import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { PanelHeader } from "./AgentPanel";
import { Markdown } from "../components/CodeBlock";
import { getApiKey, getCurrentAiRoute, streamChat, type GenTurn } from "../lib/gemini";
import { loadSettings } from "../lib/settings";
import { projectTemplates } from "../data/templates";
import type { BuilderPhase, BuilderPlan, OpenGeneratedDrafts, VFile } from "../types";
import {
  Wand2, Loader2, CheckCircle2, FileCode2, TerminalSquare,
  Sparkles, RotateCcw, FolderPlus, ArrowRight, ClipboardList, Copy,
} from "lucide-react";

const MAX_PLAN_FILES = 12;
const MAX_PLAN_STEPS = 12;
const MAX_PLAN_COMMANDS = 16;
const MAX_DRAFT_BYTES = 512 * 1024;
const MAX_FILE_OUTPUT_CHARS = 96 * 1024;
const MAX_SPEC_CHARS = 48 * 1024;

const IDEAS = [
  "A SaaS dashboard with auth, Stripe billing and a Postgres database",
  "A REST API for a task manager with JWT auth and OpenAPI docs",
  "A realtime chat app with WebSockets and message persistence",
  "A CLI tool that scans a codebase and reports dependency risks",
];

function formatError(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

function validDraftPath(path: string) {
  const clean = path.trim();
  return !!clean
    && clean.length <= 512
    && !clean.startsWith("/")
    && !clean.startsWith("~")
    && !clean.includes("\\")
    && !clean.includes("//")
    && !clean.endsWith("/")
    && !clean.split("/").some((part) => !part || part === "." || part === "..");
}

function languageForPath(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() || "txt";
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", java: "java", cs: "csharp",
    rb: "ruby", php: "php", ex: "elixir", json: "json", yml: "yaml",
    yaml: "yaml", md: "markdown", html: "html", css: "css", sql: "sql",
    sh: "shell", toml: "toml", dockerfile: "dockerfile",
  };
  return langMap[ext] || "plaintext";
}

function textBytes(value: string) {
  return new TextEncoder().encode(value).length;
}

