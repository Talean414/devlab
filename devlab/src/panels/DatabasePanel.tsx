import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import {
  DatabaseCommandError,
  connectPostgres,
  disconnectDatabase,
  disconnectPostgres,
  forgetPostgresPassword,
  getDatabaseConnections,
  getDatabaseSchema,
  getPostgresConnections,
  getPostgresSchema,
  runDatabaseQuery,
  runPostgresReadQuery,
  selectSqliteDatabase,
  setDatabaseWriteAccess,
  type DatabaseCell,
  type DatabaseConnectionInfo,
  type DatabaseObject,
  type DatabaseQueryResult,
  type DatabaseSchema,
  type PostgresConnectionInfo,
  type PostgresConnectRequest,
  type PostgresObject,
  type PostgresSchema,
} from "../lib/database";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Database,
  FolderOpen,
  HardDrive,
  KeyRound,
  Loader2,
  LockKeyhole,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Table2,
  Trash2,
  UnlockKeyhole,
  X,
} from "lucide-react";

const DEFAULT_SQL = `SELECT name, type
FROM sqlite_schema
WHERE type IN ('table', 'view')
ORDER BY type, name
LIMIT 100;`;

const DEFAULT_POSTGRES_SQL = `SELECT current_database() AS database,
       current_user AS username,
       current_setting('server_version') AS server_version;`;

const DEFAULT_POSTGRES_REQUEST: PostgresConnectRequest = {
  host: "localhost",
  port: 5432,
  database: "postgres",
  username: "postgres",
  password: "",
  tlsMode: "verify-full",
  allowWrites: false,
  storePassword: false,
};

