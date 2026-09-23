import type { AgentAuditEvent } from "../lib/agentAudit";
import {
  AGENT_AUDIT_METADATA_NOTE,
  agentAuditToneClass,
  formatAgentAuditFullTime,
  formatAgentAuditShortTime,
} from "../lib/agentAudit";

export function AgentAuditCard({ event, compact = false }: { event: AgentAuditEvent; compact?: boolean }) {
  return (
    <div className={`rounded-lg border p-2 ${compact ? "border-white/5 bg-white/[0.02]" : "border-white/10 bg-black/15"}`}>
      <div className="flex items-center gap-2 text-[10.5px]">
        <span className="font-mono text-zinc-500">{formatAgentAuditShortTime(event.timestampMs)}</span>
        <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10.5px] text-cyan-200">{event.kind}</span>
        <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-400">{event.action}</span>
        <span className={`ml-auto font-semibold ${agentAuditToneClass(event.outcome)}`}>{event.outcome}</span>
      </div>
      <div className={`mt-1 truncate font-mono text-[10.5px] ${compact ? "text-zinc-300" : "text-zinc-500"}`}>{event.target}</div>
      <div className={`mt-1 text-[10.5px] leading-relaxed ${compact ? "line-clamp-2 text-zinc-600" : "text-zinc-300/80"}`}>{event.summary}</div>
      <details className="mt-1.5 rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1 text-[10.5px] text-zinc-500">
        <summary className="cursor-pointer select-none text-zinc-400 hover:text-zinc-200">Metadata details</summary>
        <dl className="mt-1.5 grid gap-x-3 gap-y-1 sm:grid-cols-[5.5rem_1fr]">
          <dt>Audit ID</dt><dd className="font-mono text-zinc-300">{event.id}</dd>
          <dt>Timestamp</dt><dd className="font-mono text-zinc-300">{formatAgentAuditFullTime(event.timestampMs)}</dd>
          <dt>Workspace</dt><dd className="truncate font-mono text-zinc-300">{event.workspaceName ?? "workspace not recorded"}</dd>
          <dt>Kind</dt><dd className="font-mono text-zinc-300">{event.kind}</dd>
          <dt>Action</dt><dd className="font-mono text-zinc-300">{event.action}</dd>
          <dt>Outcome</dt><dd className="font-mono text-zinc-300">{event.outcome}</dd>
          <dt>Target</dt><dd className="break-all font-mono text-zinc-300">{event.target}</dd>
          <dt>Summary</dt><dd className="break-words text-zinc-300">{event.summary}</dd>
        </dl>
        <div className="mt-1.5 text-zinc-600">{AGENT_AUDIT_METADATA_NOTE}</div>
      </details>
    </div>
  );
}
