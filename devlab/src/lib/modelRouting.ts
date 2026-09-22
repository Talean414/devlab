import { isTauri } from "@tauri-apps/api/core";
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
// Whether the native runtime is hosting the renderer. Providers whose transport is Rust-owned
// (Ollama) are active only when this is true; the plain Vite preview never calls them.
const NATIVE_RUNTIME = typeof window !== "undefined" && isTauri();

export interface AiProviderProfile {
  id: AiProviderId;
  name: string;
  shortName: string;
  statusLabel: "Available" | "Available in native DevLab" | "Future native adapter" | "Future local adapter";
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
    statusLabel: "Available in native DevLab",
    availableNow: NATIVE_RUNTIME,
    credentialStorage: "OS credential store entry written through Rust; never returned to the WebView",
    transport: "Rust-owned HTTPS adapter to the fixed host api.deepseek.com (bounded prompt and reply, 120 s non-streamed bound)",
    defaultModel: "deepseek-chat",
    modelExamples: ["deepseek-chat", "deepseek-reasoner"],
    note: "Phase 9B native adapter. Requires an API key stored in Settings → Providers; unavailable in the plain web preview.",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    shortName: "Ollama",
    statusLabel: "Available in native DevLab",
    availableNow: NATIVE_RUNTIME,
    credentialStorage: "No credential; loopback endpoint and model id are non-secret settings",
    transport: "Rust-owned loopback-only HTTP adapter (fixed /api/tags and /api/chat paths, bounded prompt and reply, 120 s generation timeout)",
    defaultModel: "llama3.1",
    modelExamples: ["llama3.1", "qwen2.5-coder", "deepseek-r1"],
    note: "Phase 9A native local adapter. Only http://localhost or 127.0.0.1/::1 endpoints are accepted, the WebView never calls localhost itself, and generation is non-streamed. Unavailable in the plain web preview.",
  },
  {
    id: "openai",
    name: "OpenAI",
    shortName: "OpenAI",
    statusLabel: "Available in native DevLab",
    availableNow: NATIVE_RUNTIME,
    credentialStorage: "OS credential store entry written through Rust; never returned to the WebView",
    transport: "Rust-owned HTTPS adapter to the fixed host api.openai.com (bounded prompt and reply, 120 s non-streamed bound)",
    defaultModel: "gpt-4.1-mini",
    modelExamples: ["gpt-4.1", "gpt-4.1-mini"],
    note: "Phase 9B native adapter. Requires an API key stored in Settings → Providers; unavailable in the plain web preview.",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    shortName: "Claude",
    statusLabel: "Available in native DevLab",
    availableNow: NATIVE_RUNTIME,
    credentialStorage: "OS credential store entry written through Rust; never returned to the WebView",
    transport: "Rust-owned HTTPS adapter to the fixed host api.anthropic.com (bounded prompt and reply, 120 s non-streamed bound)",
    defaultModel: "claude-sonnet-4-5",
    modelExamples: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    note: "Phase 9B native adapter. Requires an API key stored in Settings → Providers; unavailable in the plain web preview.",
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
    const reason = provider.id === "ollama" || provider.id === "deepseek" || provider.id === "openai" || provider.id === "anthropic"
      ? `${provider.name} routing is configured for ${task.label.toLowerCase()}, but its native adapter is only available inside the DevLab desktop app, not the web preview. No request was sent.`
      : `${provider.name} routing is configured for ${task.label.toLowerCase()}, but this provider is a future phase. DevLab has not enabled its native credential store and bounded transport yet, so no request was sent. Switch Settings → Providers back to Gemini for current AI generation.`;
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
      reason,
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
    reason: provider.id === "ollama"
      ? `Routing ${task.label.toLowerCase()} to the local Ollama model "${modelLabel}" through the native loopback adapter; no cloud request is made and there is no fallback to Gemini.`
      : provider.id === "deepseek" || provider.id === "openai" || provider.id === "anthropic"
        ? `Routing ${task.label.toLowerCase()} to ${provider.shortName} model "${modelLabel}" through the native HTTPS adapter; the key stays in the OS credential store and there is no fallback to Gemini.`
        : settings.modelRouting === "fixed"
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

export function generationGuardrailInstruction(taskId: AiTaskKind): string {
  const task = getTaskProfile(taskId);
  const shared = [
    "DevLab generation guardrails: generated files are review drafts only; do not claim they were written, installed, tested, deployed or executed.",
    "Keep secrets, tokens, credentials and environment-specific values out of generated files and examples unless the user explicitly supplies non-secret placeholders.",
    "Prefer small single-responsibility files, strict TypeScript interfaces where TypeScript is used, clear module boundaries and accessible semantic HTML for UI work.",
  ];

  switch (task.routeClass) {
    case "implementation":
      return [
        ...shared,
        "Frontend implementation defaults: modern responsive layouts, Tailwind-friendly class structure when Tailwind is in the requested stack, subtle elevation/glass effects, keyboard/focus states and mobile-first spacing.",
        "Use Lucide icons, Framer Motion, TanStack Query, Zustand or other libraries only when the project already includes them or the generated plan/commands explicitly add them; otherwise avoid surprise dependencies.",
        "Output complete file contents for the requested safe workspace-relative path and keep component files focused enough to review in DevLab's explicit editor gate.",
      ].join("\n");
    case "vision":
      return [
        ...shared,
        "UI reverse-engineering defaults: derive palette, typography, spacing, layout and component hierarchy from observable evidence before drafting files.",
        "When producing React/Tailwind drafts, preserve responsive behavior, accessible labels, loading/empty states and visual hierarchy instead of generic placeholder screens.",
        "Do not invent external assets, paid services or unavailable dependencies; use local placeholders or CSS/SVG only when the source evidence is ambiguous.",
      ].join("\n");
    case "reasoning":
      return [
        ...shared,
        "Planning defaults: prefer reviewable task slices, changed-file plans, out-of-scope notes, risk notes and explicit verification suggestions without implying any command has run.",
        "For frontend plans, include design-system tokens, component boundaries, accessibility expectations and dependency assumptions so generated drafts stay coherent.",
      ].join("\n");
    case "diagnostic":
      return [
        ...shared,
        "Repair defaults: keep patches minimal, explain regression risk, preserve existing style and suggest verification profiles to run explicitly after reviewed apply.",
      ].join("\n");
    default:
      return shared.join("\n");
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
    case "openai":
      return settings.openaiModel || getProviderProfile(provider).defaultModel;
    case "anthropic":
      return settings.anthropicModel || getProviderProfile(provider).defaultModel;
    case "ollama":
      return settings.ollamaModel || getProviderProfile(provider).defaultModel;
    case "custom":
      return settings.customModel || getProviderProfile(provider).defaultModel;
  }
}
