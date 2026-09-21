import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface WorkspaceInfo {
  name: string;
  path: string;
}

export type WorkspaceEntryKind = "file" | "directory" | "symlink" | "other";

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
  size: number | null;
  modifiedMs: number | null;
  readonly: boolean;
}

export interface WorkspaceDocument {
  path: string;
  content: string;
  revision: string;
  size: number;
  modifiedMs: number | null;
}

export interface WorkspaceChange {
  kind: "create" | "modify" | "remove" | "other";
  paths: string[];
}

export interface NativeCommandError {
  code: string;
  message: string;
}

export class WorkspaceCommandError extends Error {
  readonly code: string;

  constructor(error: NativeCommandError) {
    super(error.message);
    this.name = "WorkspaceCommandError";
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
      throw new WorkspaceCommandError({ code: error.code, message: error.message });
    }
    throw new WorkspaceCommandError({
      code: "native_command_failed",
      message: typeof error === "string" ? error : "The native workspace command failed.",
    });
  });
}

export function selectWorkspace(): Promise<WorkspaceInfo | null> {
  return command("workspace_select");
}

export function getCurrentWorkspace(): Promise<WorkspaceInfo | null> {
  return command("workspace_current");
}

export function closeWorkspace(): Promise<void> {
  return command("workspace_close");
}

export function listDirectory(relativePath = ""): Promise<WorkspaceEntry[]> {
  return command("workspace_list", { relativePath });
}

export function readWorkspaceFile(relativePath: string): Promise<WorkspaceDocument> {
  return command("workspace_read", { relativePath });
}

export function writeWorkspaceFile(
  relativePath: string,
  content: string,
  expectedRevision: string | null,
): Promise<WorkspaceDocument> {
  return command("workspace_write", { relativePath, content, expectedRevision });
}

export function applyReviewedDraftToWorkspace(
  relativePath: string,
  content: string,
  expectedRevision: string | null,
): Promise<WorkspaceDocument> {
  return command("workspace_apply_reviewed_draft", { relativePath, content, expectedRevision });
}

export function createWorkspaceFile(relativePath: string): Promise<WorkspaceDocument> {
  return command("workspace_create_file", { relativePath });
}

export function createWorkspaceDirectory(relativePath: string): Promise<void> {
  return command("workspace_create_directory", { relativePath });
}

export function renameWorkspaceEntry(fromPath: string, toPath: string): Promise<void> {
  return command("workspace_rename", { fromPath, toPath });
}

export function deleteWorkspaceEntry(relativePath: string): Promise<void> {
  return command("workspace_delete", { relativePath });
}

export function onWorkspaceChange(
  handler: (change: WorkspaceChange) => void,
): Promise<UnlistenFn> {
  return listen<WorkspaceChange>("workspace-changed", (event) => handler(event.payload));
}
