import { invoke } from "@tauri-apps/api/core";

export interface AgentAuditEvent {
  id: number;
  timestampMs: number;
  workspaceName: string | null;
  kind: string;
  action: string;
  target: string;
  outcome: string;
  summary: string;
}

export function listAgentAudit(limit = 20): Promise<AgentAuditEvent[]> {
  return invoke<AgentAuditEvent[]>("agent_audit_list", { limit });
}
