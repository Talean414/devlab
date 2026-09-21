import { useEffect, useMemo, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import {
  testRunnerRun,
  testRunnerSnapshot,
  type TestProfile,
  type TestRunResult,
  type TestRunnerSnapshot,
} from "../lib/testRunner";
import {
  AlertTriangle, CheckCircle2, Clock3, FileTerminal, Loader2,
  Play, RefreshCw, ShieldCheck, Stethoscope, XCircle,
} from "lucide-react";

function formatError(error: unknown) {
  if (error && typeof error === "object") {
    const maybe = error as { code?: unknown; message?: unknown };
    if (typeof maybe.message === "string" && typeof maybe.code === "string") {
      return `${maybe.message}\n\n[${maybe.code}]`;
    }
    if (typeof maybe.message === "string") return maybe.message;
  }
  return String(error);
}

function statusStyle(status?: TestRunResult["status"]) {
  if (status === "passed") return "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-200";
  if (status === "timeout") return "border-amber-500/30 bg-amber-500/[0.06] text-amber-200";
  if (status === "failed") return "border-rose-500/30 bg-rose-500/[0.06] text-rose-200";
  return "border-white/10 bg-white/[0.02] text-zinc-400";
}

function ResultIcon({ status }: { status?: TestRunResult["status"] }) {
  if (status === "passed") return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  if (status === "timeout") return <Clock3 className="h-4 w-4 text-amber-400" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-rose-400" />;
  return <Stethoscope className="h-4 w-4 text-zinc-500" />;
}

export function HealerPanel() {
  const [snapshot, setSnapshot] = useState<TestRunnerSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [result, setResult] = useState<TestRunResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const selected = useMemo(
    () => snapshot?.profiles.find((profile) => profile.id === selectedId) ?? snapshot?.profiles[0],
    [snapshot, selectedId],
  );

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const next = await testRunnerSnapshot();
      setSnapshot(next);
      setSelectedId((current) => (
        next.profiles.some((profile) => profile.id === current)
          ? current
          : next.profiles[0]?.id ?? ""
      ));
    } catch (err) {
      setSnapshot(null);
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }

  async function run(profile: TestProfile) {
    setRunningId(profile.id);
    setResult(null);
    setError("");
    try {
      const next = await testRunnerRun(profile.id);
      setResult(next);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setRunningId(null);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const badge = runningId
    ? "Running…"
    : result?.status === "passed"
      ? "Passed"
      : result?.status === "failed"
        ? "Failed"
        : result?.status === "timeout"
          ? "Timed out"
          : loading
            ? "Loading"
            : "Ready";

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Native Test Runner"
        subtitle="Phase 6A · run backend-discovered test profiles with bounded native processes"
        badge={badge}
        badgeOk={result?.status === "passed" || (!result && !error && !loading)}
      />

      <div className="grid min-h-0 flex-1 grid-cols-[22rem_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-white/5 bg-[#0d1017]/40">
          <div className="border-b border-white/5 p-4">
            <div className="rounded-xl border border-cyan-500/15 bg-cyan-500/[0.04] p-3 text-[11.5px] leading-relaxed text-cyan-100/80">
              <div className="flex gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                <div>
                  DevLab does not accept arbitrary shell text here. Rust re-discovers test profiles from the selected workspace, runs the chosen backend-owned command without a shell, captures bounded output and kills it after {snapshot?.timeoutSecs ?? 60}s.
                </div>
              </div>
            </div>
            <button
              onClick={refresh}
              disabled={loading || !!runningId}
              className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-[12px] font-medium text-zinc-300 hover:bg-white/5 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh profiles
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {loading && (
              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-[12px] text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin text-cyan-400" /> Discovering test profiles…
              </div>
            )}

            {!loading && snapshot && snapshot.profiles.length === 0 && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-4 text-[12.5px] leading-relaxed text-amber-100/80">
                <AlertTriangle className="mb-2 h-5 w-5 text-amber-300" />
                No supported test profile was detected. Select a workspace with package.json test scripts, Cargo.toml, go.mod, pytest config or a tests/ directory.
              </div>
            )}

            {snapshot?.profiles.map((profile) => {
              const active = selected?.id === profile.id;
              const isRunning = runningId === profile.id;
              const profileResult = result?.profile.id === profile.id ? result.status : undefined;
              return (
                <button
                  key={profile.id}
                  onClick={() => setSelectedId(profile.id)}
                  className={`mb-2 w-full rounded-xl border p-3 text-left transition ${
                    active
                      ? "border-cyan-500/35 bg-cyan-500/[0.07]"
                      : "border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {isRunning ? <Loader2 className="h-4 w-4 animate-spin text-cyan-400" /> : <ResultIcon status={profileResult} />}
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-100">{profile.label}</span>
                  </div>
                  <div className="mt-2 rounded-md bg-black/25 px-2 py-1 font-mono text-[10.5px] text-zinc-500">
                    {profile.command}
                  </div>
                  <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-zinc-500">{profile.reason}</p>
                </button>
              );
            })}
          </div>

          {snapshot && (
            <div className="border-t border-white/5 p-3 text-[10.5px] leading-relaxed text-zinc-600">
              <div className="truncate">Workspace: <span className="text-zinc-400">{snapshot.workspaceName}</span></div>
              <div>Output cap: {(snapshot.maxOutputBytes / 1024 / 1024).toFixed(0)} MiB per stream</div>
            </div>
          )}
        </aside>

        <section className="flex min-h-0 flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-white/5 px-5 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-white">{selected?.label ?? "No profile selected"}</div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-600">{selected?.command ?? "Select a detected test command."}</div>
            </div>
            <button
              onClick={() => selected && run(selected)}
              disabled={!selected || !!runningId || loading}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-br from-rose-500 to-orange-500 px-4 py-2 text-[12.5px] font-semibold text-white shadow-lg shadow-rose-900/30 transition hover:from-rose-400 hover:to-orange-400 disabled:opacity-40"
            >
              {runningId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {runningId ? "Running…" : "Run tests"}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {error && (
              <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] p-4 text-[12.5px] leading-relaxed text-rose-100/90">
                <div className="mb-2 flex items-center gap-2 font-semibold text-rose-200">
                  <XCircle className="h-4 w-4" /> Native test runner error
                </div>
                <pre className="whitespace-pre-wrap font-mono text-[11.5px]">{error}</pre>
              </div>
            )}

            {snapshot?.warnings.map((warning) => (
              <div key={warning} className="mb-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-3 text-[12px] leading-relaxed text-amber-100/80">
                <AlertTriangle className="mr-2 inline h-4 w-4 text-amber-300" /> {warning}
              </div>
            ))}

            {!result && !runningId && !error && (
              <div className="flex min-h-[24rem] flex-col items-center justify-center gap-3 text-center text-zinc-600">
                <FileTerminal className="h-12 w-12" />
                <div>
                  <div className="text-sm font-semibold text-zinc-300">Run a real test profile</div>
                  <p className="mt-1 max-w-md text-[12.5px] leading-relaxed">
                    Choose a discovered profile on the left. DevLab will execute only that backend-owned command from the selected workspace, never a renderer-supplied shell string.
                  </p>
                </div>
              </div>
            )}

            {runningId && (
              <div className="flex min-h-[24rem] flex-col items-center justify-center gap-3 text-center text-zinc-500">
                <Loader2 className="h-10 w-10 animate-spin text-cyan-400" />
                <div className="text-sm font-semibold text-zinc-300">Tests are running…</div>
                <p className="text-[12px]">Native timeout: {snapshot?.timeoutSecs ?? 60}s. Output is captured with hard byte limits.</p>
              </div>
            )}

            {result && !runningId && (
              <div className="space-y-4">
                <div className={`rounded-xl border p-4 ${statusStyle(result.status)}`}>
                  <div className="flex items-center gap-2">
                    <ResultIcon status={result.status} />
                    <span className="text-sm font-semibold capitalize">{result.status}</span>
                    <span className="ml-auto font-mono text-[11px] opacity-80">{result.elapsedMs} ms</span>
                  </div>
                  <div className="mt-2 grid gap-2 text-[11.5px] sm:grid-cols-3">
                    <div>Exit code: <span className="font-mono">{result.exitCode ?? "—"}</span></div>
                    <div>Timed out: <span className="font-mono">{result.timedOut ? "yes" : "no"}</span></div>
                    <div>Truncated: <span className="font-mono">{result.outputTruncated ? "yes" : "no"}</span></div>
                  </div>
                </div>

                <OutputBlock title="stdout" value={result.stdout} tone="emerald" />
                <OutputBlock title="stderr" value={result.stderr} tone="rose" />
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function OutputBlock({ title, value, tone }: { title: string; value: string; tone: "emerald" | "rose" }) {
  const color = tone === "emerald" ? "text-emerald-300" : "text-rose-300";
  return (
    <div className="rounded-xl border border-white/10 bg-[#0a0c11] ring-soft">
      <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        <span className={color}>●</span> {title}
      </div>
      <pre className="max-h-[28rem] min-h-28 overflow-auto whitespace-pre-wrap p-4 font-mono text-[11.5px] leading-relaxed text-zinc-300">
        {value || `(no ${title})`}
      </pre>
    </div>
  );
}
