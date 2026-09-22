// BYOK Gemini client — the key lives only in the user's browser localStorage.
// Nothing is hardcoded or sent anywhere except Google's official endpoint.

import { starterBlueprintInstruction } from "./generationBlueprints";
import { componentScaffoldInstruction, designSystemInstruction, qualityChecklistInstruction } from "./generationGuidance";
import { loadSettings } from "./settings";
import { ollamaChat } from "./ollama";
import {
  generationGuardrailInstruction,
  resolveAiRoute,
  routeInstruction,
  type AiRoute,
  type AiTaskKind,
} from "./modelRouting";

const KEY_STORAGE = "devlab.gemini.key";
const MODEL_STORAGE = "devlab.gemini.model";
const PICKED_STORAGE = "devlab.gemini.picked";
const COOLDOWN_STORAGE = "devlab.gemini.cooldowns";

// Flash-Lite gives free-tier users the best latency/quota balance. A user can
// still select a higher-quality Flash model in Settings.
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";

// Stable, economical models come first so an exhausted premium Flash quota can
// fail over to a model that commonly has a separate, higher-throughput quota.
export const FALLBACK_CHAIN = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
];

export interface GenTurn {
  role: "user" | "model";
  text: string;
}

export interface ImagePart {
  data: string; // base64, no data: prefix
  mime: string; // e.g. image/png
}

export interface ModelInfo {
  name: string;        // e.g. "models/gemini-3.5-flash-lite"
  displayName: string;
  supported: boolean;  // supports generateContent
}

type ErrorKind =
  | "rate_limit"
  | "daily_quota"
  | "quota_unavailable"
  | "authentication"
  | "permission"
  | "not_found"
  | "server"
  | "request";

interface ApiErrorOptions {
  status: number;
  model: string;
  kind: ErrorKind;
  message: string;
  retryAfterMs?: number;
  rawMessage?: string;
}

/** A sanitized Gemini error. rawMessage is retained for diagnostics, not shown in the UI. */
export class GeminiApiError extends Error {
  readonly status: number;
  readonly model: string;
  readonly kind: ErrorKind;
  readonly retryAfterMs?: number;
  readonly rawMessage?: string;

  constructor(options: ApiErrorOptions) {
    super(options.message);
    this.name = "GeminiApiError";
    this.status = options.status;
    this.model = options.model;
    this.kind = options.kind;
    this.retryAfterMs = options.retryAfterMs;
    this.rawMessage = options.rawMessage;
  }
}

interface Cooldown {
  until: number;
  kind: "temporary" | "daily" | "unavailable";
}

let cachedList: { key: string; ts: number; models: ModelInfo[] } | null = null;
const CACHE_MS = 60_000;
const MAX_AUTO_RETRY_WAIT_MS = 8_000;
const MAX_QUOTA_FALLBACKS = 3;
const MAX_CONTEXT_CHARS = 80_000;

export function getApiKey(): string {
  return localStorage.getItem(KEY_STORAGE) || "";
}

export function setApiKey(key: string) {
  const next = key.trim();
  const changed = next !== getApiKey();
  localStorage.setItem(KEY_STORAGE, next);
  if (changed) {
    localStorage.removeItem(PICKED_STORAGE);
    localStorage.removeItem(COOLDOWN_STORAGE);
    cachedList = null;
  }
}

export function clearApiKey() {
  localStorage.removeItem(KEY_STORAGE);
  localStorage.removeItem(MODEL_STORAGE);
  localStorage.removeItem(PICKED_STORAGE);
  localStorage.removeItem(COOLDOWN_STORAGE);
  cachedList = null;
}

export function getModel(): string {
  return localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL;
}

export function setModel(model: string) {
  localStorage.setItem(MODEL_STORAGE, model);
  // The status bar should immediately reflect an explicit user selection.
  localStorage.setItem(PICKED_STORAGE, model);
}

export function getPicked(): string | null {
  return localStorage.getItem(PICKED_STORAGE);
}

export function setPicked(model: string) {
  localStorage.setItem(PICKED_STORAGE, model);
}

