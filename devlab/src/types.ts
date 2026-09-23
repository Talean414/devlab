export type ViewId =
  | "welcome"
  | "explorer"
  | "builder"
  | "canvas"
  | "editor"
  | "agent"
  | "healer"
  | "migrate"
  | "vision"
  | "live"
  | "terminal"
  | "database"
  | "api"
  | "docker"
  | "git"
  | "cicd"
  | "deploy"
  | "tools"
  | "preview"
  | "setup"
  | "settings";

export interface ChatMessage {
  id: string;
  role: "user" | "model" | "system";
  content: string;
  ts: number;
}

export type AgentContextSource = "workspace-file" | "repo-map" | "code-outline" | "code-map" | "code-graph" | "architecture" | "dependency-inventory";

export interface AgentContextFile {
  path: string;
  content: string;
  language: string;
  revision: string;
  size: number;
  truncated: boolean;
  source?: AgentContextSource;
}


export type BuilderPhase = "brief" | "planning" | "review" | "done";

export interface BuilderPlan {
  summary: string;
  stack: string[];
  steps: { title: string; detail: string }[];
  commands: string[];
  files: { path: string; description: string }[];
}

export interface ProjectTemplate {
  id: string;
  name: string;
  stack: string;
  icon: string;
  description: string;
  commands: string[];
  tags: string[];
  lang?: string;
}

export interface ToolItem {
  id: string;
  name: string;
  category: string;
  replaces: string;
  description: string;
  icon: string;
  vsix?: string;
  install?: string;
  status: "baked-in" | "one-click" | "external";
}

export interface Runtime {
  id: string;
  name: string;
  version: string;
  category: string;
  install: string;
  verify: string;
  description: string;
}

export interface CiTemplate {
  id: string;
  name: string;
  provider: string;
  description: string;
  filename: string;
  yaml: string;
}

export interface DeployProvider {
  id: string;
  name: string;
  tagline: string;
  freeTier: string;
  cliInstall: string;
  deployCmd: string;
  docs: string;
  tokenLabel: string;
  supports: string[];
  color: string;
}

// ── Virtual file system for the built-in editor ──
export interface VFile {
  path: string;
  content: string;
  language: string;
}

export type OpenGeneratedDrafts = (files: VFile[], summary?: string) => Promise<boolean>;

// Session-only, metadata-only record of one Builder task batch staged for Editor review.
// It never stores draft contents and is intentionally excluded from recovery snapshots.
export interface BuilderTaskStagingRecord {
  taskId: string;
  taskTitle: string;
  stagedAtMs: number;
  summary: string;
  files: { path: string; bytes: number }[];
  totalBytes: number;
}

// Session-only, metadata-only outcome reported by the Editor after one explicit reviewed-draft apply.
// It carries no file contents and is intentionally excluded from recovery snapshots.
// Session-only request from Project Builder asking Self-Healing Tests to pre-select a discovered
// backend-owned profile for one task batch. It never triggers execution; the user must still click Run.
export interface VerificationHandoffRequest {
  taskId: string;
  taskTitle: string;
  appliedPaths: string[];
  recommendedProfileIds: string[];
  requestedAtMs: number;
  // "verify" pre-selects a profile to run. "repair" additionally offers the task's applied paths as
  // one-click repair-target candidates once a real failing run exists in Self-Healing Tests.
  intent: "verify" | "repair";
  // Metadata of the failed run that prompted a repair intent; informational only, never re-used as evidence.
  priorRun?: { status: "failed" | "timeout"; exitCode: number | null; command: string; ranAtMs: number };
}

// Session-only, metadata-only outcome of one real backend-owned test run reported by Self-Healing Tests.
// It intentionally omits stdout/stderr and is excluded from recovery snapshots.
export interface VerificationRunOutcome {
  taskId: string | null;
  profileId: string;
  profileLabel: string;
  command: string;
  status: "passed" | "failed" | "timeout";
  exitCode: number | null;
  elapsedMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
  ranAtMs: number;
}

// Session-only, path-only summary of the last draft policy evaluation at the shared staging gate.
export interface DraftPolicyGateSummary {
  summary: string;
  refused: { path: string; kind: string }[];
  evaluatedAtMs: number;
}

export interface ReviewedDraftApplyOutcome {
  path: string;
  action: "Created" | "Updated";
  appliedAtMs: number;
  bytes: number;
  lines: number;
  revision: string;
  size: number;
}

export interface BuildPlanStep {
  id: string;
  title: string;
  detail: string;
  status: "pending" | "running" | "done" | "error";
  kind: "command" | "file" | "note";
  payload?: string;
}
