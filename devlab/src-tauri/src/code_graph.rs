// Phase 9L — workspace dependency graph (module-level architecture summary).
//
// Where Phase 9I/9K answer "which symbols live where", this answers "how does the workspace fit
// together": a bounded walk collects every file's import specifiers (no Tree-Sitter parse, so it is
// cheap enough to cover more files than the symbol map), code_rank resolves them into a citation
// graph, and the file-level graph is aggregated into directory modules with weighted edges between
// them. The result is metadata only — module paths, file counts, importance, edge weights and the
// package names a module pulls in. No file contents, no symbol bodies, nothing cached or written.
//
// The response is intentionally a *graph*, not a picture: the renderer decides how to draw or
// summarise it, and DevLab never writes a diagram into the repository.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::code_map::validate_prefix;
use crate::code_rank;
use crate::search_index::{is_binary_extension, is_secret_file, is_skipped_directory};
use crate::workspace::{CommandError, WorkspaceService};

const MAX_GRAPH_FILES: usize = 2_500;
const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_WALK_DEPTH: usize = 32;
const BUILD_DEADLINE_MS: u64 = 8_000;
const MAX_MODULES: usize = 120;
const MAX_EDGES_PER_MODULE: usize = 8;
const MAX_EXTERNAL_PER_MODULE: usize = 6;
const MAX_GRAPH_SAMPLES: usize = 16;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeGraphRequest {
    /// Optional workspace-relative directory prefix; only files under it are graphed.
    #[serde(default)]
    pub prefix: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeGraphEdge {
    /// Workspace-relative module (directory) path; "." is the workspace root.
    module: String,
    /// Number of distinct file-level import edges behind this module edge.
    weight: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeGraphModule {
    /// Workspace-relative directory path; "." for files at the workspace root.
    module: String,
    files: usize,
    /// Summed PageRank of the module's files, scaled like code_map importance.
    importance: f64,
    /// Import edges that stay inside this module.
    internal_edges: usize,
    /// Distinct external specifiers used by this module (packages, stdlib, unresolved aliases).
    external_deps: usize,
    /// A few of those external specifiers, so the reader can see what the module pulls in.
    external_samples: Vec<String>,
    /// Modules this module depends on, heaviest first.
    depends_on: Vec<CodeGraphEdge>,
    /// Modules that depend on this one, heaviest first.
    depended_on_by: Vec<CodeGraphEdge>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeGraphLimits {
    max_files: usize,
    max_file_bytes: u64,
    max_total_bytes: u64,
    max_modules: usize,
    max_edges_per_module: usize,
    build_deadline_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeGraph {
    prefix: String,
    modules: Vec<CodeGraphModule>,
    module_count: usize,
    omitted_modules: usize,
    file_count: usize,
    /// File-level import edges resolved inside the workspace.
    internal_edges: usize,
    /// Specifiers that pointed outside the workspace.
    external_references: usize,
    /// Modules with no dependency on any other module.
    leaf_modules: usize,
    truncated: bool,
    truncation_reason: Option<&'static str>,
    skipped_files: usize,
    skipped_directories: usize,
    skipped_samples: Vec<String>,
    generated_at_ms: u64,
    build_ms: u64,
    limits: CodeGraphLimits,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn module_of(path: &str) -> &str {
    match path.rsplit_once('/') {
        Some((dir, _name)) if !dir.is_empty() => dir,
        _ => ".",
    }
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

struct Collector {
    root: PathBuf,
    deadline: Instant,
    files: Vec<String>,
    imports: Vec<Vec<String>>,
    bytes: u64,
    skipped_files: usize,
    skipped_directories: usize,
    skipped_samples: Vec<String>,
    truncated: bool,
    truncation_reason: Option<&'static str>,
    seen_dirs: HashSet<PathBuf>,
}

impl Collector {
    fn note_skip(&mut self, relative: &str, reason: &str) {
        self.skipped_files += 1;
        if self.skipped_samples.len() < MAX_GRAPH_SAMPLES {
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
        if self.files.len() >= MAX_GRAPH_FILES {
            return self.stop("max_files");
        }
        if self.bytes >= MAX_TOTAL_BYTES {
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
                    self.skipped_files += 1;
                    continue;
                }
            };
            let relative = relative_wire(&self.root, &path).unwrap_or_else(|| name.clone());
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    self.note_skip(&relative, "unreadable metadata");
                    continue;
                }
            };
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                self.note_skip(&relative, "symlink");
                continue;
            }
            if file_type.is_dir() {
                if is_skipped_directory(&name) {
                    self.skipped_directories += 1;
                    continue;
                }
                self.walk(&path, depth + 1);
                continue;
            }
            if !file_type.is_file() {
                self.note_skip(&relative, "not a regular file");
                continue;
            }
            if is_secret_file(&name) {
                self.note_skip(&relative, "secret-safe skip");
                continue;
            }
            if is_binary_extension(&name) {
                self.note_skip(&relative, "binary extension");
                continue;
            }
            if code_rank::language_id_for(&name).is_empty() {
                // Non-code files carry no import edges; they are simply not part of the graph.
                continue;
            }
            let size = metadata.len();
            if size > MAX_FILE_BYTES {
                self.note_skip(&relative, "larger than 256 KiB");
                continue;
            }
            if self.bytes.saturating_add(size) > MAX_TOTAL_BYTES {
                self.stop("max_total_bytes");
                return;
            }
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => {
                    self.note_skip(&relative, "unreadable");
                    continue;
                }
            };
            if bytes.contains(&0) {
                self.note_skip(&relative, "binary content");
                continue;
            }
            let source = match String::from_utf8(bytes) {
                Ok(source) => source,
                Err(_) => {
                    self.note_skip(&relative, "not UTF-8");
                    continue;
                }
            };
            let language = code_rank::language_id_for(&name);
            self.bytes = self.bytes.saturating_add(size);
            self.files.push(relative);
            self.imports.push(code_rank::extract_imports(language, &source));
        }
    }
}

#[derive(Default)]
struct ModuleBuilder {
    files: usize,
    importance: f64,
    internal_edges: usize,
    external: HashSet<String>,
    outgoing: HashMap<String, usize>,
    incoming: HashMap<String, usize>,
}

/// Builds the module-level dependency graph of the selected workspace. Runs on a blocking thread;
/// the response carries module metadata and edge weights only, never file contents.
pub(crate) fn build_code_graph(root: &Path, prefix: &str) -> Result<CodeGraph, CommandError> {
    let started = Instant::now();
    let start_dir = if prefix.is_empty() {
        root.to_path_buf()
    } else {
        root.join(prefix)
    };
    if !prefix.is_empty() {
        let metadata = fs::symlink_metadata(&start_dir)
            .map_err(|error| CommandError::io("inspect the prefix directory", error))?;
        if metadata.file_type().is_symlink() {
            return Err(CommandError::new(
                "symlink_not_allowed",
                "Symbolic links cannot be used as a dependency graph prefix.",
            ));
        }
        if !metadata.is_dir() {
            return Err(CommandError::new(
                "code_graph_prefix_invalid",
                "The dependency graph prefix must name an existing workspace directory.",
            ));
        }
        let canonical = fs::canonicalize(&start_dir)
            .map_err(|error| CommandError::io("resolve the prefix directory", error))?;
        if !canonical.starts_with(root) {
            return Err(CommandError::new(
                "outside_workspace",
                "The dependency graph prefix resolves outside the selected workspace.",
            ));
        }
    }

    let mut collector = Collector {
        root: root.to_path_buf(),
        deadline: started + std::time::Duration::from_millis(BUILD_DEADLINE_MS),
        files: Vec::new(),
        imports: Vec::new(),
        bytes: 0,
        skipped_files: 0,
        skipped_directories: 0,
        skipped_samples: Vec::new(),
        truncated: false,
        truncation_reason: None,
        seen_dirs: HashSet::new(),
    };
    collector.walk(&start_dir, 0);

    let ranking = code_rank::rank_paths(&collector.files, &collector.imports);
    let edges = code_rank::build_edges(&collector.files, &collector.imports);
    let file_modules = collector
        .files
        .iter()
        .map(|path| module_of(path).to_string())
        .collect::<Vec<_>>();
    let mut modules: HashMap<String, ModuleBuilder> = HashMap::new();
    for (index, module) in file_modules.iter().enumerate() {
        let entry = modules.entry(module.clone()).or_default();
        entry.files += 1;
        entry.importance += ranking.importance.get(index).copied().unwrap_or(0.0);
        for spec in edges.external.get(index).map(|specs| specs.as_slice()).unwrap_or(&[]) {
            entry.external.insert(spec.clone());
        }
    }
    for (index, module) in file_modules.iter().enumerate() {
        let targets = edges.out_edges.get(index).map(|targets| targets.as_slice()).unwrap_or(&[]);
        for target in targets {
            let target_module = &file_modules[*target];
            if target_module == module {
                if let Some(entry) = modules.get_mut(module.as_str()) {
                    entry.internal_edges += 1;
                }
                continue;
            }
            if let Some(entry) = modules.get_mut(module.as_str()) {
                *entry.outgoing.entry(target_module.clone()).or_insert(0) += 1;
            }
            let incoming = modules.entry(target_module.clone()).or_default();
            *incoming.incoming.entry(module.clone()).or_insert(0) += 1;
        }
    }

    let mut names = modules.keys().cloned().collect::<Vec<_>>();
    names.sort();
    let mut scored = names
        .iter()
        .map(|name| {
            let entry = &modules[name];
            (round3(entry.importance), name.as_str())
        })
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| right.0.total_cmp(&left.0).then_with(|| left.1.cmp(right.1)));

    let mut rendered: Vec<CodeGraphModule> = Vec::new();
    for (importance, name) in scored.iter().take(MAX_MODULES) {
        let entry = &modules[*name];
        let mut external_samples = entry.external.iter().cloned().collect::<Vec<_>>();
        external_samples.sort();
        external_samples.truncate(MAX_EXTERNAL_PER_MODULE);
        rendered.push(CodeGraphModule {
            module: (*name).to_string(),
            files: entry.files,
            importance: *importance,
            internal_edges: entry.internal_edges,
            external_deps: entry.external.len(),
            external_samples,
            depends_on: top_edges(&entry.outgoing, MAX_EDGES_PER_MODULE),
            depended_on_by: top_edges(&entry.incoming, MAX_EDGES_PER_MODULE),
        });
    }
    let omitted_modules = scored.len().saturating_sub(rendered.len());
    let leaf_modules = rendered
        .iter()
        .filter(|module| module.depends_on.is_empty())
        .count();

    Ok(CodeGraph {
        prefix: prefix.to_string(),
        module_count: rendered.len(),
        omitted_modules,
        file_count: collector.files.len(),
        internal_edges: ranking.internal_edges,
        external_references: ranking.external_references,
        leaf_modules,
        truncated: collector.truncated,
        truncation_reason: collector.truncation_reason,
        skipped_files: collector.skipped_files,
        skipped_directories: collector.skipped_directories,
        skipped_samples: collector.skipped_samples,
        generated_at_ms: now_ms(),
        build_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        limits: CodeGraphLimits {
            max_files: MAX_GRAPH_FILES,
            max_file_bytes: MAX_FILE_BYTES,
            max_total_bytes: MAX_TOTAL_BYTES,
            max_modules: MAX_MODULES,
            max_edges_per_module: MAX_EDGES_PER_MODULE,
            build_deadline_ms: BUILD_DEADLINE_MS,
        },
        modules: rendered,
    })
}

