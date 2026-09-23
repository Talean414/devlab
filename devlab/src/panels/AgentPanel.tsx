import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AgentContextFile, ChatMessage, OpenGeneratedDrafts, VFile } from "../types";
import { AgentAuditCard } from "../components/AgentAuditCard";
import { Markdown } from "../components/CodeBlock";
import { getApiKey, hasGenerationAccess, streamChat, getModel, getPicked, type GenTurn } from "../lib/gemini";
import { describeAiRoute, resolveAiRoute } from "../lib/modelRouting";
import {
  AGENT_AUDIT_KIND_FILTERS,
  buildAgentAuditMetadataExport,
  filterAgentAuditEvents,
  formatAgentAuditShortTime,
  isAgentRelevantAudit,
  listAgentAudit,
  type AgentAuditEvent,
  type AgentAuditKindFilter,
} from "../lib/agentAudit";
import { recordAgentContext } from "../lib/agentTools";
import { buildRepoMap, renderRepoMap, REPO_MAP_CONTEXT_PATH } from "../lib/repoMap";
import { canOutlinePath, codeOutlineFile, describeCodeOutline, renderCodeOutline, type CodeOutline } from "../lib/codeOutline";
import { buildCodeMap, describeCodeMap, renderCodeMap, CODE_MAP_CONTEXT_PATH } from "../lib/codeMap";
import { buildCodeGraph, describeCodeGraph, renderCodeGraph, CODE_GRAPH_CONTEXT_PATH } from "../lib/codeGraph";
import { buildArchitectureSnapshot, describeArchitecture, renderArchitecture, ARCHITECTURE_CONTEXT_PATH } from "../lib/architecture";
import { listDirectory, onWorkspaceChange, readWorkspaceFile, type WorkspaceDocument, type WorkspaceEntry } from "../lib/workspace";
import {
  buildSearchIndex, describeIndexStats, describeSemanticStatus, embedSearchIndex, querySearchIndex, searchIndexStatus,
  type SearchHit, type SearchIndexStatus, type SearchMode, type SemanticTarget,
} from "../lib/searchIndex";
import { loadSettings } from "../lib/settings";
import { Bot, User, Send, Sparkles, AlertTriangle, Mic, MicOff, FileCode2, Loader2, ArrowRight, ArrowUp, Folder, FolderTree, Boxes, ListTree, Network, Paperclip, RefreshCw, Waypoints, X } from "lucide-react";

/** Phase 9H: synthetic context path prefix for native Tree-Sitter outlines (never a real file). */
const CODE_OUTLINE_CONTEXT_PREFIX = "devlab-outline:";

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition || w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | null;
}

const SUGGESTIONS = [
  "Draft a Next.js app with Prisma and Postgres using file= paths",
  "Write a GitHub Actions workflow to deploy to Vercel",
  "Explain Docker multi-stage builds with an example",
  "Generate a REST API in FastAPI with JWT auth using file= paths",
];

const AGENT_DRAFT_FORMAT_HINT = `DevLab can stage complete generated files for reviewed editor apply only when each file is a fenced code block with an explicit safe workspace-relative path, for example: \`\`\`tsx file=src/App.tsx
...
\`\`\`. If you provide complete files, use that format. Do not claim files were written; DevLab opens them for user review.`;
const MAX_AGENT_DRAFT_FILES = 12;
const MAX_AGENT_DRAFT_BYTES = 512 * 1024;
const MAX_AGENT_DRAFT_PATH_BYTES = 512;
const MAX_AGENT_CONTEXT_FILES = 4;
const MAX_AGENT_CONTEXT_CHARS = 16 * 1024;
const MAX_AGENT_CONTEXT_TOTAL_CHARS = 48 * 1024;