export function getCurrentAiRoute(task: AiTaskKind = "chat"): AiRoute {
  return resolveAiRoute(task, {
    selectedModel: getModel(),
    pickedModel: getPicked(),
  });
}

/**
 * True when text generation can be attempted for this task: the route is active and either the
 * provider needs no renderer credential (native Ollama adapter) or a Gemini key is present.
 * Vision keeps requiring Gemini and should keep checking getApiKey() directly.
 */
export function hasGenerationAccess(task: AiTaskKind = "chat"): boolean {
  const route = getCurrentAiRoute(task);
  if (route.status !== "active") return false;
  if (route.provider === "ollama") return true;
  return !!getApiKey();
}

function readCooldowns(): Record<string, Cooldown> {
  try {
    const parsed = JSON.parse(localStorage.getItem(COOLDOWN_STORAGE) || "{}") as Record<string, Cooldown>;
    const now = Date.now();
    let changed = false;
    for (const [model, cooldown] of Object.entries(parsed)) {
      if (!cooldown || cooldown.until <= now) {
        delete parsed[model];
        changed = true;
      }
    }
    if (changed) localStorage.setItem(COOLDOWN_STORAGE, JSON.stringify(parsed));
    return parsed;
  } catch {
    return {};
  }
}

function putOnCooldown(model: string, error: GeminiApiError) {
  const cooldowns = readCooldowns();
  const wait = error.kind === "daily_quota"
    ? millisecondsUntilPacificMidnight()
    : error.kind === "quota_unavailable"
      ? 60 * 60_000
      : Math.max(error.retryAfterMs || 30_000, 5_000);
  cooldowns[model] = {
    until: Date.now() + wait,
    kind: error.kind === "daily_quota"
      ? "daily"
      : error.kind === "quota_unavailable"
        ? "unavailable"
        : "temporary",
  };
  localStorage.setItem(COOLDOWN_STORAGE, JSON.stringify(cooldowns));
}

// Google documents daily quota resets at midnight America/Los_Angeles. This
// conversion handles PST, PDT, and transition days without a timezone library.
function millisecondsUntilPacificMidnight(): number {
  const now = new Date();
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const parts = Object.fromEntries(
    dateFormatter.formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const localMidnightAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day + 1);

  // Start with the current offset. The next midnight is at most 24 hours away;
  // a second pass corrects the guess if daylight saving changes before then.
  let nextMidnightUtc = localMidnightAsUtc - pacificOffsetAt(now);
  for (let pass = 0; pass < 2; pass += 1) {
    nextMidnightUtc = localMidnightAsUtc - pacificOffsetAt(new Date(nextMidnightUtc));
  }
  return Math.max(nextMidnightUtc - now.getTime(), 60_000);
}

function pacificOffsetAt(date: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
    hourCycle: "h23",
  });
  const zoned = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal" && part.type !== "dayPeriod")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const representedAsUtc = Date.UTC(
    zoned.year, zoned.month - 1, zoned.day,
    zoned.hour, zoned.minute, zoned.second,
  );
  return representedAsUtc - date.getTime();
}

const SYSTEM_PROMPT = `You are DevLab Agent, an expert senior software engineer embedded in a developer's control-plane IDE.
Be concise, practical and code-first. When asked to scaffold or configure things, output copy-pasteable shell commands or file contents in fenced code blocks. Prefer modern, free, open-source tooling.`;

interface StreamChatOptions {
  maxOutputTokens?: number;
  temperature?: number;
  task?: AiTaskKind;
}

