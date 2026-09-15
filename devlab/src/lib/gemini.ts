// BYOK Gemini client — the key lives only in the user's browser localStorage.
// Nothing is ever hardcoded or sent anywhere except Google's official endpoint.

const KEY_STORAGE = "devlab.gemini.key";
const MODEL_STORAGE = "devlab.gemini.model";
const PICKED_STORAGE = "devlab.gemini.picked";

// Preferred default — we'll verify with the API at startup.
export const DEFAULT_MODEL = "gemini-3.6-flash";

// Ordered from "best & newest" to "oldest fallback". We always pick the first
// one that the user's key actually has access to.
export const FALLBACK_CHAIN = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
];

export function getApiKey(): string {
  return localStorage.getItem(KEY_STORAGE) || "";
}
export function setApiKey(key: string) {
  localStorage.setItem(KEY_STORAGE, key.trim());
}
export function clearApiKey() {
  localStorage.removeItem(KEY_STORAGE);
  localStorage.removeItem(MODEL_STORAGE);
  localStorage.removeItem(PICKED_STORAGE);
}
export function getModel(): string {
  return localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL;
}
export function setModel(m: string) {
  localStorage.setItem(MODEL_STORAGE, m);
}
export function getPicked(): string | null {
  return localStorage.getItem(PICKED_STORAGE);
}
export function setPicked(m: string) {
  localStorage.setItem(PICKED_STORAGE, m);
}

export interface GenTurn {
  role: "user" | "model";
  text: string;
}

export interface ImagePart {
  data: string; // base64, no data: prefix
  mime: string; // e.g. image/png
}

export async function* streamVision(
  prompt: string,
  images: ImagePart[],
): AsyncGenerator<string, void, unknown> {
  const key = getApiKey();
  if (!key) throw new Error("NO_KEY");
  const model = getPicked() || getModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

  const parts: Record<string, unknown>[] = images.map((im) => ({
    inline_data: { mime_type: im.mime, data: im.data },
  }));
  parts.push({ text: prompt });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  if (!res.body) throw new Error("No response stream");

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
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const json = t.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      try {
        const parsed = JSON.parse(json);
        const text =
          parsed?.candidates?.[0]?.content?.parts
            ?.map((p: { text?: string }) => p.text || "")
            .join("") || "";
        if (text) yield text;
      } catch { /* partial */ }
    }
  }
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const SYSTEM_PROMPT = `You are DevLab Agent, an expert senior software engineer embedded in a developer's control-plane IDE.
Be concise, practical and code-first. When asked to scaffold or configure things, output copy-pasteable shell commands or file contents in fenced code blocks. Prefer modern, free, open-source tooling.`;

export async function* streamChat(
  history: GenTurn[],
): AsyncGenerator<string, void, unknown> {
  const key = getApiKey();
  if (!key) throw new Error("NO_KEY");

  // Build the candidate list: user's selected model first, then the fallback chain.
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (m: string | null) => {
    if (m && !seen.has(m)) {
      seen.add(m);
      candidates.push(m);
    }
  };
  push(getModel());
  for (const m of FALLBACK_CHAIN) push(m);
  // Also try whatever the live API told us is available, as a last resort.
  const livePicked = await pickBestModel();
  push(livePicked);

  let lastError = "";
  for (const model of candidates) {
    try {
      yield* streamWithModel(model, history, key);
      return; // success
    } catch (e) {
      const msg = (e as Error).message;
      lastError = msg;
      // Only retry on 404 (model gone) or 403 (region-restricted). Bail otherwise.
      if (!msg.includes("API 404") && !msg.includes("API 403")) throw e;
    }
  }
  throw new Error(`All models failed. Last error: ${lastError}`);
}

