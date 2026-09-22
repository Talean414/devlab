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

export function formatOllamaSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
  return `${bytes} B`;
}
