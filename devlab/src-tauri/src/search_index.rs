//! Native workspace search index (Phase 9C — lexical half of hybrid search).
//!
//! A bounded, in-memory SQLite FTS5 index over the UTF-8 text files of the selected workspace:
//! * The index lives in process memory only (`Connection::open_in_memory`). Nothing is written
//!   to disk, nothing is persisted between runs, and the index is dropped when the workspace is
//!   closed or another workspace is selected.
//! * Building is explicit. React asks for it; the walk is scoped to the workspace root, refuses
//!   symlinks, skips heavy/generated folders and binary or over-sized files, and stops at fixed
//!   file-count and total-byte budgets, reporting what was skipped and why.
//! * Queries return bounded hits (path, bm25 rank, short snippet). Snippets are the only file
//!   content that crosses the boundary and they are capped per hit and per response. Attaching
//!   a hit as Agent context still goes through the audited `workspace_read` path.
//! * Semantic search (Phase 9D) is optional and explicit: at build time the walk also records
//!   bounded line chunks in the same in-memory database; `search_index_embed` sends those chunks
//!   to the validated loopback-only Ollama adapter a few batches per call and keeps the resulting
//!   unit vectors in process memory under a byte budget. Queries can then run lexical, semantic
//!   (cosine over chunks) or hybrid (reciprocal-rank fusion) ranking. The mutex is never held
//!   across a network call and a rebuild/clear invalidates in-flight embedding work.

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::State;

use crate::http::blocking;
use crate::ollama::{embed_texts, validate_embed_target, EmbeddingBatch, MAX_EMBED_BATCH, MAX_EMBED_INPUT_CHARS};
use crate::workspace::{CommandError, WorkspaceService};

const MAX_INDEXED_FILES: usize = 20_000;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_WALK_DEPTH: usize = 32;
const MAX_QUERY_CHARS: usize = 256;
const MAX_QUERY_TERMS: usize = 12;
const MAX_HITS: usize = 50;
const DEFAULT_HITS: usize = 20;
const SNIPPET_TOKENS: u32 = 24;
const MAX_SNIPPET_CHARS: usize = 240;
const MAX_TOTAL_SNIPPET_CHARS: usize = 12 * 1024;
const MAX_SKIPPED_SAMPLES: usize = 24;
const MAX_EMBED_CHUNKS: usize = 2_048;
const MAX_CHUNKS_PER_FILE: usize = 6;
const CHUNK_TARGET_CHARS: usize = 1_200;
const MAX_EMBED_BATCHES_PER_CALL: usize = 4;
const MAX_VECTOR_BYTES: usize = 48 * 1024 * 1024;
const RRF_K: f64 = 60.0;

const SKIPPED_DIRECTORY_NAMES: &[&str] = &[
    ".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "target", "coverage",
    ".next", ".nuxt", ".svelte-kit", ".vite", ".turbo", ".parcel-cache", ".cache", ".local",
    ".venv", "venv", ".tox", ".nox", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    "__pycache__", ".idea", ".vscode", ".gradle", ".terraform", "vendor", "Pods", "DerivedData",
];

// Files that the reviewed-draft policy also treats as secret-bearing are never indexed, so their
// contents cannot surface through snippets.
const SKIPPED_SECRET_FILE_NAMES: &[&str] = &[
    ".env", ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
    "credentials", "credentials.json", "service-account.json", "secrets.json", "secrets.yaml",
    "secrets.yml", "secrets.toml",
];
const SKIPPED_SECRET_EXTENSIONS: &[&str] = &["pem", "key", "p12", "pfx", "jks", "keystore", "asc", "gpg"];

const SKIPPED_BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "svgz", "tif", "tiff", "psd",
    "mp3", "mp4", "mov", "avi", "mkv", "wav", "flac", "ogg", "webm",
    "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "jar", "war",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "exe", "dll", "so", "dylib", "a", "o", "obj", "lib", "bin", "class", "pyc", "pyo", "wasm",
    "sqlite", "sqlite3", "db", "lock", "map", "min.js", "min.css", "woff", "woff2", "ttf", "otf", "eot",
];

#[derive(Default)]
struct IndexInner {
    connection: Option<Connection>,
    workspace_root: Option<PathBuf>,
    stats: Option<IndexStats>,
    /// Incremented on every build and clear so embedding work started against an older index is
    /// discarded instead of being merged into a newer one.
    generation: u64,
    embeddings: EmbeddingStore,
}

#[derive(Default)]
struct EmbeddingStore {
    endpoint: Option<String>,
    model: Option<String>,
    dims: usize,
    next_chunk_id: i64,
    vector_bytes: usize,
    truncated: bool,
    chunks: Vec<EmbeddedChunk>,
}

struct EmbeddedChunk {
    path: String,
    start_line: u32,
    end_line: u32,
    preview: String,
    vector: Vec<f32>,
}

impl EmbeddingStore {
    fn reset(&mut self) {
        *self = EmbeddingStore::default();
    }
}

