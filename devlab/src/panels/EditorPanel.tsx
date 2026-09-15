import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { PanelHeader } from "./AgentPanel";
import type { VFile } from "../types";
import { loadSettings, getTheme } from "../lib/settings";
import { subscribeFiles, publishFiles, getPeers, onPeers } from "../lib/sync";
import {
  FileCode2, FilePlus2, Trash2, X, Save, Download, FolderOpen, Search, History, Users,
} from "lucide-react";

const STARTER: VFile[] = [
  {
    path: "src/index.ts",
    language: "typescript",
    content: `// Welcome to the DevLab editor — a full Monaco instance,
// the same engine that powers VS Code.
//
// Everything here runs in your browser. Files are kept in
// localStorage so they survive a refresh. Live Share (Ctrl+7)
// syncs them across tabs and remote peers in realtime.

interface Task {
  id: string;
  title: string;
  done: boolean;
}

export function createTask(title: string): Task {
  return { id: crypto.randomUUID(), title, done: false };
}

export function summarize(tasks: Task[]): string {
  const done = tasks.filter((t) => t.done).length;
  return \`\${done}/\${tasks.length} complete\`;
}
`,
  },
];

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rs: "rust", go: "go", java: "java", cs: "csharp", cpp: "cpp",
  c: "c", rb: "ruby", php: "php", swift: "swift", kt: "kotlin", ex: "elixir",
  json: "json", yml: "yaml", yaml: "yaml", md: "markdown", html: "html",
  css: "css", scss: "scss", sql: "sql", sh: "shell", toml: "ini",
  dockerfile: "dockerfile", xml: "xml", graphql: "graphql",
};

const FKEY = "devlab.files.v1";
const SKEY = "devlab.snapshots.v1";

interface Snapshot { t: number; path: string; content: string }

function loadFiles(): VFile[] {
  try {
    const raw = localStorage.getItem(FKEY);
    return raw ? JSON.parse(raw) : STARTER;
  } catch { return STARTER; }
}
function loadSnaps(): Snapshot[] {
  try { return JSON.parse(localStorage.getItem(SKEY) || "[]"); } catch { return []; }
}

