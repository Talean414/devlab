// Phase 9B — renderer client for the native DeepSeek / OpenAI / Anthropic adapters.
//
// API keys are written once into the operating-system credential store through Rust and are
// never returned to the WebView; the renderer only ever learns `configured: true|false`.
// Requests go to fixed HTTPS hosts compiled into Rust; the renderer cannot choose a URL.

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { GenTurn } from "./gemini";

export type CloudAiProvider = "deepseek" | "openai" | "anthropic";

export const CLOUD_AI_PROVIDERS: CloudAiProvider[] = ["deepseek", "openai", "anthropic"];

export function isCloudAiProvider(value: string): value is CloudAiProvider {
  return (CLOUD_AI_PROVIDERS as string[]).includes(value);
}

export interface AiCredentialStatus {
  provider: CloudAiProvider;
  host: string;
  configured: boolean;
  backend: string;
}

export interface AiChatResponse {
  provider: CloudAiProvider;
  host: string;
  model: string;
  text: string;
  textTruncated: boolean;
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}

export function cloudAdapterAvailable(): boolean {
  return isTauri();
}

export function aiCredentialStatus(provider: CloudAiProvider): Promise<AiCredentialStatus> {
  return invoke<AiCredentialStatus>("ai_credential_status", { provider });
}

export function aiCredentialStore(provider: CloudAiProvider, key: string): Promise<AiCredentialStatus> {
  return invoke<AiCredentialStatus>("ai_credential_store", { provider, key });
}

export function aiCredentialDelete(provider: CloudAiProvider): Promise<AiCredentialStatus> {
  return invoke<AiCredentialStatus>("ai_credential_delete", { provider });
}

export function aiProviderChat(input: {
  provider: CloudAiProvider;
  model: string;
  system: string;
  messages: GenTurn[];
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<AiChatResponse> {
  return invoke<AiChatResponse>("ai_provider_chat", {
    request: {
      provider: input.provider,
      model: input.model,
      system: input.system,
      messages: input.messages.map((turn) => ({ role: turn.role, content: turn.text })),
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    },
  });
}

// Session-only cache of "is a key configured" so the router can answer synchronously without
// a native round-trip on every render. It holds booleans only, never key material.
const configuredCache = new Map<CloudAiProvider, boolean>();

export function rememberCredentialConfigured(provider: CloudAiProvider, configured: boolean) {
  configuredCache.set(provider, configured);
}

export function credentialKnownConfigured(provider: CloudAiProvider): boolean | undefined {
  return configuredCache.get(provider);
}

export async function refreshCredentialCache(): Promise<void> {
  if (!isTauri()) return;
  await Promise.all(CLOUD_AI_PROVIDERS.map(async (provider) => {
    try {
      const status = await aiCredentialStatus(provider);
      configuredCache.set(provider, status.configured);
    } catch {
      // Leave the cache untouched; a failed status probe must not pretend a key exists.
    }
  }));
}
