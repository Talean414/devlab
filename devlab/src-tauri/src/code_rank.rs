// Phase 9K — repo-importance ranking for the native code map.
//
// The Phase 9I code map lists files in walk order, which is alphabetical and therefore spends the
// Agent's context budget on whichever files happen to sort first. This module adds a cheap, fully
// offline dependency graph on top of the same walk:
//
//   1. a bounded lexical scan extracts each mapped file's import specifiers (Rust `use`/`mod`,
//      TypeScript/JavaScript `import`/`require`/`export ... from`, Python `import`/`from`, Go
//      `import` and grouped import blocks) from the first 64 KiB only;
//   2. specifiers are resolved against the mapped files with language-specific rules (crate/self/
//      super and `mod` declarations for Rust, relative and alias-rooted paths for web projects,
//      dotted modules and relative levels for Python, path-suffix matching for Go);
//   3. a damped PageRank over the resulting citation graph scores how central each file is, and the
//      map is emitted most-important-first so the budget lands on the modules everything else
//      depends on.
//
// Only specifiers, degrees and scores leave this module: no file contents are returned, nothing is
// cached or written, and every unresolved specifier is reported as an external reference rather
// than guessed at. The scan is deliberately lexical instead of a second Tree-Sitter pass because
// import syntax differs per grammar while the textual forms above are stable and cheap.

use std::collections::{HashMap, HashSet};

/// Hard cap on the number of distinct specifiers kept per file.
pub const MAX_IMPORTS_PER_FILE: usize = 40;
/// Only the head of a file is scanned; imports live at the top in every supported language.
const MAX_IMPORT_SCAN_BYTES: usize = 64 * 1024;
const RANK_ITERATIONS: usize = 12;
pub const RANK_DAMPING: f64 = 0.85;
const RESOLVED_EXTENSIONS: &[&str] = &[
    ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".rs", ".go",
];
/// Workspace roots tried for bare (non-relative) specifiers such as `lib/http` or `@/lib/http`.
const BARE_ROOTS: &[&str] = &["", "src", "app", "lib", "packages", "src/app", "src/lib"];
const GO_SUFFIX_LIMIT: usize = 3;

/// Resolved dependency graph over a set of files. All vectors are parallel to the file list.
#[derive(Clone, Debug, Default)]
pub struct Edges {
    /// Per file: distinct mapped files it imports, sorted for determinism.
    pub out_edges: Vec<Vec<usize>>,
    /// Per file: distinct specifiers that did not resolve inside the workspace, sorted.
    pub external: Vec<Vec<String>>,
}

/// Result of ranking one code map. All vectors are parallel to the map's file list.
#[derive(Clone, Debug, Default)]
pub struct Ranking {
    /// PageRank scaled by the file count, so 1.0 means "an average file".
    pub importance: Vec<f64>,
    /// Distinct mapped files that import this file.
    pub in_degree: Vec<usize>,
    /// Distinct mapped files this file imports.
    pub out_degree: Vec<usize>,
    /// Distinct specifiers that did not resolve to a mapped file (packages, stdlib, aliases).
    pub external_deps: Vec<usize>,
    pub internal_edges: usize,
    pub external_references: usize,
    /// Files with no resolved in-repo import (leaves, entry points, standalone scripts).
    pub dangling_nodes: usize,
    pub iterations: usize,
}

struct Scanner {
    block_comment: bool,
    go_import_block: bool,
}

impl Scanner {
    fn imports_from_line(&mut self, language: &str, line: &str) -> Vec<String> {
        let trimmed = line.trim();
        if self.block_comment {
            if trimmed.contains("*/") {
                self.block_comment = false;
            }
            return Vec::new();
        }
        if trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with('*') {
            return Vec::new();
        }
        if trimmed.starts_with("/*") {
            if !trimmed.contains("*/") {
                self.block_comment = true;
            }
            return Vec::new();
        }
        let mut out = Vec::new();
        match language {
            "go" => self.go_line(trimmed, &mut out),
            "rust" => rust_line(trimmed, &mut out),
            "python" => python_line(trimmed, &mut out),
            _ => js_line(trimmed, &mut out),
        }
        out
    }

    fn go_line(&mut self, line: &str, out: &mut Vec<String>) {
        if self.go_import_block {
            if line.starts_with(')') {
                self.go_import_block = false;
                return;
            }
            if let Some(spec) = first_quoted(line) {
                out.push(spec);
            }
            return;
        }
        if line.starts_with("import (") {
            self.go_import_block = true;
            return;
        }
        if let Some(rest) = line.strip_prefix("import ") {
            if let Some(spec) = first_quoted(rest) {
                out.push(spec);
            }
        }
    }
}

