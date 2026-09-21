import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  AlertTriangle,
  Ban,
  CircleStop,
  Eraser,
  FolderOpen,
  Loader2,
  Plus,
  ShieldAlert,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { loadSettings } from "../lib/settings";
import {
  clearTerminal,
  closeTerminal,
  createTerminal,
  getTerminalSnapshot,
  killTerminal,
  listTerminals,
  onTerminalExit,
  onTerminalOutput,
  resizeTerminal,
  TerminalCommandError,
  writeTerminal,
  type TerminalExitEvent,
  type TerminalOutputEvent,
  type TerminalSessionInfo,
} from "../lib/terminal";

interface HydrationState {
  sessionId: string;
  events: TerminalOutputEvent[];
}

export function TerminalPanel({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeId, setActiveId] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [rehydrateVersion, setRehydrateVersion] = useState(0);
  const creatingRef = useRef(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeIdRef = useRef("");
  const nextOffsetRef = useRef(0);
  const hydrationRef = useRef<HydrationState | null>(null);
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());
  const sessionsRef = useRef<TerminalSessionInfo[]>([]);
  const settings = loadSettings();

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeId) ?? null,
    [sessions, activeId],
  );

  activeIdRef.current = activeId;
  sessionsRef.current = sessions;

  useEffect(() => {
    let disposed = false;
    let stopOutput: (() => void) | undefined;
    let stopExit: (() => void) | undefined;

    async function connect() {
      try {
        [stopOutput, stopExit] = await Promise.all([
          onTerminalOutput(handleOutput),
          onTerminalExit(handleExit),
        ]);
        if (disposed) {
          stopOutput();
          stopExit();
          return;
        }
        const current = await listTerminals();
        if (disposed) return;
        setSessions(current);
        setActiveId((selected) => (
          selected && current.some((session) => session.id === selected)
            ? selected
            : (current[0]?.id ?? "")
        ));
      } catch (commandError) {
        if (!disposed) setError(errorMessage(commandError));
      } finally {
        if (!disposed) setLoading(false);
      }
    }

    function handleOutput(event: TerminalOutputEvent) {
      if (event.sessionId !== activeIdRef.current) return;
      const hydration = hydrationRef.current;
      if (hydration?.sessionId === event.sessionId) {
        hydration.events.push(event);
        return;
      }
      applyOutputEvent(event);
    }

    function handleExit(event: TerminalExitEvent) {
      setSessions((current) => current.map((session) => (
        session.id === event.sessionId
          ? {
            ...session,
            status: event.status,
            exitCode: event.exitCode,
            signal: event.signal,
            error: event.error,
          }
          : session
      )));
      if (event.sessionId === activeIdRef.current) {
        setNotice(exitDescription(event));
      }
    }

    void connect();
    return () => {
      disposed = true;
      stopOutput?.();
      stopExit?.();
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeId) {
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      return;
    }

    let disposed = false;
    let resizeTimer: number | undefined;
    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: Math.max(11, settings.fontSize),
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: {
        background: "#090b10",
        foreground: "#d4d4d8",
        cursor: "#22d3ee",
        cursorAccent: "#090b10",
        selectionBackground: "#164e63aa",
        black: "#18181b",
        red: "#fb7185",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e4e4e7",
        brightBlack: "#71717a",
        brightRed: "#fda4af",
        brightGreen: "#86efac",
        brightYellow: "#fde047",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#fafafa",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    hydrationRef.current = { sessionId: activeId, events: [] };
    setHistoryTruncated(false);

    function queueInput(data: string | Uint8Array) {
      const session = sessionsRef.current.find((item) => item.id === activeId);
      if (session?.status !== "running") return;
      inputQueueRef.current = inputQueueRef.current
        .then(() => writeTerminal(activeId, data))
        .catch((commandError) => setError(errorMessage(commandError)));
    }
    const inputDisposable = terminal.onData(queueInput);
    const binaryDisposable = terminal.onBinary((data) => {
      queueInput(Uint8Array.from(Array.from(data, (character) => character.charCodeAt(0))));
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const session = sessionsRef.current.find((item) => item.id === activeId);
        if (session?.status !== "running") return;
        resizeTerminal(activeId, cols, rows).catch((commandError) => {
          if (!(commandError instanceof TerminalCommandError && commandError.code === "terminal_not_running")) {
            setError(errorMessage(commandError));
          }
        });
      }, 60);
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // The host can disappear while ResizeObserver is delivering a final notification.
      }
    });
    observer.observe(host);

    requestAnimationFrame(() => {
      if (!disposed) {
        fit.fit();
        terminal.focus();
      }
    });

    getTerminalSnapshot(activeId)
      .then((snapshot) => {
        if (disposed || activeIdRef.current !== activeId) return;
        setSessions((current) => current.map((session) => (
          session.id === activeId ? snapshot.session : session
        )));
        setHistoryTruncated(snapshot.truncated);
        nextOffsetRef.current = snapshot.outputStart;
        if (snapshot.output.length > 0) {
          terminal.write(Uint8Array.from(snapshot.output));
        }
        nextOffsetRef.current = snapshot.outputEnd;

        const queued = hydrationRef.current?.sessionId === activeId
          ? hydrationRef.current.events.slice().sort((left, right) => left.offset - right.offset)
          : [];
        hydrationRef.current = null;
        queued.forEach(applyOutputEvent);
      })
      .catch((commandError) => {
        if (!disposed) {
          hydrationRef.current = null;
          setError(errorMessage(commandError));
        }
      });

    return () => {
      disposed = true;
      if (resizeTimer) window.clearTimeout(resizeTimer);
      observer.disconnect();
      inputDisposable.dispose();
      binaryDisposable.dispose();
      resizeDisposable.dispose();
      if (hydrationRef.current?.sessionId === activeId) hydrationRef.current = null;
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
    };
  }, [activeId, rehydrateVersion, settings.fontSize]);

  function applyOutputEvent(event: TerminalOutputEvent) {
    const terminal = terminalRef.current;
    if (!terminal || event.sessionId !== activeIdRef.current) return;

    const eventEnd = event.offset + event.data.length;
    if (eventEnd <= nextOffsetRef.current) return;
    if (event.offset > nextOffsetRef.current) {
      setNotice("Terminal output continuity was interrupted; restoring the bounded native history.");
      setRehydrateVersion((version) => version + 1);
      return;
    }

    const overlap = Math.max(0, nextOffsetRef.current - event.offset);
    terminal.write(Uint8Array.from(event.data.slice(overlap)));
    nextOffsetRef.current = eventEnd;
  }

  async function startSession() {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setError("");
    setNotice("");
    try {
      const session = await createTerminal(100, 30);
      setSessions((current) => [...current, session]);
      setActiveId(session.id);
    } catch (commandError) {
      setError(errorMessage(commandError));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  async function stopSession() {
    if (!activeSession || activeSession.status !== "running") return;
    if (!confirm(`Terminate ${shellName(activeSession.shell)} (PID ${activeSession.pid ?? "unknown"})?`)) return;
    setError("");
    try {
      await killTerminal(activeSession.id);
      setNotice("Termination requested. Waiting for the real process exit status…");
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function removeSession(session: TerminalSessionInfo) {
    if (
      session.status === "running"
      && !confirm(`Close this tab and terminate ${shellName(session.shell)} (PID ${session.pid ?? "unknown"})?`)
    ) return;
    setError("");
    try {
      await closeTerminal(session.id);
      const remaining = sessions.filter((item) => item.id !== session.id);
      setSessions(remaining);
      if (activeId === session.id) setActiveId(remaining[0]?.id ?? "");
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  async function clearActiveTerminal() {
    if (!activeSession) return;
    setError("");
    try {
      const offset = await clearTerminal(activeSession.id);
      terminalRef.current?.clear();
      terminalRef.current?.write("\x1b[2J\x1b[H");
      nextOffsetRef.current = offset;
      setHistoryTruncated(false);
    } catch (commandError) {
      setError(errorMessage(commandError));
    }
  }

  return (
    <div className="flex h-full flex-col bg-[#090b10]">
      <div className="flex min-h-12 shrink-0 items-center gap-3 border-b border-white/5 bg-[#0e1117]/80 px-4">
        <div className="flex items-center gap-2">
          <TerminalIcon className="h-4 w-4 text-cyan-400" />
          <div>
            <h2 className="text-[13px] font-semibold text-white">Native Terminal</h2>
            <p className="text-[10px] text-zinc-600">Real PTY · selected workspace</p>
          </div>
        </div>
        <div className="ml-3 flex min-w-0 flex-1 self-stretch overflow-x-auto">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`group flex shrink-0 items-center gap-2 border-b-2 px-3 text-[11.5px] transition ${
                activeId === session.id
                  ? "border-cyan-400 bg-white/[0.035] text-zinc-100"
                  : "border-transparent text-zinc-500 hover:bg-white/[0.02] hover:text-zinc-300"
              }`}
            >
              <button onClick={() => setActiveId(session.id)} className="flex items-center gap-2 py-3">
                <span className={`h-1.5 w-1.5 rounded-full ${
                  session.status === "running"
                    ? "bg-emerald-400"
                    : session.status === "exited"
                      ? "bg-zinc-600"
                      : "bg-rose-400"
                }`} />
                {shellName(session.shell)}
                {session.pid && <span className="font-mono text-[9px] text-zinc-700">{session.pid}</span>}
              </button>
              <button
                onClick={() => void removeSession(session)}
                className="rounded p-0.5 opacity-0 hover:bg-white/10 hover:text-rose-300 group-hover:opacity-100"
                aria-label={`Close ${shellName(session.shell)} terminal`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {sessions.length > 0 && (
            <button
              onClick={() => void startSession()}
              disabled={creating || sessions.length >= 8}
              className="my-auto ml-1 rounded-md p-1.5 text-zinc-600 hover:bg-white/5 hover:text-cyan-300 disabled:opacity-30"
              title="Start another real shell"
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
        {activeSession && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => void clearActiveTerminal()}
              className="rounded-md p-2 text-zinc-600 hover:bg-white/5 hover:text-zinc-200"
              title="Clear this terminal's native history buffer"
            >
              <Eraser className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => void stopSession()}
              disabled={activeSession.status !== "running"}
              className="rounded-md p-2 text-zinc-600 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-25"
              title="Terminate the real shell process"
            >
              <CircleStop className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {(error || notice || historyTruncated) && (
        <div className={`flex shrink-0 items-center gap-2 border-b px-4 py-2 text-[11.5px] ${
          error
            ? "border-rose-500/20 bg-rose-500/10 text-rose-200"
            : historyTruncated
              ? "border-amber-500/20 bg-amber-500/[0.08] text-amber-100"
              : "border-cyan-500/20 bg-cyan-500/[0.07] text-cyan-100"
        }`}>
          {error ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : historyTruncated ? <Ban className="h-3.5 w-3.5 shrink-0" /> : <TerminalIcon className="h-3.5 w-3.5 shrink-0" />}
          <span className="min-w-0 flex-1 truncate">
            {error || (historyTruncated
              ? "Earlier terminal output was discarded after the native 2 MiB history limit."
              : notice)}
          </span>
          <button onClick={() => { setError(""); setNotice(""); setHistoryTruncated(false); }} className="rounded p-0.5 hover:bg-white/10" aria-label="Dismiss message">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className={`absolute inset-0 p-3 ${activeSession ? "block" : "hidden"}`} />

        {!activeSession && !loading && (
          <div className="flex h-full items-center justify-center p-8">
            <div className="max-w-xl rounded-2xl border border-amber-500/20 bg-amber-500/[0.05] p-8 text-center ring-soft">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 ring-1 ring-amber-500/20">
                <ShieldAlert className="h-7 w-7 text-amber-300" />
              </div>
              <h3 className="mt-5 text-lg font-semibold text-white">Start a real shell</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-zinc-400">
                This is not a command simulator. The shell can read, modify, execute and delete
                anything your operating-system account can access. It starts in the workspace you
                explicitly selected, but shell commands are not confined to that folder.
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <button
                  onClick={() => void startSession()}
                  disabled={creating}
                  className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:from-cyan-400 hover:to-blue-500 disabled:opacity-50"
                >
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <TerminalIcon className="h-4 w-4" />}
                  Start native terminal
                </button>
                <button
                  onClick={onOpenWorkspace}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-sm text-zinc-300 hover:bg-white/5"
                >
                  <FolderOpen className="h-4 w-4" /> Select workspace
                </button>
              </div>
              <p className="mt-4 text-[11px] text-zinc-600">
                A selected workspace is required. Up to eight sessions remain alive when switching panels.
              </p>
            </div>
          </div>
        )}

        {loading && (
          <div className="flex h-full items-center justify-center gap-2 text-[12px] text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin text-cyan-400" /> Restoring native terminal sessions…
          </div>
        )}
      </div>

      {activeSession && (
        <div className="flex h-7 shrink-0 items-center justify-between border-t border-white/5 bg-[#0e1117]/80 px-3 font-mono text-[10.5px] text-zinc-600">
          <span className="min-w-0 truncate">{activeSession.cwd}</span>
          <div className="ml-4 flex shrink-0 items-center gap-3">
            <span>{shellName(activeSession.shell)}</span>
            <span className={activeSession.status === "running" ? "text-emerald-400" : activeSession.status === "failed" ? "text-rose-400" : "text-zinc-500"}>
              {sessionStatus(activeSession)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function shellName(shell: string): string {
  return shell.split(/[\\/]/).filter(Boolean).pop() || shell;
}

function sessionStatus(session: TerminalSessionInfo): string {
  if (session.status === "running") return "running";
  if (session.status === "failed") return "failed";
  if (session.signal) return `signal ${session.signal}`;
  return `exit ${session.exitCode ?? "?"}`;
}

function exitDescription(event: TerminalExitEvent): string {
  if (event.error) return event.error;
  if (event.signal) return `Shell exited after signal ${event.signal}.`;
  return `Shell exited with code ${event.exitCode ?? "unknown"}.`;
}

function errorMessage(error: unknown): string {
  if (error instanceof TerminalCommandError) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message;
  return "The native terminal operation failed.";
}
