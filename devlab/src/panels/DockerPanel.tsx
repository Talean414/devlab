import { useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { CodeBlock } from "../components/CodeBlock";
import { dockerfileTemplate, composeTemplate } from "../data/catalog";
import { Play, Square, Container, FileCode2, Layers } from "lucide-react";

interface Container {
  id: string;
  name: string;
  image: string;
  status: "running" | "exited";
  cpu: number;
  mem: number;
  ports: string;
}

const initial: Container[] = [
  { id: "ab12cd34", name: "app", image: "devlab/app:latest", status: "running", cpu: 12, mem: 210, ports: "3000→3000" },
  { id: "ef56gh78", name: "db", image: "postgres:16-alpine", status: "running", cpu: 4, mem: 96, ports: "5432→5432" },
  { id: "ij90kl12", name: "cache", image: "redis:7-alpine", status: "running", cpu: 1, mem: 18, ports: "6379→6379" },
  { id: "mn34op56", name: "worker", image: "devlab/worker", status: "exited", cpu: 0, mem: 0, ports: "—" },
];

export function DockerPanel() {
  const [containers, setContainers] = useState(initial);
  const [tab, setTab] = useState<"containers" | "dockerfile" | "compose">("containers");

  function toggle(id: string) {
    setContainers((cs) =>
      cs.map((c) =>
        c.id === id
          ? {
              ...c,
              status: c.status === "running" ? "exited" : "running",
              cpu: c.status === "running" ? 0 : Math.floor(Math.random() * 15) + 1,
              mem: c.status === "running" ? 0 : Math.floor(Math.random() * 200) + 20,
            }
          : c,
      ),
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Docker & Containers" subtitle="Build · run · inspect — replaces Docker Desktop GUI" />

      <div className="flex gap-5 border-b border-white/5 bg-[#0d1017]/40 px-6 text-xs">
        {([
          { id: "containers", Icon: Container, label: "Containers" },
          { id: "dockerfile", Icon: FileCode2, label: "Dockerfile" },
          { id: "compose",    Icon: Layers,    label: "docker-compose" },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`inline-flex items-center gap-1.5 -mb-px border-b-2 px-1 py-3 font-medium ${
              tab === t.id ? "border-cyan-400 text-white" : "border-transparent text-zinc-500"
            }`}
          >
            <t.Icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === "containers" && (
          <div className="space-y-2">
            {containers.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.02] px-5 py-3.5 ring-soft transition hover:bg-white/[0.04]"
              >
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                    c.status === "running" ? "animate-pulse bg-emerald-400 shadow shadow-emerald-400/50" : "bg-zinc-600"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-100">{c.name}</span>
                    <span className="font-mono text-[11px] text-zinc-500">{c.id}</span>
                  </div>
                  <div className="text-[11.5px] text-zinc-500">
                    {c.image} · {c.ports}
                  </div>
                </div>
                <div className="hidden gap-6 text-right text-[11px] sm:flex">
                  <div>
                    <div className="text-zinc-500">CPU</div>
                    <div className="font-mono text-cyan-300">{c.cpu}%</div>
                  </div>
                  <div>
                    <div className="text-zinc-500">MEM</div>
                    <div className="font-mono text-violet-300">{c.mem} MB</div>
                  </div>
                </div>
                <button
                  onClick={() => toggle(c.id)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                    c.status === "running"
                      ? "bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
                      : "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                  }`}
                >
                  {c.status === "running" ? <Square className="h-3 w-3 fill-current" /> : <Play className="h-3 w-3 fill-current" />}
                  {c.status === "running" ? "Stop" : "Start"}
                </button>
              </div>
            ))}
          </div>
        )}
        {tab === "dockerfile" && <CodeBlock code={dockerfileTemplate} lang="dockerfile" />}
        {tab === "compose"    && <CodeBlock code={composeTemplate}    lang="yaml" />}
      </div>
    </div>
  );
}
