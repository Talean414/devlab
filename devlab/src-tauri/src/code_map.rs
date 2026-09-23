// Phase 9I — workspace-wide Tree-Sitter code map.
//
// Walks the selected workspace (same directory/secret/binary skip rules as the search index),
// parses every file that has a compiled-in grammar with the Phase 9H outline walker and returns a
// bounded, metadata-only symbol map: per file, its top-level (depth 0 and 1) symbols with kind,
// name, one-line signature and line range. File contents never leave Rust; nothing is cached or
// written; the whole build runs under wall-clock, file-count, byte and symbol budgets and reports
// exactly what was skipped or truncated so the renderer can present the map honestly. Phase 9K
// ranks the result with code_rank: imports are extracted during the same walk and turned into a
// dependency graph whose PageRank decides the output order, so the most depended-on modules are
// emitted first and a tight budget costs leaf files instead of core ones.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::code_outline::{grammar_id_for, outline_source, CodeOutlineSymbol};
use crate::code_rank;
use crate::search_index::{is_binary_extension, is_secret_file, is_skipped_directory};
use crate::workspace::{CommandError, WorkspaceService};

const MAX_MAP_FILES: usize = 1_500;
const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_TOTAL_BYTES: u64 = 24 * 1024 * 1024;
const MAX_TOTAL_SYMBOLS: usize = 6_000;
const MAX_SYMBOLS_PER_FILE: usize = 60;
const MAX_MAP_DEPTH: u8 = 1;
const MAX_WALK_DEPTH: usize = 32;
const BUILD_DEADLINE_MS: u64 = 8_000;
const MAX_SKIPPED_SAMPLES: usize = 24;
const MAX_PREFIX_BYTES: usize = 512;
const MAX_TOP_ENTRIES: usize = 10;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeMapRequest {
    /// Optional workspace-relative directory prefix; only files under it are mapped.
    #[serde(default)]
    pub prefix: Option<String>,
    /// When true, only exported/public symbols are kept (the compact "API surface" map).
    #[serde(default)]
    pub exported_only: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeMapFile {
    path: String,
    language: &'static str,
    line_count: u32,
    size: u64,
    symbol_count: usize,
    truncated: bool,
    has_syntax_errors: bool,
    /// Phase 9K: PageRank scaled by the file count, so 1.0 means "an average file".
    importance: f64,
    /// Number of mapped files that import this file.
    in_degree: usize,
    /// Number of mapped files this file imports.
    out_degree: usize,
    /// Specifiers that did not resolve inside the workspace (packages, stdlib, path aliases).
    external_deps: usize,
    symbols: Vec<CodeOutlineSymbol>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeMapSkipped {
    ignored_directory: usize,
    symlink: usize,
    secret_pattern: usize,
    binary_extension: usize,
    unsupported_language: usize,
    too_large: usize,
    not_utf8: usize,
    unreadable: usize,
    parse_failed: usize,
    other_kind: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeMapLimits {
    max_files: usize,
    max_file_bytes: u64,
    max_total_bytes: u64,
    max_total_symbols: usize,
    max_symbols_per_file: usize,
    max_depth: u8,
    build_deadline_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeMap {
    prefix: String,
    exported_only: bool,
    files: Vec<CodeMapFile>,
    file_count: usize,
    symbol_count: usize,
    parsed_bytes: u64,
    skipped_files: usize,
    skipped_directories: usize,
    skipped: CodeMapSkipped,
    skipped_samples: Vec<String>,
    languages: Vec<CodeMapLanguageCount>,
    rank: CodeRank,
    truncated: bool,
    truncation_reason: Option<&'static str>,
    generated_at_ms: u64,
    build_ms: u64,
    limits: CodeMapLimits,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeRankEntry {
    path: String,
    importance: f64,
    in_degree: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeRank {
    /// Files scored, i.e. the whole map.
    nodes: usize,
    /// Resolved import edges between mapped files.
    internal_edges: usize,
    /// Specifiers that pointed outside the workspace.
    external_references: usize,
    /// Files with no resolved in-repo import (leaves, entry points, scripts).
    dangling_nodes: usize,
    iterations: usize,
    damping: f64,
    /// True when the walk stopped early, so the graph and the scores may be incomplete.
    truncated: bool,
    rank_ms: u64,
    /// The most central files, most important first.
    top: Vec<CodeRankEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeMapLanguageCount {
    language: &'static str,
    files: usize,
    symbols: usize,
}

fn limits() -> CodeMapLimits {
    CodeMapLimits {
        max_files: MAX_MAP_FILES,
        max_file_bytes: MAX_FILE_BYTES,
        max_total_bytes: MAX_TOTAL_BYTES,
        max_total_symbols: MAX_TOTAL_SYMBOLS,
        max_symbols_per_file: MAX_SYMBOLS_PER_FILE,
        max_depth: MAX_MAP_DEPTH,
        build_deadline_ms: BUILD_DEADLINE_MS,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

pub(crate) fn validate_prefix(raw: Option<&str>) -> Result<String, CommandError> {
    let prefix = raw
        .unwrap_or("")
        .trim()
        .trim_start_matches("./")
        .trim_matches('/');
    let has_bad_segment = !prefix.is_empty()
        && prefix.split('/').any(|part| part.is_empty() || part == "." || part == "..");
    if prefix.len() > MAX_PREFIX_BYTES || prefix.contains('\0') || prefix.contains('\\') || has_bad_segment {
        return Err(CommandError::new(
            "code_map_prefix_invalid",
            "Code map prefixes must be short workspace-relative directory paths without traversal.",
        ));
    }
    Ok(prefix.to_string())
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

struct Walker {
    root: PathBuf,
    exported_only: bool,
    deadline: Instant,
    files: Vec<CodeMapFile>,
    symbol_count: usize,
    parsed_bytes: u64,
    skipped_files: usize,
    skipped_directories: usize,
    skipped: CodeMapSkipped,
    skipped_samples: Vec<String>,
    truncated: bool,
    truncation_reason: Option<&'static str>,
    seen_dirs: HashSet<PathBuf>,
    /// Phase 9K: raw import specifiers per mapped file, parallel to `files`.
    imports: Vec<Vec<String>>,
}

impl Walker {
    fn note_skip(&mut self, relative: &str, reason: &str) {
        self.skipped_files += 1;
        if self.skipped_samples.len() < MAX_SKIPPED_SAMPLES {
            self.skipped_samples.push(format!("{relative} — {reason}"));
        }
    }

    fn stop(&mut self, reason: &'static str) -> bool {
        self.truncated = true;
        if self.truncation_reason.is_none() {
            self.truncation_reason = Some(reason);
        }
        true
    }

    fn budget_exhausted(&mut self) -> bool {
        if self.files.len() >= MAX_MAP_FILES {
            return self.stop("max_files");
        }
        if self.symbol_count >= MAX_TOTAL_SYMBOLS {
            return self.stop("max_symbols");
        }
        if self.parsed_bytes >= MAX_TOTAL_BYTES {
            return self.stop("max_total_bytes");
        }
        if Instant::now() >= self.deadline {
            return self.stop("deadline");
        }
        false
    }

    fn walk(&mut self, directory: &Path, depth: usize) {
        if depth > MAX_WALK_DEPTH {
            self.skipped_directories += 1;
            return;
        }
        let canonical = fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf());
        if !self.seen_dirs.insert(canonical) {
            return;
        }
        let read_dir = match fs::read_dir(directory) {
            Ok(read_dir) => read_dir,
            Err(_) => {
                self.skipped_directories += 1;
                return;
            }
        };
        let mut entries = read_dir.filter_map(Result::ok).collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if self.budget_exhausted() {
                return;
            }
            let path = entry.path();
            let name = match entry.file_name().into_string() {
                Ok(name) => name,
                Err(_) => {
                    self.skipped.other_kind += 1;
                    self.skipped_files += 1;
                    continue;
                }
            };
            let relative = relative_wire(&self.root, &path).unwrap_or_else(|| name.clone());
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    self.skipped.unreadable += 1;
                    self.note_skip(&relative, "unreadable metadata");
                    continue;
                }
            };
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                self.skipped.symlink += 1;
                self.note_skip(&relative, "symlink");
                continue;
            }
            if file_type.is_dir() {
                if is_skipped_directory(&name) {
                    self.skipped.ignored_directory += 1;
                    self.skipped_directories += 1;
                    continue;
                }
                self.walk(&path, depth + 1);
                continue;
            }
            if !file_type.is_file() {
                self.skipped.other_kind += 1;
                self.note_skip(&relative, "not a regular file");
                continue;
            }
            if is_secret_file(&name) {
                self.skipped.secret_pattern += 1;
                self.note_skip(&relative, "secret-safe skip");
                continue;
            }
            if is_binary_extension(&name) {
                self.skipped.binary_extension += 1;
                self.note_skip(&relative, "binary extension");
                continue;
            }
            let Some(grammar_id) = grammar_id_for(&name) else {
                // Unsupported languages are expected and plentiful; count them without samples.
                self.skipped.unsupported_language += 1;
                self.skipped_files += 1;
                continue;
            };
            let size = metadata.len();
            if size > MAX_FILE_BYTES {
                self.skipped.too_large += 1;
                self.note_skip(&relative, "larger than 256 KiB");
                continue;
            }
            if self.parsed_bytes.saturating_add(size) > MAX_TOTAL_BYTES {
                self.stop("max_total_bytes");
                return;
            }
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => {
                    self.skipped.unreadable += 1;
                    self.note_skip(&relative, "unreadable");
                    continue;
                }
            };
            if bytes.contains(&0) {
                self.skipped.not_utf8 += 1;
                self.note_skip(&relative, "binary content");
                continue;
            }
            let source = match String::from_utf8(bytes) {
                Ok(source) => source,
                Err(_) => {
                    self.skipped.not_utf8 += 1;
                    self.note_skip(&relative, "not UTF-8");
                    continue;
                }
            };
            self.parsed_bytes = self.parsed_bytes.saturating_add(size);
            let parsed = match outline_source(grammar_id, &source) {
                Ok(parsed) => parsed,
                Err(error) => {
                    self.skipped.parse_failed += 1;
                    self.note_skip(&relative, &format!("parse failed ({})", error.code));
                    continue;
                }
            };
            let remaining_budget = MAX_TOTAL_SYMBOLS.saturating_sub(self.symbol_count);
            // In exported-only mode a member is kept when it or its enclosing top-level symbol is
            // exported, so an exported class still shows its methods.
            let mut parent_exported = false;
            let exported_only = self.exported_only;
            let mut symbols = parsed
                .symbols
                .into_iter()
                .filter(|symbol| symbol.depth <= MAX_MAP_DEPTH)
                .filter(|symbol| {
                    if symbol.depth == 0 {
                        parent_exported = symbol.exported;
                    }
                    !exported_only || symbol.exported || (symbol.depth > 0 && parent_exported)
                })
                .collect::<Vec<_>>();
            let kept_before_cap = symbols.len();
            let cap = MAX_SYMBOLS_PER_FILE.min(remaining_budget);
            if symbols.len() > cap {
                symbols.truncate(cap);
            }
            let file_truncated = parsed.truncated || symbols.len() < kept_before_cap;
            let imports = code_rank::extract_imports(grammar_id, &source);
            self.symbol_count += symbols.len();
            self.files.push(CodeMapFile {
                path: relative,
                language: grammar_id,
                line_count: line_count(&source),
                size,
                symbol_count: symbols.len(),
                truncated: file_truncated,
                has_syntax_errors: parsed.has_syntax_errors,
                importance: 0.0,
                in_degree: 0,
                out_degree: 0,
                external_deps: 0,
                symbols,
            });
            self.imports.push(imports);
        }
    }
}

fn line_count(source: &str) -> u32 {
    if source.is_empty() {
        return 0;
    }
    let newlines = source.bytes().filter(|byte| *byte == b'\n').count();
    let trailing = if source.ends_with('\n') { 0 } else { 1 };
    (newlines + trailing).min(u32::MAX as usize) as u32
}

pub(crate) fn build_code_map(root: &Path, prefix: &str, exported_only: bool) -> Result<CodeMap, CommandError> {
    let started = Instant::now();
    let start_dir = if prefix.is_empty() { root.to_path_buf() } else { root.join(prefix) };
    if !prefix.is_empty() {
        let metadata = fs::symlink_metadata(&start_dir).map_err(|error| CommandError::io("inspect the prefix directory", error))?;
        if metadata.file_type().is_symlink() {
            return Err(CommandError::new(
                "symlink_not_allowed",
                "Symbolic links cannot be used as a code map prefix.",
            ));
        }
        if !metadata.is_dir() {
            return Err(CommandError::new(
                "code_map_prefix_invalid",
                "The code map prefix must name an existing workspace directory.",
            ));
        }
        let canonical = fs::canonicalize(&start_dir).map_err(|error| CommandError::io("resolve the prefix directory", error))?;
        if !canonical.starts_with(root) {
            return Err(CommandError::new(
                "outside_workspace",
                "The code map prefix resolves outside the selected workspace.",
            ));
        }
    }
    let mut walker = Walker {
        root: root.to_path_buf(),
        exported_only,
        deadline: started + std::time::Duration::from_millis(BUILD_DEADLINE_MS),
        files: Vec::new(),
        symbol_count: 0,
        parsed_bytes: 0,
        skipped_files: 0,
        skipped_directories: 0,
        skipped: CodeMapSkipped::default(),
        skipped_samples: Vec::new(),
        truncated: false,
        truncation_reason: None,
        seen_dirs: HashSet::new(),
        imports: Vec::new(),
    };
    walker.walk(&start_dir, 0);

    // Phase 9K: score the mapped files by dependency centrality and emit the most depended-on
    // modules first. Ties fall back to path order so the output stays deterministic.
    let rank_started = Instant::now();
    let paths = walker
        .files
        .iter()
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let ranking = code_rank::rank_paths(&paths, &walker.imports);
    for (index, file) in walker.files.iter_mut().enumerate() {
        file.importance = ranking.importance[index];
        file.in_degree = ranking.in_degree[index];
        file.out_degree = ranking.out_degree[index];
        file.external_deps = ranking.external_deps[index];
    }
    walker.files.sort_by(|left, right| {
        right
            .importance
            .total_cmp(&left.importance)
            .then_with(|| left.path.cmp(&right.path))
    });
    let top = walker
        .files
        .iter()
        .take(MAX_TOP_ENTRIES)
        .map(|file| CodeRankEntry {
            path: file.path.clone(),
            importance: file.importance,
            in_degree: file.in_degree,
        })
        .collect::<Vec<_>>();
    let rank = CodeRank {
        nodes: walker.files.len(),
        internal_edges: ranking.internal_edges,
        external_references: ranking.external_references,
        dangling_nodes: ranking.dangling_nodes,
        iterations: ranking.iterations,
        damping: code_rank::RANK_DAMPING,
        truncated: walker.truncated,
        rank_ms: rank_started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        top,
    };

    let mut languages: Vec<CodeMapLanguageCount> = Vec::new();
    for file in &walker.files {
        match languages.iter_mut().find(|entry| entry.language == file.language) {
            Some(entry) => {
                entry.files += 1;
                entry.symbols += file.symbol_count;
            }
            None => languages.push(CodeMapLanguageCount {
                language: file.language,
                files: 1,
                symbols: file.symbol_count,
            }),
        }
    }
    languages.sort_by(|a, b| b.symbols.cmp(&a.symbols).then_with(|| a.language.cmp(b.language)));

    Ok(CodeMap {
        prefix: prefix.to_string(),
        exported_only,
        file_count: walker.files.len(),
        symbol_count: walker.symbol_count,
        parsed_bytes: walker.parsed_bytes,
        skipped_files: walker.skipped_files,
        skipped_directories: walker.skipped_directories,
        skipped: walker.skipped,
        skipped_samples: walker.skipped_samples,
        languages,
        rank,
        truncated: walker.truncated,
        truncation_reason: walker.truncation_reason,
        generated_at_ms: now_ms(),
        build_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        limits: limits(),
        files: walker.files,
    })
}

/// Builds a bounded, metadata-only symbol map of the selected workspace. Runs on a blocking
/// thread; the response carries symbol metadata only, never file contents.
#[tauri::command]
pub async fn code_map_build(
    request: Option<CodeMapRequest>,
    workspace: State<'_, WorkspaceService>,
) -> Result<CodeMap, CommandError> {
    let request = request.unwrap_or_default();
    let prefix = validate_prefix(request.prefix.as_deref())?;
    let exported_only = request.exported_only;
    let root = workspace.root_path()?;
    tauri::async_runtime::spawn_blocking(move || build_code_map(&root, &prefix, exported_only))
        .await
        .map_err(|_| CommandError::new("code_map_error", "The code map worker stopped unexpectedly."))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, relative: &str, body: &str) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("devlab-code-map-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::canonicalize(root).unwrap()
    }

    #[test]
    fn validates_prefixes() {
        assert_eq!(validate_prefix(None).unwrap(), "");
        assert_eq!(validate_prefix(Some(" ./src/lib/ ")).unwrap(), "src/lib");
        assert!(validate_prefix(Some("../etc")).is_err());
        assert!(validate_prefix(Some("src/../x")).is_err());
        assert!(validate_prefix(Some("src\\lib")).is_err());
        assert!(validate_prefix(Some("a//b")).is_err());
        assert!(validate_prefix(Some(&"a".repeat(600))).is_err());
    }

    #[test]
    fn maps_supported_files_and_skips_the_rest() {
        let root = temp_root("basic");
        write(&root, "src/a.ts", "export function alpha() {}\nfunction hidden() {}\nexport class Box { size() { return 1; } }\n");
        write(&root, "src/b.py", "def beta():\n    pass\n\nclass Gamma:\n    def run(self):\n        pass\n");
        write(&root, "README.md", "# nope\n");
        write(&root, ".env", "SECRET=1\n");
        write(&root, "node_modules/x/index.js", "function shouldNotAppear() {}\n");
        write(&root, "src/bin.rs", "fn ok() {}\n\0");

        let map = build_code_map(&root, "", false).unwrap();
        let paths = map.files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>();
        assert_eq!(paths, vec!["src/a.ts", "src/b.py"]);
        assert_eq!(map.skipped.unsupported_language, 1);
        assert_eq!(map.skipped.secret_pattern, 1);
        assert_eq!(map.skipped.ignored_directory, 1);
        assert_eq!(map.skipped.not_utf8, 1);
        assert!(!map.truncated);

        let ts = &map.files[0];
        let names = ts.symbols.iter().map(|symbol| (symbol.kind, symbol.name.as_str(), symbol.depth)).collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![("function", "alpha", 0), ("function", "hidden", 0), ("class", "Box", 0), ("method", "size", 1)]
        );
        assert_eq!(map.symbol_count, 4 + 3);
        assert_eq!(map.languages[0].language, "typescript");

        let exported = build_code_map(&root, "src", true).unwrap();
        let ts_exported = exported.files.iter().find(|file| file.path == "src/a.ts").unwrap();
        let exported_names = ts_exported.symbols.iter().map(|symbol| symbol.name.as_str()).collect::<Vec<_>>();
        assert_eq!(exported_names, vec!["alpha", "Box", "size"]);
        assert!(exported.exported_only);
        assert_eq!(exported.prefix, "src");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ranks_mapped_files_by_importance() {
        let root = temp_root("rank");
        write(&root, "src/main.rs", "use crate::shared;\nfn main() { println!(\"{}\", shared::value()); }\n");
        write(&root, "src/lib.rs", "pub mod shared;\nmod util;\n");
        write(&root, "src/shared.rs", "pub fn value() -> u8 { 1 }\n");
        write(&root, "src/util.rs", "use crate::shared;\npub fn helper() -> u8 { shared::value() }\n");
        write(&root, "src/leaf.rs", "pub fn unused() -> u8 { 0 }\n");

        let map = build_code_map(&root, "", false).unwrap();
        let paths = map.files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>();
        assert_eq!(paths[0], "src/shared.rs", "the most imported module is emitted first");
        let shared = &map.files[0];
        assert_eq!(shared.in_degree, 3);
        assert_eq!(shared.out_degree, 0);
        assert!(shared.importance > 1.0, "importance is scaled so 1.0 is average");
        assert_eq!(map.rank.nodes, 5);
        assert_eq!(map.rank.internal_edges, 4);
        assert_eq!(map.rank.dangling_nodes, 2);
        assert_eq!(map.rank.top[0].path, "src/shared.rs");
        assert!(map.rank.top.len() <= MAX_TOP_ENTRIES);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_missing_or_file_prefix() {
        let root = temp_root("prefix");
        write(&root, "src/a.ts", "export const x = 1;\n");
        assert!(build_code_map(&root, "missing", false).is_err());
        assert_eq!(build_code_map(&root, "src/a.ts", false).unwrap_err().code, "code_map_prefix_invalid");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn caps_symbols_per_file() {
        let root = temp_root("cap");
        let body = (0..(MAX_SYMBOLS_PER_FILE + 10))
            .map(|index| format!("export function f{index}() {{}}\n"))
            .collect::<String>();
        write(&root, "many.ts", &body);
        let map = build_code_map(&root, "", false).unwrap();
        assert_eq!(map.files.len(), 1);
        assert_eq!(map.files[0].symbol_count, MAX_SYMBOLS_PER_FILE);
        assert!(map.files[0].truncated);
        assert!(!map.truncated, "per-file caps do not truncate the whole map");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn line_counts_are_stable() {
        assert_eq!(line_count(""), 0);
        assert_eq!(line_count("a"), 1);
        assert_eq!(line_count("a\nb\n"), 2);
        assert_eq!(line_count("a\nb"), 2);
    }
}