export function EditorPanel({ incoming }: { incoming?: VFile[] }) {
  const [files, setFiles] = useState<VFile[]>(loadFiles);
  const [openTabs, setOpenTabs] = useState<string[]>(() => loadFiles().slice(0, 2).map((f) => f.path));
  const [active, setActive] = useState<string>(() => loadFiles()[0]?.path ?? "");
  const [filter, setFilter] = useState("");
  const [saved, setSaved] = useState(true);
  const [snaps, setSnaps] = useState<Snapshot[]>(loadSnaps);
  const [showHistory, setShowHistory] = useState(false);
  const [peerCount, setPeerCount] = useState(0);
  const remoteApply = useRef(false);
  const lastEmit = useRef(0);
  const settings = loadSettings();
  const theme = getTheme(settings.theme);

  // Peer count
  useEffect(() => onPeers(() => setPeerCount(getPeers().filter((p) => p.connected).length)), []);

  // Merge files from outside (builder / canvas / vision / healer / migrate)
  useEffect(() => {
    if (incoming && incoming.length) {
      remoteApply.current = true;
      setFiles((prev) => {
        const map = new Map(prev.map((f) => [f.path, f]));
        incoming.forEach((f) => map.set(f.path, f));
        const next = Array.from(map.values());
        publishFiles(next, "handoff");
        return next;
      });
      setOpenTabs((t) => Array.from(new Set([...t, ...incoming.map((f) => f.path)])).slice(0, 10));
      setActive(incoming[0].path);
      setTimeout(() => (remoteApply.current = false), 100);
    }
  }, [incoming]);

  // Live share: receive files from other tabs / peers
  useEffect(() => {
    const unsub = subscribeFiles((fc, source) => {
      if (source === "local") return; // our own publish
      remoteApply.current = true;
      setFiles(fc);
      // keep currently-open tabs intact if their files still exist
      setOpenTabs((t) => t.filter((p) => fc.some((f) => f.path === p)).concat(fc.filter((f) => !t.includes(f.path)).map((f) => f.path)).slice(0, 10));
      setTimeout(() => (remoteApply.current = false), 60);
    });
    return unsub;
  }, []);

  // Persist + broadcast own changes (debounced)
  useEffect(() => {
    localStorage.setItem(FKEY, JSON.stringify(files));
    setSaved(true);
    if (remoteApply.current) return;
    const now = Date.now();
    if (now - lastEmit.current > 350) {
      lastEmit.current = now;
      publishFiles(files, "local");
    }
  }, [files]);

  // Snapshot the active file on change (debounced, capped)
  const snapTimer = useRef<number | null>(null);
  function maybeSnapshot(path: string, content: string) {
    if (snapTimer.current) window.clearTimeout(snapTimer.current);
    snapTimer.current = window.setTimeout(() => {
      setSnaps((s) => {
        const trimmed = s.filter((x) => !(x.path === path)).concat({ t: Date.now(), path, content });
        const perFile = trimmed.filter((x) => x.path === path);
        const others = trimmed.filter((x) => x.path !== path).slice(-120);
        const kept = [...others, ...perFile.slice(-15)].sort((a, b) => a.t - b.t);
        localStorage.setItem(SKEY, JSON.stringify(kept));
        return kept;
      });
    }, 2500);
  }

  const activeFile = useMemo(() => files.find((f) => f.path === active), [files, active]);
  const visible = files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()));
  const fileSnaps = useMemo(
    () => snaps.filter((s) => s.path === active).slice().reverse(),
    [snaps, active],
  );

  function updateContent(value: string | undefined) {
    if (value === undefined || !activeFile) return;
    setSaved(false);
    maybeSnapshot(active, activeFile.content);
    setFiles((fs) => fs.map((f) => (f.path === active ? { ...f, content: value } : f)));
  }

  function newFile() {
    const path = prompt("New file path (e.g. src/utils/helpers.ts)");
    if (!path) return;
    const ext = path.split(".").pop()?.toLowerCase() || "txt";
    const nf: VFile = { path, content: "", language: LANG_BY_EXT[ext] || "plaintext" };
    setFiles((fs) => [...fs, nf]);
    setOpenTabs((t) => [...t, path].slice(-10));
    setActive(path);
  }

  function removeFile(path: string) {
    setFiles((fs) => fs.filter((f) => f.path !== path));
    setOpenTabs((t) => t.filter((p) => p !== path));
    if (active === path) setActive(files.find((f) => f.path !== path)?.path || "");
  }

  function openFile(path: string) {
    setOpenTabs((t) => (t.includes(path) ? t : [...t, path].slice(-10)));
    setActive(path);
  }

  function downloadAll() {
    const blob = new Blob([files.map((f) => `===== ${f.path} =====\n${f.content}`).join("\n\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "devlab-project.txt";
    a.click();
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Code Editor"
        subtitle={`Monaco — the same engine that powers VS Code${peerCount ? ` · live with ${peerCount} peer${peerCount > 1 ? "s" : ""}` : ""}`}
        badge={saved ? "Saved" : "Unsaved"}
        badgeOk={saved}
      />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-white/5 bg-[#0d1017]/50">
          <div className="flex items-center gap-1 border-b border-white/5 p-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files"
                className="w-full rounded-md border border-white/10 bg-[#0b0e14] py-1.5 pl-7 pr-2 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-cyan-500/50" />
            </div>
            <button onClick={newFile} title="New file" className="rounded-md p-1.5 text-zinc-400 hover:bg-white/5 hover:text-white">
              <FilePlus2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
            <FolderOpen className="h-3 w-3" /> Workspace
            {peerCount > 0 && (
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9.5px] font-medium normal-case tracking-normal text-emerald-300">
                <Users className="h-2.5 w-2.5" /> {peerCount} live
              </span>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-1.5">
            {visible.map((f) => (
              <div key={f.path}
                className={`group flex items-center gap-2 rounded-md px-2 py-1.5 transition ${
                  active === f.path ? "bg-cyan-500/10 text-cyan-100" : "text-zinc-400 hover:bg-white/5"}`}>
                <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-60" />
                <button onClick={() => openFile(f.path)} className="flex-1 truncate text-left font-mono text-[12px]">
                  {f.path}
                </button>
                <button onClick={() => removeFile(f.path)} className="opacity-0 transition group-hover:opacity-100 hover:text-rose-400">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
            {visible.length === 0 && <p className="px-2 py-6 text-center text-[12px] text-zinc-600">No files match.</p>}
          </div>
          <div className="border-t border-white/5 p-2">
            <button onClick={downloadAll}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-white/10 py-1.5 text-[11.5px] text-zinc-300 hover:bg-white/5">
              <Download className="h-3 w-3" /> Export all
            </button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-white/5 bg-[#0d1017]/60 px-1">
            {openTabs.map((p) => (
              <div key={p}
                className={`group flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-[12px] transition ${
                  active === p ? "border-cyan-400 bg-white/[0.04] text-white" : "border-transparent text-zinc-500 hover:bg-white/[0.02]"}`}>
                <button onClick={() => setActive(p)} className="font-mono">{p.split("/").pop()}</button>
                <button onClick={() => {
                  setOpenTabs((t) => t.filter((x) => x !== p));
                  if (active === p) setActive(openTabs.filter((x) => x !== p)[0] || "");
                }} className="opacity-0 transition group-hover:opacity-100 hover:text-rose-400">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {openTabs.length === 0 && <span className="px-3 py-2 text-[12px] text-zinc-600">No file open</span>}
            <div className="ml-auto flex shrink-0 items-center gap-1 px-2">
              <button onClick={() => setShowHistory((v) => !v)} title="Time-travel snapshots"
                className={`rounded-md p-1.5 transition ${showHistory ? "bg-cyan-500/20 text-cyan-300" : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"}`}>
                <History className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {showHistory && (
            <div className="shrink-0 border-b border-white/5 bg-[#0d1017]/60 px-3 py-2">
              <div className="mb-1.5 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                <History className="h-3 w-3" /> Time travel
                <span className="font-normal normal-case tracking-normal text-zinc-600">
                  {fileSnaps.length} snapshot(s) of {active.split("/").pop()}
                </span>
              </div>
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {fileSnaps.length === 0 && (
                  <span className="text-[11.5px] text-zinc-600">Edit this file and snapshots will appear here automatically.</span>
                )}
                {fileSnaps.map((s) => (
                  <button key={s.t}
                    onClick={() => setFiles((fs) => fs.map((f) => (f.path === s.path ? { ...f, content: s.content } : f)))}
                    className="flex shrink-0 flex-col rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1.5 text-left transition hover:border-cyan-500/40">
                    <span className="font-mono text-[10.5px] text-cyan-300">
                      {new Date(s.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                    <span className="text-[9.5px] text-zinc-600">{s.content.split("\n").length} lines · restore</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="min-h-0 flex-1">
            {activeFile ? (
              <Editor
                height="100%"
                theme={theme.editor}
                path={activeFile.path}
                language={activeFile.language}
                value={activeFile.content}
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
                <FileCode2 className="h-10 w-10" />
                <p className="text-sm">Select or create a file to start editing.</p>
                <button onClick={newFile} className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/10">New file</button>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between border-t border-white/5 bg-[#0d1017]/60 px-4 py-1.5 text-[11px] text-zinc-500">
            <span className="font-mono">{activeFile?.path || "—"}</span>
            <div className="flex items-center gap-4">
              <span>{activeFile?.language || "plaintext"}</span>
              <span>{activeFile?.content.split("\n").length ?? 0} lines</span>
              <span className={saved ? "text-emerald-400" : "text-amber-400"}>
                <Save className="mr-1 inline h-3 w-3" />
                {saved ? "Saved" : "Unsaved"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
