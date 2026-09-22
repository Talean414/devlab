import { useRef, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { getApiKey, getCurrentAiRoute, streamChat, type GenTurn } from "../lib/gemini";
import type { OpenGeneratedDrafts, VFile } from "../types";
import {
  Monitor, Server, Database, DatabaseZap, ListOrdered, HardDrive, ShieldCheck,
  BrainCircuit, Globe2, Wand2, Loader2, Trash2, MousePointer2, Link2,
  ArrowRight, FileCode2, Sparkles, RotateCcw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface ArchNode {
  id: string;
  kind: string;
  label: string;
  x: number;
  y: number;
}
interface Edge { id: string; from: string; to: string; label: string }

const KINDS: { id: string; label: string; Icon: LucideIcon; tech: string; tint: string }[] = [
  { id: "frontend", label: "Frontend", Icon: Monitor,      tech: "React + Vite",        tint: "#22d3ee" },
  { id: "api",      label: "API",      Icon: Server,       tech: "Node (Hono)",         tint: "#a78bfa" },
  { id: "worker",   label: "Worker",   Icon: ListOrdered,  tech: "Bun job runner",      tint: "#f472b6" },
  { id: "db",       label: "Database", Icon: Database,     tech: "PostgreSQL + Prisma", tint: "#34d399" },
  { id: "cache",    label: "Cache",    Icon: DatabaseZap,  tech: "Redis",               tint: "#fb7185" },
  { id: "storage",  label: "Storage",  Icon: HardDrive,    tech: "S3 / R2",             tint: "#fbbf24" },
  { id: "auth",     label: "Auth",     Icon: ShieldCheck,  tech: "JWT + refresh",       tint: "#4ade80" },
  { id: "llm",      label: "AI",       Icon: BrainCircuit, tech: "Gemini",              tint: "#c084fc" },
  { id: "edge",     label: "Edge",     Icon: Globe2,       tech: "Cloudflare Workers",  tint: "#38bdf8" },
];

const SAMPLE: { nodes: ArchNode[]; edges: Edge[] } = {
  nodes: [
    { id: "n1", kind: "frontend", label: "Web App",   x: 80,  y: 200 },
    { id: "n2", kind: "api",      label: "REST API",   x: 360, y: 200 },
    { id: "n3", kind: "auth",     label: "Auth",       x: 360, y: 60  },
    { id: "n4", kind: "db",       label: "Users DB",   x: 640, y: 130 },
    { id: "n5", kind: "cache",    label: "Sessions",   x: 640, y: 280 },
    { id: "n6", kind: "llm",      label: "Assistant",  x: 360, y: 350 },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2", label: "HTTPS" },
    { id: "e2", from: "n2", to: "n3", label: "verify" },
    { id: "e3", from: "n2", to: "n4", label: "SQL" },
    { id: "e4", from: "n2", to: "n5", label: "GET/SET" },
    { id: "e5", from: "n1", to: "n6", label: "stream" },
    { id: "e6", from: "n6", to: "n2", label: "tools" },
  ],
};

export function CanvasPanel({ onOpenFiles }: { onOpenFiles: OpenGeneratedDrafts }) {
  const [nodes, setNodes] = useState<ArchNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [mode, setMode] = useState<"move" | "link">("move");
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [built, setBuilt] = useState<VFile[]>([]);
  const [genLog, setGenLog] = useState<string[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);
  const nextId = useRef(1);

  const nw = 150, nh = 58;

  function kindOf(id: string) {
    return KINDS.find((k) => k.id === id) || KINDS[0];
  }

  function addNode(kind: string) {
    const k = kindOf(kind);
    const x = 80 + Math.random() * 400;
    const y = 80 + Math.random() * 300;
    setNodes((ns) => [...ns, { id: `n${nextId.current++}`, kind, label: k.label, x, y }]);
  }

  function onNodePointerDown(e: React.PointerEvent, n: ArchNode) {
    e.stopPropagation();
    if (mode === "link") {
      if (!linkFrom) setLinkFrom(n.id);
      else if (linkFrom !== n.id) {
        setEdges((es) => [...es, { id: `e${nextId.current++}`, from: linkFrom, to: n.id, label: "" }]);
        setLinkFrom(null);
      }
      return;
    }
    const p = toLocal(e);
    setDrag({ id: n.id, dx: p.x - n.x, dy: p.y - n.y });
  }

  function toLocal(e: React.PointerEvent) {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onMove(e: React.PointerEvent) {
    if (!drag) return;
    const p = toLocal(e);
    setNodes((ns) =>
      ns.map((n) => (n.id === drag.id ? { ...n, x: Math.max(0, p.x - drag.dx), y: Math.max(0, p.y - drag.dy) } : n)),
    );
  }

  function center(id: string) {
    const n = nodes.find((x) => x.id === id);
    return n ? { x: n.x + nw / 2, y: n.y + nh / 2 } : { x: 0, y: 0 };
  }

  function removeNode(id: string) {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.from !== id && e.to !== id));
  }

  function describe(): string {
    if (!nodes.length) return "";
    const lines = nodes.map((n) => {
      const k = kindOf(n.kind);
      const out = edges.filter((e) => e.from === n.id).map((e) => {
        const target = nodes.find((t) => t.id === e.to);
        return `${target?.label ?? "?"}${e.label ? ` (${e.label})` : ""}`;
      });
      return `- ${n.label}: ${k.tech}${out.length ? ` → connects to ${out.join(", ")}` : ""}`;
    });
    return lines.join("\n");
  }

  async function generate() {
    const route = getCurrentAiRoute("architecture");
    if (route.status !== "active") { setStatus(route.reason); return; }
    if (!getApiKey()) { setStatus("Add your Gemini key in Settings first."); return; }
    if (!nodes.length) { setStatus("Add some nodes to the canvas first (or load the sample)."); return; }
    setBusy(true); setGenLog([]); setBuilt([]);
    const log = (s: string) => setGenLog((l) => [...l, s]);
    try {
      log("Analyzing architecture diagram…");
      const planPrompt = `You are DevLab's system architect. Given this visual architecture:

${describe()}

Respond with ONLY valid JSON (no fences):
{
  "summary": "one sentence describing the system",
  "projectName": "kebab-case-name",
  "files": [
    { "path": "apps/web/src/App.tsx", "description": "...", "language": "typescript" },
    { "path": "apps/api/src/index.ts", "description": "...", "language": "typescript" },
    { "path": "packages/db/prisma/schema.prisma", "description": "...", "language": "prisma" },
    { "path": "docker-compose.yml", "description": "...", "language": "yaml" },
    { "path": "README.md", "description": "...", "language": "markdown" }
  ]
}
Rules: 6 to 12 files that form a coherent monorepo matching EVERY node in the diagram. Include one file per major component plus docker-compose.yml and README.md. Paths must be realistic.`;
      let acc = "";
      for await (const ch of streamChat([{ role: "user", text: planPrompt } as GenTurn], { task: "architecture" })) acc += ch;
      const json = acc.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      const plan = JSON.parse(json.slice(json.indexOf("{"), json.lastIndexOf("}") + 1)) as {
        summary: string; projectName: string;
        files: { path: string; description: string; language: string }[];
      };
      log(`Plan: ${plan.summary}`);
      log(`Generating ${plan.files.length} reviewable drafts for "${plan.projectName}"…`);

      const out: VFile[] = [];
      for (const f of plan.files) {
        log(`  drafting ${f.path}…`);
        let content = "";
        const p = `Write the complete file \`${f.path}\` for the project "${plan.projectName}".\n\nSystem: ${plan.summary}\nArchitecture:\n${describe()}\n\nThis file's role: ${f.description}\n\nOutput ONLY raw file contents — no markdown fences or commentary. Keep it under 120 lines, production-quality, consistent with the other files in this monorepo.`;
        for await (const ch of streamChat([{ role: "user", text: p }], { task: "coding" })) content += ch;
        out.push({
          path: `${plan.projectName}/${f.path}`,
          content: content.replace(/^```[\w]*\n?/, "").replace(/```\s*$/, "").trim(),
          language: f.language || "plaintext",
        });
        setBuilt([...out]);
      }
      log(`✓ Done — ${out.length} in-memory drafts ready for review. Nothing was written to disk.`);
      const opened = await onOpenFiles(out, `Architecture Canvas draft: ${plan.summary}`);
      if (opened) setStatus("done");
      else {
        log("Draft staging was cancelled or failed. Nothing was opened or written.");
        setStatus("Draft staging failed.");
      }
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Architecture Canvas → Code"
        subtitle="Draw your system and generate a reviewable monorepo draft without automatic filesystem writes"
        badge={nodes.length ? `${nodes.length} nodes · ${edges.length} links` : "Empty canvas"}
        badgeOk={nodes.length > 0}
      />

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/5 bg-[#0d1017]/50 px-4 py-2.5">
        <div className="flex gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1">
          <ModeBtn active={mode === "move"} onClick={() => setMode("move")} Icon={MousePointer2} label="Move" />
          <ModeBtn active={mode === "link"} onClick={() => { setMode("link"); setLinkFrom(null); }} Icon={Link2} label="Link" />
        </div>
        <span className="mx-1 h-5 w-px bg-white/10" />
        {KINDS.map((k) => (
          <button key={k.id} onClick={() => addNode(k.id)} title={`Add ${k.label}`}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 hover:bg-white/5"
            style={{ color: k.tint }}>
            <k.Icon className="h-4 w-4" />
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-white/10" />
        <button onClick={() => { setNodes(SAMPLE.nodes); setEdges(SAMPLE.edges); }}
          className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[11.5px] text-zinc-300 hover:bg-white/5">
          Load sample
        </button>
        <button onClick={() => { setNodes([]); setEdges([]); setGenLog([]); setStatus(""); }}
          className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11.5px] text-zinc-400 hover:bg-white/5">
          <Trash2 className="h-3.5 w-3.5" /> Clear
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={generate} disabled={busy || !nodes.length}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 px-4 py-2 text-[12.5px] font-semibold text-white shadow-lg shadow-cyan-900/30 transition hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
            {busy ? "Generating…" : "Sketch to code"}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* canvas */}
        <div className="relative flex-1 overflow-hidden" style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}>
          <svg
            ref={svgRef}
            onPointerMove={onMove}
            onPointerUp={() => setDrag(null)}
            onPointerLeave={() => setDrag(null)}
            onClick={() => mode === "link" && setLinkFrom(null)}
            className="h-full w-full select-none"
          >
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#71717a" />
              </marker>
            </defs>
            {edges.map((e) => {
              const a = center(e.from), b = center(e.to);
              const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 24 };
              return (
                <g key={e.id}>
                  <path
                    d={`M ${a.x} ${a.y} Q ${mid.x} ${mid.y} ${b.x} ${b.y}`}
                    fill="none" stroke="#52525b" strokeWidth="1.5"
                    strokeDasharray="5 4" markerEnd="url(#arrow)"
                  />
                  {e.label && (
                    <text x={(a.x + mid.x + b.x) / 3 - 12} y={(a.y + mid.y + b.y) / 3 - 6}
                      className="fill-zinc-500" fontSize="10" fontFamily="monospace">
                      {e.label}
                    </text>
                  )}
                  <circle
                    cx={(a.x + mid.x + b.x) / 3} cy={(a.y + mid.y + b.y) / 3 + 10}
                    r="6" fill="transparent" className="cursor-pointer hover:stroke-rose-500 hover:stroke-2"
                    onClick={(ev) => { ev.stopPropagation(); setEdges((es) => es.filter((x) => x.id !== e.id)); }}
                  />
                </g>
              );
            })}

            {nodes.map((n) => {
              const k = kindOf(n.kind);
              const linking = linkFrom === n.id;
              return (
                <g key={n.id} style={{ cursor: mode === "move" ? "grab" : "crosshair", transform: `translate(${n.x}px, ${n.y}px)` }}
                  onPointerDown={(e) => onNodePointerDown(e, n)}
                  onPointerEnter={() => setHoverId(n.id)} onPointerLeave={() => setHoverId(null)}>
                  <rect width={nw} height={nh} rx="12"
                    fill={linking ? `${k.tint}22` : "#12161f"}
                    stroke={linking ? k.tint : hoverId === n.id ? `${k.tint}88` : "#ffffff1f"}
                    strokeWidth={linking ? 2 : 1.2} />
                  <rect width="4" height={nh} rx="2" fill={k.tint} opacity="0.85" />
                  <text x="16" y="26" className="fill-zinc-100" fontSize="13" fontWeight="600">{n.label}</text>
                  <text x="16" y="44" className="fill-zinc-500" fontSize="10" fontFamily="monospace">{k.tech}</text>
                  {hoverId === n.id && mode === "move" && (
                    <g transform={`translate(${nw - 18}, 6)`} onClick={(ev) => { ev.stopPropagation(); removeNode(n.id); }}>
                      <circle r="8" cx="6" cy="6" fill="#fff2" />
                      <text x="3" y="9.5" className="fill-rose-400" fontSize="10">✕</text>
                    </g>
                  )}
                </g>
              );
            })}
            {nodes.length === 0 && (
              <text x="50%" y="48%" textAnchor="middle" className="fill-zinc-600" fontSize="14">
                Click a component in the toolbar to drop it here · drag to arrange · Link mode to wire them
              </text>
            )}
            {mode === "link" && (
              <text x="50%" y="24" textAnchor="middle" className="fill-cyan-400" fontSize="11">
                {linkFrom ? "Now click the TARGET node to create the connection" : "Click the SOURCE node to start a connection"}
              </text>
            )}
          </svg>
        </div>

        {/* generation log */}
        {(busy || genLog.length > 0 || status) && (
          <aside className="flex w-80 shrink-0 flex-col border-l border-white/5 bg-[#0d1017]/60">
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3 text-[12px] font-semibold text-zinc-200">
              <Sparkles className="h-4 w-4 text-cyan-400" /> Build log
              {status === "done" && (
                <button onClick={() => { void onOpenFiles(built, "Architecture Canvas generated drafts"); }} className="ml-auto inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:underline">
                  Review drafts <ArrowRight className="h-3 w-3" />
                </button>
              )}
            </div>
            <div className="flex-1 space-y-1 overflow-y-auto p-4 font-mono text-[11.5px] leading-relaxed">
              {genLog.map((l, i) => (
                <div key={i} className={l.startsWith("✓") || l.startsWith("Plan") ? "text-emerald-300" : "text-zinc-400"}>{l}</div>
              ))}
              {busy && <div className="flex items-center gap-2 text-amber-300"><Loader2 className="h-3 w-3 animate-spin" /> streaming…</div>}
              {status && status !== "done" && <div className="text-rose-400">{status}</div>}
            </div>
            {status === "done" && (
              <div className="border-t border-white/5 p-3">
                <button onClick={() => { setNodes([]); setEdges([]); setGenLog([]); setStatus(""); setBuilt([]); nextId.current = 1; }}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/10 py-2 text-[12px] text-zinc-300 hover:bg-white/5">
                  <RotateCcw className="h-3.5 w-3.5" /> New sketch
                </button>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function ModeBtn({ active, onClick, Icon, label }: { active: boolean; onClick: () => void; Icon: LucideIcon; label: string }) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11.5px] font-medium transition ${
        active ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300"
      }`}>
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

void FileCode2;
