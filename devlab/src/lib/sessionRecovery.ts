import type { BuilderPhase, BuilderPlan, ChatMessage, VFile, ViewId } from "../types";

const KEY = "devlab.sessionRecovery.v1";
const MAX_AGENT_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 24 * 1024;
const MAX_INPUT_CHARS = 8 * 1024;
const MAX_RAW_CHARS = 64 * 1024;
const MAX_DRAFT_BYTES = 512 * 1024;
const MAX_SNAPSHOT_CHARS = 900 * 1024;

export interface AgentRecoveryState {
  messages: ChatMessage[];
  input: string;
}

export interface BuilderRecoveryState {
  phase: BuilderPhase;
  brief: string;
  raw: string;
  plan: BuilderPlan | null;
  builtFiles: VFile[];
  stageNotice: string;
}

export interface SessionRecoverySnapshot {
  version: 1;
  savedAt: number;
  view: ViewId;
  agent?: AgentRecoveryState;
  builder?: BuilderRecoveryState;
}

export interface BuildSessionRecoveryInput {
  view: ViewId;
  agentMessages: ChatMessage[];
  agentInput: string;
  builderPhase: BuilderPhase;
  builderBrief: string;
  builderRaw: string;
  builderPlan: BuilderPlan | null;
  builderBuiltFiles: VFile[];
  builderStageNotice: string;
}

export function loadSessionRecovery(): SessionRecoverySnapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionRecoverySnapshot;
    if (parsed?.version !== 1 || typeof parsed.savedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSessionRecovery(snapshot: SessionRecoverySnapshot | null) {
  try {
    if (!snapshot) {
      localStorage.removeItem(KEY);
      return;
    }
    let raw = JSON.stringify(snapshot);
    if (raw.length > MAX_SNAPSHOT_CHARS && snapshot.builder?.raw) {
      snapshot = {
        ...snapshot,
        builder: { ...snapshot.builder, raw: snapshot.builder.raw.slice(-MAX_RAW_CHARS / 2) },
      };
      raw = JSON.stringify(snapshot);
    }
    if (raw.length > MAX_SNAPSHOT_CHARS && snapshot.builder?.builtFiles?.length) {
      snapshot = {
        ...snapshot,
        builder: { ...snapshot.builder, builtFiles: boundedFiles(snapshot.builder.builtFiles, MAX_DRAFT_BYTES / 2) },
      };
      raw = JSON.stringify(snapshot);
    }
    if (raw.length > MAX_SNAPSHOT_CHARS) return;
    localStorage.setItem(KEY, raw);
  } catch {
    // Local storage can be disabled or full. Session recovery is best-effort.
  }
}

export function clearSessionRecovery() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // best effort
  }
}

export function buildSessionRecovery(input: BuildSessionRecoveryInput): SessionRecoverySnapshot | null {
  const agent = buildAgentRecovery(input.agentMessages, input.agentInput);
  const builder = buildBuilderRecovery(input);
  if (!agent && !builder) return null;
  return {
    version: 1,
    savedAt: Date.now(),
    view: input.view,
    ...(agent ? { agent } : {}),
    ...(builder ? { builder } : {}),
  };
}

export function sessionRecoverySummary(snapshot: SessionRecoverySnapshot) {
  const parts: string[] = [];
  const messages = snapshot.agent?.messages.length ?? 0;
  const files = snapshot.builder?.builtFiles.length ?? 0;
  if (messages > 0) parts.push(`${messages} agent message${messages === 1 ? "" : "s"}`);
  if (snapshot.agent?.input) parts.push("draft agent prompt");
  if (snapshot.builder?.plan) parts.push("project plan");
  if (files > 0) parts.push(`${files} generated file${files === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "previous DevLab session";
}

function buildAgentRecovery(messages: ChatMessage[], input: string): AgentRecoveryState | null {
  const keptMessages = messages
    .filter((message) => message.role === "user" || message.role === "model")
    .slice(-MAX_AGENT_MESSAGES)
    .map((message) => ({
      ...message,
      content: boundText(message.content, MAX_MESSAGE_CHARS),
    }));
  const keptInput = boundText(input, MAX_INPUT_CHARS);
  if (keptMessages.length === 0 && !keptInput.trim()) return null;
  return { messages: keptMessages, input: keptInput };
}

function buildBuilderRecovery(input: BuildSessionRecoveryInput): BuilderRecoveryState | null {
  const hasBuilderProgress = !!(
    input.builderBrief.trim()
    || input.builderRaw.trim()
    || input.builderPlan
    || input.builderBuiltFiles.length > 0
    || input.builderStageNotice.trim()
  );
  if (!hasBuilderProgress) return null;
  const phase = input.builderPhase === "planning" && !input.builderPlan ? "brief" : input.builderPhase;
  return {
    phase,
    brief: boundText(input.builderBrief, MAX_INPUT_CHARS),
    raw: boundText(input.builderRaw, MAX_RAW_CHARS),
    plan: input.builderPlan ? boundPlan(input.builderPlan) : null,
    builtFiles: boundedFiles(input.builderBuiltFiles, MAX_DRAFT_BYTES),
    stageNotice: boundText(input.builderStageNotice, 2_000),
  };
}

function boundPlan(plan: BuilderPlan): BuilderPlan {
  return {
    summary: boundText(plan.summary, 8_000),
    stack: plan.stack.slice(0, 20).map((value) => boundText(value, 256)),
    steps: plan.steps.slice(0, 12).map((step) => ({
      title: boundText(step.title, 512),
      detail: boundText(step.detail, 2_000),
    })),
    commands: plan.commands.slice(0, 16).map((command) => boundText(command, 2_000)),
    files: plan.files.slice(0, 20).map((file) => ({
      path: boundText(file.path, 512),
      description: boundText(file.description, 2_000),
    })),
  };
}

function boundedFiles(files: VFile[], maxBytes: number): VFile[] {
  const encoder = new TextEncoder();
  let total = 0;
  const kept: VFile[] = [];
  for (const file of files) {
    const bytes = encoder.encode(file.content).length;
    if (total + bytes > maxBytes) break;
    kept.push({
      path: boundText(file.path, 512),
      language: boundText(file.language, 128),
      content: file.content,
    });
    total += bytes;
  }
  return kept;
}

function boundText(value: string, maxChars: number) {
  return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}
