import { useEffect, useMemo, useState } from "react";
import { tools } from "../data/catalog";
import { toolchainSnapshot, type ToolchainSnapshot, type ToolchainTool } from "../lib/toolchain";
import { PanelHeader } from "./AgentPanel";
import {
  Bot, Plug, Database, Container, Eye, GitBranch, Cloud, Brush, Wand2,
  Server, Package, Box, ArrowRight, CheckCircle2, Circle, CircleDot,
  Loader2, RefreshCw, TerminalSquare, AlertTriangle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

const iconMap: Record<string, LucideIcon> = {
  "roo-code": Bot, "continue": ArrowRight,
  "rest-client": Plug, "thunder": Plug,
  "database-client": Database, "docker": Container, "gitlens": GitBranch,
  "preview": Eye, "k8s": Cloud, "gha": Package,
  "prettier": Wand2, "eslint": Brush, "remote-ssh": Server,
};

const categories = ["All", ...Array.from(new Set(tools.map((t) => t.category)))];

export function ToolsPanel() {
  const [cat, setCat] = useState("All");
  const [snapshot, setSnapshot] = useState<ToolchainSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const list = cat === "All" ? tools : tools.filter((t) => t.category === cat);
  const availableCount = snapshot?.tools.filter((tool) => tool.available).length ?? 0;
  const detectedCategories = useMemo(() => (
    snapshot ? Array.from(new Set(snapshot.tools.map((tool) => tool.category))).sort() : []
  ), [snapshot]);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setSnapshot(await toolchainSnapshot());
    } catch (err) {
      setError(formatToolchainError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Toolchain"
        subtitle="Read-only native detection for local developer tools. No install, update or arbitrary command execution is exposed here."
        badge={snapshot ? `${availableCount}/${snapshot.tools.length} detected` : loading ? "Detecting" : "Unavailable"}
        badgeOk={Boolean(snapshot && availableCount > 0)}
      />

      <div className="border-b border-white/5 bg-[#0d1017]/60 p-6">
        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.04] p-4 ring-soft">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500/10 ring-1 ring-cyan-500/20">
              <TerminalSquare className="h-5 w-5 text-cyan-200" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-white">Native toolchain snapshot</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
                DevLab probes a fixed allowlist with bounded version commands, without a shell. Missing tools are reported honestly.
              </p>
            </div>
            <button
              onClick={() => void refresh()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-[12px] font-semibold text-zinc-300 hover:bg-white/5 disabled:opacity-40"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </button>
          </div>
          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-[12px] text-rose-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {snapshot && (
            <div className="mt-4 grid gap-2 text-[11.5px] text-zinc-500 sm:grid-cols-3">
              <div className="rounded-lg border border-white/10 bg-black/15 p-2">
                <div className="text-zinc-600">Checked</div>
                <div className="mt-1 font-mono text-zinc-300">{new Date(snapshot.checkedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/15 p-2">
                <div className="text-zinc-600">Bounds</div>
                <div className="mt-1 font-mono text-zinc-300">{snapshot.timeoutMs} ms · {(snapshot.maxOutputBytes / 1024).toFixed(0)} KiB output</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/15 p-2">
                <div className="text-zinc-600">Categories</div>
                <div className="mt-1 truncate text-zinc-300">{detectedCategories.join(" · ")}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white">Detected local tools</h3>
              <p className="mt-1 text-[12px] text-zinc-500">Version checks are fixed and read-only; DevLab does not install or modify tools.</p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(snapshot?.tools ?? []).map((tool) => <ToolchainCard key={tool.id} tool={tool} />)}
            {loading && !snapshot && Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="h-32 animate-pulse rounded-xl border border-white/10 bg-white/[0.03]" />
            ))}
          </div>
        </section>

        <section className="mt-8">
          <div className="mb-3 flex flex-wrap gap-1.5">
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCat(c)}
                className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition ${
                  cat === c
                    ? "bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-md shadow-cyan-900/20"
                    : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list.map((t) => {
              const Icon = iconMap[t.id] || Box;
              return (
                <div
                  key={t.id}
                  className="group flex flex-col rounded-xl border border-white/10 bg-white/[0.02] p-5 ring-soft transition hover:border-cyan-500/30 hover:bg-cyan-500/[0.03]"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/15 to-violet-600/15 ring-1 ring-white/10">
                      <Icon className="h-5 w-5 text-cyan-200" />
                    </div>
                    <StatusPill status={t.status} />
                  </div>
                  <h3 className="mt-4 text-[15px] font-semibold text-white">{t.name}</h3>
                  <p className="mt-1.5 flex-1 text-[13px] leading-relaxed text-zinc-400">{t.description}</p>
                  <div className="mt-4 flex items-center gap-2 border-t border-white/5 pt-3 text-[11.5px]">
                    <span className="text-zinc-500">Replaces</span>
                    <span className="font-medium text-zinc-300">{t.replaces}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function ToolchainCard({ tool }: { tool: ToolchainTool }) {
  return (
    <div className={`rounded-xl border p-4 ring-soft ${tool.available ? "border-emerald-500/20 bg-emerald-500/[0.035]" : "border-white/10 bg-white/[0.02]"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-[13px] font-semibold text-zinc-100">{tool.label}</h4>
          <div className="mt-1 font-mono text-[10.5px] text-zinc-500">{tool.command} {tool.args.join(" ")}</div>
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${tool.available ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300" : "border-zinc-500/20 bg-zinc-500/10 text-zinc-400"}`}>
          {tool.available ? "Detected" : "Missing"}
        </span>
      </div>
      <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-2 font-mono text-[10.5px] leading-relaxed text-zinc-300">
        {tool.version ?? tool.errorCode ?? "not detected"}
      </div>
      <p className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-zinc-500">{tool.detail}</p>
      <div className="mt-3 text-[10.5px] uppercase tracking-wider text-zinc-600">{tool.category}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    "baked-in": "bg-emerald-500/15 text-emerald-300 border-emerald-500/20",
    "one-click": "bg-blue-500/15 text-blue-300 border-blue-500/20",
    external: "bg-zinc-500/15 text-zinc-400 border-zinc-500/20",
  };
  const Icon: LucideIcon = status === "baked-in" ? CheckCircle2 : status === "one-click" ? CircleDot : Circle;
  const label = status === "baked-in" ? "Baked in" : status === "one-click" ? "1-click" : "external";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${map[status]}`}>
      <Icon className="h-2.5 w-2.5" /> {label}
    </span>
  );
}

function formatToolchainError(error: unknown): string {
  if (error && typeof error === "object") {
    const maybe = error as { code?: unknown; message?: unknown };
    if (typeof maybe.message === "string" && typeof maybe.code === "string") return `${maybe.message} (${maybe.code})`;
    if (typeof maybe.message === "string") return maybe.message;
  }
  return typeof error === "string" ? error : "Could not detect local toolchains.";
}
