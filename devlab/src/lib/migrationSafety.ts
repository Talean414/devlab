// Phase 9Q — migration safety notes for SQL drafts. A pure, renderer-only lexical review of a
// migration's statements: lock-risk warnings, destructive-change flags, suggested rollback steps
// and an environment-separation checklist. It never connects to a database, never executes or
// dry-runs SQL and never edits the draft — it reads the text and reports what it recognises so a
// reviewer can decide before the draft is staged or applied.
//
// Heuristics are deliberately conservative and dialect-aware where the risk differs (PostgreSQL by
// default, since DevLab's migration drafts target it; MySQL and SQLite rules apply when detected).
// Anything the analyser cannot classify is listed as "unclassified" rather than assumed safe.

export type SqlDialect = "postgresql" | "mysql" | "sqlite" | "unknown";
export type SafetySeverity = "danger" | "warning" | "info";

export interface SqlStatement {
  index: number;
  /** 1-based line of the statement's first token. */
  line: number;
  text: string;
  /** Upper-cased, whitespace-collapsed text used for matching. */
  normalized: string;
  kind: string;
}

export interface SafetyFinding {
  severity: SafetySeverity;
  statement: number;
  line: number;
  title: string;
  detail: string;
  suggestion?: string;
}

export interface RollbackNote {
  statement: number;
  line: number;
  summary: string;
  /** A suggested inverse statement when one can be derived; never executed. */
  inverse: string | null;
  reversible: boolean;
}

export interface MigrationSafetyReport {
  dialect: SqlDialect;
  dialectReason: string;
  statementCount: number;
  statements: SqlStatement[];
  findings: SafetyFinding[];
  rollback: RollbackNote[];
  checklist: string[];
  transactional: boolean;
  dangers: number;
  warnings: number;
  infos: number;
  unclassified: number;
}

const MAX_STATEMENTS = 400;
const MAX_STATEMENT_CHARS = 4_000;

const MIGRATION_PATH_PATTERN = /(^|\/)(migrations?|migrate|db\/migrate|alembic\/versions|sql)(\/|$)|\.sql$|migration\.sql$/i;

/** True when a draft path looks like a database migration or plain SQL file. */
export function isMigrationPath(path: string): boolean {
  return MIGRATION_PATH_PATTERN.test(path);
}

export function detectDialect(sql: string, hint?: string): { dialect: SqlDialect; reason: string } {
  const hinted = (hint ?? "").toLowerCase();
  if (hinted.includes("postgres")) return { dialect: "postgresql", reason: "declared by the draft" };
  if (hinted.includes("mysql") || hinted.includes("maria")) return { dialect: "mysql", reason: "declared by the draft" };
  if (hinted.includes("sqlite")) return { dialect: "sqlite", reason: "declared by the draft" };
  const upper = sql.toUpperCase();
  if (/\bAUTOINCREMENT\b|\bPRAGMA\b|\bWITHOUT ROWID\b/.test(upper)) return { dialect: "sqlite", reason: "AUTOINCREMENT / PRAGMA syntax" };
  if (/\bAUTO_INCREMENT\b|\bENGINE\s*=|`[a-z_][a-z0-9_]*`/i.test(sql)) return { dialect: "mysql", reason: "AUTO_INCREMENT / backtick syntax" };
  if (/\bSERIAL\b|\bBIGSERIAL\b|::\s*[A-Z]|\$\$|\bCONCURRENTLY\b|\bTIMESTAMPTZ\b|\bJSONB\b|\bUUID\b|\bTEXT\[\]/.test(upper)) {
    return { dialect: "postgresql", reason: "PostgreSQL-specific syntax" };
  }
  return { dialect: "unknown", reason: "no dialect-specific syntax found; PostgreSQL rules are applied as the default" };
}

