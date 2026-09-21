import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import {
  DatabaseCommandError,
  disconnectDatabase,
  getDatabaseConnections,
  getDatabaseSchema,
  runDatabaseQuery,
  selectSqliteDatabase,
  setDatabaseWriteAccess,
  type DatabaseCell,
  type DatabaseConnectionInfo,
  type DatabaseObject,
  type DatabaseQueryResult,
  type DatabaseSchema,
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
  ShieldAlert,
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

export function DatabasePanel({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  const [connections, setConnections] = useState<DatabaseConnectionInfo[]>([]);
  const [activeId, setActiveId] = useState("");
  const [schema, setSchema] = useState<DatabaseSchema | null>(null);
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [result, setResult] = useState<DatabaseQueryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsWorkspace, setNeedsWorkspace] = useState(false);
  const [filter, setFilter] = useState("");
  const [connectOpen, setConnectOpen] = useState(false);
  const [newAllowWrites, setNewAllowWrites] = useState(false);

  const active = connections.find((connection) => connection.id === activeId) ?? null;

  const refreshConnections = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await getDatabaseConnections();
      setConnections(next);
      setNeedsWorkspace(false);
      setActiveId((current) => (
        next.some((connection) => connection.id === current)
          ? current
          : next[0]?.id ?? ""
      ));
    } catch (caught) {
      if (caught instanceof DatabaseCommandError && caught.code === "workspace_not_selected") {
        setConnections([]);
        setActiveId("");
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

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  useEffect(() => {
    setResult(null);
    void loadSchema(activeId);
  }, [activeId, loadSchema]);

  const filteredObjects = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return schema?.objects ?? [];
    return (schema?.objects ?? []).filter((object) => (
      object.name.toLowerCase().includes(query)
      || object.columns.some((column) => column.name.toLowerCase().includes(query))
    ));
  }, [filter, schema]);

  async function chooseSqlite() {
    setBusy("connect");
    setError("");
    setNotice("");
    try {
      const connection = await selectSqliteDatabase(newAllowWrites);
      if (!connection) return;
      setConnections((current) => [...current, connection]);
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

  const subtitle = active
    ? `SQLite ${active.sqliteVersion} · ${active.path} · ${active.allowWrites ? "writes enabled" : "read-only"}`
    : "Workspace-scoped SQLite · PostgreSQL is the next database checkpoint";

  return (
    <div className="relative flex h-full flex-col">
      <PanelHeader
        title="Native Database Client"
        subtitle={subtitle}
        badge={active ? (active.allowWrites ? "Writes enabled" : "Read only") : "SQLite"}
        badgeOk={!!active && !active.allowWrites}
      />

      {error && <Banner tone="error" text={error} onClose={() => setError("")} />}
      {notice && <Banner tone="success" text={notice} onClose={() => setNotice("")} />}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col border-r border-white/5 bg-[#0d1017]/40">
          <div className="border-b border-white/5 p-3">
            <button
              onClick={() => { setError(""); setConnectOpen(true); }}
              disabled={!!busy || schemaLoading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-500/15 px-3 py-2 text-[12px] font-semibold text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" /> Open SQLite database
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
              <div className="rounded-lg border border-dashed border-white/10 p-4 text-center text-[11px] leading-relaxed text-zinc-600">No database is open. Connections live only for this DevLab process.</div>
            ) : connections.map((connection) => (
              <button
                key={connection.id}
                onClick={() => setActiveId(connection.id)}
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
              {schemaLoading ? (
                <div className="flex items-center gap-2 px-3 py-4 text-[11px] text-zinc-600"><Loader2 className="h-3 w-3 animate-spin" /> Reading real schema…</div>
              ) : !active ? (
                <div className="px-3 py-5 text-center text-[11px] text-zinc-700">Open a connection to inspect schema.</div>
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
          {!active ? (
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
          This SQLite checkpoint uses a bundled native engine. PostgreSQL connections, protected server credentials and TLS policy are the next database step.
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
                <th key={`${column}-${index}`} className="whitespace-nowrap border-b border-r border-white/10 px-3 py-2.5 font-medium last:border-r-0">{column || `(column ${index + 1})`}</th>
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
        : "text-zinc-300";
  return (
    <td className={`max-w-md whitespace-pre-wrap break-words border-b border-r border-white/5 px-3 py-2 font-mono text-[11px] last:border-r-0 ${colors}`} title={cell.truncated ? "Value was truncated or binary content was omitted" : undefined}>
      {cell.value}
    </td>
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
