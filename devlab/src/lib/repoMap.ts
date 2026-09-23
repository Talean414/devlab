import { listDirectory, type WorkspaceEntry } from "./workspace";

export interface RepoMapLimits {
  maxDepth: number;
  maxEntries: number;
  maxDirectories: number;
  maxRenderedChars: number;
}

export interface RepoMapEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  depth: number;
  size: number | null;
  readonly: boolean;
  extension: string;
}

export interface RepoMapSkip {
  path: string;
  reason: "ignored-name" | "unsupported-kind" | "max-depth" | "entry-limit" | "directory-limit" | "list-error";
  detail?: string;
}

export interface RepoMapSnapshot {
  generatedAt: number;
  entries: RepoMapEntry[];
  skipped: RepoMapSkip[];
  truncated: boolean;
  fileCount: number;
  directoryCount: number;
  totalFileBytes: number;
  languageCounts: { extension: string; count: number; bytes: number }[];
  importantFiles: RepoMapEntry[];
  limits: RepoMapLimits;
}

export const REPO_MAP_CONTEXT_PATH = "devlab-repo-map.md";

export const DEFAULT_REPO_MAP_LIMITS: RepoMapLimits = {
  maxDepth: 4,
  maxEntries: 600,
  maxDirectories: 120,
  maxRenderedChars: 16 * 1024,
};

const IGNORED_NAMES = new Set([
  ".git", ".hg", ".svn",
  "node_modules", "dist", "build", "out", "target", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".vite", ".turbo", ".parcel-cache",
  ".cache", ".local", ".venv", ".tox", ".nox", ".pytest_cache", ".mypy_cache",
  ".ruff_cache", "__pycache__",
]);

const IMPORTANT_FILE_NAMES = new Set([
  "README.md", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
  "Cargo.toml", "Cargo.lock", "pyproject.toml", "requirements.txt", "go.mod", "go.sum",
  "deno.json", "tsconfig.json", "vite.config.ts", "next.config.js", "next.config.ts",
  "tailwind.config.js", "tailwind.config.ts", "docker-compose.yml", "Dockerfile",
  "schema.prisma", "biome.json", "eslint.config.js", ".env.example",
]);

const EXTENSION_LABELS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "React TSX",
  js: "JavaScript",
  jsx: "React JSX",
  rs: "Rust",
  py: "Python",
  go: "Go",
  java: "Java",
  cs: "C#",
  rb: "Ruby",
  php: "PHP",
  ex: "Elixir",
  json: "JSON",
  md: "Markdown",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  sql: "SQL",
  css: "CSS",
  html: "HTML",
  sh: "Shell",
  prisma: "Prisma",
};

const SOURCE_DIRECTORY_SEGMENTS = new Set([
  "src", "app", "pages", "components", "views", "screens", "routes", "lib", "hooks", "stores", "styles",
]);

const BACKEND_DIRECTORY_SEGMENTS = new Set([
  "api", "server", "services", "controllers", "handlers", "routes", "middleware", "workers", "jobs", "cmd", "internal",
]);

const TEST_DIRECTORY_SEGMENTS = new Set([
  "test", "tests", "__tests__", "spec", "specs", "e2e", "integration", "unit", "fixtures",
]);

const DATA_DIRECTORY_SEGMENTS = new Set([
  "db", "database", "migrations", "prisma", "schema", "schemas", "models", "entities", "repositories",
]);