#[derive(Default)]
pub struct SearchIndexService {
    inner: Mutex<IndexInner>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    indexed_files: usize,
    indexed_bytes: u64,
    skipped_files: usize,
    skipped_directories: usize,
    skipped_reasons: SkippedReasons,
    skipped_samples: Vec<String>,
    truncated: bool,
    truncation_reason: Option<&'static str>,
    built_at_ms: u64,
    build_ms: u64,
    chunk_count: usize,
    chunks_truncated: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedReasons {
    ignored_directory: usize,
    symlink: usize,
    too_large: usize,
    binary_extension: usize,
    secret_pattern: usize,
    not_utf8: usize,
    unreadable: usize,
    other_kind: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexStatus {
    available: bool,
    workspace_matches: bool,
    stats: Option<IndexStats>,
    storage: &'static str,
    semantic: SemanticStatus,
    limits: IndexLimits,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticStatus {
    total_chunks: usize,
    embedded_chunks: usize,
    complete: bool,
    endpoint: Option<String>,
    model: Option<String>,
    dims: usize,
    vector_bytes: usize,
    truncated: bool,
    note: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchEmbedRequest {
    #[serde(default)]
    endpoint: String,
    model: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEmbedResponse {
    semantic: SemanticStatus,
    embedded_now: usize,
    restarted: bool,
    prompt_eval_count: u64,
    elapsed_ms: u64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    #[default]
    Lexical,
    Semantic,
    Hybrid,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexLimits {
    max_files: usize,
    max_file_bytes: u64,
    max_total_bytes: u64,
    max_hits: usize,
    max_query_chars: usize,
    max_embed_chunks: usize,
    chunks_per_file: usize,
    chunk_chars: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchQueryRequest {
    query: String,
    limit: Option<usize>,
    #[serde(default)]
    path_prefix: String,
    #[serde(default)]
    mode: SearchMode,
    /// Loopback Ollama origin used only to embed the query text in semantic/hybrid mode.
    #[serde(default)]
    endpoint: String,
    /// Embedding model id; must match the model the index was embedded with.
    #[serde(default)]
    model: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    path: String,
    rank: f64,
    snippet: String,
    size: u64,
    modified_ms: Option<u64>,
    sources: Vec<&'static str>,
    semantic_score: Option<f64>,
    start_line: Option<u32>,
    end_line: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQueryResponse {
    query: String,
    fts_query: String,
    mode: SearchMode,
    score_kind: &'static str,
    hits: Vec<SearchHit>,
    total_matches: usize,
    truncated: bool,
    semantic_used: bool,
    semantic_note: Option<String>,
    elapsed_ms: u64,
}

fn limits() -> IndexLimits {
    IndexLimits {
        max_files: MAX_INDEXED_FILES,
        max_file_bytes: MAX_FILE_BYTES,
        max_total_bytes: MAX_TOTAL_BYTES,
        max_hits: MAX_HITS,
        max_query_chars: MAX_QUERY_CHARS,
        max_embed_chunks: MAX_EMBED_CHUNKS,
        chunks_per_file: MAX_CHUNKS_PER_FILE,
        chunk_chars: CHUNK_TARGET_CHARS,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn elapsed_ms(started: Instant) -> u64 {
    started
        .elapsed()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn sqlite_error(action: &str, error: rusqlite::Error) -> CommandError {
    CommandError::new("search_index_error", format!("Could not {action}: {error}"))
}

fn open_memory_connection() -> Result<Connection, CommandError> {
    let connection = Connection::open_in_memory_with_flags(
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| sqlite_error("open the in-memory search index", error))?;
    connection
        .execute_batch(
            "CREATE VIRTUAL TABLE docs USING fts5(path, body, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
             CREATE TABLE meta(path TEXT PRIMARY KEY, size INTEGER NOT NULL, modified_ms INTEGER);
             CREATE TABLE chunks(id INTEGER PRIMARY KEY, path TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, body TEXT NOT NULL);",
        )
        .map_err(|error| sqlite_error("create the search index tables", error))?;
    Ok(connection)
}

fn extension_of(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".min.js") {
        return "min.js".to_string();
    }
    if lower.ends_with(".min.css") {
        return "min.css".to_string();
    }
    lower.rsplit_once('.').map(|(_, ext)| ext.to_string()).unwrap_or_default()
}

pub(crate) fn is_skipped_directory(name: &str) -> bool {
    SKIPPED_DIRECTORY_NAMES.contains(&name)
}

pub(crate) fn is_secret_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with(".env") && !matches!(lower.as_str(), ".env.example" | ".env.sample" | ".env.template") {
        return true;
    }
    if SKIPPED_SECRET_FILE_NAMES.contains(&lower.as_str()) {
        return true;
    }
    if lower.starts_with("id_rsa") || lower.starts_with("id_ed25519") || lower.starts_with("id_ecdsa") {
        return true;
    }
    SKIPPED_SECRET_EXTENSIONS.contains(&extension_of(&lower).as_str())
}

pub(crate) fn is_binary_extension(name: &str) -> bool {
    let ext = extension_of(name);
    !ext.is_empty() && SKIPPED_BINARY_EXTENSIONS.contains(&ext.as_str())
}

fn relative_wire(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            std::path::Component::Normal(part) => parts.push(part.to_str()?.to_string()),
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// Splits a file into at most `MAX_CHUNKS_PER_FILE` line-aligned chunks of roughly
/// `CHUNK_TARGET_CHARS` characters (1-based inclusive line ranges). Whitespace-only chunks are
/// dropped. Text beyond the last allowed chunk is simply not embedded; status reports this.
pub(crate) fn chunk_body(body: &str) -> Vec<(u32, u32, String)> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_chars = 0usize;
    let mut current_start = 1u32;
    let mut line_no = 0u32;
    let mut last_line = 0u32;
    for line in body.split_inclusive('\n') {
        line_no = line_no.saturating_add(1);
        if current.is_empty() {
            current_start = line_no;
        }
        current.push_str(line);
        current_chars += line.chars().count();
        last_line = line_no;
        if current_chars >= CHUNK_TARGET_CHARS {
            if !current.trim().is_empty() {
                let text: String = current.chars().take(MAX_EMBED_INPUT_CHARS).collect();
                chunks.push((current_start, line_no, text));
            }
            current.clear();
            current_chars = 0;
            if chunks.len() >= MAX_CHUNKS_PER_FILE {
                return chunks;
            }
        }
    }
    if !current.trim().is_empty() && chunks.len() < MAX_CHUNKS_PER_FILE {
        let text: String = current.chars().take(MAX_EMBED_INPUT_CHARS).collect();
        chunks.push((current_start, last_line.max(current_start), text));
    }
    chunks
}

struct Walker<'a> {
    root: &'a Path,
    connection: &'a Connection,
    stats: IndexStats,
    total_bytes: u64,
    seen_dirs: HashSet<PathBuf>,
}

impl Walker<'_> {
    fn note_skip(&mut self, relative: &str, reason: &str) {
        self.stats.skipped_files += 1;
        if self.stats.skipped_samples.len() < MAX_SKIPPED_SAMPLES {
            self.stats.skipped_samples.push(format!("{relative} — {reason}"));
        }
    }

    fn budget_exhausted(&mut self) -> bool {
        if self.stats.indexed_files >= MAX_INDEXED_FILES {
            self.stats.truncated = true;
            self.stats.truncation_reason = Some("max_files");
            return true;
        }
        if self.total_bytes >= MAX_TOTAL_BYTES {
            self.stats.truncated = true;
            self.stats.truncation_reason = Some("max_total_bytes");
            return true;
        }
        false
    }

    fn walk(&mut self, directory: &Path, depth: usize) -> Result<(), CommandError> {
        if depth > MAX_WALK_DEPTH {
            self.stats.skipped_directories += 1;
            return Ok(());
        }
        let canonical = fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf());
        if !self.seen_dirs.insert(canonical) {
            return Ok(());
        }
        let read_dir = match fs::read_dir(directory) {
            Ok(read_dir) => read_dir,
            Err(_) => {
                self.stats.skipped_directories += 1;
                return Ok(());
            }
        };
        let mut entries = read_dir.filter_map(Result::ok).collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if self.budget_exhausted() {
                return Ok(());
            }
            let path = entry.path();
            let name = match entry.file_name().into_string() {
                Ok(name) => name,
                Err(_) => {
                    self.stats.skipped_reasons.other_kind += 1;
                    self.stats.skipped_files += 1;
                    continue;
                }
            };
            let relative = relative_wire(self.root, &path).unwrap_or_else(|| name.clone());
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    self.stats.skipped_reasons.unreadable += 1;
                    self.note_skip(&relative, "unreadable metadata");
                    continue;
                }
            };
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                self.stats.skipped_reasons.symlink += 1;
                self.note_skip(&relative, "symlink");
                continue;
            }
            if file_type.is_dir() {
                if is_skipped_directory(&name) {
                    self.stats.skipped_reasons.ignored_directory += 1;
                    self.stats.skipped_directories += 1;
                    continue;
                }
                self.walk(&path, depth + 1)?;
                continue;
            }
            if !file_type.is_file() {
                self.stats.skipped_reasons.other_kind += 1;
                self.note_skip(&relative, "not a regular file");
                continue;
            }
            if is_secret_file(&name) {
                self.stats.skipped_reasons.secret_pattern += 1;
                self.note_skip(&relative, "secret-safe skip");
                continue;
            }
            if is_binary_extension(&name) {
                self.stats.skipped_reasons.binary_extension += 1;
                self.note_skip(&relative, "binary extension");
                continue;
            }
            let size = metadata.len();
            if size > MAX_FILE_BYTES {
                self.stats.skipped_reasons.too_large += 1;
                self.note_skip(&relative, "larger than 512 KiB");
                continue;
            }
            if self.total_bytes.saturating_add(size) > MAX_TOTAL_BYTES {
                self.stats.truncated = true;
                self.stats.truncation_reason = Some("max_total_bytes");
                return Ok(());
            }
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => {
                    self.stats.skipped_reasons.unreadable += 1;
                    self.note_skip(&relative, "unreadable");
                    continue;
                }
            };
            if bytes.contains(&0) {
                self.stats.skipped_reasons.not_utf8 += 1;
                self.note_skip(&relative, "binary content");
                continue;
            }
            let body = match String::from_utf8(bytes) {
                Ok(body) => body,
                Err(_) => {
                    self.stats.skipped_reasons.not_utf8 += 1;
                    self.note_skip(&relative, "not UTF-8");
                    continue;
                }
            };
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64);
            self.connection
                .execute("INSERT INTO docs(path, body) VALUES (?1, ?2)", params![relative, body])
                .map_err(|error| sqlite_error("insert a document into the search index", error))?;
            self.connection
                .execute(
                    "INSERT INTO meta(path, size, modified_ms) VALUES (?1, ?2, ?3)",
                    params![relative, size as i64, modified.map(|m| m as i64)],
                )
                .map_err(|error| sqlite_error("record document metadata", error))?;
            if self.stats.chunk_count < MAX_EMBED_CHUNKS {
                for (start_line, end_line, text) in chunk_body(&body) {
                    if self.stats.chunk_count >= MAX_EMBED_CHUNKS {
                        self.stats.chunks_truncated = true;
                        break;
                    }
                    self.connection
                        .execute(
                            "INSERT INTO chunks(path, start_line, end_line, body) VALUES (?1, ?2, ?3, ?4)",
                            params![relative, start_line, end_line, text],
                        )
                        .map_err(|error| sqlite_error("record a chunk for embedding", error))?;
                    self.stats.chunk_count += 1;
                }
            } else {
                self.stats.chunks_truncated = true;
            }
            self.stats.indexed_files += 1;
            self.total_bytes += size;
            self.stats.indexed_bytes = self.total_bytes;
        }
        Ok(())
    }
}

