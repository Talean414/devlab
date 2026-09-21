import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { PanelHeader } from "./AgentPanel";
import { loadSettings, getTheme } from "../lib/settings";
import type { VFile } from "../types";
import {
  closeWorkspace,
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceEntry,
  getCurrentWorkspace,
  listDirectory,
  onWorkspaceChange,
  readWorkspaceFile,
  renameWorkspaceEntry,
  selectWorkspace,
  WorkspaceCommandError,
  writeWorkspaceFile,
  type WorkspaceDocument,
  type WorkspaceEntry,
  type WorkspaceInfo,
} from "../lib/workspace";
import {
  AlertTriangle,
  ArrowUp,
  ChevronRight,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

interface OpenDocument extends WorkspaceDocument {
  dirty: boolean;
  saving: boolean;
  changedOnDisk: boolean;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dockerfile: "dockerfile",
  ex: "elixir",
  go: "go",
  graphql: "graphql",
  html: "html",
  java: "java",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  kt: "kotlin",
  md: "markdown",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "shell",
  sql: "sql",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

export function EditorPanel({
  incomingDrafts = [],
  onDismissDrafts,
  onDirtyChange,
}: {
  incomingDrafts?: VFile[];
  onDismissDrafts?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [documents, setDocuments] = useState<Record<string, OpenDocument>>({});
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [draftReviewOpen, setDraftReviewOpen] = useState(incomingDrafts.length > 0);
  const [draftIndex, setDraftIndex] = useState(0);
  const ignoredEvents = useRef(new Map<string, number>());
  const eventTimer = useRef<number | null>(null);
  const settings = loadSettings();
  const theme = getTheme(settings.theme);

  const activeDocument = documents[activePath];
  const dirtyCount = Object.values(documents).filter((document) => document.dirty).length;
  const visibleEntries = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query
      ? entries.filter((entry) => entry.name.toLowerCase().includes(query))
      : entries;
  }, [entries, filter]);
  const selectedDraft = incomingDrafts[draftIndex];

  useEffect(() => {
    if (incomingDrafts.length === 0) {
      setDraftReviewOpen(false);
      setDraftIndex(0);
      return;
    }
    setDraftIndex(0);
    setDraftReviewOpen(true);
  }, [incomingDrafts]);

  useEffect(() => {
    onDirtyChange?.(dirtyCount > 0);
    return () => onDirtyChange?.(false);
  }, [dirtyCount, onDirtyChange]);

  useEffect(() => {
    function warnBeforeClose(event: BeforeUnloadEvent) {
      if (dirtyCount === 0) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeClose);
    return () => window.removeEventListener("beforeunload", warnBeforeClose);
  }, [dirtyCount]);

  useEffect(() => {
    let mounted = true;
    getCurrentWorkspace()
      .then((current) => {
        if (!mounted) return;
        setWorkspace(current);
      })
      .catch((commandError) => {
        if (mounted) setError(errorMessage(commandError));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!workspace) {
      setEntries([]);
      return;
    }
    let mounted = true;
    setLoading(true);
    listDirectory(currentDirectory)
      .then((next) => {
        if (mounted) setEntries(next);
      })
      .catch((commandError) => {
        if (mounted) setError(errorMessage(commandError));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [workspace, currentDirectory, refreshVersion]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onWorkspaceChange((change) => {
      const now = Date.now();
      const changedPaths = change.paths.filter((path) => {
        const ignoreUntil = ignoredEvents.current.get(path) ?? 0;
        if (ignoreUntil > now) return false;
        ignoredEvents.current.delete(path);
        return true;
      });
      if (changedPaths.length === 0) return;

      setDocuments((current) => {
        const next = { ...current };
        let changed = false;
        for (const [path, document] of Object.entries(current)) {
          if (changedPaths.some((changedPath) => path === changedPath || path.startsWith(`${changedPath}/`))) {
            next[path] = { ...document, changedOnDisk: true };
            changed = true;
          }
        }
        return changed ? next : current;
      });
      setNotice("The workspace changed on disk. The file list has been refreshed.");
      if (eventTimer.current) window.clearTimeout(eventTimer.current);
      eventTimer.current = window.setTimeout(() => setRefreshVersion((version) => version + 1), 150);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((commandError) => setError(errorMessage(commandError)));

    return () => {
      disposed = true;
      unlisten?.();
      if (eventTimer.current) window.clearTimeout(eventTimer.current);
    };
  }, []);

  useEffect(() => {
    function saveShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (activePath) void saveDocument(activePath);
    }
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  });

  async function chooseWorkspace() {
    if (dirtyCount > 0 && !confirm("Change workspace and discard all unsaved editor changes?")) return;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const selected = await selectWorkspace();
      if (!selected) return;
      setWorkspace(selected);
      setCurrentDirectory("");
      setDocuments({});
      setOpenTabs([]);
      setActivePath("");
      setFilter("");
      setNotice(`Scoped workspace opened: ${selected.name}`);
      setRefreshVersion((version) => version + 1);
    } catch (commandError) {
      setError(errorMessage(commandError));
    } finally {
      setWorking(false);
    }
  }

  async function disconnectWorkspace() {
    if (dirtyCount > 0 && !confirm("Close the workspace and discard all unsaved editor changes?")) return;
    setWorking(true);
    setError("");
    try {
      await closeWorkspace();
      setWorkspace(null);
      setCurrentDirectory("");
      setDocuments({});
      setOpenTabs([]);
      setActivePath("");
      setNotice("Workspace closed. Native file access has been revoked.");
    } catch (commandError) {
      setError(errorMessage(commandError));
    } finally {
      setWorking(false);
    }
  }

  async function openFile(path: string) {
    if (documents[path]) {
      setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
      setActivePath(path);
      return;
    }
    setWorking(true);
    setError("");
    try {
      const document = await readWorkspaceFile(path);
      setDocuments((current) => ({
        ...current,
        [path]: { ...document, dirty: false, saving: false, changedOnDisk: false },
      }));
      setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
      setActivePath(path);
    } catch (commandError) {
      setError(errorMessage(commandError));
    } finally {
      setWorking(false);
    }
  }

  function updateContent(value: string | undefined) {
    if (value === undefined || !activeDocument) return;
    setDocuments((current) => ({
      ...current,
      [activePath]: { ...current[activePath], content: value, dirty: true },
    }));
  }

  async function saveDocument(path: string) {
    const document = documents[path];
    if (!document || !document.dirty || document.saving) return;
    const contentAtSave = document.content;
    ignoredEvents.current.set(path, Date.now() + 2_000);
    setError("");
    setDocuments((current) => ({
      ...current,
      [path]: { ...current[path], saving: true },
    }));
    try {
      const saved = await writeWorkspaceFile(path, contentAtSave, document.revision || null);
      setDocuments((current) => {
        const latest = current[path];
        if (!latest) return current;
        const changedWhileSaving = latest.content !== contentAtSave;
        return {
          ...current,
          [path]: {
            ...latest,
            revision: saved.revision,
            size: saved.size,
            modifiedMs: saved.modifiedMs,
            dirty: changedWhileSaving,
            saving: false,
            changedOnDisk: false,
          },
        };
      });
      setNotice(`Saved ${path}`);
    } catch (commandError) {
      ignoredEvents.current.delete(path);
      setDocuments((current) => ({
        ...current,
        [path]: { ...current[path], saving: false },
      }));
      setError(errorMessage(commandError));
    }
  }

  async function applyDraftToWorkspace(draft: VFile) {
    if (!workspace) {
      setError("Select a workspace before applying a reviewed draft.");
      return;
    }
    const path = draft.path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!path) {
      setError("The reviewed draft does not have a valid workspace-relative path.");
      return;
    }
    if (!confirm(`Apply the reviewed draft to ${path}? This writes to the selected workspace.`)) return;

    setWorking(true);
    setError("");
    setNotice("");
    try {
      ignoredEvents.current.set(path, Date.now() + 2_000);
      let saved: WorkspaceDocument;
      let action = "Created";
      try {
        saved = await writeWorkspaceFile(path, draft.content, null);
      } catch (commandError) {
        if (!(commandError instanceof WorkspaceCommandError) || commandError.code !== "revision_required") {
          throw commandError;
        }
        const existing = await readWorkspaceFile(path);
        if (!confirm(`${path} already exists. Replace it with this reviewed draft using a native revision check?`)) {
          ignoredEvents.current.delete(path);
          return;
        }
        ignoredEvents.current.set(path, Date.now() + 2_000);
        saved = await writeWorkspaceFile(path, draft.content, existing.revision);
        action = "Updated";
      }

      setDocuments((current) => ({
        ...current,
        [path]: { ...saved, dirty: false, saving: false, changedOnDisk: false },
      }));
      setOpenTabs((tabs) => [...tabs.filter((tab) => tab !== path), path]);
      setActivePath(path);
      setCurrentDirectory(parentPath(path));
      setDraftReviewOpen(false);
      setRefreshVersion((version) => version + 1);
      setNotice(`${action} ${path} from a reviewed draft.`);
    } catch (commandError) {
      ignoredEvents.current.delete(path);
      setError(errorMessage(commandError));
    } finally {
      setWorking(false);
    }
  }

  async function reloadDocument(path: string) {
    const existing = documents[path];
    if (existing?.dirty && !confirm(`Discard unsaved changes to ${path} and reload from disk?`)) return;
    setWorking(true);
    setError("");
    try {
      const reloaded = await readWorkspaceFile(path);
      setDocuments((current) => ({
        ...current,
        [path]: { ...reloaded, dirty: false, saving: false, changedOnDisk: false },
      }));
      setNotice(`Reloaded ${path} from disk.`);
    } catch (commandError) {
      setError(errorMessage(commandError));
    } finally {
      setWorking(false);
    }
  }

  async function newFile() {
    const name = prompt("New file path relative to this directory:");
    if (!name?.trim()) return;
    const path = joinPath(currentDirectory, name.trim());
    setWorking(true);
    setError("");
    try {
      ignoredEvents.current.set(path, Date.now() + 2_000);
      const document = await createWorkspaceFile(path);
      setDocuments((current) => ({
        ...current,
        [path]: { ...document, dirty: false, saving: false, changedOnDisk: false },
      }));
      setOpenTabs((tabs) => [...tabs.filter((tab) => tab !== path), path]);
      setActivePath(path);
      setRefreshVersion((version) => version + 1);
      setNotice(`Created ${path}`);
    } catch (commandError) {
      ignoredEvents.current.delete(path);
      setError(errorMessage(commandError));
    } finally {
      setWorking(false);
    }
  }

  async function newDirectory() {
    const name = prompt("New directory path relative to this directory:");
    if (!name?.trim()) return;
    const path = joinPath(currentDirectory, name.trim());
    setWorking(true);
    setError("");
    try {
      ignoredEvents.current.set(path, Date.now() + 2_000);
      await createWorkspaceDirectory(path);
      setRefreshVersion((version) => version + 1);
      setNotice(`Created ${path}`);
    } catch (commandError) {
      ignoredEvents.current.delete(path);
      setError(errorMessage(commandError));
    } finally {
      setWorking(false);
    }
  }

  async function renameEntry(entry: WorkspaceEntry) {
    const nextName = prompt(`Rename ${entry.name} to:`, entry.name);
    if (!nextName?.trim() || nextName.trim() === entry.name) return;
    const nextPath = joinPath(currentDirectory, nextName.trim());
    if (hasDirtyPath(entry.path) && !confirm("Renaming will close unsaved files below this path. Continue?")) return;
    setWorking(true);
    setError("");
    try {
      ignoredEvents.current.set(entry.path, Date.now() + 2_000);
      ignoredEvents.current.set(nextPath, Date.now() + 2_000);
      await renameWorkspaceEntry(entry.path, nextPath);
      closePath(entry.path);
      setRefreshVersion((version) => version + 1);
      setNotice(`Renamed ${entry.path} to ${nextPath}`);
    } catch (commandError) {
      ignoredEvents.current.delete(entry.path);
      ignoredEvents.current.delete(nextPath);
      setError(errorMessage(commandError));
    } finally {
      setWorking(false);
    }
  }

  async function deleteEntry(entry: WorkspaceEntry) {
    const descriptor = entry.kind === "directory" ? "empty directory" : "file";
    if (!confirm(`Permanently delete the ${descriptor} “${entry.path}”? This cannot be undone.`)) return;
    if (hasDirtyPath(entry.path) && !confirm("This will discard unsaved editor changes. Delete anyway?")) return;
    setWorking(true);
    setError("");
    try {
      ignoredEvents.current.set(entry.path, Date.now() + 2_000);
      await deleteWorkspaceEntry(entry.path);
      closePath(entry.path);
      setRefreshVersion((version) => version + 1);
      setNotice(`Deleted ${entry.path}`);
    } catch (commandError) {
      ignoredEvents.current.delete(entry.path);
      setError(errorMessage(commandError));
    } finally {
      setWorking(false);
    }
  }

  function hasDirtyPath(path: string) {
    return Object.values(documents).some(
      (document) => (document.path === path || document.path.startsWith(`${path}/`)) && document.dirty,
    );
  }

  function closePath(path: string) {
    setDocuments((current) => Object.fromEntries(
      Object.entries(current).filter(([documentPath]) => (
        documentPath !== path && !documentPath.startsWith(`${path}/`)
      )),
    ));
    const remainingTabs = openTabs.filter(
      (tab) => tab !== path && !tab.startsWith(`${path}/`),
    );
    setOpenTabs(remainingTabs);
    setActivePath((active) => (
      active === path || active.startsWith(`${path}/`) ? (remainingTabs[0] ?? "") : active
    ));
  }

  function closeTab(path: string) {
    const document = documents[path];
    if (document?.dirty && !confirm(`Close ${path} and discard its unsaved changes?`)) return;
    const remainingTabs = openTabs.filter((tab) => tab !== path);
    setOpenTabs(remainingTabs);
    if (activePath === path) setActivePath(remainingTabs[0] ?? "");
    setDocuments((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
  }

  function navigateUp() {
    setCurrentDirectory(parentPath(currentDirectory));
    setFilter("");
  }

  return (
    <div className="relative flex h-full flex-col">
      <PanelHeader
        title="Native Workspace Editor"
        subtitle={workspace
          ? `${workspace.path} · all file operations are scoped by the Rust backend`
          : "Select a folder through the native dialog to grant temporary workspace access"}
        badge={workspace ? (dirtyCount ? `${dirtyCount} unsaved` : "Native filesystem") : "No workspace"}
        badgeOk={Boolean(workspace) && dirtyCount === 0}
      />

      {(error || notice) && (
        <div className={`flex items-center gap-2 border-b px-4 py-2 text-[12px] ${
          error
            ? "border-rose-500/20 bg-rose-500/10 text-rose-200"
            : "border-cyan-500/20 bg-cyan-500/[0.07] text-cyan-100"
        }`}>
          {error ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <HardDrive className="h-3.5 w-3.5 shrink-0" />}
          <span className="min-w-0 flex-1 truncate">{error || notice}</span>
          <button onClick={() => { setError(""); setNotice(""); }} className="rounded p-0.5 hover:bg-white/10" aria-label="Dismiss message">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {incomingDrafts.length > 0 && (
        <div className="flex items-center gap-2 border-b border-violet-500/20 bg-violet-500/[0.08] px-4 py-2 text-[12px] text-violet-100">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-300" />
          <span className="min-w-0 flex-1">
            {incomingDrafts.length} generated {incomingDrafts.length === 1 ? "draft is" : "drafts are"} ready for review. Nothing was written to disk.
          </span>
          <button onClick={() => setDraftReviewOpen(true)} className="rounded-md bg-violet-500/15 px-2.5 py-1 font-medium text-violet-200 hover:bg-violet-500/25">
            Review drafts
          </button>
        </div>
      )}

      {!workspace ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-lg rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.05] p-8 text-center ring-soft">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-500/10 ring-1 ring-cyan-500/20">
              <FolderOpen className="h-7 w-7 text-cyan-300" />
            </div>
            <h3 className="mt-5 text-lg font-semibold text-white">Open a real workspace</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-zinc-400">
              The native folder picker is the only way to establish the workspace boundary. DevLab
              stores the canonical path in Rust memory, rejects parent traversal and never falls back
              to browser-local files.
            </p>
            <button onClick={chooseWorkspace} disabled={working || loading}
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:from-cyan-400 hover:to-blue-500 disabled:opacity-50">
              {working || loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
              Select workspace folder
            </button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-72 shrink-0 flex-col border-r border-white/5 bg-[#0d1017]/50">
            <div className="border-b border-white/5 p-2.5">
              <div className="flex items-center gap-2">
                <button onClick={chooseWorkspace} disabled={working}
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-left hover:bg-white/[0.06] disabled:opacity-50"
                  title={workspace.path}>
                  <div className="truncate text-[12.5px] font-semibold text-zinc-100">{workspace.name}</div>
                  <div className="truncate font-mono text-[9.5px] text-zinc-600">Change workspace</div>
                </button>
                <button onClick={disconnectWorkspace} disabled={working} title="Close workspace and revoke access"
                  className="rounded-lg border border-white/10 p-2.5 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-50">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="flex items-center gap-1 border-b border-white/5 p-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
                <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter this directory"
                  className="w-full rounded-md border border-white/10 bg-[#0b0e14] py-1.5 pl-7 pr-2 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-cyan-500/50" />
              </div>
              <button onClick={newFile} disabled={working} title="New file" className="rounded-md p-1.5 text-zinc-400 hover:bg-white/5 hover:text-white disabled:opacity-40">
                <FilePlus2 className="h-3.5 w-3.5" />
              </button>
              <button onClick={newDirectory} disabled={working} title="New directory" className="rounded-md p-1.5 text-zinc-400 hover:bg-white/5 hover:text-white disabled:opacity-40">
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => setRefreshVersion((version) => version + 1)} disabled={working || loading} title="Refresh"
                className="rounded-md p-1.5 text-zinc-400 hover:bg-white/5 hover:text-white disabled:opacity-40">
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>

            <div className="flex min-w-0 items-center gap-1 border-b border-white/5 px-2 py-2 font-mono text-[10.5px] text-zinc-500">
              <button onClick={() => setCurrentDirectory("")} className="shrink-0 rounded px-1 py-0.5 hover:bg-white/5 hover:text-zinc-200">
                {workspace.name}
              </button>
              {directoryParts(currentDirectory).map((part) => (
                <span key={part.path} className="flex min-w-0 items-center gap-1">
                  <ChevronRight className="h-3 w-3 shrink-0 text-zinc-700" />
                  <button onClick={() => setCurrentDirectory(part.path)} className="truncate rounded px-1 py-0.5 hover:bg-white/5 hover:text-zinc-200">
                    {part.name}
                  </button>
                </span>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-1.5">
              {currentDirectory && (
                <button onClick={navigateUp} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-200">
                  <ArrowUp className="h-3.5 w-3.5" />
                  <span className="font-mono text-[12px]">..</span>
                </button>
              )}
              {visibleEntries.map((entry) => (
                <div key={entry.path} className={`group flex items-center gap-2 rounded-md px-2 py-1.5 transition ${
                  activePath === entry.path ? "bg-cyan-500/10 text-cyan-100" : "text-zinc-400 hover:bg-white/5"
                }`}>
                  {entry.kind === "directory"
                    ? <Folder className="h-3.5 w-3.5 shrink-0 text-cyan-400/70" />
                    : <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-60" />}
                  <button
                    onClick={() => {
                      if (entry.kind === "directory") {
                        setCurrentDirectory(entry.path);
                        setFilter("");
                      } else if (entry.kind === "file") {
                        void openFile(entry.path);
                      }
                    }}
                    disabled={entry.kind === "symlink" || entry.kind === "other"}
                    className="min-w-0 flex-1 truncate text-left font-mono text-[12px] disabled:cursor-not-allowed disabled:opacity-40"
                    title={entry.kind === "symlink" ? `${entry.path} · symbolic links are blocked` : entry.path}
                  >
                    {entry.name}
                  </button>
                  {(entry.kind === "file" || entry.kind === "directory") && (
                    <div className="flex opacity-0 transition group-hover:opacity-100">
                      <button onClick={() => void renameEntry(entry)} title="Rename" className="rounded p-1 hover:bg-white/10 hover:text-cyan-300">
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button onClick={() => void deleteEntry(entry)} title="Delete permanently" className="rounded p-1 hover:bg-white/10 hover:text-rose-400">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {!loading && visibleEntries.length === 0 && (
                <p className="px-2 py-8 text-center text-[12px] text-zinc-600">
                  {filter ? "No entries match this filter." : "This directory is empty."}
                </p>
              )}
              {loading && (
                <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-zinc-600">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading native directory…
                </div>
              )}
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-white/5 bg-[#0d1017]/60 px-1">
              {openTabs.map((path) => {
                const document = documents[path];
                return (
                  <div key={path} className={`group flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-[12px] transition ${
                    activePath === path
                      ? "border-cyan-400 bg-white/[0.04] text-white"
                      : "border-transparent text-zinc-500 hover:bg-white/[0.02]"
                  }`}>
                    <button onClick={() => setActivePath(path)} className="flex items-center gap-1.5 font-mono">
                      {(document?.dirty || document?.changedOnDisk) && (
                        <span className={`h-1.5 w-1.5 rounded-full ${document.changedOnDisk ? "bg-amber-400" : "bg-cyan-400"}`} />
                      )}
                      {basename(path)}
                    </button>
                    <button onClick={() => closeTab(path)} className="opacity-0 transition group-hover:opacity-100 hover:text-rose-400" aria-label={`Close ${path}`}>
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
              {openTabs.length === 0 && <span className="px-3 py-2 text-[12px] text-zinc-600">No real file open</span>}
              <div className="ml-auto flex shrink-0 items-center gap-1 px-2">
                {activeDocument?.changedOnDisk && (
                  <button onClick={() => void reloadDocument(activePath)} title="Reload changed file from disk"
                    className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-[10.5px] text-amber-300 hover:bg-amber-500/20">
                    <RotateCcw className="h-3 w-3" /> Changed on disk
                  </button>
                )}
                <button onClick={() => activePath && void saveDocument(activePath)}
                  disabled={!activeDocument?.dirty || activeDocument?.saving}
                  title="Save real file (Ctrl/Cmd+S)"
                  className="rounded-md p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30">
                  {activeDocument?.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1">
              {activeDocument ? (
                <Editor
                  height="100%"
                  theme={theme.editor}
                  path={`devlab-workspace://${activeDocument.path}`}
                  language={languageForPath(activeDocument.path)}
                  value={activeDocument.content}
                  onChange={updateContent}
                  options={{
                    fontSize: settings.fontSize,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    minimap: { enabled: settings.density === "comfortable" },
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    cursorBlinking: "smooth",
                    padding: { top: 16 },
                    renderLineHighlight: "all",
                    tabSize: 2,
                    automaticLayout: true,
                    bracketPairColorization: { enabled: true },
                  }}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-600">
                  <HardDrive className="h-11 w-11" />
                  <p className="text-sm text-zinc-400">Select a text file from the scoped workspace.</p>
                  <p className="max-w-md text-center text-[12px] leading-relaxed">
                    Files are read and written by Rust. UTF-8 text files are limited to 2 MiB,
                    symlinks are blocked, and saves use revision checks to prevent silent overwrites.
                  </p>
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center justify-between border-t border-white/5 bg-[#0d1017]/60 px-4 py-1.5 text-[11px] text-zinc-500">
              <span className="min-w-0 truncate font-mono">{activeDocument?.path || workspace.path}</span>
              <div className="flex shrink-0 items-center gap-4">
                <span>{activeDocument ? languageForPath(activeDocument.path) : "native workspace"}</span>
                <span>{activeDocument?.content.split("\n").length ?? 0} lines</span>
                <span className={activeDocument?.dirty ? "text-amber-400" : "text-emerald-400"}>
                  <Save className="mr-1 inline h-3 w-3" />
                  {activeDocument?.saving ? "Saving…" : activeDocument?.dirty ? "Unsaved" : "On disk"}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {draftReviewOpen && selectedDraft && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm">
          <div className="flex h-[82%] w-full max-w-5xl overflow-hidden rounded-2xl border border-violet-500/25 bg-[#0b0e14] shadow-2xl shadow-black/60">
            <aside className="flex w-72 shrink-0 flex-col border-r border-white/10 bg-white/[0.02]">
              <div className="border-b border-white/10 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Sparkles className="h-4 w-4 text-violet-300" /> Generated drafts
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                  Review-only memory. These files do not exist in the workspace.
                </p>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {incomingDrafts.map((draft, index) => (
                  <button
                    key={`${draft.path}-${index}`}
                    onClick={() => setDraftIndex(index)}
                    className={`mb-1 w-full rounded-lg px-3 py-2 text-left font-mono text-[11px] transition ${
                      index === draftIndex
                        ? "bg-violet-500/15 text-violet-100"
                        : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
                    }`}
                  >
                    {draft.path}
                  </button>
                ))}
              </div>
              <div className="border-t border-white/10 p-3">
                <button
                  onClick={() => {
                    setDraftReviewOpen(false);
                    onDismissDrafts?.();
                  }}
                  className="w-full rounded-lg border border-rose-500/20 px-3 py-2 text-[11.5px] text-rose-300 hover:bg-rose-500/10"
                >
                  Dismiss all drafts
                </button>
              </div>
            </aside>
            <section className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12px] text-zinc-200">{selectedDraft.path}</div>
                  <div className="mt-0.5 text-[10.5px] text-zinc-600">{selectedDraft.language} · generated preview</div>
                </div>
                <button onClick={() => setDraftReviewOpen(false)} className="rounded-lg p-2 text-zinc-500 hover:bg-white/5 hover:text-white" aria-label="Close draft review">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-5 font-mono text-[11.5px] leading-relaxed text-zinc-300">
                {selectedDraft.content}
              </pre>
              <div className="flex items-center gap-3 border-t border-white/10 bg-amber-500/[0.04] px-4 py-3 text-[11.5px] leading-relaxed text-amber-100/75">
                <div className="min-w-0 flex-1">
                  Review this output before using it. DevLab writes it only when you explicitly apply the reviewed draft; existing files are protected by the native revision check.
                </div>
                <button
                  onClick={() => void applyDraftToWorkspace(selectedDraft)}
                  disabled={working || !workspace}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-2 text-[12px] font-semibold text-white hover:bg-violet-400 disabled:opacity-40"
                >
                  {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Apply reviewed draft
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function joinPath(parent: string, child: string): string {
  const cleanChild = child.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return parent ? `${parent}/${cleanChild}` : cleanChild;
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function directoryParts(path: string): Array<{ name: string; path: string }> {
  const parts = path.split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

function languageForPath(path: string): string {
  const name = basename(path).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : name;
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}

function errorMessage(error: unknown): string {
  if (error instanceof WorkspaceCommandError) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message;
  return "The native workspace operation failed.";
}