export async function* streamChat(
  history: GenTurn[],
  options: StreamChatOptions = {},
): AsyncGenerator<string, void, unknown> {
  const settings = loadSettings();
  const route = resolveAiRoute(options.task ?? "chat", {
    selectedModel: getModel(),
    pickedModel: getPicked(),
  }, settings);
  if (route.status !== "active") throw new Error(route.reason);

  const customPrompt = settings.systemPrompt.trim();
  const systemText = [
    SYSTEM_PROMPT,
    routeInstruction(route.task),
    generationGuardrailInstruction(route.task),
    starterBlueprintInstruction(route.task),
    componentScaffoldInstruction(route.task),
    designSystemInstruction(route.task),
    qualityChecklistInstruction(route.task),
    customPrompt ? `Developer preferences:\n${customPrompt}` : "",
  ].filter(Boolean).join("\n\n");
  const temperature = clamp(options.temperature ?? settings.temperature, 0, 2);
  const maxOutputTokens = Math.round(clamp(options.maxOutputTokens ?? settings.maxTokens, 256, 16_384));

  if (route.provider === "ollama") {
    // Native loopback adapter: one bounded, non-streamed completion from Rust. No Gemini key,
    // cooldown or fallback logic applies; a failure is reported as-is rather than retried elsewhere.
    const reply = await ollamaChat({
      endpoint: settings.customEndpoint,
      model: route.model,
      system: systemText,
      messages: limitHistory(history),
      temperature,
      maxOutputTokens,
    });
    yield reply.text;
    if (reply.textTruncated) yield "\n\n… local model reply truncated at DevLab's response bound.";
    return;
  }

  const body = {
    systemInstruction: {
      parts: [{ text: systemText }],
    },
    contents: limitHistory(history).map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text }],
    })),
    generationConfig: { temperature, maxOutputTokens },
  };

  yield* streamAcrossModels(body, route);
}

export async function* streamVision(
  prompt: string,
  images: ImagePart[],
): AsyncGenerator<string, void, unknown> {
  const settings = loadSettings();
  const route = resolveAiRoute("vision", {
    selectedModel: getModel(),
    pickedModel: getPicked(),
  }, settings);
  if (route.status !== "active") throw new Error(route.reason);
  if (route.provider === "ollama") {
    throw new Error("Vision generation is not routed through the local Ollama adapter in this phase. Switch Settings → Providers to Gemini for image input.");
  }

  const parts: Record<string, unknown>[] = images.map((image) => ({
    inline_data: { mime_type: image.mime, data: image.data },
  }));
  parts.push({ text: prompt });

  const systemText = [
    SYSTEM_PROMPT,
    routeInstruction("vision"),
    generationGuardrailInstruction("vision"),
    starterBlueprintInstruction("vision"),
    componentScaffoldInstruction("vision"),
    designSystemInstruction("vision"),
    qualityChecklistInstruction("vision"),
  ].filter(Boolean).join("\n\n");

  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: clamp(settings.temperature, 0, 2),
      maxOutputTokens: Math.round(clamp(settings.maxTokens, 256, 16_384)),
    },
  };

  yield* streamAcrossModels(body, route);
}

