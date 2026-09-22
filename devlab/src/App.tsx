import { lazy, Suspense, useEffect, useState } from "react";
import type { AgentContextFile, BuilderPhase, BuilderPlan, BuilderTaskStagingRecord, ChatMessage, OpenGeneratedDrafts, ReviewedDraftApplyOutcome, VFile, ViewId } from "./types";
import { getApiKey, getModel, getPicked, pickBestModel } from "./lib/gemini";
import { loadDeploy, loadGit, loadSettings, applyTheme, getTheme, type DevLabSettings } from "./lib/settings";
import { resolveAiRoute } from "./lib/modelRouting";
import {
  buildSessionRecovery, clearSessionRecovery, loadSessionRecovery, saveSessionRecovery,
  sessionRecoverySummary, type SessionRecoverySnapshot,
} from "./lib/sessionRecovery";
import {
  detectRuntime, hasNativeCapability, WEB_RUNTIME,
  type NativeCapability, type RuntimeInfo,
} from "./lib/native";
import { recordAgentDraft } from "./lib/agentTools";
import { cn } from "./utils/cn";
import {
  Sparkles, FolderTree, Bot, Terminal as TerminalIcon, GitBranch, Rocket,
  Database, Plug, Container, Globe, Wrench, Settings as SettingsIcon,
  Circle, Zap, CheckCircle2, Wand2, Code2, UploadCloud, BookOpen,
  PenTool, Stethoscope, FileDiff, ScanLine, Radio,
} from "lucide-react";
import { KeyModal } from "./components/KeyModal";
import { WelcomePanel } from "./panels/WelcomePanel";
import { AgentPanel } from "./panels/AgentPanel";
import { CanvasPanel } from "./panels/CanvasPanel";
import { EditorPanel } from "./panels/EditorPanel";
import { MigratePanel } from "./panels/MigratePanel";
import { VisionPanel } from "./panels/VisionPanel";
import { LiveSharePanel } from "./panels/LiveSharePanel";
import { ExplorerPanel } from "./panels/ExplorerPanel";
import { PreviewPanel } from "./panels/PreviewPanel";
import { SetupPanel } from "./panels/SetupPanel";
import { SettingsPanel } from "./panels/SettingsPanel";


const BuilderPanel = lazy(() => import("./panels/BuilderPanel").then((module) => ({
  default: module.BuilderPanel,
})));

const TerminalPanel = lazy(() => import("./panels/TerminalPanel").then((module) => ({
  default: module.TerminalPanel,
})));

const GitPanel = lazy(() => import("./panels/GitPanel").then((module) => ({
  default: module.GitPanel,
})));

const DockerPanel = lazy(() => import("./panels/DockerPanel").then((module) => ({
  default: module.DockerPanel,
})));

const DatabasePanel = lazy(() => import("./panels/DatabasePanel").then((module) => ({
  default: module.DatabasePanel,
})));

const HealerPanel = lazy(() => import("./panels/HealerPanel").then((module) => ({
  default: module.HealerPanel,
})));

const ApiPanel = lazy(() => import("./panels/ApiPanel").then((module) => ({
  default: module.ApiPanel,
})));

const ToolsPanel = lazy(() => import("./panels/ToolsPanel").then((module) => ({
  default: module.ToolsPanel,
})));

interface NavItem { id: ViewId; icon: typeof Sparkles; label: string; shortcut?: string }

// Bound for the session-only reviewed-draft apply outcome ledger shared with Project Builder.
const MAX_APPLY_OUTCOMES = 48;

