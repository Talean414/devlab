import { useState } from "react";
import { projectTemplates, stacks } from "../data/templates";
import { PanelHeader } from "./AgentPanel";
import { CodeBlock } from "../components/CodeBlock";
import { Search, Layers, Zap, ArrowRight, Tag, Wand2 } from "lucide-react";

export function ExplorerPanel({ onAgentMode }: { onAgentMode?: () => void }) {
  const [selected, setSelected] = useState(projectTemplates[0]);
  const [query, setQuery] = useState("");
  const [stack, setStack] = useState("All");

  const filtered = projectTemplates.filter(
    (t) =>
      (stack === "All" || t.stack === stack) &&
      (t.name.toLowerCase().includes(query.toLowerCase()) ||
        t.tags.some((tag) => tag.includes(query.toLowerCase())) ||
        (t.lang ?? "").toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Project Templates"
        subtitle={`${projectTemplates.length} setup recipes to review and copy`}
      />

      {onAgentMode && (
        <button
          onClick={onAgentMode}
          className="group mx-6 mt-4 flex items-center gap-4 rounded-xl border border-cyan-500/30 bg-gradient-to-r from-cyan-500/10 to-violet-600/10 p-4 text-left transition hover:border-cyan-500/50 hover:from-cyan-500/15 hover:to-violet-600/15"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/25 to-violet-600/25 ring-1 ring-white/10">
            <Wand2 className="h-5 w-5 text-cyan-200" />
          </span>
          <span className="flex-1">
            <span className="block text-sm font-semibold text-white">Build with the agent instead</span>
            <span className="block text-[12.5px] text-zinc-400">
              Describe your idea in plain English — the agent picks the stack and prepares a plan for review. Native file generation remains disabled.
            </span>
          </span>
          <ArrowRight className="h-4 w-4 text-cyan-300 transition group-hover:translate-x-0.5" />
        </button>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col border-r border-white/5 bg-[#0d1017]/40">
          <div className="space-y-2 border-b border-white/5 p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search templates…"
                className="w-full rounded-lg border border-white/10 bg-[#0b0e14] py-2 pl-9 pr-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-cyan-500/50"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {stacks.map((st) => (
                <button
                  key={st}
                  onClick={() => setStack(st)}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
                    stack === st ? "bg-cyan-500 text-white" : "bg-white/5 text-zinc-400 hover:bg-white/10"
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 space-y-1 overflow-y-auto p-3">
            {filtered.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelected(t)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ring-soft ${
                  selected.id === t.id
                    ? "border border-cyan-500/40 bg-cyan-500/10"
                    : "border border-transparent hover:bg-white/5"
                }`}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/15 to-violet-600/15 ring-1 ring-white/10">
                  <Layers className="h-4 w-4 text-cyan-200" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-zinc-100">{t.name}</div>
                  <div className="text-[11px] text-zinc-500">{t.stack}</div>
                </div>
                {selected.id === t.id && (
                  <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0 text-cyan-400" />
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="py-8 text-center text-sm text-zinc-500">No matches.</div>
            )}
          </div>
        </aside>

        <div className="flex-1 overflow-y-auto p-8">
          <div className="mb-5 flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/20 to-violet-600/20 ring-1 ring-white/10">
              <Layers className="h-6 w-6 text-cyan-200" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2.5">
                <h3 className="text-2xl font-semibold text-white">{selected.name}</h3>
                {selected.lang && (
                  <span className="rounded-md bg-violet-500/15 px-2 py-0.5 text-[11px] font-medium text-violet-300 ring-1 ring-violet-500/20">
                    {selected.lang}
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-sm text-zinc-400">{selected.description}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {selected.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-zinc-400"
                  >
                    <Tag className="h-2.5 w-2.5" /> {tag}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            <Zap className="h-3 w-3" />
            Setup command reference
          </div>
          <CodeBlock code={selected.commands.join("\n")} lang="bash" />
          <div className="mt-4 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] p-3.5 text-[13px] text-cyan-200/90">
            Review commands before copying them. Automatic execution stays disabled until the scoped workspace and native process policy are implemented.
          </div>
        </div>
      </div>
    </div>
  );
}