async function* streamAcrossModels(body: object, route: AiRoute): AsyncGenerator<string, void, unknown> {
  const key = getApiKey();
  if (!key) throw new Error("NO_KEY");

  const { candidates, cooled } = await buildCandidateModels(route.task);
  if (candidates.length === 0) {
    const soonest = cooled.sort((a, b) => a.cooldown.until - b.cooldown.until)[0];
    if (soonest) {
      const wait = humanWait(soonest.cooldown.until - Date.now());
      throw new Error(
        soonest.cooldown.kind === "daily"
          ? `Gemini's free daily quota is exhausted. It resets at midnight Pacific time. DevLab will try this model again after the reset.`
          : soonest.cooldown.kind === "unavailable"
            ? "Google reports no free quota for the available models on this project. Choose a Flash-Lite model and check the project's limits in Google AI Studio."
            : `Gemini is temporarily rate-limiting requests. Try again in about ${wait}.`,
      );
    }
    throw new Error("No Gemini text-generation model is available for this API key. Choose a supported model in Settings.");
  }

  const attempted: string[] = [];
  const quotaErrors: GeminiApiError[] = [];
  let lastError: unknown = null;
  let unavailableCount = 0;

  for (const model of candidates) {
    try {
      attempted.push(model);
      yield* streamModelWithRetry(model, body, key);
      setPicked(model);
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof GeminiApiError)) throw error;

      if (error.status === 429) {
        quotaErrors.push(error);
        putOnCooldown(model, error);
        if (quotaErrors.length >= MAX_QUOTA_FALLBACKS) break;
        continue;
      }

      // A listed model can still be disabled for a region/project. Try a small
      // number of alternatives, but never hammer every model in the catalog.
      if (error.status === 403 || error.status === 404) {
        unavailableCount += 1;
        if (unavailableCount < MAX_QUOTA_FALLBACKS) continue;
      }
      throw error;
    }
  }

  if (quotaErrors.length > 0) {
    const unavailable = quotaErrors.some((error) => error.kind === "quota_unavailable");
    const daily = quotaErrors.some((error) => error.kind === "daily_quota");
    const retryValues = quotaErrors
      .map((error) => error.retryAfterMs)
      .filter((value): value is number => typeof value === "number" && value > 0);
    const retryAfterMs = retryValues.length ? Math.min(...retryValues) : undefined;
    const tried = attempted.join(", ");
    const kind: ErrorKind = unavailable ? "quota_unavailable" : daily ? "daily_quota" : "rate_limit";
    throw new GeminiApiError({
      status: 429,
      model: attempted[attempted.length - 1] || getModel(),
      kind,
      retryAfterMs,
      message: unavailable
        ? `Google reports no usable free quota for one or more models on this project. DevLab automatically tried ${tried}. Select an available Flash-Lite model and check this project's limits in Google AI Studio; a quota limit of 0 does not recover by retrying.`
        : daily
          ? `Gemini's free daily quota is exhausted. DevLab automatically tried ${tried}. Daily quotas reset at midnight Pacific time. You can wait for the reset or select another available Flash-Lite model in Settings. API keys from the same Google Cloud project share one quota.`
          : `Gemini is temporarily rate-limiting this project after DevLab tried ${tried}. Try again${retryAfterMs ? ` in about ${humanWait(retryAfterMs)}` : " in a minute"}. If this keeps happening, select a Flash-Lite model in Settings.`,
    });
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error("Gemini could not complete this request. Please try again.");
}

async function* streamModelWithRetry(
  model: string,
  body: object,
  key: string,
): AsyncGenerator<string, void, unknown> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let emitted = false;
    try {
      for await (const chunk of streamWithModel(model, body, key)) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (error) {
      // Never restart a response after showing part of it; doing so duplicates
      // text and may charge quota for a second full generation.
      if (emitted || !(error instanceof GeminiApiError)) throw error;

      const retryableServerError = [500, 503, 504].includes(error.status);
      const shortRateLimit = error.status === 429
        && error.kind === "rate_limit"
        && (error.retryAfterMs || 1_000) <= MAX_AUTO_RETRY_WAIT_MS;
      if (attempt > 0 || (!retryableServerError && !shortRateLimit)) throw error;

      const base = error.retryAfterMs || (retryableServerError ? 1_200 : 2_000);
      await delay(Math.min(base + Math.round(Math.random() * 350), MAX_AUTO_RETRY_WAIT_MS));
    }
  }
}

async function* streamWithModel(
  model: string,
  body: object,
  key: string,
): AsyncGenerator<string, void, unknown> {
  let emitted = false;
  try {
    for await (const chunk of streamSse(model, body, key)) {
      emitted = true;
      yield chunk;
    }
    return;
  } catch (error) {
    // HTTP failures need deliberate retry/failover handling. Falling straight
    // through to generateContent used to duplicate every 429 request.
    if (emitted || error instanceof GeminiApiError) throw error;
    console.warn("[DevLab] Streaming transport failed; trying a non-streaming request.", error);
  }

  yield* generateNonStreaming(model, body, key);
}

async function* streamSse(
  model: string,
  body: object,
  key: string,
): AsyncGenerator<string, void, unknown> {
  const url = endpoint(model, "streamGenerateContent", key, "&alt=sse");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await responseError(res, model);
  if (!res.body) throw new Error("Gemini returned no response stream.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const text = textFromSseLine(line);
      if (text) yield text;
    }
  }

  buffer += decoder.decode();
  if (buffer) {
    const text = textFromSseLine(buffer);
    if (text) yield text;
  }
}

function textFromSseLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return "";
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return "";
  try {
    const parsed = JSON.parse(data);
    return parsed?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text || "")
      .join("") || "";
  } catch {
    return "";
  }
}