const NAV: NavItem[] = [
  { id: "welcome",  icon: Sparkles,     label: "Home" },
  { id: "agent",    icon: Bot,          label: "AI Agent",       shortcut: "⌘1" },
  { id: "builder",  icon: Wand2,        label: "Project Builder", shortcut: "⌘2" },
  { id: "canvas",   icon: PenTool,      label: "Architecture Canvas" },
  { id: "editor",   icon: Code2,        label: "Code Editor",    shortcut: "⌘3" },
  { id: "healer",   icon: Stethoscope,  label: "Self-Healing Tests" },
  { id: "migrate",  icon: FileDiff,     label: "DB Migrations" },
  { id: "vision",   icon: ScanLine,     label: "Reverse Engineer" },
  { id: "live",     icon: Radio,        label: "Live Share",     shortcut: "⌘7" },
  { id: "explorer", icon: FolderTree,   label: "Templates" },
  { id: "terminal", icon: TerminalIcon, label: "Terminal",       shortcut: "⌘4" },
  { id: "git",      icon: GitBranch,    label: "Source Control", shortcut: "⌘5" },
  { id: "cicd",     icon: Rocket,       label: "CI / CD" },
  { id: "deploy",   icon: UploadCloud,  label: "Deploy",         shortcut: "⌘6" },
  { id: "database", icon: Database,     label: "Database" },
  { id: "api",      icon: Plug,         label: "API Client" },
  { id: "docker",   icon: Container,    label: "Containers" },
  { id: "preview",  icon: Globe,        label: "Live Preview" },
  { id: "tools",    icon: Wrench,       label: "Toolchain" },
  { id: "setup",    icon: BookOpen,     label: "Local Setup" },
];

