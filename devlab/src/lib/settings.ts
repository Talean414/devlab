import type { ViewId } from "../types";

export type ThemeId = "midnight" | "carbon" | "nord" | "dracula" | "solarized" | "highcontrast";

export interface Theme {
  id: ThemeId;
  name: string;
  bg: string;       // app background
  panel: string;    // panel background
  border: string;
  accent: string;   // primary accent (hex)
  accent2: string;  // secondary accent
  text: string;
  muted: string;
  editor: string;   // monaco theme
}

export const THEMES: Theme[] = [
  { id: "midnight",     name: "Midnight",      bg: "#0b0d12", panel: "#0e1117", border: "#ffffff14", accent: "#22d3ee", accent2: "#a78bfa", text: "#f4f4f5", muted: "#71717a", editor: "vs-dark" },
  { id: "carbon",       name: "Carbon",        bg: "#0d0d0d", panel: "#151515", border: "#ffffff12", accent: "#f97316", accent2: "#fbbf24", text: "#fafafa", muted: "#737373", editor: "vs-dark" },
  { id: "nord",         name: "Nord",          bg: "#2e3440", panel: "#3b4252", border: "#ffffff14", accent: "#88c0d0", accent2: "#81a1c1", text: "#eceff4", muted: "#8b95a7", editor: "vs-dark" },
  { id: "dracula",      name: "Dracula",       bg: "#282a36", panel: "#343746", border: "#ffffff14", accent: "#bd93f9", accent2: "#ff79c6", text: "#f8f8f2", muted: "#8b8fa3", editor: "vs-dark" },
  { id: "solarized",    name: "Solarized Dark",bg: "#002b36", panel: "#073642", border: "#ffffff14", accent: "#2aa198", accent2: "#b58900", text: "#eee8d5", muted: "#7c99a3", editor: "vs-dark" },
  { id: "highcontrast", name: "High Contrast", bg: "#000000", panel: "#0a0a0a", border: "#ffffff30", accent: "#00ffff", accent2: "#ffff00", text: "#ffffff", muted: "#a1a1aa", editor: "hc-black" },
];

export type Density = "comfortable" | "compact";
export type Autonomy = "ask" | "suggest" | "auto";
export type AiProviderId = "gemini" | "deepseek" | "openai" | "anthropic" | "ollama" | "custom";
export type ModelRoutingMode = "auto" | "fixed";

/** Phase 9G: an explicit provider (and optional model) for one task class; absent = global provider. */
export interface TaskProviderOverride {
  provider: AiProviderId;
  /** Empty = the provider's configured/default model. */
  model?: string;
}
export type TaskProviderOverrides = Partial<Record<
  "chat" | "planning" | "coding" | "repair" | "vision" | "migration" | "architecture",
  TaskProviderOverride
>>;

/** What DevLab does when saved session-recovery data is found at launch. */
export type SessionRecoveryPreference = "ask" | "continue" | "discard";

export interface DevLabSettings {
  theme: ThemeId;
  density: Density;
  /** panels the user wants visible in the activity bar */
  visiblePanels: ViewId[];
  autonomy: Autonomy;
  /** agent is allowed to perform these actions */
  allowWriteFiles: boolean;
  allowRunCommands: boolean;
  allowGitCommit: boolean;
  allowGitPush: boolean;
  allowDeploy: boolean;
  showWelcomeOnStart: boolean;
  /** Launch behavior when previous-session recovery data exists. */
  recoveryPreference: SessionRecoveryPreference;
  showStatusBar: boolean;
  showTooltips: boolean;
  fontSize: number;
  /** provider config */
  aiProvider: AiProviderId;
  modelRouting: ModelRoutingMode;
  deepseekModel: string;
  openaiModel: string;
  anthropicModel: string;
  ollamaModel: string;
  /** Local embedding model used by semantic workspace search (Ollama, loopback only). */
  ollamaEmbedModel: string;
  /** Stream native adapter replies incrementally (Ollama, cloud providers, custom endpoint). */
  streamReplies: boolean;
  customModel: string;
  customEndpoint: string;
  /** Per-task provider overrides (non-secret metadata). Missing tasks follow `aiProvider`. */
  taskProviders: TaskProviderOverrides;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
}

export const ALL_PANELS: { id: ViewId; label: string; core?: boolean }[] = [
  { id: "welcome",  label: "Home", core: true },
  { id: "agent",    label: "AI Agent", core: true },
  { id: "builder",  label: "Project Builder" },
  { id: "canvas",   label: "Architecture Canvas" },
  { id: "editor",   label: "Code Editor" },
  { id: "healer",   label: "Self-Healing Tests" },
  { id: "migrate",  label: "DB Migrations" },
  { id: "vision",   label: "Reverse Engineer" },
  { id: "live",     label: "Live Share" },
  { id: "explorer", label: "Templates" },
  { id: "terminal", label: "Terminal" },
  { id: "git",      label: "Source Control" },
  { id: "cicd",     label: "CI / CD" },
  { id: "deploy",   label: "Deploy" },
  { id: "database", label: "Database" },
  { id: "api",      label: "API Client" },
  { id: "docker",   label: "Containers" },
  { id: "preview",  label: "Live Preview" },
  { id: "tools",    label: "Toolchain" },
  { id: "setup",    label: "Local Setup" },
];

/** Onboarding and docs surfaces: resuming a session into one of these is not a work context. */
const LANDING_VIEWS: ViewId[] = ["welcome", "setup"];

/** Panel to restore when resuming a session: landing surfaces clamp to the AI Agent,
 * and a resumed panel the sidebar currently hides falls back to the AI Agent as well. */
