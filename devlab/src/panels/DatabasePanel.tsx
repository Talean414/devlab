import { useState } from "react";
import type { DbConnection } from "../types";
import { PanelHeader } from "./AgentPanel";
import { Play, Search, Database, Table2 } from "lucide-react";

const connections: DbConnection[] = [
  { id: "1", name: "app_production", engine: "PostgreSQL", host: "db.internal", port: 5432, status: "connected" },
  { id: "2", name: "cache", engine: "Redis", host: "localhost", port: 6379, status: "connected" },
  { id: "3", name: "analytics", engine: "MySQL", host: "localhost", port: 3306, status: "idle" },
  { id: "4", name: "sessions", engine: "MongoDB", host: "localhost", port: 27017, status: "idle" },
];

const sampleRows = [
  { id: 1, email: "ava@devlab.io", role: "admin", created: "2026-01-04" },
  { id: 2, email: "kai@devlab.io", role: "member", created: "2026-01-08" },
  { id: 3, email: "mira@devlab.io", role: "member", created: "2026-01-11" },
  { id: 4, email: "leo@devlab.io", role: "viewer", created: "2026-01-19" },
];

const engineColor: Record<string, string> = {
  PostgreSQL: "text-sky-300 bg-sky-500/10 ring-sky-500/20",
  Redis: "text-rose-300 bg-rose-500/10 ring-rose-500/20",
  MySQL: "text-orange-300 bg-orange-500/10 ring-orange-500/20",
  MongoDB: "text-emerald-300 bg-emerald-500/10 ring-emerald-500/20",
  SQLite: "text-violet-300 bg-violet-500/10 ring-violet-500/20",
};

export function DatabasePanel() {
  const [active, setActive] = useState(connections[0]);
  const [sql, setSql] = useState(
    "SELECT id, email, role, created\nFROM users\nORDER BY created DESC\nLIMIT 20;",
  );
  const [ran, setRan] = useState(true);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Database Client"
        subtitle="Postgres · MySQL · Redis · MongoDB — replaces DBeaver / pgAdmin"
      />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-white/5 bg-[#0d1017]/40">
          <div className="border-b border-white/5 p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <input
                placeholder="Filter connections…"
                className="w-full rounded-lg border border-white/10 bg-[#0b0e14] py-2 pl-9 pr-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-cyan-500/50"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Connections
            </div>
            {connections.map((c) => (
              <button
                key={c.id}
                onClick={() => setActive(c)}
                className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${
                  active.id === c.id ? "border border-cyan-500/30 bg-cyan-500/10" : "border border-transparent hover:bg-white/5"
                }`}
              >
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ${engineColor[c.engine]}`}>
                  <Database className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-zinc-100">{c.name}</div>
                  <div className="font-mono text-[11px] text-zinc-500">
                    {c.engine} :{c.port}
                  </div>
                </div>
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    c.status === "connected" ? "bg-emerald-400 shadow shadow-emerald-400/50" : "bg-zinc-600"
                  }`}
                />
              </button>
            ))}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col p-4">
          <div className="mb-3 rounded-xl border border-white/10 bg-[#0d1017] ring-soft">
            <div className="flex items-center justify-between border-b border-white/5 px-4 py-2">
              <div className="flex items-center gap-2 text-[12px] text-zinc-500">
                <Table2 className="h-3.5 w-3.5" />
                Query
                <span className="font-mono text-[11px] text-zinc-600">· {active.name}</span>
              </div>
              <button
                onClick={() => setRan(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-br from-cyan-500 to-blue-600 px-3 py-1.5 text-[11.5px] font-semibold text-white hover:from-cyan-400 hover:to-blue-500"
              >
                <Play className="h-3 w-3 fill-current" />
                Run
              </button>
            </div>
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              rows={4}
              className="w-full resize-none bg-transparent p-4 font-mono text-[12.5px] leading-relaxed text-emerald-200 outline-none"
            />
          </div>
          {ran && (
            <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-white/10 ring-soft">
              <table className="w-full text-left text-[13px]">
                <thead className="sticky top-0 bg-[#12161f]/95 backdrop-blur text-[11px] uppercase tracking-wider text-zinc-400">
                  <tr>
                    {Object.keys(sampleRows[0]).map((k) => (
                      <th key={k} className="border-b border-white/10 px-4 py-2.5 font-medium">
                        {k}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sampleRows.map((r) => (
                    <tr key={r.id} className="text-zinc-200 transition hover:bg-white/[0.03]">
                      {Object.values(r).map((v, i) => (
                        <td key={i} className="border-b border-white/5 px-4 py-2.5">
                          {String(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t border-white/5 bg-[#0d1017] px-4 py-2 text-[11px] text-zinc-500">
                {sampleRows.length} rows · sample data
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