export default function App() {
  const [settings, setSettings] = useState<DevLabSettings>(loadSettings);
  const [view, setView] = useState<ViewId>(() =>
    loadSettings().showWelcomeOnStart ? "welcome" : "agent",
  );
  const [keyVersion, setKeyVersion] = useState(0);
  const [showModal, setShowModal] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  const [time, setTime] = useState("");
  const [runtime, setRuntime] = useState(WEB_RUNTIME);
  const [editorDirty, setEditorDirty] = useState(false);
  const [generatedDrafts, setGeneratedDrafts] = useState<VFile[]>([]);
  const [agentMessages, setAgentMessages] = useState<ChatMessage[]>([]);
  const [agentInput, setAgentInput] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentContextFiles, setAgentContextFiles] = useState<AgentContextFile[]>([]);
  const [builderPhase, setBuilderPhase] = useState<BuilderPhase>("brief");
  const [builderBrief, setBuilderBrief] = useState("");
  const [builderRaw, setBuilderRaw] = useState("");
  const [builderPlan, setBuilderPlan] = useState<BuilderPlan | null>(null);
  const [builderBusy, setBuilderBusy] = useState(false);
  const [builderError, setBuilderError] = useState("");
  const [builderGenerating, setBuilderGenerating] = useState<string | null>(null);
  const [builderBuiltFiles, setBuilderBuiltFiles] = useState<VFile[]>([]);
  const [builderStaging, setBuilderStaging] = useState(false);
  const [builderStageNotice, setBuilderStageNotice] = useState("");
  // Session-only metadata ledger for task batches staged into Editor review; intentionally not persisted.
  const [builderTaskStagingLedger, setBuilderTaskStagingLedger] = useState<BuilderTaskStagingRecord[]>([]);
  // Session-only metadata outcomes reported by Editor reviewed-draft apply; never persisted, no file contents.
  const [reviewedDraftApplyOutcomes, setReviewedDraftApplyOutcomes] = useState<ReviewedDraftApplyOutcome[]>([]);
  const [pendingRecovery, setPendingRecovery] = useState<SessionRecoverySnapshot | null>(() => loadSessionRecovery());
  const [recoveryReady, setRecoveryReady] = useState(() => !loadSessionRecovery());

  const aiRoute = resolveAiRoute("chat", {
    selectedModel: getModel(),
    pickedModel: getPicked(),
  }, settings);
  const hasKey = aiRoute.status === "active" && !!getApiKey();
  const theme = getTheme(settings.theme);

  function navigate(next: ViewId) {
    if (
      view === "editor"
      && next !== "editor"
      && editorDirty
      && !confirm("Leave the workspace editor and discard unsaved changes?")
    ) return;
    setView(next);
  }

  useEffect(() => { applyTheme(settings); }, [settings]);

  // Rewrite the retired Git settings shape on startup so legacy plaintext
  // tokens are removed even before the Source Control panel is opened.
  useEffect(() => {
    loadGit();
    loadDeploy();
  }, []);

  useEffect(() => {
    let mounted = true;
    detectRuntime().then((info) => { if (mounted) setRuntime(info); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!firstRun && !pendingRecovery) {
      const startupSettings = loadSettings();
      if (startupSettings.aiProvider === "gemini" && !getApiKey()) setShowModal(true);
      else if (getApiKey()) pickBestModel();
      setFirstRun(true);
    }
  }, [firstRun, pendingRecovery]);

  useEffect(() => {
    if (!recoveryReady) return;
    const snapshot = buildSessionRecovery({
      view,
      agentMessages,
      agentInput,
      builderPhase,
      builderBrief,
      builderRaw,
      builderPlan,
      builderBuiltFiles,
      builderStageNotice,
    });
    saveSessionRecovery(snapshot);
  }, [
    recoveryReady,
    view,
    agentMessages,
    agentInput,
    builderPhase,
    builderBrief,
    builderRaw,
    builderPlan,
    builderBuiltFiles,
    builderStageNotice,
  ]);

  useEffect(() => {
    const tick = () => setTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    tick();
    const i = setInterval(tick, 30_000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const map: Record<string, ViewId> = {
        "1": "agent", "2": "builder", "3": "editor", "4": "terminal",
        "5": "git", "6": "deploy", ",": "settings",
      };
      const t = map[e.key];
      if (t) { e.preventDefault(); navigate(t); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, editorDirty]);

  const refreshKey = () => setKeyVersion((v) => v + 1);
  const refreshSettings = () => setSettings(loadSettings());

  function resetRecoverableSession() {
    setAgentMessages([]);
    setAgentInput("");
    setAgentBusy(false);
    setAgentContextFiles([]);
    setBuilderPhase("brief");
    setBuilderBrief("");
    setBuilderRaw("");
    setBuilderPlan(null);
    setBuilderBusy(false);
    setBuilderError("");
    setBuilderGenerating(null);
    setBuilderBuiltFiles([]);
    setBuilderStaging(false);
    setBuilderStageNotice("");
    setBuilderTaskStagingLedger([]);
    setReviewedDraftApplyOutcomes([]);
    setGeneratedDrafts([]);
  }

  function recordReviewedDraftApplyOutcome(outcome: ReviewedDraftApplyOutcome) {
    setReviewedDraftApplyOutcomes((current) => [
      outcome,
      ...current.filter((item) => item.path !== outcome.path),
    ].slice(0, MAX_APPLY_OUTCOMES));
  }

  function finishRecoveryPrompt() {
    setPendingRecovery(null);
    setRecoveryReady(true);
    setFirstRun(true);
    if (getApiKey()) void pickBestModel();
  }

  function continueRecoveredSession(snapshot: SessionRecoverySnapshot) {
    setAgentMessages(snapshot.agent?.messages ?? []);
    setAgentInput(snapshot.agent?.input ?? "");
    setAgentBusy(false);
    setAgentContextFiles([]);
    setBuilderPhase(snapshot.builder?.phase ?? "brief");
    setBuilderBrief(snapshot.builder?.brief ?? "");
    setBuilderRaw(snapshot.builder?.raw ?? "");
    setBuilderPlan(snapshot.builder?.plan ?? null);
    setBuilderBusy(false);
    setBuilderError("");
    setBuilderGenerating(null);
    setBuilderBuiltFiles(snapshot.builder?.builtFiles ?? []);
    setBuilderStaging(false);
    setBuilderStageNotice(snapshot.builder?.stageNotice ?? "");
    setView(settings.visiblePanels.includes(snapshot.view) ? snapshot.view : "agent");
    finishRecoveryPrompt();
  }

  function startFresh(next: "builder" | "editor" | "current") {
    clearSessionRecovery();
    resetRecoverableSession();
    finishRecoveryPrompt();
    if (next !== "current") setView(next);
  }

  const nav = NAV.filter((n) => settings.visiblePanels.includes(n.id));

  const openGeneratedSource: OpenGeneratedDrafts = async (files, summary = "Generated reviewed drafts") => {
    if (files.length === 0) return false;
    if (runtime.runtime === "tauri") {
      if (!hasNativeCapability(runtime, "agent-tools")) {
        alert("DevLab cannot stage generated drafts because the native agent-tools capability is unavailable in this build.");
        return false;
      }
      try {
        await recordAgentDraft(
          summary,
          files.map((file) => ({ path: file.path, bytes: textBytes(file.content) })),
        );
      } catch (error) {
        alert(`Could not stage generated drafts for reviewed editor apply. Nothing was opened.\n\n${formatDraftStageError(error)}`);
        return false;
      }
    }
    setGeneratedDrafts(files);
    navigate("editor");
    return true;
  };

  function nativeFeature(
    title: string,
    capability: NativeCapability,
    milestone: string,
  ) {
    return (
      <NativeFeaturePending
        title={title}
        milestone={milestone}
        runtime={runtime}
        backendEnabled={hasNativeCapability(runtime, capability)}
      />
    );
  }

  function render() {
    switch (view) {
      case "welcome":  return <WelcomePanel key={keyVersion} onNavigate={navigate} hasKey={hasKey} />;
      case "agent":    return <AgentPanel
        key={keyVersion}
        onNeedKey={() => setShowModal(true)}
        onOpenFiles={openGeneratedSource}
        canAttachWorkspace={hasNativeCapability(runtime, "filesystem")}
        canShowAudit={hasNativeCapability(runtime, "agent-audit")}
        contextFiles={agentContextFiles}
        setContextFiles={setAgentContextFiles}
        messages={agentMessages}
        setMessages={setAgentMessages}
        input={agentInput}
        setInput={setAgentInput}
        busy={agentBusy}
        setBusy={setAgentBusy}
      />;
      case "builder":  return hasNativeCapability(runtime, "agent-tools")
        ? <Suspense fallback={<NativePanelLoading label="Loading native agent tools…" />}>
          <BuilderPanel
            key={keyVersion}
            onNeedKey={() => setShowModal(true)}
            onOpenFiles={openGeneratedSource}
            phase={builderPhase}
            setPhase={setBuilderPhase}
            brief={builderBrief}
            setBrief={setBuilderBrief}
            raw={builderRaw}
            setRaw={setBuilderRaw}
            plan={builderPlan}
            setPlan={setBuilderPlan}
            busy={builderBusy}
            setBusy={setBuilderBusy}
            error={builderError}
            setError={setBuilderError}
            generating={builderGenerating}
            setGenerating={setBuilderGenerating}
            builtFiles={builderBuiltFiles}
            setBuiltFiles={setBuilderBuiltFiles}
            staging={builderStaging}
            setStaging={setBuilderStaging}
            stageNotice={builderStageNotice}
            setStageNotice={setBuilderStageNotice}
            taskStagingLedger={builderTaskStagingLedger}
            setTaskStagingLedger={setBuilderTaskStagingLedger}
            applyOutcomes={reviewedDraftApplyOutcomes}
            setApplyOutcomes={setReviewedDraftApplyOutcomes}
          />
        </Suspense>
        : nativeFeature(
          "Project Builder", "agent-tools", "Phase 6E · permission-gated multi-file draft staging",
        );
      case "canvas":   return <CanvasPanel key={keyVersion} onOpenFiles={openGeneratedSource} />;
      case "editor": {
        if (hasNativeCapability(runtime, "filesystem")) {
          return <EditorPanel
            incomingDrafts={generatedDrafts}
            onDismissDrafts={() => setGeneratedDrafts([])}
            onDirtyChange={setEditorDirty}
            onDraftApplied={recordReviewedDraftApplyOutcome}
          />;
        }
        return generatedDrafts.length > 0
          ? <GeneratedDraftReview drafts={generatedDrafts} onDismiss={() => setGeneratedDrafts([])} />
          : nativeFeature(
            "Workspace Editor", "filesystem", "Phase 2 · real scoped workspace and filesystem access",
          );
      }
      case "healer":   return hasNativeCapability(runtime, "test-runner")
        ? <Suspense fallback={<NativePanelLoading label="Loading native test runner…" />}>
          <HealerPanel onOpenFiles={openGeneratedSource} onNeedKey={() => setShowModal(true)} />
        </Suspense>
        : nativeFeature(
          "Self-Healing Tests", "test-runner", "Phase 6D · audited tests and reviewed draft application",
        );
      case "migrate":  return <MigratePanel key={keyVersion} onOpenFiles={openGeneratedSource} />;
      case "vision":   return <VisionPanel key={keyVersion} onOpenFiles={openGeneratedSource} />;
      case "live":     return <LiveSharePanel />;
      case "explorer": return <ExplorerPanel onAgentMode={() => navigate("builder")} />;
      case "terminal": return hasNativeCapability(runtime, "pty")
        ? <Suspense fallback={<NativePanelLoading label="Loading native terminal…" />}>
          <TerminalPanel onOpenWorkspace={() => navigate("editor")} />
        </Suspense>
        : nativeFeature(
          "Integrated Terminal", "pty", "Phase 3 · native PTY sessions",
        );
      case "git":      return hasNativeCapability(runtime, "git")
        ? <Suspense fallback={<NativePanelLoading label="Loading native source control…" />}>
          <GitPanel onOpenWorkspace={() => navigate("editor")} />
        </Suspense>
        : nativeFeature(
          "Source Control", "git", "Phase 4 · real repository operations and OS-protected credentials",
        );
      case "cicd":     return nativeFeature(
        "CI / CD Pipelines", "ci", "Phase 6 · real workflow provider and run status integration",
      );
      case "deploy":   return nativeFeature(
        "Deployment", "deploy", "Phase 6 · approved native deployment commands",
      );
      case "database": return hasNativeCapability(runtime, "database")
        ? <Suspense fallback={<NativePanelLoading label="Loading native database integration…" />}>
          <DatabasePanel onOpenWorkspace={() => navigate("editor")} />
        </Suspense>
        : nativeFeature(
          "Database Client", "database", "Phase 5B.2d · bounded PostgreSQL reads and confirmed writes",
        );
      case "api":      return hasNativeCapability(runtime, "native-http")
        ? <Suspense fallback={<NativePanelLoading label="Loading native API client…" />}>
          <ApiPanel />
        </Suspense>
        : nativeFeature(
          "API Client", "native-http", "Phase 5C · native HTTP client without browser CORS limits",
        );
      case "docker":   return hasNativeCapability(runtime, "docker")
        ? <Suspense fallback={<NativePanelLoading label="Loading native Docker integration…" />}>
          <DockerPanel />
        </Suspense>
        : nativeFeature(
          "Docker & Containers", "docker", "Phase 5A.1 · Docker engine and safe creation",
        );
      case "preview":  return <PreviewPanel />;
      case "tools":    return hasNativeCapability(runtime, "toolchain")
        ? <Suspense fallback={<NativePanelLoading label="Loading native toolchain detection…" />}>
          <ToolsPanel />
        </Suspense>
        : nativeFeature(
          "Toolchain", "toolchain", "Phase 6V · read-only native local tool detection",
        );
      case "setup":    return <SetupPanel />;
      case "settings": return (
        <SettingsPanel key={keyVersion} onKeyChange={refreshKey} onSettingsChange={refreshSettings} />
      );
      default: return null;
    }
  }

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden text-zinc-100 selection:bg-cyan-500/30"
      style={{ background: theme.bg }}
    >
      {/* Title bar */}
      <header
        className="flex h-10 shrink-0 items-center justify-between border-b border-white/5 px-4"
        style={{ background: theme.panel }}
      >
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5">
            <span className="h-3 w-3 rounded-full bg-[#ff5f57] ring-1 ring-inset ring-black/10" />
            <span className="h-3 w-3 rounded-full bg-[#febc2e] ring-1 ring-inset ring-black/10" />
            <span className="h-3 w-3 rounded-full bg-[#28c840] ring-1 ring-inset ring-black/10" />
          </div>
          <div className="ml-1 flex items-center gap-2 text-[13px] font-medium text-zinc-300">
            <span
              className="rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white"
              style={{ background: `linear-gradient(135deg, ${theme.accent}, ${theme.accent2})` }}
            >
              DL
            </span>
            <span>DevLab</span>
            <span className="text-zinc-600">·</span>
            <span className="font-normal text-zinc-500">developer control plane</span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-[12px] text-zinc-500">
          <span
            className="flex items-center gap-1.5"
            title={runtime.runtime === "tauri"
              ? `Trusted native runtime · ${runtime.os}/${runtime.arch} · v${runtime.appVersion}`
              : "Browser UI preview · native tools are unavailable"}
          >
            <span className={`h-2 w-2 rounded-full ${runtime.runtime === "tauri" ? "bg-cyan-400" : "bg-amber-400"}`} />
            <span className={runtime.runtime === "tauri" ? "text-cyan-300" : "text-amber-300"}>
              {runtime.runtime === "tauri" ? `Native · ${runtime.os}` : "Web preview"}
            </span>
          </span>
          {aiRoute.status !== "active" ? (
            <span className="flex items-center gap-1.5" title={aiRoute.reason}>
              <Circle className="h-3 w-3 text-amber-400" />
              <span className="text-amber-300">{aiRoute.providerName} future</span>
              <span className="font-mono text-zinc-600">{aiRoute.modelLabel}</span>
            </span>
          ) : hasKey ? (
            <span className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              <span className="text-zinc-400">{aiRoute.providerName}</span>
              <span className="font-mono text-zinc-600">{aiRoute.modelLabel}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Circle className="h-3 w-3 text-amber-400" />
              <span className="text-amber-300">No API key</span>
            </span>
          )}
          <span className="hidden font-mono tabular-nums md:inline">{time}</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Activity bar */}
        <nav
          className="flex w-14 shrink-0 flex-col items-center justify-between overflow-y-auto border-r border-white/5 py-3"
          style={{ background: theme.panel }}
        >
          <div className="flex flex-col items-center gap-0.5">
            {nav.map((n) => (
              <NavButton key={n.id} item={n} active={view === n.id}
                accent={theme.accent} tooltips={settings.showTooltips}
                onClick={() => navigate(n.id)} />
            ))}
          </div>
          <NavButton
            item={{ id: "settings", icon: SettingsIcon, label: "Settings", shortcut: "⌘," }}
            active={view === "settings"} accent={theme.accent} tooltips={settings.showTooltips}
            onClick={() => navigate("settings")}
          />
        </nav>

        <main className="min-w-0 flex-1 overflow-hidden" style={{ background: theme.bg }}>
          {render()}
        </main>
      </div>

      {/* Status bar */}
      {settings.showStatusBar && (
        <footer
          className="flex h-6 shrink-0 items-center justify-between border-t border-white/5 px-3 text-[11px] font-medium text-white"
          style={{ background: `linear-gradient(90deg, ${theme.accent}cc, ${theme.accent2}cc)` }}
        >
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3 w-3" /> Phase 8M task apply progress</span>
            <span className="hidden items-center gap-1.5 md:flex">
              <Zap className="h-3 w-3" />
              {runtime.runtime === "tauri" ? "Native core connected" : "Native tools off"}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden font-mono md:inline">{aiRoute.modelLabel}</span>
            <span className="font-mono">DevLab v{runtime.appVersion}</span>
          </div>
        </footer>
      )}

      {pendingRecovery && (
        <SessionRecoveryPrompt
          snapshot={pendingRecovery}
          onContinue={() => continueRecoveredSession(pendingRecovery)}
          onNewProject={() => startFresh("builder")}
          onOpenWorkspace={() => startFresh("editor")}
          onDismiss={() => startFresh("current")}
        />
      )}

      {showModal && !pendingRecovery && (
        <KeyModal
          onClose={() => setShowModal(false)}
          onSaved={() => { refreshKey(); setShowModal(false); navigate("agent"); }}
        />
      )}
    </div>
  );
}