fn build_index(root: &Path) -> Result<(Connection, IndexStats), CommandError> {
    let started = Instant::now();
    let connection = open_memory_connection()?;
    connection
        .execute_batch("BEGIN")
        .map_err(|error| sqlite_error("start the index transaction", error))?;
    let stats = {
        let mut walker = Walker {
            root,
            connection: &connection,
            stats: IndexStats {
                indexed_files: 0,
                indexed_bytes: 0,
                skipped_files: 0,
                skipped_directories: 0,
                skipped_reasons: SkippedReasons::default(),
                skipped_samples: Vec::new(),
                truncated: false,
                truncation_reason: None,
                built_at_ms: 0,
                build_ms: 0,
                chunk_count: 0,
                chunks_truncated: false,
            },
            total_bytes: 0,
            seen_dirs: HashSet::new(),
        };
        walker.walk(root, 0)?;
        walker.stats
    };
    connection
        .execute_batch("COMMIT")
        .map_err(|error| sqlite_error("commit the search index", error))?;
    let mut stats = stats;
    stats.built_at_ms = now_ms();
    stats.build_ms = elapsed_ms(started);
    Ok((connection, stats))
}

/// Turns free text into a safe FTS5 expression: each term becomes a quoted phrase token with a
/// prefix wildcard, joined by implicit AND. Quotes, operators and column filters from the user
/// are neutralized by the quoting, so the user cannot inject FTS syntax.
pub(crate) fn to_fts_query(raw: &str) -> Result<String, CommandError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CommandError::new("search_query_empty", "Enter something to search for."));
    }
    if trimmed.chars().count() > MAX_QUERY_CHARS {
        return Err(CommandError::new(
            "search_query_too_long",
            format!("Search queries are limited to {MAX_QUERY_CHARS} characters."),
        ));
    }
    let terms = trimmed
        .split(|ch: char| !(ch.is_alphanumeric() || ch == '_'))
        .filter(|term| !term.is_empty())
        .take(MAX_QUERY_TERMS)
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return Err(CommandError::new(
            "search_query_empty",
            "The query contains no searchable words (letters, digits or underscores).",
        ));
    }
    Ok(terms
        .iter()
        .map(|term| format!("\"{}\"*", term.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" "))
}

fn validate_prefix(raw: &str) -> Result<String, CommandError> {
    let prefix = raw.trim().trim_start_matches("./").trim_start_matches('/');
    if prefix.len() > 512 || prefix.contains("..") || prefix.contains('\\') || prefix.contains('\0') {
        return Err(CommandError::new(
            "search_prefix_invalid",
            "Path prefixes must be short workspace-relative paths without traversal.",
        ));
    }
    Ok(prefix.to_string())
}

fn bound_snippet(snippet: &str) -> String {
    let single_line = snippet
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if single_line.chars().count() <= MAX_SNIPPET_CHARS {
        return single_line;
    }
    let mut cut = single_line.chars().take(MAX_SNIPPET_CHARS).collect::<String>();
    cut.push('…');
    cut
}

struct LexicalHit {
    path: String,
    rank: f64,
    snippet: String,
    size: u64,
    modified_ms: Option<u64>,
}

struct LexicalResult {
    fts_query: String,
    hits: Vec<LexicalHit>,
    total_matches: usize,
}

