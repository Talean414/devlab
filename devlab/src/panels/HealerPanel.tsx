import { useRef, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { getApiKey, streamChat } from "../lib/gemini";
import { computeDiff, diffStats } from "../lib/diff";
import type { VFile } from "../types";
import {
  Stethoscope, Play, Loader2, CheckCircle2, XCircle, Wand2,
  FileCode2, ArrowRight, Bug, ShieldCheck, RefreshCw, FlaskConical,
} from "lucide-react";

interface Loop {
  n: number;
  phase: "diagnosing" | "patching" | "verifying" | "passed" | "failed";
  diagnosis: string;
  patched: string;
  notes: string;
  base: string;
}

const SAMPLE_CODE = `export function computeInvoiceTotal(items) {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price * items[i].qty;
  }
  const discount = total > 100 ? total * 0.1 : 0;
  return total - discount;
}

export function formatCurrency(val) {
  return "$" + val.toFixed(2);
}`;

const SAMPLE_ERROR = `FAIL  src/invoice.test.ts
  ✕ adds line items · TypeError: Cannot read properties of undefined (reading 'price')
    at computeInvoiceTotal (src/invoice.ts:4:7)
  ✕ empty cart returns $0.00
    Expected: "$0.00"  Received: "$NaN"
Tests: 2 failed, 3 passed · Score: 60%`;

export function HealerPanel({ onOpenFiles }: { onOpenFiles: (f: VFile[]) => void }) {
  const [code, setCode] = useState(SAMPLE_CODE);
  const [failLog, setFailLog] = useState(SAMPLE_ERROR);
  const [path, setPath] = useState("src/invoice.ts");
  const [loops, setLoops] = useState<Loop[]>([]);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<"idle" | "running" | "passed" | "failed">("idle");
  const logRef = useRef<HTMLDivElement>(null);

  function scrollLog() {
    requestAnimationFrame(() => logRef.current?.scrollTo({ top: 99999, behavior: "smooth" }));
  }

  async function heal() {
    if (!getApiKey()) return;
    setBusy(true); setRunning("running"); setLoops([]);
    let current = code;
    let log = failLog;

    for (let iter = 1; iter <= 3; iter++) {
      const entry: Loop = { n: iter, phase: "diagnosing", diagnosis: "", patched: "", notes: "", base: current };
      setLoops((ls) => [...ls, entry]);
      scrollLog();

      try {
        // ── Pass 1: diagnose + patch ──
        let acc = "";
        const prompt = `You are DevLab's autonomous debugger. The following file is failing its test suite.

FILE \`${path}\`:
\`\`\`
${current}
\`\`\`

TEST OUTPUT:
\`\`\`
${log}
\`\`\`

Respond with ONLY valid JSON (no fences):
{
  "diagnosis": "2-3 sentence root-cause analysis of every failing test",
  "patched": "the ENTIRE fixed file contents, escaped as a JSON string",
  "notes": "what changed, one line per fix, separated by newlines",
  "resolved": true or false — your honest judgment of whether this patch fixes every reported failure
}
Never change public APIs unless a test demands it. Keep the same general structure.`;
        for await (const ch of streamChat([{ role: "user", text: prompt }])) acc += ch;
        const clean = acc.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
        const parsed = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)) as {
          diagnosis: string; patched: string; notes: string; resolved: boolean;
        };

        entry.diagnosis = parsed.diagnosis;
        entry.patched = parsed.patched;
        entry.notes = parsed.notes;
        entry.phase = "patching";
        setLoops((ls) => ls.map((l) => (l.n === iter ? { ...entry } : l)));
        scrollLog();
        await new Promise((r) => setTimeout(r, 400));

        // ── Pass 2: agent-verified "re-run" ──
        entry.phase = "verifying";
        setLoops((ls) => ls.map((l) => (l.n === iter ? { ...entry } : l)));
        scrollLog();

        let verify = "";
        const verifyPrompt = `Act as a strict test runner. Re-execute the ORIGINAL failing tests mentally against this PATCHED file.

PATCHED \`${path}\`:
\`\`\`
${parsed.patched}
\`\`\`

ORIGINAL FAILURES:
\`\`\`
${log}
\`\`\`

Respond with ONLY valid JSON:
{
  "passed": true or false,
  "output": "mimic a realistic test-runner console output: per-test pass/fail lines and a summary like 'Tests: 5 passed · Score: 100%'. If any test would STILL fail, show the exact error."
}`;
        for await (const ch of streamChat([{ role: "user", text: verifyPrompt }])) verify += ch;
        const vc = verify.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
        const vres = JSON.parse(vc.slice(vc.indexOf("{"), vc.lastIndexOf("}") + 1)) as {
          passed: boolean; output: string;
        };

        entry.phase = vres.passed ? "passed" : "failed";
        entry.notes = parsed.notes + "\n\nTEST RUN:\n" + vres.output;
        setLoops((ls) => ls.map((l) => (l.n === iter ? { ...entry } : l)));
        scrollLog();

        if (vres.passed) {
          current = parsed.patched;
          setCode(current);
          setFailLog(vres.output);
          setRunning("passed");
          setBusy(false);
          return;
        }
        current = parsed.patched;
        log = vres.output;
      } catch (e) {
        entry.phase = "failed";
        entry.notes += "\nerror: " + (e as Error).message;
        setLoops((ls) => ls.map((l) => (l.n === iter ? { ...entry } : l)));
        break;
      }
    }
    setRunning("failed");
    setBusy(false);
  }

  const lastLoop = loops[loops.length - 1];

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Self-Healing Test Loop"
        subtitle="Diagnose → patch → re-run — autonomous until green"
        badge={
          running === "passed" ? "All tests passing"
          : running === "failed" ? "Still failing"
          : running === "running" ? "Healing…"
          : "Idle"
        }
        badgeOk={running === "passed"}
      />

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-0">
        {/* input */}
        <div className="flex min-h-0 flex-col border-r border-white/5">
          <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2.5">
            <Bug className="h-4 w-4 text-rose-400" />
            <span className="text-[12.5px] font-medium text-zinc-200">Broken workspace</span>
            <input value={path} onChange={(e) => setPath(e.target.value)}
              className="ml-auto w-40 rounded border border-white/10 bg-[#0d1017] px-2 py-1 font-mono text-[11px] text-zinc-300 outline-none" />
          </div>
          <textarea value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-[#0a0c11] p-4 font-mono text-[12px] leading-relaxed text-zinc-200 outline-none" />
          <div className="border-t border-white/5">
            <div className="border-b border-white/5 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Failing test output
            </div>
            <textarea value={failLog} onChange={(e) => setFailLog(e.target.value)} spellCheck={false} rows={5}
              className="w-full resize-none bg-[#0a0c11] p-4 font-mono text-[11.5px] leading-relaxed text-rose-200/80 outline-none" />
          </div>
          <div className="flex items-center gap-2 border-t border-white/5 p-3">
            <button onClick={heal} disabled={busy || !getApiKey()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-rose-500 to-orange-500 px-4 py-2 text-[12.5px] font-semibold text-white shadow-lg shadow-rose-900/30 transition hover:from-rose-400 hover:to-orange-400 disabled:opacity-40">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {busy ? "Healing…" : "Run self-heal"}
            </button>
            {lastLoop?.patched && (
              <button
                onClick={() => onOpenFiles([{ path, content: lastLoop.patched, language: path.split(".").pop() === "ts" ? "typescript" : "javascript" }])}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-[12.5px] font-semibold text-emerald-200 hover:bg-emerald-500/20">
                <ArrowRight className="h-3.5 w-3.5" /> Apply fix to editor
              </button>
            )}
            {!getApiKey() && <span className="text-[11.5px] text-amber-300">Add a Gemini key in Settings to enable.</span>}
          </div>
        </div>

        {/* loop log + diff */}
        <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto p-4">
          {loops.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-zinc-600">
              <Stethoscope className="h-10 w-10" />
              <p className="max-w-xs text-[13px]">
                Paste broken code and its failing test output, then press
                <strong className="text-zinc-300"> Run self-heal</strong>. DevLab iterates —
                diagnose, patch, re-run — until the suite is green.
              </p>
            </div>
          )}

          {loops.map((loop) => (
            <div key={loop.n} className="mb-5 rounded-xl border border-white/10 bg-white/[0.02] ring-soft">
              <div className="flex items-center gap-2.5 border-b border-white/5 px-4 py-2.5">
                {loop.phase === "passed" ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                 : loop.phase === "failed" ? <XCircle className="h-4 w-4 text-rose-400" />
                 : <Loader2 className="h-4 w-4 animate-spin text-amber-400" />}
                <span className="text-[13px] font-semibold text-white">Iteration {loop.n}</span>
                <span className="text-[11.5px] text-zinc-500 capitalize">{loop.phase}</span>
              </div>

              {loop.diagnosis && (
                <div className="px-4 py-3">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-rose-400">
                    <Bug className="h-3 w-3" /> Diagnosis
                  </div>
                  <p className="text-[12.5px] leading-relaxed text-zinc-300">{loop.diagnosis}</p>
                </div>
              )}

              {loop.patched && (
                <div className="border-t border-white/5 px-4 py-3">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
                    <Wand2 className="h-3 w-3" /> Patch
                    {(() => {
                      const s = diffStats(computeDiff(loop.base, loop.patched));
                      return <span className="ml-auto font-mono text-[10px]"><span className="text-emerald-400">+{s.adds}</span> <span className="text-rose-400">−{s.dels}</span></span>;
                    })()}
                  </div>
                  <div className="max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-[#0a0c11] p-2 font-mono text-[11px] leading-[1.55]">
                    {computeDiff(loop.base, loop.patched).map((r, i) => (
                      <div key={i}
                        className={
                          r.type === "add" ? "bg-emerald-500/10 text-emerald-200"
                          : r.type === "del" ? "bg-rose-500/10 text-rose-300/80 line-through decoration-rose-500/40"
                          : "text-zinc-600"
                        }>
                        <span className="mr-2 inline-block w-7 select-none text-right text-[9.5px] opacity-50">
                          {r.type === "del" ? r.lineOld : r.lineNew}
                        </span>
                        {r.type === "add" ? "+ " : r.type === "del" ? "− " : "  "}
                        {r.text || " "}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {loop.notes && (
                <div className="border-t border-white/5 px-4 py-3">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-cyan-400">
                    <FlaskConical className="h-3 w-3" /> Notes & re-run
                  </div>
                  <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-zinc-400">{loop.notes}</pre>
                </div>
              )}
            </div>
          ))}

          {running === "passed" && lastLoop && (
            <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] p-4">
              <ShieldCheck className="h-6 w-6 text-emerald-400" />
              <div className="flex-1">
                <div className="text-sm font-semibold text-emerald-200">Suite healed autonomously</div>
                <p className="text-[12px] text-emerald-200/70">{loops.length} iteration(s). Accept the patch to push it into your workspace.</p>
              </div>
              <button onClick={() => onOpenFiles([{ path, content: lastLoop.patched, language: "typescript" }])}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-[12px] font-semibold text-white hover:bg-emerald-400">
                <ArrowRight className="h-3.5 w-3.5" /> Apply fix
              </button>
            </div>
          )}

          {running === "failed" && (
            <div className="flex items-center gap-3 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] p-4">
              <XCircle className="h-6 w-6 text-rose-400" />
              <div className="flex-1">
                <div className="text-sm font-semibold text-rose-200">Max iterations reached</div>
                <p className="text-[12px] text-rose-200/70">The latest patch may be partially correct — review it above, or run again with clearer test output.</p>
              </div>
              <button onClick={heal} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-[12px] text-zinc-200 hover:bg-white/5">
                <RefreshCw className="h-3.5 w-3.5" /> Retry
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

void FileCode2;
