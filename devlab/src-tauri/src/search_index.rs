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
//! * Semantic (embedding) search is not part of this slice; the status struct reports that.

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
    semantic: &'static str,
    limits: IndexLimits,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexLimits {
    max_files: usize,
    max_file_bytes: u64,
    max_total_bytes: u64,
    max_hits: usize,
    max_query_chars: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchQueryRequest {
    query: String,
    limit: Option<usize>,
    #[serde(default)]
    path_prefix: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    path: String,
    rank: f64,
    snippet: String,
    size: u64,
    modified_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQueryResponse {
    query: String,
    fts_query: String,
    hits: Vec<SearchHit>,
    total_matches: usize,
    truncated: bool,
    elapsed_ms: u64,
}

fn limits() -> IndexLimits {
    IndexLimits {
        max_files: MAX_INDEXED_FILES,
        max_file_bytes: MAX_FILE_BYTES,
        max_total_bytes: MAX_TOTAL_BYTES,
        max_hits: MAX_HITS,
        max_query_chars: MAX_QUERY_CHARS,
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
             CREATE TABLE meta(path TEXT PRIMARY KEY, size INTEGER NOT NULL, modified_ms INTEGER);",
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

fn run_query(connection: &Connection, request: &SearchQueryRequest) -> Result<SearchQueryResponse, CommandError> {
    let started = Instant::now();
    let fts_query = to_fts_query(&request.query)?;
    let prefix = validate_prefix(&request.path_prefix)?;
    let limit = request.limit.unwrap_or(DEFAULT_HITS).clamp(1, MAX_HITS);
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
    let mut snippet_budget = MAX_TOTAL_SNIPPET_CHARS;
    for row in rows {
        let (path, rank, snippet, size, modified) = row.map_err(|error| sqlite_error("read a search hit", error))?;
        let mut snippet = bound_snippet(&snippet);
        let chars = snippet.chars().count();
        if chars > snippet_budget {
            snippet = String::new();
        } else {
            snippet_budget -= chars;
        }
        hits.push(SearchHit {
            path,
            rank,
            snippet,
            size: size.max(0) as u64,
            modified_ms: modified.map(|m| m.max(0) as u64),
        });
    }
    let truncated = total_matches > hits.len();
    Ok(SearchQueryResponse {
        query: request.query.trim().to_string(),
        fts_query,
        hits,
        total_matches,
        truncated,
        elapsed_ms: elapsed_ms(started),
    })
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
        Ok(SearchIndexStatus {
            available: inner.connection.is_some() && workspace_matches,
            workspace_matches,
            stats: if workspace_matches { inner.stats.clone() } else { None },
            storage: "in-memory SQLite FTS5; never written to disk, dropped on workspace close",
            semantic: "not indexed in this phase (lexical bm25 only)",
            limits: limits(),
        })
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.connection = None;
            inner.workspace_root = None;
            inner.stats = None;
        }
    }
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

#[tauri::command]
pub fn search_index_query(
    request: SearchQueryRequest,
    workspace: State<'_, WorkspaceService>,
    index: State<'_, SearchIndexService>,
) -> Result<SearchQueryResponse, CommandError> {
    let root = workspace.root_path()?;
    let inner = index.lock()?;
    if inner.workspace_root.as_deref() != Some(root.as_path()) {
        return Err(CommandError::new(
            "search_index_stale",
            "The search index belongs to a different workspace. Build it again for the current workspace.",
        ));
    }
    let connection = inner.connection.as_ref().ok_or_else(|| {
        CommandError::new(
            "search_index_missing",
            "No search index has been built for this workspace yet. Build it first.",
        )
    })?;
    run_query(connection, &request)
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
        assert_eq!(stats.skipped_reasons.ignored_directory, 1);
        assert_eq!(stats.skipped_reasons.secret_pattern, 1);
        assert_eq!(stats.skipped_reasons.binary_extension, 1);
        assert_eq!(stats.skipped_reasons.not_utf8, 2);
        assert!(!stats.truncated);

        let response = run_query(&connection, &SearchQueryRequest { query: "devlab".into(), limit: None, path_prefix: String::new() }).unwrap();
        let paths = response.hits.iter().map(|hit| hit.path.as_str()).collect::<Vec<_>>();
        assert!(paths.contains(&"src/main.rs") && paths.contains(&"src/lib/search_helper.rs"));
        assert!(!paths.iter().any(|p| p.contains("node_modules") || p.ends_with(".env")));
        assert!(!response.hits.iter().any(|hit| hit.snippet.contains("super-secret")));
        assert_eq!(response.fts_query, "\"devlab\"*");
        assert!(response.hits.iter().all(|hit| hit.snippet.contains('[')), "snippets highlight matches");

        let scoped = run_query(&connection, &SearchQueryRequest { query: "search".into(), limit: Some(1), path_prefix: "docs/".into() }).unwrap();
        assert_eq!(scoped.hits.len(), 1);
        assert_eq!(scoped.hits[0].path, "docs/notes.md");

        let prefix_match = run_query(&connection, &SearchQueryRequest { query: "sear".into(), limit: None, path_prefix: String::new() }).unwrap();
        assert!(prefix_match.total_matches >= 2, "prefix wildcard should match 'search'");

        let none = run_query(&connection, &SearchQueryRequest { query: "zzzznotthere".into(), limit: None, path_prefix: String::new() }).unwrap();
        assert!(none.hits.is_empty() && none.total_matches == 0);

        let injected = run_query(&connection, &SearchQueryRequest { query: "devlab\" OR path:\"src".into(), limit: None, path_prefix: String::new() }).unwrap();
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
        let response = run_query(&connection, &SearchQueryRequest { query: "devlab".into(), limit: None, path_prefix: String::new() }).unwrap();
        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.hits[0].path, "ok.txt");
        fs::remove_dir_all(&dir).ok();
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