/// Extracts the distinct import specifiers of one file's source, bounded by
/// [`MAX_IMPORTS_PER_FILE`] and [`MAX_IMPORT_SCAN_BYTES`].
pub fn extract_imports(language: &str, source: &str) -> Vec<String> {
    let mut scanner = Scanner {
        block_comment: false,
        go_import_block: false,
    };
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut consumed = 0usize;
    for line in source.lines() {
        consumed += line.len() + 1;
        for spec in scanner.imports_from_line(language, line) {
            if spec.is_empty() {
                continue;
            }
            if out.len() >= MAX_IMPORTS_PER_FILE {
                return out;
            }
            if seen.insert(spec.clone()) {
                out.push(spec);
            }
        }
        if consumed >= MAX_IMPORT_SCAN_BYTES {
            break;
        }
    }
    out
}

fn rust_line(line: &str, out: &mut Vec<String>) {
    for prefix in ["pub(crate) ", "pub(super) ", "pub ", ""] {
        let Some(rest) = line.strip_prefix(prefix) else {
            continue;
        };
        if let Some(rest) = rest.strip_prefix("use ") {
            push_rust_use(rest, out);
            return;
        }
        if let Some(rest) = rest.strip_prefix("mod ") {
            let name = rest.trim_end_matches(';').trim();
            if !name.is_empty() && !name.contains('{') {
                out.push(name.to_string());
            }
            return;
        }
    }
}

fn push_rust_use(rest: &str, out: &mut Vec<String>) {
    let text = rest.trim().trim_end_matches(';').trim();
    if text.is_empty() || text == "*" {
        return;
    }
    if text.contains('{') {
        expand_rust_use(text, out);
        return;
    }
    let cleaned = text.split(" as ").next().unwrap_or("").trim();
    if cleaned.is_empty() || cleaned.ends_with("::*") {
        return;
    }
    out.push(cleaned.to_string());
}

fn expand_rust_use(text: &str, out: &mut Vec<String>) {
    let Some(open) = text.find('{') else {
        push_rust_use(text, out);
        return;
    };
    let Some(close) = text.rfind('}') else {
        return;
    };
    if close < open {
        return;
    }
    let prefix = text[..open].trim_end_matches(':');
    let inner = &text[open + 1..close];
    for part in inner.split(',') {
        let part = part.trim();
        if part.is_empty() || part == "*" {
            continue;
        }
        let joined = if prefix.is_empty() {
            part.to_string()
        } else {
            format!("{prefix}::{part}")
        };
        push_rust_use(&joined, out);
    }
}

fn python_line(line: &str, out: &mut Vec<String>) {
    if let Some(rest) = line.strip_prefix("import ") {
        for part in rest.split(',') {
            let name = part.split(" as ").next().unwrap_or("").trim();
            if !name.is_empty() {
                out.push(name.to_string());
            }
        }
        return;
    }
    if let Some(rest) = line.strip_prefix("from ") {
        if let Some((module, _names)) = rest.split_once(" import ") {
            let module = module.trim();
            if !module.is_empty() {
                out.push(module.to_string());
            }
        }
    }
}

fn js_line(line: &str, out: &mut Vec<String>) {
    let module_word = line.contains("import") || line.contains("require") || line.contains("export");
    if !module_word {
        return;
    }
    let from_style = line.contains(" from ");
    let call_style = line.contains("require(") || line.contains("import(");
    // `export const NAME = "value"` is not an import; only quote-bearing module syntax is.
    if line.contains('=') && !from_style && !call_style {
        return;
    }
    for spec in quoted_strings(line) {
        out.push(spec);
    }
}

fn quoted_strings(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte != b'"' && byte != b'\'' {
            index += 1;
            continue;
        }
        let quote = byte as char;
        let tail = &line[index + 1..];
        let Some(offset) = tail.find(quote) else {
            break;
        };
        let start = index + 1;
        out.push(line[start..start + offset].to_string());
        index = start + offset + 1;
    }
    out
}

fn first_quoted(line: &str) -> Option<String> {
    quoted_strings(line).into_iter().next()
}