fn lexical_search(
    connection: &Connection,
    query: &str,
    prefix: &str,
    limit: usize,
) -> Result<LexicalResult, CommandError> {
    let fts_query = to_fts_query(query)?;
    let like = format!("{}%", prefix.replace('%', "").replace('_', "\\_"));

    let total_matches: usize = connection
        .query_row(
            "SELECT COUNT(*) FROM docs WHERE docs MATCH ?1 AND path LIKE ?2 ESCAPE '\\'",
            params![fts_query, like],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| sqlite_error("count search matches", error))?
        .max(0) as usize;

    let mut statement = connection
        .prepare(
            "SELECT docs.path, bm25(docs, 2.0, 1.0) AS score,
                    snippet(docs, 1, '[', ']', '…', ?3) AS snip,
                    meta.size, meta.modified_ms
             FROM docs JOIN meta ON meta.path = docs.path
             WHERE docs MATCH ?1 AND docs.path LIKE ?2 ESCAPE '\\'
             ORDER BY score ASC, docs.path ASC
             LIMIT ?4",
        )
        .map_err(|error| sqlite_error("prepare the search query", error))?;
    let rows = statement
        .query_map(
            params![fts_query, like, SNIPPET_TOKENS, limit as i64],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            },
        )
        .map_err(|error| sqlite_error("run the search query", error))?;

    let mut hits = Vec::new();
    for row in rows {
        let (path, rank, snippet, size, modified) = row.map_err(|error| sqlite_error("read a search hit", error))?;
        hits.push(LexicalHit {
            path,
            rank,
            snippet: bound_snippet(&snippet),
            size: size.max(0) as u64,
            modified_ms: modified.map(|m| m.max(0) as u64),
        });
    }
    Ok(LexicalResult { fts_query, hits, total_matches })
}

fn file_meta(connection: &Connection, path: &str) -> (u64, Option<u64>) {
    connection
        .query_row(
            "SELECT size, modified_ms FROM meta WHERE path = ?1",
            params![path],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .map(|(size, modified)| (size.max(0) as u64, modified.map(|m| m.max(0) as u64)))
        .unwrap_or((0, None))
}

fn dot(a: &[f32], b: &[f32]) -> f64 {
    a.iter().zip(b).map(|(x, y)| f64::from(*x) * f64::from(*y)).sum()
}

struct SemanticHit {
    path: String,
    score: f64,
    preview: String,
    start_line: u32,
    end_line: u32,
}

/// Cosine similarity over unit vectors, best chunk per file, filtered by path prefix.
fn semantic_rank(store: &EmbeddingStore, query_vector: &[f32], prefix: &str, limit: usize) -> Vec<SemanticHit> {
    let mut best: std::collections::HashMap<&str, (f64, &EmbeddedChunk)> = std::collections::HashMap::new();
    for chunk in &store.chunks {
        if !prefix.is_empty() && !chunk.path.starts_with(prefix) {
            continue;
        }
        if chunk.vector.len() != query_vector.len() {
            continue;
        }
        let score = dot(&chunk.vector, query_vector);
        let entry = best.entry(chunk.path.as_str()).or_insert((f64::NEG_INFINITY, chunk));
        if score > entry.0 {
            *entry = (score, chunk);
        }
    }
    let mut ranked = best
        .into_values()
        .map(|(score, chunk)| SemanticHit {
            path: chunk.path.clone(),
            score,
            preview: chunk.preview.clone(),
            start_line: chunk.start_line,
            end_line: chunk.end_line,
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.path.cmp(&b.path)));
    ranked.truncate(limit);
    ranked
}

/// (path, fused score, contributing sources)
type FusedHit = (String, f64, Vec<&'static str>);

/// Reciprocal-rank fusion of the two ranked lists; deterministic tie-break on path.
pub(crate) fn fuse_rankings(lexical: &[String], semantic: &[String], limit: usize) -> Vec<FusedHit> {
    let mut scores: std::collections::HashMap<&str, (f64, Vec<&'static str>)> = std::collections::HashMap::new();
    for (position, path) in lexical.iter().enumerate() {
        let entry = scores.entry(path.as_str()).or_insert((0.0, Vec::new()));
        entry.0 += 1.0 / (RRF_K + position as f64 + 1.0);
        entry.1.push("lexical");
    }
    for (position, path) in semantic.iter().enumerate() {
        let entry = scores.entry(path.as_str()).or_insert((0.0, Vec::new()));
        entry.0 += 1.0 / (RRF_K + position as f64 + 1.0);
        entry.1.push("semantic");
    }
    let mut fused = scores
        .into_iter()
        .map(|(path, (score, sources))| (path.to_string(), score, sources))
        .collect::<Vec<_>>();
    fused.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.0.cmp(&b.0)));
    fused.truncate(limit);
    fused
}

fn apply_snippet_budget(hits: &mut [SearchHit]) {
    let mut budget = MAX_TOTAL_SNIPPET_CHARS;
    for hit in hits.iter_mut() {
        let chars = hit.snippet.chars().count();
        if chars > budget {
            hit.snippet.clear();
        } else {
            budget -= chars;
        }
    }
}

fn lexical_response(
    connection: &Connection,
    request: &SearchQueryRequest,
    prefix: &str,
    limit: usize,
    started: Instant,
) -> Result<SearchQueryResponse, CommandError> {
    let lexical = lexical_search(connection, &request.query, prefix, limit)?;
    let mut hits = lexical
        .hits
        .into_iter()
        .map(|hit| SearchHit {
            path: hit.path,
            rank: hit.rank,
            snippet: hit.snippet,
            size: hit.size,
            modified_ms: hit.modified_ms,
            sources: vec!["lexical"],
            semantic_score: None,
            start_line: None,
            end_line: None,
        })
        .collect::<Vec<_>>();
    apply_snippet_budget(&mut hits);
    let truncated = lexical.total_matches > hits.len();
    Ok(SearchQueryResponse {
        query: request.query.trim().to_string(),
        fts_query: lexical.fts_query,
        mode: SearchMode::Lexical,
        score_kind: "bm25 (lower is better)",
        hits,
        total_matches: lexical.total_matches,
        truncated,
        semantic_used: false,
        semantic_note: None,
        elapsed_ms: elapsed_ms(started),
    })
}

fn semantic_or_hybrid_response(
    connection: &Connection,
    store: &EmbeddingStore,
    request: &SearchQueryRequest,
    prefix: &str,
    limit: usize,
    query_vector: &[f32],
    started: Instant,
) -> Result<SearchQueryResponse, CommandError> {
    let semantic = semantic_rank(store, query_vector, prefix, MAX_HITS);
    let mut hits = Vec::new();
    let (fts_query, total_matches, score_kind) = if request.mode == SearchMode::Semantic {
        for hit in semantic.iter().take(limit) {
            let (size, modified_ms) = file_meta(connection, &hit.path);
            hits.push(SearchHit {
                path: hit.path.clone(),
                rank: hit.score,
                snippet: hit.preview.clone(),
                size,
                modified_ms,
                sources: vec!["semantic"],
                semantic_score: Some(hit.score),
                start_line: Some(hit.start_line),
                end_line: Some(hit.end_line),
            });
        }
        (String::new(), semantic.len(), "cosine similarity (higher is better)")
    } else {
        let lexical = lexical_search(connection, &request.query, prefix, MAX_HITS)?;
        let lexical_paths = lexical.hits.iter().map(|hit| hit.path.clone()).collect::<Vec<_>>();
        let semantic_paths = semantic.iter().map(|hit| hit.path.clone()).collect::<Vec<_>>();
        let fused = fuse_rankings(&lexical_paths, &semantic_paths, limit);
        let total = {
            let mut union: HashSet<&str> = lexical_paths.iter().map(String::as_str).collect();
            union.extend(semantic_paths.iter().map(String::as_str));
            union.len().max(lexical.total_matches)
        };
        for (path, score, sources) in fused {
            let lexical_hit = lexical.hits.iter().find(|hit| hit.path == path);
            let semantic_hit = semantic.iter().find(|hit| hit.path == path);
            let (size, modified_ms) = match lexical_hit {
                Some(hit) => (hit.size, hit.modified_ms),
                None => file_meta(connection, &path),
            };
            let snippet = lexical_hit
                .map(|hit| hit.snippet.clone())
                .or_else(|| semantic_hit.map(|hit| hit.preview.clone()))
                .unwrap_or_default();
            hits.push(SearchHit {
                path,
                rank: score,
                snippet,
                size,
                modified_ms,
                sources,
                semantic_score: semantic_hit.map(|hit| hit.score),
                start_line: semantic_hit.map(|hit| hit.start_line),
                end_line: semantic_hit.map(|hit| hit.end_line),
            });
        }
        (lexical.fts_query, total, "reciprocal-rank fusion (higher is better)")
    };
    apply_snippet_budget(&mut hits);
    let truncated = total_matches > hits.len();
    let total_chunks = chunk_total(connection);
    let complete = store.chunks.len() >= total_chunks;
    Ok(SearchQueryResponse {
        query: request.query.trim().to_string(),
        fts_query,
        mode: request.mode,
        score_kind,
        hits,
        total_matches,
        truncated,
        semantic_used: true,
        semantic_note: if complete {
            None
        } else {
            Some(format!(
                "Semantic ranking covers {} of {} chunks; run Embed again to finish.",
                store.chunks.len(),
                total_chunks
            ))
        },
        elapsed_ms: elapsed_ms(started),
    })
}

fn chunk_total(connection: &Connection) -> usize {
    connection
        .query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get::<_, i64>(0))
        .map(|count| count.max(0) as usize)
        .unwrap_or(0)
}

