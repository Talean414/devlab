import { useState } from "react";
import { tools } from "../data/catalog";
import { PanelHeader } from "./AgentPanel";
import {
  Bot, Plug, Database, Container, Eye, GitBranch, Cloud, Brush, Wand2,
  Server, Package, Box, ArrowRight, CheckCircle2, Circle, CircleDot,
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
  const list = cat === "All" ? tools : tools.filter((t) => t.category === cat);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Tool Marketplace (Pre-baked)"
        subtitle="Everything a developer might ever need — installed and ready, no marketplace hunting"
      />
      <div className="flex flex-wrap gap-1.5 border-b border-white/5 bg-[#0d1017]/40 px-6 py-3">
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
      <div className="grid flex-1 grid-cols-1 gap-3 overflow-y-auto p-6 md:grid-cols-2 xl:grid-cols-3">
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