// Fallback for browsers/proxies that cannot keep the SSE connection open.
async function* generateNonStreaming(
  model: string,
  body: object,
  key: string,
): AsyncGenerator<string, void, unknown> {
  const res = await fetch(endpoint(model, "generateContent", key), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await responseError(res, model);

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text || "")
    .join("") || "";
  if (!text) {
    yield "*(Gemini returned an empty response — try again.)*";
    return;
  }

  const chunkSize = 18;
  for (let i = 0; i < text.length; i += chunkSize) {
    yield text.slice(i, i + chunkSize);
    await delay(12);
  }
}

function endpoint(model: string, method: string, key: string, suffix = ""): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${method}?key=${encodeURIComponent(key)}${suffix}`;
}

async function responseError(response: Response, model: string): Promise<GeminiApiError> {
  const raw = await response.text();
  let message = raw;
  let details: unknown[] = [];
  try {
    const parsed = JSON.parse(raw);
    message = parsed?.error?.message || raw;
    details = Array.isArray(parsed?.error?.details) ? parsed.error.details : [];
  } catch {
    // Some proxies return plain text or HTML. It is kept out of the UI.
  }

  const detailText = JSON.stringify(details);
  const combined = `${message} ${detailText}`.toLowerCase();
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"))
    ?? retryDelayFromDetails(details)
    ?? retryDelayFromMessage(message);
  const zeroQuota = response.status === 429 && (
    /quota[^\n]*limit:\s*0\b/.test(combined)
    || /"quotavalue"\s*:\s*"?0"?/.test(combined)
  );
  const daily = response.status === 429
    && !zeroQuota
    && /per.?day|daily|requestsperday|tokensperday/.test(combined);

  const kind: ErrorKind = response.status === 429
    ? (zeroQuota ? "quota_unavailable" : daily ? "daily_quota" : "rate_limit")
    : response.status === 401
      ? "authentication"
      : response.status === 403
        ? "permission"
        : response.status === 404
          ? "not_found"
          : response.status >= 500
            ? "server"
            : "request";

  return new GeminiApiError({
    status: response.status,
    model,
    kind,
    retryAfterMs,
    rawMessage: message,
    message: friendlyApiMessage(response.status, kind, model, retryAfterMs),
  });
}

function friendlyApiMessage(status: number, kind: ErrorKind, model: string, retryAfterMs?: number): string {
  if (kind === "daily_quota") {
    return `The free daily quota for ${model} has been used. DevLab is trying another available model; this quota resets at midnight Pacific time.`;
  }
  if (kind === "quota_unavailable") {
    return `Google reports a quota limit of 0 for ${model}. DevLab is trying another available Flash-Lite model.`;
  }
  if (kind === "rate_limit") {
    return `Google is temporarily rate-limiting ${model}. DevLab is trying another model${retryAfterMs ? `; this one should recover in about ${humanWait(retryAfterMs)}` : ""}.`;
  }
  if (kind === "authentication") return "Google rejected this API key. Replace it in Settings → Providers.";
  if (kind === "permission") return `${model} is not enabled for this Google project or region.`;
  if (kind === "not_found") return `${model} is no longer available. DevLab is trying a supported model.`;
  if (kind === "server") return `Gemini is temporarily unavailable (API ${status}). DevLab retried the request; please try again shortly.`;
  return `Gemini rejected the request (API ${status}) for ${model}. Check the selected model and generation settings.`;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function retryDelayFromDetails(details: unknown[]): number | undefined {
  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    const value = (detail as Record<string, unknown>).retryDelay;
    if (typeof value === "string") {
      const parsed = parseDuration(value);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function retryDelayFromMessage(message: string): number | undefined {
  const match = message.match(/retry\s+in\s+([\d.]+)\s*s/i);
  return match ? Number(match[1]) * 1_000 : undefined;
}

function parseDuration(value: string): number | undefined {
  const match = value.match(/^([\d.]+)s$/);
  return match ? Number(match[1]) * 1_000 : undefined;
}

function humanWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1_000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function limitHistory(history: GenTurn[]): GenTurn[] {
  const kept: GenTurn[] = [];
  let remaining = MAX_CONTEXT_CHARS;
  for (let index = history.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const turn = history[index];
    const text = turn.text.length > remaining
      ? turn.text.slice(turn.text.length - remaining)
      : turn.text;
    kept.unshift({ ...turn, text });
    remaining -= text.length;
  }
  while (kept[0]?.role === "model") kept.shift();
  return kept;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Fetches the model list and caches it briefly. Listing models does not consume
// generateContent quota and lets us avoid requests to retired model IDs.
export async function listAvailableModels(): Promise<ModelInfo[]> {
  const key = getApiKey();
  if (!key) return [];
  if (cachedList && cachedList.key === key && Date.now() - cachedList.ts < CACHE_MS) {
    return cachedList.models;
  }
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
    );
    if (!res.ok) return [];
    const json = await res.json();
    const models: ModelInfo[] = (json.models || [])
      .filter((model: { name?: string }) => model.name?.startsWith("models/"))
      .map((model: { name: string; displayName?: string; supportedGenerationMethods?: string[] }) => ({
        name: model.name,
        displayName: model.displayName || model.name.replace("models/", ""),
        supported: (model.supportedGenerationMethods || []).includes("generateContent"),
      }));
    cachedList = { key, ts: Date.now(), models };
    return models;
  } catch {
    return [];
  }
}

async function buildCandidateModels(task: AiTaskKind = "chat"): Promise<{
  candidates: string[];
  cooled: { model: string; cooldown: Cooldown }[];
}> {
  const models = await listAvailableModels();
  const supportedIds = new Set(
    models.filter((model) => model.supported).map((model) => model.name.replace("models/", "")),
  );
  const haveLiveList = supportedIds.size > 0;
  const cooldowns = readCooldowns();
  const ordered: string[] = [];
  const seen = new Set<string>();
  const cooled: { model: string; cooldown: Cooldown }[] = [];

  const push = (model: string | null) => {
    if (!model || seen.has(model) || (haveLiveList && !supportedIds.has(model))) return;
    seen.add(model);
    const cooldown = cooldowns[model];
    if (cooldown?.until > Date.now()) cooled.push({ model, cooldown });
    else ordered.push(model);
  };

  const settings = loadSettings();
  if (settings.modelRouting === "fixed") {
    push(getModel());
    push(getPicked());
  } else {
    push(getPicked());
    push(getModel());
    for (const model of taskPreferredGeminiModels(task)) push(model);
  }
  for (const model of FALLBACK_CHAIN) push(model);
  for (const model of supportedIds) push(model);
  return { candidates: ordered, cooled };
}

function taskPreferredGeminiModels(task: AiTaskKind): string[] {
  switch (task) {
    case "planning":
    case "architecture":
    case "migration":
      return [
        "gemini-3.8-flash",
        "gemini-3.7-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-2.5-flash",
        "gemini-3.5-flash-lite",
      ];
    case "coding":
      return [
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
      ];
    case "repair":
      return [
        "gemini-3.5-flash-lite",
        "gemini-2.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-2.5-flash",
      ];
    case "vision":
      return [
        "gemini-2.5-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
      ];
    default:
      return FALLBACK_CHAIN;
  }
}

// Pick the configured model when it is available, otherwise the most economical
// stable fallback exposed to this API key.
export async function pickBestModel(): Promise<string | null> {
  const models = await listAvailableModels();
  if (models.length === 0) return null;
  const ids = new Set(
    models.filter((model) => model.supported).map((model) => model.name.replace("models/", "")),
  );
  const configured = getModel();
  if (ids.has(configured)) {
    setPicked(configured);
    return configured;
  }
  for (const candidate of FALLBACK_CHAIN) {
    if (ids.has(candidate)) {
      setPicked(candidate);
      return candidate;
    }
  }
  const any = models.find((model) => model.supported);
  if (!any) return null;
  const id = any.name.replace("models/", "");
  setPicked(id);
  return id;
}

// This validates authentication and model-list access. It deliberately does not
// generate content, because a "Test" button should not consume user quota.
export async function verifyKey(): Promise<boolean> {
  const key = getApiKey();
  if (!key) return false;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
    );
    return res.ok;
  } catch {
    return false;
  }
}
