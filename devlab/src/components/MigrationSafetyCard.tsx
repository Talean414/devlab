import { useMemo, useState } from "react";
import { Copy, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import {
  analyzeMigrationSafety,
  renderMigrationSafety,
  summarizeMigrationSafety,
  type SafetyFinding as MigrationSafetyFinding,
  type MigrationSafetyReport,
  type SqlDialect,
} from "../lib/migrationSafety";

export interface MigrationSafetySource {
  /** Label shown next to the findings (usually the draft path). */
  label: string;
  sql: string;
  dialectHint?: string | SqlDialect;
}

interface Props {
  sources: MigrationSafetySource[];
  /** Compact mode is used inside the Editor review gate sidebar. */
  compact?: boolean;
}

interface AnalyzedSource extends MigrationSafetySource {
  report: MigrationSafetyReport;
}

const MAX_SOURCES = 8;

const SEVERITY_LABEL: Record<MigrationSafetyFinding["severity"], string> = {
  danger: "DANGER",
  warning: "WARNING",
  info: "INFO",
};

const SEVERITY_CLASS: Record<MigrationSafetyFinding["severity"], string> = {
  danger: "text-rose-300",
  warning: "text-amber-300",
  info: "text-zinc-400",
};

function toneFor(reports: MigrationSafetyReport[]) {
  if (reports.some((report) => report.dangers > 0)) return "danger" as const;
  if (reports.some((report) => report.warnings > 0)) return "warning" as const;
  return "ok" as const;
}

/**
 * Renders lexical migration safety notes for one or more SQL drafts.
 * Analysis is pure and synchronous: nothing is executed and no database is contacted.
 */
export function MigrationSafetyCard({ sources, compact = false }: Props) {
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const analyzed = useMemo<AnalyzedSource[]>(
    () => sources.slice(0, MAX_SOURCES).map((source) => ({ ...source, report: analyzeMigrationSafety(source.sql, { dialectHint: source.dialectHint }) })),
    [sources],
  );
  const skippedSources = Math.max(0, sources.length - analyzed.length);
  const tone = toneFor(analyzed.map((item) => item.report));
  const totals = analyzed.reduce(
    (acc, item) => ({
      statements: acc.statements + item.report.statementCount,
      dangers: acc.dangers + item.report.dangers,
      warnings: acc.warnings + item.report.warnings,
      irreversible: acc.irreversible + item.report.rollback.filter((step) => !step.reversible).length,
    }),
    { statements: 0, dangers: 0, warnings: 0, irreversible: 0 },
  );

  async function copyNotes() {
    setNotice(null);
    if (!navigator.clipboard?.writeText) {
      setNotice({ kind: "error", text: "Clipboard access is unavailable in this environment. Nothing was copied." });
      return;
    }
    const markdown = analyzed
      .map((item) => (analyzed.length > 1 ? `<!-- ${item.label} -->\n${renderMigrationSafety(item.report)}` : renderMigrationSafety(item.report)))
      .join("\n\n---\n\n");
    try {
      await navigator.clipboard.writeText(markdown);
      setNotice({ kind: "ok", text: "Copied migration safety notes as markdown. Nothing was executed." });
    } catch (error) {
      setNotice({ kind: "error", text: `Could not copy safety notes: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  if (analyzed.length === 0) return null;

  const frame =
    tone === "danger"
      ? "border-rose-500/25 bg-rose-500/[0.05]"
      : tone === "warning"
        ? "border-amber-500/25 bg-amber-500/[0.05]"
        : "border-emerald-500/20 bg-emerald-500/[0.05]";
  const headingColor = tone === "danger" ? "text-rose-200" : tone === "warning" ? "text-amber-200" : "text-emerald-200";
  const Icon = tone === "danger" ? ShieldAlert : tone === "warning" ? TriangleAlert : ShieldCheck;
  const findingLimit = compact ? 4 : 12;
  const checklistLimit = compact ? 4 : 12;

  return (
    <div className={`rounded-xl border p-3 ${compact ? "text-[11px]" : "text-[12.5px]"} ${frame}`}>
      <div className="flex items-center justify-between gap-2">
        <div className={`flex items-center gap-2 font-semibold ${headingColor}`}>
          <Icon className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          Migration safety review
        </div>
        <button
          onClick={() => { void copyNotes(); }}
          className={`inline-flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 font-semibold hover:bg-white/5 ${compact ? "text-[10.5px]" : "text-[11px]"} ${headingColor}`}
        >
          <Copy className="h-3 w-3" /> Copy notes
        </button>
      </div>
      <p className={`mt-1 leading-relaxed ${compact ? "text-[10.5px]" : "text-[11.5px]"} text-zinc-400`}>
        Lexical read of the SQL, not a dry run: DevLab did not contact a database or execute anything. Rehearse on a staging snapshot before production.
      </p>
      <div className={`mt-2 rounded-lg border border-white/10 bg-black/15 px-2 py-1.5 ${compact ? "text-[10.5px]" : "text-[11.5px]"} text-zinc-300`}>
        {analyzed.length === 1
          ? summarizeMigrationSafety(analyzed[0].report)
          : `${analyzed.length} SQL drafts · ${totals.statements} statements · ${totals.dangers} danger${totals.dangers === 1 ? "" : "s"} · ${totals.warnings} warning${totals.warnings === 1 ? "" : "s"}${totals.irreversible > 0 ? ` · ${totals.irreversible} irreversible without backup` : ""}`}
        {skippedSources > 0 ? ` · ${skippedSources} more draft${skippedSources === 1 ? "" : "s"} not analysed (limit ${MAX_SOURCES})` : ""}
      </div>

      {analyzed.map((item) => {
        const key = item.label;
        const isOpen = expanded[key] ?? !compact;
        const ranked = [...item.report.findings].sort((a, b) => rank(a) - rank(b) || a.statement - b.statement);
        const shown = ranked.filter((finding) => !compact || finding.severity !== "info").slice(0, findingLimit);
        const hidden = ranked.length - shown.length;
        const irreversible = item.report.rollback.filter((step) => !step.reversible);
        return (
          <div key={key} className="mt-2">
            {analyzed.length > 1 && (
              <div className="truncate font-mono text-[10.5px] text-zinc-400" title={item.label}>
                {item.label} · {summarizeMigrationSafety(item.report)}
              </div>
            )}
            {shown.length > 0 && (
              <ul className="mt-1 space-y-1">
                {shown.map((finding, index) => (
                  <li key={`${finding.statement}-${index}`} className="leading-snug text-zinc-200">
                    <span className={`font-semibold ${SEVERITY_CLASS[finding.severity]}`}>{SEVERITY_LABEL[finding.severity]}</span>
                    <span className="text-zinc-500"> · line {finding.line} · </span>
                    <span title={finding.detail}>{finding.title}</span>
                    {!compact && <div className={`text-[11px] text-zinc-400`}>{finding.detail}{finding.suggestion ? ` Suggestion: ${finding.suggestion}` : ""}</div>}
                  </li>
                ))}
              </ul>
            )}
            {shown.length === 0 && item.report.statementCount > 0 && (
              <div className="mt-1 text-zinc-400">No lock or data-loss risks recognised in this draft. Rehearse it on staging anyway.</div>
            )}
            {hidden > 0 && (
              <div className="mt-1 text-[10.5px] text-zinc-500">{hidden} more finding{hidden === 1 ? "" : "s"} in the copied notes.</div>
            )}
            {(!compact || isOpen) && (
              <div className="mt-2 space-y-2">
                <div>
                  <div className={`font-semibold ${headingColor}`}>Rollback notes</div>
                  {irreversible.length > 0 && (
                    <div className="text-rose-200/90">
                      {irreversible.length} step{irreversible.length === 1 ? "" : "s"} cannot be reversed from the schema alone — the backup is the rollback plan.
                    </div>
                  )}
                  <ul className="mt-1 space-y-0.5 text-zinc-300">
                    {item.report.rollback.slice(0, compact ? 4 : 12).map((step) => (
                      <li key={step.statement} className="leading-snug">
                        <span className="text-zinc-500">#{step.statement}</span> {step.summary}
                        {step.inverse && <code className="ml-1 rounded bg-black/25 px-1 font-mono text-[10.5px] text-zinc-200">{step.inverse}</code>}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className={`font-semibold ${headingColor}`}>Environment and rollout checklist</div>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-zinc-300">
                    {item.report.checklist.slice(0, checklistLimit).map((entry, index) => <li key={index} className="leading-snug">{entry}</li>)}
                  </ul>
                </div>
              </div>
            )}
            {compact && item.report.statementCount > 0 && (
              <button
                onClick={() => setExpanded((current) => ({ ...current, [key]: !isOpen }))}
                className="mt-1 text-[10.5px] font-semibold text-zinc-300 hover:text-white"
              >
                {isOpen ? "Hide rollback notes and checklist" : "Show rollback notes and checklist"}
              </button>
            )}
          </div>
        );
      })}

      {notice && (
        <div className={`mt-2 text-[10.5px] ${notice.kind === "ok" ? "text-emerald-300" : "text-amber-300"}`}>{notice.text}</div>
      )}
    </div>
  );
}

function rank(finding: MigrationSafetyFinding) {
  return finding.severity === "danger" ? 0 : finding.severity === "warning" ? 1 : 2;
}