/// Lexical-only entry point kept for tests and for the `Lexical` mode.
fn run_query(connection: &Connection, request: &SearchQueryRequest) -> Result<SearchQueryResponse, CommandError> {
    let started = Instant::now();
    let prefix = validate_prefix(&request.path_prefix)?;
    let limit = request.limit.unwrap_or(DEFAULT_HITS).clamp(1, MAX_HITS);
    lexical_response(connection, request, &prefix, limit, started)
}

fn semantic_status(store: &EmbeddingStore, total_chunks: usize) -> SemanticStatus {
    let embedded = store.chunks.len();
    SemanticStatus {
        total_chunks,
        embedded_chunks: embedded,
        complete: total_chunks > 0 && embedded >= total_chunks,
        endpoint: store.endpoint.clone(),
        model: store.model.clone(),
        dims: store.dims,
        vector_bytes: store.vector_bytes,
        truncated: store.truncated,
        note: "optional; vectors come from the loopback-only Ollama adapter, live in process memory and are dropped with the index",
    }
}

impl SearchIndexService {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, IndexInner>, CommandError> {
        self.inner
            .lock()
            .map_err(|_| CommandError::new("state_unavailable", "Search index state is unavailable."))
    }

    fn status_for(&self, current_root: Option<&Path>) -> Result<SearchIndexStatus, CommandError> {
        let inner = self.lock()?;
        let workspace_matches = match (&inner.workspace_root, current_root) {
            (Some(indexed), Some(current)) => indexed == current,
            _ => false,
        };
        let total_chunks = if workspace_matches {
            inner.connection.as_ref().map(chunk_total).unwrap_or(0)
        } else {
            0
        };
        Ok(SearchIndexStatus {
            available: inner.connection.is_some() && workspace_matches,
            workspace_matches,
            stats: if workspace_matches { inner.stats.clone() } else { None },
            storage: "in-memory SQLite FTS5 plus in-memory vectors; never written to disk, dropped on workspace close",
            semantic: semantic_status(&inner.embeddings, total_chunks),
            limits: limits(),
        })
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.connection = None;
            inner.workspace_root = None;
            inner.stats = None;
            inner.generation = inner.generation.wrapping_add(1);
            inner.embeddings.reset();
        }
    }
}

fn require_current_index<'a>(inner: &'a IndexInner, root: &Path) -> Result<&'a Connection, CommandError> {
    if inner.workspace_root.as_deref() != Some(root) {
        return Err(CommandError::new(
            "search_index_stale",
            "The search index belongs to a different workspace. Build it again for the current workspace.",
        ));
    }
    inner.connection.as_ref().ok_or_else(|| {
        CommandError::new(
            "search_index_missing",
            "No search index has been built for this workspace yet. Build it first.",
        )
    })
}

struct PendingChunk {
    id: i64,
    path: String,
    start_line: u32,
    end_line: u32,
    body: String,
}

fn next_pending_chunks(connection: &Connection, after_id: i64, count: usize) -> Result<Vec<PendingChunk>, CommandError> {
    let mut statement = connection
        .prepare("SELECT id, path, start_line, end_line, body FROM chunks WHERE id > ?1 ORDER BY id LIMIT ?2")
        .map_err(|error| sqlite_error("prepare the chunk query", error))?;
    let rows = statement
        .query_map(params![after_id, count as i64], |row| {
            Ok(PendingChunk {
                id: row.get(0)?,
                path: row.get(1)?,
                start_line: row.get::<_, i64>(2)?.max(0) as u32,
                end_line: row.get::<_, i64>(3)?.max(0) as u32,
                body: row.get(4)?,
            })
        })
        .map_err(|error| sqlite_error("read pending chunks", error))?;
    let pending = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sqlite_error("read a pending chunk", error))?;
    Ok(pending)
}

struct MergeOutcome {
    embedded: usize,
    prompt_eval_count: u64,
    truncated: bool,
}

