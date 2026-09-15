import { useRef, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { Markdown } from "../components/CodeBlock";
import { getApiKey, streamChat, type GenTurn } from "../lib/gemini";
import { loadSettings } from "../lib/settings";
import { projectTemplates } from "../data/templates";
import type { VFile } from "../types";
import {
  Wand2, Loader2, CheckCircle2, FileCode2, TerminalSquare,
  Sparkles, RotateCcw, FolderPlus, ArrowRight,
} from "lucide-react";

type Phase = "brief" | "planning" | "review" | "done";

interface Plan {
  summary: string;
  stack: string[];
  steps: { title: string; detail: string }[];
  commands: string[];
  files: { path: string; description: string }[];
}

const IDEAS = [
  "A SaaS dashboard with auth, Stripe billing and a Postgres database",
  "A REST API for a task manager with JWT auth and OpenAPI docs",
  "A realtime chat app with WebSockets and message persistence",
  "A CLI tool that scans a codebase and reports dependency risks",
];

export function BuilderPanel({
  onNeedKey, onOpenFiles,
}: {
  onNeedKey: () => void;
  onOpenFiles: (files: VFile[]) => void;
}) {
  const [phase, setPhase] = useState<Phase>("brief");
  const [brief, setBrief] = useState("");
  const [raw, setRaw] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState<string | null>(null);
  const [builtFiles, setBuiltFiles] = useState<VFile[]>([]);
  const outRef = useRef<HTMLDivElement>(null);
  const settings = loadSettings();

  async function generatePlan(text: string) {
    if (!text.trim()) return;
    if (!getApiKey()) { onNeedKey(); return; }
    setBusy(true); setError(""); setRaw(""); setPlan(null); setPhase("planning");

    const templateList = projectTemplates.map((t) => `${t.id} (${t.stack}, ${t.lang})`).join(", ");
    const prompt = `You are DevLab's project architect. The developer wants to build:

"""${text}"""

Respond with ONLY a valid JSON object (no markdown fences, no prose) matching this exact shape:
{
  "summary": "one-paragraph description of what will be built",
  "stack": ["tech", "choices"],
  "steps": [{ "title": "short step name", "detail": "what happens in this step" }],
  "commands": ["shell command 1", "shell command 2"],
  "files": [{ "path": "src/index.ts", "description": "what this file does" }]
}

Rules:
- 4-7 steps, 4-10 commands, 4-10 files.
- Prefer these known scaffolds when relevant: ${templateList}
- Commands must be real, runnable shell commands.
- File paths must be realistic for the chosen stack.`;

    const history: GenTurn[] = [{ role: "user", text: prompt }];
    try {
      let acc = "";
      for await (const chunk of streamChat(history)) {
        acc += chunk;
        setRaw(acc);
        outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
      }
      const cleaned = acc.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      const jsonStr = firstBrace > -1 ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned;
      const parsed = JSON.parse(jsonStr) as Plan;
      setPlan(parsed);
      setPhase("review");
    } catch (e) {
      setError(
        (e as Error).message.includes("JSON")
          ? "The model returned a response that wasn't valid JSON. Try rephrasing your brief or hit Retry."
          : (e as Error).message,
      );
      setPhase("brief");
    } finally {
      setBusy(false);
    }
  }

  async function generateFile(path: string, description: string) {
    if (!getApiKey()) { onNeedKey(); return; }
    setGenerating(path);
    const prompt = `Write the complete contents of the file \`${path}\` for this project:

Project: ${plan?.summary}
Stack: ${plan?.stack.join(", ")}
This file's purpose: ${description}

Output ONLY the raw file contents. No markdown fences, no explanation, no commentary.`;
    try {
      let acc = "";
      for await (const chunk of streamChat([{ role: "user", text: prompt }])) acc += chunk;
      const content = acc.replace(/^```[\w]*\s*/i, "").replace(/```\s*$/, "").trim();
      const ext = path.split(".").pop() || "txt";
      const langMap: Record<string, string> = {
        ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
        py: "python", rs: "rust", go: "go", java: "java", cs: "csharp",
        rb: "ruby", php: "php", ex: "elixir", json: "json", yml: "yaml",
        yaml: "yaml", md: "markdown", html: "html", css: "css", sql: "sql",
        sh: "shell", toml: "toml", dockerfile: "dockerfile",
      };
      const vfile: VFile = { path, content, language: langMap[ext] || "plaintext" };
      setBuiltFiles((f) => [...f.filter((x) => x.path !== path), vfile]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(null);
    }
  }

  async function generateAll() {
    if (!plan) return;
    for (const f of plan.files) await generateFile(f.path, f.description);
    setPhase("done");
  }

  function reset() {
    setPhase("brief"); setBrief(""); setPlan(null); setRaw("");
    setBuiltFiles([]); setError("");
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Agentic Project Builder"
        subtitle="Describe what you want — the agent plans the stack, commands and files"
        badge={settings.autonomy === "auto" ? "Autonomous" : settings.autonomy === "suggest" ? "Suggest mode" : "Ask first"}
        badgeOk={settings.autonomy !== "ask"}
      />

      <div className="flex-1 overflow-y-auto">
        {/* ── Brief phase ── */}
        {phase === "brief" && (
          <div className="mx-auto max-w-3xl px-6 py-10">
            <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500/20 to-violet-600/20 ring-1 ring-white/10">
              <Wand2 className="h-6 w-6 text-cyan-300" />
            </div>
            <h2 className="text-2xl font-semibold text-white">What are we building?</h2>
            <p className="mt-2 text-sm text-zinc-400">
              Describe your project in plain English. The agent will choose a stack, produce a
              step-by-step plan, generate the shell commands and write the starter files.
            </p>

            <div className="mt-6 rounded-2xl border border-white/10 bg-[#0d1017] p-2 transition focus-within:border-cyan-500/50">
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generatePlan(brief);
                }}
                rows={5}
                placeholder="e.g. A multi-tenant SaaS for invoice tracking with Next.js, Postgres, Stripe billing and role-based access…"
                className="w-full resize-none bg-transparent p-3 text-[14px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600"
              />
              <div className="flex items-center justify-between px-2 pb-1">
                <span className="text-[11px] text-zinc-600">⌘/Ctrl + Enter to plan</span>
                <button
                  onClick={() => generatePlan(brief)}
                  disabled={busy || !brief.trim()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Generate plan
                </button>
              </div>
            </div>

            {error && (
              <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-[13px] text-rose-200">
                {error}
              </div>
            )}

            <div className="mt-8">
              <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                Or start from an idea
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {IDEAS.map((i) => (
                  <button
                    key={i}
                    onClick={() => { setBrief(i); generatePlan(i); }}
                    className="group flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3.5 text-left text-[13px] text-zinc-300 transition hover:border-cyan-500/40 hover:bg-cyan-500/[0.04]"
                  >
                    <FolderPlus className="mt-0.5 h-4 w-4 shrink-0 text-cyan-400" />
                    <span>{i}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Planning phase ── */}
        {phase === "planning" && (
          <div className="mx-auto max-w-3xl px-6 py-10">
            <div className="flex items-center gap-3 text-sm text-zinc-300">
              <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
              Architecting your project…
            </div>
            <div
              ref={outRef}
              className="mt-4 max-h-96 overflow-y-auto rounded-xl border border-white/10 bg-[#0b0e14] p-4 font-mono text-[11.5px] leading-relaxed text-zinc-500"
            >
              {raw || "Waiting for the model…"}
            </div>
          </div>
        )}

        {/* ── Review / done phase ── */}
        {(phase === "review" || phase === "done") && plan && (
          <div className="mx-auto max-w-4xl px-6 py-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-white">Build plan ready</h2>
                <p className="mt-1.5 max-w-2xl text-sm text-zinc-400">{plan.summary}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {plan.stack.map((s) => (
                    <span key={s} className="rounded-md bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300 ring-1 ring-cyan-500/20">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
              <button
                onClick={reset}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-400 hover:bg-white/5"
              >
                <RotateCcw className="h-3 w-3" /> New brief
              </button>
            </div>

            {/* Steps */}
            <h3 className="mb-3 mt-8 text-sm font-semibold text-white">Execution plan</h3>
            <div className="relative space-y-4 pl-7">
              <div className="absolute bottom-2 left-[9px] top-2 w-px bg-white/10" />
              {plan.steps.map((s, i) => (
                <div key={i} className="relative">
                  <span className="absolute -left-7 top-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-cyan-400 bg-[#0b0d12] text-[9px] font-bold text-cyan-300">
                    {i + 1}
                  </span>
                  <div className="text-[13.5px] font-medium text-zinc-100">{s.title}</div>
                  <div className="text-[12.5px] text-zinc-500">{s.detail}</div>
                </div>
              ))}
            </div>

            {/* Commands */}
            <h3 className="mb-2 mt-8 flex items-center gap-2 text-sm font-semibold text-white">
              <TerminalSquare className="h-4 w-4 text-cyan-400" />
              Setup commands
            </h3>
            <Markdown text={"```bash\n" + plan.commands.join("\n") + "\n```"} />

            {/* Files */}
            <div className="mb-3 mt-8 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                <FileCode2 className="h-4 w-4 text-cyan-400" />
                Project files ({builtFiles.length}/{plan.files.length} generated)
              </h3>
              <div className="flex gap-2">
                <button
                  onClick={generateAll}
                  disabled={!!generating}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40"
                >
                  {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
                  Generate all files
                </button>
                {builtFiles.length > 0 && (
                  <button
                    onClick={() => onOpenFiles(builtFiles)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20"
                  >
                    Open in Editor <ArrowRight className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              {plan.files.map((f) => {
                const built = builtFiles.find((b) => b.path === f.path);
                const isGen = generating === f.path;
                return (
                  <div
                    key={f.path}
                    className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-4 py-2.5"
                  >
                    {isGen ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-400" />
                    ) : built ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                    ) : (
                      <FileCode2 className="h-4 w-4 shrink-0 text-zinc-600" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[12.5px] text-zinc-200">{f.path}</div>
                      <div className="truncate text-[11.5px] text-zinc-500">{f.description}</div>
                    </div>
                    <button
                      onClick={() => generateFile(f.path, f.description)}
                      disabled={!!generating}
                      className="shrink-0 rounded-md bg-white/5 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-white/10 disabled:opacity-40"
                    >
                      {built ? "Regenerate" : "Generate"}
                    </button>
                  </div>
                );
              })}
            </div>

            {error && (
              <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-[13px] text-rose-200">
                {error}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