fn top_edges(weights: &HashMap<String, usize>, limit: usize) -> Vec<CodeGraphEdge> {
    let mut edges = weights
        .iter()
        .map(|(module, weight)| CodeGraphEdge {
            module: module.clone(),
            weight: *weight,
        })
        .collect::<Vec<_>>();
    edges.sort_by(|left, right| {
        right
            .weight
            .cmp(&left.weight)
            .then_with(|| left.module.cmp(&right.module))
    });
    edges.truncate(limit);
    edges
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

/// Builds a bounded, metadata-only module dependency graph of the selected workspace.
#[tauri::command]
pub async fn code_graph_build(
    request: Option<CodeGraphRequest>,
    workspace: State<'_, WorkspaceService>,
) -> Result<CodeGraph, CommandError> {
    let request = request.unwrap_or_default();
    let prefix = validate_prefix(request.prefix.as_deref())?;
    let root = workspace.root_path()?;
    tauri::async_runtime::spawn_blocking(move || build_code_graph(&root, &prefix))
        .await
        .map_err(|_| CommandError::new("code_graph_error", "The dependency graph worker stopped unexpectedly."))?
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
        let root = std::env::temp_dir().join(format!("devlab-code-graph-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::canonicalize(root).unwrap()
    }

    fn find<'a>(graph: &'a CodeGraph, module: &str) -> &'a CodeGraphModule {
        graph
            .modules
            .iter()
            .find(|entry| entry.module == module)
            .expect("module in graph")
    }

    #[test]
    fn aggregates_file_edges_into_modules() {
        let root = temp_root("basic");
        write(&root, "src/main.rs", "use crate::core::engine;\nfn main() { engine::run(); }\n");
        write(&root, "src/core/mod.rs", "pub mod engine;\npub mod config;\n");
        write(&root, "src/core/engine.rs", "use crate::core::config;\nuse serde::Serialize;\npub fn run() { config::load(); }\n");
        write(&root, "src/core/config.rs", "pub fn load() -> u8 { 1 }\n");
        write(&root, "src/ui/view.rs", "use crate::core::engine;\npub fn draw() { engine::run(); }\n");
        write(&root, "README.md", "# not code\n");

        let graph = build_code_graph(&root, "").unwrap();
        assert_eq!(graph.file_count, 5, "only files with a known language are graphed");
        assert_eq!(graph.module_count, 3, "src, src/core and src/ui");
        let core = find(&graph, "src/core");
        assert_eq!(core.files, 3);
        assert!(core.internal_edges >= 1, "engine -> config stays inside src/core");
        assert_eq!(core.external_deps, 1, "serde is external");
        assert_eq!(core.external_samples, vec!["serde::Serialize".to_string()]);
        assert!(core.depended_on_by.iter().any(|edge| edge.module == "src" && edge.weight == 1));
        assert!(core.depended_on_by.iter().any(|edge| edge.module == "src/ui" && edge.weight == 1));
        let ui = find(&graph, "src/ui");
        assert_eq!(ui.depends_on.first().map(|edge| edge.module.as_str()), Some("src/core"));
        assert_eq!(ui.depends_on.first().map(|edge| edge.weight), Some(1));
        assert!(graph.internal_edges >= 4);
        assert_eq!(graph.external_references, 1);
        assert_eq!(graph.leaf_modules, 1, "src/core depends on nothing outside itself");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn orders_modules_by_importance_and_bounds_edges() {
        let root = temp_root("bounds");
        for index in 0..(MAX_EDGES_PER_MODULE + 4) {
            write(
                &root,
                &format!("src/hub/target{index}.ts"),
                "export const value = 1;\n",
            );
            write(
                &root,
                &format!("src/fan/source{index}.ts"),
                &format!("import {{ value }} from '../hub/target{index}';\nexport const v = value;\n"),
            );
        }
        let graph = build_code_graph(&root, "").unwrap();
        let hub = find(&graph, "src/hub");
        assert_eq!(hub.depended_on_by.len(), 1);
        assert_eq!(hub.depended_on_by[0].module, "src/fan");
        assert_eq!(hub.depended_on_by[0].weight, MAX_EDGES_PER_MODULE + 4);
        let fan = find(&graph, "src/fan");
        assert_eq!(fan.depends_on.len(), 1);
        assert_eq!(graph.modules[0].module, "src/hub", "the most depended-on module first");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn honours_prefixes_and_skips() {
        let root = temp_root("prefix");
        write(&root, "src/a.ts", "import '../other/b';\n");
        write(&root, "other/b.ts", "export const b = 1;\n");
        write(&root, "node_modules/pkg/index.js", "module.exports = 1;\n");
        write(&root, ".env", "SECRET=1\n");

        let scoped = build_code_graph(&root, "src").unwrap();
        assert_eq!(scoped.file_count, 1);
        assert_eq!(scoped.module_count, 1);
        assert_eq!(scoped.prefix, "src");
        assert_eq!(find(&scoped, "src").files, 1);

        let all = build_code_graph(&root, "").unwrap();
        assert_eq!(all.file_count, 2, "node_modules and .env are skipped");
        assert!(build_code_graph(&root, "missing").is_err());
        assert_eq!(
            build_code_graph(&root, "src/a.ts").unwrap_err().code,
            "code_map_prefix_invalid",
            "prefix validation is shared with the code map"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