export async function buildRepoMap(
  limits: Partial<RepoMapLimits> = {},
): Promise<RepoMapSnapshot> {
  const boundedLimits = normalizeLimits(limits);
  const entries: RepoMapEntry[] = [];
  const skipped: RepoMapSkip[] = [];
  const queue: string[] = [""];
  let directoriesVisited = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (directoriesVisited >= boundedLimits.maxDirectories) {
      truncated = true;
      skipped.push({ path: queue[0] || ".", reason: "directory-limit" });
      break;
    }

    const directory = queue.shift() ?? "";
    directoriesVisited += 1;
    let listed: WorkspaceEntry[];
    try {
      listed = await listDirectory(directory);
    } catch (error) {
      skipped.push({
        path: directory || ".",
        reason: "list-error",
        detail: formatError(error),
      });
      continue;
    }

    for (const entry of listed) {
      const depth = pathDepth(entry.path);
      if (shouldIgnore(entry.name)) {
        skipped.push({ path: entry.path, reason: "ignored-name" });
        continue;
      }
      if (entry.kind !== "file" && entry.kind !== "directory") {
        skipped.push({ path: entry.path, reason: "unsupported-kind", detail: entry.kind });
        continue;
      }
      if (entries.length >= boundedLimits.maxEntries) {
        truncated = true;
        skipped.push({ path: entry.path, reason: "entry-limit" });
        break;
      }

      const mapped: RepoMapEntry = {
        path: entry.path,
        name: entry.name,
        kind: entry.kind,
        depth,
        size: entry.size,
        readonly: entry.readonly,
        extension: entry.kind === "file" ? extensionForPath(entry.path) : "",
      };
      entries.push(mapped);

      if (entry.kind === "directory") {
        if (depth < boundedLimits.maxDepth) queue.push(entry.path);
        else skipped.push({ path: entry.path, reason: "max-depth" });
      }
    }
    if (truncated) break;
  }

  const fileEntries = entries.filter((entry) => entry.kind === "file");
  const directoryEntries = entries.filter((entry) => entry.kind === "directory");
  const languageCounts = summarizeExtensions(fileEntries);
  return {
    generatedAt: Date.now(),
    entries,
    skipped,
    truncated,
    fileCount: fileEntries.length,
    directoryCount: directoryEntries.length,
    totalFileBytes: fileEntries.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
    languageCounts,
    importantFiles: fileEntries.filter(isImportantFile).slice(0, 40),
    limits: boundedLimits,
  };
}

export function renderRepoMap(snapshot: RepoMapSnapshot): string {
  const lines = [
    "# DevLab repository map",
    "",
    "Generated from the selected native workspace using metadata-only directory listings.",
    "No file contents were read for this map. Use it as navigation context, then attach specific files when content evidence is needed.",
    "",
    `Generated: ${new Date(snapshot.generatedAt).toLocaleString()}`,
    `Files: ${snapshot.fileCount.toLocaleString()} · directories: ${snapshot.directoryCount.toLocaleString()} · visible file bytes: ${formatBytes(snapshot.totalFileBytes)}`,
    `Limits: depth ${snapshot.limits.maxDepth}, entries ${snapshot.limits.maxEntries}, directories ${snapshot.limits.maxDirectories}`,
    snapshot.truncated ? "Truncated: yes — map limits were reached before the entire workspace was listed." : "Truncated: no within configured map limits.",
    "",
    "## Language and file-type summary",
  ];

  if (snapshot.languageCounts.length === 0) lines.push("- No regular files were listed.");
  else {
    for (const item of snapshot.languageCounts.slice(0, 16)) {
      const label = EXTENSION_LABELS[item.extension] ?? item.extension.toUpperCase();
      lines.push(`- ${label}: ${item.count} file${item.count === 1 ? "" : "s"}, ${formatBytes(item.bytes)}`);
    }
  }

  lines.push("", "## Important files");
  if (snapshot.importantFiles.length === 0) lines.push("- None detected within the current bounds.");
  else {
    for (const file of snapshot.importantFiles) lines.push(`- ${file.path} (${formatBytes(file.size ?? 0)})`);
  }

  lines.push("", "## Context focus suggestions");
  for (const suggestion of repoMapFocusSuggestions(snapshot)) lines.push(suggestion);

  lines.push("", "## Workspace tree", "- .");
  for (const entry of snapshot.entries) {
    const indent = "  ".repeat(Math.min(entry.depth + 1, snapshot.limits.maxDepth + 2));
    const label = entry.kind === "directory" ? `${entry.path}/` : entry.path;
    const suffix = entry.kind === "directory"
      ? ""
      : ` (${formatBytes(entry.size ?? 0)}${entry.readonly ? ", read-only" : ""})`;
    lines.push(`${indent}- ${label}${suffix}`);
  }

  lines.push("", "## Skipped metadata");
  if (snapshot.skipped.length === 0) lines.push("- No skipped paths within the configured bounds.");
  else {
    const byReason = new Map<RepoMapSkip["reason"], number>();
    for (const skip of snapshot.skipped) byReason.set(skip.reason, (byReason.get(skip.reason) ?? 0) + 1);
    for (const [reason, count] of byReason) lines.push(`- ${reason}: ${count}`);
    const examples = snapshot.skipped.slice(0, 20);
    if (examples.length > 0) {
      lines.push("", "Skipped examples:");
      for (const skip of examples) {
        lines.push(`- ${skip.path}: ${skip.reason}${skip.detail ? ` (${skip.detail})` : ""}`);
      }
    }
  }

  const rendered = lines.join("\n");
  if (rendered.length <= snapshot.limits.maxRenderedChars) return rendered;
  return [
    rendered.slice(0, snapshot.limits.maxRenderedChars),
    "",
    "[DevLab repo map truncated to the configured context-character budget.]",
  ].join("\n");
}

