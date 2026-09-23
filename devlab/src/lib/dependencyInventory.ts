// Phase 9N — renderer client for the native workspace dependency inventory. Rust reads the
// manifests and lockfiles already in the selected workspace (package.json / package-lock.json,
// Cargo.toml / Cargo.lock, requirements.txt / pyproject.toml, go.mod) and returns metadata only:
// package name, version or specifier, ecosystem, kind and the file that declared it, plus
// per-ecosystem rollups and packages pinned to more than one version. Offline by design — no
// network calls, no advisory lookups, no license matching and no remediation of any kind.

import { invoke, isTauri } from "@tauri-apps/api/core";

export const DEPENDENCY_INVENTORY_CONTEXT_PATH = "devlab-dependencies.md";

export interface DependencyInventoryRequest {
  prefix?: string;
}

export interface DependencyEntry {
  name: string;
  version: string;
  ecosystem: string;
  kind: string;
  resolved: boolean;
  direct: boolean;
  source: string;
}

export interface DependencyConflict {
  name: string;
  ecosystem: string;
  versions: string[];
  files: number;
}

export interface DependencyEcosystemCount {
  ecosystem: string;
  manifests: number;
  lockfiles: number;
  direct: number;
  transitive: number;
  dev: number;
  resolved: number;
  unresolved: number;
}

export interface DependencyInventoryLimits {
  maxManifests: number;
  maxManifestBytes: number;
  maxEntries: number;
  maxConflicts: number;
  buildDeadlineMs: number;
}

export interface DependencyInventory {
  prefix: string;
  manifests: number;
  lockfiles: number;
  filesScanned: number;
  dependencies: number;
  direct: number;
  transitive: number;
  dev: number;
  resolved: number;
  unresolved: number;
  entries: DependencyEntry[];
  entryCount: number;
  omittedEntries: number;
  ecosystems: DependencyEcosystemCount[];
  conflicts: DependencyConflict[];
  conflictCount: number;
  truncated: boolean;
  truncationReason: string | null;
  skippedFiles: number;
  skippedDirectories: number;
  skippedSamples: string[];
  generatedAtMs: number;
  buildMs: number;
  limits: DependencyInventoryLimits;
}

export function dependencyInventoryAvailable(): boolean {
  return isTauri();
}

export async function buildDependencyInventory(request: DependencyInventoryRequest = {}): Promise<DependencyInventory> {
  const payload: DependencyInventoryRequest = {};
  const prefix = (request.prefix ?? "").trim();
  if (prefix) payload.prefix = prefix;
  return invoke<DependencyInventory>("dependency_inventory", { request: payload });
}

export function describeInventory(inventory: DependencyInventory): string {
  const parts = [
    `${inventory.manifests} manifest${inventory.manifests === 1 ? "" : "s"}`,
    `${inventory.dependencies} dependenc${inventory.dependencies === 1 ? "y" : "ies"}`,
  ];
  if (inventory.transitive > 0) parts.push(`${inventory.transitive} transitive`);
  if (inventory.dev > 0) parts.push(`${inventory.dev} dev`);
  parts.push(`${inventory.buildMs} ms`);
  if (inventory.prefix) parts.push(`under ${inventory.prefix}/`);
  if (inventory.truncated) parts.push(`truncated (${inventory.truncationReason ?? "budget"})`);
  return parts.join(" · ");
}

export interface RenderedInventory {
  markdown: string;
  renderedEntries: number;
  renderedConflicts: number;
  clipped: boolean;
}

const MIN_RENDER_CHARS = 1_024;

/**
 * Renders the inventory as compact markdown within `maxChars`. Whole entries and conflicts are
 * emitted in Rust's order (direct dependencies first) until the budget would be exceeded; the
 * remainder is summarised as counts rather than cut mid-line.
 */
