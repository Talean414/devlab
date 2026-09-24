// Phase 9E — renderer client for the native custom OpenAI-compatible endpoint adapter.
//
// The base URL is non-secret metadata kept in settings; Rust re-validates it with the host policy
// (https:// required unless loopback; no credentials, query, fragment or raw remote IPs) before
// any credential lookup or request. Bearer tokens live only in the OS credential store, scoped to
// the normalized endpoint profile, and are never returned to the WebView. This module never
// fetches anything itself.

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { GenTurn } from "./gemini";

export interface EndpointProfile {
  id: string;
  origin: string;
  host: string;
  basePath: string;
  chatUrl: string;
  loopback: boolean;
  tls: boolean;
}

export interface CustomCredentialStatus {
  profile: EndpointProfile;
  configured: boolean;
  backend: string;
}

export interface CustomChatResponse {
  profile: EndpointProfile;
  model: string;
  text: string;
  textTruncated: boolean;
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
  authenticated: boolean;
  elapsedMs: number;
}

export interface CustomEndpointModel {
  id: string;
  ownedBy: string;
  created: number;
}

// Phase 9V — read-only health check result for a custom OpenAI-compatible server.
export interface CustomEndpointHealth {
  profile: EndpointProfile;
  /** HTTP status the server returned for GET {id}/models. */
  httpStatus: number;
  /** False when the server is reachable but does not expose GET /models (HTTP 404/405). */
  modelsListed: boolean;
  models: CustomEndpointModel[];
  /** True when the server lists more models than the cap kept. */
  modelsTruncated: boolean;
  /** True when the profile-scoped bearer token was attached. */
  authenticated: boolean;
  elapsedMs: number;
}

export function customAdapterAvailable(): boolean {
  return isTauri();
}

/** Pure validation (no network, no credential access) so Settings can preview the normalized profile. */
export function validateCustomEndpoint(endpoint: string): Promise<EndpointProfile> {
  return invoke<EndpointProfile>("custom_endpoint_validate", { endpoint });
}

export function customCredentialStatus(endpoint: string): Promise<CustomCredentialStatus> {
  return invoke<CustomCredentialStatus>("custom_credential_status", { endpoint });
}

export function customCredentialStore(endpoint: string, key: string): Promise<CustomCredentialStatus> {
  return invoke<CustomCredentialStatus>("custom_credential_store", { endpoint, key });
}

export function customCredentialDelete(endpoint: string): Promise<CustomCredentialStatus> {
  return invoke<CustomCredentialStatus>("custom_credential_delete", { endpoint });
}

/**
 * Phase 9V — Rust calls GET <base>/models through the bounded client with the same host
 * policy and stored token as the chat path. Read-only: no model is loaded, pulled or
 * prompted, and nothing is written.
 */
export function customEndpointHealth(endpoint: string): Promise<CustomEndpointHealth> {
  return invoke<CustomEndpointHealth>("custom_endpoint_health", { endpoint });
}

/** Pure notice text for a health result, so the Settings UI stays declarative and testable. */
export function describeCustomHealth(
  health: CustomEndpointHealth,
  configuredModel: string,
): { kind: "ok" | "warn"; text: string } {
  const id = health.profile.id;
  if (!health.modelsListed) {
    return {
      kind: "warn",
      text: `Reached ${id}, but it did not expose GET ${id}/models (HTTP ${health.httpStatus}). The chat completions path may still work — only the model list is unavailable.`,
    };
  }
  const base =
    health.models.length === 0
      ? `Reached ${id} in ${health.elapsedMs} ms (HTTP ${health.httpStatus}), but it listed no models; enter the model id manually.`
      : `Listed ${health.models.length}${health.modelsTruncated ? "+" : ""} model${health.models.length === 1 ? "" : "s"} at ${id} in ${health.elapsedMs} ms (HTTP ${health.httpStatus}).`;
  const wanted = configuredModel.trim();
  if (wanted !== "" && !health.models.some((model) => model.id === wanted)) {
    return { kind: "ok", text: `${base} Your configured model id “${wanted}” is not in this list (some gateways only list a subset).` };
  }
  return { kind: "ok", text: base };
}

export function customEndpointChat(input: {
  endpoint: string;
  model: string;
  system: string;
  messages: GenTurn[];
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<CustomChatResponse> {
  return invoke<CustomChatResponse>("custom_endpoint_chat", {
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

/**
 * Renderer-side mirror of the Rust host policy so Settings can explain a refusal before any call.
 * Rust remains authoritative; this never widens what Rust accepts.
 */
export function describeCustomEndpoint(raw: string): { ok: boolean; reason: string; loopback: boolean; tls: boolean } {
  const value = raw.trim();
  if (!value) return { ok: false, reason: "Enter the base URL of an OpenAI-compatible server (e.g. https://llm.example.com/v1).", loopback: false, tls: false };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "Not a valid URL.", loopback: false, tls: false };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "::1" || host === "::ffff:127.0.0.1";
  const tls = url.protocol === "https:";
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "Only https:// (or http:// for loopback) is supported.", loopback, tls };
  if (!tls && !loopback) return { ok: false, reason: `${host} must be reached over https://; plain http:// is accepted only for loopback.`, loopback, tls };
  if (url.username || url.password) return { ok: false, reason: "Embedded credentials are not accepted; store a bearer token instead.", loopback, tls };
  if (url.search || url.hash) return { ok: false, reason: "Query strings and fragments are not accepted.", loopback, tls };
  if (!loopback && /^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return { ok: false, reason: "Raw IP addresses are not accepted for remote endpoints; use a DNS name with a valid certificate.", loopback, tls };
  return { ok: true, reason: loopback ? "Loopback server; no token can be attached over http://." : "Remote https:// endpoint; a bearer token may be stored for it.", loopback, tls };
}
