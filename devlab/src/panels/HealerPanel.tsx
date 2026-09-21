import { useEffect, useMemo, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { getApiKey, streamChat } from "../lib/gemini";
import { readWorkspaceFile } from "../lib/workspace";
import type { VFile } from "../types";
import {
  testRunnerRun,
  testRunnerSnapshot,
  type TestProfile,
  type TestRunResult,
  type TestRunnerSnapshot,
} from "../lib/testRunner";
import {
  AlertTriangle, ArrowRight, CheckCircle2, Clock3, FileTerminal, Loader2,
  Play, RefreshCw, ShieldCheck, Sparkles, Stethoscope, Wand2, XCircle,
} from "lucide-react";

const MAX_REPAIR_SOURCE_CHARS = 64 * 1024;
const MAX_REPAIR_OUTPUT_CHARS = 64 * 1024;
const MAX_TEST_EVIDENCE_CHARS = 24 * 1024;

interface RepairDraft {
  path: string;
  content: string;
  rationale: string;
}

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

function errorTitle(error: string) {
  return error.startsWith("Repair draft error:") ? "Repair draft error" : "Native test runner error";
}

function visibleError(error: string) {
  return error.replace(/^Repair draft error:\s*/, "");
}

function excerpt(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n… truncated for prompt (${value.length.toLocaleString()} characters total).`;
}

function languageForPath(path: string): string {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", java: "java", cs: "csharp",
    rb: "ruby", php: "php", json: "json", yml: "yaml", yaml: "yaml",
    md: "markdown", html: "html", css: "css", sql: "sql", sh: "shell",
    toml: "toml", xml: "xml", dockerfile: "dockerfile",
  };
  return map[extension] ?? "plaintext";
}

function stripJsonFence(value: string) {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

function normalizeRepairPath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function cargoManifestBase(evidence: string) {
  const match = evidence.match(/--manifest-path\s+([^\s]+?)\/Cargo\.toml/);
  return match?.[1]?.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "") ?? "";
}

function cargoRelativePath(path: string) {
  return /^(src|tests|test|benches|examples)\//.test(path) && path.endsWith(".rs");
}

function repairPathCandidates(input: string, result: TestRunResult) {
  const clean = normalizeRepairPath(input);
  const candidates = new Set<string>();
  if (clean) candidates.add(clean);
  const base = cargoManifestBase(`${result.profile.command}\n${result.stdout}\n${result.stderr}`);
  if (base && cargoRelativePath(clean) && !clean.startsWith(`${base}/`)) {
    candidates.add(`${base}/${clean}`);
  }
  return [...candidates];
}

function qualifyInferredRepairPath(path: string, evidence: string) {
  const clean = normalizeRepairPath(path);
  const base = cargoManifestBase(evidence);
  if (base && cargoRelativePath(clean) && !clean.startsWith(`${base}/`)) return `${base}/${clean}`;
  return clean;
}

function validateRepairContent(content: string) {
  const clean = content.replace(/^```[\w-]*\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!clean) throw new Error("Model response did not include a non-empty patched file.");
  if (clean.length > MAX_REPAIR_OUTPUT_CHARS) {
    throw new Error(`Repair draft exceeded ${(MAX_REPAIR_OUTPUT_CHARS / 1024).toFixed(0)} KiB. Narrow the target file or failing test output.`);
  }
  return clean;
}

function extractFencedFile(raw: string) {
  const matches = [...raw.matchAll(/```[\w-]*\s*\n([\s\S]*?)```/g)].map((match) => match[1]);
  if (matches.length === 0) return "";
  return matches.sort((left, right) => right.length - left.length)[0] ?? "";
}

function extractTaggedRepair(raw: string) {
  const rationale = raw.match(/<devlab-rationale>([\s\S]*?)<\/devlab-rationale>/i)?.[1]?.trim() ?? "";
  const content = raw.match(/<devlab-patched-file>([\s\S]*?)<\/devlab-patched-file>/i)?.[1] ?? "";
  return content ? { rationale, content } : null;
}

