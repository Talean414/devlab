// Phase 9U — metadata-only, per-task-class model suggestions for Settings → Providers → task router.
//
// These suggestions are derived purely from the Phase 9P Ollama health response
// (installed models, capabilities, context windows, embedding sizes, loaded
// state) plus the current routing metadata. They never switch providers or
// models, never persist, never trigger network calls and never run anything:
// applying a suggestion is always the user's own explicit action through the
// existing per-task provider/model override controls.
//
// Scoring is deterministic and transparent. Each task class weighs two signals
// differently (see CLASS_WEIGHTS): the effective context window (the smallest
// of the trained maximum, the Modelfile num_ctx cap and the running instance's
// value) and the model's parameter size. Chat additionally rewards snappier
// (smaller) models; reasoning and implementation reward depth. A small bonus
// goes to models already loaded in VRAM. Ties break on the model name so the
// order is stable across renders.

import type { AiRouteClass, AiTaskKind } from "./modelRouting";
import { formatTokens, sameOllamaModel, type OllamaHealthResponse, type OllamaModelHealth } from "./ollama";

export const MAX_SUGGESTED_MODELS_PER_TASK = 3;
const CONTEXT_SATURATION_TOKENS = 32_768;
const CAPACITY_SATURATION_PARAMS = 8_000_000_000;
const LOADED_BONUS = 0.05;
const UNKNOWN_SIGNAL = 0.3;

export interface TaskModelSuggestion {
  model: string;
  /** 0..1 transparency score used for ordering. */
  score: number;
  /** Effective context window used for scoring (null when not reported). */
  contextTokens: number | null;
  reasons: string[];
  /** True when this model is the one currently effective for the task via Ollama. */
  matchesCurrent: boolean;
}

export interface TaskClassRecommendation {
  task: AiTaskKind;
  taskLabel: string;
  /** The provider this task class is recommended for ("gemini" = stay on Gemini). */
  provider: "ollama" | "gemini";
  headline: string;
  models: TaskModelSuggestion[];
  note: string | null;
}

interface TaskRecommendationInput {
  id: AiTaskKind;
  label: string;
  routeClass: AiRouteClass;
}

/** Class weights: [context, capacity, snappiness]. Vision is unused (Gemini-only). */
const CLASS_WEIGHTS: Record<AiRouteClass, { context: number; capacity: number; snappiness: number }> = {
  general: { context: 0.5, capacity: 0.2, snappiness: 0.3 },
  reasoning: { context: 0.6, capacity: 0.4, snappiness: 0 },
  implementation: { context: 0.55, capacity: 0.45, snappiness: 0 },
  diagnostic: { context: 0.5, capacity: 0.4, snappiness: 0.1 },
  vision: { context: 0, capacity: 0, snappiness: 0 },
};

/**
 * The context window a request can actually use: the minimum of the trained
 * maximum, the Modelfile num_ctx cap and the running instance's value — the
 * first restriction wins. Null when nothing is reported.
 */
