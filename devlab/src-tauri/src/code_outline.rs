// Phase 9H — native Tree-Sitter code outlines.
//
// Parses ONE workspace text file with a compiled-in Tree-Sitter grammar and returns a bounded,
// metadata-only symbol outline (kind, name, one-line signature, line range, nesting depth,
// exported flag). File contents are never returned by this module; the WebView still reads files
// only through `workspace_read`. Parsing runs in process memory with a wall-clock deadline, a
// 512 KiB input bound and a symbol cap, and nothing is cached or written. Unsupported extensions
// return `supported: false` instead of an error so the UI can explain honestly.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;
use tree_sitter::{Language, Node, ParseOptions, ParseState, Parser, Point};
use tree_sitter_language::LanguageFn;

use crate::workspace::{read_workspace_document, CommandError, WorkspaceService};

const MAX_OUTLINE_BYTES: u64 = 512 * 1024;
const MAX_SYMBOLS: usize = 400;
const MAX_DEPTH: u8 = 4;
const MAX_NAME_CHARS: usize = 120;
const MAX_SIGNATURE_CHARS: usize = 160;
const PARSE_DEADLINE_MS: u64 = 2_000;

struct Grammar {
    id: &'static str,
    label: &'static str,
    extensions: &'static [&'static str],
    language: LanguageFn,
}

