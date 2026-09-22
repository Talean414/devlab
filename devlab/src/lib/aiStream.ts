// Phase 9F — renderer client for streamed replies from the native AI adapters.
//
// Text deltas arrive through a Tauri Channel from Rust; the WebView never opens the upstream
// connection itself. Every adapter keeps its own host policy, credential handling and bounds —
// this module only chooses the matching `*_chat_stream` command, forwards deltas as an async
// iterator and lets the caller stop a reply with `ai_stream_cancel`.

import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { GenTurn } from "./gemini";
import type { CloudAiProvider } from "./aiProviders";

export interface StreamSummary {
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
  chars: number;
  textTruncated: boolean;
  cancelled: boolean;
  lines: number;
  elapsedMs: number;
}

export type StreamEvent = { kind: "delta"; text: string } | { kind: "done"; summary: StreamSummary };

export interface StreamedReply {
  target: string;
  model: string;
  summary: StreamSummary;
}

export type StreamTarget =
  | { kind: "ollama"; endpoint: string }
  | { kind: "cloud"; provider: CloudAiProvider }
  | { kind: "custom"; endpoint: string };

export interface StreamInput {
  target: StreamTarget;
  model: string;
  system: string;
  messages: GenTurn[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export function streamingAvailable(): boolean {
  return isTauri();
}

let streamCounter = 0;
function nextStreamId(): string {
  streamCounter = (streamCounter + 1) % 1_000_000;
  return `s-${Date.now().toString(36)}-${streamCounter.toString(36)}`;
}

export function cancelStream(streamId: string): Promise<boolean> {
  return invoke<boolean>("ai_stream_cancel", { streamId });
}

function commandFor(target: StreamTarget): { command: string; request: Record<string, unknown> } {
  switch (target.kind) {
    case "ollama":
      return { command: "ollama_chat_stream", request: { endpoint: target.endpoint } };
    case "cloud":
      return { command: "ai_provider_chat_stream", request: { provider: target.provider } };
    case "custom":
      return { command: "custom_endpoint_chat_stream", request: { endpoint: target.endpoint } };
  }
}

/**
 * Streams a reply as text chunks. Resolves after the final `done` event; throws the native
 * CommandError when the adapter fails. Aborting `signal` asks Rust to stop at the next line.
 */
export async function* streamNativeReply(input: StreamInput): AsyncGenerator<string, StreamedReply, unknown> {
  const streamId = nextStreamId();
  const queue: StreamEvent[] = [];
  let wake: (() => void) | null = null;
  const channel = new Channel<StreamEvent>();
  channel.onmessage = (event) => {
    queue.push(event);
    wake?.();
    wake = null;
  };

  const { command, request } = commandFor(input.target);
  let settled: { reply?: StreamedReply; error?: unknown } | null = null;
  const pending = invoke<StreamedReply>(command, {
    request: {
      ...request,
      model: input.model,
      system: input.system,
      messages: input.messages.map((turn) => ({ role: turn.role, content: turn.text })),
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    },
    streamId,
    channel,
  })
    .then((reply) => { settled = { reply }; })
    .catch((error: unknown) => { settled = { error }; })
    .finally(() => { wake?.(); wake = null; });

  const onAbort = () => { void cancelStream(streamId).catch(() => undefined); };
  if (input.signal?.aborted) onAbort();
  input.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      while (queue.length > 0) {
        const event = queue.shift()!;
        if (event.kind === "delta") yield event.text;
      }
      if (settled) break;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    while (queue.length > 0) {
      const event = queue.shift()!;
      if (event.kind === "delta") yield event.text;
    }
    await pending;
    const outcome = settled as { reply?: StreamedReply; error?: unknown } | null;
    if (outcome?.error !== undefined) throw outcome.error;
    if (!outcome?.reply) throw new Error("The streamed reply ended without a summary.");
    return outcome.reply;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
}
