// Phase 9A — renderer client for the native, loopback-only Ollama adapter.
//
// The WebView never calls localhost itself: every request goes through the Rust `ollama_*`
// commands, which refuse non-loopback endpoints before opening a socket and bound prompts,
// models and responses. Nothing here persists state; the endpoint/model come from settings.

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { GenTurn } from "./gemini";

export const OLLAMA_DEFAULT_ENDPOINT = "http://127.0.0.1:11434";

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  family: string;
  parameterSize: string;
  quantization: string;
  modifiedAt: string;
}

export interface OllamaListResponse {
  endpoint: string;
  models: OllamaModelInfo[];
  truncated: boolean;
  elapsedMs: number;
}

export interface OllamaChatResponse {
  endpoint: string;
  model: string;
  text: string;
  textTruncated: boolean;
  doneReason: string;
  promptEvalCount: number;
  evalCount: number;
  totalDurationMs: number;
  elapsedMs: number;
}

export function ollamaAdapterAvailable(): boolean {
  return isTauri();
}

/** Renderer-side pre-check mirroring the Rust rule, so Settings can explain refusals before a call. */
export function describeOllamaEndpoint(raw: string): { ok: boolean; origin: string; reason: string } {
  const value = raw.trim() || OLLAMA_DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, origin: value, reason: "Not a valid URL." };
  }
  if (url.protocol !== "http:") return { ok: false, origin: value, reason: "Only plain http:// on this machine is supported." };
  if (url.username || url.password) return { ok: false, origin: value, reason: "Embedded credentials are not accepted." };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "::1" || host === "::ffff:127.0.0.1";
  if (!loopback) return { ok: false, origin: value, reason: `${host} is not a loopback address; the adapter only talks to this machine.` };
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return { ok: false, origin: value, reason: "Enter only the origin (scheme, host, port); DevLab appends the API paths." };
  }
  return { ok: true, origin: `http://${url.host}`, reason: "Loopback endpoint accepted; the native adapter will re-validate it." };
}

export async function listOllamaModels(endpoint: string): Promise<OllamaListResponse> {
  return invoke<OllamaListResponse>("ollama_list_models", { request: { endpoint } });
}

export async function ollamaChat(input: {
  endpoint: string;
  model: string;
  system: string;
  messages: GenTurn[];
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<OllamaChatResponse> {
  return invoke<OllamaChatResponse>("ollama_chat", {
    request: {
      endpoint: input.endpoint,
      model: input.model,
      system: input.system,
      messages: input.messages.map((turn) => ({ role: turn.role, content: turn.text })),
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    },
  });
}

// Phase 9P — read-only local model health check. Rust calls the fixed loopback paths
// /api/version, /api/tags, /api/ps and /api/show; no model is loaded, pulled or prompted.
export interface OllamaModelHealth {
  name: string;
  installed: boolean;
  family: string;
  parameterSize: string;
  quantization: string;
  format: string;
  architecture: string;
  parameterCount: number;
  contextLength: number | null;
  configuredContext: number | null;
  embeddingLength: number | null;
  capabilities: string[];
  sizeBytes: number;
  loaded: boolean;
  sizeVram: number;
  expiresAt: string;
  loadedContext: number | null;
  probeMs: number;
  error: string | null;
}

export interface OllamaHealthResponse {
  endpoint: string;
  serverVersion: string;
  installed: number;
  loaded: number;
  loadedKnown: boolean;
  models: OllamaModelHealth[];
  probed: number;
  skipped: number;
  truncated: boolean;
  truncationReason: string | null;
  elapsedMs: number;
}

export async function checkOllamaModelHealth(endpoint: string, models: string[] = []): Promise<OllamaHealthResponse> {
  const wanted = models.map((model) => model.trim()).filter(Boolean);
  return invoke<OllamaHealthResponse>("ollama_model_health", { request: { endpoint, models: wanted } });
}

export function describeOllamaHealth(health: OllamaHealthResponse): string {
  const parts = [
    `Ollama${health.serverVersion ? ` ${health.serverVersion}` : ""} at ${health.endpoint}`,
    `${health.installed} installed`,
    health.loadedKnown ? `${health.loaded} loaded` : "loaded state unknown (/api/ps unavailable)",
    `probed ${health.probed} in ${health.elapsedMs} ms`,
  ];
  if (health.skipped > 0) parts.push(`${health.skipped} not probed (${health.truncationReason ?? "budget"})`);
  return parts.join(" · ");
}

/** One-line context-window summary: trained maximum, Modelfile num_ctx and the running instance's value. */
export function describeContextWindow(model: OllamaModelHealth): string {
  const parts: string[] = [];
  if (model.contextLength !== null) parts.push(`max ${formatTokens(model.contextLength)} tokens`);
  if (model.configuredContext !== null) parts.push(`Modelfile num_ctx ${formatTokens(model.configuredContext)}`);
  if (model.loadedContext !== null) parts.push(`running with ${formatTokens(model.loadedContext)}`);
  if (parts.length === 0) return model.installed ? "context window not reported" : "";
  if (model.configuredContext === null && model.loadedContext === null) {
    parts.push("Ollama's default num_ctx applies unless a request sets one");
  }
  return parts.join(" · ");
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1024 && tokens % 1024 === 0) return `${tokens / 1024}k`;
  return tokens.toLocaleString("en-US");
}

export function formatParameterCount(count: number): string {
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)}B params`;
  if (count >= 1e6) return `${(count / 1e6).toFixed(0)}M params`;
  return count > 0 ? `${count} params` : "";
}

export function formatOllamaSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
  return `${bytes} B`;
}

// Phase 9P helpers — pure readings of the health metadata used by Settings.
export function sameOllamaModel(left: string, right: string): boolean {
  const canonical = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return "";
    return trimmed.includes(":") ? trimmed : `${trimmed}:latest`;
  };
  const a = canonical(left);
  const b = canonical(right);
  return a !== "" && a === b;
}

export function formatOllamaExpiry(raw: string): string {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw.slice(0, 32);
  const minutes = Math.round((parsed.getTime() - Date.now()) / 60_000);
  const clock = parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (minutes <= 0) return `${clock} (expiring)`;
  if (minutes < 120) return `${clock} (~${minutes} min)`;
  return clock;
}

/** Warnings about the configured chat/embedding models, derived only from what the server reported. */
export function describeConfiguredModelHealth(health: OllamaHealthResponse, chatModel: string, embedModel: string): string[] {
  const warnings: string[] = [];
  const check = (id: string, role: string, capability: string) => {
    const wanted = id.trim();
    if (!wanted) return;
    const entry = health.models.find((model) => sameOllamaModel(model.name, wanted));
    if (!entry) {
      if (health.truncated) {
        warnings.push(`The configured ${role} \`${wanted}\` was not among the ${health.probed} probed models; the check stopped early (${health.truncationReason ?? "budget"}).`);
      } else {
        warnings.push(`The configured ${role} \`${wanted}\` is not installed on this server. Pull it with \`ollama pull ${wanted}\` or pick a detected model.`);
      }
      return;
    }
    if (entry.error) {
      warnings.push(`The configured ${role} \`${wanted}\` could not be inspected: ${entry.error}`);
      return;
    }
    if (entry.capabilities.length > 0 && !entry.capabilities.includes(capability)) {
      warnings.push(`The configured ${role} \`${wanted}\` does not report the \`${capability}\` capability (server lists: ${entry.capabilities.join(", ")}).`);
    }
  };
  check(chatModel, "chat model", "completion");
  check(embedModel, "embedding model", "embedding");
  return warnings;
}