const GRAMMARS: &[Grammar] = &[
    Grammar {
        id: "typescript",
        label: "TypeScript",
        extensions: &["ts", "mts", "cts"],
        language: tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
    },
    Grammar {
        id: "tsx",
        label: "TSX",
        extensions: &["tsx"],
        language: tree_sitter_typescript::LANGUAGE_TSX,
    },
    Grammar {
        id: "javascript",
        label: "JavaScript",
        extensions: &["js", "mjs", "cjs", "jsx"],
        language: tree_sitter_javascript::LANGUAGE,
    },
    Grammar {
        id: "rust",
        label: "Rust",
        extensions: &["rs"],
        language: tree_sitter_rust::LANGUAGE,
    },
    Grammar {
        id: "python",
        label: "Python",
        extensions: &["py", "pyi"],
        language: tree_sitter_python::LANGUAGE,
    },
    Grammar {
        id: "go",
        label: "Go",
        extensions: &["go"],
        language: tree_sitter_go::LANGUAGE,
    },
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeOutlineLanguage {
    id: &'static str,
    label: &'static str,
    extensions: Vec<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeOutlineSymbol {
    pub(crate) kind: &'static str,
    pub(crate) name: String,
    pub(crate) signature: String,
    pub(crate) start_line: u32,
    pub(crate) end_line: u32,
    pub(crate) depth: u8,
    pub(crate) exported: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeOutline {
    path: String,
    supported: bool,
    language: Option<&'static str>,
    language_label: Option<&'static str>,
    revision: String,
    size: u64,
    modified_ms: Option<u64>,
    line_count: u32,
    symbol_count: usize,
    truncated: bool,
    has_syntax_errors: bool,
    parse_ms: u64,
    symbols: Vec<CodeOutlineSymbol>,
    note: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeOutlineLimits {
    max_bytes: u64,
    max_symbols: usize,
    max_depth: u8,
    parse_deadline_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeOutlineCatalog {
    languages: Vec<CodeOutlineLanguage>,
    limits: CodeOutlineLimits,
}

pub(crate) fn extension_of(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// Grammar id (`typescript`, `rust`, …) for a path or file name, if a grammar is compiled in.
pub(crate) fn grammar_id_for(path: &str) -> Option<&'static str> {
    grammar_for(path).map(|grammar| grammar.id)
}

fn grammar_for(path: &str) -> Option<&'static Grammar> {
    let extension = extension_of(path);
    if extension.is_empty() {
        return None;
    }
    GRAMMARS.iter().find(|grammar| grammar.extensions.contains(&extension.as_str()))
}

fn bound_chars(value: &str, max_chars: usize) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_chars {
        return collapsed;
    }
    let mut out: String = collapsed.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or("")
}

struct Collector<'a> {
    source: &'a [u8],
    grammar: &'static str,
    symbols: Vec<CodeOutlineSymbol>,
    truncated: bool,
}

impl Collector<'_> {
    fn text(&self, node: Node<'_>) -> String {
        node.utf8_text(self.source).map(str::to_string).unwrap_or_default()
    }

    fn field_text(&self, node: Node<'_>, field: &str) -> Option<String> {
        node.child_by_field_name(field).map(|child| self.text(child))
    }

    fn push(&mut self, node: Node<'_>, kind: &'static str, name: String, depth: u8, exported: bool) -> bool {
        if self.symbols.len() >= MAX_SYMBOLS {
            self.truncated = true;
            return false;
        }
        let raw = node.utf8_text(self.source).unwrap_or_default();
        let signature = bound_chars(first_line(raw), MAX_SIGNATURE_CHARS);
        self.symbols.push(CodeOutlineSymbol {
            kind,
            name: bound_chars(&name, MAX_NAME_CHARS),
            signature,
            start_line: node.start_position().row as u32 + 1,
            end_line: node.end_position().row as u32 + 1,
            depth,
            exported,
        });
        true
    }

    fn children(node: Node<'_>) -> Vec<Node<'_>> {
        let mut cursor = node.walk();
        node.children(&mut cursor).collect::<Vec<_>>()
    }

    /// Walks `node`'s children. `depth` is the nesting level for symbols found here, `exported`
    /// is inherited from an enclosing `export` wrapper, `container` is the kind of the enclosing
    /// classified symbol (so functions inside classes/impls become methods).
    fn walk(&mut self, node: Node<'_>, depth: u8, exported: bool, container: Option<&'static str>) {
        if depth > MAX_DEPTH {
            return;
        }
        for child in Self::children(node) {
            if self.symbols.len() >= MAX_SYMBOLS {
                self.truncated = true;
                return;
            }
            if child.is_error() || child.is_missing() || !child.is_named() {
                continue;
            }
            let child_kind = child.kind();
            if self.is_transparent(child_kind, node.kind(), depth) {
                let now_exported = exported || child_kind == "export_statement";
                self.walk(child, depth, now_exported, container);
                continue;
            }
            let Some((kind, name)) = self.classify(child, depth, container) else {
                continue;
            };
            let is_exported = exported || self.declares_exported(child, &name);
            if !self.push(child, kind, name, depth, is_exported) {
                return;
            }
            if let Some(body) = self.container_body(child, kind) {
                self.walk(body, depth + 1, false, Some(kind));
            }
        }
    }

    fn is_transparent(&self, kind: &str, parent_kind: &str, depth: u8) -> bool {
        match self.grammar {
            "typescript" | "tsx" | "javascript" => matches!(
                kind,
                "export_statement" | "lexical_declaration" | "variable_declaration" | "ambient_declaration"
            ),
            "rust" => kind == "declaration_list",
            "python" => {
                kind == "decorated_definition"
                    || (kind == "expression_statement" && depth == 0 && parent_kind == "module")
            }
            "go" => matches!(
                kind,
                "type_declaration" | "const_declaration" | "var_declaration" | "var_spec_list"
            ),
            _ => false,
        }
    }

    fn classify(&self, node: Node<'_>, depth: u8, container: Option<&'static str>) -> Option<(&'static str, String)> {
        let kind = node.kind();
        let name = |field: &str| self.field_text(node, field).filter(|value| !value.trim().is_empty());
        match self.grammar {
            "typescript" | "tsx" | "javascript" => match kind {
                "function_declaration" | "generator_function_declaration" | "function_signature" => {
                    Some(("function", name("name")?))
                }
                "class_declaration" | "abstract_class_declaration" | "class" => Some(("class", name("name")?)),
                "interface_declaration" => Some(("interface", name("name")?)),
                "type_alias_declaration" => Some(("type", name("name")?)),
                "enum_declaration" => Some(("enum", name("name")?)),
                "internal_module" | "module" => Some(("namespace", name("name")?)),
                "method_definition" | "method_signature" | "abstract_method_signature" => Some(("method", name("name")?)),
                "public_field_definition" | "property_signature" => {
                    let value_kind = node.child_by_field_name("value").map(|value| value.kind());
                    let kind = if is_function_value(value_kind) { "method" } else { "property" };
                    Some((kind, name("name")?))
                }
                "field_definition" => {
                    let value_kind = node.child_by_field_name("value").map(|value| value.kind());
                    let kind = if is_function_value(value_kind) { "method" } else { "property" };
                    Some((kind, name("property")?))
                }
                "variable_declarator" => {
                    let value_kind = node.child_by_field_name("value").map(|value| value.kind());
                    let kind = if is_function_value(value_kind) {
                        "function"
                    } else if node
                        .parent()
                        .and_then(|parent| parent.child_by_field_name("kind"))
                        .is_some_and(|keyword| keyword.kind() == "const")
                    {
                        "constant"
                    } else {
                        "variable"
                    };
                    Some((kind, name("name")?))
                }
                _ => None,
            },
            "rust" => match kind {
                "function_item" | "function_signature_item" => {
                    let kind = if matches!(container, Some("impl") | Some("trait")) { "method" } else { "function" };
                    Some((kind, name("name")?))
                }
                "struct_item" | "union_item" => Some(("struct", name("name")?)),
                "enum_item" => Some(("enum", name("name")?)),
                "trait_item" => Some(("trait", name("name")?)),
                "impl_item" => {
                    let target = name("type")?;
                    let label = match name("trait") {
                        Some(trait_name) => format!("{trait_name} for {target}"),
                        None => target,
                    };
                    Some(("impl", label))
                }
                "mod_item" => Some(("module", name("name")?)),
                "const_item" => Some(("constant", name("name")?)),
                "static_item" => Some(("variable", name("name")?)),
                "type_item" => Some(("type", name("name")?)),
                "macro_definition" => Some(("macro", name("name")?)),
                _ => None,
            },
            "python" => match kind {
                "function_definition" => {
                    let kind = if container == Some("class") { "method" } else { "function" };
                    Some((kind, name("name")?))
                }
                "class_definition" => Some(("class", name("name")?)),
                "assignment" if depth == 0 => {
                    let left = node.child_by_field_name("left")?;
                    if left.kind() != "identifier" {
                        return None;
                    }
                    Some(("variable", self.text(left)))
                }
                _ => None,
            },
            "go" => match kind {
                "function_declaration" => Some(("function", name("name")?)),
                "method_declaration" => {
                    let receiver = self
                        .field_text(node, "receiver")
                        .map(|text| bound_chars(&text, 40))
                        .unwrap_or_default();
                    let method = name("name")?;
                    Some(("method", if receiver.is_empty() { method } else { format!("{receiver} {method}") }))
                }
                "type_spec" => {
                    let kind = match node.child_by_field_name("type").map(|value| value.kind()) {
                        Some("struct_type") => "struct",
                        Some("interface_type") => "interface",
                        _ => "type",
                    };
                    Some((kind, name("name")?))
                }
                "type_alias" => Some(("type", name("name")?)),
                "const_spec" => Some(("constant", name("name")?)),
                "var_spec" => Some(("variable", name("name")?)),
                _ => None,
            },
            _ => None,
        }
    }

    fn container_body<'n>(&self, node: Node<'n>, kind: &'static str) -> Option<Node<'n>> {
        let containers: &[&str] = match self.grammar {
            "typescript" | "tsx" | "javascript" => &["class", "interface", "namespace"],
            "rust" => &["impl", "trait", "module"],
            "python" => &["class"],
            _ => &[],
        };
        if !containers.contains(&kind) {
            return None;
        }
        node.child_by_field_name("body")
    }

    fn declares_exported(&self, node: Node<'_>, name: &str) -> bool {
        match self.grammar {
            "rust" => Self::children(node).iter().any(|child| child.kind() == "visibility_modifier"),
            "python" => !name.starts_with('_'),
            "go" => name
                .rsplit(' ')
                .next()
                .and_then(|last| last.chars().next())
                .is_some_and(char::is_uppercase),
            _ => false,
        }
    }
}

fn is_function_value(kind: Option<&str>) -> bool {
    matches!(
        kind,
        Some("arrow_function")
            | Some("function_expression")
            | Some("function")
            | Some("generator_function")
            | Some("generator_function_expression")
    )
}

pub(crate) struct ParsedOutline {
    pub(crate) symbols: Vec<CodeOutlineSymbol>,
    pub(crate) truncated: bool,
    pub(crate) has_syntax_errors: bool,
    pub(crate) parse_ms: u64,
}

fn language_of(grammar: &'static Grammar) -> Language {
    grammar.language.into()
}

pub(crate) fn outline_source(grammar_id: &str, source: &str) -> Result<ParsedOutline, CommandError> {
    let grammar = GRAMMARS
        .iter()
        .find(|grammar| grammar.id == grammar_id)
        .ok_or_else(|| CommandError::new("code_outline_unsupported", "No grammar is compiled in for this language."))?;
    let language = language_of(grammar);
    let mut parser = Parser::new();
    parser.set_language(&language).map_err(|error| {
        CommandError::new(
            "code_outline_grammar_incompatible",
            format!("The compiled {} grammar is incompatible with the Tree-Sitter runtime: {error}", grammar.label),
        )
    })?;

    let started = Instant::now();
    let deadline = started + Duration::from_millis(PARSE_DEADLINE_MS);
    let bytes = source.as_bytes();
    let mut progress = |_state: &ParseState| Instant::now() > deadline;
    let options = ParseOptions::new().progress_callback(&mut progress);
    let tree = parser
        .parse_with_options(
            &mut |offset: usize, _point: Point| bytes.get(offset..).unwrap_or_default(),
            None,
            Some(options),
        )
        .ok_or_else(|| {
            CommandError::new(
                "code_outline_timeout",
                format!("Parsing did not finish within {PARSE_DEADLINE_MS} ms; the outline was abandoned."),
            )
        })?;
    let root = tree.root_node();
    let mut collector = Collector {
        source: bytes,
        grammar: grammar.id,
        symbols: Vec::new(),
        truncated: false,
    };
    collector.walk(root, 0, false, None);
    Ok(ParsedOutline {
        symbols: collector.symbols,
        truncated: collector.truncated,
        has_syntax_errors: root.has_error(),
        parse_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

fn line_count(source: &str) -> u32 {
    if source.is_empty() {
        return 0;
    }
    let newlines = source.bytes().filter(|byte| *byte == b'\n').count();
    let trailing = if source.ends_with('\n') { 0 } else { 1 };
    (newlines + trailing).min(u32::MAX as usize) as u32
}

#[tauri::command]
pub fn code_outline_languages() -> CodeOutlineCatalog {
    CodeOutlineCatalog {
        languages: GRAMMARS
            .iter()
            .map(|grammar| CodeOutlineLanguage {
                id: grammar.id,
                label: grammar.label,
                extensions: grammar.extensions.to_vec(),
            })
            .collect(),
        limits: CodeOutlineLimits {
            max_bytes: MAX_OUTLINE_BYTES,
            max_symbols: MAX_SYMBOLS,
            max_depth: MAX_DEPTH,
            parse_deadline_ms: PARSE_DEADLINE_MS,
        },
    }
}

/// Reads one workspace file through the scoped workspace boundary and returns its symbol outline.
/// Contents never leave Rust; the response carries symbol metadata only.
#[tauri::command]
pub async fn code_outline_file(
    relative_path: String,
    workspace: State<'_, WorkspaceService>,
) -> Result<CodeOutline, CommandError> {
    let document = read_workspace_document(relative_path, &workspace)?;
    if document.size > MAX_OUTLINE_BYTES {
        return Err(CommandError::new(
            "code_outline_too_large",
            format!("Code outlines cover files up to {} KiB.", MAX_OUTLINE_BYTES / 1024),
        ));
    }
    let path = document.path;
    let base = CodeOutline {
        path: path.clone(),
        supported: false,
        language: None,
        language_label: None,
        revision: document.revision,
        size: document.size,
        modified_ms: document.modified_ms,
        line_count: line_count(&document.content),
        symbol_count: 0,
        truncated: false,
        has_syntax_errors: false,
        parse_ms: 0,
        symbols: Vec::new(),
        note: String::new(),
    };
    let Some(grammar) = grammar_for(&path) else {
        return Ok(CodeOutline {
            note: format!(
                "No compiled-in grammar for `.{}` files. Supported: {}.",
                extension_of(&path),
                GRAMMARS.iter().map(|grammar| grammar.label).collect::<Vec<_>>().join(", ")
            ),
            ..base
        });
    };
    let source = document.content;
    let grammar_id = grammar.id;
    let parsed = tauri::async_runtime::spawn_blocking(move || outline_source(grammar_id, &source))
        .await
        .map_err(|_| CommandError::new("code_outline_error", "The outline worker stopped unexpectedly."))??;
    let mut note = format!("{} symbols from the {} grammar.", parsed.symbols.len(), grammar.label);
    if parsed.has_syntax_errors {
        note.push_str(" The file has syntax errors; the outline may be partial.");
    }
    if parsed.truncated {
        note.push_str(&format!(" Only the first {MAX_SYMBOLS} symbols are listed."));
    }
    Ok(CodeOutline {
        supported: true,
        language: Some(grammar.id),
        language_label: Some(grammar.label),
        symbol_count: parsed.symbols.len(),
        truncated: parsed.truncated,
        has_syntax_errors: parsed.has_syntax_errors,
        parse_ms: parsed.parse_ms,
        symbols: parsed.symbols,
        note,
        ..base
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(symbols: &[CodeOutlineSymbol]) -> Vec<(&'static str, String, u8, bool)> {
        symbols
            .iter()
            .map(|symbol| (symbol.kind, symbol.name.clone(), symbol.depth, symbol.exported))
            .collect()
    }

    #[test]
    fn maps_extensions_to_grammars() {
        assert_eq!(grammar_for("src/App.tsx").map(|g| g.id), Some("tsx"));
        assert_eq!(grammar_for("src/lib/x.ts").map(|g| g.id), Some("typescript"));
        assert_eq!(grammar_for("a/b/c.MJS").map(|g| g.id), Some("javascript"));
        assert_eq!(grammar_for("main.rs").map(|g| g.id), Some("rust"));
        assert_eq!(grammar_for("tool.pyi").map(|g| g.id), Some("python"));
        assert_eq!(grammar_for("cmd/main.go").map(|g| g.id), Some("go"));
        assert!(grammar_for("README.md").is_none());
        assert!(grammar_for(".gitignore").is_none());
        assert!(grammar_for("Makefile").is_none());
        assert_eq!(extension_of("dir.v1/file"), "");
    }

    #[test]
    fn every_grammar_loads_into_the_runtime() {
        for grammar in GRAMMARS {
            let language = language_of(grammar);
            let mut parser = Parser::new();
            parser.set_language(&language).unwrap_or_else(|error| panic!("{}: {error}", grammar.id));
        }
    }

    #[test]
    fn outlines_typescript() {
        let source = r#"
import { x } from "./x";
export const API_URL = "https://example.test";
let counter = 0;
export function load(id: string): Promise<void> { return Promise.resolve(); }
const helper = (a: number) => a * 2;
export interface Options { retries: number; onDone(): void; }
export type Mode = "a" | "b";
export enum Color { Red, Green }
export default class Store {
  private items: string[] = [];
  handle = () => this.items;
  add(item: string) { this.items.push(item); }
}
namespace Util { export function inner() {} }
"#;
        let parsed = outline_source("typescript", source).expect("outline");
        let found = names(&parsed.symbols);
        assert!(found.contains(&("constant", "API_URL".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("variable", "counter".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("function", "load".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("function", "helper".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("interface", "Options".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("property", "retries".into(), 1, false)), "{found:?}");
        assert!(found.contains(&("method", "onDone".into(), 1, false)), "{found:?}");
        assert!(found.contains(&("type", "Mode".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("enum", "Color".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("class", "Store".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("property", "items".into(), 1, false)), "{found:?}");
        assert!(found.contains(&("method", "handle".into(), 1, false)), "{found:?}");
        assert!(found.contains(&("method", "add".into(), 1, false)), "{found:?}");
        assert!(found.contains(&("namespace", "Util".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("function", "inner".into(), 1, true)), "{found:?}");
        assert!(!parsed.has_syntax_errors);
        let load = parsed.symbols.iter().find(|s| s.name == "load").expect("load");
        assert_eq!(load.start_line, 5);
        assert!(load.signature.starts_with("function load(id: string)"), "{}", load.signature);
    }

    #[test]
    fn outlines_tsx_and_javascript() {
        let tsx = "export function App() { return <div>hi</div>; }\nconst Item = ({ a }: { a: number }) => <span>{a}</span>;\n";
        let parsed = outline_source("tsx", tsx).expect("tsx");
        let found = names(&parsed.symbols);
        assert!(found.contains(&("function", "App".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("function", "Item".into(), 0, false)), "{found:?}");

        let js = "function a() {}\nclass B { m() {} }\nconst c = function () {};\nvar d = 1;\nmodule.exports = { a };\n";
        let parsed = outline_source("javascript", js).expect("js");
        let found = names(&parsed.symbols);
        assert!(found.contains(&("function", "a".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("class", "B".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("method", "m".into(), 1, false)), "{found:?}");
        assert!(found.contains(&("function", "c".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("variable", "d".into(), 0, false)), "{found:?}");
    }

    #[test]
    fn outlines_rust() {
        let source = r#"
pub mod inner { pub fn nested() {} fn hidden() {} }
pub struct Point { x: i32 }
enum Shape { Circle }
pub trait Draw { fn draw(&self); }
impl Draw for Point { fn draw(&self) {} }
impl Point { pub fn new() -> Self { Point { x: 0 } } }
pub const LIMIT: usize = 3;
static COUNTER: u8 = 0;
type Alias = Point;
macro_rules! shout { () => {}; }
fn main() { let local = 1; }
"#;
        let parsed = outline_source("rust", source).expect("outline");
        let found = names(&parsed.symbols);
        assert!(found.contains(&("module", "inner".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("function", "nested".into(), 1, true)), "{found:?}");
        assert!(found.contains(&("function", "hidden".into(), 1, false)), "{found:?}");
        assert!(found.contains(&("struct", "Point".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("enum", "Shape".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("trait", "Draw".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("method", "draw".into(), 1, false)), "{found:?}");
        assert!(found.contains(&("impl", "Draw for Point".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("impl", "Point".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("method", "new".into(), 1, true)), "{found:?}");
        assert!(found.contains(&("constant", "LIMIT".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("variable", "COUNTER".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("type", "Alias".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("macro", "shout".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("function", "main".into(), 0, false)), "{found:?}");
        assert!(!found.iter().any(|(_, name, _, _)| name == "local"), "{found:?}");
    }

    #[test]
    fn outlines_python_and_go() {
        let py = "import os\nVERSION = \"1\"\n_private = 2\n\n@decorator\ndef top(a, b):\n    inner_value = 1\n    def inner():\n        pass\n\nclass Thing(Base):\n    def method(self):\n        pass\n    def _hidden(self):\n        pass\n";
        let parsed = outline_source("python", py).expect("python");
        let found = names(&parsed.symbols);
        assert!(found.contains(&("variable", "VERSION".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("variable", "_private".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("function", "top".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("class", "Thing".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("method", "method".into(), 1, true)), "{found:?}");
        assert!(found.contains(&("method", "_hidden".into(), 1, false)), "{found:?}");
        assert!(!found.iter().any(|(_, name, _, _)| name == "inner" || name == "inner_value"), "{found:?}");

        let go = "package main\n\nconst Limit = 3\nvar count int\n\ntype Server struct{ addr string }\ntype Handler interface{ Serve() }\ntype ID = int\n\nfunc (s *Server) Start() error { return nil }\nfunc helper() {}\nfunc Main() {}\n";
        let parsed = outline_source("go", go).expect("go");
        let found = names(&parsed.symbols);
        assert!(found.contains(&("constant", "Limit".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("variable", "count".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("struct", "Server".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("interface", "Handler".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("type", "ID".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("method", "(s *Server) Start".into(), 0, true)), "{found:?}");
        assert!(found.contains(&("function", "helper".into(), 0, false)), "{found:?}");
        assert!(found.contains(&("function", "Main".into(), 0, true)), "{found:?}");
    }

    #[test]
    fn reports_syntax_errors_and_caps_symbols() {
        let parsed = outline_source("typescript", "export function broken( {").expect("outline");
        assert!(parsed.has_syntax_errors);

        let mut big = String::new();
        for index in 0..(MAX_SYMBOLS + 50) {
            big.push_str(&format!("function f{index}() {{}}\n"));
        }
        let parsed = outline_source("javascript", &big).expect("outline");
        assert_eq!(parsed.symbols.len(), MAX_SYMBOLS);
        assert!(parsed.truncated);
    }

    #[test]
    fn bounds_signatures_and_counts_lines() {
        let long = format!("function {}() {{}}", "x".repeat(400));
        let parsed = outline_source("javascript", &long).expect("outline");
        assert_eq!(parsed.symbols[0].signature.chars().count(), MAX_SIGNATURE_CHARS);
        assert_eq!(parsed.symbols[0].name.chars().count(), MAX_NAME_CHARS);
        assert_eq!(line_count(""), 0);
        assert_eq!(line_count("a"), 1);
        assert_eq!(line_count("a\nb\n"), 2);
        assert_eq!(line_count("a\nb"), 2);
        assert!(outline_source("cobol", "x").is_err());
    }
}
