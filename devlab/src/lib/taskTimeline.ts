// Phase 8Q — session-only Builder task run timeline.
//
// Pure derivation over metadata that already lives in renderer session state:
//   plan  → the approved task DAG (task ids, titles, dependencies, reviewed file targets)
//   draft → which reviewed targets currently have an in-memory generated draft
//   stage → the Builder task staging ledger (path/byte metadata only)
//   apply → Editor reviewed-draft apply outcomes (path/action/bytes/revision metadata only)
//   verify→ Self-Healing Tests run outcomes (status/exit/timing metadata only) and handoff requests
//   repair→ repair-intent handoffs and later applies on the task's targets after a failed run
//
// It reads no files, invokes no native command, executes nothing, and persists nothing. The export
// text is metadata-only: it never includes draft contents, workspace contents, diffs or captured output.

import type {
  BuilderTaskStagingRecord,
  ReviewedDraftApplyOutcome,
  VerificationHandoffRequest,
  VerificationRunOutcome,
} from "../types";

export const MAX_TIMELINE_EVENTS_PER_TASK = 48;
export const MAX_HANDOFF_HISTORY = 64;

export type TimelinePhaseId = "plan" | "draft" | "stage" | "apply" | "verify" | "repair";
export type TimelinePhaseState = "done" | "partial" | "pending" | "stale" | "failed" | "not-applicable";

export const TIMELINE_PHASES: { id: TimelinePhaseId; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "draft", label: "Draft" },
  { id: "stage", label: "Stage" },
  { id: "apply", label: "Apply" },
  { id: "verify", label: "Verify" },
  { id: "repair", label: "Repair" },
];

export interface TimelineTaskInput {
  id: string;
  title: string;
  dependsOn: string[];
  reviewedFileTargets: string[];
}

export interface TimelineInputs {
  tasks: TimelineTaskInput[];
  // Paths (and byte sizes) of generated drafts currently held in Builder memory.
  draftPaths: { path: string; bytes: number }[];
  stagingLedger: BuilderTaskStagingRecord[];
  applyOutcomes: ReviewedDraftApplyOutcome[];
  runOutcomes: VerificationRunOutcome[];
  handoffHistory: VerificationHandoffRequest[];
}

export interface TimelinePhase {
  id: TimelinePhaseId;
  label: string;
  state: TimelinePhaseState;
  atMs: number | null;
  detail: string;
}

export interface TimelineEvent {
  atMs: number;
  phase: TimelinePhaseId;
  label: string;
}

export interface TaskTimeline {
  taskId: string;
  title: string;
  phases: TimelinePhase[];
  events: TimelineEvent[];
  currentPhase: TimelinePhaseId;
  nextAction: string;
  loopIterations: number;
}