/// Folds one embedding batch into the store, refusing it if the index generation or the
/// endpoint/model target changed while the network call was in flight.
fn merge_batch(
    inner: &mut IndexInner,
    generation: u64,
    endpoint: &str,
    model: &str,
    pending: Vec<PendingChunk>,
    batch: EmbeddingBatch,
) -> Result<MergeOutcome, CommandError> {
    if inner.generation != generation
        || inner.embeddings.model.as_deref() != Some(model)
        || inner.embeddings.endpoint.as_deref() != Some(endpoint)
    {
        return Err(CommandError::new(
            "search_index_stale",
            "The search index changed while embedding; start the embedding pass again.",
        ));
    }
    if batch.model != model || batch.endpoint != endpoint {
        return Err(CommandError::new(
            "ollama_protocol_error",
            "The embedding batch was produced for a different endpoint or model.",
        ));
    }
    if inner.embeddings.dims == 0 {
        inner.embeddings.dims = batch.dims;
    } else if inner.embeddings.dims != batch.dims {
        return Err(CommandError::new(
            "ollama_protocol_error",
            "The embedding model returned vectors of a different dimension than earlier batches.",
        ));
    }
    let mut embedded = 0usize;
    for (chunk, vector) in pending.into_iter().zip(batch.vectors.into_iter()) {
        let bytes = vector.len() * std::mem::size_of::<f32>();
        if inner.embeddings.vector_bytes + bytes > MAX_VECTOR_BYTES {
            inner.embeddings.truncated = true;
            break;
        }
        inner.embeddings.vector_bytes += bytes;
        inner.embeddings.next_chunk_id = chunk.id;
        inner.embeddings.chunks.push(EmbeddedChunk {
            path: chunk.path,
            start_line: chunk.start_line,
            end_line: chunk.end_line,
            preview: preview_of(&chunk.body),
            vector,
        });
        embedded += 1;
    }
    Ok(MergeOutcome {
        embedded,
        prompt_eval_count: batch.prompt_eval_count,
        truncated: inner.embeddings.truncated,
    })
}

fn preview_of(body: &str) -> String {
    let single = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview: String = single.chars().take(MAX_SNIPPET_CHARS).collect();
    if single.chars().count() > MAX_SNIPPET_CHARS {
        preview.push('…');
    }
    preview
}

#[tauri::command]
pub async fn search_index_build(
    workspace: State<'_, WorkspaceService>,
    index: State<'_, SearchIndexService>,
) -> Result<SearchIndexStatus, CommandError> {
    let root = workspace.root_path()?;
    let build_root = root.clone();
    let (connection, stats) = tauri::async_runtime::spawn_blocking(move || build_index(&build_root))
        .await
        .map_err(|_| CommandError::new("search_index_error", "The search index worker stopped unexpectedly."))??;
    {
        let mut inner = index.lock()?;
        inner.connection = Some(connection);
        inner.workspace_root = Some(root.clone());
        inner.stats = Some(stats);
        inner.generation = inner.generation.wrapping_add(1);
        inner.embeddings.reset();
    }
    index.status_for(Some(&root))
}

#[tauri::command]
pub fn search_index_status(
    workspace: State<'_, WorkspaceService>,
    index: State<'_, SearchIndexService>,
) -> Result<SearchIndexStatus, CommandError> {
    let root = workspace.root_path().ok();
    index.status_for(root.as_deref())
}

/// Embeds the next few batches of pending chunks through the loopback Ollama adapter. Each call
/// is bounded (`MAX_EMBED_BATCHES_PER_CALL` × `MAX_EMBED_BATCH` chunks); React calls it repeatedly
/// until `semantic.complete`. Switching endpoint/model restarts from the first chunk. The service
/// mutex is released while the network call runs, and results are dropped if the index changed.
#[tauri::command]
pub async fn search_index_embed(
    request: SearchEmbedRequest,
    workspace: State<'_, WorkspaceService>,
    index: State<'_, SearchIndexService>,
) -> Result<SearchEmbedResponse, CommandError> {
    let started = Instant::now();
    let root = workspace.root_path()?;
    let (endpoint, model) = validate_embed_target(&request.endpoint, &request.model)?;

    let mut embedded_now = 0usize;
    let mut prompt_eval_count = 0u64;
    let mut restarted = false;
    for _ in 0..MAX_EMBED_BATCHES_PER_CALL {
        // Phase 1: under the lock, pick the next pending batch (or restart for a new model).
        let (generation, pending) = {
            let mut inner = index.lock()?;
            require_current_index(&inner, &root)?;
            let same_target = inner.embeddings.endpoint.as_deref() == Some(endpoint.as_str())
                && inner.embeddings.model.as_deref() == Some(model.as_str());
            if !same_target {
                if inner.embeddings.model.is_some() {
                    restarted = true;
                }
                inner.embeddings.reset();
                inner.embeddings.endpoint = Some(endpoint.clone());
                inner.embeddings.model = Some(model.clone());
            }
            if inner.embeddings.truncated {
                break;
            }
            let after_id = inner.embeddings.next_chunk_id;
            let connection = require_current_index(&inner, &root)?;
            let pending = next_pending_chunks(connection, after_id, MAX_EMBED_BATCH)?;
            (inner.generation, pending)
        };
        if pending.is_empty() {
            break;
        }

        // Phase 2: network call with the lock released.
        let batch_endpoint = endpoint.clone();
        let batch_model = model.clone();
        let bodies = pending.iter().map(|chunk| chunk.body.clone()).collect::<Vec<_>>();
        let batch = blocking(move || {
            let inputs = bodies.iter().map(String::as_str).collect::<Vec<_>>();
            embed_texts(&batch_endpoint, &batch_model, &inputs)
        })
        .await?;

        // Phase 3: merge only if the index is still the same generation and target.
        let merged = {
            let mut inner = index.lock()?;
            merge_batch(&mut inner, generation, &endpoint, &model, pending, batch)?
        };
        embedded_now += merged.embedded;
        prompt_eval_count = prompt_eval_count.saturating_add(merged.prompt_eval_count);
        if merged.truncated {
            break;
        }
    }

    let inner = index.lock()?;
    let connection = require_current_index(&inner, &root)?;
    let total = chunk_total(connection);
    Ok(SearchEmbedResponse {
        semantic: semantic_status(&inner.embeddings, total),
        embedded_now,
        restarted,
        prompt_eval_count,
        elapsed_ms: elapsed_ms(started),
    })
}