function parseRepairDraft(raw: string, path: string): RepairDraft {
  const cleaned = stripJsonFence(raw);
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(cleaned.slice(first, last + 1)) as { patched?: unknown; rationale?: unknown };
      if (typeof parsed.patched === "string") {
        return {
          path,
          content: validateRepairContent(parsed.patched),
          rationale: typeof parsed.rationale === "string" ? parsed.rationale : "No rationale returned.",
        };
      }
    } catch {
      // Whole-file JSON is brittle for source code. Fall through to tags/fences.
    }
  }

  const tagged = extractTaggedRepair(raw);
  if (tagged) {
    return {
      path,
      content: validateRepairContent(tagged.content),
      rationale: tagged.rationale || "Repair draft generated from the failing native test output.",
    };
  }

  const fenced = extractFencedFile(raw);
  if (fenced) {
    const rationale = raw.slice(0, raw.indexOf("```")).replace(/^(rationale|reasoning)\s*:\s*/i, "").trim();
    return {
      path,
      content: validateRepairContent(fenced),
      rationale: rationale || "Repair draft generated from the failing native test output.",
    };
  }

  throw new Error("Model response did not include valid JSON, DevLab repair tags, or a fenced patched file.");
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

export function HealerPanel({
  onOpenFiles,
  onNeedKey,
}: {
  onOpenFiles: (files: VFile[]) => void;
  onNeedKey: () => void;
}) {
  const [snapshot, setSnapshot] = useState<TestRunnerSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [result, setResult] = useState<TestRunResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [repairPath, setRepairPath] = useState("");
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairDraft, setRepairDraft] = useState<RepairDraft | null>(null);
  const [repairNotice, setRepairNotice] = useState("");

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
      setRepairDraft(null);
      setRepairNotice("");
      const evidence = `${next.profile.command}\n${next.stdout}\n${next.stderr}`;
      const inferred = inferRepairPath(evidence);
      if (inferred) setRepairPath((current) => current || inferred);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setRunningId(null);
    }
  }

  function inferRepairPath(output: string) {
    const match = output.match(/(?:^|\s)((?:src|test|tests|benches|examples|app|lib|packages|crates)\/[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|php|json|yml|yaml|toml|md|css|html))/m);
    return match ? qualifyInferredRepairPath(match[1], output) : "";
  }

  async function generateRepairDraft() {
    if (!result || result.status === "passed") return;
    if (!repairPath.trim()) {
      setError("Enter the failing source-file path to draft a repair.");
      return;
    }
    if (!getApiKey()) {
      onNeedKey();
      return;
    }
    setRepairBusy(true);
    setError("");
    setRepairNotice("");
    setRepairDraft(null);
    try {
      let targetPath = "";
      let document: Awaited<ReturnType<typeof readWorkspaceFile>> | null = null;
      let lastReadError: unknown = null;
      const candidates = repairPathCandidates(repairPath, result);
      for (const candidate of candidates) {
        try {
          document = await readWorkspaceFile(candidate);
          targetPath = candidate;
          break;
        } catch (err) {
          lastReadError = err;
        }
      }
      if (!document) {
        throw new Error(`Could not read the repair target. Tried: ${candidates.join(", ") || "(none)"}. ${formatError(lastReadError)}`);
      }
      if (targetPath !== repairPath.trim()) setRepairPath(targetPath);
      if (document.content.length > MAX_REPAIR_SOURCE_CHARS) {
        throw new Error(`Repair drafts accept source files up to ${(MAX_REPAIR_SOURCE_CHARS / 1024).toFixed(0)} KiB for this checkpoint.`);
      }
      const prompt = `You are DevLab's reviewed repair assistant. A real native test run failed.

Rules:
- Patch exactly this one file: ${targetPath}
- Return the ENTIRE patched file, not a diff.
- Do not invent test results.
- Preserve public APIs unless the test output requires a change.
- If the evidence is insufficient, make the smallest defensive fix and explain uncertainty in rationale.
- Prefer this exact response format so DevLab can parse source code safely:
<devlab-rationale>
short explanation of the root cause and fix
</devlab-rationale>
<devlab-patched-file>
\`\`\`text
complete patched file contents
\`\`\`
</devlab-patched-file>

TEST PROFILE: ${result.profile.label}
COMMAND: ${result.profile.command}
STATUS: ${result.status}
EXIT CODE: ${result.exitCode ?? "none"}
TIMED OUT: ${result.timedOut ? "yes" : "no"}
OUTPUT TRUNCATED: ${result.outputTruncated ? "yes" : "no"}

STDOUT:
\`\`\`
${excerpt(result.stdout, MAX_TEST_EVIDENCE_CHARS)}
\`\`\`

STDERR:
\`\`\`
${excerpt(result.stderr, MAX_TEST_EVIDENCE_CHARS)}
\`\`\`

CURRENT FILE ${targetPath}:
\`\`\`
${document.content}
\`\`\``;

      let raw = "";
      for await (const chunk of streamChat([{ role: "user", text: prompt }])) raw += chunk;
      const draft = parseRepairDraft(raw, targetPath);
      setRepairDraft(draft);
      setRepairNotice("Repair draft generated in memory. Review it before sending it to the editor draft flow.");
    } catch (err) {
      setError(`Repair draft error: ${formatError(err)}`);
    } finally {
      setRepairBusy(false);
    }
  }

  function openRepairDraft() {
    if (!repairDraft) return;
    onOpenFiles([{
      path: repairDraft.path,
      content: repairDraft.content,
      language: languageForPath(repairDraft.path),
    }]);
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
        subtitle="Phase 6C · native tests plus reviewed draft application"
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
                  <XCircle className="h-4 w-4" /> {errorTitle(error)}
                </div>
                <pre className="whitespace-pre-wrap font-mono text-[11.5px]">{visibleError(error)}</pre>
              </div>
            )}

            {snapshot?.warnings.map((warning) => (
              <div key={warning} className="mb-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-3 text-[12px] leading-relaxed text-amber-100/80">
                <AlertTriangle className="mr-2 inline h-4 w-4 text-amber-300" /> {warning}
              </div>
            ))}

            {repairNotice && (
              <div className="mb-4 rounded-xl border border-violet-500/25 bg-violet-500/[0.06] p-3 text-[12px] leading-relaxed text-violet-100/80">
                <Sparkles className="mr-2 inline h-4 w-4 text-violet-300" /> {repairNotice}
              </div>
            )}

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

                {result.status !== "passed" && (
                  <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-4 ring-soft">
                    <div className="flex items-start gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 ring-1 ring-violet-500/20">
                        <Wand2 className="h-4.5 w-4.5 text-violet-300" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-violet-100">Reviewed repair draft</div>
                        <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
                          Optional Phase 6B assistant: read one existing source file, use this real test output as evidence, and generate an in-memory draft. Nothing is written automatically.
                        </p>
                        <div className="mt-3 flex gap-2">
                          <input
                            value={repairPath}
                            onChange={(event) => setRepairPath(event.target.value)}
                            placeholder="src/path/to/failing-file.ts"
                            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2 font-mono text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-violet-500/50"
                          />
                          <button
                            onClick={generateRepairDraft}
                            disabled={repairBusy || !repairPath.trim()}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-2 text-[12px] font-semibold text-white hover:bg-violet-400 disabled:opacity-40"
                          >
                            {repairBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                            Draft fix
                          </button>
                        </div>
                        {repairDraft && (
                          <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3">
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-violet-300">Rationale</div>
                            <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-300">{repairDraft.rationale}</p>
                            <button
                              onClick={openRepairDraft}
                              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-[12px] font-semibold text-violet-100 hover:bg-violet-500/20"
                            >
                              <ArrowRight className="h-3.5 w-3.5" /> Open draft in editor review
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

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