export function effectiveContextTokens(model: OllamaModelHealth): number | null {
  const candidates = [model.contextLength, model.configuredContext, model.loadedContext].filter(
    (value): value is number => value !== null && value > 0,
  );
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/**
 * Whether a probed model can serve chat-class tasks. Models whose reported
 * capabilities lack "completion" (embedding-only models) are excluded; models
 * whose capabilities were not reported at all stay eligible but score their
 * capability signal as unknown.
 */
export function isChatCapable(model: OllamaModelHealth): boolean {
  if (!model.installed || model.error) return false;
  if (model.capabilities.length > 0 && !model.capabilities.includes("completion")) return false;
  return true;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function scoreModel(model: OllamaModelHealth, routeClass: AiRouteClass): { score: number; reasons: string[]; contextTokens: number | null } {
  const weights = CLASS_WEIGHTS[routeClass];
  const contextTokens = effectiveContextTokens(model);
  const contextScore = contextTokens === null ? UNKNOWN_SIGNAL : clamp01(contextTokens / CONTEXT_SATURATION_TOKENS);
  const capacityScore = model.parameterCount <= 0 ? UNKNOWN_SIGNAL : clamp01(model.parameterCount / CAPACITY_SATURATION_PARAMS);
  const snappinessScore = 1 - capacityScore;
  const score = Math.min(
    1,
    weights.context * contextScore
      + weights.capacity * capacityScore
      + weights.snappiness * snappinessScore
      + (model.loaded ? LOADED_BONUS : 0),
  );
  const reasons: string[] = [];
  if (contextTokens !== null) reasons.push(`${formatTokens(contextTokens)} context`);
  else reasons.push("context not reported");
  const sizeLabel = model.parameterSize || (model.parameterCount > 0 ? `${Math.round(model.parameterCount / 1_000_000)}M params` : "");
  if (sizeLabel) reasons.push(sizeLabel);
  if (model.loaded) reasons.push("loaded in VRAM");
  return { score, reasons, contextTokens };
}

/**
 * Suggest the best local Ollama models for one task class. `currentModel` is
 * the model currently effective for the task via Ollama (when the task is
 * routed there); matching suggestions are flagged, never applied.
 */
export function recommendTaskModels(
  health: OllamaHealthResponse,
  input: TaskRecommendationInput,
  currentModel: string,
): TaskModelSuggestion[] {
  if (input.routeClass === "vision") return [];
  const eligible = health.models.filter(isChatCapable);
  const ranked = eligible
    .map((model) => ({ model, ...scoreModel(model, input.routeClass) }))
    .sort((a, b) => b.score - a.score || a.model.name.localeCompare(b.model.name))
    .slice(0, MAX_SUGGESTED_MODELS_PER_TASK);
  return ranked.map(({ model, score, reasons, contextTokens }) => ({
    model: model.name,
    score,
    contextTokens,
    reasons,
    matchesCurrent: Boolean(currentModel) && sameOllamaModel(model.name, currentModel),
  }));
}

/**
 * Build the per-task-class recommendation list for the task router. Vision
 * always stays on Gemini because image input is wired there alone; every other
 * task class is suggested for local Ollama with its best-fit models.
 */
export function recommendTaskClasses(
  health: OllamaHealthResponse,
  tasks: TaskRecommendationInput[],
  currentOllamaModelByTask: Partial<Record<AiTaskKind, string>> = {},
): TaskClassRecommendation[] {
  return tasks.map((task) => {
    if (task.routeClass === "vision") {
      return {
        task: task.id,
        taskLabel: task.label,
        provider: "gemini",
        headline: "Stays on Gemini — image input is wired through Gemini alone; no local model can take this task.",
        models: [],
        note: null,
      };
    }
    const suggestions = recommendTaskModels(health, task, currentOllamaModelByTask[task.id] ?? "");
    const top = suggestions[0];
    if (suggestions.length === 0) {
      const reason = health.installed === 0
        ? "No models are installed on the local Ollama server."
        : health.models.some((model) => model.installed && !model.error)
          ? "No installed local model reports the completion capability needed for chat-class tasks."
          : "No local model could be probed (see the health check details above).";
      return {
        task: task.id,
        taskLabel: task.label,
        provider: "ollama",
        headline: reason,
        models: [],
        note: null,
      };
    }
    const headline = `Best local fit: ${top.model}${top.matchesCurrent ? " (your current model)" : ""} · ${top.reasons.join(" · ")}`;
    return {
      task: task.id,
      taskLabel: task.label,
      provider: "ollama",
      headline,
      models: suggestions,
      note: health.truncated
        ? `Based on the ${health.probed} probed model${health.probed === 1 ? "" : "s"} only (${health.truncationReason ?? "budget"}); unprobed models are not ranked.`
        : null,
    };
  });
}

/** One-line card summary, e.g. "4 of 6 local task classes have a suitable model". */
export function summarizeTaskRecommendations(recommendations: TaskClassRecommendation[]): string {
  const local = recommendations.filter((recommendation) => recommendation.provider === "ollama");
  const covered = local.filter((recommendation) => recommendation.models.length > 0).length;
  return `${covered} of ${local.length} local task classes have a suitable model`;
}
