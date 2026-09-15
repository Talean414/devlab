import { useEffect, useState } from "react";
import type { ViewId, VFile } from "./types";
import { getApiKey, getModel, getPicked, pickBestModel } from "./lib/gemini";
import { loadSettings, applyTheme, getTheme, type DevLabSettings } from "./lib/settings";
import { cn } from "./utils/cn";
import {
  Sparkles, FolderTree, Bot, Terminal as TerminalIcon, GitBranch, Rocket,
  Database, Plug, Container, Globe, Wrench, Settings as SettingsIcon,
  Circle, GitMerge, Zap, CheckCircle2, Wand2, Code2, UploadCloud, BookOpen,
  PenTool, Stethoscope, FileDiff, ScanLine, Radio,
} from "lucide-react";
import { KeyModal } from "./components/KeyModal";
import { WelcomePanel } from "./panels/WelcomePanel";
import { AgentPanel } from "./panels/AgentPanel";
import { BuilderPanel } from "./panels/BuilderPanel";
import { CanvasPanel } from "./panels/CanvasPanel";
import { EditorPanel } from "./panels/EditorPanel";
import { HealerPanel } from "./panels/HealerPanel";
import { MigratePanel } from "./panels/MigratePanel";
import { VisionPanel } from "./panels/VisionPanel";
import { LiveSharePanel } from "./panels/LiveSharePanel";
import { ExplorerPanel } from "./panels/ExplorerPanel";
import { TerminalPanel } from "./panels/TerminalPanel";
import { DatabasePanel } from "./panels/DatabasePanel";
import { ApiPanel } from "./panels/ApiPanel";
import { DockerPanel } from "./panels/DockerPanel";
import { GitPanel } from "./panels/GitPanel";
import { CicdPanel } from "./panels/CicdPanel";
import { DeployPanel } from "./panels/DeployPanel";
import { ToolsPanel } from "./panels/ToolsPanel";
import { PreviewPanel } from "./panels/PreviewPanel";
import { SetupPanel } from "./panels/SetupPanel";
import { SettingsPanel } from "./panels/SettingsPanel";

interface NavItem { id: ViewId; icon: typeof Sparkles; label: string; shortcut?: string }

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
  const [handoffFiles, setHandoffFiles] = useState<VFile[] | undefined>();

  const hasKey = !!getApiKey();
  const model = getPicked() || getModel();
  const theme = getTheme(settings.theme);

  useEffect(() => { applyTheme(settings); }, [settings]);

  useEffect(() => {
    if (!firstRun) {
      if (!getApiKey()) setShowModal(true);
      else pickBestModel();
      setFirstRun(true);
    }
  }, [firstRun]);

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
      if (t) { e.preventDefault(); setView(t); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const refreshKey = () => setKeyVersion((v) => v + 1);
  const refreshSettings = () => setSettings(loadSettings());

  const nav = NAV.filter((n) => settings.visiblePanels.includes(n.id));

  function render() {
    switch (view) {
      case "welcome":  return <WelcomePanel key={keyVersion} onNavigate={setView} hasKey={hasKey} />;
      case "agent":    return <AgentPanel key={keyVersion} onNeedKey={() => setShowModal(true)} />;
      case "builder":  return (
        <BuilderPanel
          key={keyVersion}
          onNeedKey={() => setShowModal(true)}
          onOpenFiles={(f) => { setHandoffFiles(f); setView("editor"); }}
        />
      );
      case "canvas":   return <CanvasPanel key={keyVersion} onOpenFiles={(f) => { setHandoffFiles(f); setView("editor"); }} />;
      case "editor":   return <EditorPanel incoming={handoffFiles} />;
      case "healer":   return <HealerPanel key={keyVersion} onOpenFiles={(f) => { setHandoffFiles(f); setView("editor"); }} />;
      case "migrate":  return <MigratePanel key={keyVersion} onOpenFiles={(f) => { setHandoffFiles(f); setView("editor"); }} />;
      case "vision":   return <VisionPanel key={keyVersion} onOpenFiles={(f) => { setHandoffFiles(f); setView("editor"); }} />;
      case "live":     return <LiveSharePanel />;
      case "explorer": return <ExplorerPanel onAgentMode={() => setView("builder")} />;
      case "terminal": return <TerminalPanel />;
      case "git":      return <GitPanel />;
      case "cicd":     return <CicdPanel />;
      case "deploy":   return <DeployPanel />;
      case "database": return <DatabasePanel />;
      case "api":      return <ApiPanel />;
      case "docker":   return <DockerPanel />;
      case "preview":  return <PreviewPanel />;
      case "tools":    return <ToolsPanel />;
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
          {hasKey ? (
            <span className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              <span className="text-zinc-400">Gemini</span>
              <span className="font-mono text-zinc-600">{model}</span>
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
                onClick={() => setView(n.id)} />
            ))}
          </div>
          <NavButton
            item={{ id: "settings", icon: SettingsIcon, label: "Settings", shortcut: "⌘," }}
            active={view === "settings"} accent={theme.accent} tooltips={settings.showTooltips}
            onClick={() => setView("settings")}
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
            <span className="flex items-center gap-1.5"><GitMerge className="h-3 w-3" /> main</span>
            <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3 w-3" /> Ready</span>
            <span className="hidden items-center gap-1.5 md:flex"><Zap className="h-3 w-3" /> Monaco · {settings.autonomy}</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden font-mono md:inline">{model}</span>
            <span className="font-mono">DevLab v1.1</span>
          </div>
        </footer>
      )}

      {showModal && (
        <KeyModal
          onClose={() => setShowModal(false)}
          onSaved={() => { refreshKey(); setShowModal(false); setView("agent"); }}
        />
      )}
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