function textBytes(value: string) {
  return new TextEncoder().encode(value).length;
}

function formatDraftStageError(error: unknown) {
  if (error && typeof error === "object") {
    const maybe = error as { code?: unknown; message?: unknown };
    if (typeof maybe.message === "string" && typeof maybe.code === "string") {
      return `${maybe.message} (${maybe.code})`;
    }
    if (typeof maybe.message === "string") return maybe.message;
  }
  return typeof error === "string" ? error : "The native agent-tools staging command failed.";
}

function SessionRecoveryPrompt({
  snapshot,
  onContinue,
  onNewProject,
  onOpenWorkspace,
  onDismiss,
}: {
  snapshot: SessionRecoverySnapshot;
  onContinue: () => void;
  onNewProject: () => void;
  onOpenWorkspace: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0d1017] p-6 shadow-2xl shadow-black/40 ring-soft">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-500/10 ring-1 ring-cyan-500/20">
            <Sparkles className="h-5 w-5 text-cyan-300" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-white">Continue your previous DevLab session?</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">
              DevLab found local browser recovery data from {new Date(snapshot.savedAt).toLocaleString()}:
              <span className="mt-1 block font-medium text-zinc-200">{sessionRecoverySummary(snapshot)}</span>
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3 text-[12px] leading-relaxed text-amber-100/80">
          This recovery data is stored only in this WebView's localStorage. It may include prompts,
          model replies and generated draft file contents. Choose Start fresh if that data should be cleared.
        </div>

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <button
            onClick={onContinue}
            className="rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 px-4 py-2.5 text-[13px] font-semibold text-white shadow-lg shadow-cyan-950/30 hover:from-cyan-400 hover:to-blue-500"
          >
            Continue where I left off
          </button>
          <button
            onClick={onNewProject}
            className="rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 py-2.5 text-[13px] font-semibold text-violet-100 hover:bg-violet-500/20"
          >
            Start a new project
          </button>
          <button
            onClick={onOpenWorkspace}
            className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-[13px] font-semibold text-zinc-200 hover:bg-white/[0.06]"
          >
            Open a workspace
          </button>
          <button
            onClick={onDismiss}
            className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-2.5 text-[13px] font-semibold text-rose-100 hover:bg-rose-500/20"
          >
            Clear saved progress
          </button>
        </div>
      </div>
    </div>
  );
}

function NativePanelLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-[12px] text-zinc-500">
      <TerminalIcon className="h-4 w-4 animate-pulse text-cyan-400" /> {label}
    </div>
  );
}

function GeneratedDraftReview({ drafts, onDismiss }: { drafts: VFile[]; onDismiss: () => void }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = drafts[selectedIndex] ?? drafts[0];

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-white/5 bg-[#0e1117]/60 px-6 py-3.5">
        <h2 className="text-sm font-semibold text-white">Generated Draft Review</h2>
        <p className="mt-0.5 text-[12px] text-zinc-500">
          In-memory source preview · native filesystem access is unavailable in this browser
        </p>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-white/5 bg-[#0d1017]/50">
          <div className="border-b border-violet-500/20 bg-violet-500/[0.07] p-4 text-[11.5px] leading-relaxed text-violet-100/80">
            Nothing was written to disk. Open DevLab with <span className="font-mono text-violet-200">npm run desktop:dev</span> to use a real scoped workspace.
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {drafts.map((draft, index) => (
              <button
                key={`${draft.path}-${index}`}
                onClick={() => setSelectedIndex(index)}
                className={`mb-1 w-full rounded-lg px-3 py-2 text-left font-mono text-[11px] transition ${
                  selected === draft
                    ? "bg-violet-500/15 text-violet-100"
                    : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
                }`}
              >
                {draft.path}
              </button>
            ))}
          </div>
          <div className="border-t border-white/5 p-3">
            <button onClick={onDismiss} className="w-full rounded-lg border border-rose-500/20 px-3 py-2 text-[11.5px] text-rose-300 hover:bg-rose-500/10">
              Dismiss all drafts
            </button>
          </div>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-white/5 px-4 py-3">
            <div className="truncate font-mono text-[12px] text-zinc-200">{selected?.path}</div>
            <div className="mt-0.5 text-[10.5px] text-zinc-600">{selected?.language} · generated preview</div>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-5 font-mono text-[11.5px] leading-relaxed text-zinc-300">
            {selected?.content}
          </pre>
        </section>
      </div>
    </div>
  );
}

function NativeFeaturePending({
  title, milestone, runtime, backendEnabled,
}: {
  title: string;
  milestone: string;
  runtime: RuntimeInfo;
  backendEnabled: boolean;
}) {
  const native = runtime.runtime === "tauri";
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-white/5 bg-[#0e1117]/60 px-6 py-3.5">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        <p className="mt-0.5 text-[12px] text-zinc-500">Native implementation required</p>
      </div>
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-lg rounded-2xl border border-amber-500/20 bg-amber-500/[0.05] p-7 text-center ring-soft">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/10 ring-1 ring-amber-500/20">
            <Wrench className="h-6 w-6 text-amber-300" />
          </div>
          <h3 className="mt-4 text-lg font-semibold text-white">Simulation removed</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-zinc-400">
            {backendEnabled
              ? "The backend advertises this capability, but no verified renderer is connected yet. DevLab keeps the feature closed rather than loading its retired simulation."
              : native
                ? "The trusted Tauri runtime is connected, but this capability is disabled until its real native backend is complete. DevLab will not show fabricated data or pretend an operation succeeded."
                : "This is the browser UI preview. Native operating-system capabilities are unavailable here, and DevLab will not replace them with simulated results."}
          </p>
          <div className="mt-5 rounded-lg border border-white/10 bg-black/20 px-4 py-3 text-left">
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">Planned milestone</div>
            <div className="mt-1 text-[13px] font-medium text-amber-200">{milestone}</div>
          </div>
          {!native && (
            <p className="mt-4 font-mono text-[11.5px] text-cyan-300">npm run desktop:dev</p>
          )}
        </div>
      </div>
    </div>
  );
}

function NavButton({
  item, active, onClick, accent, tooltips,
}: {
  item: NavItem; active: boolean; onClick: () => void; accent: string; tooltips: boolean;
}) {
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      aria-label={item.label}
      className={cn(
        "group relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition",
        active ? "bg-white/[0.07]" : "hover:bg-white/[0.04]",
      )}
    >
      {active && (
        <span className="absolute -left-2 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full"
          style={{ background: accent }} />
      )}
      <Icon
        className={cn("h-[18px] w-[18px] transition", active ? "text-white" : "text-zinc-500 group-hover:text-zinc-200")}
      />
      {tooltips && (
        <span className="pointer-events-none absolute left-14 z-50 flex items-center gap-2 whitespace-nowrap rounded-md border border-white/10 bg-[#1a1f2b] px-2.5 py-1.5 text-[11px] font-medium text-zinc-200 opacity-0 shadow-2xl transition group-hover:opacity-100">
          {item.label}
          {item.shortcut && (
            <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">{item.shortcut}</kbd>
          )}
        </span>
      )}
    </button>
  );
}