export function resumeViewFor(view: ViewId, visiblePanels: ViewId[]): ViewId {
  const candidate = LANDING_VIEWS.includes(view) ? "agent" : view;
  return visiblePanels.includes(candidate) ? candidate : "agent";
}

export const DEFAULT_SETTINGS: DevLabSettings = {
  theme: "midnight",
  density: "comfortable",
  visiblePanels: ALL_PANELS.map((p) => p.id),
  autonomy: "suggest",
  allowWriteFiles: true,
  allowRunCommands: false,
  allowGitCommit: true,
  allowGitPush: false,
  allowDeploy: false,
  showWelcomeOnStart: false,
  recoveryPreference: "ask",
  showStatusBar: true,
  showTooltips: true,
  fontSize: 14,
  aiProvider: "gemini",
  modelRouting: "auto",
  deepseekModel: "deepseek-chat",
  openaiModel: "gpt-4.1-mini",
  anthropicModel: "claude-sonnet-4-5",
  ollamaModel: "llama3.1",
  ollamaEmbedModel: "nomic-embed-text",
  streamReplies: true,
  customModel: "",
  customEndpoint: "",
  taskProviders: {},
  temperature: 0.7,
  maxTokens: 4096,
  systemPrompt: "",
};

const KEY = "devlab.settings.v1";
// Written into the stored blob once one-time settings migrations have run, so each fires exactly once.
const MIGRATION_KEY = "settingsMigration";
const CURRENT_MIGRATION = 2;

/** Pure, storage-free migration of a previously persisted settings blob toward current defaults. */
export function migrateSettings(parsed: Record<string, unknown>): Record<string, unknown> {
  const done = parsed[MIGRATION_KEY];
  if (typeof done === "number" && done >= CURRENT_MIGRATION) return parsed;
  // v1 -> v2: DevLab no longer forces the Home page on every launch for existing installs.
  // Anyone who wants it re-enables it in Settings > Interface ("Open Home on start").
  return { ...parsed, showWelcomeOnStart: false, [MIGRATION_KEY]: CURRENT_MIGRATION };
}

export function loadSettings(): DevLabSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const migrated = migrateSettings(JSON.parse(raw) as Record<string, unknown>);
    return { ...DEFAULT_SETTINGS, ...migrated } as DevLabSettings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: DevLabSettings) {
  localStorage.setItem(KEY, JSON.stringify(s));
  applyTheme(s);
}

export function getTheme(id: ThemeId): Theme {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

/** Writes CSS custom properties onto :root so the whole app re-skins. */
export function applyTheme(s: DevLabSettings) {
  const t = getTheme(s.theme);
  const r = document.documentElement;
  r.style.setProperty("--dl-bg", t.bg);
  r.style.setProperty("--dl-panel", t.panel);
  r.style.setProperty("--dl-border", t.border);
  r.style.setProperty("--dl-accent", t.accent);
  r.style.setProperty("--dl-accent2", t.accent2);
  r.style.setProperty("--dl-text", t.text);
  r.style.setProperty("--dl-muted", t.muted);
  r.style.setProperty("--dl-font-size", `${s.fontSize}px`);
  r.style.setProperty("--dl-gap", s.density === "compact" ? "0.5rem" : "0.875rem");
}

// ── Source-control presentation preferences ──
// Secrets never belong in this browser-readable settings record. loadGit also
// sanitizes the retired v1 shape so an old plaintext token is removed on use.
export interface GitConfig {
  commitStyle: "conventional" | "plain";
}

export const DEFAULT_GIT: GitConfig = {
  commitStyle: "conventional",
};

const GKEY = "devlab.git.v1";

export function loadGit(): GitConfig {
  try {
    const raw = localStorage.getItem(GKEY);
    if (!raw) return { ...DEFAULT_GIT };
    const legacy = JSON.parse(raw) as Record<string, unknown>;
    const config: GitConfig = {
      commitStyle: legacy.commitStyle === "plain" ? "plain" : "conventional",
    };
    // Rewrite the allowlisted shape, dropping legacy token/owner/repository data.
    localStorage.setItem(GKEY, JSON.stringify(config));
    return config;
  } catch {
    return { ...DEFAULT_GIT };
  }
}
export function saveGit(g: GitConfig) {
  localStorage.setItem(GKEY, JSON.stringify({ commitStyle: g.commitStyle }));
}

// ── Deployment preferences ──
// Native deployment is disabled and the Deploy panel is authoring-only. The
// non-secret default provider id is the only value persisted; legacy browser
// tokens found under this key are discarded on load and never read back,
// until a protected native credential path exists for deployment credentials.
export interface DeployConfig {
  defaultProvider: string;
}

export const DEFAULT_DEPLOY: DeployConfig = { defaultProvider: "vercel" };

const DKEY = "devlab.deploy.v1";
export function loadDeploy(): DeployConfig {
  try {
    const raw = localStorage.getItem(DKEY);
    const legacy = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const config = {
      ...DEFAULT_DEPLOY,
      defaultProvider: typeof legacy.defaultProvider === "string"
        ? legacy.defaultProvider
        : DEFAULT_DEPLOY.defaultProvider,
    };
    localStorage.setItem(DKEY, JSON.stringify({ defaultProvider: config.defaultProvider }));
    return config;
  } catch { return { ...DEFAULT_DEPLOY }; }
}
export function saveDeploy(d: DeployConfig) {
  localStorage.setItem(DKEY, JSON.stringify({ defaultProvider: d.defaultProvider }));
}