/// Resolves every raw specifier of every file into in-repo edges and external references.
pub fn build_edges(paths: &[String], raw_imports: &[Vec<String>]) -> Edges {
    let count = paths.len();
    let mut edges = Edges {
        out_edges: Vec::with_capacity(count),
        external: Vec::with_capacity(count),
    };
    if count == 0 {
        return edges;
    }
    let mut files: HashMap<String, usize> = HashMap::new();
    for (index, path) in paths.iter().enumerate() {
        files.insert(path.clone(), index);
    }
    let dirs = directory_index(paths);
    for (index, path) in paths.iter().enumerate() {
        let language = language_id_for(path);
        let specs = raw_imports.get(index).map(|specs| specs.as_slice()).unwrap_or(&[]);
        let mut targets: HashSet<usize> = HashSet::new();
        let mut external: HashSet<String> = HashSet::new();
        for spec in specs {
            match resolve_specifier(language, spec, path, &files, &dirs) {
                Some(target) => {
                    if target != index {
                        targets.insert(target);
                    }
                }
                None => {
                    external.insert(spec.clone());
                }
            }
        }
        let mut resolved = targets.into_iter().collect::<Vec<usize>>();
        resolved.sort();
        let mut unresolved = external.into_iter().collect::<Vec<String>>();
        unresolved.sort();
        edges.out_edges.push(resolved);
        edges.external.push(unresolved);
    }
    edges
}

/// Builds the dependency graph over `paths` from the raw specifiers collected during the walk and
/// returns per-file importance and degrees. Unresolved specifiers are counted as external.
pub fn rank_paths(paths: &[String], raw_imports: &[Vec<String>]) -> Ranking {
    let count = paths.len();
    let mut ranking = Ranking {
        importance: vec![0.0; count],
        in_degree: vec![0; count],
        out_degree: vec![0; count],
        external_deps: vec![0; count],
        internal_edges: 0,
        external_references: 0,
        dangling_nodes: 0,
        iterations: 0,
    };
    if count == 0 {
        return ranking;
    }
    let edges = build_edges(paths, raw_imports);
    let out_edges = edges.out_edges;
    let mut in_edges: Vec<Vec<usize>> = vec![Vec::new(); count];
    for (index, targets) in out_edges.iter().enumerate() {
        for target in targets {
            in_edges[*target].push(index);
        }
        ranking.out_degree[index] = targets.len();
        ranking.external_deps[index] = edges.external[index].len();
        ranking.external_references += edges.external[index].len();
        ranking.internal_edges += targets.len();
    }
    for (index, importers) in in_edges.iter().enumerate() {
        ranking.in_degree[index] = importers.len();
    }

    let total = count as f64;
    let teleport = (1.0 - RANK_DAMPING) / total;
    let mut scores = vec![1.0 / total; count];
    for _ in 0..RANK_ITERATIONS {
        let mut dangling = 0.0;
        for (index, edges) in out_edges.iter().enumerate() {
            if edges.is_empty() {
                dangling += scores[index];
            }
        }
        let shared = teleport + RANK_DAMPING * dangling / total;
        let mut next = vec![shared; count];
        for (index, edges) in out_edges.iter().enumerate() {
            if edges.is_empty() {
                continue;
            }
            let share = RANK_DAMPING * scores[index] / edges.len() as f64;
            for target in edges {
                next[*target] += share;
            }
        }
        scores = next;
        ranking.iterations += 1;
    }
    for (index, edges) in out_edges.iter().enumerate() {
        ranking.importance[index] = round3(scores[index] * total);
        if edges.is_empty() {
            ranking.dangling_nodes += 1;
        }
    }
    ranking
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn resolve_specifier(
    language: &str,
    spec: &str,
    importer: &str,
    files: &HashMap<String, usize>,
    dirs: &HashMap<String, usize>,
) -> Option<usize> {
    let candidates: Vec<String> = match language {
        "rust" => rust_candidates(spec, importer),
        "python" => python_candidates(spec, importer),
        "go" => go_candidates(spec, importer),
        _ => js_candidates(spec, importer),
    };
    for candidate in candidates {
        if let Some(index) = resolve_candidate(&candidate, files, dirs) {
            return Some(index);
        }
    }
    None
}

fn resolve_candidate(
    base: &str,
    files: &HashMap<String, usize>,
    dirs: &HashMap<String, usize>,
) -> Option<usize> {
    if base.is_empty() {
        return None;
    }
    if let Some(index) = files.get(base) {
        return Some(*index);
    }
    for extension in RESOLVED_EXTENSIONS {
        if let Some(index) = files.get(&format!("{base}{extension}")) {
            return Some(*index);
        }
    }
    for extension in RESOLVED_EXTENSIONS {
        if let Some(index) = files.get(&format!("{base}/index{extension}")) {
            return Some(*index);
        }
    }
    for suffix in ["/mod.rs", "/__init__.py"] {
        if let Some(index) = files.get(&format!("{base}{suffix}")) {
            return Some(*index);
        }
    }
    // A specifier that names a directory resolves to that directory's representative file, which is
    // how Go packages and Python packages are referenced.
    dirs.get(base).copied()
}

fn split_path(path: &str) -> (&str, &str) {
    match path.rsplit_once('/') {
        Some((dir, name)) => (dir, name),
        None => ("", path),
    }
}

fn join_path(base: &str, relative: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for part in base.split('/') {
        if !part.is_empty() {
            parts.push(part);
        }
    }
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return None;
                }
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

fn up_dirs(dir: &str, levels: usize) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|part| !part.is_empty()).collect();
    for _ in 0..levels {
        if parts.pop().is_none() {
            return None;
        }
    }
    Some(parts.join("/"))
}

