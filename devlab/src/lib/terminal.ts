import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type TerminalSessionStatus = "running" | "exited" | "failed";

export interface TerminalSessionInfo {
  id: string;
  shell: string;
  cwd: string;
  pid: number | null;
  status: TerminalSessionStatus;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  startedAtMs: number;
}

export interface TerminalSnapshot {
  session: TerminalSessionInfo;
  output: number[];
  outputStart: number;
  outputEnd: number;
  truncated: boolean;
}

export interface TerminalOutputEvent {
  sessionId: string;
  offset: number;
  data: number[];
}

export interface TerminalExitEvent {
  sessionId: string;
  status: TerminalSessionStatus;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
}

export interface NativeTerminalError {
  code: string;
  message: string;
}

export class TerminalCommandError extends Error {
  readonly code: string;

  constructor(error: NativeTerminalError) {
    super(error.message);
    this.name = "TerminalCommandError";
    this.code = error.code;
  }
}

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(name, args).catch((error: unknown) => {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && "message" in error
      && typeof error.code === "string"
      && typeof error.message === "string"
    ) {
      throw new TerminalCommandError({ code: error.code, message: error.message });
    }
    throw new TerminalCommandError({
      code: "native_terminal_command_failed",
      message: typeof error === "string" ? error : "The native terminal command failed.",
    });
  });
}

export function createTerminal(cols: number, rows: number): Promise<TerminalSessionInfo> {
  return command("terminal_create", { cols, rows });
}

export function listTerminals(): Promise<TerminalSessionInfo[]> {
  return command("terminal_list");
}

export function getTerminalSnapshot(sessionId: string): Promise<TerminalSnapshot> {
  return command("terminal_snapshot", { sessionId });
}

export function writeTerminal(sessionId: string, data: string | Uint8Array): Promise<void> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return command("terminal_write", { sessionId, data: Array.from(bytes) });
}

export function resizeTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  return command("terminal_resize", { sessionId, cols, rows });
}

export function clearTerminal(sessionId: string): Promise<number> {
  return command("terminal_clear", { sessionId });
}

export function killTerminal(sessionId: string): Promise<void> {
  return command("terminal_kill", { sessionId });
}

export function closeTerminal(sessionId: string): Promise<void> {
  return command("terminal_close", { sessionId });
}

export function onTerminalOutput(
  handler: (event: TerminalOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalOutputEvent>("terminal-output", (event) => handler(event.payload));
}

export function onTerminalExit(
  handler: (event: TerminalExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalExitEvent>("terminal-exit", (event) => handler(event.payload));
}