export function BuilderPanel({
  onNeedKey,
  onOpenFiles,
  phase,
  setPhase,
  brief,
  setBrief,
  raw,
  setRaw,
  plan,
  setPlan,
  busy,
  setBusy,
  error,
  setError,
  generating,
  setGenerating,
  builtFiles,
  setBuiltFiles,
  staging,
  setStaging,
  stageNotice,
  setStageNotice,
}: {
  onNeedKey: () => void;
  onOpenFiles: OpenGeneratedDrafts;
  phase: BuilderPhase;
  setPhase: Dispatch<SetStateAction<BuilderPhase>>;
  brief: string;
  setBrief: Dispatch<SetStateAction<string>>;
  raw: string;
  setRaw: Dispatch<SetStateAction<string>>;
  plan: BuilderPlan | null;
  setPlan: Dispatch<SetStateAction<BuilderPlan | null>>;
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  error: string;
  setError: Dispatch<SetStateAction<string>>;
  generating: string | null;
  setGenerating: Dispatch<SetStateAction<string | null>>;
  builtFiles: VFile[];
  setBuiltFiles: Dispatch<SetStateAction<VFile[]>>;
  staging: boolean;
  setStaging: Dispatch<SetStateAction<boolean>>;
  stageNotice: string;
  setStageNotice: Dispatch<SetStateAction<string>>;
}) {
  const outRef = useRef<HTMLDivElement>(null);
  const [specNotice, setSpecNotice] = useState("");
  const settings = loadSettings();

  async function generatePlan(text: string) {
    if (!text.trim()) return;
    const route = getCurrentAiRoute("planning");
    if (route.status !== "active") { setError(route.reason); return; }
    if (!getApiKey()) { onNeedKey(); return; }
    setBusy(true); setError(""); setRaw(""); setPlan(null); setSpecNotice(""); setPhase("planning");

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
- 4-7 steps, 4-10 commands, 4-10 files. Never list more than 10 files.
- Prefer these known scaffolds when relevant: ${templateList}
- Commands must be real, runnable shell commands.
- File paths must be realistic workspace-relative paths. Do not use absolute paths, parent traversal, empty segments, or backslashes.`;

    const history: GenTurn[] = [{ role: "user", text: prompt }];
    try {
      let acc = "";
      for await (const chunk of streamChat(history, { task: "planning" })) {
        acc += chunk;
        setRaw(acc);
        outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
      }
      const cleaned = acc.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      const jsonStr = firstBrace > -1 ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned;
      const parsed = JSON.parse(jsonStr) as BuilderPlan;
      parsed.files = parsed.files
        .filter((file) => validDraftPath(file.path))
        .slice(0, MAX_PLAN_FILES);
      if (parsed.files.length === 0) throw new Error("The model did not return any safe workspace-relative file paths.");
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
    const route = getCurrentAiRoute("coding");
    if (route.status !== "active") { setError(route.reason); return; }
    if (!getApiKey()) { onNeedKey(); return; }
    setGenerating(path);
    const prompt = `Write the complete contents of the file \`${path}\` for this project:

Project: ${plan?.summary}
Stack: ${plan?.stack.join(", ")}
This file's purpose: ${description}

Output ONLY the raw file contents. No markdown fences, no explanation, no commentary.`;
    try {
      let acc = "";
      for await (const chunk of streamChat([{ role: "user", text: prompt }], { task: "coding", maxOutputTokens: 12_000, temperature: 0.25 })) {
        acc += chunk;
        if (acc.length > MAX_FILE_OUTPUT_CHARS) throw new Error("Generated file exceeded DevLab's reviewed-draft staging limit.");
      }
      const content = acc.replace(/^```[\w]*\s*/i, "").replace(/```\s*$/, "").trim();
      if (textBytes(content) > MAX_DRAFT_BYTES) throw new Error("Generated file exceeded DevLab's reviewed-draft staging limit.");
      const vfile: VFile = { path, content, language: languageForPath(path) };
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

  async function openInEditorReview() {
    if (!plan || builtFiles.length === 0) return;
    setStaging(true);
    setError("");
    setStageNotice("");
    try {
      const opened = await onOpenFiles(builtFiles, plan.summary);
      if (opened) {
        setStageNotice(`Native agent-tools staged ${builtFiles.length} reviewed draft file(s). Nothing was written.`);
      } else {
        setError("Generated drafts were not staged for editor review. Nothing was written.");
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setStaging(false);
    }
  }

  async function copySpecDraft() {
    if (!plan) return;
    setError("");
    setSpecNotice("");
    if (!navigator.clipboard?.writeText) {
      setError("Clipboard access is unavailable in this environment. Nothing was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(buildSpecMarkdown(plan, brief));
      setSpecNotice("Copied spec.md draft with task DAG metadata. Nothing was written.");
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function openSpecInEditorReview() {
    if (!plan) return;
    setStaging(true);
    setError("");
    setStageNotice("");
    setSpecNotice("");
    try {
      const content = buildSpecMarkdown(plan, brief);
      const opened = await onOpenFiles([
        { path: "spec.md", content, language: "markdown" },
      ], `Spec-first plan draft: ${plan.summary}`);
      if (opened) {
        setSpecNotice("Staged spec.md for Editor review. Nothing was written until reviewed apply.");
      } else {
        setError("Spec draft was not staged for editor review. Nothing was written.");
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setStaging(false);
    }
  }

  function reset() {
    setPhase("brief"); setBrief(""); setPlan(null); setRaw("");
    setBuiltFiles([]); setError(""); setStageNotice(""); setSpecNotice("");
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Agentic Project Builder"
        subtitle="Phase 6Y · spec-first reviewed planning"
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
              step-by-step plan and generate reviewed in-memory starter files. Nothing is written automatically.
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

            <div className="mt-7 rounded-xl border border-violet-500/20 bg-violet-500/[0.06] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-violet-100">
                    <ClipboardList className="h-4 w-4 text-violet-300" />
                    Spec-first review pack
                  </h3>
                  <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-violet-100/70">
                    DevLab can derive a bounded <span className="font-mono text-violet-100">spec.md</span> from this approved plan, including scope, commands, reviewed files and a sequential task DAG. It stays in memory until copied or opened for reviewed Editor apply.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => { void copySpecDraft(); }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-violet-100 hover:bg-white/[0.08]"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy spec.md
                  </button>
                  <button
                    onClick={() => { void openSpecInEditorReview(); }}
                    disabled={staging}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-violet-400/40 bg-violet-400/10 px-3 py-1.5 text-xs font-semibold text-violet-100 hover:bg-violet-400/20 disabled:opacity-40"
                  >
                    {staging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
                    Open spec review
                  </button>
                </div>
              </div>
              <div className="mt-3 grid gap-2 text-[11.5px] sm:grid-cols-3">
                <div className="rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-violet-100/65">
                  <span className="block text-violet-100">{Math.min(plan.steps.length, MAX_PLAN_STEPS)} task DAG node{Math.min(plan.steps.length, MAX_PLAN_STEPS) === 1 ? "" : "s"}</span>
                  Sequential dependencies only
                </div>
                <div className="rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-violet-100/65">
                  <span className="block text-violet-100">{plan.files.length} reviewed file target{plan.files.length === 1 ? "" : "s"}</span>
                  Written only after Editor apply
                </div>
                <div className="rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-violet-100/65">
                  <span className="block text-violet-100">{Math.min(plan.commands.length, MAX_PLAN_COMMANDS)} command reference{Math.min(plan.commands.length, MAX_PLAN_COMMANDS) === 1 ? "" : "s"}</span>
                  Display-only; no execution
                </div>
              </div>
              {specNotice && <div className="mt-3 text-[12px] text-emerald-300">{specNotice}</div>}
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
                    onClick={openInEditorReview}
                    disabled={staging}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-40"
                  >
                    {staging ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3" />}
                    Open reviewed drafts
                  </button>
                )}
              </div>
            </div>

            {stageNotice && (
              <div className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-[13px] text-emerald-100">
                {stageNotice}
              </div>
            )}

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

interface SpecTaskNode {
  id: string;
  title: string;
  detail: string;
  dependsOn: string[];
  reviewedFileTargets: string[];
}

function buildSpecMarkdown(plan: BuilderPlan, brief: string): string {
  const boundedPlan = boundPlanForSpec(plan);
  const taskDag = buildTaskDag(boundedPlan);
  const lines = [
    "# Project specification",
    "",
    "> Generated by DevLab Project Builder as an in-memory reviewed draft. Review before applying. Workspace writes still require explicit Editor reviewed-draft apply.",
    "",
    "## Original brief",
    "",
    boundSpecText(brief.trim() || "No brief was retained for this plan.", 6_000),
    "",
    "## Summary",
    "",
    boundedPlan.summary,
    "",
    "## Stack",
    "",
    ...listOrFallback(boundedPlan.stack, "No stack choices were returned.").map((item) => `- ${item}`),
    "",
    "## Task DAG",
    "",
    "The initial DAG is intentionally sequential and review-oriented. Future phases can split or reorder tasks after richer repository context and verification metadata exist.",
    "",
    "```json",
    JSON.stringify({ tasks: taskDag }, null, 2),
    "```",
    "",
    "## Execution plan",
    "",
    ...boundedPlan.steps.flatMap((step, index) => [
      `### ${index + 1}. ${step.title}`,
      "",
      step.detail,
      "",
    ]),
    "## Setup command references",
    "",
    "These commands are references only. DevLab does not execute them from this spec.",
    "",
    "```bash",
    ...listOrFallback(boundedPlan.commands, "# No setup commands were returned."),
    "```",
    "",
    "## Reviewed file targets",
    "",
    ...boundedPlan.files.map((file) => `- \`${file.path}\` — ${file.description}`),
    "",
    "## Review and safety checklist",
    "",
    "- Confirm the scope and out-of-scope boundaries before generating or applying files.",
    "- Generate file drafts into memory, then inspect each draft in the Editor.",
    "- Recompare existing files before applying reviewed drafts.",
    "- Run bounded verification profiles after applying reviewed changes.",
    "- Keep secrets out of generated files and prompts.",
    "- Treat setup commands as manual terminal references unless a future bounded backend-owned profile exists.",
    "",
    "## Out of scope for this draft",
    "",
    "- Automatic workspace writes.",
    "- Automatic command execution.",
    "- CI/deploy/toolchain install or update management.",
    "- Provider credentials or secrets.",
  ];
  const markdown = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  return markdown.length > MAX_SPEC_CHARS
    ? `${markdown.slice(0, MAX_SPEC_CHARS)}\n\n[DevLab truncated this spec draft to the configured Builder spec size limit.]\n`
    : markdown;
}

function buildTaskDag(plan: BuilderPlan): SpecTaskNode[] {
  const files = plan.files.slice(0, MAX_PLAN_FILES).map((file) => file.path);
  return plan.steps.slice(0, MAX_PLAN_STEPS).map((step, index) => ({
    id: `task-${String(index + 1).padStart(2, "0")}`,
    title: step.title,
    detail: step.detail,
    dependsOn: index === 0 ? [] : [`task-${String(index).padStart(2, "0")}`],
    reviewedFileTargets: filesForTask(files, index, plan.steps.length),
  }));
}

function filesForTask(files: string[], index: number, stepCount: number): string[] {
  if (files.length === 0) return [];
  const bucketCount = Math.max(1, Math.min(stepCount, files.length));
  return files.filter((_, fileIndex) => fileIndex % bucketCount === index % bucketCount).slice(0, 4);
}

function boundPlanForSpec(plan: BuilderPlan): BuilderPlan {
  return {
    summary: boundSpecText(plan.summary || "No summary was returned.", 4_000),
    stack: plan.stack.slice(0, 20).map((item) => boundSpecText(item, 160)),
    steps: plan.steps.slice(0, MAX_PLAN_STEPS).map((step, index) => ({
      title: boundSpecText(step.title || `Task ${index + 1}`, 240),
      detail: boundSpecText(step.detail || "No detail was returned for this task.", 1_500),
    })),
    commands: plan.commands.slice(0, MAX_PLAN_COMMANDS).map((command) => boundSpecText(command, 800)),
    files: plan.files.filter((file) => validDraftPath(file.path)).slice(0, MAX_PLAN_FILES).map((file) => ({
      path: boundSpecText(file.path, 512),
      description: boundSpecText(file.description || "Generated project file.", 800),
    })),
  };
}

function listOrFallback(values: string[], fallback: string): string[] {
  return values.length > 0 ? values : [fallback];
}

function boundSpecText(value: string, maxChars: number): string {
  const normalized = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized;
}