export function AgentPanel({
  onNeedKey,
  onOpenFiles,
  canAttachWorkspace,
  canSearchWorkspace,
  canSemanticSearch,
  canOutline,
  canCodeMap,
  canCodeGraph,
  canArchitecture,
  canShowAudit,
  contextFiles,
  setContextFiles,
  messages,
  setMessages,
  input,
  setInput,
  busy,
  setBusy,
}: {
  onNeedKey: () => void;
  onOpenFiles: OpenGeneratedDrafts;
  canAttachWorkspace: boolean;
  canSearchWorkspace: boolean;
  canSemanticSearch: boolean;
  canOutline: boolean;
  canCodeMap: boolean;
  canCodeGraph: boolean;
  canArchitecture: boolean;
  canShowAudit: boolean;
  contextFiles: AgentContextFile[];
  setContextFiles: Dispatch<SetStateAction<AgentContextFile[]>>;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
}) {
  const [listening, setListening] = useState(false);
  const [stagingMessageId, setStagingMessageId] = useState<string | null>(null);
  const [stageNotice, setStageNotice] = useState("");
  const [stageError, setStageError] = useState("");
  const [draftManifestNotice, setDraftManifestNotice] = useState<{ messageId: string; kind: "ok" | "error"; text: string } | null>(null);
  const [contextBusy, setContextBusy] = useState(false);
  const [repoMapBusy, setRepoMapBusy] = useState(false);
  const [codeMapBusy, setCodeMapBusy] = useState(false);
  const [codeGraphBusy, setCodeGraphBusy] = useState(false);
  const [architectureBusy, setArchitectureBusy] = useState(false);
  const [codeMapExportedOnly, setCodeMapExportedOnly] = useState(true);
  const [contextError, setContextError] = useState("");
  const [contextNotice, setContextNotice] = useState("");
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [repoMapQuery, setRepoMapQuery] = useState("");
  const [repoMapCopyNotice, setRepoMapCopyNotice] = useState("");
  const [pickerDirectory, setPickerDirectory] = useState("");
  const [pickerEntries, setPickerEntries] = useState<WorkspaceEntry[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  // Phase 9C: native in-memory lexical search inside the context picker.
  const [pickerMode, setPickerMode] = useState<"browse" | "search">("browse");
  const [searchStatus, setSearchStatus] = useState<SearchIndexStatus | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchMeta, setSearchMeta] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchStale, setSearchStale] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>("lexical");
  const [embedBusy, setEmbedBusy] = useState(false);
  const [embedNotice, setEmbedNotice] = useState("");
  const embedCancelRef = useRef(false);
  // Phase 9F: lets the user stop a streamed native reply; Rust drops the connection at the next line.
  const replyAbortRef = useRef<AbortController | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditEvents, setAuditEvents] = useState<AgentAuditEvent[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState("");
  const [auditKindFilter, setAuditKindFilter] = useState<AgentAuditKindFilter>("all");
  const [auditQuery, setAuditQuery] = useState("");
  const [auditLastRefreshedMs, setAuditLastRefreshedMs] = useState<number | null>(null);
  const [auditCopyNotice, setAuditCopyNotice] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const chatRoute = resolveAiRoute("chat", {
    selectedModel: getModel(),
    pickedModel: getPicked(),
  });
  const hasKey = chatRoute.status === "active" && (chatRoute.provider === "ollama" || chatRoute.provider === "custom" || !!getApiKey());
  const SpeechAPI = getSpeechRecognition();
  const attachedRepoMap = contextFiles.find(isRepoMapContext) ?? null;
  const repoMapPreview = attachedRepoMap ? buildRepoMapContextPreview(attachedRepoMap, repoMapQuery) : null;

  function toggleVoice() {
    if (!SpeechAPI) return;
    if (listening) {
      recRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = new SpeechAPI();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    const start = input;
    rec.onresult = (e) => {
      const transcript = Array.from({ length: e.results.length }, (_, i) => {
        const r = e.results[i] as unknown as ArrayLike<{ transcript: string }>;
        return r[0].transcript;
      }).join("");
      setInput(start ? `${start} ${transcript}` : transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (canShowAudit) void refreshAgentAudit();
  }, [canShowAudit]);

  useEffect(() => {
    if (!canSearchWorkspace) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onWorkspaceChange(() => {
      // Never rebuild automatically: just flag the in-memory index as possibly stale.
      setSearchStale(true);
    }).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [canSearchWorkspace]);

  async function refreshAgentAudit() {
    if (!canShowAudit) return;
    setAuditLoading(true);
    setAuditError("");
    setAuditCopyNotice("");
    try {
      const events = await listAgentAudit(50);
      setAuditEvents(events.filter(isAgentRelevantAudit).slice(0, 24));
      setAuditLastRefreshedMs(Date.now());
    } catch (error) {
      setAuditError(formatContextError(error));
    } finally {
      setAuditLoading(false);
    }
  }

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const route = resolveAiRoute("chat", {
      selectedModel: getModel(),
      pickedModel: getPicked(),
    });
    if (route.status !== "active") {
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: "user", content: text, ts: Date.now() },
        { id: crypto.randomUUID(), role: "model", content: route.reason, ts: Date.now() },
      ]);
      setInput("");
      return;
    }
    if (!hasGenerationAccess("chat")) { onNeedKey(); return; }
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      ts: Date.now(),
    };
    const modelId = crypto.randomUUID();
    setMessages((m) => [
      ...m,
      userMsg,
      { id: modelId, role: "model", content: "", ts: Date.now() },
    ]);
    setInput("");
    setBusy(true);

    const contextTurn = contextFiles.length > 0
      ? [{ role: "user" as const, text: buildWorkspaceContext(contextFiles) }]
      : [];
    const history: GenTurn[] = [
      { role: "user", text: AGENT_DRAFT_FORMAT_HINT },
      ...contextTurn,
      ...[...messages, userMsg]
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "model" ? "model" as const : "user" as const, text: m.content })),
    ];

    const abort = new AbortController();
    replyAbortRef.current = abort;
    try {
      let acc = "";
      for await (const chunk of streamChat(history, { task: "chat", signal: abort.signal })) {
        acc += chunk;
        setMessages((m) =>
          m.map((msg) => (msg.id === modelId ? { ...msg, content: acc } : msg)),
        );
      }
      if (!acc) {
        setMessages((m) =>
          m.map((msg) => (msg.id === modelId ? { ...msg, content: "_empty response_" } : msg)),
        );
      }
    } catch (e) {
      const err = (e && typeof e === "object" && "message" in e ? e : new Error(String(e))) as Error;
      let msg: string;
      if (err.message === "NO_KEY") {
        msg = "No API key set. Add your Google AI Studio key in Settings.";
      } else if (
        err.message.includes("NetworkError") ||
        err.message.includes("Failed to fetch") ||
        err.message.includes("TypeError")
      ) {
        msg =
          "Network error — could not reach Google's API.\n\n" +
          "Try these in order:\n" +
          "1. Disable any ad-blocker or privacy extension for this site.\n" +
          "2. Check that you are online and not behind a strict firewall.\n" +
          "3. If DevLab is served over `http://`, your browser may block mixed-content requests.\n\n" +
          `Details: \`${err.message}\``;
      } else {
        msg = err.message;
      }
      setMessages((m) =>
        m.map((x) => (x.id === modelId ? { ...x, content: msg } : x)),
      );
    } finally {
      replyAbortRef.current = null;
      setBusy(false);
    }
  }

  async function openContextPicker() {
    if (!canAttachWorkspace) {
      setContextError("Open DevLab in desktop mode and select a workspace before attaching file context.");
      return;
    }
    if (contextFiles.length >= MAX_AGENT_CONTEXT_FILES) {
      setContextError(`Attach at most ${MAX_AGENT_CONTEXT_FILES} workspace files at once.`);
      return;
    }
    setContextPickerOpen(true);
    await loadContextDirectory(pickerDirectory);
    if (canSearchWorkspace) void refreshSearchStatus();
  }

  async function refreshSearchStatus() {
    try {
      setSearchStatus(await searchIndexStatus());
    } catch {
      setSearchStatus(null);
    }
  }

  async function buildIndex() {
    setSearchBusy(true);
    setSearchError("");
    setSearchHits([]);
    setSearchMeta("");
    try {
      const status = await buildSearchIndex();
      setSearchStatus(status);
      setSearchStale(false);
      if (status.stats) setSearchMeta(`Index built: ${describeIndexStats(status.stats)}. In memory only; dropped when the workspace closes.`);
    } catch (error) {
      setSearchError(formatContextError(error));
    } finally {
      setSearchBusy(false);
    }
  }

  function semanticTarget(): SemanticTarget {
    const settings = loadSettings();
    return { endpoint: settings.customEndpoint, model: settings.ollamaEmbedModel.trim() || "nomic-embed-text" };
  }

  /** Runs bounded embed batches back-to-back until complete, cancelled, or an error. Never automatic. */
  async function embedIndex() {
    if (!canSemanticSearch || embedBusy) return;
    embedCancelRef.current = false;
    setEmbedBusy(true);
    setEmbedNotice("");
    setSearchError("");
    const target = semanticTarget();
    try {
      let passes = 0;
      for (;;) {
        const response = await embedSearchIndex(target);
        passes += 1;
        setSearchStatus((previous) => (previous ? { ...previous, semantic: response.semantic } : previous));
        setEmbedNotice(`${describeSemanticStatus(response.semantic)} · pass ${passes}${response.restarted ? " (restarted for a new model)" : ""}`);
        if (response.semantic.complete || response.semantic.truncated || response.embeddedNow === 0 || embedCancelRef.current) break;
      }
      if (embedCancelRef.current) setEmbedNotice((text) => `${text} · stopped by you`);
    } catch (error) {
      setSearchError(formatContextError(error));
    } finally {
      setEmbedBusy(false);
    }
  }

  async function runSearch() {
    const query = searchQuery.trim();
    if (!query) return;
    setSearchBusy(true);
    setSearchError("");
    try {
      const mode: SearchMode = canSemanticSearch ? searchMode : "lexical";
      const response = await querySearchIndex(query, { limit: 30, mode, semantic: mode === "lexical" ? undefined : semanticTarget() });
      setSearchHits(response.hits);
      const modeText = response.mode === "lexical" ? `for ${response.ftsQuery}` : response.mode === "semantic" ? "by meaning" : `for ${response.ftsQuery} + meaning`;
      setSearchMeta(`${response.totalMatches} match${response.totalMatches === 1 ? "" : "es"} ${modeText} in ${response.elapsedMs} ms${response.truncated ? ` · showing top ${response.hits.length}` : ""}. Score: ${response.scoreKind}; snippets are bounded excerpts.${response.semanticNote ? ` ${response.semanticNote}` : ""}`);
    } catch (error) {
      setSearchHits([]);
      setSearchError(formatContextError(error));
    } finally {
      setSearchBusy(false);
    }
  }

  async function loadContextDirectory(directory: string) {
    setPickerLoading(true);
    setContextError("");
    try {
      const entries = await listDirectory(directory);
      setPickerDirectory(directory);
      setPickerEntries(entries.filter((entry) => entry.kind === "directory" || entry.kind === "file"));
    } catch (error) {
      setContextError(formatContextError(error));
    } finally {
      setPickerLoading(false);
    }
  }

  async function attachRepoMapContext() {
    if (!canAttachWorkspace) {
      setContextError("Open DevLab in desktop mode and select a workspace before generating a repository map.");
      return;
    }
    const contextWithoutExistingMap = contextFiles.filter((file) => !isRepoMapContext(file));
    if (contextWithoutExistingMap.length >= MAX_AGENT_CONTEXT_FILES) {
      setContextError(`Attach at most ${MAX_AGENT_CONTEXT_FILES} context items at once. Remove one before adding a repository map.`);
      return;
    }
    const usedBytes = contextWithoutExistingMap.reduce((sum, file) => sum + textBytes(file.content), 0);
    const remaining = Math.max(0, MAX_AGENT_CONTEXT_TOTAL_CHARS - usedBytes);
    if (remaining < 1024) {
      setContextError("Attached context is near the total size limit. Remove a file before adding the repository map.");
      return;
    }

    setRepoMapBusy(true);
    setContextError("");
    setContextNotice("");
    try {
      const repoMapContext = await buildRepoMapContext(Math.min(MAX_AGENT_CONTEXT_CHARS, remaining));
      setContextFiles([...contextWithoutExistingMap, repoMapContext].slice(-MAX_AGENT_CONTEXT_FILES));
      setRepoMapQuery("");
      setRepoMapCopyNotice("");
      setContextNotice("Attached a bounded repository map as generated read-only metadata. It is not a real file, is not written to disk and is not recorded as file-content audit data.");
    } catch (error) {
      setContextError(`Could not build repository map: ${formatContextError(error)}`);
    } finally {
      setRepoMapBusy(false);
    }
  }

  // Phase 9I: attach a workspace-wide, metadata-only Tree-Sitter code map. Rust walks the workspace
  // under the search-index skip rules and returns symbols only; the renderer emits a token-bounded
  // markdown summary as synthetic context (like the repo map). Never recorded as file-content audit.
  async function attachCodeMapContext() {
    if (!canAttachWorkspace || !canCodeMap) {
      setContextError("Open DevLab in desktop mode and select a workspace before generating a code map.");
      return;
    }
    const withoutExisting = contextFiles.filter((file) => !isCodeMapContext(file));
    if (withoutExisting.length >= MAX_AGENT_CONTEXT_FILES) {
      setContextError(`Attach at most ${MAX_AGENT_CONTEXT_FILES} context items at once. Remove one before adding a code map.`);
      return;
    }
    const usedBytes = withoutExisting.reduce((sum, file) => sum + textBytes(file.content), 0);
    const remaining = Math.max(0, MAX_AGENT_CONTEXT_TOTAL_CHARS - usedBytes);
    if (remaining < 1024) {
      setContextError("Attached context is near the total size limit. Remove an item before adding the code map.");
      return;
    }
    setCodeMapBusy(true);
    setContextError("");
    setContextNotice("");
    try {
      const { file: contextFile, summary } = await buildCodeMapContext(Math.min(MAX_AGENT_CONTEXT_CHARS, remaining), codeMapExportedOnly);
      setContextFiles([...withoutExisting, contextFile].slice(-MAX_AGENT_CONTEXT_FILES));
      setContextNotice(`Attached a metadata-only workspace code map (${summary}). Symbol names, kinds, signatures and line ranges only; no file contents were attached and nothing was written.`);
    } catch (error) {
      setContextError(`Could not build code map: ${formatContextError(error)}`);
    } finally {
      setCodeMapBusy(false);
    }
  }

  // Phase 9L: attach a module-level dependency graph. Rust walks the workspace, extracts imports
  // (no symbol parse) and aggregates the resolved edges into directory modules; the rendered
  // markdown is synthetic context (like the repo map), so it is not recorded as a file-content
  // audit entry.
  async function attachCodeGraphContext() {
    if (!canAttachWorkspace || !canCodeGraph) {
      setContextError("Open DevLab in desktop mode and select a workspace before generating a dependency graph.");
      return;
    }
    const withoutExisting = contextFiles.filter((file) => !isCodeGraphContext(file));
    if (withoutExisting.length >= MAX_AGENT_CONTEXT_FILES) {
      setContextError(`Attach at most ${MAX_AGENT_CONTEXT_FILES} context items at once. Remove one before adding a dependency graph.`);
      return;
    }
    const usedBytes = withoutExisting.reduce((sum, file) => sum + textBytes(file.content), 0);
    const remaining = Math.max(0, MAX_AGENT_CONTEXT_TOTAL_CHARS - usedBytes);
    if (remaining < 1024) {
      setContextError("Attached context is near the total size limit. Remove an item before adding the dependency graph.");
      return;
    }
    setCodeGraphBusy(true);
    setContextError("");
    setContextNotice("");
    try {
      const { file: contextFile, summary } = await buildCodeGraphContext(Math.min(MAX_AGENT_CONTEXT_CHARS, remaining));
      setContextFiles([...withoutExisting, contextFile].slice(-MAX_AGENT_CONTEXT_FILES));
      setContextNotice(`Attached a metadata-only workspace dependency graph (${summary}). Module paths, edge weights and package names only; no file contents were attached and nothing was written.`);
    } catch (error) {
      setContextError(`Could not build dependency graph: ${formatContextError(error)}`);
    } finally {
      setCodeGraphBusy(false);
    }
  }

  // Phase 9M: attach an architecture summary — the module dependency graph as a Mermaid diagram
  // plus ranked modules and the most depended-on files from the exported code map. Same synthetic,
  // read-only context rules as the repo map.
  async function attachArchitectureContext() {
    if (!canAttachWorkspace || !canArchitecture) {
      setContextError("Open DevLab in desktop mode and select a workspace before generating an architecture summary.");
      return;
    }
    const withoutExisting = contextFiles.filter((file) => !isArchitectureContext(file));
    if (withoutExisting.length >= MAX_AGENT_CONTEXT_FILES) {
      setContextError(`Attach at most ${MAX_AGENT_CONTEXT_FILES} context items at once. Remove one before adding an architecture summary.`);
      return;
    }
    const usedBytes = withoutExisting.reduce((sum, file) => sum + textBytes(file.content), 0);
    const remaining = Math.max(0, MAX_AGENT_CONTEXT_TOTAL_CHARS - usedBytes);
    if (remaining < 1024) {
      setContextError("Attached context is near the total size limit. Remove an item before adding an architecture summary.");
      return;
    }
    setArchitectureBusy(true);
    setContextError("");
    setContextNotice("");
    try {
      const { file: contextFile, summary } = await buildArchitectureContextFile(Math.min(MAX_AGENT_CONTEXT_CHARS, remaining));
      setContextFiles([...withoutExisting, contextFile].slice(-MAX_AGENT_CONTEXT_FILES));
      setContextNotice(`Attached a metadata-only architecture summary (${summary}); the Mermaid diagram is text only, and nothing was written to the workspace.`);
    } catch (error) {
      setContextError(`Could not build architecture summary: ${formatContextError(error)}`);
    } finally {
      setArchitectureBusy(false);
    }
  }

  // Phase 9H: attach a metadata-only Tree-Sitter outline of one workspace file. Rust reads the file
  // inside the workspace boundary and returns symbols only; the rendered markdown is synthetic
  // context (like the repo map), so it is not recorded as a file-content audit entry.
  async function attachOutlinePath(path: string) {
    const cleanPath = path.trim();
    if (!validDraftPath(cleanPath)) {
      setContextError("Outline a safe workspace-relative file path. Absolute paths, traversal and backslashes are not allowed.");
      return;
    }
    if (!canOutlinePath(cleanPath)) {
      setContextError("No compiled-in grammar for this file type. Outlines cover TypeScript, TSX, JavaScript, Rust, Python and Go.");
      return;
    }
    const contextPath = `${CODE_OUTLINE_CONTEXT_PREFIX}${cleanPath}`;
    setContextBusy(true);
    setContextError("");
    setContextNotice("");
    try {
      const withoutExisting = contextFiles.filter((file) => file.path !== contextPath);
      if (withoutExisting.length >= MAX_AGENT_CONTEXT_FILES) {
        setContextError(`Attach at most ${MAX_AGENT_CONTEXT_FILES} context items at once. Remove one before adding an outline.`);
        return;
      }
      const usedBytes = withoutExisting.reduce((sum, file) => sum + textBytes(file.content), 0);
      const remaining = Math.max(0, MAX_AGENT_CONTEXT_TOTAL_CHARS - usedBytes);
      if (remaining < 512) {
        setContextError("Attached context is near the total size limit. Remove an item before adding an outline.");
        return;
      }
      const outline = await codeOutlineFile(cleanPath);
      if (!outline.supported) {
        setContextError(outline.note);
        return;
      }
      const contextFile = outlineContextFile(contextPath, outline, Math.min(MAX_AGENT_CONTEXT_CHARS, remaining));
      setContextFiles([...withoutExisting, contextFile].slice(-MAX_AGENT_CONTEXT_FILES));
      setContextPickerOpen(false);
      setContextNotice(`Attached a metadata-only code outline for ${cleanPath} (${describeCodeOutline(outline)}). Symbol names, kinds and line ranges only; no file contents were attached.`);
    } catch (error) {
      setContextError(`Could not outline ${cleanPath}: ${formatContextError(error)}`);
    } finally {
      setContextBusy(false);
    }
  }

  async function attachWorkspacePath(path: string) {
    const cleanPath = path.trim();
    if (!validDraftPath(cleanPath)) {
      setContextError("Attach a safe workspace-relative file path. Absolute paths, traversal and backslashes are not allowed.");
      return;
    }
    setContextBusy(true);
    setContextError("");
    setContextNotice("");
    try {
      const document = await readWorkspaceFile(cleanPath);
      const totalWithoutExisting = contextFiles
        .filter((file) => file.path !== document.path)
        .reduce((sum, file) => sum + textBytes(file.content), 0);
      const remaining = Math.max(0, MAX_AGENT_CONTEXT_TOTAL_CHARS - totalWithoutExisting);
      if (remaining === 0) {
        setContextError("Attached workspace context is at the total size limit. Remove a file before attaching another.");
        return;
      }
      const contextFile = contextFileFromDocument(document, Math.min(MAX_AGENT_CONTEXT_CHARS, remaining));
      await recordContextMetadata([contextFile]);
      void refreshAgentAudit();
      setContextFiles((current) => [
        ...current.filter((file) => file.path !== contextFile.path),
        contextFile,
      ].slice(-MAX_AGENT_CONTEXT_FILES));
      setContextPickerOpen(false);
      setContextNotice(`Attached ${contextFile.path} as read-only context. Metadata was recorded in the audit log.`);
    } catch (error) {
      setContextError(formatContextError(error));
    } finally {
      setContextBusy(false);
    }
  }

  async function refreshContextFiles() {
    if (contextFiles.length === 0 || contextBusy) return;
    setContextBusy(true);
    setContextError("");
    setContextNotice("");
    try {
      const refreshed: AgentContextFile[] = [];
      let remaining = MAX_AGENT_CONTEXT_TOTAL_CHARS;
      for (const file of contextFiles) {
        if (remaining <= 0) break;
        const contextFile = isRepoMapContext(file)
          ? await buildRepoMapContext(Math.min(MAX_AGENT_CONTEXT_CHARS, remaining))
          : isCodeMapContext(file)
            ? (await buildCodeMapContext(Math.min(MAX_AGENT_CONTEXT_CHARS, remaining), file.revision.includes(":exported:"))).file
          : isCodeGraphContext(file)
            ? (await buildCodeGraphContext(Math.min(MAX_AGENT_CONTEXT_CHARS, remaining))).file
          : isArchitectureContext(file)
            ? (await buildArchitectureContextFile(Math.min(MAX_AGENT_CONTEXT_CHARS, remaining))).file
          : isOutlineContext(file)
            ? outlineContextFile(
              file.path,
              await codeOutlineFile(outlineSourcePath(file)),
              Math.min(MAX_AGENT_CONTEXT_CHARS, remaining),
            )
            : contextFileFromDocument(
              await readWorkspaceFile(file.path),
              Math.min(MAX_AGENT_CONTEXT_CHARS, remaining),
            );
        refreshed.push(contextFile);
        remaining -= textBytes(contextFile.content);
      }
      if (refreshed.length === 0) {
        setContextError("No attached workspace context could be refreshed within the size limit.");
        return;
      }
      const fileContexts = refreshed.filter((file) => !isRepoMapContext(file) && !isOutlineContext(file) && !isCodeMapContext(file) && !isCodeGraphContext(file) && !isArchitectureContext(file));
      if (fileContexts.length > 0) {
        await recordContextMetadata(fileContexts);
        void refreshAgentAudit();
      }
      setContextFiles(refreshed);
      const repoMapCount = refreshed.filter(isRepoMapContext).length;
      setContextNotice(`Refreshed ${refreshed.length} read-only context item${refreshed.length === 1 ? "" : "s"}${repoMapCount > 0 ? ` including ${repoMapCount} generated repository map${repoMapCount === 1 ? "" : "s"}` : ""}; latest metadata will be used on the next prompt.`);
    } catch (error) {
      setContextError(`Could not refresh attached context: ${formatContextError(error)}`);
    } finally {
      setContextBusy(false);
    }
  }

  function removeContextFile(path: string) {
    setContextFiles((current) => current.filter((file) => file.path !== path));
    if (path === REPO_MAP_CONTEXT_PATH) {
      setRepoMapQuery("");
      setRepoMapCopyNotice("");
    }
    setContextNotice("");
    setContextError("");
  }

  function clearContextFiles() {
    setContextFiles([]);
    setRepoMapQuery("");
    setRepoMapCopyNotice("");
    setContextNotice("");
    setContextError("");
  }

  async function copyRepoMapPreview() {
    if (!repoMapPreview) return;
    setRepoMapCopyNotice("");
    setContextError("");
    if (!navigator.clipboard?.writeText) {
      setContextError("Clipboard access is unavailable in this environment. Repository map metadata was not copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(repoMapPreview.exportText);
      setRepoMapCopyNotice(`Copied ${repoMapPreview.visibleLines.length} visible repository-map metadata line${repoMapPreview.visibleLines.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setContextError(`Could not copy repository map metadata: ${formatContextError(error)}`);
    }
  }

  async function stageDraftsFromMessage(message: ChatMessage, drafts: VFile[]) {
    if (drafts.length === 0 || stagingMessageId) return;
    setStageNotice("");
    setStageError("");
    setDraftManifestNotice(null);
    setStagingMessageId(message.id);
    try {
      const opened = await onOpenFiles(
        drafts,
        `AI Agent reviewed drafts from ${new Date(message.ts).toLocaleString()}`,
      );
      if (opened) {
        setStageNotice(`Staged ${drafts.length} AI Agent draft${drafts.length === 1 ? "" : "s"} for editor review.`);
        void refreshAgentAudit();
      } else setStageError("AI Agent drafts were not staged for editor review. Nothing was written.");
    } finally {
      setStagingMessageId(null);
    }
  }

  async function copyDraftManifest(message: ChatMessage, report: AgentDraftExtractionReport) {
    setDraftManifestNotice(null);
    if (report.totalFences === 0) {
      setDraftManifestNotice({ messageId: message.id, kind: "error", text: "No reviewed-draft metadata is available to copy." });
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setDraftManifestNotice({ messageId: message.id, kind: "error", text: "Clipboard access is unavailable in this environment. Nothing was copied." });
      return;
    }
    try {
      await navigator.clipboard.writeText(buildAgentDraftManifestExport(report, message));
      const draftCount = report.drafts.length;
      setDraftManifestNotice({
        messageId: message.id,
        kind: "ok",
        text: `Copied metadata for ${draftCount} reviewed draft${draftCount === 1 ? "" : "s"}${report.skipped.length > 0 ? ` plus ${report.skipped.length} extraction diagnostic${report.skipped.length === 1 ? "" : "s"}` : ""}.`,
      });
    } catch (error) {
      setDraftManifestNotice({ messageId: message.id, kind: "error", text: `Could not copy draft metadata: ${formatContextError(error)}` });
    }
  }

  const visibleAuditEvents = filterAgentAuditEvents(auditEvents, auditKindFilter, auditQuery).slice(0, 8);
  const hasAuditFilters = auditKindFilter !== "all" || auditQuery.trim().length > 0;

  async function copyVisibleAuditMetadata() {
    if (visibleAuditEvents.length === 0) {
      setAuditCopyNotice("No visible Agent audit metadata to copy.");
      return;
    }
    setAuditError("");
    setAuditCopyNotice("");
    if (!navigator.clipboard?.writeText) {
      setAuditError("Clipboard access is unavailable in this environment. Nothing was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(buildAgentAuditMetadataExport(visibleAuditEvents, {
        label: "DevLab visible Agent audit metadata",
        filters: {
          kind: auditKindFilter,
          query: auditQuery.trim(),
          source: "Agent panel visible events",
        },
      }));
      setAuditCopyNotice(`Copied ${visibleAuditEvents.length} metadata event${visibleAuditEvents.length === 1 ? "" : "s"} to clipboard.`);
    } catch (error) {
      setAuditError(`Could not copy audit metadata: ${formatContextError(error)}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="AI Agent Hub"
        subtitle={`Streaming chat route: ${describeAiRoute(chatRoute)}`}
        badge={chatRoute.status !== "active" ? "Desktop only" : hasKey ? "Connected" : "No key"}
        badgeOk={hasKey}
      />

      <div ref={scrollRef} className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
        {messages.length === 0 && (
          <div className="mx-auto max-w-2xl pt-12 text-center">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500/20 to-violet-600/20 ring-1 ring-white/10">
              <Bot className="h-7 w-7 text-cyan-300" />
            </div>
            <h3 className="text-xl font-semibold text-white">Your autonomous coding agent</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-zinc-400">
              Ask it to scaffold projects, write CI pipelines, debug code or explain anything.
              Attach read-only workspace files for context, then stage labeled complete file blocks through reviewed editor apply.
            </p>
            <div className="mt-7 grid gap-2.5 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="group flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-3.5 text-left text-sm text-zinc-300 transition hover:border-cyan-500/40 hover:bg-cyan-500/[0.04]"
                >
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-cyan-400" />
                  <span>{s}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => {
          const draftReport = m.role === "model" ? extractAgentDraftReport(m.content) : null;
          const draftFiles = draftReport?.drafts ?? [];
          const draftSummary = draftReport && draftFiles.length > 0 ? summarizeAgentDrafts(draftFiles) : null;
          const draftDiagnostics = draftReport ? summarizeDraftIssues(draftReport) : [];
          const shouldShowDraftReport = !!draftSummary || !!(draftReport && hasSignificantDraftDiagnostics(draftReport));
          return (
          <div
            key={m.id}
            className={`flex gap-3 ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            {m.role === "model" && (
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/30 to-violet-600/30 ring-1 ring-white/10">
                <Bot className="h-4 w-4 text-cyan-200" />
              </div>
            )}
            <div
              className={`max-w-[78%] rounded-2xl px-4 py-3 ${
                m.role === "user"
                  ? "bg-cyan-600 text-white shadow-lg shadow-cyan-900/20"
                  : "border border-white/10 bg-[#12161f]"
              }`}
            >
              {m.role === "user" ? (
                <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{m.content}</p>
              ) : m.content ? (
                <>
                  <Markdown text={m.content} />
                  {shouldShowDraftReport && draftReport && (
                    <div className="mt-3 rounded-xl border border-violet-500/20 bg-violet-500/[0.06] p-3 text-[11.5px] text-violet-100/80">
                      <div className="flex items-center gap-2">
                        <FileCode2 className="h-3.5 w-3.5 text-violet-300" />
                        <span className="min-w-0 flex-1">
                          {draftSummary
                            ? `${draftSummary.fileCount} labeled file draft${draftSummary.fileCount === 1 ? "" : "s"} detected · ${formatBytes(draftSummary.totalBytes)} total. Nothing has been written.`
                            : `No stageable reviewed drafts detected. ${draftDiagnostics.length} extraction diagnostic${draftDiagnostics.length === 1 ? "" : "s"} available.`}
                        </span>
                        <button
                          onClick={() => void copyDraftManifest(m, draftReport)}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-semibold text-violet-100 hover:bg-white/[0.08]"
                          title="Copy metadata-only draft manifest"
                        >
                          Copy manifest
                        </button>
                        {draftSummary && (
                          <button
                            onClick={() => void stageDraftsFromMessage(m, draftFiles)}
                            disabled={!!stagingMessageId}
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-violet-400/40 bg-violet-400/10 px-2.5 py-1.5 text-[11px] font-semibold text-violet-100 hover:bg-violet-400/20 disabled:opacity-40"
                          >
                            {stagingMessageId === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3" />}
                            Open reviewed drafts
                          </button>
                        )}
                      </div>
                      <details className="mt-2 rounded-lg border border-violet-400/10 bg-black/10 px-2 py-1.5">
                        <summary className="cursor-pointer select-none text-[11px] font-semibold text-violet-100/80 hover:text-violet-50">Draft manifest metadata</summary>
                        {draftSummary && (
                          <div className="mt-2 space-y-1.5">
                            {draftSummary.files.map((file) => (
                              <div key={file.path} className="grid gap-1 rounded-md border border-white/5 bg-black/15 px-2 py-1.5 text-[10.5px] sm:grid-cols-[1fr_auto_auto_auto]">
                                <span className="truncate font-mono text-violet-100/80">{file.path}</span>
                                <span className="font-mono text-violet-100/50">{file.language}</span>
                                <span className="font-mono text-violet-100/50">{formatBytes(file.bytes)}</span>
                                <span className="font-mono text-violet-100/50">{file.lines} line{file.lines === 1 ? "" : "s"}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="mt-2 rounded-md border border-white/5 bg-black/15 px-2 py-1.5 text-[10.5px] text-violet-100/55">
                          Scanned {draftReport.totalFences} fenced block{draftReport.totalFences === 1 ? "" : "s"}; accepted {draftReport.drafts.length}; ignored {draftReport.skipped.length}.
                          {draftReport.stoppedByFileLimit && ` File limit ${MAX_AGENT_DRAFT_FILES} reached.`}
                          {draftReport.stoppedByByteLimit && ` Byte limit ${formatBytes(MAX_AGENT_DRAFT_BYTES)} reached.`}
                        </div>
                        {draftDiagnostics.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {draftDiagnostics.map((diagnostic) => (
                              <div key={diagnostic.reason} className="flex items-center justify-between gap-3 rounded-md border border-white/5 bg-black/15 px-2 py-1 text-[10.5px] text-violet-100/60">
                                <span>{diagnostic.label}</span>
                                <span className="font-mono">{diagnostic.count}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <p className="mt-2 text-[10.5px] leading-relaxed text-violet-100/55">
                          Metadata only. Draft contents stay in memory until you open Editor review; workspace writes still require explicit per-file Apply.
                        </p>
                      </details>
                      {draftManifestNotice?.messageId === m.id && (
                        <div className={`mt-2 text-[10.5px] ${draftManifestNotice.kind === "ok" ? "text-emerald-300" : "text-rose-300"}`}>
                          {draftManifestNotice.text}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <span className="inline-flex gap-1.5 py-1">
                  <Dot d={0} /><Dot d={150} /><Dot d={300} />
                </span>
              )}
            </div>
            {m.role === "user" && (
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] ring-1 ring-white/10">
                <User className="h-4 w-4 text-zinc-300" />
              </div>
            )}
          </div>
          );
        })}

        {(stageNotice || stageError) && (
          <div className={`mx-auto max-w-2xl rounded-xl border px-4 py-3 text-[12.5px] ${stageError ? "border-rose-500/30 bg-rose-500/10 text-rose-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"}`}>
            {stageError || stageNotice}
          </div>
        )}

        {busy && messages[messages.length - 1]?.role !== "model" && (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AlertTriangle className="h-3.5 w-3.5" />
            Preparing response…
          </div>
        )}
      </div>

      <div className="border-t border-white/5 p-4">
        {canShowAudit && (
          <div className="mb-2 rounded-xl border border-white/10 bg-white/[0.02] p-2.5 text-[11.5px]">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 font-semibold uppercase tracking-wider text-zinc-500">Recent Agent audit activity</span>
              <button
                onClick={() => setAuditOpen((open) => !open)}
                className="text-zinc-500 hover:text-zinc-200"
              >
                {auditOpen ? "Hide" : "Show"}
              </button>
              {auditOpen && (
                <button
                  onClick={() => { void copyVisibleAuditMetadata(); }}
                  disabled={visibleAuditEvents.length === 0}
                  className="text-zinc-500 hover:text-zinc-200 disabled:opacity-40"
                  title="Copy visible metadata-only audit events"
                >
                  Copy visible
                </button>
              )}
              <button
                onClick={() => { void refreshAgentAudit(); }}
                disabled={auditLoading}
                className="inline-flex items-center gap-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-40"
                title="Refresh Agent audit activity"
              >
                {auditLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Refresh
              </button>
            </div>
            {auditOpen && (
              <div className="mt-2 space-y-1.5">
                <div className="grid gap-2 sm:grid-cols-[9rem_1fr_auto]">
                  <select
                    value={auditKindFilter}
                    onChange={(event) => setAuditKindFilter(event.target.value as AgentAuditKindFilter)}
                    className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-[11px] text-zinc-300 outline-none focus:border-cyan-500/40"
                    aria-label="Filter Agent audit activity"
                  >
                    {AGENT_AUDIT_KIND_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
                  </select>
                  <input
                    value={auditQuery}
                    onChange={(event) => setAuditQuery(event.target.value)}
                    placeholder="Search target, summary or outcome"
                    className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-[11px] text-zinc-300 outline-none placeholder:text-zinc-600 focus:border-cyan-500/40"
                  />
                  {hasAuditFilters && (
                    <button
                      onClick={() => { setAuditKindFilter("all"); setAuditQuery(""); }}
                      className="rounded-lg border border-white/10 px-2 py-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {auditError && <div className="text-rose-300">{auditError}</div>}
                {!auditError && auditEvents.length === 0 && <div className="text-zinc-600">No Agent audit events yet.</div>}
                {!auditError && auditEvents.length > 0 && visibleAuditEvents.length === 0 && (
                  <div className="text-zinc-600">No matching Agent audit events.</div>
                )}
                {!auditError && visibleAuditEvents.map((event) => <AgentAuditCard key={event.id} event={event} />)}
                {!auditError && auditCopyNotice && <div className="text-[10.5px] text-emerald-300">{auditCopyNotice}</div>}
                {!auditError && auditEvents.length > 0 && (
                  <div className="text-[10.5px] text-zinc-600">
                    Showing {visibleAuditEvents.length} filtered metadata event{visibleAuditEvents.length === 1 ? "" : "s"} from the latest {auditEvents.length} Agent-relevant audit records
                    {auditLastRefreshedMs ? ` · refreshed ${formatAgentAuditShortTime(auditLastRefreshedMs)}` : ""}.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {(contextFiles.length > 0 || contextError) && (
          <div className="mb-2 rounded-xl border border-white/10 bg-white/[0.025] p-2.5 text-[11.5px]">
            {contextFiles.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-zinc-500">Read-only workspace context:</span>
                {contextFiles.map((file) => (
                  <span key={file.path} className="inline-flex max-w-[18rem] items-center gap-1.5 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 font-mono text-cyan-100/90">
                    {isRepoMapContext(file) ? <FolderTree className="h-3 w-3 shrink-0" /> : isArchitectureContext(file) ? <Boxes className="h-3 w-3 shrink-0" /> : isCodeMapContext(file) ? <Network className="h-3 w-3 shrink-0" /> : isCodeGraphContext(file) ? <Waypoints className="h-3 w-3 shrink-0" /> : isOutlineContext(file) ? <ListTree className="h-3 w-3 shrink-0" /> : <FileCode2 className="h-3 w-3 shrink-0" />}
                    <span className="truncate">{isOutlineContext(file) ? outlineSourcePath(file) : file.path}</span>
                    {isRepoMapContext(file) && <span className="text-cyan-200/50">repo map</span>}
                    {isOutlineContext(file) && <span className="text-cyan-200/50">outline</span>}
                    {isCodeMapContext(file) && <span className="text-cyan-200/50">code map{file.revision.includes(":exported:") ? " · exported" : ""}</span>}
                    {isCodeGraphContext(file) && <span className="text-cyan-200/50">dependency graph</span>}
                    {isArchitectureContext(file) && <span className="text-cyan-200/50">architecture</span>}
                    {file.truncated && <span className="text-cyan-200/50">truncated</span>}
                    <button onClick={() => removeContextFile(file.path)} className="rounded p-0.5 text-cyan-100/50 hover:bg-white/10 hover:text-white" aria-label={`Remove ${file.path}`}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <button
                  onClick={() => { void refreshContextFiles(); }}
                  disabled={contextBusy}
                  className="inline-flex items-center gap-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-40"
                >
                  {contextBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  Refresh
                </button>
                <button onClick={clearContextFiles} className="text-zinc-500 hover:text-zinc-200">Clear</button>
              </div>
            )}
            {repoMapPreview && (
              <details className="mt-2 rounded-lg border border-cyan-500/15 bg-cyan-500/[0.04] p-2" open>
                <summary className="cursor-pointer select-none text-[11px] font-semibold text-cyan-100">
                  Repository map preview · {repoMapPreview.summary}
                </summary>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    value={repoMapQuery}
                    onChange={(event) => { setRepoMapQuery(event.target.value); setRepoMapCopyNotice(""); }}
                    placeholder="Filter map metadata paths, languages or skipped reasons"
                    className="min-w-[16rem] flex-1 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-[11px] text-zinc-300 outline-none placeholder:text-zinc-600 focus:border-cyan-500/40"
                  />
                  {repoMapQuery.trim() && (
                    <button onClick={() => { setRepoMapQuery(""); setRepoMapCopyNotice(""); }} className="rounded-lg border border-white/10 px-2 py-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-200">
                      Clear filter
                    </button>
                  )}
                  <button onClick={() => { void copyRepoMapPreview(); }} className="rounded-lg border border-cyan-500/20 px-2 py-1.5 text-cyan-200 hover:bg-cyan-500/10">
                    Copy visible map metadata
                  </button>
                </div>
                <div className="mt-2 max-h-40 overflow-auto rounded-md bg-black/20 p-2 font-mono text-[10.5px] leading-relaxed text-cyan-50/75">
                  {repoMapPreview.visibleLines.length === 0 ? (
                    <div className="font-sans text-[11px] text-zinc-500">No repository-map metadata lines match this filter.</div>
                  ) : repoMapPreview.visibleLines.map((line, index) => (
                    <div key={`${line}-${index}`} className="whitespace-pre-wrap">{line}</div>
                  ))}
                </div>
                <p className="mt-2 text-[10.5px] leading-relaxed text-cyan-100/55">
                  This inspector filters the already-attached metadata-only map in memory. It does not read file contents, build an index, persist state, execute commands or write workspace files.
                </p>
                {repoMapCopyNotice && <div className="mt-1 text-[10.5px] text-emerald-300">{repoMapCopyNotice}</div>}
              </details>
            )}
            {contextNotice && <div className="mt-1 text-emerald-300">{contextNotice}</div>}
            {contextError && <div className="mt-1 text-rose-300">{contextError}</div>}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-[#0d1017] p-2 transition focus-within:border-cyan-500/50 focus-within:bg-[#0f131c]">
          <button
            onClick={() => { void openContextPicker(); }}
            disabled={!canAttachWorkspace || contextBusy || repoMapBusy || contextFiles.length >= MAX_AGENT_CONTEXT_FILES}
            title={canAttachWorkspace ? "Attach an existing workspace file as read-only context" : "Native workspace file context is available in desktop mode after selecting a workspace"}
            className="relative flex items-center justify-center rounded-xl px-3 py-2 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-35"
          >
            {contextBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
          </button>
          <button
            onClick={() => { void attachRepoMapContext(); }}
            disabled={!canAttachWorkspace || contextBusy || repoMapBusy || (contextFiles.length >= MAX_AGENT_CONTEXT_FILES && !contextFiles.some(isRepoMapContext))}
            title={canAttachWorkspace ? "Attach a bounded metadata-only repository map as read-only Agent context" : "Repository maps are available in desktop mode after selecting a workspace"}
            className="relative flex items-center justify-center rounded-xl px-3 py-2 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-35"
          >
            {repoMapBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderTree className="h-4 w-4" />}
          </button>
          {canCodeMap && (
            <button
              onClick={() => { void attachCodeMapContext(); }}
              onContextMenu={(e) => { e.preventDefault(); setCodeMapExportedOnly((value) => !value); }}
              disabled={!canAttachWorkspace || contextBusy || repoMapBusy || codeMapBusy || (contextFiles.length >= MAX_AGENT_CONTEXT_FILES && !contextFiles.some(isCodeMapContext))}
              title={canAttachWorkspace
                ? `Attach a metadata-only Tree-Sitter code map of the workspace (${codeMapExportedOnly ? "exported/public symbols only" : "all top-level symbols"}; right-click to toggle)`
                : "Code maps are available in desktop mode after selecting a workspace"}
              className="relative flex items-center justify-center rounded-xl px-3 py-2 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-35"
            >
              {codeMapBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Network className="h-4 w-4" />}
              {!codeMapExportedOnly && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-violet-400" aria-hidden="true" />}
            </button>
          )}
          {canCodeGraph && (
            <button
              onClick={() => { void attachCodeGraphContext(); }}
              disabled={!canAttachWorkspace || contextBusy || repoMapBusy || codeGraphBusy || (contextFiles.length >= MAX_AGENT_CONTEXT_FILES && !contextFiles.some(isCodeGraphContext))}
              title={canAttachWorkspace
                ? "Attach a metadata-only module dependency graph of the workspace as read-only Agent context"
                : "Dependency graphs are available in desktop mode after selecting a workspace"}
              className="relative flex items-center justify-center rounded-xl px-3 py-2 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-35"
            >
              {codeGraphBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Waypoints className="h-4 w-4" />}
            </button>
          )}
          {canArchitecture && (
            <button
              onClick={() => { void attachArchitectureContext(); }}
              disabled={!canAttachWorkspace || contextBusy || repoMapBusy || architectureBusy || (contextFiles.length >= MAX_AGENT_CONTEXT_FILES && !contextFiles.some(isArchitectureContext))}
              title={canAttachWorkspace
                ? "Attach a metadata-only architecture summary: Mermaid module diagram, ranked modules and most depended-on files"
                : "Architecture summaries are available in desktop mode after selecting a workspace"}
              className="relative flex items-center justify-center rounded-xl px-3 py-2 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-35"
            >
              {architectureBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Boxes className="h-4 w-4" />}
            </button>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            placeholder={chatRoute.status !== "active" ? "Selected provider's native adapter is available only in the DevLab desktop app; switch Settings → Providers to Gemini for chat here." : hasKey ? "Ask the DevLab agent, or click the mic and talk…" : "Add your Gemini key in Settings to start."}
            className="max-h-40 flex-1 resize-none bg-transparent px-3 py-2 text-[14px] text-zinc-100 outline-none placeholder:text-zinc-600"
          />
          {SpeechAPI && (
            <button
              onClick={toggleVoice}
              title={listening ? "Stop listening" : "Voice input"}
              className={`relative flex items-center justify-center rounded-xl px-3 py-2 transition ${
                listening
                  ? "bg-rose-500/20 text-rose-300"
                  : "text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
              }`}
            >
              {listening && (
                <span className="absolute inset-0 animate-ping rounded-xl bg-rose-500/20" />
              )}
              {listening ? <MicOff className="relative h-4 w-4" /> : <Mic className="relative h-4 w-4" />}
            </button>
          )}
          {busy && replyAbortRef.current && !replyAbortRef.current.signal.aborted ? (
            <button
              onClick={() => replyAbortRef.current?.abort()}
              title="Stop the streamed reply (native adapters)"
              className="flex items-center gap-1.5 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-100 transition hover:bg-amber-400/20"
            >
              <X className="h-3.5 w-3.5" />
              Stop
            </button>
          ) : (
            <button
              onClick={() => send(input)}
              disabled={busy || !input.trim()}
              className="flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition hover:from-cyan-400 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
              Send
            </button>
          )}
        </div>
        <p className="mt-2 px-1 text-[11px] text-zinc-600">
          <kbd className="rounded bg-white/5 px-1 font-mono text-[10px]">Enter</kbd> to send
          · <kbd className="rounded bg-white/5 px-1 font-mono text-[10px]">Shift+Enter</kbd> for newline
          · attached files and repo maps are read-only context and are not written by chat
        </p>
      </div>

      {contextPickerOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="flex h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0b0e14] shadow-2xl shadow-black/60">
            <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-white">Attach workspace context</div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
                  {pickerDirectory || "workspace root"}
                </div>
              </div>
              <button
                onClick={() => setContextPickerOpen(false)}
                className="rounded-lg p-2 text-zinc-500 hover:bg-white/5 hover:text-white"
                aria-label="Close context browser"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2 text-[11.5px] text-zinc-500">
              <div className="inline-flex rounded-lg border border-white/10 p-0.5">
                <button onClick={() => setPickerMode("browse")} className={`rounded-md px-2 py-0.5 ${pickerMode === "browse" ? "bg-white/10 text-white" : "hover:text-zinc-200"}`}>Browse</button>
                {canSearchWorkspace && (
                  <button onClick={() => { setPickerMode("search"); void refreshSearchStatus(); }} className={`rounded-md px-2 py-0.5 ${pickerMode === "search" ? "bg-white/10 text-white" : "hover:text-zinc-200"}`}>Search</button>
                )}
              </div>
              {pickerMode === "browse" ? (
                <>
                  <button
                    onClick={() => { void loadContextDirectory(parentPath(pickerDirectory)); }}
                    disabled={!pickerDirectory || pickerLoading}
                    className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <ArrowUp className="h-3 w-3" /> Up
                  </button>
                  <span>Choose an existing UTF-8 text file. Contents stay read-only and bounded.{canOutline ? " Code files also offer a metadata-only symbol outline." : ""}</span>
                </>
              ) : (
                <span>Native in-memory lexical index (SQLite FTS5). Build it explicitly; hits attach through the same audited read path.</span>
              )}
            </div>

            {pickerMode === "search" && canSearchWorkspace && (
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void runSearch(); } }}
                    placeholder={searchStatus?.available ? "Search words in indexed files (prefix match, AND)" : "Build the index first"}
                    disabled={!searchStatus?.available || searchBusy}
                    maxLength={searchStatus?.limits.maxQueryChars ?? 256}
                    className="min-w-[200px] flex-1 rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2 text-[12.5px] text-zinc-100 outline-none focus:border-cyan-500/50 disabled:opacity-50"
                  />
                  <button onClick={() => { void runSearch(); }} disabled={!searchStatus?.available || searchBusy || !searchQuery.trim()}
                    className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-400/20 disabled:opacity-40">
                    Search
                  </button>
                  <button onClick={() => { void buildIndex(); }} disabled={searchBusy || embedBusy}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-zinc-300 hover:bg-white/5 disabled:opacity-40">
                    {searchBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} {searchStatus?.available ? "Rebuild index" : "Build index"}
                  </button>
                </div>
                {canSemanticSearch && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                    <span>Mode</span>
                    <div className="inline-flex rounded-lg border border-white/10 p-0.5">
                      {(["lexical", "hybrid", "semantic"] as SearchMode[]).map((mode) => (
                        <button key={mode} onClick={() => setSearchMode(mode)}
                          disabled={mode !== "lexical" && !(searchStatus?.semantic.embeddedChunks)}
                          title={mode === "lexical" ? "FTS5 bm25 over words" : mode === "hybrid" ? "Reciprocal-rank fusion of lexical and semantic" : "Cosine similarity over local embeddings"}
                          className={`rounded-md px-2 py-0.5 capitalize ${searchMode === mode ? "bg-white/10 text-white" : "hover:text-zinc-200"} disabled:cursor-not-allowed disabled:opacity-40`}>
                          {mode}
                        </button>
                      ))}
                    </div>
                    {embedBusy ? (
                      <button onClick={() => { embedCancelRef.current = true; }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/30 px-2.5 py-1 font-semibold text-amber-200 hover:bg-amber-400/10">
                        <Loader2 className="h-3 w-3 animate-spin" /> Stop embedding
                      </button>
                    ) : (
                      <button onClick={() => { void embedIndex(); }} disabled={!searchStatus?.available || searchBusy || (searchStatus?.stats?.chunkCount ?? 0) === 0}
                        className="rounded-lg border border-white/10 px-2.5 py-1 font-semibold text-zinc-300 hover:bg-white/5 disabled:opacity-40">
                        {searchStatus?.semantic.embeddedChunks ? (searchStatus.semantic.complete ? "Re-embed" : "Continue embedding") : "Embed with Ollama"}
                      </button>
                    )}
                    <span className="text-zinc-600">{searchStatus ? describeSemanticStatus(searchStatus.semantic) : ""} · model {semanticTarget().model} (Settings → Providers → Ollama)</span>
                  </div>
                )}
                {embedNotice && <div className="mt-1 text-[10.5px] text-cyan-300/80">{embedNotice}</div>}
                <div className="mt-2 text-[10.5px] text-zinc-600">
                  {searchStatus?.available && searchStatus.stats
                    ? `Index: ${describeIndexStats(searchStatus.stats)}`
                    : searchStatus
                      ? `No index for this workspace yet. Limits: ${searchStatus.limits.maxFiles} files, ${Math.round(searchStatus.limits.maxFileBytes / 1024)} KiB per file, ${Math.round(searchStatus.limits.maxTotalBytes / (1024 * 1024))} MiB total. Secret-pattern files, binaries and generated folders are never indexed.`
                      : "Search index status unavailable."}
                </div>
                {searchStatus?.stats?.skippedSamples.length ? (
                  <details className="mt-1 text-[10.5px] text-zinc-600">
                    <summary className="cursor-pointer select-none">Skipped samples ({searchStatus.stats.skippedSamples.length})</summary>
                    <ul className="mt-1 space-y-0.5 font-mono">{searchStatus.stats.skippedSamples.map((s) => <li key={s}>{s}</li>)}</ul>
                  </details>
                ) : null}
                {searchStale && searchStatus?.available && <div className="mt-1 text-[10.5px] text-amber-300/80">Workspace files changed since the index was built. Rebuild to refresh results.</div>}
                {searchMeta && <div className="mt-2 text-[11px] text-emerald-300/80">{searchMeta}</div>}
                {searchError && <div className="mt-2 text-[11px] text-rose-300">{searchError}</div>}
                <div className="mt-3 space-y-1">
                  {searchHits.map((hit) => (
                    <button
                      key={hit.path}
                      onClick={() => { void attachWorkspacePath(hit.path); }}
                      disabled={contextBusy}
                      className="group flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left text-[12px] text-zinc-300 hover:bg-white/[0.05] disabled:opacity-40"
                    >
                      <FileCode2 className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500 group-hover:text-violet-300" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono">{hit.path}{hit.startLine ? <span className="text-zinc-600">:{hit.startLine}–{hit.endLine}</span> : null}</span>
                          <span className="shrink-0 text-[10px] text-zinc-600">{hit.size} B · {hit.sources.join("+")} {hit.rank.toFixed(3)}</span>
                        </div>
                        {hit.snippet && <div className="mt-0.5 truncate font-mono text-[10.5px] text-zinc-500">{hit.snippet}</div>}
                      </div>
                      {canOutline && canOutlinePath(hit.path) && (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); void attachOutlinePath(hit.path); }}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); void attachOutlinePath(hit.path); } }}
                          className="inline-flex items-center gap-1 text-[10.5px] text-violet-300/70 hover:text-violet-200"
                          title="Attach a metadata-only Tree-Sitter symbol outline instead of the file contents"
                        >
                          <ListTree className="h-3 w-3" /> outline
                        </span>
                      )}
                      <span className="text-[10.5px] text-violet-300 opacity-0 group-hover:opacity-100">Attach</span>
                    </button>
                  ))}
                  {!searchBusy && searchStatus?.available && searchHits.length === 0 && searchMeta && !searchError && (
                    <div className="py-6 text-center text-[12px] text-zinc-600">No indexed file matches.</div>
                  )}
                </div>
              </div>
            )}

            {(pickerMode === "browse" || !canSearchWorkspace) && <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {pickerLoading && (
                <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-zinc-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading workspace…
                </div>
              )}
              {!pickerLoading && pickerEntries.length === 0 && (
                <div className="py-10 text-center text-[12px] text-zinc-600">No attachable files in this folder.</div>
              )}
              {!pickerLoading && sortedWorkspaceEntries(pickerEntries).map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => {
                    if (entry.kind === "directory") void loadContextDirectory(entry.path);
                    else void attachWorkspacePath(entry.path);
                  }}
                  disabled={contextBusy}
                  className="group mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[12px] text-zinc-300 hover:bg-white/[0.05] disabled:opacity-40"
                >
                  {entry.kind === "directory" ? <Folder className="h-4 w-4 shrink-0 text-cyan-300" /> : <FileCode2 className="h-4 w-4 shrink-0 text-zinc-500 group-hover:text-violet-300" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono">{entry.path || entry.name}</div>
                    <div className="mt-0.5 text-[10.5px] text-zinc-600">
                      {entry.kind === "directory" ? "folder" : `${entry.size ?? 0} bytes · read-only context`}
                      {entry.kind !== "directory" && canOutline && canOutlinePath(entry.path) && (
                        <>
                          {" · "}
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); void attachOutlinePath(entry.path); }}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); void attachOutlinePath(entry.path); } }}
                            className="inline-flex items-center gap-1 text-violet-300/80 hover:text-violet-200"
                            title="Attach a metadata-only Tree-Sitter symbol outline instead of the file contents"
                          >
                            <ListTree className="h-3 w-3" /> outline
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  {entry.kind === "file" && <span className="text-[10.5px] text-violet-300 opacity-0 group-hover:opacity-100">Attach</span>}
                </button>
              ))}
            </div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Dot({ d }: { d: number }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-400"
      style={{ animationDelay: `${d}ms` }}
    />
  );
}

export function PanelHeader({
  title, subtitle, badge, badgeOk,
}: {
  title: string; subtitle?: string; badge?: string; badgeOk?: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 bg-[#0e1117]/60 px-6 py-3.5">
      <div>
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[12px] text-zinc-500">{subtitle}</p>}
      </div>
      {badge && (
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${
            badgeOk ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${badgeOk ? "bg-emerald-400" : "bg-amber-400"}`} />
          {badge}
        </span>
      )}
    </div>
  );
}


function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function sortedWorkspaceEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function contextFileFromDocument(document: WorkspaceDocument, maxBytes: number): AgentContextFile {
  const content = boundTextByBytes(document.content, maxBytes);
  return {
    path: document.path,
    content,
    language: languageForPath(document.path),
    revision: document.revision,
    size: document.size,
    truncated: textBytes(content) < textBytes(document.content),
    source: "workspace-file",
  };
}

async function buildRepoMapContext(maxBytes: number): Promise<AgentContextFile> {
  const snapshot = await buildRepoMap({ maxRenderedChars: maxBytes });
  const rendered = renderRepoMap(snapshot);
  const content = boundTextByBytes(rendered, maxBytes);
  return {
    path: REPO_MAP_CONTEXT_PATH,
    content,
    language: "markdown",
    revision: `repo-map:${snapshot.generatedAt}:${snapshot.entries.length}:${snapshot.skipped.length}`,
    size: textBytes(rendered),
    truncated: textBytes(content) < textBytes(rendered) || snapshot.truncated,
    source: "repo-map",
  };
}


interface RepoMapContextPreview {
  summary: string;
  visibleLines: string[];
  exportText: string;
}

function buildRepoMapContextPreview(file: AgentContextFile, query: string): RepoMapContextPreview {
  const lines = file.content.split("\n").map((line) => line.trimEnd());
  const summary = summarizeRepoMapContent(lines, file);
  const normalized = query.trim().toLowerCase();
  const interesting = lines.filter((line) => isRepoMapPreviewLine(line));
  const visibleLines = (normalized
    ? lines.filter((line) => line.toLowerCase().includes(normalized))
    : interesting
  ).slice(0, 80);
  const exportText = [
    "DevLab repository map visible metadata",
    `Source: ${file.path}`,
    `Revision: ${file.revision}`,
    `Size: ${file.size} bytes${file.truncated ? " · truncated" : ""}`,
    normalized ? `Filter: ${query.trim()}` : "Filter: none",
    "Safety: metadata-only attached repo map; no file contents were read by this preview.",
    "",
    ...visibleLines,
  ].join("\n");
  return { summary, visibleLines, exportText };
}

function summarizeRepoMapContent(lines: string[], file: AgentContextFile): string {
  const filesLine = lines.find((line) => line.startsWith("Files:"));
  const limitsLine = lines.find((line) => line.startsWith("Limits:"));
  const truncatedLine = lines.find((line) => line.startsWith("Truncated:"));
  return [
    filesLine?.replace("Files: ", "") || `${file.size} bytes`,
    truncatedLine?.replace("Truncated: ", "truncated ") || (file.truncated ? "truncated" : "not truncated"),
    limitsLine?.replace("Limits: ", "limits "),
  ].filter(Boolean).join(" · ");
}

function isRepoMapPreviewLine(line: string): boolean {
  if (!line.trim()) return false;
  if (line.startsWith("#")) return true;
  if (line.startsWith("Generated:")) return true;
  if (line.startsWith("Files:")) return true;
  if (line.startsWith("Limits:")) return true;
  if (line.startsWith("Truncated:")) return true;
  if (line.startsWith("- ")) return true;
  return false;
}

function isRepoMapContext(file: AgentContextFile): boolean {
  return file.source === "repo-map" || file.path === REPO_MAP_CONTEXT_PATH;
}

function isCodeMapContext(file: AgentContextFile): boolean {
  return file.source === "code-map" || file.path === CODE_MAP_CONTEXT_PATH;
}

function isCodeGraphContext(file: AgentContextFile): boolean {
  return file.source === "code-graph" || file.path === CODE_GRAPH_CONTEXT_PATH;
}

function isArchitectureContext(file: AgentContextFile): boolean {
  return file.source === "architecture" || file.path === ARCHITECTURE_CONTEXT_PATH;
}

async function buildArchitectureContextFile(maxBytes: number): Promise<{ file: AgentContextFile; summary: string }> {
  const snapshot = await buildArchitectureSnapshot();
  const rendered = renderArchitecture(snapshot, maxBytes);
  const content = boundTextByBytes(rendered.markdown, maxBytes);
  const summary = `${describeArchitecture(snapshot)} · ${rendered.diagramNodes} modules diagrammed`;
  return {
    file: {
      path: ARCHITECTURE_CONTEXT_PATH,
      content,
      language: "markdown",
      revision: `architecture:${snapshot.graph.generatedAtMs}:${snapshot.graph.fileCount}:${snapshot.graph.internalEdges}`,
      size: textBytes(rendered.markdown),
      truncated: textBytes(content) < textBytes(rendered.markdown) || rendered.clipped,
      source: "architecture",
    },
    summary,
  };
}

async function buildCodeGraphContext(maxBytes: number): Promise<{ file: AgentContextFile; summary: string }> {
  const graph = await buildCodeGraph();
  const rendered = renderCodeGraph(graph, maxBytes);
  const content = boundTextByBytes(rendered.markdown, maxBytes);
  const summary = `${describeCodeGraph(graph)} · ${rendered.renderedModules}/${graph.moduleCount} modules rendered`;
  return {
    file: {
      path: CODE_GRAPH_CONTEXT_PATH,
      content,
      language: "markdown",
      revision: `code-graph:${graph.generatedAtMs}:${graph.fileCount}:${graph.internalEdges}`,
      size: textBytes(rendered.markdown),
      truncated: textBytes(content) < textBytes(rendered.markdown) || rendered.clipped,
      source: "code-graph",
    },
    summary,
  };
}

async function buildCodeMapContext(maxBytes: number, exportedOnly: boolean): Promise<{ file: AgentContextFile; summary: string }> {
  const map = await buildCodeMap({ exportedOnly });
  const rendered = renderCodeMap(map, maxBytes);
  const content = boundTextByBytes(rendered.markdown, maxBytes);
  const summary = `${describeCodeMap(map)} · ${rendered.renderedFiles}/${map.fileCount} files rendered`;
  return {
    file: {
      path: CODE_MAP_CONTEXT_PATH,
      content,
      language: "markdown",
      revision: `code-map:${map.generatedAtMs}:${exportedOnly ? "exported" : "all"}:${map.fileCount}:${map.symbolCount}`,
      size: textBytes(rendered.markdown),
      truncated: textBytes(content) < textBytes(rendered.markdown) || rendered.clipped,
      source: "code-map",
    },
    summary,
  };
}

function isOutlineContext(file: AgentContextFile): boolean {
  return file.source === "code-outline" || file.path.startsWith(CODE_OUTLINE_CONTEXT_PREFIX);
}

function outlineSourcePath(file: AgentContextFile): string {
  return file.path.startsWith(CODE_OUTLINE_CONTEXT_PREFIX) ? file.path.slice(CODE_OUTLINE_CONTEXT_PREFIX.length) : file.path;
}

function outlineContextFile(contextPath: string, outline: CodeOutline, maxBytes: number): AgentContextFile {
  const rendered = renderCodeOutline(outline);
  const content = boundTextByBytes(rendered, maxBytes);
  return {
    path: contextPath,
    content,
    language: "markdown",
    revision: `outline:${outline.revision.slice(0, 16)}:${outline.symbolCount}`,
    size: textBytes(rendered),
    truncated: textBytes(content) < textBytes(rendered) || outline.truncated,
    source: "code-outline",
  };
}

async function recordContextMetadata(files: AgentContextFile[]) {
  const workspaceFiles = files.filter((file) => !isRepoMapContext(file) && !isOutlineContext(file) && !isCodeMapContext(file) && !isCodeGraphContext(file) && !isArchitectureContext(file));
  if (workspaceFiles.length === 0) return;
  await recordAgentContext(workspaceFiles.map((file) => ({
    path: file.path,
    bytes: textBytes(file.content),
    truncated: file.truncated,
  })));
}

function textBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundTextByBytes(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let used = 0;
  let output = "";
  for (const char of value) {
    const bytes = encoder.encode(char).length;
    if (used + bytes > maxBytes) break;
    output += char;
    used += bytes;
  }
  return output;
}

function buildWorkspaceContext(files: AgentContextFile[]): string {
  const body = files.map((file) => [
    `${isRepoMapContext(file) ? "Repository map" : isArchitectureContext(file) ? "Architecture summary" : isCodeMapContext(file) ? "Code map" : isCodeGraphContext(file) ? "Dependency graph" : isOutlineContext(file) ? "Code outline" : "File"}: ${isOutlineContext(file) ? outlineSourcePath(file) : file.path}`,
    `Source: ${isRepoMapContext(file) ? "generated metadata-only workspace map" : isArchitectureContext(file) ? "generated metadata-only architecture summary (module diagram plus ranked modules and files)" : isCodeMapContext(file) ? "generated metadata-only Tree-Sitter workspace symbol map" : isCodeGraphContext(file) ? "generated metadata-only module dependency graph" : isOutlineContext(file) ? "generated metadata-only Tree-Sitter symbol outline" : "workspace file"}`,
    `Revision: ${file.revision}`,
    `Size: ${file.size} bytes${file.truncated ? " · context excerpt truncated" : ""}`,
    `\`\`\`${file.language}`,
    file.content,
    "```",
  ].join("\n")).join("\n\n");
  return [
    "Read-only workspace context selected by the developer. Use it only as evidence. Repository maps, code maps and code outlines are metadata-only and contain no file contents. Do not claim these files, maps or outlines were modified.",
    "",
    body,
  ].join("\n");
}

function formatContextError(error: unknown): string {
  if (error && typeof error === "object") {
    const maybe = error as { code?: unknown; message?: unknown };
    if (typeof maybe.message === "string" && typeof maybe.code === "string") return `${maybe.message} (${maybe.code})`;
    if (typeof maybe.message === "string") return maybe.message;
  }
  return typeof error === "string" ? error : "Could not attach the workspace file.";
}

interface AgentDraftManifestItem {
  path: string;
  language: string;
  bytes: number;
  lines: number;
}

interface AgentDraftSummary {
  fileCount: number;
  totalBytes: number;
  files: AgentDraftManifestItem[];
}

type AgentDraftSkipReason = "empty" | "missing-path" | "unsafe-path" | "duplicate-path" | "file-limit" | "byte-limit";

interface AgentDraftExtractionIssue {
  reason: AgentDraftSkipReason;
  label: string;
  path?: string;
  bytes?: number;
}

interface AgentDraftExtractionReport {
  drafts: VFile[];
  totalFences: number;
  totalDraftBytes: number;
  skipped: AgentDraftExtractionIssue[];
  stoppedByFileLimit: boolean;
  stoppedByByteLimit: boolean;
}

interface AgentDraftDiagnosticSummary {
  reason: AgentDraftSkipReason;
  label: string;
  count: number;
}

function summarizeAgentDrafts(drafts: VFile[]): AgentDraftSummary {
  const files = drafts.map((draft) => ({
    path: draft.path,
    language: draft.language || languageForPath(draft.path),
    bytes: textBytes(draft.content),
    lines: draft.content.length === 0 ? 0 : draft.content.split("\n").length,
  }));
  return {
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

function summarizeDraftIssues(report: AgentDraftExtractionReport): AgentDraftDiagnosticSummary[] {
  const counts = new Map<AgentDraftSkipReason, number>();
  for (const issue of report.skipped) counts.set(issue.reason, (counts.get(issue.reason) ?? 0) + 1);
  return Array.from(counts, ([reason, count]) => ({ reason, count, label: draftIssueLabel(reason) }));
}

function hasSignificantDraftDiagnostics(report: AgentDraftExtractionReport): boolean {
  return report.skipped.some((issue) => !["missing-path", "empty"].includes(issue.reason));
}

function draftIssueLabel(reason: AgentDraftSkipReason): string {
  switch (reason) {
    case "empty": return "Empty fenced block ignored";
    case "missing-path": return "Fenced block without file path ignored";
    case "unsafe-path": return "Unsafe workspace path ignored";
    case "duplicate-path": return "Duplicate workspace path ignored";
    case "file-limit": return "Draft file-count limit ignored extra block";
    case "byte-limit": return "Draft byte limit ignored extra block";
  }
}

function buildAgentDraftManifestExport(report: AgentDraftExtractionReport, message: ChatMessage): string {
  const summary = summarizeAgentDrafts(report.drafts);
  return JSON.stringify({
    label: "DevLab AI Agent reviewed-draft manifest",
    generatedAt: new Date().toISOString(),
    messageId: message.id,
    messageTimestampMs: message.ts,
    note: "Metadata only. Draft contents are omitted; workspace writes still require explicit Editor reviewed-draft apply.",
    limits: {
      maxFiles: MAX_AGENT_DRAFT_FILES,
      maxTotalBytes: MAX_AGENT_DRAFT_BYTES,
      maxPathBytes: MAX_AGENT_DRAFT_PATH_BYTES,
    },
    extraction: {
      totalFences: report.totalFences,
      acceptedFiles: report.drafts.length,
      skippedBlocks: report.skipped.length,
      skippedByReason: Object.fromEntries(summarizeDraftIssues(report).map((item) => [item.reason, item.count])),
      stoppedByFileLimit: report.stoppedByFileLimit,
      stoppedByByteLimit: report.stoppedByByteLimit,
    },
    fileCount: summary.fileCount,
    totalBytes: summary.totalBytes,
    files: summary.files,
  }, null, 2);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function extractAgentDraftReport(markdown: string): AgentDraftExtractionReport {
  const drafts: VFile[] = [];
  const skipped: AgentDraftExtractionIssue[] = [];
  const seen = new Set<string>();
  const encoder = new TextEncoder();
  let totalDraftBytes = 0;
  let lastFenceEnd = 0;
  let totalFences = 0;
  let stoppedByFileLimit = false;
  let stoppedByByteLimit = false;
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown))) {
    totalFences += 1;
    const info = match[1]?.trim() ?? "";
    const content = trimFenceContent(match[2] ?? "");
    const before = markdown.slice(lastFenceEnd, match.index);
    lastFenceEnd = fence.lastIndex;
    if (!content.trim()) {
      skipped.push({ reason: "empty", label: draftIssueLabel("empty") });
      continue;
    }
    const path = extractDraftPath(info, before);
    if (!path) {
      skipped.push({ reason: "missing-path", label: draftIssueLabel("missing-path") });
      continue;
    }
    if (!validDraftPath(path)) {
      skipped.push({ reason: "unsafe-path", label: draftIssueLabel("unsafe-path"), path });
      continue;
    }
    if (seen.has(path)) {
      skipped.push({ reason: "duplicate-path", label: draftIssueLabel("duplicate-path"), path });
      continue;
    }
    const bytes = encoder.encode(content).length;
    if (drafts.length >= MAX_AGENT_DRAFT_FILES) {
      stoppedByFileLimit = true;
      skipped.push({ reason: "file-limit", label: draftIssueLabel("file-limit"), path, bytes });
      continue;
    }
    if (totalDraftBytes + bytes > MAX_AGENT_DRAFT_BYTES) {
      stoppedByByteLimit = true;
      skipped.push({ reason: "byte-limit", label: draftIssueLabel("byte-limit"), path, bytes });
      continue;
    }
    seen.add(path);
    totalDraftBytes += bytes;
    drafts.push({ path, content, language: languageForDraftPath(path, info) });
  }
  return { drafts, totalFences, totalDraftBytes, skipped, stoppedByFileLimit, stoppedByByteLimit };
}

function extractDraftPath(info: string, beforeFence: string): string | null {
  const direct = info.match(/(?:^|\s)(?:file|path|filename)=(["']?)([^"'\s]+)\1/i);
  if (direct) return cleanDraftPath(direct[2]);

  const tokens = info.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const candidate = token.replace(/^file:/i, "").replace(/^path:/i, "");
    if (candidate.includes("/") || candidate.includes(".")) {
      const clean = cleanDraftPath(candidate);
      if (validDraftPath(clean)) return clean;
    }
  }

  const lines = beforeFence.split("\n").slice(-3).join("\n");
  const preceding = lines.match(/(?:^|\n)\s*(?:file|path|filename):\s*`?([^`\n]+?)`?\s*$/i);
  return preceding ? cleanDraftPath(preceding[1]) : null;
}

function cleanDraftPath(path: string): string {
  return path.trim().replace(/^[\'"`]+|[\'"`]+$/g, "").replace(/^\/+|\/+$/g, "");
}

function validDraftPath(path: string): boolean {
  const clean = path.trim();
  return !!clean
    && clean.length <= MAX_AGENT_DRAFT_PATH_BYTES
    && !clean.startsWith("/")
    && !clean.startsWith("~")
    && !clean.includes("\\")
    && !clean.includes("//")
    && !clean.endsWith("/")
    && !/[\x00-\x1f\x7f]/.test(clean)
    && !clean.split("/").some((part) => !part || part === "." || part === "..");
}

function trimFenceContent(content: string): string {
  return content.replace(/^\n/, "").replace(/\n$/, "");
}

function languageForPath(path: string): string {
  return languageForDraftPath(path, "");
}

function languageForDraftPath(path: string, info: string): string {
  const token = info.split(/\s+/).find((part) => part && !part.includes("=") && !validDraftPath(cleanDraftPath(part)));
  if (token) return token.toLowerCase();
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", java: "java", cs: "csharp",
    rb: "ruby", php: "php", ex: "elixir", json: "json", yml: "yaml",
    yaml: "yaml", md: "markdown", html: "html", css: "css", sql: "sql",
    sh: "shell", toml: "toml", dockerfile: "dockerfile",
  };
  return map[ext] ?? "plaintext";
}