function repoMapFocusSuggestions(snapshot: RepoMapSnapshot): string[] {
  const suggestions: string[] = [
    "- Metadata-only: these are path and size hints, not file-content evidence. Attach specific files before reasoning about implementation details.",
  ];
  const manifests = snapshot.importantFiles
    .filter((file) => isManifestOrConfig(file))
    .slice(0, 8)
    .map((file) => file.path);
  if (manifests.length > 0) {
    suggestions.push(`- Start with manifests/configs for stack orientation: ${formatPathList(manifests)}.`);
  }

  const sourceDirs = focusDirectories(snapshot, SOURCE_DIRECTORY_SEGMENTS, 10);
  if (sourceDirs.length > 0) suggestions.push(`- Source/UI directories visible: ${formatPathList(sourceDirs)}.`);

  const backendDirs = focusDirectories(snapshot, BACKEND_DIRECTORY_SEGMENTS, 10);
  if (backendDirs.length > 0) suggestions.push(`- Backend/service directories visible: ${formatPathList(backendDirs)}.`);

  const testDirs = focusDirectories(snapshot, TEST_DIRECTORY_SEGMENTS, 8);
  const testFiles = focusFiles(snapshot, isTestLikeFile, 8);
  if (testDirs.length > 0 || testFiles.length > 0) {
    suggestions.push(`- Test/check metadata visible: ${formatPathList([...testDirs, ...testFiles].slice(0, 10))}.`);
  }

  const dataDirs = focusDirectories(snapshot, DATA_DIRECTORY_SEGMENTS, 8);
  const dataFiles = focusFiles(snapshot, isDataLikeFile, 8);
  if (dataDirs.length > 0 || dataFiles.length > 0) {
    suggestions.push(`- Data/schema/migration metadata visible: ${formatPathList([...dataDirs, ...dataFiles].slice(0, 10))}.`);
  }

  const topTypes = snapshot.languageCounts.slice(0, 5).map((item) => EXTENSION_LABELS[item.extension] ?? item.extension.toUpperCase());
  if (topTypes.length > 0) suggestions.push(`- Dominant listed file types: ${topTypes.join(", ")}. Use this only for routing context; inspect files for actual APIs.`);

  if (snapshot.truncated) {
    suggestions.push("- Map is truncated; refresh with narrower context or attach known files if a relevant path is missing from the visible metadata.");
  }

  return suggestions;
}

