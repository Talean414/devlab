import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { DiffEditor, type DiffOnMount, type MonacoDiffEditor } from "@monaco-editor/react";
import { PanelHeader } from "./AgentPanel";
import { loadSettings, getTheme } from "../lib/settings";
import { testRunnerSnapshot, type TestProfile, type TestRunnerSnapshot } from "../lib/testRunner";
import { recommendVerificationProfiles, type VerificationProfileRecommendation } from "../lib/verificationGuidance";
import { isMigrationPath } from "../lib/migrationSafety";
import { MigrationSafetyCard, type MigrationSafetySource } from "../components/MigrationSafetyCard";
import type { DraftPolicyGateSummary, ReviewedDraftApplyOutcome, VFile } from "../types";
import {
  appendSavedReviewView, buildSavedReviewViewsExport, createSavedReviewView, previewReviewViewRestore,
  restoreReviewViewAnnotations, MAX_REVIEW_VIEW_NAME_CHARS, MAX_SAVED_REVIEW_VIEWS, type SavedReviewView,
} from "../lib/reviewViews";
import {
  applyReviewedDraftToWorkspace,
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
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Copy,
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
  BookmarkPlus,
} from "lucide-react";

interface OpenDocument extends WorkspaceDocument {
  dirty: boolean;
  saving: boolean;
  changedOnDisk: boolean;
}

type DraftInspectionStatus = "loading" | "new" | "update" | "unchanged" | "unavailable" | "error";
type DiffNavigationTarget = "next" | "previous";
type ReviewedDraftAnnotationStatus = "unreviewed" | "reviewed" | "needs-changes";
type ReviewedDraftFilter = "all" | "pending" | "applied" | "reviewed" | "needs-changes";

interface ReviewedDraftAnnotation {
  status: ReviewedDraftAnnotationStatus;
  note: string;
  updatedAtMs: number;
}