export function renderInventory(inventory: DependencyInventory, maxChars: number): RenderedInventory {
  const budget = Math.max(MIN_RENDER_CHARS, Math.floor(maxChars));
  const header: string[] = [
    `# Workspace dependency inventory${inventory.prefix ? `: ${inventory.prefix}/` : ""}`,
    "Read-only metadata from the workspace's manifests and lockfiles (offline: no network calls, no advisory lookups, no license matching and no remediation).",
    inventorySummaryLine(inventory),
  ];
  if (inventory.ecosystems.length > 0) {
    header.push(`Ecosystems: ${inventory.ecosystems.map(describeEcosystem).join("; ")}.`);
  }
  if (inventory.truncated) header.push(`Note: the native build stopped early (${inventory.truncationReason ?? "budget"}); some manifests were not read.`);
  if (inventory.skippedFiles > 0) header.push(`Skipped ${inventory.skippedFiles} unreadable or non-UTF-8 manifest${inventory.skippedFiles === 1 ? "" : "s"}.`);
  if (inventory.dependencies === 0) {
    header.push("No supported manifest or lockfile was found, so nothing was resolved.");
  }
  header.push(
    "Legend: `name version (ecosystem, kind) — file`; `pinned` means the version is exact, a bare version is a range; `transitive` means the package only appears in a lockfile.",
    "",
  );

  const footerReserve = omissionFooter(inventory.entryCount + inventory.conflictCount).length + 2;
  let used = header.join("\n").length + footerReserve;
  const body: string[] = ["## Dependencies (direct first)", ""];
  let renderedEntries = 0;
  for (const entry of inventory.entries) {
    const line = renderEntry(entry);
    const size = line.length + 1;
    if (used + size > budget) break;
    used += size;
    body.push(line);
    renderedEntries += 1;
  }
  if (renderedEntries === 0) body.push("- (none within the context budget)");
  let renderedConflicts = 0;
  if (inventory.conflicts.length > 0) {
    const heading = "## Packages pinned to more than one version";
    const size = heading.length + 3;
    if (used + size <= budget) {
      used += size;
      body.push("", heading, "");
      for (const conflict of inventory.conflicts) {
        const line = `- **${conflict.name}** (${conflict.ecosystem}) — ${conflict.versions.join(", ")} across ${conflict.files} file${conflict.files === 1 ? "" : "s"}`;
        const lineSize = line.length + 1;
        if (used + lineSize > budget) break;
        used += lineSize;
        body.push(line);
        renderedConflicts += 1;
      }
    }
  }

  const omittedEntries = inventory.entryCount - renderedEntries;
  const omittedConflicts = inventory.conflictCount - renderedConflicts;
  const footer: string[] = [];
  if (omittedEntries > 0 || omittedConflicts > 0 || inventory.omittedEntries > 0) {
    footer.push("", omissionFooter(omittedEntries + omittedConflicts + inventory.omittedEntries));
  }
  const markdown = [...header, ...body, ...footer].join("\n");
  return {
    markdown,
    renderedEntries,
    renderedConflicts,
    clipped: omittedEntries > 0 || omittedConflicts > 0 || inventory.omittedEntries > 0 || inventory.truncated,
  };
}

function inventorySummaryLine(inventory: DependencyInventory): string {
  const parts = [
    `${inventory.manifests} manifest${inventory.manifests === 1 ? "" : "s"} + ${inventory.lockfiles} lockfile${inventory.lockfiles === 1 ? "" : "s"}`,
    `${inventory.dependencies} dependenc${inventory.dependencies === 1 ? "y" : "ies"} (${inventory.direct} direct, ${inventory.transitive} transitive)`,
  ];
  if (inventory.dev > 0) parts.push(`${inventory.dev} dev`);
  parts.push(`${inventory.resolved} pinned`);
  if (inventory.unresolved > 0) parts.push(`${inventory.unresolved} range-only`);
  return parts.join(" · ");
}

function describeEcosystem(count: DependencyEcosystemCount): string {
  return `${count.ecosystem} ${count.manifests + count.lockfiles} file${count.manifests + count.lockfiles === 1 ? "" : "s"}, ${count.direct} direct / ${count.transitive} transitive${count.dev > 0 ? `, ${count.dev} dev` : ""}, ${count.resolved} pinned`;
}

function renderEntry(entry: DependencyEntry): string {
  const flags: string[] = [entry.ecosystem, entry.kind];
  if (!entry.direct) flags.push("transitive");
  if (entry.resolved) flags.push("pinned");
  return `- **${entry.name}** ${entry.version} (${flags.join(", ")}) — ${entry.source}`;
}

function omissionFooter(omitted: number): string {
  return `… ${omitted} more item${omitted === 1 ? "" : "s"} omitted to stay within the context budget. Narrow the workspace or raise the Agent context budget for the full list.`;
}