async function* streamWithModel(
  model: string,
  history: GenTurn[],
  key: string,
): AsyncGenerator<string, void, unknown> {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: history.map((h) => ({
      role: h.role,
      parts: [{ text: h.text }],
    })),
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
  };

  // ── Path 1: SSE streaming (preferred, gives token-by-token output) ──
  try {
    yield* streamSse(model, body, key);
    return;
  } catch (sseErr) {
    const msg = (sseErr as Error).message;
    // If it's a model-not-found / permission error, surface it so the outer
    // loop can try the next model in the fallback chain.
    if (msg.includes("API 404") || msg.includes("API 403") || msg.includes("API 400")) {
      throw sseErr;
    }
    // For NetworkError / CORS / aborts etc., fall through to non-streaming fallback.
    console.warn("[DevLab] SSE failed, falling back to non-streaming:", msg);
  }

  // ── Path 2: Non-streaming generateContent (chunked yield for UX) ──
  yield* generateNonStreaming(model, body, key);
}

async function* streamSse(
  model: string,
  body: object,
  key: string,
): AsyncGenerator<string, void, unknown> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("No response stream");

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
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const json = trimmed.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      try {
        const parsed = JSON.parse(json);
        const text =
          parsed?.candidates?.[0]?.content?.parts
            ?.map((p: { text?: string }) => p.text || "")
            .join("") || "";
        if (text) yield text;
      } catch {
        // partial JSON, ignore
      }
    }
  }
}

// Fallback: plain JSON response, chunked into ~20-char "tokens" so the UI
// still feels like streaming instead of dumping the whole answer at once.
async function* generateNonStreaming(
  model: string,
  body: object,
  key: string,
): AsyncGenerator<string, void, unknown> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const json = await res.json();
  const text =
    json?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text || "")
      .join("") || "";
  if (!text) {
    yield "*(empty response — try again)*";
    return;
  }

  // Chunk into ~18-char pieces with tiny delays for a "streaming" feel.
  const CHUNK = 18;
  for (let i = 0; i < text.length; i += CHUNK) {
    yield text.slice(i, i + CHUNK);
    await new Promise((r) => setTimeout(r, 12));
  }
}

export interface ModelInfo {
  name: string;        // e.g. "models/gemini-3.6-flash"
  displayName: string;
  supported: boolean;  // supports generateContent
}

// Fetches the full model list from Google's API and caches it briefly in memory.
let cachedList: { ts: number; models: ModelInfo[] } | null = null;
const CACHE_MS = 60_000;

export async function listAvailableModels(): Promise<ModelInfo[]> {
  const key = getApiKey();
  if (!key) return [];
  if (cachedList && Date.now() - cachedList.ts < CACHE_MS) return cachedList.models;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
    );
    if (!res.ok) return [];
    const json = await res.json();
    const models: ModelInfo[] = (json.models || [])
      .filter((m: { name?: string }) => m.name && m.name.startsWith("models/"))
      .map((m: { name: string; displayName?: string; supportedGenerationMethods?: string[] }) => ({
        name: m.name,
        displayName: m.displayName || m.name.replace("models/", ""),
        supported: (m.supportedGenerationMethods || []).includes("generateContent"),
      }));
    cachedList = { ts: Date.now(), models };
    return models;
  } catch {
    return [];
  }
}

// Pick the best model we actually have access to, from the FALLBACK_CHAIN.
export async function pickBestModel(): Promise<string | null> {
  const cached = getPicked();
  if (cached) return cached;
  const models = await listAvailableModels();
  if (models.length === 0) return null;
  const ids = new Set(models.map((m) => m.name.replace("models/", "")));
  for (const candidate of FALLBACK_CHAIN) {
    if (ids.has(candidate)) {
      setPicked(candidate);
      return candidate;
    }
  }
  // Nothing in our preferred chain? Just take the first generateContent-supporting one.
  const any = models.find((m) => m.supported);
  if (any) {
    const id = any.name.replace("models/", "");
    setPicked(id);
    return id;
  }
  return null;
}

// Kept for backwards-compat with SettingsPanel "Test connection" button.
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
