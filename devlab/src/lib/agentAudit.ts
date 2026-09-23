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

export const AGENT_AUDIT_METADATA_NOTE = "Metadata only — file contents, captured outputs and credentials are not included.";

export type AgentAuditKindFilter = "all" | "agent-context" | "multi-file-draft" | "reviewed-draft";

export const AGENT_AUDIT_KIND_FILTERS: { value: AgentAuditKindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "agent-context", label: "Context" },
  { value: "multi-file-draft", label: "Draft staging" },
  { value: "reviewed-draft", label: "Reviewed writes" },
];

export function isAgentRelevantAudit(event: AgentAuditEvent): boolean {
  return event.kind === "agent-context" || event.kind === "multi-file-draft" || event.kind === "reviewed-draft";
}

export function filterAgentAuditEvents(events: AgentAuditEvent[], kindFilter: AgentAuditKindFilter, query: string): AgentAuditEvent[] {
  const normalizedQuery = query.trim().toLowerCase();
  return events.filter((event) => {
    if (kindFilter !== "all" && event.kind !== kindFilter) return false;
    if (!normalizedQuery) return true;
    return [event.kind, event.action, event.target, event.outcome, event.summary]
      .some((value) => value.toLowerCase().includes(normalizedQuery));
  });
}

export function formatAgentAuditShortTime(timestampMs: number): string {
  if (!timestampMs) return "unknown time";
  return new Date(timestampMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatAgentAuditFullTime(timestampMs: number): string {
  if (!timestampMs) return "unknown time";
  return new Date(timestampMs).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function agentAuditToneClass(outcome: string): string {
  if (["success", "passed", "review", "read-only"].includes(outcome)) return "text-emerald-300";
  if (["failed", "error", "timeout"].includes(outcome)) return "text-rose-300";
  return "text-amber-300";
}

export function buildAgentAuditMetadataExport(
  events: AgentAuditEvent[],
  context: { label?: string; filters?: Record<string, string> } = {},
): string {
  return JSON.stringify({
    label: context.label ?? "DevLab Agent audit metadata",
    generatedAt: new Date().toISOString(),
    note: AGENT_AUDIT_METADATA_NOTE,
    filters: context.filters ?? {},
    eventCount: events.length,
    events: events.map((event) => ({
      id: event.id,
      timestampMs: event.timestampMs,
      timestamp: new Date(event.timestampMs).toISOString(),
      workspaceName: event.workspaceName,
      kind: event.kind,
      action: event.action,
      target: event.target,
      outcome: event.outcome,
      summary: event.summary,
    })),
  }, null, 2);
}

export function listAgentAudit(limit = 20): Promise<AgentAuditEvent[]> {
  return invoke<AgentAuditEvent[]>("agent_audit_list", { limit });
}