fn rust_candidates(spec: &str, importer: &str) -> Vec<String> {
    let (dir, file_name) = split_path(importer);
    let is_module_root = file_name == "mod.rs" || file_name == "lib.rs" || file_name == "main.rs";
    let children = if is_module_root {
        dir.to_string()
    } else {
        let stem = file_name.split('.').next().unwrap_or(file_name);
        if stem.is_empty() {
            return Vec::new();
        }
        match join_path(dir, stem) {
            Some(path) => path,
            None => return Vec::new(),
        }
    };
    let mut segments: Vec<&str> = spec.split("::").filter(|part| !part.is_empty()).collect();
    if segments.is_empty() || segments.iter().any(|part| *part == "*") {
        return Vec::new();
    }
    let base = if segments[0] == "crate" {
        segments.remove(0);
        String::new()
    } else if segments[0] == "self" {
        segments.remove(0);
        children
    } else if segments[0] == "super" {
        let mut levels = 0usize;
        while !segments.is_empty() && segments[0] == "super" {
            segments.remove(0);
            levels += 1;
        }
        // `super` from a module-root file leaves its directory; from a leaf module file it enters
        // the directory the module occupies (`src/a/b.rs` -> `super` is `src/a`).
        let steps = if is_module_root {
            levels
        } else {
            levels.saturating_sub(1)
        };
        match up_dirs(dir, steps) {
            Some(path) => path,
            None => return Vec::new(),
        }
    } else {
        // Bare names cover `mod name;` declarations; external crates simply fail to resolve.
        children
    };
    if segments.is_empty() {
        return Vec::new();
    }
    // A crate-root path is tried at the workspace root and under `src/`, which is where Cargo
    // layouts keep their crate roots.
    let joined = segments.join("/");
    let mut out = Vec::new();
    if base.is_empty() {
        if let Some(path) = join_path("", &joined) {
            out.push(path);
        }
        if let Some(path) = join_path("src", &joined) {
            out.push(path);
        }
    } else if let Some(path) = join_path(&base, &joined) {
        out.push(path);
    }
    out
}

fn js_candidates(spec: &str, importer: &str) -> Vec<String> {
    let (dir, _name) = split_path(importer);
    if spec.starts_with('.') {
        return match join_path(dir, spec) {
            Some(path) => vec![path],
            None => Vec::new(),
        };
    }
    bare_candidates(spec)
}

fn python_candidates(spec: &str, importer: &str) -> Vec<String> {
    let (dir, _name) = split_path(importer);
    let Some(rest) = spec.strip_prefix('.') else {
        return bare_candidates(&spec.replace('.', "/"));
    };
    let mut levels = 0usize;
    let mut tail = rest;
    while let Some(stripped) = tail.strip_prefix('.') {
        levels += 1;
        tail = stripped;
    }
    let base = match up_dirs(dir, levels) {
        Some(base) => base,
        None => return Vec::new(),
    };
    // `from . import x` names the package itself, which is its `__init__.py`.
    if tail.is_empty() {
        return vec![base];
    }
    let module = tail.replace('.', "/");
    match join_path(&base, &module) {
        Some(path) => vec![path],
        None => Vec::new(),
    }
}

