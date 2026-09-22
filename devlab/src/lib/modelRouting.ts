import { loadSettings, type AiProviderId, type DevLabSettings } from "./settings";

export type AiTaskKind =
  | "chat"
  | "planning"
  | "coding"
  | "repair"
  | "vision"
  | "migration"
  | "architecture";

export type AiRouteClass = "general" | "reasoning" | "implementation" | "diagnostic" | "vision";
export type AiRouteStatus = "active" | "unavailable";

export interface AiProviderProfile {
  id: AiProviderId;
  name: string;
  shortName: string;
  statusLabel: "Available" | "Future native adapter" | "Future local adapter";
  availableNow: boolean;
  credentialStorage: string;
  transport: string;
  defaultModel: string;
  modelExamples: string[];
  note: string;
}

export interface AiTaskProfile {
  id: AiTaskKind;
  label: string;
  routeClass: AiRouteClass;
  description: string;
}

export interface AiRouteSelection {
  selectedModel: string;
  pickedModel?: string | null;
}

export interface AiRoute {
  task: AiTaskKind;
  taskLabel: string;
  routeClass: AiRouteClass;
  provider: AiProviderId;
  providerName: string;
  model: string;
  modelLabel: string;
  status: AiRouteStatus;
  availableNow: boolean;
  credentialStorage: string;
  transport: string;
  reason: string;
}

export const AI_TASK_PROFILES: AiTaskProfile[] = [
  {
    id: "chat",
    label: "General chat",
    routeClass: "general",
    description: "Explanations, Q&A and lightweight coding guidance.",
  },
  {
    id: "planning",
    label: "Spec planning",
    routeClass: "reasoning",
    description: "Architecture planning, task decomposition and implementation strategy.",
  },
  {
    id: "architecture",
    label: "Architecture",
    routeClass: "reasoning",
    description: "System design, repo structure and component/API boundaries.",
  },
  {
    id: "coding",
    label: "Implementation",
    routeClass: "implementation",
    description: "Complete file drafts, templates and generated source changes.",
  },
  {
    id: "repair",
    label: "Repair loop",
    routeClass: "diagnostic",
    description: "Failing-test analysis and small reviewed repair drafts.",
  },
  {
    id: "migration",
    label: "Migration",
    routeClass: "reasoning",
    description: "Database/schema migration planning and reviewed SQL/application drafts.",
  },
  {
    id: "vision",
    label: "Vision/reverse engineering",
    routeClass: "vision",
    description: "Screenshot, UI reconstruction and design-to-code interpretation.",
  },
];

export const AI_PROVIDER_PROFILES: AiProviderProfile[] = [
  {
    id: "gemini",
    name: "Google Gemini",
    shortName: "Gemini",
    statusLabel: "Available",
    availableNow: true,
    credentialStorage: "WebView localStorage under devlab.gemini.key",
    transport: "Renderer fetch to Google's official Generative Language API",
    defaultModel: "gemini-3.5-flash-lite",
    modelExamples: ["gemini-3.5-flash-lite", "gemini-2.5-flash", "models returned by Google"],
    note: "Current runtime provider. DevLab lists live Google models and falls back across bounded Gemini candidates.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    shortName: "DeepSeek",
    statusLabel: "Future native adapter",
    availableNow: false,
    credentialStorage: "Planned OS credential store entry, never renderer-readable",
    transport: "Planned Rust-owned HTTPS provider adapter",
    defaultModel: "deepseek-chat",
    modelExamples: ["deepseek-chat", "deepseek-reasoner"],
    note: "Roadmap provider for DeepSeek V3/R1 style routing. It is intentionally unavailable until native credential storage and bounded transport exist.",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    shortName: "Ollama",
    statusLabel: "Future local adapter",
    availableNow: false,
    credentialStorage: "No cloud key; planned local endpoint profile only",
    transport: "Planned bounded localhost/native adapter with model health checks",
    defaultModel: "llama3.1",
    modelExamples: ["llama3.1", "qwen2.5-coder", "deepseek-r1"],
    note: "Roadmap local-model provider. DevLab does not call localhost from browser-facing code or assume a model is installed yet.",
  },
  {
    id: "openai",
    name: "OpenAI",
    shortName: "OpenAI",
    statusLabel: "Future native adapter",
    availableNow: false,
    credentialStorage: "Planned OS credential store entry, never renderer-readable",
    transport: "Planned Rust-owned HTTPS provider adapter",
    defaultModel: "gpt-4.1-mini",
    modelExamples: ["gpt-4.1", "gpt-4.1-mini"],
    note: "Future external provider profile. Selecting it records non-secret preferences only.",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    shortName: "Claude",
    statusLabel: "Future native adapter",
    availableNow: false,
    credentialStorage: "Planned OS credential store entry, never renderer-readable",
    transport: "Planned Rust-owned HTTPS provider adapter",
    defaultModel: "claude-sonnet-4-5",
    modelExamples: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    note: "Future external provider profile. Selecting it records non-secret preferences only.",
  },
  {
    id: "custom",
    name: "Custom OpenAI-compatible endpoint",
    shortName: "Custom",
    statusLabel: "Future native adapter",
    availableNow: false,
    credentialStorage: "Planned OS credential store entry when credentials are required",
    transport: "Planned bounded native HTTP adapter with explicit host policy",
    defaultModel: "",
    modelExamples: ["provider-specific model id"],
    note: "Future advanced profile. Endpoint/model metadata is non-secret; arbitrary browser fetches are not enabled.",
  },
];