interface DraftInspection {
  key: string;
  path: string;
  status: DraftInspectionStatus;
  message: string;
  added: number;
  removed: number;
  preview: string;
  truncated: boolean;
  originalContent: string;
  inspectedAtMs?: number;
  existingRevision?: string;
  existingSize?: number;
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
  draftPolicyGate = null,
  onDismissDrafts,
  onDirtyChange,
  onDraftApplied,
}: {
  incomingDrafts?: VFile[];
  draftPolicyGate?: DraftPolicyGateSummary | null;
  onDismissDrafts?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onDraftApplied?: (outcome: ReviewedDraftApplyOutcome) => void;
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
  const [draftReviewFilter, setDraftReviewFilter] = useState<ReviewedDraftFilter>("all");
  const [draftIndex, setDraftIndex] = useState(0);
  const [draftInspection, setDraftInspection] = useState<DraftInspection | null>(null);
  const [appliedDraftKeys, setAppliedDraftKeys] = useState<string[]>([]);
  const [appliedDraftRecords, setAppliedDraftRecords] = useState<Record<string, ReviewedDraftApplicationRecord>>({});
  const [draftReviewAnnotations, setDraftReviewAnnotations] = useState<Record<string, ReviewedDraftAnnotation>>({});
  // Session-only named snapshots of review filter + annotations + selection for the current queue.
  const [savedReviewViews, setSavedReviewViews] = useState<SavedReviewView<ReviewedDraftFilter>[]>([]);
  const [reviewViewName, setReviewViewName] = useState("");
  const [reviewViewNotice, setReviewViewNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [draftReviewCopyNotice, setDraftReviewCopyNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [verificationLoading, setVerificationLoading] = useState(false);
  const [verificationPlan, setVerificationPlan] = useState<ReviewedDraftVerificationPlan | null>(null);
  const [verificationNotice, setVerificationNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [diffChangeCount, setDiffChangeCount] = useState<number | null>(null);
  const [diffNavigationNotice, setDiffNavigationNotice] = useState("");
  const [draftReviewShortcutNotice, setDraftReviewShortcutNotice] = useState("");
  const ignoredEvents = useRef(new Map<string, number>());
  const eventTimer = useRef<number | null>(null);
  const reviewedDiffEditorRef = useRef<MonacoDiffEditor | null>(null);
  const reviewedDiffUpdateRef = useRef<{ dispose: () => void } | null>(null);
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
  const selectedDraftKey = selectedDraft ? draftKey(selectedDraft, draftIndex) : "";
  const selectedDraftApplied = selectedDraftKey ? appliedDraftKeys.includes(selectedDraftKey) : false;
  const draftReviewSummary = useMemo(
    () => summarizeReviewedDrafts(incomingDrafts, appliedDraftKeys, appliedDraftRecords, draftReviewAnnotations),
    [incomingDrafts, appliedDraftKeys, appliedDraftRecords, draftReviewAnnotations],
  );
  const draftReviewFilterOptions = useMemo(
    () => buildReviewedDraftFilterOptions(draftReviewSummary),
    [draftReviewSummary],
  );
  const filteredDraftEntries = useMemo(
    () => draftReviewSummary.files.filter((file) => reviewedDraftMatchesFilter(file, draftReviewFilter)),
    [draftReviewSummary, draftReviewFilter],
  );
  const activeDraftReviewFilter = draftReviewFilterOptions.find((option) => option.value === draftReviewFilter);
  const selectedDraftMetadata = selectedDraft ? draftReviewSummary.files[draftIndex] : undefined;
  const selectedDraftApplication = selectedDraftKey ? appliedDraftRecords[selectedDraftKey] : undefined;
  const selectedDraftAnnotation = selectedDraftKey ? draftReviewAnnotations[selectedDraftKey] : undefined;
  const selectedDraftAnnotationStatus = selectedDraftAnnotation?.status ?? "unreviewed";
  const selectedDraftAnnotationNote = selectedDraftAnnotation?.note ?? "";
  const selectedDraftApplyBlockReason = selectedDraft
    ? reviewedDraftApplyBlockReason({
      working,
      hasWorkspace: Boolean(workspace),
      applied: selectedDraftApplied,
      inspection: draftInspection?.key === selectedDraftKey ? draftInspection : null,
    })
    : "No reviewed draft is selected.";
  const selectedDraftDiffReady = Boolean(
    selectedDraft
    && draftInspection?.key === selectedDraftKey
    && draftInspection.status !== "loading"
    && draftInspection.status !== "error",
  );
  const canNavigateReviewedDiff = Boolean(
    selectedDraftDiffReady
    && (diffChangeCount === null
      ? draftInspection && (draftInspection.status === "new" || draftInspection.status === "update")
      : diffChangeCount > 0),
  );
  const reviewedDiffChangeLabel = diffChangeCount === null
    ? "Monaco changes pending"
    : `${diffChangeCount} change block${diffChangeCount === 1 ? "" : "s"}`;
  const reviewedDiffApplyStateLabel = selectedDraftApplied
    ? "Applied in this review session"
    : selectedDraftApplyBlockReason
      ? `Apply blocked · ${selectedDraftApplyBlockReason}`
      : "Pending explicit apply";

  useEffect(() => {
    if (incomingDrafts.length === 0) {
      setDraftReviewOpen(false);
      setDraftReviewFilter("all");
      setDraftIndex(0);
      setAppliedDraftKeys([]);
      setAppliedDraftRecords({});
      setDraftReviewAnnotations({});
      setSavedReviewViews([]);
      setReviewViewName("");
      setReviewViewNotice(null);
      setDraftInspection(null);
      setDraftReviewCopyNotice(null);
      setVerificationPlan(null);
      setVerificationNotice(null);
      setDiffChangeCount(null);
      setDiffNavigationNotice("");
      setDraftReviewShortcutNotice("");
      return;
    }
    setDraftReviewFilter("all");
    setDraftIndex(0);
    setAppliedDraftKeys([]);
    setAppliedDraftRecords({});
    setDraftReviewAnnotations({});
    setSavedReviewViews([]);
    setReviewViewName("");
    setReviewViewNotice(null);
    setDraftReviewCopyNotice(null);
    setVerificationPlan(null);
    setVerificationNotice(null);
    setDiffChangeCount(null);
    setDiffNavigationNotice("");
    setDraftReviewShortcutNotice("");
    setDraftReviewOpen(true);
  }, [incomingDrafts]);

  useEffect(() => {
    if (!draftReviewOpen || incomingDrafts.length === 0 || filteredDraftEntries.length === 0) return;
    if (filteredDraftEntries.some((file) => file.index === draftIndex)) return;
    setDraftIndex(filteredDraftEntries[0].index);
  }, [draftReviewOpen, incomingDrafts.length, filteredDraftEntries, draftIndex]);

  const refreshReviewedDiffChangeCount = useCallback((editor = reviewedDiffEditorRef.current) => {
    if (!editor) {
      setDiffChangeCount(null);
      return;
    }
    const lineChanges = editor.getLineChanges();
    setDiffChangeCount(lineChanges ? lineChanges.length : null);
  }, []);

  const handleReviewedDiffMount = useCallback<DiffOnMount>((editor) => {
    reviewedDiffEditorRef.current = editor;
    reviewedDiffUpdateRef.current?.dispose();
    reviewedDiffUpdateRef.current = editor.onDidUpdateDiff(() => refreshReviewedDiffChangeCount(editor));
    refreshReviewedDiffChangeCount(editor);
  }, [refreshReviewedDiffChangeCount]);

  const navigateReviewedDiffChange = useCallback((target: DiffNavigationTarget): boolean => {
    const editor = reviewedDiffEditorRef.current;
    if (!editor) {
      setDiffNavigationNotice("Diff navigation is still initializing. The reviewed draft remains read-only.");
      return false;
    }
    const lineChanges = editor.getLineChanges();
    if (lineChanges) setDiffChangeCount(lineChanges.length);
    if (lineChanges && lineChanges.length === 0) {
      setDiffNavigationNotice("No Monaco change blocks are available for this reviewed draft.");
      return false;
    }
    editor.goToDiff(target);
    setDiffNavigationNotice(`${target === "next" ? "Next" : "Previous"} change selected in the read-only diff. Apply still requires the explicit reviewed-draft button.`);
    return true;
  }, []);

  const moveSelectedDraftInFilteredQueue = useCallback((direction: DiffNavigationTarget) => {
    if (filteredDraftEntries.length === 0) {
      setDraftReviewShortcutNotice("No reviewed drafts match the current filter. Change filters to continue reviewing.");
      return;
    }
    const currentPosition = filteredDraftEntries.findIndex((file) => file.index === draftIndex);
    const nextPosition = currentPosition >= 0
      ? (currentPosition + (direction === "next" ? 1 : -1) + filteredDraftEntries.length) % filteredDraftEntries.length
      : 0;
    const nextDraft = filteredDraftEntries[nextPosition];
    if (!nextDraft) return;
    setDraftIndex(nextDraft.index);
    setDraftReviewShortcutNotice(`${direction === "next" ? "Next" : "Previous"} reviewed draft selected in the ${activeDraftReviewFilter?.label ?? "current"} filter. Apply still requires the explicit reviewed-draft button.`);
  }, [activeDraftReviewFilter?.label, draftIndex, filteredDraftEntries]);

  useEffect(() => {
    if (!draftReviewOpen) return;
    function handleReviewedDraftShortcuts(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey || isReviewShortcutTextEntryTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        const moved = navigateReviewedDiffChange("next");
        setDraftReviewShortcutNotice(moved
          ? "Keyboard shortcut Alt+N moved to the next read-only diff change. Apply still requires the explicit reviewed-draft button."
          : "Keyboard shortcut Alt+N requested the next read-only diff change. See the diff notice above; apply still requires the explicit reviewed-draft button.");
      } else if (key === "p") {
        event.preventDefault();
        const moved = navigateReviewedDiffChange("previous");
        setDraftReviewShortcutNotice(moved
          ? "Keyboard shortcut Alt+P moved to the previous read-only diff change. Apply still requires the explicit reviewed-draft button."
          : "Keyboard shortcut Alt+P requested the previous read-only diff change. See the diff notice above; apply still requires the explicit reviewed-draft button.");
      } else if (key === "j") {
        event.preventDefault();
        moveSelectedDraftInFilteredQueue("next");
      } else if (key === "k") {
        event.preventDefault();
        moveSelectedDraftInFilteredQueue("previous");
      }
    }
    window.addEventListener("keydown", handleReviewedDraftShortcuts);
    return () => window.removeEventListener("keydown", handleReviewedDraftShortcuts);
  }, [draftReviewOpen, moveSelectedDraftInFilteredQueue, navigateReviewedDiffChange]);

  useEffect(() => {
    setDiffChangeCount(null);
    setDiffNavigationNotice("");
    setDraftReviewShortcutNotice("");
  }, [selectedDraftKey]);

  useEffect(() => () => {
    reviewedDiffUpdateRef.current?.dispose();
    reviewedDiffUpdateRef.current = null;
    reviewedDiffEditorRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!draftReviewOpen || !selectedDraft) {
      setDraftInspection(null);
      return;
    }

    const key = draftKey(selectedDraft, draftIndex);
    const path = normalizeDraftPath(selectedDraft.path);
    if (!path) {
      setDraftInspection({
        key,
        path: selectedDraft.path,
        status: "error",
        message: "This generated draft does not have a valid workspace-relative path.",
        added: 0,
        removed: 0,
        preview: "",
        truncated: false,
        originalContent: "",
        inspectedAtMs: Date.now(),
      });
      return;
    }
    if (!workspace) {
      setDraftInspection({
        key,
        path,
        status: "unavailable",
        message: "Select a workspace to compare this generated draft against files on disk.",
        added: countLines(selectedDraft.content),
        removed: 0,
        preview: buildDraftDiff(null, selectedDraft.content).preview,
        truncated: false,
        originalContent: "",
        inspectedAtMs: Date.now(),
      });
      return;
    }

    setDraftInspection({
      key,
      path,
      status: "loading",
      message: "Comparing generated draft with the selected workspace…",
      added: 0,
      removed: 0,
      preview: "",
      truncated: false,
      originalContent: "",
    });

    readWorkspaceFile(path)
      .then((existing) => {
        if (cancelled) return;
        const diff = buildDraftDiff(existing.content, selectedDraft.content);
        setDraftInspection({
          key,
          path,
          status: diff.added === 0 && diff.removed === 0 ? "unchanged" : "update",
          message: diff.added === 0 && diff.removed === 0
            ? "The generated draft matches the workspace file exactly. Applying it would not change the file."
            : "This generated draft updates an existing workspace file. The native revision check still runs when you apply it.",
          added: diff.added,
          removed: diff.removed,
          preview: diff.preview,
          truncated: diff.truncated,
          originalContent: existing.content,
          inspectedAtMs: Date.now(),
          existingRevision: existing.revision,
          existingSize: existing.size,
        });
      })
      .catch((commandError) => {
        if (cancelled) return;
        if (isMissingWorkspaceFile(commandError)) {
          const diff = buildDraftDiff(null, selectedDraft.content);
          setDraftInspection({
            key,
            path,
            status: "new",
            message: "This generated draft creates a new workspace file. Missing parent directories are created only by the reviewed-draft apply path.",
            added: diff.added,
            removed: 0,
            preview: diff.preview,
            truncated: diff.truncated,
            originalContent: "",
            inspectedAtMs: Date.now(),
          });
          return;
        }
        setDraftInspection({
          key,
          path,
          status: "error",
          message: `Could not compare with the workspace file: ${errorMessage(commandError)}`,
          added: 0,
          removed: 0,
          preview: "",
          truncated: false,
          originalContent: "",
          inspectedAtMs: Date.now(),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [draftReviewOpen, selectedDraft, draftIndex, workspace, refreshVersion]);

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
      let action: "Created" | "Updated" = "Created";
      try {
        saved = await applyReviewedDraftToWorkspace(path, draft.content, null);
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
        saved = await applyReviewedDraftToWorkspace(path, draft.content, existing.revision);
        action = "Updated";
      }

      setDocuments((current) => ({
        ...current,
        [path]: { ...saved, dirty: false, saving: false, changedOnDisk: false },
      }));
      setOpenTabs((tabs) => [...tabs.filter((tab) => tab !== path), path]);
      setActivePath(path);
      setCurrentDirectory(parentPath(path));
      setRefreshVersion((version) => version + 1);
      const appliedKey = draftKey(draft, draftIndex);
      const appliedRecord = buildReviewedDraftApplicationRecord(draft, draftIndex, appliedKey, action, saved);
      const nextAppliedKeys = appliedDraftKeys.includes(appliedKey)
        ? appliedDraftKeys
        : [...appliedDraftKeys, appliedKey];
      setAppliedDraftKeys(nextAppliedKeys);
      setAppliedDraftRecords((current) => ({ ...current, [appliedKey]: appliedRecord }));
      // Metadata-only outcome for the session apply ledger shared with Project Builder; no contents are passed.
      onDraftApplied?.({
        path: appliedRecord.path,
        action: appliedRecord.action,
        appliedAtMs: appliedRecord.appliedAtMs,
        bytes: appliedRecord.bytes,
        lines: appliedRecord.lines,
        revision: appliedRecord.revision,
        size: appliedRecord.size,
      });
      setVerificationPlan(null);
      setVerificationNotice(null);
      const nextDraftIndex = nextUnappliedDraftIndex(incomingDrafts, nextAppliedKeys, draftIndex);
      if (nextDraftIndex >= 0) setDraftIndex(nextDraftIndex);
      else setDraftReviewOpen(false);
      setNotice(`${action} ${path} from a reviewed draft. This action was recorded in the native agent audit log.`);
    } catch (commandError) {
      ignoredEvents.current.delete(path);
      setError(errorMessage(commandError));
    } finally {
      setWorking(false);
    }
  }

  async function copyReviewedDraftSummary() {
    setDraftReviewCopyNotice(null);
    if (incomingDrafts.length === 0) {
      setDraftReviewCopyNotice({ kind: "error", text: "No reviewed-draft metadata is available to copy." });
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setDraftReviewCopyNotice({ kind: "error", text: "Clipboard access is unavailable in this environment. Nothing was copied." });
      return;
    }
    try {
      await navigator.clipboard.writeText(buildReviewedDraftSummaryExport(incomingDrafts, appliedDraftKeys, appliedDraftRecords, draftReviewAnnotations));
      const copyMessage = `Copied metadata for ${incomingDrafts.length} reviewed draft${incomingDrafts.length === 1 ? "" : "s"}.`;
      setDraftReviewCopyNotice({ kind: "ok", text: copyMessage });
      setNotice(copyMessage);
    } catch (commandError) {
      const copyError = `Could not copy reviewed-draft metadata: ${errorMessage(commandError)}`;
      setDraftReviewCopyNotice({ kind: "error", text: copyError });
      setError(copyError);
    }
  }

  async function refreshVerificationPlan() {
    setVerificationLoading(true);
    setVerificationNotice(null);
    setError("");
    try {
      const snapshot = await testRunnerSnapshot();
      const plan = buildReviewedDraftVerificationPlan(incomingDrafts, appliedDraftKeys, appliedDraftRecords, draftReviewAnnotations, snapshot);
      setVerificationPlan(plan);
      setVerificationNotice({
        kind: "ok",
        text: `Discovered ${snapshot.profiles.length} backend-owned verification profile${snapshot.profiles.length === 1 ? "" : "s"}. Nothing was executed.`,
      });
    } catch (commandError) {
      const plan = buildReviewedDraftVerificationPlan(incomingDrafts, appliedDraftKeys, appliedDraftRecords, draftReviewAnnotations, null, errorMessage(commandError));
      setVerificationPlan(plan);
      setVerificationNotice({
        kind: "error",
        text: "Could not discover native test profiles. A metadata-only draft verification checklist is still available.",
      });
    } finally {
      setVerificationLoading(false);
    }
  }

  async function copyVerificationPlan() {
    const plan = verificationPlan ?? buildReviewedDraftVerificationPlan(incomingDrafts, appliedDraftKeys, appliedDraftRecords, draftReviewAnnotations, null);
    setVerificationNotice(null);
    if (!navigator.clipboard?.writeText) {
      setVerificationNotice({ kind: "error", text: "Clipboard access is unavailable in this environment. Nothing was copied." });
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(plan, null, 2));
      setVerificationNotice({ kind: "ok", text: "Copied reviewed-draft verification metadata. Nothing was executed." });
    } catch (commandError) {
      setVerificationNotice({ kind: "error", text: `Could not copy verification metadata: ${errorMessage(commandError)}` });
    }
  }

  const reviewQueueKeys = useMemo(() => incomingDrafts.map((draft, index) => draftKey(draft, index)), [incomingDrafts]);

  // SQL migration drafts get a lexical safety review before apply (pure, nothing executed).
  const migrationSafetySources = useMemo<MigrationSafetySource[]>(() => {
    const dialectHint = incomingDrafts.find((draft) => /(^|\/)schema\.prisma$/.test(draft.path))?.content;
    return incomingDrafts
      .filter((draft) => draft.language === "sql" || isMigrationPath(draft.path))
      .filter((draft) => /\.sql$/i.test(draft.path) || draft.language === "sql")
      .map((draft) => ({ label: draft.path, sql: draft.content, dialectHint }));
  }, [incomingDrafts]);

  function saveCurrentReviewView() {
    if (incomingDrafts.length === 0) return;
    if (savedReviewViews.length >= MAX_SAVED_REVIEW_VIEWS) {
      setReviewViewNotice({ kind: "error", text: `Saved view limit reached (${MAX_SAVED_REVIEW_VIEWS}). Delete a view before saving another.` });
      return;
    }
    const view = createSavedReviewView<ReviewedDraftFilter>(
      { name: reviewViewName, filter: draftReviewFilter, selectedKey: selectedDraftKey, annotations: draftReviewAnnotations, queueKeys: reviewQueueKeys },
      savedReviewViews,
    );
    setSavedReviewViews((current) => appendSavedReviewView(current, view));
    setReviewViewName("");
    setReviewViewNotice({ kind: "ok", text: `Saved review view "${view.name}" (${view.filter} filter, ${view.counts.annotated} annotation${view.counts.annotated === 1 ? "" : "s"}). Session-only; nothing was written.` });
  }

  function restoreReviewView(viewId: string) {
    const view = savedReviewViews.find((item) => item.id === viewId);
    if (!view) return;
    const preview = previewReviewViewRestore(view, draftReviewAnnotations, reviewQueueKeys);
    if (preview.overwritten > 0 && !window.confirm(`Restore "${view.name}"? ${preview.summary}. This changes review-only UI state; it does not write files or apply drafts.`)) return;
    setDraftReviewFilter(view.filter);
    setDraftReviewAnnotations(restoreReviewViewAnnotations(view, reviewQueueKeys) as Record<string, ReviewedDraftAnnotation>);
    if (preview.selectedStillPresent) {
      const index = reviewQueueKeys.indexOf(view.selectedKey);
      if (index >= 0) setDraftIndex(index);
    }
    setReviewViewNotice({ kind: "ok", text: `Restored "${view.name}": ${preview.summary}. Apply still requires the explicit reviewed-draft button.` });
  }

  function deleteReviewView(viewId: string) {
    const view = savedReviewViews.find((item) => item.id === viewId);
    setSavedReviewViews((current) => current.filter((item) => item.id !== viewId));
    if (view) setReviewViewNotice({ kind: "ok", text: `Deleted saved view "${view.name}". Current annotations are unchanged.` });
  }

  async function copySavedReviewViews() {
    setReviewViewNotice(null);
    if (!navigator.clipboard?.writeText) {
      setReviewViewNotice({ kind: "error", text: "Clipboard access is unavailable in this environment. Nothing was copied." });
      return;
    }
    try {
      const pathForKey = (key: string) => {
        const index = reviewQueueKeys.indexOf(key);
        return index >= 0 ? incomingDrafts[index]?.path : undefined;
      };
      await navigator.clipboard.writeText(buildSavedReviewViewsExport(savedReviewViews, pathForKey));
      setReviewViewNotice({ kind: "ok", text: `Copied ${savedReviewViews.length} saved review view${savedReviewViews.length === 1 ? "" : "s"} as review-only metadata.` });
    } catch (copyError) {
      setReviewViewNotice({ kind: "error", text: errorMessage(copyError) });
    }
  }

  function updateSelectedDraftAnnotationStatus(status: Exclude<ReviewedDraftAnnotationStatus, "unreviewed">) {
    if (!selectedDraftKey) return;
    const updatedAtMs = Date.now();
    setDraftReviewAnnotations((current) => ({
      ...current,
      [selectedDraftKey]: {
        status,
        note: current[selectedDraftKey]?.note ?? "",
        updatedAtMs,
      },
    }));
    setDraftReviewCopyNotice(null);
  }

  function updateSelectedDraftAnnotationNote(note: string) {
    if (!selectedDraftKey) return;
    const boundedNote = note.slice(0, MAX_REVIEW_NOTE_CHARS);
    const updatedAtMs = Date.now();
    setDraftReviewAnnotations((current) => {
      const existing = current[selectedDraftKey];
      if (!boundedNote && (!existing || existing.status === "unreviewed")) {
        const next = { ...current };
        delete next[selectedDraftKey];
        return next;
      }
      return {
        ...current,
        [selectedDraftKey]: {
          status: existing?.status ?? "unreviewed",
          note: boundedNote,
          updatedAtMs,
        },
      };
    });
    setDraftReviewCopyNotice(null);
  }

  function clearSelectedDraftAnnotation() {
    if (!selectedDraftKey) return;
    setDraftReviewAnnotations((current) => {
      if (!current[selectedDraftKey]) return current;
      const next = { ...current };
      delete next[selectedDraftKey];
      return next;
    });
    setDraftReviewCopyNotice(null);
  }

  function recompareSelectedDraft() {
    if (!selectedDraft) return;
    setDraftInspection(null);
    setNotice(`Rechecking ${selectedDraft.path} against the selected workspace before apply.`);
    setRefreshVersion((version) => version + 1);
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
            {incomingDrafts.length} generated {incomingDrafts.length === 1 ? "draft is" : "drafts are"} ready for review · {draftReviewSummary.appliedCount} applied / {draftReviewSummary.pendingCount} pending · {formatBytes(draftReviewSummary.totalBytes)} metadata{draftReviewSummary.lastAppliedAtMs ? ` · last applied ${formatReviewTime(draftReviewSummary.lastAppliedAtMs)}` : ""}. Nothing was written automatically.
          </span>
          <button onClick={() => void copyReviewedDraftSummary()} className="rounded-md border border-violet-400/20 px-2.5 py-1 font-medium text-violet-200 hover:bg-violet-500/15">
            Copy summary
          </button>
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
                  Review-only memory. {draftReviewSummary.appliedCount} applied / {draftReviewSummary.pendingCount} pending · {draftReviewSummary.annotationCounts.reviewedCount} reviewed · {draftReviewSummary.annotationCounts.needsChangesCount} needs changes. Draft contents are copied only into the Editor preview, never the metadata summary.
                </p>
                <button
                  onClick={() => void copyReviewedDraftSummary()}
                  className="mt-3 w-full rounded-lg border border-white/10 px-3 py-2 text-[11.5px] text-violet-200 hover:bg-white/5"
                >
                  Copy metadata summary
                </button>
                {draftReviewCopyNotice && (
                  <div className={`mt-2 text-[10.5px] ${draftReviewCopyNotice.kind === "ok" ? "text-emerald-300" : "text-rose-300"}`}>
                    {draftReviewCopyNotice.text}
                  </div>
                )}
                <div className="mt-3 rounded-xl border border-white/10 bg-black/15 p-3 text-[11px] text-zinc-400">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-zinc-200">Review queue filter</span>
                    <span className="font-mono text-[10px] text-zinc-600">{activeDraftReviewFilter?.count ?? 0} shown</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {draftReviewFilterOptions.map((option) => {
                      const active = option.value === draftReviewFilter;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setDraftReviewFilter(option.value)}
                          className={`rounded-full border px-2 py-1 text-[10px] font-semibold transition ${active ? "border-violet-400/40 bg-violet-400/15 text-violet-100" : "border-white/10 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"}`}
                        >
                          {option.label} <span className="font-mono opacity-70">{option.count}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
                    Filters are session-only UI state. They hide or show draft rows for review but do not change generated content, write files, run commands or alter apply requirements.
                  </p>
                  <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.025] px-2 py-1.5 text-[10px] leading-relaxed text-zinc-500">
                    Keyboard shortcuts: <span className="font-mono text-zinc-300">Alt+N/P</span> move between read-only diff changes; <span className="font-mono text-zinc-300">Alt+J/K</span> move through visible drafts in this filter. Shortcuts are ignored while typing notes and never apply files.
                  </div>
                  {draftReviewShortcutNotice && (
                    <div className="mt-2 text-[10px] leading-relaxed text-violet-200/75">
                      {draftReviewShortcutNotice}
                    </div>
                  )}
                  <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 font-semibold text-zinc-200"><BookmarkPlus className="h-3.5 w-3.5 text-violet-300" /> Saved review views</span>
                      <span className="font-mono text-[10px] text-zinc-600">{savedReviewViews.length}/{MAX_SAVED_REVIEW_VIEWS}</span>
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">
                      Name and save the current filter, session annotations and selected draft for this queue, then restore later. Views are session-only, dropped when the queue is replaced, never persisted, and never write files or apply drafts.
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <input
                        value={reviewViewName}
                        onChange={(event) => setReviewViewName(event.currentTarget.value)}
                        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveCurrentReviewView(); } }}
                        maxLength={MAX_REVIEW_VIEW_NAME_CHARS}
                        placeholder="View name (e.g. needs-changes pass 1)"
                        className="min-w-[160px] flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[10.5px] text-zinc-200 placeholder:text-zinc-600 focus:border-violet-400/40 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={saveCurrentReviewView}
                        disabled={incomingDrafts.length === 0 || savedReviewViews.length >= MAX_SAVED_REVIEW_VIEWS}
                        className="rounded-md border border-violet-400/30 bg-violet-400/10 px-2 py-1 text-[10px] font-semibold text-violet-100 hover:bg-violet-400/20 disabled:opacity-40"
                      >
                        Save view
                      </button>
                      <button
                        type="button"
                        onClick={() => { void copySavedReviewViews(); }}
                        disabled={savedReviewViews.length === 0}
                        className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[10px] font-semibold text-zinc-300 hover:bg-white/5 disabled:opacity-40"
                      >
                        <Copy className="h-3 w-3" /> Copy views
                      </button>
                    </div>
                    {savedReviewViews.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {savedReviewViews.map((view) => {
                          const preview = previewReviewViewRestore(view, draftReviewAnnotations, reviewQueueKeys);
                          return (
                            <li key={view.id} className="rounded-md border border-white/10 bg-black/20 px-2 py-1.5">
                              <div className="flex flex-wrap items-center justify-between gap-1.5">
                                <span className="font-semibold text-zinc-200">{view.name}</span>
                                <span className="font-mono text-[9.5px] text-zinc-600">{formatReviewTime(view.savedAtMs)} · {view.filter} · {view.counts.annotated} annotated</span>
                              </div>
                              <div className="mt-0.5 text-[9.5px] text-zinc-500" title={preview.summary}>Restore would: {preview.summary}</div>
                              <div className="mt-1 flex gap-1.5">
                                <button type="button" onClick={() => restoreReviewView(view.id)} className="rounded border border-violet-400/30 px-1.5 py-0.5 text-[9.5px] font-semibold text-violet-100 hover:bg-violet-400/15">Restore</button>
                                <button type="button" onClick={() => deleteReviewView(view.id)} className="rounded border border-white/10 px-1.5 py-0.5 text-[9.5px] font-semibold text-zinc-400 hover:bg-white/5">Delete</button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {reviewViewNotice && (
                      <div className={`mt-2 text-[10px] leading-relaxed ${reviewViewNotice.kind === "ok" ? "text-emerald-300" : "text-rose-300"}`}>{reviewViewNotice.text}</div>
                    )}
                  </div>
                </div>
                {draftPolicyGate && (
                  <div className={`mt-3 rounded-xl border p-3 text-[11px] ${draftPolicyGate.refused.length > 0 ? "border-amber-500/25 bg-amber-500/[0.05] text-amber-100/80" : "border-white/10 bg-white/[0.02] text-zinc-400"}`}>
                    <div className="font-semibold">Draft path policy · {draftPolicyGate.summary}</div>
                    {draftPolicyGate.refused.length > 0 && (
                      <ul className="mt-1 space-y-0.5 font-mono text-[10.5px]">
                        {draftPolicyGate.refused.slice(0, 8).map((item) => <li key={`${item.path}-${item.kind}`}>refused · {item.kind} · {item.path}</li>)}
                      </ul>
                    )}
                    <div className="mt-1 text-[10px] opacity-70">Refused paths were dropped before staging and are not in this queue. Policy is path-only and editable in Settings → Agent.</div>
                  </div>
                )}
                <div className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-3 text-[11px] text-emerald-100/75">
                  <div className="flex items-center gap-2 font-semibold text-emerald-100">
                    <ClipboardList className="h-3.5 w-3.5 text-emerald-300" /> Verification guidance
                  </div>
                  <p className="mt-1 leading-relaxed text-emerald-100/60">
                    Discover backend-owned test profiles for after reviewed apply. DevLab does not run them from this panel.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => { void refreshVerificationPlan(); }}
                      disabled={verificationLoading}
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-emerald-400/25 px-2 py-1.5 text-[10.5px] font-semibold text-emerald-100 hover:bg-emerald-400/10 disabled:opacity-40"
                    >
                      {verificationLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      Refresh
                    </button>
                    <button
                      onClick={() => { void copyVerificationPlan(); }}
                      className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/10 px-2 py-1.5 text-[10.5px] font-semibold text-emerald-100 hover:bg-white/5"
                    >
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                  </div>
                  {verificationPlan && (
                    <div className="mt-2 space-y-1.5">
                      <div className="rounded-lg border border-white/10 bg-black/15 px-2 py-1.5">
                        {verificationPlan.recommendedProfiles.length > 0
                          ? `${verificationPlan.recommendedProfiles.length} recommended profile${verificationPlan.recommendedProfiles.length === 1 ? "" : "s"}`
                          : "No detected profile recommendation yet"}
                        {verificationPlan.unavailableReason ? " · discovery unavailable" : ""}
                      </div>
                      {verificationPlan.recommendedProfiles.slice(0, 3).map((profile) => (
                        <div key={profile.id} className="truncate rounded-md bg-black/20 px-2 py-1 font-mono text-[10px] text-emerald-100/65" title={profile.command}>
                          {profile.command}
                        </div>
                      ))}
                    </div>
                  )}
                  {verificationNotice && (
                    <div className={`mt-2 text-[10.5px] ${verificationNotice.kind === "ok" ? "text-emerald-300" : "text-amber-300"}`}>
                      {verificationNotice.text}
                    </div>
                  )}
                </div>
                {migrationSafetySources.length > 0 && (
                  <div className="mt-3">
                    <MigrationSafetyCard sources={migrationSafetySources} compact />
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {filteredDraftEntries.map((file) => {
                  const draft = incomingDrafts[file.index];
                  if (!draft) return null;
                  const key = draftKey(draft, file.index);
                  const annotationStatus = file.reviewStatus;
                  const title = file.application
                    ? `${file.application.action} ${file.application.path} at ${formatReviewTime(file.application.appliedAtMs)}`
                    : `Pending reviewed draft · ${draftReviewAnnotationStatusLabel(annotationStatus)}`;
                  return (
                    <button
                      key={key}
                      onClick={() => setDraftIndex(file.index)}
                      title={title}
                      className={`mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left font-mono text-[11px] transition ${
                        file.index === draftIndex
                          ? "bg-violet-500/15 text-violet-100"
                          : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{draft.path}</span>
                      {annotationStatus !== "unreviewed" && (
                        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] ${draftReviewAnnotationPillClass(annotationStatus)}`}>
                          {draftReviewAnnotationShortLabel(annotationStatus)}
                        </span>
                      )}
                      {file.applied && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
                    </button>
                  );
                })}
                {filteredDraftEntries.length === 0 && (
                  <div className="rounded-xl border border-white/10 bg-black/15 px-3 py-6 text-center text-[11px] leading-relaxed text-zinc-600">
                    No reviewed drafts match the {activeDraftReviewFilter?.label.toLowerCase() ?? "selected"} filter. Change filters to continue reviewing the full in-memory draft set.
                  </div>
                )}
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
                  <div className="mt-0.5 text-[10.5px] text-zinc-600">
                    {draftInspection?.key === selectedDraftKey ? draftStatusLabel(draftInspection) : "Inspecting draft…"} · {selectedDraft.language} · {selectedDraftMetadata ? `${formatBytes(selectedDraftMetadata.bytes)} · ${selectedDraftMetadata.lines} line${selectedDraftMetadata.lines === 1 ? "" : "s"}` : "metadata pending"} · {draftReviewAnnotationStatusLabel(selectedDraftAnnotationStatus)}{selectedDraftApplication ? ` · ${selectedDraftApplication.action} ${formatReviewTime(selectedDraftApplication.appliedAtMs)}` : ""}
                  </div>
                </div>
                <button
                  onClick={recompareSelectedDraft}
                  disabled={working || !workspace || !selectedDraft}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-400 hover:bg-white/5 hover:text-zinc-100 disabled:opacity-40"
                >
                  <RefreshCw className="h-3 w-3" />
                  Recompare
                </button>
                <button onClick={() => setDraftReviewOpen(false)} className="rounded-lg p-2 text-zinc-500 hover:bg-white/5 hover:text-white" aria-label="Close draft review">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className={`border-b border-white/10 px-4 py-3 ${draftStatusClass(draftInspection?.status)}`}>
                <div className="flex items-start justify-between gap-3 text-[11.5px] leading-relaxed">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-zinc-100">Workspace diff review</div>
                    <div className="mt-0.5 text-zinc-300/80">
                      {draftInspection?.key === selectedDraftKey ? draftInspection.message : "Inspecting this generated draft before it can be applied…"}
                    </div>
                    {draftInspection?.existingRevision && (
                      <div className="mt-1 font-mono text-[10.5px] text-zinc-500">
                        Existing revision {draftInspection.existingRevision.slice(0, 12)} · {draftInspection.existingSize} bytes
                      </div>
                    )}
                    {draftInspection?.key === selectedDraftKey && draftInspection.inspectedAtMs && (
                      <div className="mt-1 font-mono text-[10.5px] text-zinc-500">
                        Compared {formatReviewTime(draftInspection.inspectedAtMs)}. Use Recompare if the workspace changed before applying.
                      </div>
                    )}
                  </div>
                  {draftInspection?.key === selectedDraftKey && draftInspection.status !== "loading" && (
                    <div className="shrink-0 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1 font-mono text-[11px] text-zinc-200">
                      +{draftInspection.added} / -{draftInspection.removed}
                    </div>
                  )}
                </div>
                {draftInspection?.key === selectedDraftKey && draftInspection.status !== "loading" && draftInspection.status !== "error" && (
                  <div className="mt-3 overflow-hidden rounded-xl border border-white/10 bg-black/25">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3 py-2 text-[10.5px] text-zinc-500">
                      <div className="min-w-0">
                        <div>Inline Monaco diff · original workspace content on the left, reviewed draft on the right</div>
                        <div className="mt-0.5 font-mono text-[10px] text-zinc-600">
                          {reviewedDiffChangeLabel} · {reviewedDiffApplyStateLabel} · {draftReviewAnnotationStatusLabel(selectedDraftAnnotationStatus)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 font-mono text-[10px] text-emerald-200">read-only</span>
                        <button
                          type="button"
                          onClick={() => navigateReviewedDiffChange("previous")}
                          disabled={!canNavigateReviewedDiff}
                          className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[10px] font-semibold text-zinc-400 hover:bg-white/5 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                          title="Jump to the previous Monaco diff change block"
                        >
                          <ArrowUp className="h-3 w-3" />
                          Previous
                        </button>
                        <button
                          type="button"
                          onClick={() => navigateReviewedDiffChange("next")}
                          disabled={!canNavigateReviewedDiff}
                          className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[10px] font-semibold text-zinc-400 hover:bg-white/5 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                          title="Jump to the next Monaco diff change block"
                        >
                          <ArrowDown className="h-3 w-3" />
                          Next
                        </button>
                      </div>
                    </div>
                    {diffNavigationNotice && (
                      <div className="border-b border-white/10 bg-black/20 px-3 py-2 text-[10.5px] text-zinc-500">
                        {diffNavigationNotice}
                      </div>
                    )}
                    <div className="h-72 min-h-0">
                      <DiffEditor
                        original={draftInspection.originalContent}
                        modified={selectedDraft.content}
                        language={selectedDraft.language || languageForDraftPath(selectedDraft.path)}
                        originalLanguage={languageForDraftPath(selectedDraft.path)}
                        modifiedLanguage={selectedDraft.language || languageForDraftPath(selectedDraft.path)}
                        theme={theme.editor}
                        originalModelPath={`devlab-reviewed-draft://original/${selectedDraftKey}`}
                        modifiedModelPath={`devlab-reviewed-draft://modified/${selectedDraftKey}`}
                        onMount={handleReviewedDiffMount}
                        options={{
                          readOnly: true,
                          originalEditable: false,
                          renderSideBySide: true,
                          automaticLayout: true,
                          scrollBeyondLastLine: false,
                          minimap: { enabled: false },
                          fontSize: Math.max(11, settings.fontSize - 1),
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          renderOverviewRuler: false,
                          wordWrap: "off",
                        }}
                      />
                    </div>
                  </div>
                )}
                {draftInspection?.preview && (
                  <details className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3 text-[11px] text-zinc-400">
                    <summary className="cursor-pointer select-none font-semibold text-zinc-300 hover:text-white">Text diff summary</summary>
                    <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono leading-relaxed text-zinc-400">
                      {draftInspection.preview}
                    </pre>
                  </details>
                )}
                {draftInspection?.truncated && (
                  <div className="mt-2 text-[10.5px] text-zinc-500">
                    Text diff summary truncated to keep review responsive. The inline Monaco diff and generated file preview remain available for review.
                  </div>
                )}
              </div>
              <div className="border-b border-white/10 bg-white/[0.015] px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-zinc-400">
                    <div className="flex items-center gap-2 font-semibold text-zinc-100">
                      <Pencil className="h-3.5 w-3.5 text-violet-300" /> Session review annotation
                    </div>
                    <div className="mt-0.5 text-[10.5px] text-zinc-500">
                      In-memory only. This does not write files, unlock apply, run commands or enter the native audit log. Notes are included only when you explicitly copy reviewed-draft metadata.
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => updateSelectedDraftAnnotationStatus("reviewed")}
                      className={`rounded-lg border px-2.5 py-1.5 text-[10.5px] font-semibold ${draftReviewAnnotationButtonClass(selectedDraftAnnotationStatus === "reviewed", "reviewed")}`}
                    >
                      Mark reviewed
                    </button>
                    <button
                      type="button"
                      onClick={() => updateSelectedDraftAnnotationStatus("needs-changes")}
                      className={`rounded-lg border px-2.5 py-1.5 text-[10.5px] font-semibold ${draftReviewAnnotationButtonClass(selectedDraftAnnotationStatus === "needs-changes", "needs-changes")}`}
                    >
                      Needs changes
                    </button>
                    <button
                      type="button"
                      onClick={clearSelectedDraftAnnotation}
                      disabled={!selectedDraftAnnotation}
                      className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[10.5px] font-semibold text-zinc-500 hover:bg-white/5 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <textarea
                  value={selectedDraftAnnotationNote}
                  onChange={(event) => updateSelectedDraftAnnotationNote(event.currentTarget.value)}
                  maxLength={MAX_REVIEW_NOTE_CHARS}
                  placeholder="Optional reviewer note for this generated draft. Kept in memory until drafts are dismissed."
                  className="mt-3 h-16 w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[11.5px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-violet-400/50"
                />
                <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-zinc-600">
                  <span>{draftReviewAnnotationStatusLabel(selectedDraftAnnotationStatus)}{selectedDraftAnnotation?.updatedAtMs ? ` · updated ${formatReviewTime(selectedDraftAnnotation.updatedAtMs)}` : ""}</span>
                  <span>{selectedDraftAnnotationNote.length}/{MAX_REVIEW_NOTE_CHARS} chars</span>
                </div>
              </div>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-5 font-mono text-[11.5px] leading-relaxed text-zinc-300">
                {selectedDraft.content}
              </pre>
              <div className="flex items-center gap-3 border-t border-white/10 bg-amber-500/[0.04] px-4 py-3 text-[11.5px] leading-relaxed text-amber-100/75">
                <div className="min-w-0 flex-1">
                  <div>
                    {selectedDraftApplied
                      ? "This draft has already been applied in this review session. Other generated drafts still require their own explicit Apply click."
                      : "Review the diff and generated output before using it. DevLab writes only when you explicitly apply this one reviewed draft; existing files are protected by the native revision check."}
                  </div>
                  <div className="mt-1 font-mono text-[10.5px] text-amber-100/50">
                    Review progress: {draftReviewSummary.appliedCount}/{draftReviewSummary.fileCount} applied · {draftReviewSummary.pendingCount} pending · metadata only in copied summaries.
                  </div>
                  {selectedDraftApplication && (
                    <div className="mt-1 font-mono text-[10.5px] text-emerald-200/70">
                      Applied ledger: {selectedDraftApplication.action} · {formatReviewTime(selectedDraftApplication.appliedAtMs)} · revision {selectedDraftApplication.revision.slice(0, 12)} · {formatBytes(selectedDraftApplication.size)}.
                    </div>
                  )}
                  {selectedDraftApplyBlockReason && !selectedDraftApplied && (
                    <div className="mt-1 text-[10.5px] text-amber-100/60">{selectedDraftApplyBlockReason}</div>
                  )}
                </div>
                <button
                  onClick={() => void applyDraftToWorkspace(selectedDraft)}
                  disabled={Boolean(selectedDraftApplyBlockReason)}
                  title={selectedDraftApplyBlockReason || "Apply this reviewed draft to the selected workspace"}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-2 text-[12px] font-semibold text-white hover:bg-violet-400 disabled:opacity-40"
                >
                  {selectedDraftApplied ? <CheckCircle2 className="h-3.5 w-3.5" /> : working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {selectedDraftApplied ? "Applied" : "Apply reviewed draft"}
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}


const MAX_DIFF_PREVIEW_LINES = 240;
const MAX_DIFF_CONTEXT_LINES = 3;
const MAX_DIFF_LINE_CHARS = 240;
const MAX_REVIEW_NOTE_CHARS = 1000;

interface ReviewedDraftApplicationRecord {
  key: string;
  index: number;
  path: string;
  language: string;
  bytes: number;
  lines: number;
  action: "Created" | "Updated";
  appliedAtMs: number;
  revision: string;
  size: number;
}

interface ReviewedDraftFilterOption {
  value: ReviewedDraftFilter;
  label: string;
  count: number;
}

interface ReviewedDraftAnnotationCounts {
  reviewedCount: number;
  needsChangesCount: number;
  annotatedCount: number;
  unreviewedCount: number;
}

interface ReviewedDraftSummaryItem {
  index: number;
  path: string;
  language: string;
  bytes: number;
  lines: number;
  applied: boolean;
  reviewStatus: ReviewedDraftAnnotationStatus;
  reviewNote?: string;
  reviewNoteChars: number;
  reviewUpdatedAtMs?: number;
  application?: ReviewedDraftApplicationRecord;
}

interface ReviewedDraftSummary {
  fileCount: number;
  appliedCount: number;
  pendingCount: number;
  totalBytes: number;
  lastAppliedAtMs?: number;
  annotationCounts: ReviewedDraftAnnotationCounts;
  files: ReviewedDraftSummaryItem[];
}

interface ReviewedDraftVerificationPlan {
  label: "DevLab reviewed-draft verification plan";
  generatedAt: string;
  note: string;
  unavailableReason?: string;
  draftSummary: ReviewedDraftSummary;
  affectedPaths: string[];
  recommendedProfiles: VerificationProfileRecommendation[];
  detectedProfiles: Array<Pick<TestProfile, "id" | "label" | "command" | "reason">>;
  warnings: string[];
  manualChecklist: string[];
}

function summarizeReviewedDrafts(
  drafts: VFile[],
  appliedKeys: string[],
  appliedRecords: Record<string, ReviewedDraftApplicationRecord>,
  annotations: Record<string, ReviewedDraftAnnotation> = {},
): ReviewedDraftSummary {
  const files = drafts.map((draft, index) => {
    const key = draftKey(draft, index);
    const annotation = annotations[key];
    const reviewNote = annotation?.note.trim() || undefined;
    return {
      index,
      path: normalizeDraftPath(draft.path) || draft.path,
      language: draft.language || languageForDraftPath(draft.path),
      bytes: textBytes(draft.content),
      lines: countLines(draft.content),
      applied: appliedKeys.includes(key),
      reviewStatus: annotation?.status ?? "unreviewed",
      reviewNote,
      reviewNoteChars: reviewNote?.length ?? 0,
      reviewUpdatedAtMs: annotation?.updatedAtMs,
      application: appliedRecords[key],
    };
  });
  const appliedCount = files.filter((file) => file.applied).length;
  const annotationCounts = summarizeReviewAnnotationCounts(files);
  const lastAppliedAtMs = files
    .map((file) => file.application?.appliedAtMs ?? 0)
    .reduce((latest, value) => Math.max(latest, value), 0) || undefined;
  return {
    fileCount: files.length,
    appliedCount,
    pendingCount: Math.max(0, files.length - appliedCount),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    lastAppliedAtMs,
    annotationCounts,
    files,
  };
}

function buildReviewedDraftFilterOptions(summary: ReviewedDraftSummary): ReviewedDraftFilterOption[] {
  return [
    { value: "all", label: "All", count: summary.fileCount },
    { value: "pending", label: "Pending", count: summary.pendingCount },
    { value: "applied", label: "Applied", count: summary.appliedCount },
    { value: "reviewed", label: "Reviewed", count: summary.annotationCounts.reviewedCount },
    { value: "needs-changes", label: "Needs changes", count: summary.annotationCounts.needsChangesCount },
  ];
}

function reviewedDraftMatchesFilter(file: ReviewedDraftSummaryItem, filter: ReviewedDraftFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "pending": return !file.applied;
    case "applied": return file.applied;
    case "reviewed": return file.reviewStatus === "reviewed";
    case "needs-changes": return file.reviewStatus === "needs-changes";
  }
}

function summarizeReviewAnnotationCounts(files: ReviewedDraftSummaryItem[]): ReviewedDraftAnnotationCounts {
  const reviewedCount = files.filter((file) => file.reviewStatus === "reviewed").length;
  const needsChangesCount = files.filter((file) => file.reviewStatus === "needs-changes").length;
  return {
    reviewedCount,
    needsChangesCount,
    annotatedCount: reviewedCount + needsChangesCount + files.filter((file) => file.reviewNoteChars > 0 && file.reviewStatus === "unreviewed").length,
    unreviewedCount: files.filter((file) => file.reviewStatus === "unreviewed" && file.reviewNoteChars === 0).length,
  };
}

function buildReviewedDraftSummaryExport(
  drafts: VFile[],
  appliedKeys: string[],
  appliedRecords: Record<string, ReviewedDraftApplicationRecord>,
  annotations: Record<string, ReviewedDraftAnnotation> = {},
): string {
  const summary = summarizeReviewedDrafts(drafts, appliedKeys, appliedRecords, annotations);
  return JSON.stringify({
    label: "DevLab reviewed-draft Editor summary",
    generatedAt: new Date().toISOString(),
    note: "Metadata only. Draft contents are omitted; workspace writes require explicit per-file Editor apply. Session review annotation notes are included only because this copy action was explicit.",
    fileCount: summary.fileCount,
    appliedCount: summary.appliedCount,
    pendingCount: summary.pendingCount,
    totalBytes: summary.totalBytes,
    lastAppliedAtMs: summary.lastAppliedAtMs,
    annotationCounts: summary.annotationCounts,
    files: summary.files,
  }, null, 2);
}

function buildReviewedDraftVerificationPlan(
  drafts: VFile[],
  appliedKeys: string[],
  appliedRecords: Record<string, ReviewedDraftApplicationRecord>,
  annotations: Record<string, ReviewedDraftAnnotation> = {},
  snapshot: TestRunnerSnapshot | null,
  unavailableReason?: string,
): ReviewedDraftVerificationPlan {
  const draftSummary = summarizeReviewedDrafts(drafts, appliedKeys, appliedRecords, annotations);
  const affectedPaths = draftSummary.files.map((file) => file.path);
  const recommendedProfiles = snapshot
    ? recommendVerificationProfiles(snapshot.profiles, affectedPaths)
    : [];
  return {
    label: "DevLab reviewed-draft verification plan",
    generatedAt: new Date().toISOString(),
    note: "Metadata only. Draft contents are omitted; session annotation notes may be included because they were typed in this review. No tests or shell commands were executed by this plan. Run backend-owned profiles explicitly from Self-Healing Tests after applying reviewed drafts.",
    ...(unavailableReason ? { unavailableReason } : {}),
    draftSummary,
    affectedPaths,
    recommendedProfiles,
    detectedProfiles: snapshot?.profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      command: profile.command,
      reason: profile.reason,
    })) ?? [],
    warnings: snapshot?.warnings ?? [],
    manualChecklist: [
      "Apply only the reviewed drafts you approve in the Editor.",
      "Recompare existing files before applying if the workspace changed.",
      "Open Self-Healing Tests and run the recommended backend-owned profile explicitly.",
      "Inspect stdout/stderr and generate a repair draft only from a real failing run if needed.",
      "Do not treat this manifest as proof that verification has run.",
    ],
  };
}

function buildReviewedDraftApplicationRecord(
  draft: VFile,
  index: number,
  key: string,
  action: "Created" | "Updated",
  saved: WorkspaceDocument,
): ReviewedDraftApplicationRecord {
  return {
    key,
    index,
    path: normalizeDraftPath(draft.path) || draft.path,
    language: draft.language || languageForDraftPath(draft.path),
    bytes: textBytes(draft.content),
    lines: countLines(draft.content),
    action,
    appliedAtMs: Date.now(),
    revision: saved.revision,
    size: saved.size,
  };
}

function textBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function languageForDraftPath(path: string): string {
  return LANGUAGE_BY_EXTENSION[path.toLowerCase().split(".").pop() ?? ""] ?? "plaintext";
}

function reviewedDraftApplyBlockReason({
  working,
  hasWorkspace,
  applied,
  inspection,
}: {
  working: boolean;
  hasWorkspace: boolean;
  applied: boolean;
  inspection: DraftInspection | null;
}): string {
  if (working) return "Another workspace operation is still running.";
  if (!hasWorkspace) return "Select a workspace before applying reviewed drafts.";
  if (applied) return "This reviewed draft has already been applied in this review session.";
  if (!inspection || inspection.status === "loading") return "Wait for the workspace comparison to finish before applying.";
  if (inspection.status === "error") return "Resolve or recompare the draft before applying.";
  return "";
}

function formatReviewTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function normalizeDraftPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
}

function draftKey(draft: VFile, index: number): string {
  return `${index}:${normalizeDraftPath(draft.path)}:${draft.content.length}`;
}

function nextUnappliedDraftIndex(drafts: VFile[], appliedKeys: string[], currentIndex: number): number {
  for (let offset = 1; offset <= drafts.length; offset += 1) {
    const index = (currentIndex + offset) % drafts.length;
    if (!appliedKeys.includes(draftKey(drafts[index], index))) return index;
  }
  return -1;
}

function countLines(value: string): number {
  if (!value) return 0;
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length;
}

function buildDraftDiff(existing: string | null, next: string): Pick<DraftInspection, "added" | "removed" | "preview" | "truncated"> {
  const nextLines = splitDiffLines(next);
  if (existing === null) {
    const preview = createDiffPreview([], nextLines, 0, -1, 0, nextLines.length - 1);
    return { added: nextLines.length, removed: 0, preview: preview.preview, truncated: preview.truncated };
  }

  const existingLines = splitDiffLines(existing);
  if (existing === next) {
    return { added: 0, removed: 0, preview: "No line changes.", truncated: false };
  }

  let prefix = 0;
  while (
    prefix < existingLines.length
    && prefix < nextLines.length
    && existingLines[prefix] === nextLines[prefix]
  ) {
    prefix += 1;
  }

  let existingEnd = existingLines.length - 1;
  let nextEnd = nextLines.length - 1;
  while (
    existingEnd >= prefix
    && nextEnd >= prefix
    && existingLines[existingEnd] === nextLines[nextEnd]
  ) {
    existingEnd -= 1;
    nextEnd -= 1;
  }

  const added = Math.max(0, nextEnd - prefix + 1);
  const removed = Math.max(0, existingEnd - prefix + 1);
  const preview = createDiffPreview(existingLines, nextLines, prefix, existingEnd, prefix, nextEnd);
  return { added, removed, preview: preview.preview, truncated: preview.truncated };
}

function splitDiffLines(value: string): string[] {
  if (!value) return [];
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function createDiffPreview(
  existingLines: string[],
  nextLines: string[],
  existingStart: number,
  existingEnd: number,
  nextStart: number,
  nextEnd: number,
): { preview: string; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;
  const push = (line: string) => {
    if (lines.length >= MAX_DIFF_PREVIEW_LINES) {
      truncated = true;
      return;
    }
    lines.push(line.length > MAX_DIFF_LINE_CHARS ? `${line.slice(0, MAX_DIFF_LINE_CHARS)}…` : line);
  };

  const beforeStart = Math.max(0, existingStart - MAX_DIFF_CONTEXT_LINES);
  if (beforeStart > 0) push(`… ${beforeStart} unchanged line${beforeStart === 1 ? "" : "s"} before`);
  for (let index = beforeStart; index < existingStart; index += 1) push(` ${existingLines[index] ?? ""}`);

  for (let index = existingStart; index <= existingEnd; index += 1) push(`-${existingLines[index] ?? ""}`);
  for (let index = nextStart; index <= nextEnd; index += 1) push(`+${nextLines[index] ?? ""}`);

  const afterStart = Math.max(existingEnd + 1, existingStart);
  const afterEnd = Math.min(existingLines.length, afterStart + MAX_DIFF_CONTEXT_LINES);
  for (let index = afterStart; index < afterEnd; index += 1) push(` ${existingLines[index] ?? ""}`);
  const remaining = existingLines.length - afterEnd;
  if (remaining > 0) push(`… ${remaining} unchanged line${remaining === 1 ? "" : "s"} after`);

  return { preview: lines.join("\n") || "No previewable line changes.", truncated };
}

function isMissingWorkspaceFile(error: unknown): boolean {
  return error instanceof WorkspaceCommandError
    && error.code === "io_error"
    && /no such file|not found|os error 2|cannot find/i.test(error.message);
}

function draftStatusLabel(inspection: DraftInspection): string {
  switch (inspection.status) {
    case "loading": return "Inspecting workspace diff";
    case "new": return "New file";
    case "update": return "Updates existing file";
    case "unchanged": return "No file changes";
    case "unavailable": return "Workspace comparison unavailable";
    case "error": return "Comparison failed";
  }
}

function draftStatusClass(status?: DraftInspectionStatus): string {
  switch (status) {
    case "new": return "bg-emerald-500/[0.05]";
    case "update": return "bg-cyan-500/[0.05]";
    case "unchanged": return "bg-zinc-500/[0.05]";
    case "error": return "bg-rose-500/[0.08]";
    case "unavailable": return "bg-amber-500/[0.05]";
    case "loading":
    default:
      return "bg-white/[0.02]";
  }
}

function isReviewShortcutTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
}

function draftReviewAnnotationStatusLabel(status: ReviewedDraftAnnotationStatus): string {
  switch (status) {
    case "reviewed": return "Marked reviewed";
    case "needs-changes": return "Needs changes";
    case "unreviewed": return "Not marked reviewed";
  }
}

function draftReviewAnnotationShortLabel(status: Exclude<ReviewedDraftAnnotationStatus, "unreviewed">): string {
  return status === "reviewed" ? "reviewed" : "needs changes";
}

function draftReviewAnnotationPillClass(status: ReviewedDraftAnnotationStatus): string {
  switch (status) {
    case "reviewed": return "border border-emerald-400/20 bg-emerald-400/10 text-emerald-200";
    case "needs-changes": return "border border-amber-400/20 bg-amber-400/10 text-amber-200";
    case "unreviewed": return "border border-white/10 bg-white/[0.04] text-zinc-500";
  }
}

function draftReviewAnnotationButtonClass(active: boolean, status: Exclude<ReviewedDraftAnnotationStatus, "unreviewed">): string {
  if (status === "reviewed") {
    return active
      ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-100"
      : "border-emerald-400/20 text-emerald-200 hover:bg-emerald-400/10";
  }
  return active
    ? "border-amber-400/40 bg-amber-400/15 text-amber-100"
    : "border-amber-400/20 text-amber-200 hover:bg-amber-400/10";
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