fn go_candidates(spec: &str, importer: &str) -> Vec<String> {
    let (dir, _name) = split_path(importer);
    if spec.starts_with('.') {
        return match join_path(dir, spec) {
            Some(path) => vec![path],
            None => Vec::new(),
        };
    }
    // Go import paths carry the module prefix, which does not exist inside the repository, so the
    // longest suffix that matches wins (most specific first).
    let segments: Vec<&str> = spec.split('/').filter(|part| !part.is_empty()).collect();
    let mut out = Vec::new();
    let limit = segments.len().min(GO_SUFFIX_LIMIT + 1);
    for take in (1..=limit).rev() {
        let start = segments.len() - take;
        out.push(segments[start..].join("/"));
    }
    out
}

fn bare_candidates(spec: &str) -> Vec<String> {
    let stripped = strip_alias(spec);
    let mut out = Vec::new();
    for root in BARE_ROOTS {
        if root.is_empty() {
            out.push(stripped.clone());
        } else {
            out.push(format!("{root}/{stripped}"));
        }
    }
    out
}

fn strip_alias(spec: &str) -> String {
    let stripped = spec
        .strip_prefix("@/")
        .or_else(|| spec.strip_prefix("~/"))
        .unwrap_or(spec);
    match stripped.strip_prefix('@') {
        Some(rest) => match rest.split_once('/') {
            Some((_scope, tail)) => tail.to_string(),
            None => stripped.to_string(),
        },
        None => stripped.to_string(),
    }
}

fn directory_index(paths: &[String]) -> HashMap<String, usize> {
    let mut dirs: HashMap<String, usize> = HashMap::new();
    for (index, path) in paths.iter().enumerate() {
        let (dir, name) = split_path(path);
        if dir.is_empty() {
            continue;
        }
        let preference = file_preference(name, dir);
        let better = match dirs.get(dir) {
            None => true,
            Some(current) => {
                let (_, current_name) = split_path(&paths[*current]);
                let current_preference = file_preference(current_name, dir);
                preference > current_preference
                    || (preference == current_preference && path.as_str() < paths[*current].as_str())
            }
        };
        if better {
            dirs.insert(dir.to_string(), index);
        }
    }
    dirs
}

/// Which file best represents a directory: a same-named Go file first, then the package entry point,
/// then the lexicographically first file.
fn file_preference(name: &str, dir: &str) -> u8 {
    let (_, dir_name) = split_path(dir);
    if !dir_name.is_empty() && name == format!("{dir_name}.go") {
        return 3;
    }
    if name.starts_with("index.") || name == "mod.rs" || name == "__init__.py" {
        return 2;
    }
    1
}

