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

export function recordAgentDraft(
  summary: string,
  files: AgentDraftFileMetadata[],
): Promise<AgentDraftSession> {
  return invoke<AgentDraftSession>("agent_tools_record_draft", { summary, files });
}
