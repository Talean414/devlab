import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AgentContextFile, ChatMessage, OpenGeneratedDrafts, VFile } from "../types";
import { Markdown } from "../components/CodeBlock";
import { getApiKey, streamChat, getModel, type GenTurn } from "../lib/gemini";
import { readWorkspaceFile } from "../lib/workspace";
import { Bot, User, Send, Sparkles, AlertTriangle, Mic, MicOff, FileCode2, Loader2, ArrowRight, Paperclip, X } from "lucide-react";

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
  const [contextBusy, setContextBusy] = useState(false);
  const [contextError, setContextError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const hasKey = !!getApiKey();
  const SpeechAPI = getSpeechRecognition();

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

  async function send(text: string) {
    if (!text.trim() || busy) return;
    if (!getApiKey()) { onNeedKey(); return; }
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

    try {
      let acc = "";
      for await (const chunk of streamChat(history)) {
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
      const err = e as Error;
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
      setBusy(false);
    }
  }

  async function attachWorkspaceFile() {
    if (!canAttachWorkspace) {
      setContextError("Open DevLab in desktop mode and select a workspace before attaching file context.");
      return;
    }
    if (contextFiles.length >= MAX_AGENT_CONTEXT_FILES) {
      setContextError(`Attach at most ${MAX_AGENT_CONTEXT_FILES} workspace files at once.`);
      return;
    }
    const path = prompt("Workspace file path to attach as read-only AI Agent context:");
    const cleanPath = path?.trim();
    if (!cleanPath) return;
    if (!validDraftPath(cleanPath)) {
      setContextError("Attach a safe workspace-relative file path. Absolute paths, traversal and backslashes are not allowed.");
      return;
    }
    setContextBusy(true);
    setContextError("");
    try {
      const document = await readWorkspaceFile(cleanPath);
      const totalWithoutExisting = contextFiles
        .filter((file) => file.path !== document.path)
        .reduce((sum, file) => sum + file.content.length, 0);
      const remaining = Math.max(0, MAX_AGENT_CONTEXT_TOTAL_CHARS - totalWithoutExisting);
      if (remaining === 0) {
        setContextError("Attached workspace context is at the total size limit. Remove a file before attaching another.");
        return;
      }
      const limit = Math.min(MAX_AGENT_CONTEXT_CHARS, remaining);
      const content = document.content.length > limit ? document.content.slice(0, limit) : document.content;
      const contextFile: AgentContextFile = {
        path: document.path,
        content,
        language: languageForPath(document.path),
        revision: document.revision,
        size: document.size,
        truncated: content.length < document.content.length,
      };
      setContextFiles((current) => [
        ...current.filter((file) => file.path !== contextFile.path),
        contextFile,
      ].slice(-MAX_AGENT_CONTEXT_FILES));
    } catch (error) {
      setContextError(formatContextError(error));
    } finally {
      setContextBusy(false);
    }
  }

  function removeContextFile(path: string) {
    setContextFiles((current) => current.filter((file) => file.path !== path));
  }

  async function stageDraftsFromMessage(message: ChatMessage, drafts: VFile[]) {
    if (drafts.length === 0 || stagingMessageId) return;
    setStageNotice("");
    setStageError("");
    setStagingMessageId(message.id);
    try {
      const opened = await onOpenFiles(
        drafts,
        `AI Agent reviewed drafts from ${new Date(message.ts).toLocaleString()}`,
      );
      if (opened) setStageNotice(`Staged ${drafts.length} AI Agent draft${drafts.length === 1 ? "" : "s"} for editor review.`);
      else setStageError("AI Agent drafts were not staged for editor review. Nothing was written.");
    } finally {
      setStagingMessageId(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="AI Agent Hub"
        subtitle={`Streaming chat powered by Gemini (${getModel()})`}
        badge={hasKey ? "Connected" : "No key"}
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
          const draftFiles = m.role === "model" ? extractAgentDrafts(m.content) : [];
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
                  {draftFiles.length > 0 && (
                    <div className="mt-3 rounded-xl border border-violet-500/20 bg-violet-500/[0.06] p-3 text-[11.5px] text-violet-100/80">
                      <div className="flex items-center gap-2">
                        <FileCode2 className="h-3.5 w-3.5 text-violet-300" />
                        <span className="min-w-0 flex-1">
                          {draftFiles.length} labeled file draft{draftFiles.length === 1 ? "" : "s"} detected. Stage for reviewed Editor diff/apply?
                        </span>
                        <button
                          onClick={() => void stageDraftsFromMessage(m, draftFiles)}
                          disabled={!!stagingMessageId}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-violet-400/40 bg-violet-400/10 px-2.5 py-1.5 text-[11px] font-semibold text-violet-100 hover:bg-violet-400/20 disabled:opacity-40"
                        >
                          {stagingMessageId === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3" />}
                          Open reviewed drafts
                        </button>
                      </div>
                      <div className="mt-2 truncate font-mono text-[10.5px] text-violet-100/60">
                        {draftFiles.map((file) => file.path).join(" · ")}
                      </div>
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
        {(contextFiles.length > 0 || contextError) && (
          <div className="mb-2 rounded-xl border border-white/10 bg-white/[0.025] p-2.5 text-[11.5px]">
            {contextFiles.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-zinc-500">Read-only workspace context:</span>
                {contextFiles.map((file) => (
                  <span key={file.path} className="inline-flex max-w-[18rem] items-center gap-1.5 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 font-mono text-cyan-100/90">
                    <FileCode2 className="h-3 w-3 shrink-0" />
                    <span className="truncate">{file.path}</span>
                    {file.truncated && <span className="text-cyan-200/50">truncated</span>}
                    <button onClick={() => removeContextFile(file.path)} className="rounded p-0.5 text-cyan-100/50 hover:bg-white/10 hover:text-white" aria-label={`Remove ${file.path}`}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <button onClick={() => setContextFiles([])} className="text-zinc-500 hover:text-zinc-200">Clear</button>
              </div>
            )}
            {contextError && <div className="mt-1 text-rose-300">{contextError}</div>}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-[#0d1017] p-2 transition focus-within:border-cyan-500/50 focus-within:bg-[#0f131c]">
          <button
            onClick={() => void attachWorkspaceFile()}
            disabled={!canAttachWorkspace || contextBusy || contextFiles.length >= MAX_AGENT_CONTEXT_FILES}
            title={canAttachWorkspace ? "Attach an existing workspace file as read-only context" : "Native workspace file context is available in desktop mode after selecting a workspace"}
            className="relative flex items-center justify-center rounded-xl px-3 py-2 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-35"
          >
            {contextBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
          </button>
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
            placeholder={hasKey ? "Ask the DevLab agent, or click the mic and talk…" : "Add your Gemini key in Settings to start."}
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
          <button
            onClick={() => send(input)}
            disabled={busy || !input.trim()}
            className="flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition hover:from-cyan-400 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" />
            Send
          </button>
        </div>
        <p className="mt-2 px-1 text-[11px] text-zinc-600">
          <kbd className="rounded bg-white/5 px-1 font-mono text-[10px]">Enter</kbd> to send
          · <kbd className="rounded bg-white/5 px-1 font-mono text-[10px]">Shift+Enter</kbd> for newline
          · attached files are read-only context and are not written by chat
        </p>
      </div>
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


function buildWorkspaceContext(files: AgentContextFile[]): string {
  const body = files.map((file) => [
    `File: ${file.path}`,
    `Revision: ${file.revision}`,
    `Size: ${file.size} bytes${file.truncated ? " · content excerpt truncated" : ""}`,
    `\`\`\`${file.language}`,
    file.content,
    "```",
  ].join("\n")).join("\n\n");
  return [
    "Read-only workspace context selected by the developer. Use it only as evidence. Do not claim these files were modified.",
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

function extractAgentDrafts(markdown: string): VFile[] {
  const drafts: VFile[] = [];
  const seen = new Set<string>();
  const encoder = new TextEncoder();
  let totalBytes = 0;
  let lastFenceEnd = 0;
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) && drafts.length < MAX_AGENT_DRAFT_FILES) {
    const info = match[1]?.trim() ?? "";
    const content = trimFenceContent(match[2] ?? "");
    const before = markdown.slice(lastFenceEnd, match.index);
    lastFenceEnd = fence.lastIndex;
    if (!content.trim()) continue;
    const path = extractDraftPath(info, before);
    if (!path || !validDraftPath(path) || seen.has(path)) continue;
    const bytes = encoder.encode(content).length;
    if (totalBytes + bytes > MAX_AGENT_DRAFT_BYTES) break;
    seen.add(path);
    totalBytes += bytes;
    drafts.push({ path, content, language: languageForDraftPath(path, info) });
  }
  return drafts;
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