export interface TaskTimelineSummary {
  tasks: TaskTimeline[];
  summary: string;
  counts: Record<TimelinePhaseId, number>;
  exportText: string;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function latestBy<T>(items: T[], at: (item: T) => number): T | null {
  let best: T | null = null;
  for (const item of items) if (!best || at(item) > at(best)) best = item;
  return best;
}

function iso(ms: number | null) {
  return ms ? new Date(ms).toISOString() : "—";
}

export function buildTaskTimeline(task: TimelineTaskInput, inputs: TimelineInputs): TaskTimeline {
  const targets = task.reviewedFileTargets;
  const targetSet = new Set(targets);
  const draftByPath = new Map(inputs.draftPaths.map((d) => [d.path, d]));
  const events: TimelineEvent[] = [];
  const phases: TimelinePhase[] = [];

  // plan
  phases.push({
    id: "plan",
    label: "Plan",
    state: "done",
    atMs: null,
    detail: `${plural(targets.length, "reviewed file target")}${task.dependsOn.length ? `; depends on ${task.dependsOn.join(", ")}` : "; no dependencies"}`,
  });

  // draft
  const drafted = targets.filter((p) => draftByPath.has(p));
  phases.push({
    id: "draft",
    label: "Draft",
    state: targets.length === 0 ? "not-applicable" : drafted.length === 0 ? "pending" : drafted.length === targets.length ? "done" : "partial",
    atMs: null,
    detail: targets.length === 0 ? "no reviewed targets" : `${drafted.length}/${targets.length} targets have an in-memory draft`,
  });

  // stage
  const stagings = inputs.stagingLedger.filter((r) => r.taskId === task.id);
  const lastStage = latestBy(stagings, (r) => r.stagedAtMs);
  for (const r of stagings) events.push({ atMs: r.stagedAtMs, phase: "stage", label: `staged ${plural(r.files.length, "file")} for Editor review` });
  phases.push({
    id: "stage",
    label: "Stage",
    state: targets.length === 0 ? "not-applicable" : lastStage ? "done" : "pending",
    atMs: lastStage?.stagedAtMs ?? null,
    detail: lastStage ? `${plural(stagings.length, "staging")}; last staged ${plural(lastStage.files.length, "file")}` : "not staged yet",
  });

  // apply
  const taskApplies = inputs.applyOutcomes.filter((o) => targetSet.has(o.path));
  const latestApplyByPath = new Map<string, ReviewedDraftApplyOutcome>();
  for (const o of taskApplies) {
    const cur = latestApplyByPath.get(o.path);
    if (!cur || o.appliedAtMs > cur.appliedAtMs) latestApplyByPath.set(o.path, o);
  }
  for (const o of taskApplies) events.push({ atMs: o.appliedAtMs, phase: "apply", label: `${o.action.toLowerCase()} ${o.path} (rev ${o.revision.slice(0, 12)})` });
  const appliedTargets = targets.filter((p) => latestApplyByPath.has(p));
  const staleTargets = appliedTargets.filter((p) => {
    const o = latestApplyByPath.get(p);
    const d = draftByPath.get(p);
    return Boolean(o && d && d.bytes !== o.bytes);
  });
  const lastApply = latestBy([...latestApplyByPath.values()], (o) => o.appliedAtMs);
  let applyState: TimelinePhaseState;
  if (targets.length === 0) applyState = "not-applicable";
  else if (appliedTargets.length === 0) applyState = "pending";
  else if (staleTargets.length > 0) applyState = "stale";
  else if (appliedTargets.length === targets.length) applyState = "done";
  else applyState = "partial";
  phases.push({
    id: "apply",
    label: "Apply",
    state: applyState,
    atMs: lastApply?.appliedAtMs ?? null,
    detail: targets.length === 0
      ? "nothing to apply"
      : `${appliedTargets.length}/${targets.length} applied via explicit Editor apply${staleTargets.length ? `; ${plural(staleTargets.length, "target")} changed since apply` : ""}`,
  });

  // verify
  const taskHandoffs = inputs.handoffHistory.filter((h) => h.taskId === task.id);
  for (const h of taskHandoffs) {
    events.push({ atMs: h.requestedAtMs, phase: h.intent === "repair" ? "repair" : "verify", label: `${h.intent} handoff sent to Self-Healing Tests (${plural(h.recommendedProfileIds.length, "profile")} suggested)` });
  }
  const taskRuns = inputs.runOutcomes.filter((r) => r.taskId === task.id);
  for (const r of taskRuns) events.push({ atMs: r.ranAtMs, phase: "verify", label: `real run ${r.status} — ${r.profileLabel} (exit ${r.exitCode ?? "none"}, ${r.elapsedMs} ms)` });
  const lastRun = latestBy(taskRuns, (r) => r.ranAtMs);
  const latestApplyMs = lastApply?.appliedAtMs ?? 0;
  const runSuperseded = Boolean(lastRun && (staleTargets.length > 0 || latestApplyMs > lastRun.ranAtMs));
  const verifyHandoffSent = taskHandoffs.some((h) => h.intent === "verify");
  let verifyState: TimelinePhaseState;
  if (targets.length === 0) verifyState = "not-applicable";
  else if (!lastRun) verifyState = "pending";
  else if (runSuperseded) verifyState = "stale";
  else verifyState = lastRun.status === "passed" ? "done" : "failed";
  phases.push({
    id: "verify",
    label: "Verify",
    state: verifyState,
    atMs: lastRun?.ranAtMs ?? null,
    detail: lastRun
      ? `last real run ${lastRun.status} (${lastRun.profileLabel}, exit ${lastRun.exitCode ?? "none"})${runSuperseded ? " — superseded by a later apply or draft change" : ""}; ${plural(taskRuns.length, "run")} this session`
      : verifyHandoffSent
        ? "handoff sent; no real run reported yet (Run must be clicked in Self-Healing Tests)"
        : appliedTargets.length > 0 ? "no real run reported yet" : "apply targets first",
  });

  // repair
  const repairHandoffs = taskHandoffs.filter((h) => h.intent === "repair");
  const lastRepairHandoff = latestBy(repairHandoffs, (h) => h.requestedAtMs);
  const failedRuns = taskRuns.filter((r) => r.status !== "passed");
  const firstFailureMs = failedRuns.length ? Math.min(...failedRuns.map((r) => r.ranAtMs)) : 0;
  const repairApplies = firstFailureMs ? taskApplies.filter((o) => o.appliedAtMs > firstFailureMs) : [];
  let repairState: TimelinePhaseState;
  let repairDetail: string;
  if (targets.length === 0) {
    repairState = "not-applicable"; repairDetail = "nothing to repair";
  } else if (failedRuns.length === 0) {
    repairState = "not-applicable"; repairDetail = "no failing run this session";
  } else if (lastRun && lastRun.status === "passed" && !runSuperseded) {
    repairState = "done"; repairDetail = `${plural(failedRuns.length, "earlier failure")} followed by a passing real run${repairApplies.length ? ` after ${plural(repairApplies.length, "reviewed apply", "reviewed applies")}` : ""}`;
  } else if (repairApplies.length > 0) {
    repairState = "partial"; repairDetail = `${plural(repairApplies.length, "reviewed apply", "reviewed applies")} since the failure; rerun the profile explicitly to confirm`;
  } else if (lastRepairHandoff) {
    repairState = "partial"; repairDetail = `repair handoff sent ${iso(lastRepairHandoff.requestedAtMs)}; no reviewed repair apply recorded yet`;
  } else {
    repairState = "pending"; repairDetail = `${plural(failedRuns.length, "failing run")}; no repair handoff sent yet`;
  }
  phases.push({
    id: "repair",
    label: "Repair",
    state: repairState,
    atMs: lastRepairHandoff?.requestedAtMs ?? (repairApplies.length ? latestBy(repairApplies, (o) => o.appliedAtMs)!.appliedAtMs : null),
    detail: repairDetail,
  });

  events.sort((a, b) => a.atMs - b.atMs);
  const boundedEvents = events.length > MAX_TIMELINE_EVENTS_PER_TASK ? events.slice(events.length - MAX_TIMELINE_EVENTS_PER_TASK) : events;

  // Loop iterations: count apply→run pairs (each real run that followed at least one apply since the previous run).
  let loopIterations = 0;
  let prevRunMs = 0;
  for (const r of [...taskRuns].sort((a, b) => a.ranAtMs - b.ranAtMs)) {
    if (taskApplies.some((o) => o.appliedAtMs > prevRunMs && o.appliedAtMs <= r.ranAtMs)) loopIterations += 1;
    prevRunMs = r.ranAtMs;
  }

  const currentPhase = pickCurrentPhase(phases);
  const nextAction = describeNextAction(task, phases, currentPhase);
  return { taskId: task.id, title: task.title, phases, events: boundedEvents, currentPhase, nextAction, loopIterations };
}

function pickCurrentPhase(phases: TimelinePhase[]): TimelinePhaseId {
  const by = (id: TimelinePhaseId) => phases.find((p) => p.id === id)!;
  if (by("repair").state === "pending" || by("repair").state === "partial") return "repair";
  if (by("verify").state === "failed") return "repair";
  for (const id of ["draft", "stage", "apply", "verify"] as TimelinePhaseId[]) {
    const s = by(id).state;
    if (s === "pending" || s === "partial" || s === "stale") return id;
  }
  return by("verify").state === "done" ? "verify" : "plan";
}

function describeNextAction(task: TimelineTaskInput, phases: TimelinePhase[], current: TimelinePhaseId): string {
  const by = (id: TimelinePhaseId) => phases.find((p) => p.id === id)!;
  if (task.reviewedFileTargets.length === 0) return "No reviewed targets; nothing to stage, apply or verify.";
  switch (current) {
    case "draft": return "Generate the missing in-memory drafts for this task.";
    case "stage": return "Stage this task's drafts for Editor review.";
    case "apply":
      return by("apply").state === "stale"
        ? "Restage and recompare the changed drafts, then apply explicitly in the Editor."
        : "Apply each reviewed draft explicitly in the Editor.";
    case "verify":
      if (by("verify").state === "stale") return "Targets changed after the last run; send a verify handoff and click Run again in Self-Healing Tests.";
      if (by("verify").state === "done") return "Last real run passed for the current applied state. No further action recorded.";
      return "Send a verify handoff, then click Run explicitly in Self-Healing Tests.";
    case "repair":
      return by("repair").state === "partial" && by("repair").detail.startsWith("repair handoff")
        ? "In Self-Healing Tests: rerun the profile, then draft a one-file repair and apply it via Editor review."
        : by("repair").state === "partial"
          ? "Rerun the profile explicitly in Self-Healing Tests to confirm the repair."
          : "Send a repair handoff to Self-Healing Tests for this failed batch.";
    default: return "Plan approved.";
  }
}

export function buildTaskTimelineSummary(inputs: TimelineInputs): TaskTimelineSummary {
  const tasks = inputs.tasks.map((t) => buildTaskTimeline(t, inputs));
  const counts: Record<TimelinePhaseId, number> = { plan: 0, draft: 0, stage: 0, apply: 0, verify: 0, repair: 0 };
  for (const t of tasks) counts[t.currentPhase] += 1;
  const verified = tasks.filter((t) => t.phases.find((p) => p.id === "verify")!.state === "done").length;
  const failing = tasks.filter((t) => t.phases.find((p) => p.id === "verify")!.state === "failed").length;
  const iterations = tasks.reduce((n, t) => n + t.loopIterations, 0);
  const summary = `${plural(tasks.length, "task")} · ${verified} verified · ${failing} failing · ${plural(iterations, "apply→run iteration")}`;
  const exportText = [
    "DevLab Builder task run timeline (loop summary)",
    `Generated: ${new Date().toISOString()}`,
    "Source: session-only renderer metadata (plan DAG, in-memory draft paths, staging ledger, Editor apply outcomes, Self-Healing Tests run outcomes and handoff requests)",
    "Safety: metadata-only; no draft contents, workspace contents, diffs or captured command output. Nothing here was executed by the Builder; every run required an explicit Run click and every write an explicit Editor apply.",
    "",
    "## Summary",
    `- ${summary}`,
    `- Tasks by current phase: ${TIMELINE_PHASES.map((p) => `${p.label} ${counts[p.id]}`).join(", ")}`,
    "- This timeline is not persisted and is excluded from recovery snapshots.",
    "",
    "## Tasks",
    ...tasks.flatMap((t) => [
      `### ${t.taskId} — ${t.title}`,
      `Current phase: ${t.currentPhase} · loop iterations: ${t.loopIterations}`,
      `Next: ${t.nextAction}`,
      ...t.phases.map((p) => `- ${p.label}: ${p.state}${p.atMs ? ` @ ${iso(p.atMs)}` : ""} — ${p.detail}`),
      ...(t.events.length ? ["Events:", ...t.events.map((e) => `  - ${iso(e.atMs)} [${e.phase}] ${e.label}`)] : ["Events: none recorded"]),
      "",
    ]),
  ].join("\n");
  return { tasks, summary, counts, exportText };
}
