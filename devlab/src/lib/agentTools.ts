import { invoke } from "@tauri-apps/api/core";

export interface AgentDraftFileMetadata {
  path: string;
  bytes: number;
}

export interface AgentDraftSession {
  id: number;
  fileCount: number;
  totalBytes: number;
  summary: string;
}

export interface AgentContextFileMetadata {
  path: string;
  bytes: number;
  truncated: boolean;
}

export interface AgentContextSession {
  id: number;
  fileCount: number;
  totalBytes: number;
  truncatedCount: number;
}

export function recordAgentDraft(
  summary: string,
  files: AgentDraftFileMetadata[],
): Promise<AgentDraftSession> {
  return invoke<AgentDraftSession>("agent_tools_record_draft", { summary, files });
}

export function recordAgentContext(
  files: AgentContextFileMetadata[],
): Promise<AgentContextSession> {
  return invoke<AgentContextSession>("agent_tools_record_context", { files });
}