/**
 * Splits SQL into statements on `;` outside quotes, comments and dollar-quoted blocks. Comments
 * are dropped from the statement text so keyword matching is not fooled by them.
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let current = "";
  let currentLine = 1;
  let startLine = 0;
  let line = 1;
  let index = 0;
  const flush = () => {
    const text = current.trim();
    if (text.length > 0 && statements.length < MAX_STATEMENTS) {
      const clipped = text.length > MAX_STATEMENT_CHARS ? `${text.slice(0, MAX_STATEMENT_CHARS)}…` : text;
      // Backticks (MySQL) are treated like double quotes so one set of patterns covers both.
      const normalized = clipped.replace(/`/g, '"').replace(/\s+/g, " ").toUpperCase();
      statements.push({ index: statements.length, line: startLine || currentLine, text: clipped, normalized, kind: classifyStatement(normalized) });
    }
    current = "";
    startLine = 0;
  };
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "\n") line += 1;
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      line += (sql.slice(index, stop).match(/\n/g) ?? []).length;
      index = stop;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === "\\" && quote !== "`") {
          end += 2;
          continue;
        }
        if (sql[end] === quote) {
          if (sql[end + 1] === quote) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      const literal = sql.slice(index, Math.min(sql.length, end + 1));
      if (!startLine) startLine = line;
      current += literal;
      line += (literal.match(/\n/g) ?? []).length;
      index += literal.length;
      continue;
    }
    if (char === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(index));
      if (tag) {
        const close = sql.indexOf(tag[0], index + tag[0].length);
        const stop = close === -1 ? sql.length : close + tag[0].length;
        const block = sql.slice(index, stop);
        if (!startLine) startLine = line;
        current += block;
        line += (block.match(/\n/g) ?? []).length;
        index = stop;
        continue;
      }
    }
    if (char === ";") {
      flush();
      currentLine = line;
      index += 1;
      continue;
    }
    if (!startLine && !/\s/.test(char)) startLine = line;
    current += char;
    index += 1;
  }
  flush();
  return statements;
}

function classifyStatement(normalized: string): string {
  const head = normalized.replace(/^\(+/, "");
  const patterns: Array<[RegExp, string]> = [
    [/^(BEGIN|START TRANSACTION)\b/, "begin"],
    [/^(COMMIT|END)\b/, "commit"],
    [/^ROLLBACK\b/, "rollback"],
    [/^SET\b/, "set"],
    [/^LOCK\b/, "lock"],
    [/^CREATE (UNIQUE )?INDEX\b/, "create-index"],
    [/^CREATE (OR REPLACE )?(TEMP |TEMPORARY )?(TABLE|VIEW|MATERIALIZED VIEW|SEQUENCE|TYPE|SCHEMA|EXTENSION|FUNCTION|PROCEDURE|TRIGGER|ENUM)\b/, "create"],
    [/^ALTER TABLE\b/, "alter-table"],
    [/^ALTER (INDEX|TYPE|SEQUENCE|VIEW|SCHEMA)\b/, "alter-other"],
    [/^DROP\b/, "drop"],
    [/^TRUNCATE\b/, "truncate"],
    [/^DELETE\b/, "delete"],
    [/^UPDATE\b/, "update"],
    [/^INSERT\b/, "insert"],
    [/^(MERGE|UPSERT)\b/, "insert"],
    [/^(VACUUM|CLUSTER|REINDEX|ANALYZE|OPTIMIZE TABLE)\b/, "maintenance"],
    [/^(COMMENT|GRANT|REVOKE)\b/, "metadata"],
    [/^(SELECT|WITH|EXPLAIN|SHOW)\b/, "read"],
  ];
  for (const [pattern, kind] of patterns) {
    if (pattern.test(head)) return kind;
  }
  return "unclassified";
}

export function analyzeMigrationSafety(sql: string, options: { dialectHint?: string } = {}): MigrationSafetyReport {
  const statements = splitSqlStatements(sql);
  const detected = detectDialect(sql, options.dialectHint);
  const dialect: SqlDialect = detected.dialect === "unknown" ? "postgresql" : detected.dialect;
  const findings: SafetyFinding[] = [];
  const rollback: RollbackNote[] = [];
  const transactional = statements.some((statement) => statement.kind === "begin");
  const hasLockTimeout = statements.some((statement) => statement.kind === "set" && /\b(LOCK_TIMEOUT|STATEMENT_TIMEOUT)\b/.test(statement.normalized));

  for (const statement of statements) {
    const add = (severity: SafetySeverity, title: string, detail: string, suggestion?: string) => {
      findings.push({ severity, statement: statement.index, line: statement.line, title, detail, ...(suggestion ? { suggestion } : {}) });
    };
    const note = (summary: string, inverse: string | null, reversible: boolean) => {
      rollback.push({ statement: statement.index, line: statement.line, summary, inverse, reversible });
    };
    const n = statement.normalized;
    switch (statement.kind) {
      case "drop": {
        const target = /^DROP (TABLE|SCHEMA|DATABASE|INDEX|VIEW|MATERIALIZED VIEW|SEQUENCE|TYPE|FUNCTION|TRIGGER|EXTENSION)( IF EXISTS)? ("?[\w.]+"?)/.exec(n);
        const objectType = target?.[1] ?? "OBJECT";
        const objectName = identifier(statement, target?.[3]);
        if (objectType === "INDEX") {
          add("warning", `Drops index ${objectName}`, "Queries relying on this index slow down immediately; the index itself is recreatable.", dialect === "postgresql" ? "If the table is busy, use DROP INDEX CONCURRENTLY outside a transaction." : undefined);
          note(`Recreate index ${objectName}`, null, true);
        } else if (objectType === "VIEW" || objectType === "FUNCTION" || objectType === "TRIGGER" || objectType === "TYPE" || objectType === "SEQUENCE" || objectType === "EXTENSION" || objectType === "MATERIALIZED VIEW") {
          add("warning", `Drops ${objectType.toLowerCase()} ${objectName}`, "Dependent code and queries break until it is recreated; keep the previous definition in the rollback.", undefined);
          note(`Recreate ${objectType.toLowerCase()} ${objectName} from its previous definition`, null, true);
        } else {
          add("danger", `Drops ${objectType.toLowerCase()} ${objectName}`, "All rows in it are lost and cannot be recreated from the schema alone.", "Prefer a two-step contract: stop reading/writing it in the application first, back it up (or rename it), then drop in a later migration.");
          note(`Restore ${objectType.toLowerCase()} ${objectName} from a backup taken before this migration`, null, false);
        }
        break;
      }
      case "truncate": {
        const target = identifier(statement, /^TRUNCATE (TABLE )?(ONLY )?("?[\w.]+"?)/.exec(n)?.[3]);
        add("danger", `Truncates ${target}`, "Deletes every row; in PostgreSQL it also takes an ACCESS EXCLUSIVE lock and cannot be undone without a backup.", "Export the rows first, or delete in bounded batches if only some rows must go.");
        note(`Reload ${target} from the export taken before truncating`, null, false);
        break;
      }
      case "delete": {
        const target = identifier(statement, /^DELETE FROM (ONLY )?("?[\w.]+"?)/.exec(n)?.[2]);
        if (!/\bWHERE\b/.test(n)) {
          add("danger", `Deletes every row of ${target}`, "A DELETE without WHERE empties the table and writes one WAL/redo record per row.", "Add a WHERE clause, or use TRUNCATE deliberately after exporting the rows.");
          note(`Restore ${target} rows from a backup or export`, null, false);
        } else {
          add("warning", `Deletes rows from ${target}`, "Deleted rows are not recoverable from the schema; large deletes hold row locks and bloat the table.", "Capture the affected rows first (INSERT INTO ..._backup SELECT ... WHERE ...) and delete in batches on big tables.");
          note(`Re-insert the deleted ${target} rows from the capture taken first`, null, false);
        }
        break;
      }
      case "update": {
        const target = identifier(statement, /^UPDATE (ONLY )?("?[\w.]+"?)/.exec(n)?.[2]);
        if (!/\bWHERE\b/.test(n)) {
          add("danger", `Updates every row of ${target}`, "A full-table UPDATE rewrites every row, holds row locks for the whole statement and cannot be reversed without the previous values.", "Add a WHERE clause or backfill in bounded batches (by primary-key range) outside the schema transaction.");
        } else {
          add("warning", `Backfills rows in ${target}`, "Data changes are not reversible from the schema; long UPDATEs block concurrent writers on the same rows.", "Capture previous values first and batch large backfills.");
        }
        note(`Restore previous ${target} values from a capture taken before the update`, null, false);
        break;
      }
      case "insert": {
        const target = identifier(statement, /^(INSERT INTO|MERGE INTO) ("?[\w.]+"?)/.exec(n)?.[2]);
        add("info", `Seeds rows into ${target}`, "Seed data is usually reversible by key; make sure the statement is idempotent if the migration can be retried.", /\bON CONFLICT\b|\bON DUPLICATE KEY\b|\bINSERT OR IGNORE\b/.test(n) ? undefined : "Consider ON CONFLICT DO NOTHING (PostgreSQL/SQLite) or INSERT IGNORE (MySQL) so reruns are safe.");
        note(`Delete the seeded ${target} rows by their keys`, `DELETE FROM ${target} WHERE <seeded keys>;`, true);
        break;
      }
      case "create-index": {
        const match = /^CREATE (UNIQUE )?INDEX (CONCURRENTLY )?(IF NOT EXISTS )?("?[\w.]+"?)? ?ON ("?[\w.]+"?)/.exec(n);
        const indexName = identifier(statement, match?.[4]) === "?" ? "the new index" : identifier(statement, match?.[4]);
        const table = identifier(statement, match?.[5]);
        const concurrently = Boolean(match?.[2]);
        if (dialect === "postgresql") {
          if (!concurrently) {
            add("warning", `Builds ${indexName} on ${table} while blocking writes`, "CREATE INDEX takes a SHARE lock: reads continue but every INSERT/UPDATE/DELETE on the table waits until the build finishes.", "Use CREATE INDEX CONCURRENTLY (outside a transaction block) on tables that receive writes in production.");
          } else if (transactional) {
            add("danger", `CREATE INDEX CONCURRENTLY inside a transaction`, "PostgreSQL rejects CONCURRENTLY inside BEGIN/COMMIT; the migration will fail at this statement.", "Move this statement out of the transaction or run it as its own migration step.");
          } else {
            add("info", `Builds ${indexName} on ${table} concurrently`, "Writes continue during the build; if it fails it leaves an INVALID index that must be dropped and retried.");
          }
        } else if (dialect === "mysql") {
          add("info", `Builds ${indexName} on ${table}`, "InnoDB builds secondary indexes online by default (ALGORITHM=INPLACE); the table stays writable except briefly at the start and end.");
        } else {
          add("warning", `Builds ${indexName} on ${table}`, "SQLite holds a write lock on the database for the whole index build.");
        }
        note(`Drop ${indexName}`, indexName === "the new index" ? null : `DROP INDEX ${dialect === "postgresql" ? "CONCURRENTLY " : ""}IF EXISTS ${indexName};`, true);
        break;
      }
      case "create": {
        const match = /^CREATE (OR REPLACE )?(TEMP |TEMPORARY )?(TABLE|VIEW|MATERIALIZED VIEW|SEQUENCE|TYPE|SCHEMA|EXTENSION|FUNCTION|PROCEDURE|TRIGGER)( IF NOT EXISTS )?\s?("?[\w.]+"?)/.exec(n);
        const objectType = match?.[3] ?? "object";
        const objectName = identifier(statement, match?.[5]);
        const replace = Boolean(match?.[1]);
        if (replace) {
          add("warning", `Replaces ${objectType.toLowerCase()} ${objectName}`, "CREATE OR REPLACE overwrites the previous definition; the rollback needs that previous definition, which the migration does not contain.", "Keep the previous definition next to the migration or version it in the repository.");
          note(`Restore the previous definition of ${objectName}`, null, true);
        } else {
          add("info", `Creates ${objectType.toLowerCase()} ${objectName}`, "Additive change: nothing existing is modified, so it is safe to run ahead of the application deploy.");
          note(`Drop ${objectType.toLowerCase()} ${objectName}`, `DROP ${objectType} IF EXISTS ${objectName};`, true);
        }
        break;
      }
      case "alter-table":
        analyzeAlterTable(statement, dialect, transactional, add, note);
        break;
      case "alter-other": {
        add("info", "Alters a non-table object", "Renames or option changes on indexes, types, sequences and views are quick, but dependent code must be updated in the same deploy.");
        note("Reverse the rename/option change with the mirrored ALTER", null, true);
        break;
      }
      case "lock": {
        add("warning", "Takes an explicit table lock", "Every other session on the table waits until this transaction ends; keep the transaction short and set a lock_timeout.");
        break;
      }
      case "maintenance": {
        if (/^(VACUUM FULL|CLUSTER|REINDEX(?! .*CONCURRENTLY)|OPTIMIZE TABLE)/.test(n)) {
          add("danger", "Rewrites the table under an exclusive lock", "VACUUM FULL / CLUSTER / REINDEX / OPTIMIZE TABLE rewrite the whole table or index and block reads and writes for the duration.", "Run maintenance in a dedicated window, not inside a schema migration; prefer REINDEX CONCURRENTLY (PostgreSQL 12+) or pg_repack.");
        } else {
          add("info", "Runs a maintenance statement", "ANALYZE / VACUUM (without FULL) are online but still cost I/O; they do not belong in a schema migration's transaction.");
        }
        break;
      }
      case "set": {
        if (/\b(LOCK_TIMEOUT|STATEMENT_TIMEOUT)\b/.test(n)) {
          add("info", "Sets a lock or statement timeout", "Good practice: DDL that cannot get its lock fails fast instead of queueing behind long transactions and blocking everything else.");
        }
        break;
      }
      case "begin":
      case "commit":
      case "rollback":
      case "metadata":
      case "read":
        break;
      default: {
        add("warning", "Unclassified statement", `DevLab could not classify \`${statement.text.slice(0, 80).replace(/\s+/g, " ")}${statement.text.length > 80 ? "…" : ""}\`; review it manually. It is not assumed to be safe.`);
        break;
      }
    }
  }

  const dangers = findings.filter((finding) => finding.severity === "danger").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const infos = findings.filter((finding) => finding.severity === "info").length;
  const unclassified = statements.filter((statement) => statement.kind === "unclassified").length;
  const irreversible = rollback.filter((step) => !step.reversible).length;
  const hasDdl = statements.some((statement) => ["create", "create-index", "alter-table", "alter-other", "drop"].includes(statement.kind));
  const hasDml = statements.some((statement) => ["insert", "update", "delete", "truncate"].includes(statement.kind));

  const checklist: string[] = [
    "Run the migration against a staging database restored from a recent production snapshot (same size, same PostgreSQL/MySQL/SQLite version) and time each statement.",
    "Take a verified backup or snapshot immediately before running it in production, and confirm you can restore it.",
    "Deploy in expand/contract order: the currently running application version must work with both the old and the new schema, so ship additive changes first and destructive ones in a later migration.",
  ];
  if (dialect === "postgresql" && hasDdl) {
    checklist.push(hasLockTimeout
      ? "lock_timeout / statement_timeout is set — keep it so DDL fails fast instead of queueing behind long transactions."
      : "Set a short lock_timeout (for example SET lock_timeout = '5s') before DDL so a blocked ALTER fails fast instead of stalling every other session; retry rather than wait.");
  }
  if (hasDdl && hasDml) {
    checklist.push("Schema changes and data backfills are mixed: run the DDL first, then the backfill in bounded batches outside the schema transaction, so a slow backfill cannot hold DDL locks.");
  }
  if (!transactional && dialect !== "mysql" && hasDdl) {
    checklist.push("No BEGIN/COMMIT wrapper found: decide explicitly whether the tool runs each migration in a transaction (Prisma and most runners do) — CONCURRENTLY statements must stay outside it.");
  }
  if (dialect === "mysql" && hasDdl) {
    checklist.push("MySQL DDL is not transactional: a failure mid-migration leaves the schema half-applied, so make every statement idempotent (IF EXISTS / IF NOT EXISTS) and keep the rollback script ready.");
  }
  if (dialect === "sqlite" && hasDdl) {
    checklist.push("SQLite supports only a subset of ALTER TABLE (add/rename/drop column on 3.35+); other changes need the create-copy-drop-rename recipe inside one transaction with foreign keys off.");
  }
  if (irreversible > 0) {
    checklist.push(`${irreversible} step${irreversible === 1 ? "" : "s"} cannot be reversed from the schema alone (see rollback notes) — the backup is the rollback plan for those.`);
  }
  checklist.push("Keep production credentials out of the workspace: run the migration from the deployment pipeline or a maintainer shell, never from a draft or an embedded connection string.");

  return {
    dialect,
    dialectReason: detected.reason,
    statementCount: statements.length,
    statements,
    findings,
    rollback,
    checklist,
    transactional,
    dangers,
    warnings,
    infos,
    unclassified,
  };
}

type AddFinding = (severity: SafetySeverity, title: string, detail: string, suggestion?: string) => void;
type AddRollback = (summary: string, inverse: string | null, reversible: boolean) => void;

function analyzeAlterTable(statement: SqlStatement, dialect: SqlDialect, transactional: boolean, add: AddFinding, note: AddRollback) {
  const n = statement.normalized;
  const table = identifier(statement, /^ALTER TABLE (ONLY )?(IF EXISTS )?("?[\w.]+"?)/.exec(n)?.[3]);
  const actions = n.replace(/^ALTER TABLE (ONLY )?(IF EXISTS )?("?[\w.]+"?)\s*/, "").split(/,\s*(?=(ADD|DROP|ALTER|RENAME|SET|RESET|VALIDATE|ENABLE|DISABLE|ATTACH|DETACH)\b)/).filter((part) => part && !/^(ADD|DROP|ALTER|RENAME|SET|RESET|VALIDATE|ENABLE|DISABLE|ATTACH|DETACH)$/.test(part));
  let classified = false;
  for (const action of actions) {
    const a = action.trim();
    if (/^ADD (COLUMN )?(IF NOT EXISTS )?/.test(a) && !/^ADD (CONSTRAINT|PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|EXCLUDE)\b/.test(a)) {
      classified = true;
      const column = identifier(statement, /^ADD (COLUMN )?(IF NOT EXISTS )?("?[\w]+"?)/.exec(a)?.[3]);
      const notNull = /\bNOT NULL\b/.test(a);
      const hasDefault = /\bDEFAULT\b/.test(a);
      const volatileDefault = /\bDEFAULT\s+\(?\s*(NOW|CLOCK_TIMESTAMP|RANDOM|GEN_RANDOM_UUID|UUID_GENERATE_V4|NEXTVAL|CURRENT_TIMESTAMP\(\))/.test(a);
      if (notNull && !hasDefault) {
        add("danger", `Adds NOT NULL column ${column} to ${table} without a default`, "Fails on any table that already has rows (PostgreSQL/SQLite) or fills the column with zero-values silently (MySQL).", "Add the column as nullable (or with a DEFAULT), backfill in batches, then add the NOT NULL constraint in a later step.");
      } else if (dialect === "postgresql" && volatileDefault) {
        add("warning", `Adds column ${column} with a volatile default to ${table}`, "PostgreSQL must rewrite every row to evaluate a volatile default (now(), random(), gen_random_uuid(), nextval(...)), holding an ACCESS EXCLUSIVE lock for the whole rewrite.", "Add the column with a constant default or nullable, backfill the value in batches, then set the default for new rows.");
      } else if (dialect === "postgresql" && notNull && hasDefault) {
        add("info", `Adds column ${column} with a constant default to ${table}`, "Fast on PostgreSQL 11+ (metadata-only); on older servers it rewrites the table.");
      } else if (dialect === "mysql") {
        add(notNull ? "warning" : "info", `Adds column ${column} to ${table}`, "MySQL 8.0 can add a trailing column INSTANT; other positions or older versions copy the table. Specify ALGORITHM=INSTANT or INPLACE, LOCK=NONE to make the tool fail instead of copying silently.");
      } else {
        add("info", `Adds nullable column ${column} to ${table}`, "Additive and metadata-only; the running application ignores unknown columns.");
      }
      note(`Drop column ${column} from ${table}`, `ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column};`, true);
      continue;
    }
    if (/^DROP (COLUMN )?(IF EXISTS )?("?[\w]+"?)/.test(a) && !/^DROP CONSTRAINT\b/.test(a)) {
      classified = true;
      const column = identifier(statement, /^DROP (COLUMN )?(IF EXISTS )?("?[\w]+"?)/.exec(a)?.[3]);
      add("danger", `Drops column ${column} from ${table}`, "The column's data is lost immediately and any application code still selecting it fails until redeployed.", "Stop reading and writing the column in the application first (expand/contract), then drop it in a later migration once no version uses it.");
      note(`Re-add column ${column} and restore its data from a backup`, `ALTER TABLE ${table} ADD COLUMN ${column} <previous type>;`, false);
      continue;
    }
    if (/^DROP CONSTRAINT\b/.test(a)) {
      classified = true;
      const name = identifier(statement, /^DROP CONSTRAINT (IF EXISTS )?("?[\w]+"?)/.exec(a)?.[2]);
      add("warning", `Drops constraint ${name} on ${table}`, "Invalid data can enter the table as soon as the constraint is gone; re-adding it later requires a full validation scan.");
      note(`Re-add constraint ${name}`, `ALTER TABLE ${table} ADD CONSTRAINT ${name} <previous definition>;`, true);
      continue;
    }
    if (/^ADD (CONSTRAINT ("?[\w]+"?) )?FOREIGN KEY\b/.test(a) || /^ADD (CONSTRAINT ("?[\w]+"?) )?CHECK\b/.test(a)) {
      classified = true;
      const name = identifier(statement, /^ADD CONSTRAINT ("?[\w]+"?)/.exec(a)?.[1]);
      const kind = /FOREIGN KEY/.test(a) ? "foreign key" : "check constraint";
      const notValid = /\bNOT VALID\b/.test(a);
      if (dialect === "postgresql" && !notValid) {
        add("warning", `Adds ${kind} ${name} on ${table} with a full validation scan`, "PostgreSQL scans every existing row under a SHARE ROW EXCLUSIVE lock (and locks the referenced table for foreign keys) before the ALTER returns.", "Add it with NOT VALID first (instant), then run ALTER TABLE ... VALIDATE CONSTRAINT separately; validation only takes a SHARE UPDATE EXCLUSIVE lock.");
      } else if (dialect === "postgresql") {
        add("info", `Adds ${kind} ${name} on ${table} as NOT VALID`, "New rows are checked immediately; remember to VALIDATE CONSTRAINT later so existing rows are covered too.");
      } else {
        add("warning", `Adds ${kind} ${name} on ${table}`, "Existing rows are scanned during the ALTER; rows that violate it make the migration fail.");
      }
      note(`Drop constraint ${name}`, name === "?" ? null : `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name};`, true);
      continue;
    }
    if (/^ADD (CONSTRAINT ("?[\w]+"?) )?(UNIQUE|PRIMARY KEY|EXCLUDE)\b/.test(a)) {
      classified = true;
      const name = identifier(statement, /^ADD CONSTRAINT ("?[\w]+"?)/.exec(a)?.[1]);
      const usingIndex = /\bUSING INDEX\b/.test(a);
      if (dialect === "postgresql" && !usingIndex) {
        add("warning", `Adds a unique/primary key constraint ${name} on ${table} by building an index under an exclusive lock`, "The index build blocks reads and writes on the table for its whole duration.", "CREATE UNIQUE INDEX CONCURRENTLY first, then ALTER TABLE ... ADD CONSTRAINT ... USING INDEX to attach it without the long lock.");
      } else {
        add("info", `Adds constraint ${name} on ${table}`, usingIndex ? "Attaching an existing index is a quick metadata change." : "Existing rows are checked for duplicates during the ALTER.");
      }
      note(`Drop constraint ${name}`, name === "?" ? null : `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name};`, true);
      continue;
    }
    if (/^ALTER (COLUMN )?("?[\w]+"?) (SET DATA )?TYPE\b/.test(a)) {
      classified = true;
      const column = identifier(statement, /^ALTER (COLUMN )?("?[\w]+"?)/.exec(a)?.[2]);
      add("danger", `Changes the type of ${table}.${column}`, "Usually rewrites the whole table (and its indexes) under an ACCESS EXCLUSIVE lock; a cast that fails for one row aborts the migration. Only a few widenings (e.g. varchar(n) → text) are metadata-only.", "Add a new column, backfill it in batches, switch the application, then drop the old column in a later migration.");
      note(`Change ${table}.${column} back to its previous type (data may already be truncated or cast)`, `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE <previous type>;`, false);
      continue;
    }
    if (/^ALTER (COLUMN )?("?[\w]+"?) SET NOT NULL\b/.test(a)) {
      classified = true;
      const column = identifier(statement, /^ALTER (COLUMN )?("?[\w]+"?)/.exec(a)?.[2]);
      add("warning", `Makes ${table}.${column} NOT NULL`, "PostgreSQL scans the whole table under an ACCESS EXCLUSIVE lock to prove no NULLs exist; any NULL aborts the migration.", "On PostgreSQL 12+, add a CHECK (column IS NOT NULL) NOT VALID, VALIDATE it, then SET NOT NULL — the final step becomes a quick metadata check.");
      note(`Drop the NOT NULL constraint on ${table}.${column}`, `ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL;`, true);
      continue;
    }
    if (/^ALTER (COLUMN )?("?[\w]+"?) (DROP NOT NULL|SET DEFAULT|DROP DEFAULT)\b/.test(a)) {
      classified = true;
      const column = identifier(statement, /^ALTER (COLUMN )?("?[\w]+"?)/.exec(a)?.[2]);
      add("info", `Changes nullability/default of ${table}.${column}`, "Metadata-only change; defaults apply to new rows only.");
      note(`Restore the previous default/nullability of ${table}.${column}`, null, true);
      continue;
    }
    if (/^RENAME (COLUMN )?("?[\w]+"?) TO ("?[\w]+"?)/.test(a)) {
      classified = true;
      const match = /^RENAME (COLUMN )?("?[\w]+"?) TO ("?[\w]+"?)/.exec(a);
      const from = identifier(statement, match?.[2]);
      const to = identifier(statement, match?.[3]);
      add("warning", `Renames ${table}.${from} to ${to}`, "Instant, but every running application instance that still uses the old name fails until it is redeployed — renames cannot be done in expand/contract order.", "Prefer adding the new column, dual-writing, backfilling and dropping the old one; if you must rename, deploy the code change in the same step.");
      note(`Rename ${to} back to ${from}`, `ALTER TABLE ${table} RENAME COLUMN ${to} TO ${from};`, true);
      continue;
    }
    if (/^RENAME TO ("?[\w.]+"?)/.test(a)) {
      classified = true;
      const to = identifier(statement, /^RENAME TO ("?[\w.]+"?)/.exec(a)?.[1]);
      add("warning", `Renames table ${table} to ${to}`, "Instant, but breaks every running instance that still references the old name.", "Consider a view with the old name during the transition, or deploy the code change in the same step.");
      note(`Rename ${to} back to ${table}`, `ALTER TABLE ${to} RENAME TO ${table};`, true);
      continue;
    }
    if (/^VALIDATE CONSTRAINT\b/.test(a)) {
      classified = true;
      add("info", `Validates a constraint on ${table}`, "Scans existing rows under a SHARE UPDATE EXCLUSIVE lock, which does not block reads or writes.");
      continue;
    }
    if (/^(SET|RESET) \(/.test(a) || /^(ENABLE|DISABLE) (ROW LEVEL SECURITY|TRIGGER)/.test(a) || /^(ATTACH|DETACH) PARTITION/.test(a) || /^SET (SCHEMA|TABLESPACE|LOGGED|UNLOGGED)/.test(a) || /^OWNER TO/.test(a)) {
      classified = true;
      add("info", `Changes table options on ${table}`, /TABLESPACE|LOGGED/.test(a) ? "Moving tablespaces or toggling LOGGED rewrites the table under an exclusive lock." : "Metadata-only change; review the security implications of RLS/trigger toggles.");
      continue;
    }
  }
  if (!classified) {
    add("warning", `Unrecognised ALTER TABLE on ${table}`, `DevLab could not classify \`${statement.text.slice(0, 80).replace(/\s+/g, " ")}${statement.text.length > 80 ? "…" : ""}\`; review the lock and data impact manually.`);
  }
  if (dialect === "postgresql" && transactional && /\bCONCURRENTLY\b/.test(n)) {
    add("danger", "CONCURRENTLY inside a transaction", "PostgreSQL rejects CONCURRENTLY operations inside BEGIN/COMMIT.", "Move the statement outside the transaction block.");
  }
}

function identifier(statement: SqlStatement, upperName: string | undefined): string {
  if (!upperName) return "?";
  const cleaned = upperName.replace(/["`]/g, "");
  // Recover the original casing from the statement text when possible.
  const escaped = cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\./g, '"?\\."?');
  const pattern = new RegExp(`(?<![\\w"\`])["\`]?${escaped}["\`]?(?![\\w"\`])`, "i");
  const original = pattern.exec(statement.text.replace(/\s+/g, " "));
  return original ? original[0].replace(/["`]/g, "") : cleaned.toLowerCase();
}

export function summarizeMigrationSafety(report: MigrationSafetyReport): string {
  if (report.statementCount === 0) return "No SQL statements found.";
  const parts = [
    `${report.statementCount} statement${report.statementCount === 1 ? "" : "s"}`,
    `${report.dialect}${report.dialectReason.startsWith("declared") ? "" : " (detected)"}`,
  ];
  if (report.dangers > 0) parts.push(`${report.dangers} danger${report.dangers === 1 ? "" : "s"}`);
  if (report.warnings > 0) parts.push(`${report.warnings} warning${report.warnings === 1 ? "" : "s"}`);
  if (report.dangers === 0 && report.warnings === 0) parts.push("no lock or data-loss risks recognised");
  if (report.unclassified > 0) parts.push(`${report.unclassified} unclassified`);
  const irreversible = report.rollback.filter((step) => !step.reversible).length;
  if (irreversible > 0) parts.push(`${irreversible} irreversible without backup`);
  return parts.join(" · ");
}

/** Markdown rendering of the report for copying into a PR or runbook. Nothing here is executed. */
export function renderMigrationSafety(report: MigrationSafetyReport, title = "Migration safety notes"): string {
  const lines: string[] = [
    `# ${title}`,
    "Generated by DevLab from a lexical read of the SQL draft. Not a dry run: no database was contacted and nothing was executed.",
    summarizeMigrationSafety(report),
    "",
  ];
  if (report.findings.length > 0) {
    lines.push("## Findings", "");
    for (const severity of ["danger", "warning", "info"] as SafetySeverity[]) {
      for (const finding of report.findings.filter((item) => item.severity === severity)) {
        lines.push(`- **${severity.toUpperCase()}** (statement ${finding.statement + 1}, line ${finding.line}) ${finding.title} — ${finding.detail}${finding.suggestion ? ` _Suggestion:_ ${finding.suggestion}` : ""}`);
      }
    }
    lines.push("");
  }
  if (report.rollback.length > 0) {
    lines.push("## Rollback notes (suggested inverses, review before use)", "");
    for (const step of report.rollback) {
      lines.push(`- Statement ${step.statement + 1} (line ${step.line}): ${step.summary}${step.reversible ? "" : " — **not reversible from the schema; restore from backup**"}${step.inverse ? `\n  \`${step.inverse}\`` : ""}`);
    }
    lines.push("");
  }
  lines.push("## Environment and rollout checklist", "");
  for (const item of report.checklist) lines.push(`- ${item}`);
  return lines.join("\n");
}