export function DatabasePanel({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  const [connections, setConnections] = useState<DatabaseConnectionInfo[]>([]);
  const [postgresConnections, setPostgresConnections] = useState<PostgresConnectionInfo[]>([]);
  const [activeId, setActiveId] = useState("");
  const [activePostgresId, setActivePostgresId] = useState("");
  const [schema, setSchema] = useState<DatabaseSchema | null>(null);
  const [postgresSchema, setPostgresSchema] = useState<PostgresSchema | null>(null);
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [result, setResult] = useState<DatabaseQueryResult | null>(null);
  const [postgresSql, setPostgresSql] = useState(DEFAULT_POSTGRES_SQL);
  const [postgresResult, setPostgresResult] = useState<DatabaseQueryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [postgresSchemaLoading, setPostgresSchemaLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsWorkspace, setNeedsWorkspace] = useState(false);
  const [filter, setFilter] = useState("");
  const [connectOpen, setConnectOpen] = useState(false);
  const [postgresConnectOpen, setPostgresConnectOpen] = useState(false);
  const [newAllowWrites, setNewAllowWrites] = useState(false);
  const [postgresRequest, setPostgresRequest] = useState<PostgresConnectRequest>(DEFAULT_POSTGRES_REQUEST);

  const active = connections.find((connection) => connection.id === activeId) ?? null;
  const activePostgres = postgresConnections.find((connection) => connection.id === activePostgresId) ?? null;

  const refreshConnections = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [next, nextPostgres] = await Promise.all([
        getDatabaseConnections(),
        getPostgresConnections(),
      ]);
      setConnections(next);
      setPostgresConnections(nextPostgres);
      setNeedsWorkspace(false);
      setActiveId((current) => (
        next.some((connection) => connection.id === current)
          ? current
          : nextPostgres.length > 0 ? "" : next[0]?.id ?? ""
      ));
      setActivePostgresId((current) => (
        nextPostgres.some((connection) => connection.id === current)
          ? current
          : next.length > 0 ? "" : nextPostgres[0]?.id ?? ""
      ));
    } catch (caught) {
      if (caught instanceof DatabaseCommandError && caught.code === "workspace_not_selected") {
        setConnections([]);
        setPostgresConnections([]);
        setActiveId("");
        setActivePostgresId("");
        setSchema(null);
        setPostgresSchema(null);
        setNeedsWorkspace(true);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSchema = useCallback(async (id: string) => {
    if (!id) {
      setSchema(null);
      return;
    }
    setSchemaLoading(true);
    setError("");
    try {
      const next = await getDatabaseSchema(id);
      setSchema(next);
      setConnections((current) => current.map((connection) => (
        connection.id === next.connection.id ? next.connection : connection
      )));
    } catch (caught) {
      setSchema(null);
      setError(errorMessage(caught));
    } finally {
      setSchemaLoading(false);
    }
  }, []);

  const loadPostgresSchema = useCallback(async (id: string) => {
    if (!id) {
      setPostgresSchema(null);
      return;
    }
    setPostgresSchemaLoading(true);
    setError("");
    try {
      const next = await getPostgresSchema(id);
      setPostgresSchema(next);
      setPostgresConnections((current) => current.map((connection) => (
        connection.id === next.connection.id ? next.connection : connection
      )));
    } catch (caught) {
      setPostgresSchema(null);
      setError(errorMessage(caught));
    } finally {
      setPostgresSchemaLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  useEffect(() => {
    setResult(null);
    void loadSchema(activeId);
  }, [activeId, loadSchema]);

  useEffect(() => {
    setPostgresResult(null);
    void loadPostgresSchema(activePostgresId);
  }, [activePostgresId, loadPostgresSchema]);

  const filteredObjects = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return schema?.objects ?? [];
    return (schema?.objects ?? []).filter((object) => (
      object.name.toLowerCase().includes(query)
      || object.columns.some((column) => column.name.toLowerCase().includes(query))
    ));
  }, [filter, schema]);

  const filteredPostgresObjects = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return postgresSchema?.objects ?? [];
    return (postgresSchema?.objects ?? []).filter((object) => (
      object.schema.toLowerCase().includes(query)
      || object.name.toLowerCase().includes(query)
      || object.columns.some((column) => column.name.toLowerCase().includes(query))
    ));
  }, [filter, postgresSchema]);

  async function chooseSqlite() {
    setBusy("connect");
    setError("");
    setNotice("");
    try {
      const connection = await selectSqliteDatabase(newAllowWrites);
      if (!connection) return;
      setConnections((current) => [...current, connection]);
      setActivePostgresId("");
      setActiveId(connection.id);
      setNeedsWorkspace(false);
      setConnectOpen(false);
      setNotice(`${connection.name} opened ${connection.allowWrites ? "with confirmed writes enabled" : "read-only"}.`);
    } catch (caught) {
      if (caught instanceof DatabaseCommandError && caught.code === "workspace_not_selected") {
        setConnectOpen(false);
        setNeedsWorkspace(true);
      }
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  async function connectPostgresServer() {
    if (busy) return;
    setBusy("postgres-connect");
    setError("");
    setNotice("");
    try {
      const connection = await connectPostgres(postgresRequest);
      setPostgresConnections((current) => [...current, connection]);
      setActiveId("");
      setActivePostgresId(connection.id);
      setPostgresRequest((current) => ({ ...current, password: "" }));
      setPostgresConnectOpen(false);
      setNeedsWorkspace(false);
      setNotice(
        `Connected to PostgreSQL ${connection.serverVersion} at ${connection.host}:${connection.port} using TLS policy ${connection.tlsMode}.`,
      );
    } catch (caught) {
      if (caught instanceof DatabaseCommandError && caught.code === "workspace_not_selected") {
        setPostgresConnectOpen(false);
        setNeedsWorkspace(true);
      }
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  async function disconnectPostgresServer(connection: PostgresConnectionInfo) {
    if (busy) return;
    setBusy(`postgres-disconnect-${connection.id}`);
    setError("");
    try {
      await disconnectPostgres(connection.id);
      const remaining = postgresConnections.filter((item) => item.id !== connection.id);
      setPostgresConnections(remaining);
      if (activePostgresId === connection.id) {
        setActivePostgresId(remaining[0]?.id ?? "");
        if (remaining.length === 0) setActiveId(connections[0]?.id ?? "");
        setPostgresSchema(null);
      }
      setNotice(`${connection.name} disconnected. Any securely stored password was retained.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  async function forgetPostgresServerPassword(connection: PostgresConnectionInfo) {
    if (busy || !connection.credentialStored || !confirm(
      `Remove the stored PostgreSQL password for “${connection.name}” from the operating-system credential store?\n\nThe live connection will remain open until disconnected.`,
    )) return;
    setBusy(`postgres-forget-${connection.id}`);
    setError("");
    try {
      const updated = await forgetPostgresPassword(connection.id);
      setPostgresConnections((current) => current.map((item) => (
        item.id === updated.id ? updated : item
      )));
      setNotice(`Removed the stored password for ${connection.name}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  async function executeQuery() {
    if (!active || !sql.trim() || busy || schemaLoading) return;
    setBusy("query");
    setError("");
    setNotice("");
    try {
      let next: DatabaseQueryResult;
      try {
        next = await runDatabaseQuery(active.id, sql, false);
      } catch (caught) {
        if (
          caught instanceof DatabaseCommandError
          && caught.code === "database_write_confirmation_required"
        ) {
          const confirmed = confirm(
            `Run this write statement against “${active.name}”?\n\nSQLite will execute one statement atomically. DevLab cannot undo a committed change.`,
          );
          if (!confirmed) return;
          next = await runDatabaseQuery(active.id, sql, true);
        } else {
          throw caught;
        }
      }
      setResult(next);
      if (next.readOnly) {
        setNotice(`Read ${next.rowCount} displayed row${next.rowCount === 1 ? "" : "s"} in ${next.elapsedMs} ms.`);
      } else {
        setNotice(`Write completed · ${next.affectedRows} affected row${next.affectedRows === 1 ? "" : "s"} · ${next.elapsedMs} ms.`);
        void loadSchema(active.id);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  async function executePostgresQuery() {
    if (!activePostgres || !postgresSql.trim() || busy || postgresSchemaLoading) return;
    setBusy("postgres-query");
    setError("");
    setNotice("");
    try {
      const next = await runPostgresReadQuery(activePostgres.id, postgresSql);
      setPostgresResult(next);
      setNotice(`Read ${next.rowCount} displayed row${next.rowCount === 1 ? "" : "s"} from PostgreSQL in ${next.elapsedMs} ms.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  async function toggleWriteAccess() {
    if (!active) return;
    const enable = !active.allowWrites;
    if (enable && !confirm(
      `Enable write statements for “${active.name}”?\n\nEach mutating statement will still require a separate confirmation. The database file and SQLite journal files can be changed.`,
    )) return;
    setBusy("access");
    setError("");
    try {
      const updated = await setDatabaseWriteAccess(active.id, enable);
      setConnections((current) => current.map((connection) => (
        connection.id === updated.id ? updated : connection
      )));
      setSchema((current) => current?.connection.id === updated.id
        ? { ...current, connection: updated }
        : current);
      setNotice(enable
        ? "Writes enabled for this in-memory connection. Every write still requires confirmation."
        : "Connection reopened in operating-system-enforced read-only mode.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  async function disconnect() {
    if (!active) return;
    setBusy("disconnect");
    setError("");
    try {
      await disconnectDatabase(active.id);
      const remaining = connections.filter((connection) => connection.id !== active.id);
      setConnections(remaining);
      setActiveId(remaining[0]?.id ?? "");
      if (remaining.length === 0) setActivePostgresId(postgresConnections[0]?.id ?? "");
      setSchema(null);
      setResult(null);
      setNotice(`${active.name} disconnected.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  function queryObject(object: DatabaseObject) {
    setSql(`SELECT *\nFROM ${quoteIdentifier(object.name)}\nLIMIT 100;`);
    setResult(null);
  }

  function queryPostgresObject(object: PostgresObject) {
    setPostgresSql(`SELECT *\nFROM ${quoteIdentifier(object.schema)}.${quoteIdentifier(object.name)}\nLIMIT 100;`);
    setPostgresResult(null);
  }

  const subtitle = active
    ? `SQLite ${active.sqliteVersion} · ${active.path} · ${active.allowWrites ? "writes enabled" : "read-only"}`
    : activePostgres
      ? `PostgreSQL ${activePostgres.serverVersion} · ${activePostgres.username}@${activePostgres.host}:${activePostgres.port}/${activePostgres.database}`
      : "Workspace-scoped SQLite · bounded PostgreSQL schema inspection";

  return (
    <div className="relative flex h-full flex-col">
      <PanelHeader
        title="Native Database Client"
        subtitle={subtitle}
        badge={active
          ? (active.allowWrites ? "Writes enabled" : "Read only")
          : activePostgres ? `TLS ${activePostgres.tlsMode}` : "SQLite + PostgreSQL"}
        badgeOk={active ? !active.allowWrites : activePostgres?.tlsMode === "verify-full"}
      />

      {error && <Banner tone="error" text={error} onClose={() => setError("")} />}
      {notice && <Banner tone="success" text={notice} onClose={() => setNotice("")} />}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col border-r border-white/5 bg-[#0d1017]/40">
          <div className="grid grid-cols-2 gap-2 border-b border-white/5 p-3">
            <button
              onClick={() => { setError(""); setConnectOpen(true); }}
              disabled={!!busy || schemaLoading || postgresSchemaLoading}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-cyan-500/15 px-2 py-2 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-40"
            >
              <HardDrive className="h-3.5 w-3.5" /> SQLite
            </button>
            <button
              onClick={() => { setError(""); setPostgresConnectOpen(true); }}
              disabled={!!busy || schemaLoading || postgresSchemaLoading}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-blue-500/15 px-2 py-2 text-[11px] font-semibold text-blue-200 hover:bg-blue-500/25 disabled:opacity-40"
            >
              <Server className="h-3.5 w-3.5" /> PostgreSQL
            </button>
          </div>

          <div className="max-h-[38%] overflow-y-auto border-b border-white/5 p-3">
            <div className="mb-2 flex items-center justify-between px-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-600">
              <span>Connections</span>
              <button onClick={() => void refreshConnections()} disabled={loading || !!busy} title="Refresh connections" className="rounded p-1 hover:bg-white/5 hover:text-zinc-300 disabled:opacity-40">
                <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
            {loading && connections.length === 0 ? (
              <div className="flex items-center gap-2 px-2 py-4 text-[11px] text-zinc-600"><Loader2 className="h-3 w-3 animate-spin" /> Reading native connections…</div>
            ) : connections.length === 0 ? (
              <div className="rounded-lg border border-dashed border-white/10 p-4 text-center text-[11px] leading-relaxed text-zinc-600">No SQLite database is open. Live connections remain only in this DevLab process.</div>
            ) : connections.map((connection) => (
              <button
                key={connection.id}
                onClick={() => { setActivePostgresId(""); setActiveId(connection.id); }}
                disabled={!!busy || schemaLoading || postgresSchemaLoading}
                className={`mb-1 flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${
                  activeId === connection.id
                    ? "border-violet-500/30 bg-violet-500/10"
                    : "border-transparent hover:bg-white/5"
                }`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-300 ring-1 ring-violet-500/20"><HardDrive className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-zinc-200">{connection.name}</span>
                  <span className="block truncate font-mono text-[10px] text-zinc-600">{connection.path}</span>
                </span>
                {connection.allowWrites
                  ? <UnlockKeyhole className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                  : <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
              </button>
            ))}

            {postgresConnections.length > 0 && (
              <div className="mt-3 border-t border-white/5 pt-3">
                <div className="mb-2 px-1 text-[9.5px] font-semibold uppercase tracking-wider text-blue-400/60">PostgreSQL connectivity</div>
                {postgresConnections.map((connection) => (
                  <div key={connection.id} className={`mb-2 rounded-lg border p-2.5 ${activePostgresId === connection.id ? "border-blue-500/35 bg-blue-500/10" : "border-blue-500/15 bg-blue-500/[0.04]"}`}>
                    <button
                      onClick={() => { setActiveId(""); setActivePostgresId(connection.id); }}
                      disabled={!!busy || schemaLoading || postgresSchemaLoading}
                      className="flex w-full items-start gap-2 text-left disabled:opacity-40"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-300"><Server className="h-3.5 w-3.5" /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11.5px] font-medium text-zinc-200">{connection.name}</span>
                        <span className="block truncate font-mono text-[9.5px] text-zinc-600">{connection.username}@{connection.host}:{connection.port}</span>
                        <span className="mt-1 block text-[9px] text-zinc-700">PostgreSQL {connection.serverVersion} · TLS {connection.tlsMode}</span>
                      </span>
                    </button>
                    <div className="mt-2 flex items-center justify-end gap-1.5">
                      {connection.credentialStored && (
                        <button
                          onClick={() => void forgetPostgresServerPassword(connection)}
                          disabled={!!busy || postgresSchemaLoading}
                          title="Forget stored password"
                          className="rounded border border-white/10 px-2 py-1 text-[9.5px] text-zinc-500 hover:border-amber-500/20 hover:text-amber-300 disabled:opacity-40"
                        >
                          {busy === `postgres-forget-${connection.id}` ? "Removing…" : "Forget password"}
                        </button>
                      )}
                      <button
                        onClick={() => void disconnectPostgresServer(connection)}
                        disabled={!!busy || postgresSchemaLoading}
                        className="rounded border border-white/10 px-2 py-1 text-[9.5px] text-zinc-500 hover:border-rose-500/20 hover:text-rose-300 disabled:opacity-40"
                      >
                        {busy === `postgres-disconnect-${connection.id}` ? "Disconnecting…" : "Disconnect"}
                      </button>
                    </div>
                  </div>
                ))}
                <div className="px-1 text-[9px] leading-relaxed text-zinc-700">Schema and read queries are bounded. PostgreSQL writes remain disabled until their separate confirmation checkpoint.</div>
              </div>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-white/5 p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter tables and columns…"
                  className="w-full rounded-lg border border-white/10 bg-[#0b0e14] py-2 pl-9 pr-3 text-[11.5px] text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-cyan-500/50"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {schemaLoading || postgresSchemaLoading ? (
                <div className="flex items-center gap-2 px-3 py-4 text-[11px] text-zinc-600"><Loader2 className="h-3 w-3 animate-spin" /> Reading bounded native schema…</div>
              ) : !active && !activePostgres ? (
                <div className="px-3 py-5 text-center text-[11px] text-zinc-700">Open a connection to inspect schema.</div>
              ) : activePostgres ? (
                filteredPostgresObjects.length === 0
                  ? <div className="px-3 py-5 text-center text-[11px] text-zinc-700">No matching user tables or views.</div>
                  : filteredPostgresObjects.map((object) => (
                    <PostgresSchemaObjectView
                      key={`${object.schema}-${object.kind}-${object.name}`}
                      object={object}
                      disabled={!!busy}
                      onQuery={() => queryPostgresObject(object)}
                    />
                  ))
              ) : filteredObjects.length === 0 ? (
                <div className="px-3 py-5 text-center text-[11px] text-zinc-700">No matching user tables or views.</div>
              ) : filteredObjects.map((object) => (
                <details key={`${object.kind}-${object.name}`} className="group mb-1 rounded-lg open:bg-white/[0.025]">
                  <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 py-2 text-[11.5px] text-zinc-300 hover:bg-white/5">
                    <ChevronRight className="h-3 w-3 text-zinc-600 transition group-open:rotate-90" />
                    <Table2 className={`h-3.5 w-3.5 ${object.kind === "view" ? "text-cyan-400" : "text-violet-400"}`} />
                    <span className="min-w-0 flex-1 truncate font-mono">{object.name}</span>
                    <span className="text-[9px] uppercase text-zinc-700">{object.kind}</span>
                  </summary>
                  <div className="pb-2 pl-8 pr-2">
                    <button onClick={() => queryObject(object)} className="mb-1 text-[10px] font-medium text-cyan-400 hover:text-cyan-300">Query first 100 rows</button>
                    {object.columns.map((column) => (
                      <div key={`${object.name}-${column.position}-${column.name}`} className="flex items-center gap-2 py-1 text-[10.5px]">
                        <span className="min-w-0 flex-1 truncate font-mono text-zinc-500">{column.name}</span>
                        <span className="shrink-0 font-mono text-[9.5px] text-zinc-700">{column.dataType || "ANY"}</span>
                        {column.primaryKey && <KeyRound className="h-2.5 w-2.5 shrink-0 text-amber-400" />}
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {activePostgres ? (
            <PostgresSchemaSummary
              connection={activePostgres}
              schema={postgresSchema}
              loading={postgresSchemaLoading}
              sql={postgresSql}
              result={postgresResult}
              queryBusy={busy === "postgres-query"}
              onSql={setPostgresSql}
              onRun={() => void executePostgresQuery()}
              onRefresh={() => void loadPostgresSchema(activePostgres.id)}
            />
          ) : !active ? (
            <EmptyDatabaseState needsWorkspace={needsWorkspace} onOpenWorkspace={onOpenWorkspace} onConnect={() => setConnectOpen(true)} />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 bg-[#0d1017]/40 px-5 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-semibold text-zinc-200">{active.name}</div>
                  <div className="truncate font-mono text-[10px] text-zinc-600">{active.path} · {formatBytes(active.fileSize)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void toggleWriteAccess()}
                    disabled={!!busy}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10.5px] disabled:opacity-40 ${active.allowWrites ? "border-amber-500/25 bg-amber-500/[0.07] text-amber-200" : "border-emerald-500/20 bg-emerald-500/[0.05] text-emerald-300"}`}
                  >
                    {busy === "access" ? <Loader2 className="h-3 w-3 animate-spin" /> : active.allowWrites ? <UnlockKeyhole className="h-3 w-3" /> : <LockKeyhole className="h-3 w-3" />}
                    {active.allowWrites ? "Disable writes" : "Enable writes"}
                  </button>
                  <button onClick={() => void disconnect()} disabled={!!busy} title="Disconnect" className="rounded-lg border border-white/10 p-1.5 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-40">
                    {busy === "disconnect" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>

              <div className="border-b border-white/5 p-4">
                <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0d1017] ring-soft">
                  <div className="flex items-center justify-between border-b border-white/5 px-4 py-2">
                    <div className="flex items-center gap-2 text-[11px] text-zinc-500"><Database className="h-3.5 w-3.5" /> One SQLite statement · Ctrl/⌘+Enter to run</div>
                    <button
                      onClick={() => void executeQuery()}
                      disabled={!!busy || schemaLoading || !sql.trim()}
                      className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-br from-cyan-500 to-blue-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:from-cyan-400 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy === "query" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3 fill-current" />}
                      {busy === "query" ? "Running…" : "Run"}
                    </button>
                  </div>
                  <textarea
                    value={sql}
                    onChange={(event) => setSql(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        void executeQuery();
                      }
                    }}
                    spellCheck={false}
                    rows={7}
                    maxLength={64 * 1024}
                    className="w-full resize-none bg-transparent p-4 font-mono text-[12.5px] leading-relaxed text-emerald-200 outline-none placeholder:text-zinc-700"
                    placeholder="SELECT * FROM your_table LIMIT 100;"
                  />
                  <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-white/5 px-4 py-2 text-[9.5px] text-zinc-700">
                    <span>5 second timeout</span><span>1,000 displayed rows</span><span>2 MiB result limit</span><span>ATTACH and configuration PRAGMAs blocked</span>
                  </div>
                </div>
              </div>

              <div className="min-h-0 flex-1 p-4">
                <QueryResultView result={result} />
              </div>
            </>
          )}
        </main>
      </div>

      {connectOpen && (
        <ConnectSqliteDialog
          allowWrites={newAllowWrites}
          busy={busy === "connect"}
          error={error}
          onAllowWrites={setNewAllowWrites}
          onChoose={() => void chooseSqlite()}
          onClose={() => { if (!busy) { setConnectOpen(false); setError(""); } }}
        />
      )}
      {postgresConnectOpen && (
        <ConnectPostgresDialog
          request={postgresRequest}
          busy={busy === "postgres-connect"}
          error={error}
          onChange={setPostgresRequest}
          onConnect={() => void connectPostgresServer()}
          onClose={() => {
            if (!busy) {
              setPostgresConnectOpen(false);
              setPostgresRequest((current) => ({ ...current, password: "" }));
              setError("");
            }
          }}
        />
      )}
    </div>
  );
}

function PostgresSchemaObjectView({ object, disabled, onQuery }: { object: PostgresObject; disabled: boolean; onQuery: () => void }) {
  return (
    <details className="group mb-1 rounded-lg open:bg-white/[0.025]">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 py-2 text-[11.5px] text-zinc-300 hover:bg-white/5">
        <ChevronRight className="h-3 w-3 text-zinc-600 transition group-open:rotate-90" />
        <Table2 className={`h-3.5 w-3.5 ${object.kind === "view" ? "text-cyan-400" : "text-blue-400"}`} />
        <span className="min-w-0 flex-1 truncate font-mono"><span className="text-zinc-600">{object.schema}.</span>{object.name}</span>
        <span className="text-[9px] uppercase text-zinc-700">{object.kind}</span>
      </summary>
      <div className="pb-2 pl-8 pr-2">
        <button onClick={onQuery} disabled={disabled} className="mb-1 text-[10px] font-medium text-blue-400 hover:text-blue-300 disabled:opacity-40">Prepare read-only query</button>
        {object.columns.length === 0 && <div className="py-1 text-[10px] text-zinc-700">No user columns.</div>}
        {object.columns.map((column) => (
          <div key={`${object.schema}-${object.name}-${column.position}-${column.name}`} className="flex items-center gap-2 py-1 text-[10.5px]">
            <span className="min-w-0 flex-1 truncate font-mono text-zinc-500">{column.name}</span>
            <span className="max-w-28 shrink-0 truncate font-mono text-[9.5px] text-zinc-700" title={column.dataType}>{column.dataType || "unknown"}</span>
            {column.primaryKey && <KeyRound className="h-2.5 w-2.5 shrink-0 text-amber-400" />}
          </div>
        ))}
      </div>
    </details>
  );
}

function PostgresSchemaSummary({
  connection,
  schema,
  loading,
  sql,
  result,
  queryBusy,
  onSql,
  onRun,
  onRefresh,
}: {
  connection: PostgresConnectionInfo;
  schema: PostgresSchema | null;
  loading: boolean;
  sql: string;
  result: DatabaseQueryResult | null;
  queryBusy: boolean;
  onSql: (value: string) => void;
  onRun: () => void;
  onRefresh: () => void;
}) {
  const objects = schema?.objects ?? [];
  const tables = objects.filter((object) => object.kind === "table").length;
  const views = objects.filter((object) => object.kind === "view").length;
  const columns = objects.reduce((total, object) => total + object.columns.length, 0);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-lg font-semibold text-white"><Server className="h-5 w-5 text-blue-300" /> {connection.database}</div>
            <div className="mt-1 font-mono text-[11px] text-zinc-600">{connection.username}@{connection.host}:{connection.port} · PostgreSQL {connection.serverVersion}</div>
          </div>
          <button onClick={onRefresh} disabled={loading || queryBusy} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-white disabled:opacity-40">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh schema
          </button>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-4">
          {[["Objects", objects.length], ["Tables", tables], ["Views", views], ["Columns", columns]].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
              <div className="text-2xl font-semibold text-zinc-100">{value}</div>
              <div className="mt-1 text-[10px] uppercase tracking-wider text-zinc-600">{label}</div>
            </div>
          ))}
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-blue-500/15 bg-blue-500/[0.04] p-4">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-blue-200"><Database className="h-4 w-4" /> Fixed native schema inspection</div>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">DevLab reads user tables, materialized/regular views, foreign tables, columns, types, defaults and primary-key flags through one fixed Rust-owned catalog query. Renderer SQL is not accepted by this command.</p>
          </div>
          <div className={`rounded-xl border p-4 ${connection.tlsMode === "verify-full" ? "border-emerald-500/15 bg-emerald-500/[0.04]" : "border-amber-500/20 bg-amber-500/[0.05]"}`}>
            <div className={`flex items-center gap-2 text-[12px] font-semibold ${connection.tlsMode === "verify-full" ? "text-emerald-200" : "text-amber-200"}`}><ShieldCheck className="h-4 w-4" /> TLS {connection.tlsMode}</div>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">{connection.tlsMode === "verify-full" ? "The operating-system trust store verified the server certificate and hostname without plaintext fallback." : "This session is plaintext by explicit choice. Use it only for a local server or separately protected trusted network."}</p>
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-[#0d1017] ring-soft">
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-semibold text-zinc-300"><LockKeyhole className="h-3.5 w-3.5 text-emerald-400" /> Enforced read-only PostgreSQL query</div>
              <div className="mt-0.5 text-[9.5px] text-zinc-600">One SELECT, WITH, VALUES, or TABLE statement · Ctrl/⌘+Enter</div>
            </div>
            <button onClick={onRun} disabled={queryBusy || loading || !sql.trim()} className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-br from-blue-500 to-cyan-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:from-blue-400 hover:to-cyan-500 disabled:opacity-40">
              {queryBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3 fill-current" />}
              {queryBusy ? "Reading…" : "Run read"}
            </button>
          </div>
          <textarea
            value={sql}
            onChange={(event) => onSql(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                onRun();
              }
            }}
            spellCheck={false}
            rows={7}
            maxLength={64 * 1024}
            className="w-full resize-y bg-transparent p-4 font-mono text-[12.5px] leading-relaxed text-blue-100 outline-none placeholder:text-zinc-700"
            placeholder="SELECT * FROM public.your_table LIMIT 100;"
          />
          <div className="grid gap-1 border-t border-white/5 px-4 py-2 text-[9.5px] text-zinc-700 sm:grid-cols-3">
            <span>5 second timeout</span><span>1,000 displayed rows</span><span>200 displayed columns</span>
            <span>16,384 displayed characters/cell</span><span>2 MiB encoded rows</span><span>Writes and parameters rejected</span>
          </div>
        </div>
        <div className="mt-4 h-[420px] min-h-[260px]">
          <QueryResultView result={result} />
        </div>
        {!loading && schema && objects.length === 0 && (
          <div className="mt-4 rounded-xl border border-dashed border-white/10 p-6 text-center text-[12px] text-zinc-600">The server returned no visible user tables or views for this account.</div>
        )}
      </div>
    </div>
  );
}

function EmptyDatabaseState({
  needsWorkspace,
  onOpenWorkspace,
  onConnect,
}: {
  needsWorkspace: boolean;
  onOpenWorkspace: () => void;
  onConnect: () => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-lg text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-300 ring-1 ring-violet-500/20"><HardDrive className="h-7 w-7" /></span>
        <h3 className="mt-4 text-lg font-semibold text-white">{needsWorkspace ? "Select a workspace first" : "Open a real SQLite database"}</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">
          {needsWorkspace
            ? "Database files are restricted to the active canonical workspace. DevLab will not open an arbitrary path or substitute sample rows."
            : "Choose an existing SQLite file from the selected workspace. Connections stay in Rust memory and disappear when DevLab closes."}
        </p>
        <button onClick={needsWorkspace ? onOpenWorkspace : onConnect} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-400">
          {needsWorkspace ? <FolderOpen className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {needsWorkspace ? "Open workspace" : "Choose SQLite file"}
        </button>
        <div className="mt-5 rounded-lg border border-white/10 bg-black/20 p-3 text-left text-[11px] leading-relaxed text-zinc-600">
          SQLite supports bounded reads and confirmed writes. PostgreSQL supports verified connections, bounded schemas and enforced read-only queries; write execution remains disabled.
        </div>
      </div>
    </div>
  );
}

function QueryResultView({ result }: { result: DatabaseQueryResult | null }) {
  if (!result) {
    return (
      <div className="flex h-full min-h-[180px] items-center justify-center rounded-xl border border-dashed border-white/10 text-center text-[12px] text-zinc-700">
        Run a real query to display its bounded native result.
      </div>
    );
  }
  if (result.columns.length === 0) {
    return (
      <div className="flex h-full min-h-[180px] items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04]">
        <div className="text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-400" />
          <div className="mt-3 text-sm font-semibold text-emerald-200">Statement completed</div>
          <div className="mt-1 text-[12px] text-zinc-500">{result.affectedRows} affected rows · {result.elapsedMs} ms</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-white/10 ring-soft">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left text-[12px]">
          <thead className="sticky top-0 z-10 bg-[#12161f]/95 text-[10px] uppercase tracking-wider text-zinc-500 backdrop-blur">
            <tr>
              <th className="border-b border-r border-white/10 px-3 py-2.5 text-right font-medium">#</th>
              {result.columns.map((column, index) => (
                <th key={`${column}-${index}`} className="whitespace-nowrap border-b border-r border-white/10 px-3 py-2.5 font-medium last:border-r-0">
                  <span className="block">{column || `(column ${index + 1})`}</span>
                  {result.columnTypes?.[index] && <span className="mt-0.5 block normal-case tracking-normal text-zinc-700">{result.columnTypes[index]}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-white/[0.025]">
                <td className="border-b border-r border-white/5 px-3 py-2 text-right font-mono text-[10px] text-zinc-700">{rowIndex + 1}</td>
                {row.map((cell, cellIndex) => <ResultCell key={cellIndex} cell={cell} />)}
              </tr>
            ))}
          </tbody>
        </table>
        {result.rows.length === 0 && <div className="p-8 text-center text-[12px] text-zinc-600">The query returned zero rows.</div>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/5 bg-[#0d1017] px-4 py-2 text-[10.5px] text-zinc-600">
        <span>{result.rowCount} displayed rows · {result.elapsedMs} ms</span>
        {result.truncated && <span className="text-amber-300">Result truncated at DevLab’s safety limit</span>}
      </div>
    </div>
  );
}

function ResultCell({ cell }: { cell: DatabaseCell }) {
  const colors = cell.kind === "null"
    ? "italic text-zinc-700"
    : cell.kind === "blob"
      ? "text-violet-300"
      : cell.kind === "integer" || cell.kind === "real"
        ? "text-cyan-300"
        : cell.kind === "boolean"
          ? "text-amber-300"
          : "text-zinc-300";
  return (
    <td className={`max-w-md whitespace-pre-wrap break-words border-b border-r border-white/5 px-3 py-2 font-mono text-[11px] last:border-r-0 ${colors}`} title={cell.truncated ? "Value was truncated or binary content was omitted" : undefined}>
      {cell.value}
    </td>
  );
}

function ConnectPostgresDialog({
  request,
  busy,
  error,
  onChange,
  onConnect,
  onClose,
}: {
  request: PostgresConnectRequest;
  busy: boolean;
  error: string;
  onChange: (request: PostgresConnectRequest) => void;
  onConnect: () => void;
  onClose: () => void;
}) {
  const update = <K extends keyof PostgresConnectRequest>(key: K, value: PostgresConnectRequest[K]) => {
    onChange({ ...request, [key]: value });
  };
  const canConnect = request.host.trim()
    && request.database.trim()
    && request.username.trim()
    && request.port >= 1
    && request.port <= 65535;

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm">
      <div className="max-h-full w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-[#10141c] p-5 shadow-2xl ring-soft">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold text-white"><Server className="h-4 w-4 text-blue-300" /> Connect PostgreSQL</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">This opens a real native session with bounded schema inspection and enforced read-only queries. PostgreSQL writes remain disabled until their separate checkpoint.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="rounded p-1.5 text-zinc-500 hover:bg-white/5 hover:text-white disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <PostgresField label="Host" value={request.host} onChange={(value) => update("host", value)} placeholder="db.example.com" disabled={busy} />
          <label className="block">
            <span className="mb-1.5 block text-[10.5px] font-medium text-zinc-500">Port</span>
            <input type="number" min={1} max={65535} value={request.port} onChange={(event) => update("port", Number(event.target.value))} disabled={busy} className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2 text-[12px] text-zinc-200 outline-none focus:border-blue-500/50 disabled:opacity-50" />
          </label>
          <PostgresField label="Database" value={request.database} onChange={(value) => update("database", value)} placeholder="postgres" disabled={busy} />
          <PostgresField label="Username" value={request.username} onChange={(value) => update("username", value)} placeholder="postgres" disabled={busy} />
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-[10.5px] font-medium text-zinc-500">Password</span>
            <input type="password" value={request.password} onChange={(event) => update("password", event.target.value)} disabled={busy} autoComplete="new-password" placeholder={request.storePassword ? "Leave blank to reuse the stored password" : "Transient; never written to renderer storage"} maxLength={8 * 1024} className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-blue-500/50 disabled:opacity-50" />
          </label>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className={`rounded-xl border p-3 ${request.tlsMode === "verify-full" ? "border-emerald-500/20 bg-emerald-500/[0.04]" : "border-amber-500/25 bg-amber-500/[0.05]"}`}>
            <span className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-medium text-zinc-400"><ShieldCheck className="h-3.5 w-3.5" /> TLS policy</span>
            <select value={request.tlsMode} onChange={(event) => update("tlsMode", event.target.value as PostgresConnectRequest["tlsMode"])} disabled={busy} className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-2.5 py-2 text-[11.5px] text-zinc-200 outline-none disabled:opacity-50">
              <option value="verify-full">Verify certificate and hostname</option>
              <option value="disable">Disable TLS (local/trusted network only)</option>
            </select>
          </label>
          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/10 p-2.5">
              <input type="checkbox" checked={request.storePassword} onChange={(event) => update("storePassword", event.target.checked)} disabled={busy} className="mt-0.5 h-3.5 w-3.5 accent-blue-500" />
              <span className="text-[10.5px] leading-relaxed text-zinc-500">Store or reuse this password in the operating-system credential store.</span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/10 p-2.5">
              <input type="checkbox" checked={request.allowWrites} onChange={(event) => update("allowWrites", event.target.checked)} disabled={busy} className="mt-0.5 h-3.5 w-3.5 accent-amber-500" />
              <span className="text-[10.5px] leading-relaxed text-zinc-500">Record write intent for the future individually confirmed write checkpoint. It does not enable writes yet.</span>
            </label>
          </div>
        </div>

        <div className={`mt-4 flex gap-3 rounded-lg border p-3 text-[11px] leading-relaxed ${request.tlsMode === "disable" ? "border-amber-500/20 bg-amber-500/[0.05] text-amber-200/80" : "border-blue-500/15 bg-blue-500/[0.04] text-zinc-500"}`}>
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {request.tlsMode === "disable"
            ? "TLS is disabled. Passwords and database traffic may be visible to the network. Use this only for a local server or a separately protected trusted network."
            : "The operating-system trust store must validate the server certificate and the certificate must match the host. DevLab does not silently downgrade to plaintext."}
        </div>

        {error && <div className="mt-3 rounded-lg border border-rose-500/20 bg-rose-500/[0.07] p-3 text-[11.5px] text-rose-200">{error}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-white/10 px-3.5 py-2 text-xs text-zinc-400 hover:bg-white/5 hover:text-white disabled:opacity-40">Cancel</button>
          <button type="button" onClick={onConnect} disabled={busy || !canConnect} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-400 disabled:opacity-40">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Server className="h-3.5 w-3.5" />}
            {busy ? "Connecting…" : "Connect native session"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PostgresField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10.5px] font-medium text-zinc-500">{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} placeholder={placeholder} maxLength={253} className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-blue-500/50 disabled:opacity-50" />
    </label>
  );
}

function ConnectSqliteDialog({
  allowWrites,
  busy,
  error,
  onAllowWrites,
  onChoose,
  onClose,
}: {
  allowWrites: boolean;
  busy: boolean;
  error: string;
  onAllowWrites: (value: boolean) => void;
  onChoose: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#10141c] p-5 shadow-2xl ring-soft">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold text-white"><HardDrive className="h-4 w-4 text-violet-300" /> Open SQLite database</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">The native picker may choose only an existing regular file that resolves inside the active workspace.</p>
          </div>
          <button onClick={onClose} disabled={busy} className="rounded p-1.5 text-zinc-500 hover:bg-white/5 hover:text-white disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>

        <label className={`mt-5 flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${allowWrites ? "border-amber-500/25 bg-amber-500/[0.06]" : "border-emerald-500/20 bg-emerald-500/[0.04]"}`}>
          <input type="checkbox" checked={allowWrites} onChange={(event) => onAllowWrites(event.target.checked)} disabled={busy} className="mt-0.5 h-4 w-4 accent-amber-500" />
          <span>
            <span className={`block text-[12.5px] font-semibold ${allowWrites ? "text-amber-200" : "text-emerald-200"}`}>{allowWrites ? "Allow confirmed writes" : "Open read-only"}</span>
            <span className="mt-1 block text-[11.5px] leading-relaxed text-zinc-500">
              {allowWrites
                ? "INSERT, UPDATE, DELETE and DDL can run only after a separate confirmation for each statement. SQLite may change the file and create journal or WAL files beside it."
                : "SQLite is opened with an operating-system-enforced read-only flag. Mutating statements are rejected by Rust even if the UI is bypassed."}
            </span>
          </span>
        </label>

        <div className="mt-4 flex gap-3 rounded-lg border border-cyan-500/15 bg-cyan-500/[0.04] p-3 text-[11px] leading-relaxed text-zinc-500">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
          DevLab accepts one statement at a time, blocks database attachment and filesystem-capable SQL features, and bounds time, rows, columns, cells and encoded output.
        </div>

        {error && <div className="mt-3 rounded-lg border border-rose-500/20 bg-rose-500/[0.07] p-3 text-[11.5px] text-rose-200">{error}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="rounded-lg border border-white/10 px-3.5 py-2 text-xs text-zinc-400 hover:bg-white/5 hover:text-white disabled:opacity-40">Cancel</button>
          <button onClick={onChoose} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-violet-500 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-400 disabled:opacity-40">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
            {busy ? "Opening…" : "Choose existing file"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Banner({ tone, text, onClose }: { tone: "error" | "success"; text: string; onClose: () => void }) {
  return (
    <div className={`flex items-start gap-2 border-b px-6 py-2.5 text-[11.5px] ${tone === "error" ? "border-rose-500/20 bg-rose-500/[0.07] text-rose-200" : "border-emerald-500/20 bg-emerald-500/[0.07] text-emerald-200"}`}>
      {tone === "error" ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 break-words">{text}</span>
      <button onClick={onClose} className="text-current opacity-60 hover:opacity-100">Dismiss</button>
    </div>
  );
}

function quoteIdentifier(value: string): string {
  return `"${value.split('"').join('""')}"`;
}

function formatBytes(value: number | null): string {
  if (value === null) return "size unavailable";
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_024 / 1_024).toFixed(1)} MiB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The native database operation failed.";
}
