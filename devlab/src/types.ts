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

export type AgentContextSource = "workspace-file" | "repo-map";

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

export interface BuildPlanStep {
  id: string;
  title: string;
  detail: string;
  status: "pending" | "running" | "done" | "error";
  kind: "command" | "file" | "note";
  payload?: string;
}