const PROFILE_BY_ID = new Map(AI_PROVIDER_PROFILES.map((profile) => [profile.id, profile]));
const TASK_BY_ID = new Map(AI_TASK_PROFILES.map((task) => [task.id, task]));

export function getProviderProfile(id: AiProviderId): AiProviderProfile {
  return PROFILE_BY_ID.get(id) ?? AI_PROVIDER_PROFILES[0];
}

export function getTaskProfile(id: AiTaskKind): AiTaskProfile {
  return TASK_BY_ID.get(id) ?? AI_TASK_PROFILES[0];
}

export function resolveAiRoute(
  taskId: AiTaskKind,
  selection: AiRouteSelection,
  settings: DevLabSettings = loadSettings(),
): AiRoute {
  const task = getTaskProfile(taskId);
  const provider = getProviderProfile(settings.aiProvider);
  const model = modelForProvider(provider.id, settings, selection);
  const modelLabel = model || provider.defaultModel || "not configured";

  if (!provider.availableNow) {
    return {
      task: task.id,
      taskLabel: task.label,
      routeClass: task.routeClass,
      provider: provider.id,
      providerName: provider.name,
      model,
      modelLabel,
      status: "unavailable",
      availableNow: false,
      credentialStorage: provider.credentialStorage,
      transport: provider.transport,
      reason: `${provider.name} routing is configured for ${task.label.toLowerCase()}, but this provider is a future phase. DevLab has not enabled its native credential store and bounded transport yet, so no request was sent. Switch Settings → Providers back to Gemini for current AI generation.`,
    };
  }

  return {
    task: task.id,
    taskLabel: task.label,
    routeClass: task.routeClass,
    provider: provider.id,
    providerName: provider.name,
    model,
    modelLabel,
    status: "active",
    availableNow: true,
    credentialStorage: provider.credentialStorage,
    transport: provider.transport,
    reason: settings.modelRouting === "fixed"
      ? `Using the selected ${provider.shortName} model for ${task.label.toLowerCase()}.`
      : `Routing ${task.label.toLowerCase()} through ${provider.shortName}; Gemini fallback candidates are ordered for this task class when live model metadata is available.`,
  };
}

export function describeAiRoute(route: AiRoute): string {
  const status = route.status === "active" ? "active" : "future";
  return `${route.providerName} · ${route.modelLabel} · ${route.taskLabel} route (${status})`;
}

export function routeInstruction(taskId: AiTaskKind): string {
  const task = getTaskProfile(taskId);
  switch (task.routeClass) {
    case "reasoning":
      return "Task route: reasoning/planning. Prefer concise architecture trade-offs, assumptions, ordered tasks and review checkpoints before code.";
    case "implementation":
      return "Task route: implementation. Prefer complete, reviewable file drafts with explicit safe file paths when generating code; do not claim files were written.";
    case "diagnostic":
      return "Task route: diagnostic repair. Focus on the failing evidence, smallest safe patch, regression risk and verification command to run next.";
    case "vision":
      return "Task route: vision/reverse engineering. Describe observable UI evidence first, then produce bounded implementation guidance or file drafts when asked.";
    default:
      return "Task route: general chat. Be concise, practical and clear about what has or has not been executed.";
  }
}

function modelForProvider(
  provider: AiProviderId,
  settings: DevLabSettings,
  selection: AiRouteSelection,
): string {
  switch (provider) {
    case "gemini":
      return settings.modelRouting === "fixed"
        ? selection.selectedModel
        : (selection.pickedModel || selection.selectedModel);
    case "deepseek":
      return settings.deepseekModel || getProviderProfile(provider).defaultModel;
    case "ollama":
      return settings.ollamaModel || getProviderProfile(provider).defaultModel;
    case "custom":
      return settings.customModel || getProviderProfile(provider).defaultModel;
    case "openai":
    case "anthropic":
      return getProviderProfile(provider).defaultModel;
  }
}
