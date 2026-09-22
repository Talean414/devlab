// Phase 9C/9D — renderer client for the native in-memory workspace search index (lexical FTS5
// plus optional Ollama embeddings). The index and its vectors live only in Rust process memory
// for the selected workspace. This module never reads files or talks to Ollama itself; attaching
// a hit still goes through the audited workspace_read path.

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
  chunkCount: number;
  chunksTruncated: boolean;
}

export type SearchMode = "lexical" | "semantic" | "hybrid";

export interface SemanticStatus {
  totalChunks: number;
  embeddedChunks: number;
  complete: boolean;
  endpoint: string | null;
  model: string | null;
  dims: number;
  vectorBytes: number;
  truncated: boolean;
  note: string;
}

export interface SearchEmbedResponse {
  semantic: SemanticStatus;
  embeddedNow: number;
  restarted: boolean;
  promptEvalCount: number;
  elapsedMs: number;
}

export interface SearchIndexStatus {
  available: boolean;
  workspaceMatches: boolean;
  stats: IndexStats | null;
  storage: string;
  semantic: SemanticStatus;
  limits: {
    maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxHits: number; maxQueryChars: number;
    maxEmbedChunks: number; chunksPerFile: number; chunkChars: number;
  };
}

export interface SearchHit {
  path: string;
  rank: number;
  snippet: string;
  size: number;
  modifiedMs: number | null;
  sources: ("lexical" | "semantic")[];
  semanticScore: number | null;
  startLine: number | null;
  endLine: number | null;
}

export interface SearchQueryResponse {
  query: string;
  ftsQuery: string;
  mode: SearchMode;
  scoreKind: string;
  hits: SearchHit[];
  totalMatches: number;
  truncated: boolean;
  semanticUsed: boolean;
  semanticNote: string | null;
  elapsedMs: number;
}

export interface SemanticTarget {
  /** Loopback Ollama origin (empty = http://127.0.0.1:11434). Validated again in Rust. */
  endpoint: string;
  /** Embedding model id, e.g. nomic-embed-text. */
  model: string;
}

export function searchIndexStatus(): Promise<SearchIndexStatus> {
  return invoke<SearchIndexStatus>("search_index_status");
}

export function buildSearchIndex(): Promise<SearchIndexStatus> {
  return invoke<SearchIndexStatus>("search_index_build");
}

export function querySearchIndex(
  query: string,
  options: { limit?: number; pathPrefix?: string; mode?: SearchMode; semantic?: SemanticTarget } = {},
): Promise<SearchQueryResponse> {
  const mode = options.mode ?? "lexical";
  return invoke<SearchQueryResponse>("search_index_query", {
    request: {
      query,
      limit: options.limit,
      pathPrefix: options.pathPrefix ?? "",
      mode,
      endpoint: mode === "lexical" ? "" : options.semantic?.endpoint ?? "",
      model: mode === "lexical" ? "" : options.semantic?.model ?? "",
    },
  });
}

/** Embeds the next bounded slice of chunks; call repeatedly until `semantic.complete`. */
export function embedSearchIndex(target: SemanticTarget): Promise<SearchEmbedResponse> {
  return invoke<SearchEmbedResponse>("search_index_embed", { request: { endpoint: target.endpoint, model: target.model } });
}

export function describeSemanticStatus(semantic: SemanticStatus): string {
  if (semantic.totalChunks === 0) return "No chunks to embed.";
  if (semantic.embeddedChunks === 0) return `${semantic.totalChunks} chunks ready to embed (not embedded yet).`;
  const mib = (semantic.vectorBytes / (1024 * 1024)).toFixed(1);
  return `${semantic.embeddedChunks}/${semantic.totalChunks} chunks embedded with ${semantic.model ?? "?"} (${semantic.dims} dims · ${mib} MiB in memory)${semantic.complete ? "" : " · incomplete"}${semantic.truncated ? " · vector budget reached" : ""}`;
}

export function clearSearchIndex(): Promise<void> {
  return invoke<void>("search_index_clear");
}

export function describeIndexStats(stats: IndexStats): string {
  const mib = (stats.indexedBytes / (1024 * 1024)).toFixed(1);
  const skipped = stats.skippedFiles + stats.skippedDirectories;
  return `${stats.indexedFiles} files · ${mib} MiB indexed · ${skipped} skipped · ${stats.chunkCount} chunks${stats.chunksTruncated ? " (chunk cap reached)" : ""}${stats.truncated ? ` · truncated (${stats.truncationReason ?? "limit"})` : ""} · built in ${stats.buildMs} ms`;
}
