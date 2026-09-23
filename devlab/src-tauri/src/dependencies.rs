// Phase 9N — workspace dependency inventory (read-only metadata).
//
// The first half of the roadmap's "dependency vulnerability and license scanning as read-only
// metadata first": DevLab reads the manifests and lockfiles already in the selected workspace and
// reports what the project depends on — name, version or specifier, ecosystem, kind, and the file
// that declared it — plus per-ecosystem rollups and packages that resolve to more than one version.
//
// Deliberately offline and inert: no network calls, no advisory database, no license matching and no
// remediation of any kind. Parsing is line-based (plus serde_json for the npm files, which are JSON)
// and everything runs under file-count, byte and wall-clock budgets. Only metadata leaves Rust.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::code_map::validate_prefix;
use crate::search_index::{is_secret_file, is_skipped_directory};
use crate::workspace::{CommandError, WorkspaceService};

const MAX_MANIFESTS: usize = 200;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;
const MAX_WALK_DEPTH: usize = 32;
const MAX_WALK_DIRS: usize = 4_000;
const BUILD_DEADLINE_MS: u64 = 5_000;
const MAX_ENTRIES: usize = 400;
const MAX_CONFLICTS: usize = 20;
const MAX_VERSIONS_PER_CONFLICT: usize = 4;
const MAX_SAMPLES: usize = 16;
const MAX_NAME_CHARS: usize = 200;
const MAX_VERSION_CHARS: usize = 120;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInventoryRequest {
    /// Optional workspace-relative directory prefix; only manifests under it are read.
    #[serde(default)]
    pub prefix: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyEntry {
    name: String,
    /// Exact version when the manifest or lockfile pins one, otherwise the declared specifier.
    version: String,
    /// `npm`, `cargo`, `pypi` or `go`.
    ecosystem: &'static str,
    /// `runtime`, `dev`, `build`, `optional`, `peer`, `workspace` or `indirect`.
    kind: &'static str,
    /// True when `version` is an exact pinned version rather than a range.
    resolved: bool,
    /// True when the package is declared in a manifest; false when it only appears in a lockfile.
    direct: bool,
    /// Workspace-relative file that declared or locked this package.
    source: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyConflict {
    name: String,
    ecosystem: &'static str,
    versions: Vec<String>,
    /// How many manifests or lockfiles mention the package.
    files: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyEcosystemCount {
    ecosystem: &'static str,
    manifests: usize,
    lockfiles: usize,
    direct: usize,
    transitive: usize,
    dev: usize,
    resolved: usize,
    unresolved: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInventoryLimits {
    max_manifests: usize,
    max_manifest_bytes: u64,
    max_entries: usize,
    max_conflicts: usize,
    build_deadline_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInventory {
    prefix: String,
    manifests: usize,
    lockfiles: usize,
    files_scanned: usize,
    dependencies: usize,
    direct: usize,
    transitive: usize,
    dev: usize,
    resolved: usize,
    unresolved: usize,
    entries: Vec<DependencyEntry>,
    entry_count: usize,
    omitted_entries: usize,
    ecosystems: Vec<DependencyEcosystemCount>,
    conflicts: Vec<DependencyConflict>,
    conflict_count: usize,
    truncated: bool,
    truncation_reason: Option<&'static str>,
    skipped_files: usize,
    skipped_directories: usize,
    skipped_samples: Vec<String>,
    generated_at_ms: u64,
    build_ms: u64,
    limits: DependencyInventoryLimits,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
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

/// Manifest or lockfile kind by exact file name.
fn manifest_kind(name: &str) -> Option<&'static str> {
    match name {
        "package.json" => Some("npm-manifest"),
        "package-lock.json" | "npm-shrinkwrap.json" => Some("npm-lock"),
        "Cargo.toml" => Some("cargo-manifest"),
        "Cargo.lock" => Some("cargo-lock"),
        "requirements.txt" => Some("pypi-manifest"),
        "pyproject.toml" => Some("pypi-manifest"),
        "go.mod" => Some("go-manifest"),
        _ => {
            if name.starts_with("requirements") && name.ends_with(".txt") {
                Some("pypi-manifest")
            } else {
                None
            }
        }
    }
}

fn is_exact(version: &str) -> bool {
    !version.is_empty()
        && version
            .chars()
            .next()
            .map(|first| first.is_ascii_digit())
            .unwrap_or(false)
        && !version
            .chars()
            .any(|character| matches!(character, '^' | '~' | '>' | '<' | '=' | '*' | '|' | ' ' | ','))
}

fn clip(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    value.chars().take(limit.saturating_sub(1)).collect::<String>() + "…"
}

struct Collector {
    root: PathBuf,
    deadline: Instant,
    files: Vec<(String, String, String)>,
    bytes: u64,
    manifests: usize,
    lockfiles: usize,
    skipped_files: usize,
    skipped_directories: usize,
    skipped_samples: Vec<String>,
    truncated: bool,
    truncation_reason: Option<&'static str>,
    seen_dirs: HashSet<PathBuf>,
    dirs: usize,
}

impl Collector {
    fn note_skip(&mut self, relative: &str, reason: &str) {
        self.skipped_files += 1;
        if self.skipped_samples.len() < MAX_SAMPLES {
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
        if self.files.len() >= MAX_MANIFESTS {
            return self.stop("max_manifests");
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
        if depth > MAX_WALK_DEPTH || self.dirs >= MAX_WALK_DIRS || self.budget_exhausted() {
            return;
        }
        let canonical = fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf());
        if !self.seen_dirs.insert(canonical) {
            return;
        }
        self.dirs += 1;
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
                Err(_) => continue,
            };
            let relative = relative_wire(&self.root, &path).unwrap_or_else(|| name.clone());
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => continue,
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
                continue;
            }
            let Some(kind) = manifest_kind(&name) else {
                continue;
            };
            if is_secret_file(&name) {
                self.note_skip(&relative, "secret-safe skip");
                continue;
            }
            let size = metadata.len();
            if size > MAX_MANIFEST_BYTES {
                self.note_skip(&relative, "larger than 1 MiB");
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
            let source = match String::from_utf8(bytes) {
                Ok(source) => source,
                Err(_) => {
                    self.note_skip(&relative, "not UTF-8");
                    continue;
                }
            };
            let kind = kind.to_string();
            if kind.ends_with("lock") {
                self.lockfiles += 1;
            } else {
                self.manifests += 1;
            }
            self.bytes = self.bytes.saturating_add(size);
            self.files.push((relative, kind, source));
        }
    }
}

fn push(
    out: &mut Vec<DependencyEntry>,
    ecosystem: &'static str,
    name: &str,
    version: &str,
    kind: &'static str,
    direct: bool,
    source: &str,
    // Some(true/false) when the file format says whether the version is exact; None to guess from
    // the version string itself. (Plain comment: rustc rejects doc comments on parameters.)
    exact: Option<bool>,
) {
    let name = name.trim().trim_matches('"').trim_matches('\'');
    if name.is_empty() || name.starts_with('[') || name.starts_with('#') {
        return;
    }
    let version = if version.is_empty() { "*" } else { version };
    out.push(DependencyEntry {
        name: clip(name, MAX_NAME_CHARS),
        version: clip(version, MAX_VERSION_CHARS),
        ecosystem,
        kind,
        resolved: exact.unwrap_or_else(|| is_exact(version)),
        direct,
        source: source.to_string(),
    });
}

fn inline_field(text: &str, key: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut start = 0usize;
    while start + key.len() <= text.len() {
        let offset = text[start..].find(key)?;
        let index = start + offset;
        let before = if index == 0 { None } else { Some(bytes[index - 1]) };
        let before_ok = !matches!(before, Some(byte) if byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
        let after = bytes.get(index + key.len()).copied();
        let after_ok = matches!(after, Some(b' ' | b'=' | b'\t'));
        if before_ok && after_ok {
            let tail = text[index + key.len()..].trim_start().strip_prefix('=')?;
            let tail = tail.trim_start().trim_start_matches('"').trim_start_matches('\'');
            let end = tail.find(|character: char| character == '"' || character == '\'')?;
            return Some(tail[..end].to_string());
        }
        start = index + key.len();
    }
    None
}

fn parse_package_json(path: &str, source: &str, out: &mut Vec<DependencyEntry>) {
    let value: serde_json::Value = match serde_json::from_str(source) {
        Ok(value) => value,
        Err(_) => return,
    };
    let sections: [(&str, &'static str); 4] = [
        ("dependencies", "runtime"),
        ("devDependencies", "dev"),
        ("optionalDependencies", "optional"),
        ("peerDependencies", "peer"),
    ];
    for (section, kind) in sections {
        if let Some(object) = value.get(section).and_then(|value| value.as_object()) {
            for (name, spec) in object {
                let version = spec.as_str().unwrap_or("*");
                push(out, "npm", name, version, kind, true, path, None);
            }
        }
    }
}

fn parse_package_lock(path: &str, source: &str, out: &mut Vec<DependencyEntry>) {
    let value: serde_json::Value = match serde_json::from_str(source) {
        Ok(value) => value,
        Err(_) => return,
    };
    if let Some(packages) = value.get("packages").and_then(|value| value.as_object()) {
        for (key, entry) in packages {
            if key.is_empty() {
                continue;
            }
            let name = match key.rsplit_once("node_modules/") {
                Some((_prefix, tail)) => tail,
                None => continue,
            };
            let version = entry.get("version").and_then(|value| value.as_str()).unwrap_or("");
            let dev = entry.get("dev").and_then(|value| value.as_bool()).unwrap_or(false);
            let kind = if dev { "dev" } else { "runtime" };
            push(out, "npm", name, version, kind, false, path, Some(!version.is_empty()));
        }
    }
}

fn parse_cargo_toml(path: &str, source: &str, out: &mut Vec<DependencyEntry>) {
    let mut section: Option<&'static str> = None;
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('[') {
            section = match trimmed.split_whitespace().next().unwrap_or("") {
                "[dependencies]" => Some("runtime"),
                "[dev-dependencies]" => Some("dev"),
                "[build-dependencies]" => Some("build"),
                "[workspace.dependencies]" => Some("workspace"),
                _ => None,
            };
            continue;
        }
        let Some(kind) = section else {
            continue;
        };
        let Some((name, rest)) = trimmed.split_once('=') else {
            continue;
        };
        let name = name.trim().trim_matches('"');
        if name.is_empty() {
            continue;
        }
        let rest = rest.trim();
        let version = if rest.starts_with('{') {
            if let Some(version) = inline_field(rest, "version") {
                version
            } else if rest.contains("git =") || rest.contains("git=") {
                "git".to_string()
            } else if rest.contains("path =") || rest.contains("path=") {
                "path".to_string()
            } else {
                String::new()
            }
        } else {
            rest.trim_matches('"').to_string()
        };
        // Cargo treats a bare version as a caret range; only `=x.y.z` is an exact pin.
        let exact = version.trim().starts_with('=');
        let version = version.trim().trim_start_matches('=');
        push(out, "cargo", name, version, kind, true, path, Some(exact));
    }
}

fn parse_cargo_lock(path: &str, source: &str, out: &mut Vec<DependencyEntry>) {
    let mut name: Option<String> = None;
    let mut version: Option<String> = None;
    // The trailing sentinel flushes the final record without duplicating the push.
    for line in source.lines().chain(std::iter::once("[[package]]")) {
        let trimmed = line.trim();
        if trimmed == "[[package]]" {
            if let (Some(found_name), Some(found_version)) = (name.take(), version.take()) {
                push(out, "cargo", &found_name, &found_version, "runtime", false, path, Some(true));
            }
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            let key = key.trim();
            let value = value.trim().trim_matches('"');
            if key == "name" && name.is_none() {
                name = Some(value.to_string());
            } else if key == "version" && version.is_none() {
                version = Some(value.to_string());
            }
        }
    }
}

fn parse_requirements(path: &str, source: &str, out: &mut Vec<DependencyEntry>) {
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
            continue;
        }
        let without_comment = trimmed.split(" #").next().unwrap_or(trimmed).trim();
        let without_marker = without_comment.split(';').next().unwrap_or(without_comment).trim();
        let split_at = without_marker
            .find(|character: char| matches!(character, '=' | '>' | '<' | '~' | '!' | '[' | ' '))
            .unwrap_or(without_marker.len());
        let name = without_marker[..split_at].trim();
        let rest = without_marker[split_at..].trim();
        let version = rest.trim_start_matches(|character: char| matches!(character, '=' | '>' | '<' | '~' | '!' | '['));
        let version = version.trim_end_matches(']').trim();
        let exact = without_marker.contains("==");
        push(out, "pypi", name, version, "runtime", true, path, Some(exact));
    }
}

fn split_array_items(text: &str) -> Vec<String> {
    let start = match text.find('[') {
        Some(index) => index + 1,
        None => return Vec::new(),
    };
    let end = match text.rfind(']') {
        Some(index) => index,
        None => text.len(),
    };
    if end <= start {
        return Vec::new();
    }
    text[start..end]
        .split(',')
        .map(|item| item.trim().trim_matches('"').trim_matches('\'').trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn pypi_kind(section: &str) -> &'static str {
    if section.contains("dev") || section.contains("test") {
        "dev"
    } else if section.contains("optional") {
        "optional"
    } else {
        "runtime"
    }
}

fn parse_pyproject(path: &str, source: &str, out: &mut Vec<DependencyEntry>) {
    let mut section = String::new();
    let mut buffer: Option<String> = None;
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && buffer.is_none() {
            section = trimmed.trim_matches('[').trim_matches(']').trim().to_string();
            continue;
        }
        if let Some(mut collected) = buffer.take() {
            collected.push(' ');
            collected.push_str(trimmed);
            if trimmed.contains(']') {
                let kind = pypi_kind(&section);
                for item in split_array_items(&collected) {
                    push_pypi_spec(path, &item, kind, out);
                }
            } else {
                buffer = Some(collected);
            }
            continue;
        }
        if (section.contains("dependencies") || trimmed.starts_with("dependencies")) && trimmed.contains('=') && trimmed.contains('[') {
            if trimmed.contains(']') {
                let kind = pypi_kind(&section);
                for item in split_array_items(trimmed) {
                    push_pypi_spec(path, &item, kind, out);
                }
            } else {
                buffer = Some(trimmed.to_string());
            }
            continue;
        }
        if section.starts_with("tool.poetry") && section.contains("dependencies") {
            if let Some((name, rest)) = trimmed.split_once('=') {
                let name = name.trim().trim_matches('"');
                let rest = rest.trim();
                let version = if rest.starts_with('{') {
                    inline_field(rest, "version").unwrap_or_default()
                } else {
                    rest.trim_matches('"').to_string()
                };
                if !name.is_empty() && name != "python" {
                    push(out, "pypi", name, version.trim(), pypi_kind(&section), true, path, None);
                }
            }
        }
    }
}

fn push_pypi_spec(path: &str, spec: &str, kind: &'static str, out: &mut Vec<DependencyEntry>) {
    let spec = spec.trim();
    if spec.is_empty() {
        return;
    }
    let split_at = spec
        .find(|character: char| matches!(character, '=' | '>' | '<' | '~' | '!' | '[' | ' '))
        .unwrap_or(spec.len());
    let name = spec[..split_at].trim();
    let rest = spec[split_at..].trim();
    let version = rest.trim_start_matches(|character: char| matches!(character, '=' | '>' | '<' | '~' | '!' | '['));
    let version = version.trim_end_matches(']').trim();
    let exact = spec.contains("==");
    push(out, "pypi", name, version, kind, true, path, Some(exact));
}

fn parse_go_mod(path: &str, source: &str, out: &mut Vec<DependencyEntry>) {
    let mut in_block = false;
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("require (") {
            in_block = true;
            continue;
        }
        if in_block && trimmed.starts_with(')') {
            in_block = false;
            continue;
        }
        let body = if in_block {
            trimmed
        } else if let Some(rest) = trimmed.strip_prefix("require ") {
            rest
        } else {
            continue;
        };
        let indirect = body.contains("// indirect");
        let without_comment = body.split("//").next().unwrap_or(body).trim();
        let mut parts = without_comment.split_whitespace();
        let name = parts.next().unwrap_or("");
        let version = parts.next().unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let kind = if indirect { "indirect" } else { "runtime" };
        let exact = version.starts_with('v') && !version.contains(' ');
        push(out, "go", name, version, kind, true, path, Some(exact));
    }
}

/// Reads the manifests and lockfiles of the selected workspace and reports their dependencies as
/// read-only metadata. Runs on a blocking thread; no network access, no writes.
pub(crate) fn build_inventory(root: &Path, prefix: &str) -> Result<DependencyInventory, CommandError> {
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
                "Symbolic links cannot be used as a dependency inventory prefix.",
            ));
        }
        if !metadata.is_dir() {
            return Err(CommandError::new(
                "code_map_prefix_invalid",
                "The dependency inventory prefix must name an existing workspace directory.",
            ));
        }
        let canonical = fs::canonicalize(&start_dir)
            .map_err(|error| CommandError::io("resolve the prefix directory", error))?;
        if !canonical.starts_with(root) {
            return Err(CommandError::new(
                "outside_workspace",
                "The dependency inventory prefix resolves outside the selected workspace.",
            ));
        }
    }

    let mut collector = Collector {
        root: root.to_path_buf(),
        deadline: started + std::time::Duration::from_millis(BUILD_DEADLINE_MS),
        files: Vec::new(),
        bytes: 0,
        manifests: 0,
        lockfiles: 0,
        skipped_files: 0,
        skipped_directories: 0,
        skipped_samples: Vec::new(),
        truncated: false,
        truncation_reason: None,
        seen_dirs: HashSet::new(),
        dirs: 0,
    };
    collector.walk(&start_dir, 0);

    let files = std::mem::take(&mut collector.files);
    let mut raw: Vec<DependencyEntry> = Vec::new();
    for (relative, kind, source) in &files {
        let file_name = match relative.rsplit_once('/') {
            Some((_dir, name)) => name,
            None => relative.as_str(),
        };
        match kind.as_str() {
            "npm-manifest" => parse_package_json(relative, source, &mut raw),
            "npm-lock" => {
                if file_name.ends_with(".json") {
                    parse_package_lock(relative, source, &mut raw);
                }
            }
            "cargo-manifest" => parse_cargo_toml(relative, source, &mut raw),
            "cargo-lock" => parse_cargo_lock(relative, source, &mut raw),
            "pypi-manifest" => {
                if file_name == "pyproject.toml" {
                    parse_pyproject(relative, source, &mut raw);
                } else {
                    parse_requirements(relative, source, &mut raw);
                }
            }
            "go-manifest" => parse_go_mod(relative, source, &mut raw),
            _ => {}
        }
    }

    // Deduplicate by package, version and kind; a direct declaration wins over a lockfile-only row.
    let mut merged: HashMap<String, DependencyEntry> = HashMap::new();
    for entry in raw {
        let key = format!("{}\u{1f}{}\u{1f}{}\u{1f}{}", entry.ecosystem, entry.name, entry.version, entry.kind);
        match merged.get_mut(&key) {
            Some(existing) => {
                if entry.direct && !existing.direct {
                    existing.direct = true;
                    existing.source = entry.source.clone();
                }
                if entry.resolved {
                    existing.resolved = true;
                }
            }
            None => {
                merged.insert(key, entry);
            }
        }
    }
    let mut entries = merged.values().cloned().collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        right
            .direct
            .cmp(&left.direct)
            .then_with(|| left.ecosystem.cmp(right.ecosystem))
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.version.cmp(&right.version))
            .then_with(|| left.kind.cmp(right.kind))
    });
    let total = entries.len();
    let direct = entries.iter().filter(|entry| entry.direct).count();
    let transitive = total - direct;
    let dev = entries.iter().filter(|entry| entry.kind == "dev").count();
    let resolved = entries.iter().filter(|entry| entry.resolved).count();
    let unresolved = total - resolved;
    entries.truncate(MAX_ENTRIES);

    let mut ecosystem_order: Vec<&'static str> = Vec::new();
    let mut ecosystem_counts: HashMap<&'static str, DependencyEcosystemCount> = HashMap::new();
    for entry in merged.values() {
        let counts = ecosystem_counts.entry(entry.ecosystem).or_insert(DependencyEcosystemCount {
            ecosystem: entry.ecosystem,
            manifests: 0,
            lockfiles: 0,
            direct: 0,
            transitive: 0,
            dev: 0,
            resolved: 0,
            unresolved: 0,
        });
        if !ecosystem_order.contains(&entry.ecosystem) {
            ecosystem_order.push(entry.ecosystem);
        }
        if entry.direct {
            counts.direct += 1;
        } else {
            counts.transitive += 1;
        }
        if entry.kind == "dev" {
            counts.dev += 1;
        }
        if entry.resolved {
            counts.resolved += 1;
        } else {
            counts.unresolved += 1;
        }
    }
    for (relative, kind, _source) in &files {
        let ecosystem = match kind.as_str() {
            "npm-manifest" | "npm-lock" => "npm",
            "cargo-manifest" | "cargo-lock" => "cargo",
            "pypi-manifest" => "pypi",
            "go-manifest" => "go",
            _ => continue,
        };
        let counts = ecosystem_counts.entry(ecosystem).or_insert(DependencyEcosystemCount {
            ecosystem,
            manifests: 0,
            lockfiles: 0,
            direct: 0,
            transitive: 0,
            dev: 0,
            resolved: 0,
            unresolved: 0,
        });
        if !ecosystem_order.contains(&ecosystem) {
            ecosystem_order.push(ecosystem);
        }
        if kind.ends_with("lock") {
            counts.lockfiles += 1;
        } else {
            counts.manifests += 1;
        }
    }
    ecosystem_order.sort();
    let ecosystems = ecosystem_order
        .iter()
        .filter_map(|ecosystem| ecosystem_counts.get(ecosystem).cloned())
        .collect::<Vec<_>>();

    // Packages that more than one manifest or lockfile pins to different versions. `files` counts
    // the distinct files that mention the package, not the number of rows.
    let mut versions: HashMap<String, (DependencyConflict, HashSet<String>)> = HashMap::new();
    for entry in merged.values() {
        if !entry.resolved {
            continue;
        }
        let key = format!("{}\u{1f}{}", entry.ecosystem, entry.name);
        let record = versions.entry(key).or_insert_with(|| {
            (
                DependencyConflict {
                    name: entry.name.clone(),
                    ecosystem: entry.ecosystem,
                    versions: Vec::new(),
                    files: 0,
                },
                HashSet::new(),
            )
        });
        if !record.0.versions.iter().any(|version| version == &entry.version) {
            record.0.versions.push(entry.version.clone());
        }
        record.1.insert(entry.source.clone());
    }
    let mut conflicts = versions
        .into_values()
        .filter(|(conflict, _files)| conflict.versions.len() > 1)
        .map(|(mut conflict, files)| {
            conflict.files = files.len();
            conflict.versions.sort();
            conflict.versions.truncate(MAX_VERSIONS_PER_CONFLICT);
            conflict
        })
        .collect::<Vec<_>>();
    conflicts.sort_by(|left, right| {
        right
            .versions
            .len()
            .cmp(&left.versions.len())
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.ecosystem.cmp(right.ecosystem))
    });
    let conflict_count = conflicts.len();
    conflicts.truncate(MAX_CONFLICTS);

    Ok(DependencyInventory {
        prefix: prefix.to_string(),
        manifests: collector.manifests,
        lockfiles: collector.lockfiles,
        files_scanned: files.len(),
        dependencies: total,
        direct,
        transitive,
        dev,
        resolved,
        unresolved,
        entry_count: entries.len(),
        omitted_entries: total.saturating_sub(entries.len()),
        ecosystems,
        conflicts,
        conflict_count,
        truncated: collector.truncated,
        truncation_reason: collector.truncation_reason,
        skipped_files: collector.skipped_files,
        skipped_directories: collector.skipped_directories,
        skipped_samples: collector.skipped_samples,
        generated_at_ms: now_ms(),
        build_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        limits: DependencyInventoryLimits {
            max_manifests: MAX_MANIFESTS,
            max_manifest_bytes: MAX_MANIFEST_BYTES,
            max_entries: MAX_ENTRIES,
            max_conflicts: MAX_CONFLICTS,
            build_deadline_ms: BUILD_DEADLINE_MS,
        },
        entries,
    })
}

