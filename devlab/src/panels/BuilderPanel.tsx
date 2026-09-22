import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { PanelHeader } from "./AgentPanel";
import { Markdown } from "../components/CodeBlock";
import { getApiKey, getCurrentAiRoute, streamChat, type GenTurn } from "../lib/gemini";
import { loadSettings } from "../lib/settings";
import { projectTemplates } from "../data/templates";
import { testRunnerSnapshot, type TestRunnerSnapshot } from "../lib/testRunner";
import { recommendVerificationProfiles, type VerificationProfileRecommendation } from "../lib/verificationGuidance";
import type { BuilderPhase, BuilderPlan, BuilderTaskStagingRecord, OpenGeneratedDrafts, ReviewedDraftApplyOutcome, VerificationHandoffRequest, VerificationRunOutcome, VFile } from "../types";
import {
  Wand2, Loader2, CheckCircle2, FileCode2, TerminalSquare,
  Sparkles, RotateCcw, FolderPlus, ArrowRight, ClipboardList, Copy, ListChecks, ShieldCheck, RefreshCw, Play,
} from "lucide-react";

const MAX_PLAN_FILES = 12;
const MAX_PLAN_STEPS = 12;
const MAX_PLAN_COMMANDS = 16;
const MAX_DRAFT_BYTES = 512 * 1024;
const MAX_FILE_OUTPUT_CHARS = 96 * 1024;
const MAX_SPEC_CHARS = 48 * 1024;
const MAX_TASK_STAGING_RECORDS = 24;

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