pub fn language_id_for(path: &str) -> &'static str {
    let (_dir, name) = split_path(path);
    match name.rsplit_once('.') {
        Some((_stem, extension)) => match extension {
            "rs" => "rust",
            "py" | "pyi" => "python",
            "go" => "go",
            "ts" | "mts" | "cts" => "typescript",
            "tsx" => "tsx",
            "js" | "mjs" | "cjs" | "jsx" => "javascript",
            _ => "",
        },
        None => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index_of(paths: &[String], wanted: &str) -> usize {
        paths.iter().position(|path| path == wanted).expect("test path")
    }

    #[test]
    fn extracts_rust_imports() {
        let source = concat!(
            "use std::collections::HashMap;\n",
            "pub(crate) use crate::workspace::{CommandError, WorkspaceService};\n",
            "use super::sibling as other;\n",
            "mod inner;\n",
            "pub mod public;\n",
            "// use commented::out;\n",
        );
        let imports = extract_imports("rust", source);
        assert_eq!(
            imports,
            vec![
                "std::collections::HashMap".to_string(),
                "crate::workspace::CommandError".to_string(),
                "crate::workspace::WorkspaceService".to_string(),
                "super::sibling".to_string(),
                "inner".to_string(),
                "public".to_string(),
            ]
        );
    }

    #[test]
    fn extracts_web_imports() {
        let source = concat!(
            "import React from 'react';\n",
            "import { a, b } from \"./local\";\n",
            "import \"./styles.css\";\n",
            "export * from \"@/lib/http\";\n",
            "const lazy = require(\"./lazy\");\n",
            "export const NAME = \"not an import\";\n",
        );
        let imports = extract_imports("typescript", source);
        assert!(imports.contains(&"react".to_string()));
        assert!(imports.contains(&"./local".to_string()));
        assert!(imports.contains(&"./styles.css".to_string()));
        assert!(imports.contains(&"@/lib/http".to_string()));
        assert!(imports.contains(&"./lazy".to_string()));
        assert!(!imports.iter().any(|spec| spec == "not an import"));
    }

    #[test]
    fn extracts_python_and_go_imports() {
        let python = concat!(
            "import os\n",
            "import pkg.sub as sub, json\n",
            "from . import sibling\n",
            "from ..parent.thing import Thing\n",
            "# from commented import out\n",
        );
        let imports = extract_imports("python", python);
        assert_eq!(
            imports,
            vec![
                "os".to_string(),
                "pkg.sub".to_string(),
                "json".to_string(),
                ".".to_string(),
                "..parent.thing".to_string(),
            ]
        );

        let go = concat!(
            "import (\n",
            "\t\"os\"\n",
            "\talias \"github.com/acme/repo/internal/util\"\n",
            ")\n",
            "import \"fmt\"\n",
            "fmt.Println(\"not an import\")\n",
        );
        let imports = extract_imports("go", go);
        assert_eq!(
            imports,
            vec![
                "os".to_string(),
                "github.com/acme/repo/internal/util".to_string(),
                "fmt".to_string(),
            ]
        );
    }

    #[test]
    fn ranks_a_rust_module_graph() {
        let paths = vec![
            "src/main.rs".to_string(),
            "src/lib.rs".to_string(),
            "src/util.rs".to_string(),
            "src/web/mod.rs".to_string(),
            "src/web/handler.rs".to_string(),
        ];
        let raw = vec![
            vec!["crate::lib".to_string(), "crate::util".to_string()],
            vec!["util".to_string(), "web".to_string()],
            Vec::new(),
            vec!["super::util".to_string(), "handler".to_string()],
            vec!["crate::util".to_string(), "serde::Serialize".to_string()],
        ];
        let ranking = rank_paths(&paths, &raw);
        let util = index_of(&paths, "src/util.rs");
        let handler = index_of(&paths, "src/web/handler.rs");
        assert_eq!(ranking.in_degree[util], 4, "every module reaches util");
        assert_eq!(ranking.out_degree[util], 0);
        assert_eq!(ranking.in_degree[handler], 1);
        assert!(ranking.importance[util] > ranking.importance[handler]);
        assert_eq!(ranking.external_deps[handler], 1, "serde is external");
        assert_eq!(ranking.external_references, 1);
        assert_eq!(ranking.internal_edges, 7);
        assert_eq!(ranking.dangling_nodes, 1);
        assert_eq!(ranking.iterations, RANK_ITERATIONS);
    }

    #[test]
    fn ranks_a_web_module_graph() {
        let paths = vec![
            "src/app.ts".to_string(),
            "src/components/Button.tsx".to_string(),
            "src/lib/http.ts".to_string(),
            "src/lib/index.ts".to_string(),
        ];
        let raw = vec![
            vec!["./components/Button".to_string(), "react".to_string()],
            vec!["@/lib/http".to_string()],
            Vec::new(),
            vec!["./http".to_string()],
        ];
        let ranking = rank_paths(&paths, &raw);
        let http = index_of(&paths, "src/lib/http.ts");
        let button = index_of(&paths, "src/components/Button.tsx");
        assert_eq!(ranking.in_degree[http], 2);
        assert!(ranking.importance[http] > ranking.importance[button]);
        assert_eq!(ranking.external_deps[index_of(&paths, "src/app.ts")], 1);
    }

    #[test]
    fn resolves_go_packages_by_suffix() {
        let paths = vec![
            "main.go".to_string(),
            "internal/util/util.go".to_string(),
            "internal/util/other.go".to_string(),
        ];
        let raw = vec![
            vec!["github.com/acme/repo/internal/util".to_string()],
            Vec::new(),
            Vec::new(),
        ];
        let ranking = rank_paths(&paths, &raw);
        let util = index_of(&paths, "internal/util/util.go");
        assert_eq!(ranking.in_degree[util], 1);
        assert_eq!(ranking.external_references, 0);
    }

    #[test]
    fn scoped_imports_stay_bounded_and_deterministic() {
        let source = (0..(MAX_IMPORTS_PER_FILE + 20))
            .map(|index| format!("import x{index} from './m{index}';\n"))
            .collect::<String>();
        assert_eq!(extract_imports("typescript", &source).len(), MAX_IMPORTS_PER_FILE);

        let head = format!("{}\nimport late from './late';\n", "padding\n".repeat(40_000));
        assert!(
            !extract_imports("typescript", &head).iter().any(|spec| spec == "./late"),
            "the scan stops at MAX_IMPORT_SCAN_BYTES"
        );

        let empty = rank_paths(&[], &[]);
        assert_eq!(empty.internal_edges, 0);
        assert_eq!(empty.importance.len(), 0);
    }
}
