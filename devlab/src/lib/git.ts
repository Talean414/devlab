import { invoke } from "@tauri-apps/api/core";
import type { NativeCommandError } from "./workspace";

export type GitProvider = "github" | "gitlab" | "bitbucket";

export interface GitStateMessage {
  code: string;
  message: string;
}

export interface GitChange {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted" | "type-changed" | "changed";
  staged: boolean;
  unstaged: boolean;
  conflicted: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  subject: string;
}

export interface GitBranch {
  name: string;
  kind: "local" | "remote";
  current: boolean;
  hash: string;
  upstream: string | null;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  provider: GitProvider | null;
  usesSsh: boolean;
}

export interface GitRepository {
  root: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  userName: string | null;
  userEmail: string | null;
  changes: GitChange[];
  commits: GitCommit[];
  branches: GitBranch[];
  remotes: GitRemote[];
}

export interface GitSnapshot {
  gitInstalled: boolean;
  gitVersion: string | null;
  workspacePath: string | null;
  state: GitStateMessage;
  repository: GitRepository | null;
}

export interface GitDiff {
  path: string;
  staged: string;
  unstaged: string;
}

export interface GitOperationResult {
  message: string;
  output: string;
  repository: GitRepository;
}

export interface CredentialStatus {
  provider: GitProvider;
  host: string;
  configured: boolean;
  backend: string;
}

export class GitCommandError extends Error {
  readonly code: string;

  constructor(error: NativeCommandError) {
    super(error.message);
    this.name = "GitCommandError";
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
      throw new GitCommandError({ code: error.code, message: error.message });
    }
    throw new GitCommandError({
      code: "native_command_failed",
      message: typeof error === "string" ? error : "The native Git command failed.",
    });
  });
}

export function getGitSnapshot(): Promise<GitSnapshot> {
  return command("git_repository_snapshot");
}

export function stageGitPaths(paths: string[]): Promise<GitOperationResult> {
  return command("git_stage_paths", { paths });
}

export function unstageGitPaths(paths: string[]): Promise<GitOperationResult> {
  return command("git_unstage_paths", { paths });
}

export function stageAllGitChanges(): Promise<GitOperationResult> {
  return command("git_stage_all");
}

export function unstageAllGitChanges(): Promise<GitOperationResult> {
  return command("git_unstage_all");
}

export function commitGitChanges(message: string): Promise<GitOperationResult> {
  return command("git_commit", { message });
}

export function getGitDiff(path: string): Promise<GitDiff> {
  return command("git_diff", { path });
}

export function fetchGitRemote(remote: string): Promise<GitOperationResult> {
  return command("git_fetch", { remote });
}

export function pullGitRemote(remote: string): Promise<GitOperationResult> {
  return command("git_pull", { remote });
}

export function pushGitRemote(remote: string): Promise<GitOperationResult> {
  return command("git_push", { remote });
}

export function getGitCredentialStatus(provider: GitProvider): Promise<CredentialStatus> {
  return command("git_credential_status", { provider });
}

export function storeGitCredential(provider: GitProvider, token: string): Promise<CredentialStatus> {
  return command("git_credential_store", { provider, token });
}

export function deleteGitCredential(provider: GitProvider): Promise<CredentialStatus> {
  return command("git_credential_delete", { provider });
}