function focusDirectories(snapshot: RepoMapSnapshot, segments: Set<string>, limit: number): string[] {
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const entry of snapshot.entries) {
    if (entry.kind !== "directory") continue;
    if (!pathHasSegment(entry.path, segments)) continue;
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    matches.push(`${entry.path}/`);
    if (matches.length >= limit) break;
  }
  return matches;
}

function focusFiles(snapshot: RepoMapSnapshot, predicate: (entry: RepoMapEntry) => boolean, limit: number): string[] {
  const matches: string[] = [];
  for (const entry of snapshot.entries) {
    if (entry.kind !== "file") continue;
    if (!predicate(entry)) continue;
    matches.push(entry.path);
    if (matches.length >= limit) break;
  }
  return matches;
}

function pathHasSegment(path: string, segments: Set<string>): boolean {
  return path.split("/").some((segment) => segments.has(segment.toLowerCase()));
}

function isManifestOrConfig(file: RepoMapEntry): boolean {
  return IMPORTANT_FILE_NAMES.has(file.name) || /(^|\/)(vite|next|nuxt|svelte|astro|tailwind|eslint|biome|tsconfig|package|cargo|go\.mod|pyproject|docker-compose)/i.test(file.path);
}

function isTestLikeFile(file: RepoMapEntry): boolean {
  const lower = file.path.toLowerCase();
  return /(^|\/)(test|tests|__tests__|spec|specs|e2e|integration|unit)(\/|$)/.test(lower)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)
    || lower.endsWith("pytest.ini")
    || lower.endsWith("playwright.config.ts")
    || lower.endsWith("vitest.config.ts");
}

function isDataLikeFile(file: RepoMapEntry): boolean {
  const lower = file.path.toLowerCase();
  return pathHasSegment(lower, DATA_DIRECTORY_SEGMENTS)
    || lower.endsWith("schema.prisma")
    || lower.endsWith(".sql")
    || lower.includes("migration");
}

function formatPathList(paths: string[]): string {
  if (paths.length === 0) return "none within current bounds";
  return paths.join(", ");
}

function normalizeLimits(limits: Partial<RepoMapLimits>): RepoMapLimits {
  return {
    maxDepth: clampInt(limits.maxDepth ?? DEFAULT_REPO_MAP_LIMITS.maxDepth, 1, 8),
    maxEntries: clampInt(limits.maxEntries ?? DEFAULT_REPO_MAP_LIMITS.maxEntries, 50, 2_000),
    maxDirectories: clampInt(limits.maxDirectories ?? DEFAULT_REPO_MAP_LIMITS.maxDirectories, 10, 500),
    maxRenderedChars: clampInt(limits.maxRenderedChars ?? DEFAULT_REPO_MAP_LIMITS.maxRenderedChars, 4_096, 48 * 1024),
  };
}

function summarizeExtensions(files: RepoMapEntry[]): RepoMapSnapshot["languageCounts"] {
  const counts = new Map<string, { extension: string; count: number; bytes: number }>();
  for (const file of files) {
    const extension = file.extension || "other";
    const current = counts.get(extension) ?? { extension, count: 0, bytes: 0 };
    current.count += 1;
    current.bytes += file.size ?? 0;
    counts.set(extension, current);
  }
  return Array.from(counts.values()).sort((left, right) => right.count - left.count || left.extension.localeCompare(right.extension));
}

function isImportantFile(file: RepoMapEntry): boolean {
  if (IMPORTANT_FILE_NAMES.has(file.name)) return true;
  if (file.name.toLowerCase() === "dockerfile") return true;
  return /(^|\/)\.github\/workflows\/.+\.ya?ml$/i.test(file.path);
}

function shouldIgnore(name: string): boolean {
  return IGNORED_NAMES.has(name) || name.endsWith(".lockb");
}

function extensionForPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  if (name.toLowerCase() === "dockerfile") return "dockerfile";
  const index = name.lastIndexOf(".");
  return index > 0 && index < name.length - 1 ? name.slice(index + 1).toLowerCase() : "other";
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length - 1;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function formatError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "workspace_list failed";
}