#[tauri::command]
pub async fn search_index_query(
    request: SearchQueryRequest,
    workspace: State<'_, WorkspaceService>,
    index: State<'_, SearchIndexService>,
) -> Result<SearchQueryResponse, CommandError> {
    let started = Instant::now();
    let root = workspace.root_path()?;
    let prefix = validate_prefix(&request.path_prefix)?;
    let limit = request.limit.unwrap_or(DEFAULT_HITS).clamp(1, MAX_HITS);
    // Validate the query text first so an empty query never reaches the embedding model.
    to_fts_query(&request.query)?;

    if request.mode == SearchMode::Lexical {
        let inner = index.lock()?;
        let connection = require_current_index(&inner, &root)?;
        return lexical_response(connection, &request, &prefix, limit, started);
    }

    // Semantic/hybrid: confirm vectors exist for the requested target before embedding the query.
    let (endpoint, model) = validate_embed_target(&request.endpoint, &request.model)?;
    {
        let inner = index.lock()?;
        require_current_index(&inner, &root)?;
        if inner.embeddings.chunks.is_empty()
            || inner.embeddings.model.as_deref() != Some(model.as_str())
            || inner.embeddings.endpoint.as_deref() != Some(endpoint.as_str())
        {
            return Err(CommandError::new(
                "search_semantic_missing",
                format!("No embeddings exist for model `{model}` on this index. Run Embed first, or switch to lexical mode."),
            ));
        }
    }
    let query_text = request.query.trim().to_string();
    let batch = blocking(move || embed_texts(&endpoint, &model, &[query_text.as_str()])).await?;
    let query_vector = batch.vectors.into_iter().next().ok_or_else(|| {
        CommandError::new("ollama_protocol_error", "The embedding model returned no vector for the query.")
    })?;

    let inner = index.lock()?;
    let connection = require_current_index(&inner, &root)?;
    if inner.embeddings.dims != query_vector.len() {
        return Err(CommandError::new(
            "ollama_protocol_error",
            "The query vector dimension does not match the indexed vectors; re-run Embed.",
        ));
    }
    semantic_or_hybrid_response(connection, &inner.embeddings, &request, &prefix, limit, &query_vector, started)
}