function formatByteCount(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
  taskStagingLedger,
  setTaskStagingLedger,
  applyOutcomes,
  setApplyOutcomes,
  canDiscoverVerification,
  onOpenVerification,
  onRequestVerification,
  verificationOutcomes,
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
  taskStagingLedger: BuilderTaskStagingRecord[];
  setTaskStagingLedger: Dispatch<SetStateAction<BuilderTaskStagingRecord[]>>;
  applyOutcomes: ReviewedDraftApplyOutcome[];
  setApplyOutcomes: Dispatch<SetStateAction<ReviewedDraftApplyOutcome[]>>;
  canDiscoverVerification: boolean;
  onOpenVerification: () => void;
  onRequestVerification: (request: VerificationHandoffRequest) => void;
  verificationOutcomes: VerificationRunOutcome[];
}) {
  const outRef = useRef<HTMLDivElement>(null);
  const [specNotice, setSpecNotice] = useState("");
  const [specPreviewNotice, setSpecPreviewNotice] = useState("");
  const [taskPlanNotice, setTaskPlanNotice] = useState("");
  const [taskHandoffNotice, setTaskHandoffNotice] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [stagingTaskId, setStagingTaskId] = useState<string | null>(null);
  const [taskStagingNotice, setTaskStagingNotice] = useState("");
  const [verificationSnapshot, setVerificationSnapshot] = useState<TestRunnerSnapshot | null>(null);
  const [verificationUnavailable, setVerificationUnavailable] = useState("");
  const [verificationLoading, setVerificationLoading] = useState(false);
  const [verificationNotice, setVerificationNotice] = useState("");
  const settings = loadSettings();
  const specPreview = plan ? buildSpecMetadataPreview(plan, brief) : null;
  const taskPlanPreview = plan ? buildTaskPlanPreview(plan, builtFiles) : null;
  const taskApplyProgress = taskPlanPreview ? buildTaskApplyProgress(taskPlanPreview, builtFiles, applyOutcomes) : null;
  const taskHandoffPreview = taskPlanPreview && plan ? buildTaskHandoffPreview(taskPlanPreview, builtFiles, plan.summary, taskStagingLedger, taskApplyProgress ?? undefined) : null;
  const taskStagingLedgerPreview = buildTaskStagingLedgerPreview(taskStagingLedger);
  const verificationHandoff = taskPlanPreview && taskApplyProgress
    ? buildTaskVerificationHandoff(taskPlanPreview, taskApplyProgress, applyOutcomes, verificationSnapshot, verificationUnavailable, verificationOutcomes)
    : null;

  async function generatePlan(text: string) {
    if (!text.trim()) return;
    const route = getCurrentAiRoute("planning");
    if (route.status !== "active") { setError(route.reason); return; }
    if (!getApiKey()) { onNeedKey(); return; }
    setBusy(true); setError(""); setRaw(""); setPlan(null); setSpecNotice(""); setSpecPreviewNotice(""); setTaskPlanNotice(""); setTaskHandoffNotice(""); setTaskStagingNotice(""); setTaskStagingLedger([]); setApplyOutcomes([]); setVerificationNotice(""); setActiveTaskId(null); setPhase("planning");

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

  async function generateFile(path: string, description: string, taskContext?: SpecTaskNode): Promise<boolean> {
    const route = getCurrentAiRoute("coding");
    if (route.status !== "active") { setError(route.reason); return false; }
    if (!getApiKey()) { onNeedKey(); return false; }
    setGenerating(path);
    const taskGuidance = taskContext
      ? `Current reviewed task: ${taskContext.id} — ${taskContext.title}\nTask detail: ${taskContext.detail}\nTask acceptance notes: ${taskContext.acceptance.join("; ")}\nTask review gate: ${taskContext.reviewGate}\n`
      : "";
    const prompt = `Write the complete contents of the file \`${path}\` for this project:

Project: ${plan?.summary}
Stack: ${plan?.stack.join(", ")}
${taskGuidance}This file's purpose: ${description}

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
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
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
    setTaskPlanNotice("");
    setTaskHandoffNotice("");
    setTaskStagingNotice("");
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
    setSpecPreviewNotice("");
    setTaskPlanNotice("");
    setTaskHandoffNotice("");
    setTaskStagingNotice("");
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

  async function copySpecMetadataPreview() {
    if (!specPreview) return;
    setError("");
    setSpecNotice("");
    setSpecPreviewNotice("");
    setTaskPlanNotice("");
    setTaskHandoffNotice("");
    setTaskStagingNotice("");
    if (!navigator.clipboard?.writeText) {
      setError("Clipboard access is unavailable in this environment. Nothing was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(specPreview.exportText);
      setSpecPreviewNotice(`Copied spec metadata preview with ${specPreview.acceptanceCriteria.length} acceptance item${specPreview.acceptanceCriteria.length === 1 ? "" : "s"}, ${specPreview.riskNotes.length} risk note${specPreview.riskNotes.length === 1 ? "" : "s"} and ${specPreview.reviewGates.length} review gate${specPreview.reviewGates.length === 1 ? "" : "s"}.`);
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function copyTaskPlanPreview() {
    if (!taskPlanPreview) return;
    setError("");
    setSpecNotice("");
    setSpecPreviewNotice("");
    setTaskPlanNotice("");
    setTaskHandoffNotice("");
    setTaskStagingNotice("");
    if (!navigator.clipboard?.writeText) {
      setError("Clipboard access is unavailable in this environment. Nothing was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(taskPlanPreview.exportText);
      setTaskPlanNotice(`Copied task DAG implementation preview for ${taskPlanPreview.tasks.length} task batch${taskPlanPreview.tasks.length === 1 ? "" : "es"}.`);
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function copyTaskHandoffPreview(taskId?: string) {
    if (!taskHandoffPreview) return;
    setError("");
    setSpecNotice("");
    setSpecPreviewNotice("");
    setTaskPlanNotice("");
    setTaskHandoffNotice("");
    setTaskStagingNotice("");
    if (!navigator.clipboard?.writeText) {
      setError("Clipboard access is unavailable in this environment. Nothing was copied.");
      return;
    }
    const packet = taskId ? taskHandoffPreview.packets.find((item) => item.id === taskId) : null;
    if (taskId && !packet) {
      setTaskHandoffNotice(`No task handoff packet was found for ${taskId}. Nothing was copied.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(packet ? packet.exportText : taskHandoffPreview.exportText);
      setTaskHandoffNotice(
        packet
          ? `Copied metadata-only handoff packet for ${packet.id} with ${packet.generatedDrafts.length} generated draft target${packet.generatedDrafts.length === 1 ? "" : "s"}.`
          : `Copied metadata-only handoff ledger for ${taskHandoffPreview.packets.length} task batch${taskHandoffPreview.packets.length === 1 ? "" : "es"}.`,
      );
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function generateTaskFiles(taskId: string) {
    if (!plan || !taskPlanPreview) return;
    const task = taskPlanPreview.tasks.find((item) => item.id === taskId);
    if (!task) return;
    setError("");
    setSpecNotice("");
    setSpecPreviewNotice("");
    setTaskPlanNotice("");
    setTaskHandoffNotice("");
    setTaskStagingNotice("");
    const targetFiles = task.reviewedFileTargets
      .map((targetPath) => plan.files.find((file) => file.path === targetPath))
      .filter((file): file is BuilderPlan["files"][number] => Boolean(file));
    if (targetFiles.length === 0) {
      setTaskPlanNotice(`${task.id} has no reviewed file targets yet. Nothing was generated or written.`);
      return;
    }
    const generatedPaths = new Set(builtFiles.map((file) => file.path));
    const pendingFiles = targetFiles.filter((file) => !generatedPaths.has(file.path));
    if (pendingFiles.length === 0) {
      setTaskPlanNotice(`${task.id} already has in-memory drafts for all assigned file targets. Nothing was written.`);
      return;
    }
    setActiveTaskId(task.id);
    let generatedCount = 0;
    try {
      for (const file of pendingFiles) {
        const generatedDraft = await generateFile(file.path, file.description, task);
        if (!generatedDraft) break;
        generatedCount += 1;
      }
      if (generatedCount > 0) setPhase("done");
      setTaskPlanNotice(
        generatedCount === pendingFiles.length
          ? `Generated ${generatedCount} in-memory draft target${generatedCount === 1 ? "" : "s"} for ${task.id}. Nothing was written; use Editor review to apply.`
          : `Generated ${generatedCount} of ${pendingFiles.length} pending draft target${pendingFiles.length === 1 ? "" : "s"} for ${task.id}. Review the reported error before continuing.`,
      );
    } finally {
      setActiveTaskId(null);
    }
  }

  async function stageTaskDrafts(taskId: string) {
    if (!plan || !taskPlanPreview) return;
    const task = taskPlanPreview.tasks.find((item) => item.id === taskId);
    if (!task) return;
    setError("");
    setStageNotice("");
    setTaskPlanNotice("");
    setTaskHandoffNotice("");
    setTaskStagingNotice("");
    const builtByPath = new Map(builtFiles.map((file) => [file.path, file]));
    const taskFiles = task.generatedFileTargets
      .map((path) => builtByPath.get(path))
      .filter((file): file is VFile => Boolean(file));
    if (taskFiles.length === 0) {
      setTaskStagingNotice(`${task.id} has no generated in-memory drafts to stage. Generate missing drafts first; nothing was staged or written.`);
      return;
    }
    setStagingTaskId(task.id);
    setStaging(true);
    try {
      const summary = boundSpecText(`Builder task batch ${task.id} — ${task.title}: ${plan.summary}`, 1_800);
      const opened = await onOpenFiles(taskFiles, summary);
      if (!opened) {
        setError(`${task.id} drafts were not staged for editor review. Nothing was written.`);
        return;
      }
      const record = buildTaskStagingRecord(task, taskFiles, summary);
      setTaskStagingLedger((current) => [record, ...current.filter((item) => item.taskId !== task.id)].slice(0, MAX_TASK_STAGING_RECORDS));
      // The Builder panel unmounts while Editor review is open, so the success notice lives in App-level state.
      setStageNotice(
        `Native agent-tools staged ${taskFiles.length} reviewed draft file${taskFiles.length === 1 ? "" : "s"} for ${task.id}${task.pendingFileTargets.length > 0 ? ` (${task.pendingFileTargets.length} target${task.pendingFileTargets.length === 1 ? "" : "s"} still pending)` : ""}. Nothing was written; apply each file in Editor review.`,
      );
    } catch (err) {
      setError(formatError(err));
    } finally {
      setStaging(false);
      setStagingTaskId(null);
    }
  }

  async function refreshVerificationHandoff() {
    setError("");
    setVerificationNotice("");
    if (!canDiscoverVerification) {
      setVerificationUnavailable("The native test-runner capability is unavailable in this build, so backend-owned profiles cannot be discovered.");
      setVerificationNotice("Profile discovery is unavailable. A metadata-only verification handoff is still available.");
      return;
    }
    setVerificationLoading(true);
    try {
      const snapshot = await testRunnerSnapshot();
      setVerificationSnapshot(snapshot);
      setVerificationUnavailable("");
      setVerificationNotice(`Discovered ${snapshot.profiles.length} backend-owned verification profile${snapshot.profiles.length === 1 ? "" : "s"} (read-only). Nothing was executed.`);
    } catch (err) {
      setVerificationSnapshot(null);
      setVerificationUnavailable(formatError(err));
      setVerificationNotice("Could not discover native test profiles. A metadata-only verification handoff is still available.");
    } finally {
      setVerificationLoading(false);
    }
  }

  function sendVerificationHandoff(taskId: string, intent: VerificationHandoffRequest["intent"] = "verify") {
    if (!verificationHandoff) return;
    const task = verificationHandoff.tasks.find((item) => item.taskId === taskId);
    if (!task) return;
    setError("");
    setVerificationNotice("");
    const priorRun = intent === "repair" && task.lastRun && task.lastRun.status !== "passed"
      ? { status: task.lastRun.status, exitCode: task.lastRun.exitCode, command: task.lastRun.command, ranAtMs: task.lastRun.ranAtMs }
      : undefined;
    onRequestVerification({
      taskId: task.taskId,
      taskTitle: task.title,
      appliedPaths: task.appliedPaths,
      recommendedProfileIds: task.recommendedProfiles.map((profile) => profile.id),
      requestedAtMs: Date.now(),
      intent,
      ...(priorRun ? { priorRun } : {}),
    });
  }

  async function copyVerificationHandoff() {
    if (!verificationHandoff) return;
    setError("");
    setVerificationNotice("");
    if (!navigator.clipboard?.writeText) {
      setError("Clipboard access is unavailable in this environment. Nothing was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(verificationHandoff.exportText);
      setVerificationNotice(`Copied metadata-only verification handoff for ${verificationHandoff.appliedTaskCount} task batch${verificationHandoff.appliedTaskCount === 1 ? "" : "es"} with applied targets. Nothing was executed.`);
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function copyTaskStagingLedger() {
    setError("");
    setTaskHandoffNotice("");
    setTaskStagingNotice("");
    if (taskStagingLedger.length === 0) {
      setTaskStagingNotice("No task batches have been staged for Editor review in this session. Nothing was copied.");
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setError("Clipboard access is unavailable in this environment. Nothing was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(taskStagingLedgerPreview.exportText);
      setTaskStagingNotice(`Copied metadata-only task staging ledger for ${taskStagingLedger.length} staged batch${taskStagingLedger.length === 1 ? "" : "es"}.`);
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
    setSpecPreviewNotice("");
    setTaskPlanNotice("");
    setTaskHandoffNotice("");
    setTaskStagingNotice("");
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
    setBuiltFiles([]); setError(""); setStageNotice(""); setSpecNotice(""); setSpecPreviewNotice(""); setTaskPlanNotice(""); setTaskHandoffNotice(""); setTaskStagingNotice(""); setTaskStagingLedger([]); setApplyOutcomes([]); setVerificationNotice(""); setActiveTaskId(null);
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Agentic Project Builder"
        subtitle="Phase 8R · draft path policy"
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
                    DevLab can derive a bounded <span className="font-mono text-violet-100">spec.md</span> from this approved plan, including scope, commands, reviewed files, a sequential task DAG, acceptance criteria, risk notes and review gates. It stays in memory until copied or opened for reviewed Editor apply.
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
                    disabled={staging || !!activeTaskId}
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
                  <span className="block text-violet-100">Acceptance/risk checklist</span>
                  Metadata-only; no execution
                </div>
              </div>
              {specPreview && (
                <details className="mt-3 rounded-lg border border-violet-400/20 bg-black/15 p-3 text-[11.5px] text-violet-100/70">
                  <summary className="cursor-pointer select-none font-semibold text-violet-100">
                    Spec metadata preview · {specPreview.summary}
                  </summary>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-200/60">Acceptance criteria</div>
                      <ul className="mt-1 space-y-1">
                        {specPreview.acceptanceCriteria.slice(0, 5).map((item) => <li key={item}>- {item}</li>)}
                      </ul>
                    </div>
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-200/60">Risk notes</div>
                      <ul className="mt-1 space-y-1">
                        {specPreview.riskNotes.map((item) => <li key={item}>- {item}</li>)}
                      </ul>
                    </div>
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-200/60">Review gates</div>
                      <ul className="mt-1 space-y-1">
                        {specPreview.reviewGates.map((item) => <li key={item}>- {item}</li>)}
                      </ul>
                    </div>
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-200/60">Task DAG metadata</div>
                      <ul className="mt-1 space-y-1">
                        {specPreview.taskSummaries.map((item) => <li key={item}>- {item}</li>)}
                      </ul>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => { void copySpecMetadataPreview(); }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-violet-400/30 bg-violet-400/10 px-3 py-1.5 text-xs font-semibold text-violet-100 hover:bg-violet-400/20"
                    >
                      <Copy className="h-3.5 w-3.5" /> Copy spec metadata preview
                    </button>
                    <span className="text-[10.5px] text-violet-100/50">Preview only; spec.md still copies or stages through reviewed Editor flow.</span>
                  </div>
                  {specPreviewNotice && <div className="mt-2 text-[11px] text-emerald-300">{specPreviewNotice}</div>}
                </details>
              )}
              {specNotice && <div className="mt-3 text-[12px] text-emerald-300">{specNotice}</div>}
            </div>

            {taskPlanPreview && (
              <div className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.05] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-cyan-100">
                      <ClipboardList className="h-4 w-4 text-cyan-300" />
                      Task DAG implementation batches
                    </h3>
                    <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-cyan-100/70">
                      Turn the approved plan into discrete sequential batches. Each batch only generates missing in-memory drafts for its assigned file targets; commands remain references, and workspace writes still require Editor reviewed apply.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => { void copyTaskPlanPreview(); }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-400/20"
                    >
                      <Copy className="h-3.5 w-3.5" /> Copy task DAG preview
                    </button>
                    <button
                      onClick={() => { void copyTaskHandoffPreview(); }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-400/20"
                    >
                      <Copy className="h-3.5 w-3.5" /> Copy handoff ledger
                    </button>
                  </div>
                </div>
                <div className="mt-3 grid gap-2 text-[11.5px] sm:grid-cols-4">
                  <div className="rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-cyan-100/65">
                    <span className="block text-cyan-100">{taskPlanPreview.tasks.length} implementation batch{taskPlanPreview.tasks.length === 1 ? "" : "es"}</span>
                    Sequential dependency chain
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-cyan-100/65">
                    <span className="block text-cyan-100">{taskPlanPreview.generatedFileCount}/{taskPlanPreview.fileTargetCount} draft target{taskPlanPreview.fileTargetCount === 1 ? "" : "s"} generated</span>
                    Renderer memory only
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-cyan-100/65">
                    <span className="block text-cyan-100">{taskApplyProgress?.appliedTargetCount ?? 0}/{taskPlanPreview.fileTargetCount} target{taskPlanPreview.fileTargetCount === 1 ? "" : "s"} applied in Editor</span>
                    {taskPlanPreview.pendingFileCount} pending draft target{taskPlanPreview.pendingFileCount === 1 ? "" : "s"} · per-file explicit apply
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-cyan-100/65">
                    <span className="block text-cyan-100">{taskHandoffPreview?.readyTaskCount ?? 0} ready handoff{(taskHandoffPreview?.readyTaskCount ?? 0) === 1 ? "" : "s"}</span>
                    {formatByteCount(taskHandoffPreview?.totalDraftBytes ?? 0)} generated draft metadata
                  </div>
                </div>
                {taskApplyProgress && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-cyan-300/20 bg-cyan-300/[0.05] px-3 py-2 text-[11.5px] text-cyan-100/75">
                    <ArrowRight className="h-3.5 w-3.5 text-cyan-300" />
                    <span>{taskApplyProgress.guidance}</span>
                    {taskApplyProgress.staleTargetCount > 0 && (
                      <span className="text-amber-200/80">{taskApplyProgress.staleTargetCount} applied target{taskApplyProgress.staleTargetCount === 1 ? " has" : "s have"} a newer in-memory draft; restage and recompare before applying again.</span>
                    )}
                  </div>
                )}
                <div className="mt-3 space-y-2">
                  {taskPlanPreview.tasks.map((task) => {
                    const generatingTask = activeTaskId === task.id;
                    const stagingTask = stagingTaskId === task.id;
                    const canGenerateTask = !generating && !activeTaskId && !staging && task.pendingFileTargets.length > 0;
                    const canStageTask = !generating && !activeTaskId && !staging && task.generatedFileTargets.length > 0;
                    const handoffPacket = taskHandoffPreview?.packets.find((packet) => packet.id === task.id);
                    const stagingRecord = taskStagingLedger.find((record) => record.taskId === task.id);
                    const applyStatus = taskApplyProgress?.tasks.find((item) => item.taskId === task.id);
                    const isSuggestedNext = taskApplyProgress?.nextTaskId === task.id;
                    return (
                      <div key={task.id} className="rounded-lg border border-white/10 bg-black/15 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-md bg-cyan-400/10 px-2 py-0.5 font-mono text-[10.5px] font-semibold text-cyan-200 ring-1 ring-cyan-400/20">{task.id}</span>
                              <span className="text-[12.5px] font-semibold text-cyan-50">{task.title}</span>
                              <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10.5px] text-cyan-100/60">{task.statusLabel}</span>
                              {stagingRecord && (
                                <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10.5px] text-emerald-200">
                                  staged for Editor review · {stagingRecord.files.length} file{stagingRecord.files.length === 1 ? "" : "s"}
                                </span>
                              )}
                              {applyStatus && applyStatus.appliedTargets.length > 0 && (
                                <span className={`rounded-full border px-2 py-0.5 text-[10.5px] ${applyStatus.state === "applied" ? "border-violet-400/30 bg-violet-400/10 text-violet-200" : applyStatus.state === "stale" ? "border-amber-400/30 bg-amber-400/10 text-amber-200" : "border-violet-400/20 bg-violet-400/5 text-violet-200/80"}`}>
                                  {applyStatus.label}
                                </span>
                              )}
                              {isSuggestedNext && (
                                <span className="rounded-full border border-cyan-300/40 bg-cyan-300/10 px-2 py-0.5 text-[10.5px] font-semibold text-cyan-100">
                                  suggested next
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-[11.5px] leading-relaxed text-cyan-100/60">{task.detail}</p>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {task.reviewedFileTargets.length > 0 ? task.reviewedFileTargets.map((targetPath) => {
                                const isGenerated = task.generatedFileTargets.includes(targetPath);
                                const isApplied = applyStatus?.appliedTargets.includes(targetPath) ?? false;
                                const isStale = applyStatus?.staleTargets.includes(targetPath) ?? false;
                                const chipClass = isStale
                                  ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                                  : isApplied
                                    ? "border-violet-400/30 bg-violet-400/10 text-violet-200"
                                    : isGenerated
                                      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                                      : "border-cyan-400/20 bg-cyan-400/10 text-cyan-200";
                                const chipLabel = isStale ? "applied · draft changed" : isApplied ? "applied" : isGenerated ? "draft" : "pending";
                                return (
                                  <span
                                    key={`${task.id}-${targetPath}`}
                                    className={`rounded-md border px-2 py-0.5 font-mono text-[10.5px] ${chipClass}`}
                                  >
                                    {chipLabel} · {targetPath}
                                  </span>
                                );
                              }) : (
                                <span className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10.5px] text-cyan-100/45">No reviewed file target assigned yet</span>
                              )}
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-2">
                            <button
                              onClick={() => { void copyTaskHandoffPreview(task.id); }}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-400/20"
                            >
                              <Copy className="h-3.5 w-3.5" /> Copy handoff
                            </button>
                            <button
                              onClick={() => { void generateTaskFiles(task.id); }}
                              disabled={!canGenerateTask}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-400/20 disabled:opacity-40"
                            >
                              {generatingTask ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                              Generate missing drafts
                            </button>
                            <button
                              onClick={() => { void stageTaskDrafts(task.id); }}
                              disabled={!canStageTask}
                              title={task.generatedFileTargets.length === 0 ? "Generate in-memory drafts for this task first." : "Stage only this task's generated drafts through the native agent-tools gate for Editor review. Nothing is written."}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-40"
                            >
                              {stagingTask ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
                              Stage for Editor review
                            </button>
                          </div>
                        </div>
                        <details className="mt-2 text-[11px] text-cyan-100/60">
                          <summary className="cursor-pointer select-none text-cyan-100/80">Acceptance and review gate</summary>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            <div>
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-cyan-200/60">Acceptance</div>
                              <ul className="mt-1 space-y-1">
                                {task.acceptance.map((item) => <li key={`${task.id}-${item}`}>- {item}</li>)}
                              </ul>
                            </div>
                            <div>
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-cyan-200/60">Review gate</div>
                              <p className="mt-1">{task.reviewGate}</p>
                              <p className="mt-1 text-cyan-100/45">Depends on: {task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "none"}</p>
                            </div>
                            <div>
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-200/60">Handoff metadata</div>
                              {handoffPacket && handoffPacket.generatedDrafts.length > 0 ? (
                                <ul className="mt-1 space-y-1">
                                  {handoffPacket.generatedDrafts.map((file) => (
                                    <li key={`${task.id}-handoff-${file.path}`}>- {file.path} · {file.language} · {formatByteCount(file.bytes)} · {file.lines} line{file.lines === 1 ? "" : "s"}</li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="mt-1 text-cyan-100/45">No generated draft metadata yet. Draft contents and workspace diffs are not included in handoff packets.</p>
                              )}
                              {handoffPacket && handoffPacket.pendingFileTargets.length > 0 && (
                                <p className="mt-1 text-cyan-100/45">Pending: {handoffPacket.pendingFileTargets.join(", ")}</p>
                              )}
                              {handoffPacket && (
                                <p className="mt-1 text-cyan-100/45">Editor staging: {handoffPacket.stagingState}</p>
                              )}
                              {handoffPacket && (
                                <p className="mt-1 text-cyan-100/45">Editor apply: {handoffPacket.applyState}</p>
                              )}
                            </div>
                          </div>
                        </details>
                      </div>
                    );
                  })}
                </div>
                {taskPlanNotice && <div className="mt-3 text-[12px] text-emerald-300">{taskPlanNotice}</div>}
                {taskHandoffNotice && <div className="mt-2 text-[12px] text-emerald-300">{taskHandoffNotice}</div>}
                {taskStagingNotice && <div className="mt-2 text-[12px] text-emerald-300">{taskStagingNotice}</div>}

                <details className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] p-3 text-[11.5px] text-emerald-100/70">
                  <summary className="flex cursor-pointer select-none flex-wrap items-center justify-between gap-2 text-emerald-100">
                    <span className="inline-flex items-center gap-2 font-semibold">
                      <ListChecks className="h-3.5 w-3.5 text-emerald-300" />
                      Task staging ledger · {taskStagingLedgerPreview.summary}
                    </span>
                    <span className="text-[10.5px] text-emerald-100/50">Session-only metadata; not saved to recovery snapshots</span>
                  </summary>
                  <p className="mt-2 leading-relaxed text-emerald-100/60">
                    Records which task batches were staged through the native agent-tools gate into Editor review during this session. Staging a batch replaces the current Editor review queue with that task's generated drafts and records file path and byte metadata only; draft contents, workspace contents and apply results are not tracked here. Apply state remains visible only in Editor review.
                  </p>
                  {taskStagingLedger.length > 0 ? (
                    <ul className="mt-2 space-y-1.5">
                      {taskStagingLedger.map((record) => (
                        <li key={`${record.taskId}-${record.stagedAtMs}`} className="rounded-md border border-white/10 bg-black/15 px-2.5 py-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-md bg-emerald-400/10 px-2 py-0.5 font-mono text-[10.5px] font-semibold text-emerald-200 ring-1 ring-emerald-400/20">{record.taskId}</span>
                            <span className="font-semibold text-emerald-50">{record.taskTitle}</span>
                            <span className="text-emerald-100/50">{formatStagingTime(record.stagedAtMs)} · {record.files.length} file{record.files.length === 1 ? "" : "s"} · {formatByteCount(record.totalBytes)}</span>
                          </div>
                          <div className="mt-1 font-mono text-[10.5px] text-emerald-100/55">{record.files.map((file) => file.path).join(", ")}</div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-emerald-100/45">No task batches have been staged for Editor review yet.</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => { void copyTaskStagingLedger(); }}
                      disabled={taskStagingLedger.length === 0}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-400/20 disabled:opacity-40"
                    >
                      <Copy className="h-3.5 w-3.5" /> Copy staging ledger
                    </button>
                    <span className="text-[10.5px] text-emerald-100/50">Staging is not apply; Editor reviewed-draft apply remains the only write path.</span>
                  </div>
                </details>

                {verificationHandoff && (
                  <details className="mt-3 rounded-lg border border-violet-500/20 bg-violet-500/[0.04] p-3 text-[11.5px] text-violet-100/70" open={verificationHandoff.appliedTaskCount > 0}>
                    <summary className="flex cursor-pointer select-none flex-wrap items-center justify-between gap-2 text-violet-100">
                      <span className="inline-flex items-center gap-2 font-semibold">
                        <ShieldCheck className="h-3.5 w-3.5 text-violet-300" />
                        Verification handoff · {verificationHandoff.summary}
                      </span>
                      <span className="text-[10.5px] text-violet-100/50">Discovery only; nothing runs from Builder</span>
                    </summary>
                    <p className="mt-2 leading-relaxed text-violet-100/60">
                      Matches backend-owned test profiles discovered by the native read-only snapshot to the reviewed file targets you have already applied in the Editor. Sending a batch only pre-selects the matching profile in Self-Healing Tests; a profile runs only when you click Run there, and the run's status, exit code and timing come back here as metadata. Captured output never leaves Self-Healing Tests.
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => { void refreshVerificationHandoff(); }}
                        disabled={verificationLoading}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-violet-400/30 bg-violet-400/10 px-3 py-1.5 text-xs font-semibold text-violet-100 hover:bg-violet-400/20 disabled:opacity-40"
                      >
                        {verificationLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        {verificationSnapshot ? "Refresh profiles" : "Discover profiles"}
                      </button>
                      <button
                        onClick={() => { void copyVerificationHandoff(); }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-violet-400/30 bg-violet-400/10 px-3 py-1.5 text-xs font-semibold text-violet-100 hover:bg-violet-400/20"
                      >
                        <Copy className="h-3.5 w-3.5" /> Copy verification handoff
                      </button>
                      <button
                        onClick={onOpenVerification}
                        disabled={!canDiscoverVerification}
                        title={canDiscoverVerification ? "Open Self-Healing Tests. Profiles run only when you click Run there." : "The native test-runner capability is unavailable in this build."}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-violet-100 hover:bg-white/5 disabled:opacity-40"
                      >
                        <ArrowRight className="h-3.5 w-3.5" /> Open Self-Healing Tests
                      </button>
                    </div>
                    {verificationHandoff.unavailableReason && (
                      <p className="mt-2 text-[10.5px] text-amber-200/80">Profile discovery unavailable: {verificationHandoff.unavailableReason}</p>
                    )}
                    {verificationHandoff.warnings.length > 0 && (
                      <ul className="mt-2 space-y-0.5 text-[10.5px] text-amber-200/70">
                        {verificationHandoff.warnings.map((warning) => <li key={warning}>- {warning}</li>)}
                      </ul>
                    )}
                    {verificationHandoff.appliedTaskCount === 0 ? (
                      <p className="mt-2 text-violet-100/45">No reviewed file targets have been applied in the Editor yet, so there is nothing to verify. Apply drafts first; discovery can still be refreshed at any time.</p>
                    ) : (
                      <ul className="mt-2 space-y-1.5">
                        {verificationHandoff.tasks.map((task) => (
                          <li key={`${task.taskId}-verify`} className="rounded-md border border-white/10 bg-black/15 px-2.5 py-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-md bg-violet-400/10 px-2 py-0.5 font-mono text-[10.5px] font-semibold text-violet-200 ring-1 ring-violet-400/20">{task.taskId}</span>
                              <span className="font-semibold text-violet-50">{task.title}</span>
                              <span className="text-violet-100/50">{task.appliedPaths.length} applied target{task.appliedPaths.length === 1 ? "" : "s"}{task.stalePaths.length > 0 ? ` · ${task.stalePaths.length} changed since apply` : ""}</span>
                            </div>
                            <div className="mt-1 font-mono text-[10.5px] text-violet-100/55">{task.appliedPaths.join(", ")}</div>
                            {task.lastRun && (
                              <div className={`mt-1 inline-flex flex-wrap items-center gap-2 rounded-md border px-2 py-0.5 text-[10.5px] ${task.lastRun.status === "passed" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200" : task.lastRun.status === "failed" ? "border-rose-400/30 bg-rose-400/10 text-rose-200" : "border-amber-400/30 bg-amber-400/10 text-amber-200"}`}>
                                <span className="font-semibold">Last real run: {task.lastRun.status}</span>
                                <span className="font-mono">{task.lastRun.command}</span>
                                <span>exit {task.lastRun.exitCode ?? "—"} · {task.lastRun.elapsedMs} ms · {formatStagingTime(task.lastRun.ranAtMs)}{task.lastRun.staleAfterRun ? " · targets changed since this run" : ""}</span>
                              </div>
                            )}
                            {task.recommendedProfiles.length > 0 ? (
                              <ul className="mt-1 space-y-0.5">
                                {task.recommendedProfiles.map((profile) => (
                                  <li key={`${task.taskId}-${profile.id}`} className="flex flex-wrap items-center gap-2 text-[10.5px]">
                                    <span className="rounded bg-black/25 px-1.5 py-0.5 font-mono text-violet-100/80" title={profile.reason}>{profile.command}</span>
                                    <span className="text-violet-100/45">{profile.label} · matches {profile.matchedDraftPaths.length} target{profile.matchedDraftPaths.length === 1 ? "" : "s"} · not run</span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="mt-1 text-[10.5px] text-violet-100/45">{verificationSnapshot ? "No discovered profile matches these targets; verify manually after review." : "Discover profiles to see backend-owned matches for these targets."}</p>
                            )}
                            <div className="mt-1.5 flex flex-wrap gap-2">
                              {task.lastRun && task.lastRun.status !== "passed" && !task.lastRun.staleAfterRun && (
                                <button
                                  onClick={() => sendVerificationHandoff(task.taskId, "repair")}
                                  disabled={!canDiscoverVerification}
                                  title={!canDiscoverVerification ? "The native test-runner capability is unavailable in this build." : "Open Self-Healing Tests for this failed batch. You still run the profile explicitly; after a real failing run, this batch's applied targets are offered as one-click repair-target candidates for the existing reviewed repair-draft flow."}
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-rose-400/30 bg-rose-400/10 px-2.5 py-1 text-[11px] font-semibold text-rose-100 hover:bg-rose-400/20 disabled:opacity-40"
                                >
                                  <Wand2 className="h-3 w-3" /> Open repair for {task.taskId} (reviewed draft only)
                                </button>
                              )}
                              <button
                                onClick={() => sendVerificationHandoff(task.taskId)}
                                disabled={!canDiscoverVerification || task.recommendedProfiles.length === 0}
                                title={!canDiscoverVerification ? "The native test-runner capability is unavailable in this build." : task.recommendedProfiles.length === 0 ? "Discover profiles first so a matching backend-owned profile can be pre-selected." : "Open Self-Healing Tests with the top matching profile pre-selected. Nothing runs until you click Run tests there."}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-violet-400/30 bg-violet-400/10 px-2.5 py-1 text-[11px] font-semibold text-violet-100 hover:bg-violet-400/20 disabled:opacity-40"
                              >
                                <Play className="h-3 w-3" /> Send to Self-Healing Tests (pre-select only)
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    {verificationNotice && <div className="mt-2 text-[12px] text-emerald-300">{verificationNotice}</div>}
                  </details>
                )}
              </div>
            )}

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
                  disabled={!!generating || !!activeTaskId || staging}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40"
                >
                  {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
                  Generate all files
                </button>
                {builtFiles.length > 0 && (
                  <button
                    onClick={openInEditorReview}
                    disabled={staging || !!activeTaskId}
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
                      disabled={!!generating || !!activeTaskId || staging}
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
  acceptance: string[];
  reviewGate: string;
}

interface SpecChecklist {
  acceptanceCriteria: string[];
  dependencyAssumptions: string[];
  riskNotes: string[];
  reviewGates: string[];
}

interface SpecMetadataPreview {
  summary: string;
  acceptanceCriteria: string[];
  dependencyAssumptions: string[];
  riskNotes: string[];
  reviewGates: string[];
  taskSummaries: string[];
  exportText: string;
}

interface TaskPlanPreviewTask extends SpecTaskNode {
  generatedFileTargets: string[];
  pendingFileTargets: string[];
  statusLabel: string;
}

interface TaskPlanPreview {
  summary: string;
  tasks: TaskPlanPreviewTask[];
  fileTargetCount: number;
  generatedFileCount: number;
  pendingFileCount: number;
  exportText: string;
}

interface DraftHandoffFile {
  path: string;
  language: string;
  bytes: number;
  lines: number;
}

interface TaskHandoffPacket {
  id: string;
  title: string;
  handoffState: string;
  stagingState: string;
  applyState: string;
  dependsOn: string[];
  nextTaskIds: string[];
  generatedDrafts: DraftHandoffFile[];
  pendingFileTargets: string[];
  acceptance: string[];
  reviewGate: string;
  exportText: string;
}

interface TaskHandoffPreview {
  summary: string;
  packets: TaskHandoffPacket[];
  readyTaskCount: number;
  partialTaskCount: number;
  generatedDraftCount: number;
  totalDraftBytes: number;
  exportText: string;
}

function buildTaskHandoffPreview(taskPlan: TaskPlanPreview, builtFiles: VFile[], projectSummary: string, stagingLedger: BuilderTaskStagingRecord[] = [], applyProgress?: TaskApplyProgress): TaskHandoffPreview {
  const generatedAt = new Date().toISOString();
  const builtByPath = new Map(builtFiles.map((file) => [file.path, file]));
  const stagingByTask = new Map(stagingLedger.map((record) => [record.taskId, record]));
  const packets = taskPlan.tasks.map((task, _index, tasks) => {
    const generatedDrafts = task.generatedFileTargets
      .map((path) => buildDraftHandoffFile(builtByPath.get(path)))
      .filter((file): file is DraftHandoffFile => Boolean(file));
    const nextTaskIds = tasks.filter((candidate) => candidate.dependsOn.includes(task.id)).map((candidate) => candidate.id);
    const handoffState = task.reviewedFileTargets.length === 0
      ? "metadata-only task; no reviewed file targets assigned"
      : generatedDrafts.length > 0 && task.pendingFileTargets.length === 0
        ? "ready for Editor review handoff"
        : generatedDrafts.length > 0
          ? "partial handoff; some draft targets are still pending"
          : "waiting for in-memory draft generation";
    const stagingState = describeTaskStagingState(task, stagingByTask.get(task.id));
    const applyState = applyProgress?.tasks.find((item) => item.taskId === task.id)?.detail ?? "no reviewed-draft apply recorded in this session";
    const exportText = [
      "DevLab Builder task handoff packet",
      `Generated: ${generatedAt}`,
      "Source: Project Builder approved plan metadata plus current in-memory draft metadata",
      "Safety: metadata-only handoff; draft contents, workspace file contents, diffs, command output and verification results are not included.",
      "",
      "## Project summary",
      boundSpecText(projectSummary || "No project summary was retained for this plan.", 1_000),
      "",
      `## ${task.id} — ${task.title}`,
      `State: ${handoffState}`,
      `Editor staging: ${stagingState}`,
      `Editor apply: ${applyState}`,
      `Depends on: ${task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "none"}`,
      `Next task(s): ${nextTaskIds.length > 0 ? nextTaskIds.join(", ") : "none"}`,
      `Review gate: ${task.reviewGate}`,
      "",
      "### Generated draft metadata",
      ...(generatedDrafts.length > 0
        ? generatedDrafts.map((file) => `- ${file.path} — ${file.language}, ${formatByteCount(file.bytes)}, ${file.lines} line${file.lines === 1 ? "" : "s"}`)
        : ["- No generated draft metadata yet."]),
      "",
      "### Pending reviewed file targets",
      ...(task.pendingFileTargets.length > 0 ? task.pendingFileTargets.map((path) => `- ${path}`) : ["- None"]),
      "",
      "### Acceptance notes",
      ...task.acceptance.map((item) => `- ${item}`),
      "",
      "### Apply boundary",
      "- Handoff packets do not apply, persist or execute anything.",
      "- Staging a task batch only opens its in-memory drafts in Editor review through the native agent-tools metadata gate; it is not apply.",
      "- Editor reviewed-draft apply remains the only workspace write path.",
      "- Verification must be run explicitly after reviewed apply; this packet does not claim checks passed.",
      "- Apply state is session-only metadata reported by the Editor after explicit per-file apply; it is not re-verified against the workspace.",
    ].join("\n");
    return {
      id: task.id,
      title: task.title,
      handoffState,
      stagingState,
      applyState,
      dependsOn: task.dependsOn,
      nextTaskIds,
      generatedDrafts,
      pendingFileTargets: task.pendingFileTargets,
      acceptance: task.acceptance,
      reviewGate: task.reviewGate,
      exportText,
    };
  });
  const generatedDraftCount = packets.reduce((total, packet) => total + packet.generatedDrafts.length, 0);
  const totalDraftBytes = packets.reduce((total, packet) => total + packet.generatedDrafts.reduce((packetTotal, file) => packetTotal + file.bytes, 0), 0);
  const readyTaskCount = packets.filter((packet) => packet.handoffState === "ready for Editor review handoff").length;
  const partialTaskCount = packets.filter((packet) => packet.handoffState.startsWith("partial handoff")).length;
  const summary = `${readyTaskCount} ready handoff${readyTaskCount === 1 ? "" : "s"} · ${partialTaskCount} partial · ${generatedDraftCount} generated draft target${generatedDraftCount === 1 ? "" : "s"}`;
  const exportText = [
    "DevLab Builder task handoff ledger",
    `Generated: ${generatedAt}`,
    "Source: Project Builder approved plan metadata plus current in-memory draft metadata",
    "Safety: metadata-only handoff; no file contents, workspace reads, command execution, verification execution, persistence or workspace write.",
    "",
    "## Summary",
    `- ${summary}`,
    `- Generated draft metadata: ${generatedDraftCount} target${generatedDraftCount === 1 ? "" : "s"}, ${formatByteCount(totalDraftBytes)} total`,
    `- Task batches staged for Editor review this session: ${stagingLedger.length}`,
    `- Reviewed file targets applied in Editor this session: ${applyProgress?.appliedTargetCount ?? 0}/${taskPlan.fileTargetCount}${applyProgress && applyProgress.staleTargetCount > 0 ? ` (${applyProgress.staleTargetCount} with newer drafts)` : ""}`,
    `- Suggested next task: ${applyProgress?.nextTaskId ?? "none"}`,
    "- Draft contents and workspace diffs are intentionally omitted; use Editor review/recompare before apply.",
    "",
    "## Task handoff packets",
    ...packets.flatMap((packet) => [
      `### ${packet.id} — ${packet.title}`,
      `State: ${packet.handoffState}`,
      `Editor staging: ${packet.stagingState}`,
      `Editor apply: ${packet.applyState}`,
      `Depends on: ${packet.dependsOn.length > 0 ? packet.dependsOn.join(", ") : "none"}`,
      `Next task(s): ${packet.nextTaskIds.length > 0 ? packet.nextTaskIds.join(", ") : "none"}`,
      `Generated draft metadata: ${packet.generatedDrafts.length > 0 ? packet.generatedDrafts.map((file) => `${file.path} (${file.language}, ${formatByteCount(file.bytes)}, ${file.lines} line${file.lines === 1 ? "" : "s"})`).join(", ") : "none"}`,
      `Pending targets: ${packet.pendingFileTargets.length > 0 ? packet.pendingFileTargets.join(", ") : "none"}`,
      `Review gate: ${packet.reviewGate}`,
      "",
    ]),
  ].join("\n");
  return { summary, packets, readyTaskCount, partialTaskCount, generatedDraftCount, totalDraftBytes, exportText };
}

function buildDraftHandoffFile(file: VFile | undefined): DraftHandoffFile | null {
  if (!file) return null;
  return {
    path: boundSpecText(file.path, 512),
    language: boundSpecText(file.language || languageForPath(file.path), 80),
    bytes: textBytes(file.content),
    lines: countLines(file.content),
  };
}

type TaskApplyState = "not-started" | "partial" | "applied" | "stale" | "no-targets";

interface TaskApplyStatus {
  taskId: string;
  state: TaskApplyState;
  label: string;
  detail: string;
  appliedTargets: string[];
  staleTargets: string[];
  unappliedTargets: string[];
}

interface TaskApplyProgress {
  tasks: TaskApplyStatus[];
  appliedTargetCount: number;
  staleTargetCount: number;
  nextTaskId: string | null;
  guidance: string;
}

function buildTaskApplyProgress(taskPlan: TaskPlanPreview, builtFiles: VFile[], outcomes: ReviewedDraftApplyOutcome[]): TaskApplyProgress {
  const builtByPath = new Map(builtFiles.map((file) => [file.path, file]));
  const outcomeByPath = new Map<string, ReviewedDraftApplyOutcome>();
  for (const outcome of outcomes) {
    const existing = outcomeByPath.get(outcome.path);
    if (!existing || outcome.appliedAtMs > existing.appliedAtMs) outcomeByPath.set(outcome.path, outcome);
  }
  const tasks = taskPlan.tasks.map((task): TaskApplyStatus => {
    const appliedTargets = task.reviewedFileTargets.filter((path) => outcomeByPath.has(path));
    const staleTargets = appliedTargets.filter((path) => {
      const outcome = outcomeByPath.get(path);
      const draft = builtByPath.get(path);
      return Boolean(outcome && draft && textBytes(draft.content) !== outcome.bytes);
    });
    const unappliedTargets = task.reviewedFileTargets.filter((path) => !outcomeByPath.has(path));
    const total = task.reviewedFileTargets.length;
    const latestApplied = appliedTargets
      .map((path) => outcomeByPath.get(path))
      .filter((outcome): outcome is ReviewedDraftApplyOutcome => Boolean(outcome))
      .sort((a, b) => b.appliedAtMs - a.appliedAtMs)[0];
    let state: TaskApplyState;
    if (total === 0) state = "no-targets";
    else if (staleTargets.length > 0) state = "stale";
    else if (appliedTargets.length === total) state = "applied";
    else if (appliedTargets.length > 0) state = "partial";
    else state = "not-started";
    const label = state === "no-targets"
      ? "no apply targets"
      : state === "stale"
        ? `${appliedTargets.length}/${total} applied · ${staleTargets.length} changed since apply`
        : `${appliedTargets.length}/${total} applied in Editor`;
    const detail = state === "no-targets"
      ? "no reviewed file targets to apply"
      : appliedTargets.length === 0
        ? "no reviewed-draft apply recorded in this session"
        : `${appliedTargets.length}/${total} target${total === 1 ? "" : "s"} applied via explicit Editor apply${latestApplied ? ` (latest ${latestApplied.action.toLowerCase()} ${latestApplied.path} at ${new Date(latestApplied.appliedAtMs).toISOString()}, revision ${latestApplied.revision.slice(0, 12)})` : ""}${staleTargets.length > 0 ? `; ${staleTargets.length} applied target${staleTargets.length === 1 ? " has" : "s have"} a newer in-memory draft: ${staleTargets.join(", ")}` : ""}${unappliedTargets.length > 0 ? `; not yet applied: ${unappliedTargets.join(", ")}` : ""}`;
    return { taskId: task.id, state, label, detail, appliedTargets, staleTargets, unappliedTargets };
  });
  const appliedPaths = new Set(tasks.flatMap((task) => task.appliedTargets));
  const stalePaths = new Set(tasks.flatMap((task) => task.staleTargets));
  const appliedTargetCount = appliedPaths.size;
  const staleTargetCount = stalePaths.size;
  const statusByTask = new Map(tasks.map((task) => [task.taskId, task]));
  const isSettled = (taskId: string) => {
    const status = statusByTask.get(taskId);
    return !status || status.state === "applied" || status.state === "no-targets";
  };
  const nextTask = taskPlan.tasks.find((task) => {
    const status = statusByTask.get(task.id);
    if (!status || status.state === "applied" || status.state === "no-targets") return false;
    return task.dependsOn.every(isSettled);
  }) ?? null;
  const nextTaskId = nextTask?.id ?? null;
  let guidance: string;
  if (taskPlan.fileTargetCount === 0) {
    guidance = "No reviewed file targets were assigned, so there is nothing to stage or apply for these batches.";
  } else if (!nextTask) {
    const blocked = taskPlan.tasks.find((task) => {
      const status = statusByTask.get(task.id);
      return status && status.state !== "applied" && status.state !== "no-targets";
    });
    guidance = blocked
      ? `${blocked.id} is waiting on an earlier task: apply its dependency drafts in the Editor first.`
      : "All reviewed file targets have recorded Editor applies in this session. Run verification explicitly; this view does not claim checks passed.";
  } else {
    const status = statusByTask.get(nextTask.id);
    const taskState = taskPlan.tasks.find((task) => task.id === nextTask.id);
    if (status?.state === "stale") {
      guidance = `Next: ${nextTask.id} has applied targets with newer in-memory drafts; restage and recompare in the Editor before applying again.`;
    } else if (status?.state === "partial") {
      guidance = `Next: finish ${nextTask.id} by applying ${status.unappliedTargets.length} remaining target${status.unappliedTargets.length === 1 ? "" : "s"} in Editor review.`;
    } else if (taskState && taskState.generatedFileTargets.length === 0) {
      guidance = `Next: generate in-memory drafts for ${nextTask.id}, then stage them for Editor review.`;
    } else if (taskState && taskState.pendingFileTargets.length > 0) {
      guidance = `Next: ${nextTask.id} still has ${taskState.pendingFileTargets.length} pending draft target${taskState.pendingFileTargets.length === 1 ? "" : "s"}; generate them, then stage the batch for Editor review.`;
    } else {
      guidance = `Next: stage ${nextTask.id} for Editor review and apply each reviewed draft explicitly.`;
    }
  }
  return { tasks, appliedTargetCount, staleTargetCount, nextTaskId, guidance };
}

interface TaskVerificationLastRun {
  profileId: string;
  command: string;
  status: VerificationRunOutcome["status"];
  exitCode: number | null;
  elapsedMs: number;
  ranAtMs: number;
  staleAfterRun: boolean;
}

interface TaskVerificationHandoffTask {
  taskId: string;
  title: string;
  appliedPaths: string[];
  stalePaths: string[];
  latestRevision: string;
  latestAppliedAtMs: number;
  recommendedProfiles: VerificationProfileRecommendation[];
  lastRun: TaskVerificationLastRun | null;
}

interface TaskVerificationHandoff {
  summary: string;
  appliedTaskCount: number;
  appliedTargetCount: number;
  runCounts: { passed: number; failed: number; timeout: number };
  detectedProfileCount: number;
  unavailableReason: string;
  warnings: string[];
  tasks: TaskVerificationHandoffTask[];
  exportText: string;
}

function buildTaskVerificationHandoff(
  taskPlan: TaskPlanPreview,
  applyProgress: TaskApplyProgress,
  outcomes: ReviewedDraftApplyOutcome[],
  snapshot: TestRunnerSnapshot | null,
  unavailableReason: string,
  runOutcomes: VerificationRunOutcome[] = [],
): TaskVerificationHandoff {
  const outcomeByPath = new Map<string, ReviewedDraftApplyOutcome>();
  for (const outcome of outcomes) {
    const existing = outcomeByPath.get(outcome.path);
    if (!existing || outcome.appliedAtMs > existing.appliedAtMs) outcomeByPath.set(outcome.path, outcome);
  }
  const profiles = snapshot?.profiles ?? [];
  const tasks = taskPlan.tasks
    .map((task): TaskVerificationHandoffTask | null => {
      const status = applyProgress.tasks.find((item) => item.taskId === task.id);
      if (!status || status.appliedTargets.length === 0) return null;
      const latest = status.appliedTargets
        .map((path) => outcomeByPath.get(path))
        .filter((outcome): outcome is ReviewedDraftApplyOutcome => Boolean(outcome))
        .sort((a, b) => b.appliedAtMs - a.appliedAtMs)[0];
      const latestAppliedAtMs = latest?.appliedAtMs ?? 0;
      const lastOutcome = runOutcomes
        .filter((outcome) => outcome.taskId === task.id)
        .sort((a, b) => b.ranAtMs - a.ranAtMs)[0];
      const lastRun: TaskVerificationLastRun | null = lastOutcome
        ? {
          profileId: lastOutcome.profileId,
          command: lastOutcome.command,
          status: lastOutcome.status,
          exitCode: lastOutcome.exitCode,
          elapsedMs: lastOutcome.elapsedMs,
          ranAtMs: lastOutcome.ranAtMs,
          // A run is only evidence for the applied state it observed: any later apply or draft change supersedes it.
          staleAfterRun: status.staleTargets.length > 0 || latestAppliedAtMs > lastOutcome.ranAtMs,
        }
        : null;
      return {
        taskId: task.id,
        title: task.title,
        appliedPaths: status.appliedTargets,
        stalePaths: status.staleTargets,
        latestRevision: latest ? latest.revision.slice(0, 12) : "",
        latestAppliedAtMs,
        recommendedProfiles: selectTaskVerificationProfiles(profiles, status.appliedTargets),
        lastRun,
      };
    })
    .filter((task): task is TaskVerificationHandoffTask => Boolean(task));
  const appliedTaskCount = tasks.length;
  const appliedTargetCount = applyProgress.appliedTargetCount;
  const detectedProfileCount = profiles.length;
  const warnings = (snapshot?.warnings ?? []).slice(0, 6).map((warning) => boundSpecText(warning, 300));
  const runCounts = tasks.reduce(
    (counts, task) => {
      if (task.lastRun && !task.lastRun.staleAfterRun) counts[task.lastRun.status] += 1;
      return counts;
    },
    { passed: 0, failed: 0, timeout: 0 },
  );
  const repairCandidateTaskIds = tasks
    .filter((task) => task.lastRun && task.lastRun.status !== "passed" && !task.lastRun.staleAfterRun)
    .map((task) => task.taskId);
  const summary = `${appliedTaskCount} batch${appliedTaskCount === 1 ? "" : "es"} with applied targets · ${appliedTargetCount} applied target${appliedTargetCount === 1 ? "" : "s"} · ${snapshot ? `${detectedProfileCount} discovered profile${detectedProfileCount === 1 ? "" : "s"}` : "profiles not discovered"} · real runs: ${runCounts.passed} passed, ${runCounts.failed} failed, ${runCounts.timeout} timed out${repairCandidateTaskIds.length > 0 ? ` · ${repairCandidateTaskIds.length} batch${repairCandidateTaskIds.length === 1 ? "" : "es"} eligible for reviewed repair` : ""}`;
  const exportText = [
    "DevLab Builder task verification handoff",
    `Generated: ${new Date().toISOString()}`,
    "Source: session-only Editor apply metadata, a read-only native test-runner profile snapshot and metadata-only outcomes of runs the user started explicitly in Self-Healing Tests",
    "Safety: copying or sending this handoff executes nothing; only runs the user started explicitly in Self-Healing Tests are listed, by status/exit code/timing metadata without captured output. No file was read or written and nothing was persisted.",
    "",
    "## Summary",
    `- ${summary}`,
    `- Applied targets with a newer in-memory draft: ${applyProgress.staleTargetCount}`,
    ...(unavailableReason ? [`- Profile discovery unavailable: ${boundSpecText(unavailableReason, 300)}`] : []),
    ...(warnings.length > 0 ? warnings.map((warning) => `- Discovery warning: ${warning}`) : []),
    ...(snapshot ? [`- Backend-owned profile bounds: ${snapshot.timeoutSecs}s timeout, ${formatByteCount(snapshot.maxOutputBytes)} captured output`] : []),
    "",
    "## Task batches with applied targets",
    ...(tasks.length > 0
      ? tasks.flatMap((task) => [
        `### ${task.taskId} — ${task.title}`,
        `Applied targets: ${task.appliedPaths.join(", ")}`,
        `Changed since apply: ${task.stalePaths.length > 0 ? task.stalePaths.join(", ") : "none"}`,
        `Latest applied revision: ${task.latestRevision || "unknown"}`,
        `Last real run: ${task.lastRun ? `${task.lastRun.status} — ${task.lastRun.command} (exit ${task.lastRun.exitCode ?? "none"}, ${task.lastRun.elapsedMs} ms, ${new Date(task.lastRun.ranAtMs).toISOString()})${task.lastRun.staleAfterRun ? " — superseded: targets were applied or changed after this run" : ""}` : "none in this session"}`,
        "Recommended backend-owned profiles (not run by this handoff):",
        ...(task.recommendedProfiles.length > 0
          ? task.recommendedProfiles.map((profile) => `- ${profile.id} — ${profile.label}: ${profile.command} (matches ${profile.matchedDraftPaths.length} target${profile.matchedDraftPaths.length === 1 ? "" : "s"})`)
          : [snapshot ? "- No discovered profile matches these targets; verify manually." : "- Profiles not discovered yet."]),
        "",
      ])
      : ["- No reviewed file targets have been applied in the Editor in this session."]),
    "## Next steps",
    "- Open Self-Healing Tests (or use Send, which only pre-selects) and run a recommended backend-owned profile explicitly.",
    "- A run listed above is evidence only for the applied state it observed; rerun after any further apply.",
    ...(repairCandidateTaskIds.length > 0 ? [`- Batches with a current failing run (${repairCandidateTaskIds.join(", ")}) can open Self-Healing Tests in repair mode: rerun the profile explicitly, then draft a one-file repair from the real failing output; the draft still requires Editor reviewed apply.`] : []),
    "- Inspect real stdout/stderr; generate a repair draft only from a real failing run.",
    "- Restage and recompare any target marked changed since apply before applying it again.",
    "- Do not treat this handoff as proof that verification has run; only the listed real runs did.",
  ].join("\n");
  return { summary, appliedTaskCount, appliedTargetCount, runCounts, detectedProfileCount, unavailableReason, warnings, tasks, exportText };
}

function selectTaskVerificationProfiles(profiles: TestRunnerSnapshot["profiles"], appliedPaths: string[]): VerificationProfileRecommendation[] {
  if (profiles.length === 0 || appliedPaths.length === 0) return [];
  const ranked = recommendVerificationProfiles(profiles, appliedPaths);
  // Per-task handoffs prefer profiles that match at least one applied target; fall back to the ranked list only when nothing matches.
  const matched = ranked.filter((profile) => profile.matchedDraftPaths.length > 0);
  return (matched.length > 0 ? matched : ranked).slice(0, 3);
}

interface TaskStagingLedgerPreview {
  summary: string;
  stagedTaskCount: number;
  stagedFileCount: number;
  totalBytes: number;
  exportText: string;
}

function buildTaskStagingRecord(task: TaskPlanPreviewTask, files: VFile[], summary: string): BuilderTaskStagingRecord {
  const fileMetadata = files.map((file) => ({ path: boundSpecText(file.path, 512), bytes: textBytes(file.content) }));
  return {
    taskId: task.id,
    taskTitle: boundSpecText(task.title, 240),
    stagedAtMs: Date.now(),
    summary: boundSpecText(summary, 1_800),
    files: fileMetadata,
    totalBytes: fileMetadata.reduce((total, file) => total + file.bytes, 0),
  };
}

function describeTaskStagingState(task: TaskPlanPreviewTask, record: BuilderTaskStagingRecord | undefined): string {
  if (!record) {
    return task.generatedFileTargets.length > 0
      ? "not staged yet; generated drafts remain in Builder memory"
      : "not staged; no generated drafts available";
  }
  const stagedPaths = new Set(record.files.map((file) => file.path));
  const unstagedGenerated = task.generatedFileTargets.filter((path) => !stagedPaths.has(path));
  const base = `staged ${record.files.length} file${record.files.length === 1 ? "" : "s"} for Editor review at ${new Date(record.stagedAtMs).toISOString()}`;
  if (unstagedGenerated.length > 0) {
    return `${base}; ${unstagedGenerated.length} newer generated draft${unstagedGenerated.length === 1 ? "" : "s"} not yet restaged`;
  }
  return `${base}; apply state is tracked only in Editor review`;
}

function buildTaskStagingLedgerPreview(records: BuilderTaskStagingRecord[]): TaskStagingLedgerPreview {
  const stagedTaskCount = records.length;
  const stagedFileCount = records.reduce((total, record) => total + record.files.length, 0);
  const totalBytes = records.reduce((total, record) => total + record.totalBytes, 0);
  const summary = `${stagedTaskCount} staged batch${stagedTaskCount === 1 ? "" : "es"} · ${stagedFileCount} file${stagedFileCount === 1 ? "" : "s"} · ${formatByteCount(totalBytes)}`;
  const exportText = [
    "DevLab Builder task staging ledger",
    `Generated: ${new Date().toISOString()}`,
    "Source: session-only renderer metadata recorded when task batches were staged through the native agent-tools gate for Editor review",
    "Safety: metadata-only; draft contents, workspace contents, diffs, apply results, command output and verification results are not included. Staging is not apply.",
    "",
    "## Summary",
    `- ${summary}`,
    "- Editor reviewed-draft apply remains the only workspace write path.",
    "- This ledger is not persisted and is not included in recovery snapshots.",
    "",
    "## Staged task batches",
    ...(records.length > 0
      ? records.flatMap((record) => [
        `### ${record.taskId} — ${record.taskTitle}`,
        `Staged at: ${new Date(record.stagedAtMs).toISOString()}`,
        `Summary: ${record.summary}`,
        `Files (${record.files.length}, ${formatByteCount(record.totalBytes)}):`,
        ...record.files.map((file) => `- ${file.path} — ${formatByteCount(file.bytes)}`),
        "",
      ])
      : ["- None staged in this session."]),
  ].join("\n");
  return { summary, stagedTaskCount, stagedFileCount, totalBytes, exportText };
}

function formatStagingTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function countLines(value: string) {
  if (!value) return 0;
  return value.split(/\r\n|\r|\n/).length;
}

function buildTaskPlanPreview(plan: BuilderPlan, builtFiles: VFile[]): TaskPlanPreview {
  const boundedPlan = boundPlanForSpec(plan);
  const generatedPaths = new Set(builtFiles.map((file) => file.path));
  const taskDag = buildTaskDag(boundedPlan);
  const tasks = taskDag.map((task) => {
    const generatedFileTargets = task.reviewedFileTargets.filter((path) => generatedPaths.has(path));
    const pendingFileTargets = task.reviewedFileTargets.filter((path) => !generatedPaths.has(path));
    const statusLabel = task.reviewedFileTargets.length === 0
      ? "no file target"
      : pendingFileTargets.length === 0
        ? "draft targets generated"
        : `${pendingFileTargets.length} pending draft target${pendingFileTargets.length === 1 ? "" : "s"}`;
    return { ...task, generatedFileTargets, pendingFileTargets, statusLabel };
  });
  const allTargets = new Set(tasks.flatMap((task) => task.reviewedFileTargets));
  const generatedTargets = new Set(tasks.flatMap((task) => task.generatedFileTargets));
  const fileTargetCount = allTargets.size;
  const generatedFileCount = generatedTargets.size;
  const pendingFileCount = Math.max(0, fileTargetCount - generatedFileCount);
  const summary = `${tasks.length} task batch${tasks.length === 1 ? "" : "es"} · ${generatedFileCount}/${fileTargetCount} draft target${fileTargetCount === 1 ? "" : "s"} generated`;
  const taskSections = tasks.flatMap((task) => [
    `### ${task.id} — ${task.title}`,
    `Depends on: ${task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "none"}`,
    `Status: ${task.statusLabel}`,
    `Detail: ${task.detail}`,
    `Draft targets: ${task.reviewedFileTargets.length > 0 ? task.reviewedFileTargets.map((target) => {
      const state = task.generatedFileTargets.includes(target) ? "generated in memory" : "pending in-memory generation";
      return `${target} (${state})`;
    }).join(", ") : "none assigned"}`,
    "Acceptance:",
    ...task.acceptance.map((item) => `- ${item}`),
    `Review gate: ${task.reviewGate}`,
    "",
  ]);
  const exportText = [
    "DevLab Builder task DAG implementation preview",
    `Generated: ${new Date().toISOString()}`,
    "Source: Project Builder approved plan metadata plus current in-memory draft generation status",
    "Safety: preview-only renderer metadata; task generation creates in-memory drafts only, with no command execution, persistence or workspace write.",
    "",
    "## Summary",
    `- ${summary}`,
    "- Task dependencies are sequential and review-oriented.",
    "- Setup commands remain manual references only.",
    "- Workspace writes still require explicit Editor reviewed-draft apply per file.",
    "",
    "## Task batches",
    ...taskSections,
  ].join("\n");
  return { summary, tasks, fileTargetCount, generatedFileCount, pendingFileCount, exportText };
}

function buildSpecMetadataPreview(plan: BuilderPlan, brief: string): SpecMetadataPreview {
  const boundedPlan = boundPlanForSpec(plan);
  const checklist = buildSpecChecklist(boundedPlan);
  const taskDag = buildTaskDag(boundedPlan);
  const taskSummaries = taskDag.slice(0, 8).map((task) => {
    const files = task.reviewedFileTargets.length > 0 ? task.reviewedFileTargets.join(", ") : "no assigned file target";
    return `${task.id}: ${task.title} — ${files}`;
  });
  const summary = `${taskDag.length} task${taskDag.length === 1 ? "" : "s"} · ${checklist.acceptanceCriteria.length} acceptance item${checklist.acceptanceCriteria.length === 1 ? "" : "s"} · ${checklist.riskNotes.length} risk note${checklist.riskNotes.length === 1 ? "" : "s"}`;
  const exportText = [
    "DevLab Builder spec metadata preview",
    `Generated: ${new Date().toISOString()}`,
    "Source: Project Builder approved plan metadata",
    "Safety: preview-only renderer metadata; no command execution, persistence or workspace write.",
    "",
    "## Brief excerpt",
    boundSpecText(brief.trim() || "No brief was retained for this plan.", 1_000),
    "",
    "## Acceptance criteria",
    ...checklist.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Dependency and assumption register",
    ...checklist.dependencyAssumptions.map((item) => `- ${item}`),
    "",
    "## Risk notes",
    ...checklist.riskNotes.map((item) => `- ${item}`),
    "",
    "## Review gates",
    ...checklist.reviewGates.map((item) => `- ${item}`),
    "",
    "## Task DAG preview",
    ...taskSummaries.map((item) => `- ${item}`),
  ].join("\n");
  return { ...checklist, summary, taskSummaries, exportText };
}

function buildSpecMarkdown(plan: BuilderPlan, brief: string): string {
  const boundedPlan = boundPlanForSpec(plan);
  const taskDag = buildTaskDag(boundedPlan);
  const checklist = buildSpecChecklist(boundedPlan);
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
    "## Acceptance criteria",
    "",
    ...checklist.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Dependency and assumption register",
    "",
    ...checklist.dependencyAssumptions.map((item) => `- ${item}`),
    "",
    "## Risk notes",
    "",
    ...checklist.riskNotes.map((item) => `- ${item}`),
    "",
    "## Review gates",
    "",
    ...checklist.reviewGates.map((item) => `- ${item}`),
    "",
    "## Review and safety checklist",
    "",
    "- Confirm the scope, acceptance criteria, risk notes and out-of-scope boundaries before generating or applying files.",
    "- Generate file drafts into memory, then inspect each draft in the Editor.",
    "- Recompare existing files before applying reviewed drafts.",
    "- Run bounded verification profiles or explicit manual commands only after applying reviewed changes.",
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
  return plan.steps.slice(0, MAX_PLAN_STEPS).map((step, index) => {
    const reviewedFileTargets = filesForTask(files, index, plan.steps.length);
    return {
      id: `task-${String(index + 1).padStart(2, "0")}`,
      title: step.title,
      detail: step.detail,
      dependsOn: index === 0 ? [] : [`task-${String(index).padStart(2, "0")}`],
      reviewedFileTargets,
      acceptance: acceptanceForTask(step, reviewedFileTargets),
      reviewGate: index === plan.steps.length - 1
        ? "Final reviewed drafts are inspected in the Editor and applied only by explicit user action."
        : "Proceed after the previous reviewed draft target and assumptions are accepted.",
    };
  });
}

function buildSpecChecklist(plan: BuilderPlan): SpecChecklist {
  const files = plan.files.slice(0, MAX_PLAN_FILES);
  const commands = plan.commands.slice(0, MAX_PLAN_COMMANDS);
  const acceptanceCriteria = [
    `Project scope matches the approved summary: ${plan.summary}`,
    ...plan.steps.slice(0, 6).map((step, index) => `Task ${index + 1} outcome is reviewable: ${step.title}.`),
    ...files.slice(0, 6).map((file) => `Reviewed draft target is accounted for: ${file.path}.`),
    "No generated file is persisted until the Editor reviewed-draft apply gate is used.",
  ].map((item) => boundSpecText(item, 500));

  const dependencyAssumptions = [
    ...listOrFallback(plan.stack, "No stack choices were returned.").slice(0, 10).map((item) => `Stack assumption: ${item}.`),
    ...commands.slice(0, 6).map((command) => `Manual setup reference only: ${command}`),
    "Secrets, provider keys and environment-specific values must remain placeholders unless supplied by the user outside generated files.",
    "Any package, toolchain or service dependency not already present requires explicit user review before installation.",
  ].map((item) => boundSpecText(item, 500));

  const riskNotes = [
    files.length > 8 ? "Plan has many reviewed file targets; split implementation into smaller reviewed batches if diffs become hard to inspect." : "File target count is within the bounded Builder review pack.",
    commands.length > 0 ? "Setup commands are references only and may have side effects if a user runs them manually outside DevLab." : "No setup commands were returned; confirm any missing install/run steps before implementation.",
    "Model-generated paths and descriptions are planning metadata; inspect actual file contents before applying any draft.",
    "Verification status is unknown until backend-owned profiles or explicit manual commands are run after reviewed apply.",
  ].map((item) => boundSpecText(item, 500));

  const reviewGates = [
    "Gate 1 — Plan review: confirm scope, stack assumptions, file targets and out-of-scope items.",
    "Gate 2 — Draft generation: generated files stay in memory and must use safe workspace-relative paths.",
    "Gate 3 — Editor review: inspect each reviewed draft, recompare existing files and apply only approved changes.",
    "Gate 4 — Verification: run bounded native profiles or explicit manual commands after apply; do not mark checks as passed before they run.",
  ];

  return { acceptanceCriteria, dependencyAssumptions, riskNotes, reviewGates };
}

function acceptanceForTask(step: BuilderPlan["steps"][number], fileTargets: string[]): string[] {
  const targets = fileTargets.length > 0
    ? `Reviewed file target${fileTargets.length === 1 ? "" : "s"}: ${fileTargets.join(", ")}.`
    : "No reviewed file target is assigned to this task yet.";
  return [
    `Outcome is inspectable: ${step.title}.`,
    targets,
    "No command execution or workspace write is implied by completing this task node.",
  ].map((item) => boundSpecText(item, 420));
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
