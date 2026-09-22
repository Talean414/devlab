// Phase 9C — renderer client for the native in-memory workspace search index (lexical FTS5).
// The index lives only in Rust process memory for the selected workspace. This module never
// reads files itself; attaching a hit still goes through the audited workspace_read path.

import { invoke } from "@tauri-apps/api/core";

export interface SkippedReasons {
  ignoredDirectory: number;
  symlink: number;
  tooLarge: number;
  binaryExtension: number;
  secretPattern: number;
  notUtf8: number;
  unreadable: number;
  otherKind: number;
}

export interface IndexStats {
  indexedFiles: number;
  indexedBytes: number;
  skippedFiles: number;
  skippedDirectories: number;
  skippedReasons: SkippedReasons;
  skippedSamples: string[];
  truncated: boolean;
  truncationReason: string | null;
  builtAtMs: number;
  buildMs: number;
}

export interface SearchIndexStatus {
  available: boolean;
  workspaceMatches: boolean;
  stats: IndexStats | null;
  storage: string;
  semantic: string;
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxHits: number; maxQueryChars: number };
}

export interface SearchHit {
  path: string;
  rank: number;
  snippet: string;
  size: number;
  modifiedMs: number | null;
}

export interface SearchQueryResponse {
  query: string;
  ftsQuery: string;
  hits: SearchHit[];
  totalMatches: number;
  truncated: boolean;
  elapsedMs: number;
}

export function searchIndexStatus(): Promise<SearchIndexStatus> {
  return invoke<SearchIndexStatus>("search_index_status");
}

export function buildSearchIndex(): Promise<SearchIndexStatus> {
  return invoke<SearchIndexStatus>("search_index_build");
}

export function querySearchIndex(query: string, options: { limit?: number; pathPrefix?: string } = {}): Promise<SearchQueryResponse> {
  return invoke<SearchQueryResponse>("search_index_query", {
    request: { query, limit: options.limit, pathPrefix: options.pathPrefix ?? "" },
  });
}

export function clearSearchIndex(): Promise<void> {
  return invoke<void>("search_index_clear");
}

export function describeIndexStats(stats: IndexStats): string {
  const mib = (stats.indexedBytes / (1024 * 1024)).toFixed(1);
  const skipped = stats.skippedFiles + stats.skippedDirectories;
  return `${stats.indexedFiles} files · ${mib} MiB indexed · ${skipped} skipped${stats.truncated ? ` · truncated (${stats.truncationReason ?? "limit"})` : ""} · built in ${stats.buildMs} ms`;
}
