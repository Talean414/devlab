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

export interface DbConnection {
  id: string;
  name: string;
  engine: "PostgreSQL" | "MySQL" | "Redis" | "MongoDB" | "SQLite";
  host: string;
  port: number;
  status: "connected" | "idle";
}

// ── Virtual file system for the built-in editor ──
export interface VFile {
  path: string;
  content: string;
  language: string;
}

export interface BuildPlanStep {
  id: string;
  title: string;
  detail: string;
  status: "pending" | "running" | "done" | "error";
  kind: "command" | "file" | "note";
  payload?: string;
}