/// Builds a read-only dependency inventory of the selected workspace from its manifests and
/// lockfiles. Offline by design: no advisory lookups, no network calls, no remediation.
#[tauri::command]
pub async fn dependency_inventory(
    request: Option<DependencyInventoryRequest>,
    workspace: State<'_, WorkspaceService>,
) -> Result<DependencyInventory, CommandError> {
    let request = request.unwrap_or_default();
    let prefix = validate_prefix(request.prefix.as_deref())?;
    let root = workspace.root_path()?;
    tauri::async_runtime::spawn_blocking(move || build_inventory(&root, &prefix))
        .await
        .map_err(|_| CommandError::new("dependency_inventory_error", "The dependency inventory worker stopped unexpectedly."))?
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
        let root = std::env::temp_dir().join(format!("devlab-deps-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::canonicalize(root).unwrap()
    }

    #[test]
    fn reads_npm_cargo_python_and_go_manifests() {
        let root = temp_root("manifests");
        write(
            &root,
            "package.json",
            r#"{"name":"app","dependencies":{"react":"^18.2.0","left-pad":"1.3.0"},"devDependencies":{"vitest":"1.6.0"}}"#,
        );
        write(
            &root,
            "package-lock.json",
            r#"{"lockfileVersion":3,"packages":{"":{"name":"app"},"node_modules/react":{"version":"18.3.1"},"node_modules/left-pad":{"version":"1.3.0"},"node_modules/vitest":{"version":"1.6.0","dev":true}}}"#,
        );
        write(
            &root,
            "Cargo.toml",
            "[package]\nname = \"devlab\"\n\n[dependencies]\nserde = { version = \"1.0.219\", features = [\"derive\"] }\ntree-sitter = \"0.25\"\nlocal = { path = \"../local\" }\n\n[dev-dependencies]\ntempfile = \"3\"\n",
        );
        write(
            &root,
            "Cargo.lock",
            "[[package]]\nname = \"serde\"\nversion = \"1.0.219\"\n\n[[package]]\nname = \"tempfile\"\nversion = \"3.14.0\"\n",
        );
        write(&root, "requirements.txt", "# install\nflask==3.0.3\nrequests>=2.31.0  # keep fresh\n");
        write(
            &root,
            "pyproject.toml",
            "[project]\nname = \"tool\"\ndependencies = [\n  \"click==8.1.7\",\n  \"rich>=13\",\n]\n\n[project.optional-dependencies]\ntest = [\"pytest==8.2.0\"]\n",
        );
        write(
            &root,
            "go.mod",
            "module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/pkg/errors v0.9.1\n\tgolang.org/x/sys v0.21.0 // indirect\n)\n\nrequire github.com/stretchr/testify v1.9.0\n",
        );

        let inventory = build_inventory(&root, "").unwrap();
        assert_eq!(inventory.manifests, 5);
        assert_eq!(inventory.lockfiles, 2);
        let find = |name: &str| {
            inventory
                .entries
                .iter()
                .find(|entry| entry.name == name)
                .unwrap_or_else(|| panic!("{name} missing"))
                .clone()
        };
        assert_eq!(find("react").version, "^18.2.0", "the manifest spec wins");
        assert!(!find("react").resolved);
        assert_eq!(find("left-pad").version, "1.3.0");
        assert!(find("left-pad").resolved);
        assert_eq!(find("vitest").kind, "dev");
        assert!(
            inventory
                .entries
                .iter()
                .any(|entry| entry.name == "react" && entry.version == "18.3.1" && !entry.direct),
            "the locked react version is reported separately"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn npm_lock_adds_transitive_versions_and_conflicts() {
        let root = temp_root("lock");
        write(&root, "package.json", r#"{"dependencies":{"react":"^18.2.0"}}"#);
        write(
            &root,
            "package-lock.json",
            r#"{"lockfileVersion":3,"packages":{"":{"name":"app"},"node_modules/react":{"version":"18.3.1"},"node_modules/a/node_modules/react":{"version":"17.0.2"},"node_modules/left-pad":{"version":"1.3.0","dev":true}}}"#,
        );
        let inventory = build_inventory(&root, "").unwrap();
        let react_versions = inventory
            .conflicts
            .iter()
            .find(|conflict| conflict.name == "react")
            .expect("two react versions must be reported as a conflict");
        assert_eq!(react_versions.versions, vec!["17.0.2".to_string(), "18.3.1".to_string()]);
        assert!(inventory.entries.iter().any(|entry| entry.name == "left-pad" && entry.kind == "dev" && !entry.direct));
        assert!(inventory.transitive >= 2, "lockfile-only rows are transitive");
        assert!(inventory.direct >= 1);
        let npm = inventory.ecosystems.iter().find(|entry| entry.ecosystem == "npm").expect("npm rollup");
        assert_eq!(npm.manifests, 1);
        assert_eq!(npm.lockfiles, 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parses_cargo_python_and_go_details() {
        let root = temp_root("details");
        write(
            &root,
            "Cargo.toml",
            "[dependencies]\nserde = { version = \"1.0.219\", features = [\"derive\"] }\ntree-sitter = \"0.25\"\nvendored = { path = \"../vendored\" }\ngitdep = { git = \"https://example.com/x\" }\n",
        );
        write(&root, "requirements.txt", "flask==3.0.3\nrequests>=2.31.0\nplainName\n-e .\n");
        write(
            &root,
            "pyproject.toml",
            "[project]\ndependencies = [\n  \"click==8.1.7\",\n  \"rich>=13\",\n]\n\n[project.optional-dependencies]\ntest = [\"pytest==8.2.0\"]\n",
        );
        write(
            &root,
            "go.mod",
            "module example.com/app\n\nrequire (\n\tgithub.com/pkg/errors v0.9.1\n\tgolang.org/x/sys v0.21.0 // indirect\n)\n",
        );
        let inventory = build_inventory(&root, "").unwrap();
        let find = |name: &str| inventory.entries.iter().find(|entry| entry.name == name).expect("entry").clone();
        assert_eq!(find("serde").version, "1.0.219");
        assert!(
            !find("serde").resolved,
            "a bare Cargo version is a caret range until Cargo.lock pins it"
        );
        assert_eq!(find("tree-sitter").version, "0.25");
        assert!(!find("tree-sitter").resolved, "0.25 is a caret range in Cargo");
        assert_eq!(find("vendored").version, "path");
        assert_eq!(find("gitdep").version, "git");
        assert_eq!(find("flask").version, "3.0.3");
        assert_eq!(find("requests").version, "2.31.0");
        assert!(!find("requests").resolved);
        assert_eq!(find("plainName").version, "*");
        assert_eq!(find("click").version, "8.1.7");
        assert_eq!(find("pytest").kind, "optional");
        assert_eq!(find("github.com/pkg/errors").version, "v0.9.1");
        assert_eq!(find("golang.org/x/sys").kind, "indirect");
        assert!(inventory.entries.iter().all(|entry| entry.name != "-e"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_vendored_directories_and_rejects_bad_prefixes() {
        let root = temp_root("skips");
        write(&root, "package.json", r#"{"dependencies":{"react":"^18.0.0"}}"#);
        write(&root, "node_modules/dep/package.json", r#"{"dependencies":{"inner":"1.0.0"}}"#);
        write(&root, "target/Cargo.toml", "[dependencies]\nignored = \"1\"\n");
        write(&root, ".env.deps", "SECRET=1\n");
        let inventory = build_inventory(&root, "").unwrap();
        assert_eq!(inventory.manifests, 1, "node_modules and target are skipped");
        assert!(build_inventory(&root, "missing").is_err());
        assert_eq!(
            build_inventory(&root, "package.json").unwrap_err().code,
            "code_map_prefix_invalid",
            "prefix validation is shared with the code map"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