#[tauri::command]
pub fn search_index_clear(index: State<'_, SearchIndexService>) -> Result<(), CommandError> {
    index.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_workspace(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("devlab-search-{name}-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn lexical(query: &str, limit: Option<usize>, prefix: &str) -> SearchQueryRequest {
        SearchQueryRequest {
            query: query.into(),
            limit,
            path_prefix: prefix.into(),
            mode: SearchMode::Lexical,
            endpoint: String::new(),
            model: String::new(),
        }
    }

    fn unit(values: &[f32]) -> Vec<f32> {
        let norm = values.iter().map(|v| v * v).sum::<f32>().sqrt();
        values.iter().map(|v| v / norm).collect()
    }

    fn write(dir: &Path, relative: &str, content: &[u8]) {
        let path = dir.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = fs::File::create(path).unwrap();
        file.write_all(content).unwrap();
    }

    #[test]
    fn fts_query_quotes_terms_and_neutralizes_operators() {
        assert_eq!(to_fts_query("hello world").unwrap(), "\"hello\"* \"world\"*");
        assert_eq!(to_fts_query("foo OR bar").unwrap(), "\"foo\"* \"OR\"* \"bar\"*");
        assert_eq!(to_fts_query("path:\"x\" NOT y").unwrap(), "\"path\"* \"x\"* \"NOT\"* \"y\"*");
        assert_eq!(to_fts_query("snake_case").unwrap(), "\"snake_case\"*");
        assert_eq!(to_fts_query("   ").unwrap_err().code, "search_query_empty");
        assert_eq!(to_fts_query("!!! ---").unwrap_err().code, "search_query_empty");
        assert_eq!(to_fts_query(&"a".repeat(MAX_QUERY_CHARS + 1)).unwrap_err().code, "search_query_too_long");
        let many = (0..MAX_QUERY_TERMS + 5).map(|i| format!("t{i}")).collect::<Vec<_>>().join(" ");
        assert_eq!(to_fts_query(&many).unwrap().matches('*').count(), MAX_QUERY_TERMS);
    }

    #[test]
    fn skip_rules_cover_directories_secrets_and_binaries() {
        assert!(is_skipped_directory("node_modules") && is_skipped_directory(".git") && is_skipped_directory("target"));
        assert!(!is_skipped_directory("src"));
        for name in [".env", ".env.local", "id_rsa", "id_rsa.pub", "server.pem", "site.key", "secrets.yaml", ".npmrc"] {
            assert!(is_secret_file(name), "{name} should be skipped as secret");
        }
        for name in [".env.example", "keys.ts", "environment.ts", "secretsHelper.ts"] {
            assert!(!is_secret_file(name), "{name} should not be treated as secret");
        }
        assert!(is_binary_extension("logo.png") && is_binary_extension("bundle.min.js") && is_binary_extension("app.wasm"));
        assert!(!is_binary_extension("main.rs") && !is_binary_extension("README") && !is_binary_extension("index.js"));
    }

    #[test]
    fn prefix_validation_and_snippet_bounds() {
        assert_eq!(validate_prefix(" ./src/ ").unwrap(), "src/");
        assert_eq!(validate_prefix("").unwrap(), "");
        assert_eq!(validate_prefix("../x").unwrap_err().code, "search_prefix_invalid");
        assert_eq!(validate_prefix("a\\b").unwrap_err().code, "search_prefix_invalid");
        let long = format!("x {}", "y".repeat(MAX_SNIPPET_CHARS * 2));
        let bounded = bound_snippet(&long);
        assert_eq!(bounded.chars().count(), MAX_SNIPPET_CHARS + 1);
        assert!(bounded.ends_with('…'));
        assert_eq!(bound_snippet("a\n\n  b\tc"), "a b c");
    }

    #[test]
    fn builds_and_queries_a_bounded_index() {
        let dir = temp_workspace("basic");
        write(&dir, "src/main.rs", b"fn main() { println!(\"hello devlab\"); }");
        write(&dir, "src/lib/search_helper.rs", b"pub fn search_helper() -> &'static str { \"devlab search\" }");
        write(&dir, "docs/notes.md", b"# Notes\nThe search index is bounded.");
        write(&dir, "node_modules/pkg/index.js", b"module.exports = 'devlab should not be indexed';");
        write(&dir, ".env", b"SECRET_TOKEN=devlab-super-secret");
        write(&dir, "logo.png", &[0x89, b'P', b'N', b'G', 0, 1, 2]);
        write(&dir, "binary.dat", &[0x00, 0xff, 0x10, b'd', b'e', b'v', b'l', b'a', b'b']);
        write(&dir, "latin1.txt", &[b'd', b'e', b'v', b'l', b'a', b'b', 0xe9]);

        let (connection, stats) = build_index(&dir).unwrap();
        assert_eq!(stats.indexed_files, 3, "only the three text files should be indexed: {:?}", stats.skipped_samples);
        assert_eq!(stats.chunk_count, 3, "one chunk per small text file");
        assert!(!stats.chunks_truncated);
        assert_eq!(chunk_total(&connection), 3);
        let pending = next_pending_chunks(&connection, 0, MAX_EMBED_BATCH).unwrap();
        assert_eq!(pending.len(), 3);
        assert!(pending.iter().all(|chunk| chunk.start_line == 1 && chunk.end_line >= 1));
        assert!(pending.iter().all(|chunk| !chunk.path.ends_with(".env")));
        assert!(next_pending_chunks(&connection, pending[2].id, MAX_EMBED_BATCH).unwrap().is_empty());
        assert_eq!(stats.skipped_reasons.ignored_directory, 1);
        assert_eq!(stats.skipped_reasons.secret_pattern, 1);
        assert_eq!(stats.skipped_reasons.binary_extension, 1);
        assert_eq!(stats.skipped_reasons.not_utf8, 2);
        assert!(!stats.truncated);

        let response = run_query(&connection, &lexical("devlab", None, "")).unwrap();
        let paths = response.hits.iter().map(|hit| hit.path.as_str()).collect::<Vec<_>>();
        assert!(paths.contains(&"src/main.rs") && paths.contains(&"src/lib/search_helper.rs"));
        assert!(!paths.iter().any(|p| p.contains("node_modules") || p.ends_with(".env")));
        assert!(!response.hits.iter().any(|hit| hit.snippet.contains("super-secret")));
        assert_eq!(response.fts_query, "\"devlab\"*");
        assert!(response.hits.iter().all(|hit| hit.snippet.contains('[')), "snippets highlight matches");

        let scoped = run_query(&connection, &lexical("search", Some(1), "docs/")).unwrap();
        assert_eq!(scoped.hits.len(), 1);
        assert_eq!(scoped.hits[0].path, "docs/notes.md");

        let prefix_match = run_query(&connection, &lexical("sear", None, "")).unwrap();
        assert!(prefix_match.total_matches >= 2, "prefix wildcard should match 'search'");

        let none = run_query(&connection, &lexical("zzzznotthere", None, "")).unwrap();
        assert!(none.hits.is_empty() && none.total_matches == 0);

        let injected = run_query(&connection, &lexical("devlab\" OR path:\"src", None, "")).unwrap();
        assert_eq!(injected.fts_query, "\"devlab\"* \"OR\"* \"path\"* \"src\"*");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn symlinks_and_oversized_files_are_skipped() {
        let dir = temp_workspace("limits");
        write(&dir, "big.txt", &vec![b'a'; (MAX_FILE_BYTES + 1) as usize]);
        write(&dir, "ok.txt", b"small devlab file");
        #[cfg(unix)]
        {
            let outside = temp_workspace("outside");
            write(&outside, "leak.txt", b"devlab outside workspace");
            std::os::unix::fs::symlink(outside.join("leak.txt"), dir.join("link.txt")).unwrap();
            std::os::unix::fs::symlink(&outside, dir.join("linkdir")).unwrap();
        }
        let (connection, stats) = build_index(&dir).unwrap();
        assert_eq!(stats.indexed_files, 1);
        assert_eq!(stats.skipped_reasons.too_large, 1);
        #[cfg(unix)]
        {
            assert_eq!(stats.skipped_reasons.symlink, 2);
        }
        let response = run_query(&connection, &lexical("devlab", None, "")).unwrap();
        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.hits[0].path, "ok.txt");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn chunking_is_line_aligned_and_bounded() {
        assert!(chunk_body("").is_empty());
        assert!(chunk_body("\n\n   \n").is_empty());
        let small = chunk_body("line one\nline two\n");
        assert_eq!(small.len(), 1);
        assert_eq!((small[0].0, small[0].1), (1, 2));
        assert_eq!(small[0].2, "line one\nline two\n");

        let line = format!("{}\n", "x".repeat(299));
        let body = line.repeat(100); // 100 lines × 300 chars → 4 lines per chunk
        let chunks = chunk_body(&body);
        assert_eq!(chunks.len(), MAX_CHUNKS_PER_FILE);
        assert_eq!((chunks[0].0, chunks[0].1), (1, 4));
        assert_eq!((chunks[1].0, chunks[1].1), (5, 8));
        assert!(chunks.iter().all(|(_, _, text)| text.chars().count() <= MAX_EMBED_INPUT_CHARS));
        assert!(chunks.windows(2).all(|pair| pair[1].0 == pair[0].1 + 1));
    }

    #[test]
    fn semantic_ranking_and_fusion_are_deterministic() {
        let mut store = EmbeddingStore { dims: 3, ..EmbeddingStore::default() };
        let mut push = |path: &str, start: u32, vector: Vec<f32>| {
            store.chunks.push(EmbeddedChunk { path: path.into(), start_line: start, end_line: start + 3, preview: format!("{path} preview"), vector });
        };
        push("src/a.rs", 1, unit(&[1.0, 0.0, 0.0]));
        push("src/a.rs", 5, unit(&[0.0, 1.0, 0.0]));
        push("src/b.rs", 1, unit(&[0.7, 0.7, 0.0]));
        push("docs/c.md", 1, unit(&[0.0, 0.0, 1.0]));

        let query = unit(&[1.0, 0.1, 0.0]);
        let ranked = semantic_rank(&store, &query, "", 10);
        assert_eq!(ranked.iter().map(|hit| hit.path.as_str()).collect::<Vec<_>>(), ["src/a.rs", "src/b.rs", "docs/c.md"]);
        assert_eq!(ranked[0].start_line, 1, "best chunk per file wins");
        assert!(ranked[0].score > ranked[1].score && ranked[1].score > ranked[2].score);
        let scoped = semantic_rank(&store, &query, "docs/", 10);
        assert_eq!(scoped.len(), 1);
        assert_eq!(semantic_rank(&store, &[1.0, 0.0], "", 10).len(), 0, "dimension mismatch yields nothing");

        let lexical = vec!["src/b.rs".to_string(), "src/z.rs".to_string()];
        let semantic = vec!["src/a.rs".to_string(), "src/b.rs".to_string()];
        let fused = fuse_rankings(&lexical, &semantic, 10);
        assert_eq!(fused[0].0, "src/b.rs", "path present in both lists ranks first");
        assert_eq!(fused[0].2, vec!["lexical", "semantic"]);
        assert_eq!(fused.len(), 3);
        assert!(fused.windows(2).all(|pair| pair[0].1 >= pair[1].1));
        assert_eq!(fuse_rankings(&lexical, &semantic, 1).len(), 1);

        let status = semantic_status(&store, 8);
        assert_eq!(status.embedded_chunks, 4);
        assert!(!status.complete);
    }

    #[test]
    fn service_status_tracks_workspace_identity() {
        let service = SearchIndexService::default();
        let a = temp_workspace("a");
        let b = temp_workspace("b");
        write(&a, "x.txt", b"devlab");
        let (connection, stats) = build_index(&a).unwrap();
        {
            let mut inner = service.lock().unwrap();
            inner.connection = Some(connection);
            inner.workspace_root = Some(a.clone());
            inner.stats = Some(stats);
        }
        assert!(service.status_for(Some(&a)).unwrap().available);
        let other = service.status_for(Some(&b)).unwrap();
        assert!(!other.available && !other.workspace_matches && other.stats.is_none());
        service.clear();
        assert!(!service.status_for(Some(&a)).unwrap().available);
        fs::remove_dir_all(&a).ok();
        fs::remove_dir_all(&b).ok();
    }
}
