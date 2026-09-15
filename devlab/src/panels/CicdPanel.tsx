import { useState } from "react";
import { ciTemplates } from "../data/catalog";
import { PanelHeader } from "./AgentPanel";
import { CodeBlock } from "../components/CodeBlock";
import { CheckCircle2, Loader2, XCircle, FileCode2, Rocket } from "lucide-react";

const runs = [
  { id: 1, name: "Node CI", branch: "main", status: "success", time: "42s", when: "5m ago" },
  { id: 2, name: "Deploy Pages", branch: "main", status: "running", time: "—", when: "now" },
  { id: 3, name: "Docker", branch: "v1.2.0", status: "success", time: "1m 18s", when: "2h ago" },
  { id: 4, name: "Node CI", branch: "fix/auth", status: "failed", time: "31s", when: "4h ago" },
];

const statusMap: Record<string, { Icon: typeof CheckCircle2; cls: string }> = {
  success: { Icon: CheckCircle2, cls: "text-emerald-400" },
  running: { Icon: Loader2,      cls: "text-amber-400" },
  failed:  { Icon: XCircle,      cls: "text-rose-400" },
};

export function CicdPanel() {
  const [selected, setSelected] = useState(ciTemplates[0]);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="CI / CD Pipelines" subtitle="Author workflows & monitor runs — no external CI dashboards" />

      <div className="flex min-h-0 flex-1">
        <div className="flex-1 overflow-y-auto border-r border-white/5 p-6">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
            <Rocket className="h-4 w-4 text-cyan-400" />
            Recent workflow runs
          </h3>
          <div className="space-y-2">
            {runs.map((r) => {
              const S = statusMap[r.status];
              return (
                <div
                  key={r.id}
                  className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 ring-soft transition hover:bg-white/[0.04]"
                >
                  <S.Icon className={`h-5 w-5 ${S.cls} ${r.status === "running" ? "animate-spin" : ""}`} />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-zinc-100">{r.name}</div>
                    <div className="text-[11.5px] text-zinc-500">
                      <span className="font-mono">{r.branch}</span>
                      <span className="mx-1.5 text-zinc-700">·</span>
                      {r.when}
                    </div>
                  </div>
                  <span className="font-mono text-[11px] text-zinc-500">{r.time}</span>
                </div>
              );
            })}
          </div>

          <h3 className="mb-3 mt-8 flex items-center gap-2 text-sm font-semibold text-white">
            <FileCode2 className="h-4 w-4 text-cyan-400" />
            Add a pipeline
          </h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {ciTemplates.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelected(t)}
                className={`rounded-xl border p-4 text-left transition ring-soft ${
                  selected.id === t.id
                    ? "border-cyan-500/40 bg-cyan-500/5"
                    : "border-white/10 hover:bg-white/[0.04]"
                }`}
              >
                <div className="text-sm font-semibold text-zinc-100">{t.name}</div>
                <div className="mt-0.5 text-[12px] text-zinc-500">{t.description}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="flex w-[48%] shrink-0 flex-col overflow-y-auto p-6">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-white">{selected.name}</h3>
              <p className="font-mono text-[11px] text-zinc-500">{selected.filename}</p>
            </div>
            <span className="rounded-md bg-white/5 px-2 py-1 text-[11px] text-zinc-400">
              {selected.provider}
            </span>
          </div>
          <CodeBlock code={selected.yaml} lang="yaml" />
        </div>
      </div>
    </div>
  );
}
