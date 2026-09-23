// Phase 9T — hunk-level accept/reject decisions for the Editor review gate.
//
// Pure, renderer-only helpers. They turn the Monaco diff editor's line changes
// (the same "change blocks" already used for Previous/Next navigation) into
// per-hunk reviewer decisions and compose the resulting file **in memory**.
//
// This module never writes, never invokes native commands and never mutates the
// generated draft contents. The composed content is only ever passed to the
// existing explicit "Apply reviewed draft" button, which still routes through
// the same `workspace_apply_reviewed_draft` write path and native revision
// check as an untouched draft. With zero dropped blocks the composed content
// is byte-identical to the generated draft, so the default apply behavior is
// unchanged.

export interface ReviewHunkRange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

export interface ReviewHunk extends ReviewHunkRange {
  /** Stable, range-derived identity for the block; survives diff re-computation. */
  key: string;
  /** Zero-based position in the Monaco line-changes list. */
  index: number;
  addedLines: number;
  removedLines: number;
}

export interface HunkDecisionSummary {
  total: number;
  kept: number;
  dropped: number;
  addedKept: number;
  removedKept: number;
}

/**
 * Monaco empty ranges use `end = start - 1` (a pure insertion has
 * originalEndLineNumber = originalStartLineNumber - 1). The key derives purely
 * from the four ranges so it stays stable while the same content is diffed.
 */
export function reviewHunkKey(range: ReviewHunkRange): string {
  return `o${range.originalStartLineNumber}:${range.originalEndLineNumber}|m${range.modifiedStartLineNumber}:${range.modifiedEndLineNumber}`;
}

export function reviewHunksFromLineChanges(changes: readonly ReviewHunkRange[]): ReviewHunk[] {
  return changes.map((change, index) => ({
    key: reviewHunkKey(change),
    index,
    originalStartLineNumber: change.originalStartLineNumber,
    originalEndLineNumber: change.originalEndLineNumber,
    modifiedStartLineNumber: change.modifiedStartLineNumber,
    modifiedEndLineNumber: change.modifiedEndLineNumber,
    addedLines: Math.max(0, change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1),
    removedLines: Math.max(0, change.originalEndLineNumber - change.originalStartLineNumber + 1),
  }));
}

export function summarizeHunkDecisions(
  hunks: readonly ReviewHunk[],
  droppedKeys: readonly string[],
): HunkDecisionSummary {
  const dropped = new Set(droppedKeys);
  let kept = 0;
  let addedKept = 0;
  let removedKept = 0;
  let droppedCount = 0;
  for (const hunk of hunks) {
    if (dropped.has(hunk.key)) {
      droppedCount += 1;
      continue;
    }
    kept += 1;
    addedKept += hunk.addedLines;
    removedKept += hunk.removedLines;
  }
  return { total: hunks.length, kept, dropped: droppedCount, addedKept, removedKept };
}

function contentEndsNewline(content: string): boolean {
  return /(?:\r\n|\n|\r)$/.test(content);
}

function detectEol(content: string): string {
  if (content.includes("\r\n")) return "\r\n";
  if (content.includes("\r")) return "\r";
  return "\n";
}

/**
 * Monaco model lines: split on CRLF/LF/CR and drop the trailing empty element
 * created by a final line terminator. Empty content is a single empty line.
 */
function toModelLines(content: string): string[] {
  if (content === "") return [""];
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

export interface ComposeHunkDecisionInput {
  originalContent: string;
  modifiedContent: string;
  hunks: readonly ReviewHunk[];
  droppedKeys: readonly string[];
}

export interface ComposeHunkDecisionResult {
  content: string;
  droppedApplied: number;
}

/**
 * Compose the file the reviewer approved:
 * - unchanged regions always come from the original content;
 * - a kept block uses the modified (draft) lines;
 * - a dropped block keeps the original lines and discards the modified lines.
 *
 * With no dropped block the generated draft is returned byte-for-byte, so the
 * explicit apply path behaves exactly as before. The trailing line terminator
 * follows the side that supplied the final line of the composed file, and the
 * dominant line ending of the original file (CRLF/LF) is preserved when the
 * original uses one.
 */
export function composeDraftWithHunkDecisions(input: ComposeHunkDecisionInput): ComposeHunkDecisionResult {
  const { originalContent, modifiedContent, hunks } = input;
  const dropped = new Set(input.droppedKeys);
  const droppedApplied = hunks.reduce((count, hunk) => count + (dropped.has(hunk.key) ? 1 : 0), 0);
  if (droppedApplied === 0) {
    return { content: modifiedContent, droppedApplied: 0 };
  }

  const originalLines = toModelLines(originalContent);
  const modifiedLines = toModelLines(modifiedContent);
  const originalEndsNewline = contentEndsNewline(originalContent);
  const modifiedEndsNewline = contentEndsNewline(modifiedContent);

  const out: string[] = [];
  const pushFrom = (lines: string[], startLine: number, endLine: number): boolean => {
    if (startLine > endLine) return false;
    const start = Math.max(0, startLine - 1);
    const end = Math.min(endLine, lines.length);
    if (start >= end) return false;
    for (let i = start; i < end; i += 1) {
      out.push(lines[i] ?? "");
    }
    return true;
  };

  const sorted = [...hunks].sort(
    (a, b) => a.originalStartLineNumber - b.originalStartLineNumber
      || a.modifiedStartLineNumber - b.modifiedStartLineNumber,
  );
  let cursor = 1;
  let lastProvider: "original" | "modified" = "original";
  for (const hunk of sorted) {
    if (pushFrom(originalLines, cursor, hunk.originalStartLineNumber - 1)) lastProvider = "original";
    if (dropped.has(hunk.key)) {
      if (pushFrom(originalLines, hunk.originalStartLineNumber, hunk.originalEndLineNumber)) lastProvider = "original";
    } else if (pushFrom(modifiedLines, hunk.modifiedStartLineNumber, hunk.modifiedEndLineNumber)) {
      lastProvider = "modified";
    }
    cursor = Math.max(cursor, hunk.originalEndLineNumber + 1);
  }
  if (pushFrom(originalLines, cursor, originalLines.length)) lastProvider = "original";

  const eol = /\r/.test(originalContent) ? detectEol(originalContent) : detectEol(modifiedContent);
  const endsNewline = lastProvider === "modified" ? modifiedEndsNewline : originalEndsNewline;
  const content = out.length === 0 ? "" : out.join(eol) + (endsNewline ? eol : "");
  return { content, droppedApplied };
}

/** Human-readable range label for one change block. */
export function hunkRangeLabel(hunk: ReviewHunk): string {
  const original = hunk.removedLines > 0 ? `L${hunk.originalStartLineNumber}–${hunk.originalEndLineNumber}` : "";
  const modified = hunk.addedLines > 0 ? `L${hunk.modifiedStartLineNumber}–${hunk.modifiedEndLineNumber}` : "";
  if (original && modified) return `${original} → ${modified}`;
  if (original) return `delete ${original}`;
  if (modified) return hunk.originalStartLineNumber <= 1
    ? `insert ${modified} at file top`
    : `insert ${modified} after L${hunk.originalStartLineNumber - 1}`;
  return "no range";
}
