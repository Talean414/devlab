// Phase 8S — session-only Editor saved review views.
//
// A saved review view is a named snapshot of review-only UI state for the current reviewed-draft
// queue: the active queue filter, the per-draft session annotations (status + bounded note) and the
// selected draft key. Restoring a view only changes that UI state. It never touches draft contents,
// never writes to the workspace, never runs anything and never changes apply requirements.
// Views live in renderer memory for the current queue only; they are dropped when the queue is
// replaced and are never persisted or included in recovery snapshots.

export const MAX_SAVED_REVIEW_VIEWS = 12;
export const MAX_REVIEW_VIEW_NAME_CHARS = 60;

export interface ReviewViewAnnotation {
  status: "unreviewed" | "reviewed" | "needs-changes";
  note: string;
  updatedAtMs: number;
}

export interface SavedReviewView<Filter extends string = string> {
  id: string;
  name: string;
  savedAtMs: number;
  filter: Filter;
  selectedKey: string;
  annotations: Record<string, ReviewViewAnnotation>;
  counts: { annotated: number; reviewed: number; needsChanges: number; notes: number };
}

export interface ReviewViewRestorePreview {
  // Annotation keys in the view that still exist in the current queue.
  applicable: number;
  // Annotation keys in the view whose draft is no longer in the queue; they are ignored on restore.
  dropped: number;
  // Current annotations that would be replaced or cleared by restoring.
  overwritten: number;
  selectedStillPresent: boolean;
  summary: string;
}

export function sanitizeReviewViewName(raw: string, existing: { name: string }[]): string {
  const base = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_REVIEW_VIEW_NAME_CHARS) || "Review view";
  const names = new Set(existing.map((view) => view.name));
  if (!names.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} (${n})`.slice(0, MAX_REVIEW_VIEW_NAME_CHARS + 6);
    if (!names.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

export function countReviewViewAnnotations(annotations: Record<string, ReviewViewAnnotation>): SavedReviewView["counts"] {
  let reviewed = 0; let needsChanges = 0; let notes = 0;
  for (const annotation of Object.values(annotations)) {
    if (annotation.status === "reviewed") reviewed += 1;
    if (annotation.status === "needs-changes") needsChanges += 1;
    if (annotation.note.length > 0) notes += 1;
  }
  return { annotated: Object.keys(annotations).length, reviewed, needsChanges, notes };
}

export function createSavedReviewView<Filter extends string>(
  input: { name: string; filter: Filter; selectedKey: string; annotations: Record<string, ReviewViewAnnotation>; queueKeys: string[] },
  existing: SavedReviewView<Filter>[],
  nowMs = Date.now(),
): SavedReviewView<Filter> {
  const queue = new Set(input.queueKeys);
  const annotations: Record<string, ReviewViewAnnotation> = {};
  for (const [key, annotation] of Object.entries(input.annotations)) {
    if (!queue.has(key)) continue;
    annotations[key] = { status: annotation.status, note: annotation.note, updatedAtMs: annotation.updatedAtMs };
  }
  return {
    id: `view-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: sanitizeReviewViewName(input.name, existing),
    savedAtMs: nowMs,
    filter: input.filter,
    selectedKey: queue.has(input.selectedKey) ? input.selectedKey : "",
    annotations,
    counts: countReviewViewAnnotations(annotations),
  };
}

// Appends a view and enforces the cap by dropping the oldest saved views first.
export function appendSavedReviewView<Filter extends string>(views: SavedReviewView<Filter>[], view: SavedReviewView<Filter>): SavedReviewView<Filter>[] {
  const next = [...views, view];
  return next.length > MAX_SAVED_REVIEW_VIEWS ? next.slice(next.length - MAX_SAVED_REVIEW_VIEWS) : next;
}

export function previewReviewViewRestore(
  view: SavedReviewView,
  current: Record<string, ReviewViewAnnotation>,
  queueKeys: string[],
): ReviewViewRestorePreview {
  const queue = new Set(queueKeys);
  const viewKeys = Object.keys(view.annotations);
  const applicable = viewKeys.filter((key) => queue.has(key)).length;
  const dropped = viewKeys.length - applicable;
  let overwritten = 0;
  for (const [key, annotation] of Object.entries(current)) {
    const saved = view.annotations[key];
    if (!saved || saved.status !== annotation.status || saved.note !== annotation.note) overwritten += 1;
  }
  const selectedStillPresent = Boolean(view.selectedKey) && queue.has(view.selectedKey);
  const parts = [
    `filter → ${view.filter}`,
    `${applicable} annotation${applicable === 1 ? "" : "s"} restored`,
    overwritten > 0 ? `${overwritten} current annotation${overwritten === 1 ? "" : "s"} replaced or cleared` : "no current annotations changed",
  ];
  if (dropped > 0) parts.push(`${dropped} saved annotation${dropped === 1 ? "" : "s"} ignored (draft no longer in queue)`);
  return { applicable, dropped, overwritten, selectedStillPresent, summary: parts.join(" · ") };
}

// Produces the annotation map that restoring a view yields: only keys still in the queue survive.
export function restoreReviewViewAnnotations(view: SavedReviewView, queueKeys: string[]): Record<string, ReviewViewAnnotation> {
  const queue = new Set(queueKeys);
  const result: Record<string, ReviewViewAnnotation> = {};
  for (const [key, annotation] of Object.entries(view.annotations)) {
    if (queue.has(key)) result[key] = { ...annotation };
  }
  return result;
}

// Metadata-only export: names, filters, counts and per-draft status/note lengths. Notes themselves are
// reviewer text and are included in bounded form; draft contents never are.
export function buildSavedReviewViewsExport(views: SavedReviewView[], pathForKey: (key: string) => string | undefined): string {
  return [
    "DevLab Editor saved review views",
    `Generated: ${new Date().toISOString()}`,
    "Source: session-only renderer review state for the current reviewed-draft queue",
    "Safety: review-only UI state; contains no draft contents, workspace contents or diffs. Restoring a view never writes files, runs commands or changes apply requirements. Views are not persisted and are excluded from recovery snapshots.",
    "",
    `## Views (${views.length}/${MAX_SAVED_REVIEW_VIEWS})`,
    ...(views.length === 0
      ? ["- None saved for this queue."]
      : views.flatMap((view) => [
        `### ${view.name}`,
        `Saved: ${new Date(view.savedAtMs).toISOString()} · filter: ${view.filter} · ${view.counts.annotated} annotated (${view.counts.reviewed} reviewed, ${view.counts.needsChanges} needs changes, ${view.counts.notes} with notes)`,
        ...Object.entries(view.annotations).map(([key, annotation]) => `- ${pathForKey(key) ?? "(draft no longer in queue)"} — ${annotation.status}${annotation.note ? ` — note (${annotation.note.length} chars): ${annotation.note.slice(0, 200)}${annotation.note.length > 200 ? "…" : ""}` : ""}`),
        "",
      ])),
  ].join("\n");
}
