import { useEffect, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import {
  getApiKey, setApiKey, clearApiKey, getModel, setModel,
  verifyKey, listAvailableModels, pickBestModel, getPicked,
} from "../lib/gemini";
import type { ModelInfo } from "../lib/gemini";
import {
  loadSettings, saveSettings, DEFAULT_SETTINGS, THEMES, ALL_PANELS,
  type DevLabSettings, type ThemeId, type Autonomy, type Density,
} from "../lib/settings";
import {
  Eye, EyeOff, Save, RefreshCw, Trash2, Shield, KeyRound, CheckCircle2,
  Sparkles, Palette, LayoutGrid, Bot, SlidersHorizontal, RotateCcw, Cpu,
} from "lucide-react";

const TABS = [
  { id: "appearance", label: "Appearance", Icon: Palette },
  { id: "layout",     label: "Layout",     Icon: LayoutGrid },
  { id: "agent",      label: "Agent",      Icon: Bot },
  { id: "provider",   label: "Providers",  Icon: Cpu },
  { id: "advanced",   label: "Advanced",   Icon: SlidersHorizontal },
] as const;

export function SettingsPanel({ onKeyChange, onSettingsChange }: {
  onKeyChange: () => void;
  onSettingsChange: () => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("appearance");
  const [s, setS] = useState<DevLabSettings>(loadSettings);
  const [key, setKey] = useState(getApiKey());
  const [model, setModelState] = useState(getModel());
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState<"idle" | "checking" | "ok" | "bad">("idle");
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [autoPicked, setAutoPicked] = useState<string | null>(getPicked());

  function update(patch: Partial<DevLabSettings>) {
    const next = { ...s, ...patch };
    setS(next); saveSettings(next); onSettingsChange();
  }

  async function refreshModels() {
    setApiKey(key);
    const models = await listAvailableModels();
    setAvailableModels(models);
    const best = await pickBestModel();
    setAutoPicked(best);
    if (best && models.length) {
      const ids = new Set(models.map((m) => m.name.replace("models/", "")));
      if (!ids.has(model)) setModelState(best);
    }
  }

  useEffect(() => {
    if (key.trim().length > 10) refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function test() {
    setApiKey(key); setStatus("checking");
    const ok = await verifyKey();
    setStatus(ok ? "ok" : "bad");
    if (ok) await refreshModels();
    onKeyChange();
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Settings" subtitle="Make DevLab exactly as big or as small as you need" />

      <div className="flex gap-5 border-b border-white/5 bg-[#0d1017]/40 px-6 text-xs">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 py-3 font-medium ${
              tab === t.id ? "border-cyan-400 text-white" : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}>
            <t.Icon className="h-3.5 w-3.5" /> {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-7">
        <div className="mx-auto max-w-2xl space-y-6">

          {/* ── Appearance ── */}
          {tab === "appearance" && (
            <>
              <Card title="Theme" desc="Re-skins the entire lab, including the code editor.">
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {THEMES.map((t) => (
                    <button key={t.id} onClick={() => update({ theme: t.id as ThemeId })}
                      className={`rounded-xl border p-3 text-left transition ${
                        s.theme === t.id ? "border-cyan-500/50 bg-cyan-500/10" : "border-white/10 hover:bg-white/5"
                      }`}>
                      <div className="flex gap-1.5">
                        <span className="h-5 w-5 rounded" style={{ background: t.bg, boxShadow: "inset 0 0 0 1px #ffffff20" }} />
                        <span className="h-5 w-5 rounded" style={{ background: t.accent }} />
                        <span className="h-5 w-5 rounded" style={{ background: t.accent2 }} />
                      </div>
                      <div className="mt-2 text-[12.5px] font-medium text-zinc-100">{t.name}</div>
                      {s.theme === t.id && <div className="text-[10.5px] text-cyan-400">Active</div>}
                    </button>
                  ))}
                </div>
              </Card>

              <Card title="Density" desc="Compact mode tightens padding and hides the editor minimap.">
                <div className="flex gap-2">
                  {(["comfortable", "compact"] as Density[]).map((d) => (
                    <button key={d} onClick={() => update({ density: d })}
                      className={`flex-1 rounded-lg border px-4 py-2.5 text-sm capitalize transition ${
                        s.density === d ? "border-cyan-500/50 bg-cyan-500/10 text-white" : "border-white/10 text-zinc-400 hover:bg-white/5"
                      }`}>{d}</button>
                  ))}
                </div>
              </Card>

              <Card title="Editor font size" desc={`Currently ${s.fontSize}px`}>
                <input type="range" min={11} max={20} value={s.fontSize}
                  onChange={(e) => update({ fontSize: Number(e.target.value) })}
                  className="w-full accent-cyan-500" />
                <div className="flex justify-between text-[11px] text-zinc-600"><span>11px</span><span>20px</span></div>
              </Card>
            </>
          )}

          {/* ── Layout ── */}
          {tab === "layout" && (
            <>
              <Card title="Visible panels" desc="Hide anything you don't use — the sidebar shrinks to match.">
                <div className="space-y-1">
                  {ALL_PANELS.map((p) => {
                    const on = s.visiblePanels.includes(p.id);
                    return (
                      <div key={p.id} className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-white/[0.03]">
                        <span className="text-[13px] text-zinc-200">
                          {p.label}
                          {p.core && <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-500">core</span>}
                        </span>
                        <Switch on={on} disabled={p.core}
                          onChange={(v) => update({
                            visiblePanels: v
                              ? [...s.visiblePanels, p.id]
                              : s.visiblePanels.filter((x) => x !== p.id),
                          })} />
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 flex gap-2">
                  <button onClick={() => update({ visiblePanels: ALL_PANELS.map((p) => p.id) })}
                    className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-zinc-300 hover:bg-white/5">Show all</button>
                  <button onClick={() => update({ visiblePanels: ALL_PANELS.filter((p) => p.core).map((p) => p.id) })}
                    className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-zinc-300 hover:bg-white/5">Minimal</button>
                </div>
              </Card>

              <Card title="Interface" desc="">
                <Row label="Show status bar" desc="The gradient bar along the bottom."
                  on={s.showStatusBar} onChange={(v) => update({ showStatusBar: v })} />
                <Row label="Show sidebar tooltips" desc="Hover labels and keyboard shortcuts."
                  on={s.showTooltips} onChange={(v) => update({ showTooltips: v })} />
                <Row label="Open Home on start" desc="Otherwise DevLab restores the AI Agent."
                  on={s.showWelcomeOnStart} onChange={(v) => update({ showWelcomeOnStart: v })} />
              </Card>
            </>
          )}

          {/* ── Agent ── */}
          {tab === "agent" && (
            <>
              <Card title="Autonomy level" desc="How much the agent may do without asking you first.">
                <div className="space-y-2">
                  {([
                    { id: "ask",     t: "Ask first",  d: "Every action needs explicit confirmation." },
                    { id: "suggest", t: "Suggest",    d: "Agent proposes changes; you approve each batch." },
                    { id: "auto",    t: "Autonomous", d: "Agent executes allowed actions on its own." },
                  ] as { id: Autonomy; t: string; d: string }[]).map((o) => (
                    <button key={o.id} onClick={() => update({ autonomy: o.id })}
                      className={`flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition ${
                        s.autonomy === o.id ? "border-cyan-500/50 bg-cyan-500/10" : "border-white/10 hover:bg-white/5"
                      }`}>
                      <span className={`mt-1 h-3 w-3 shrink-0 rounded-full border-2 ${s.autonomy === o.id ? "border-cyan-400 bg-cyan-400" : "border-zinc-600"}`} />
                      <span>
                        <span className="block text-[13.5px] font-medium text-zinc-100">{o.t}</span>
                        <span className="block text-[12px] text-zinc-500">{o.d}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </Card>

              <Card title="Permitted actions" desc="Fine-grained control over what the agent can touch.">
                <Row label="Write files" desc="Create and modify files in your workspace."
                  on={s.allowWriteFiles} onChange={(v) => update({ allowWriteFiles: v })} />
                <Row label="Run shell commands" desc="Execute commands in the integrated terminal."
                  on={s.allowRunCommands} onChange={(v) => update({ allowRunCommands: v })} />
                <Row label="Create git commits" desc="Stage and commit changes on your behalf."
                  on={s.allowGitCommit} onChange={(v) => update({ allowGitCommit: v })} />
                <Row label="Push to remote" desc="Push commits to the connected repository."
                  on={s.allowGitPush} onChange={(v) => update({ allowGitPush: v })} />
                <Row label="Trigger deployments" desc="Run deploy commands for Vercel, Render, Railway etc."
                  on={s.allowDeploy} onChange={(v) => update({ allowDeploy: v })} />
              </Card>

              <Card title="Custom system prompt" desc="Prepended to every agent conversation. Leave blank for the default.">
                <textarea value={s.systemPrompt} onChange={(e) => update({ systemPrompt: e.target.value })}
                  rows={4} placeholder="e.g. Always use pnpm, prefer functional patterns, target Node 22…"
                  className="w-full resize-none rounded-lg border border-white/10 bg-[#0d1017] p-3 text-[13px] text-zinc-100 outline-none focus:border-cyan-500/50" />
              </Card>
            </>
          )}

          {/* ── Providers ── */}
          {tab === "provider" && (
            <>
              <div className="flex gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-4 text-[13px] text-amber-200/90">
                <Shield className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <strong>Security:</strong> keys are stored in this browser's localStorage and sent
                  only to the provider's official endpoint. Rotate any key you have pasted publicly.
                </div>
              </div>

              <Card title="AI provider" desc="Gemini works out of the box. Others require the native build or a local proxy.">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {([
                    ["gemini", "Google Gemini"], ["openai", "OpenAI"], ["anthropic", "Anthropic"],
                    ["ollama", "Ollama (local)"], ["custom", "Custom endpoint"],
                  ] as const).map(([id, label]) => (
                    <button key={id} onClick={() => update({ aiProvider: id })}
                      className={`rounded-lg border px-3 py-2.5 text-[12.5px] transition ${
                        s.aiProvider === id ? "border-cyan-500/50 bg-cyan-500/10 text-white" : "border-white/10 text-zinc-400 hover:bg-white/5"
                      }`}>{label}</button>
                  ))}
                </div>
                {s.aiProvider !== "gemini" && (
                  <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-[12.5px] text-zinc-400">
                    {s.aiProvider === "ollama"
                      ? "Run `ollama serve` locally, then set the endpoint to http://localhost:11434/v1."
                      : "Browser CORS blocks direct calls to this provider. Use it in the native DevLab build or via a local proxy."}
                  </div>
                )}
                {(s.aiProvider === "custom" || s.aiProvider === "ollama") && (
                  <input value={s.customEndpoint} onChange={(e) => update({ customEndpoint: e.target.value })}
                    placeholder="http://localhost:11434/v1"
                    className="mt-3 w-full rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-cyan-500/50" />
                )}
              </Card>

              <Card title="Google AI Studio API key" desc="Free tier is plenty for development.">
                <div className="flex gap-2">
                  <input type={show ? "text" : "password"} value={key} onChange={(e) => setKey(e.target.value)}
                    placeholder="AIza… (from aistudio.google.com/app/apikey)"
                    className="flex-1 rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-cyan-500/50" />
                  <button onClick={() => setShow((v) => !v)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 text-xs text-zinc-400 hover:bg-white/5">
                    {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>

                <div className="mb-2 mt-4 flex items-center justify-between">
                  <label className="text-[13px] font-medium text-zinc-300">Model</label>
                  {autoPicked && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10.5px] font-medium text-emerald-300">
                      <Sparkles className="h-2.5 w-2.5" /> Auto-picked: {autoPicked}
                    </span>
                  )}
                </div>
                <select value={model} onChange={(e) => { setModelState(e.target.value); setModel(e.target.value); onKeyChange(); }}
                  className="w-full rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-cyan-500/50">
                  {(availableModels.length > 0 ? availableModels.map((m) => m.name.replace("models/", "")) : [model])
                    .map((m) => <option key={m} value={m} className="text-zinc-900">{m}</option>)}
                </select>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button onClick={() => { setApiKey(key); setModel(model); onKeyChange(); }}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 px-4 py-2 text-sm font-semibold text-white hover:from-cyan-400 hover:to-blue-500">
                    <Save className="h-3.5 w-3.5" /> Save
                  </button>
                  <button onClick={test} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-200 hover:bg-white/5">
                    <RefreshCw className="h-3.5 w-3.5" /> Test
                  </button>
                  <button onClick={() => { clearApiKey(); setKey(""); setStatus("idle"); onKeyChange(); }}
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-rose-400 hover:bg-rose-500/10">
                    <Trash2 className="h-3.5 w-3.5" /> Clear
                  </button>
                  {status === "checking" && <span className="text-sm text-zinc-400">Checking…</span>}
                  {status === "ok" && <span className="inline-flex items-center gap-1 text-sm text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> Valid</span>}
                  {status === "bad" && <span className="text-sm text-rose-400">Invalid key</span>}
                </div>
              </Card>

              <Card title="Generation parameters" desc="">
                <label className="mb-1.5 block text-[12px] text-zinc-400">Temperature — {s.temperature.toFixed(2)}</label>
                <input type="range" min={0} max={2} step={0.05} value={s.temperature}
                  onChange={(e) => update({ temperature: Number(e.target.value) })} className="w-full accent-cyan-500" />
                <label className="mb-1.5 mt-4 block text-[12px] text-zinc-400">Max output tokens — {s.maxTokens}</label>
                <input type="range" min={512} max={16384} step={512} value={s.maxTokens}
                  onChange={(e) => update({ maxTokens: Number(e.target.value) })} className="w-full accent-cyan-500" />
              </Card>
            </>
          )}

          {/* ── Advanced ── */}
          {tab === "advanced" && (
            <>
              <Card title="Export / import configuration" desc="Move your setup between machines.">
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => {
                      const blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" });
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(blob); a.download = "devlab-settings.json"; a.click();
                    }}
                    className="rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-200 hover:bg-white/5">
                    Export settings
                  </button>
                  <label className="cursor-pointer rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-200 hover:bg-white/5">
                    Import settings
                    <input type="file" accept="application/json" className="hidden"
                      onChange={async (e) => {
                        const f = e.target.files?.[0]; if (!f) return;
                        try { update(JSON.parse(await f.text())); } catch { /* ignore */ }
                      }} />
                  </label>
                </div>
              </Card>

              <Card title="Reset" desc="Restore every preference to its default value.">
                <button
                  onClick={() => { if (confirm("Reset all DevLab settings?")) update(DEFAULT_SETTINGS); }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300 hover:bg-rose-500/20">
                  <RotateCcw className="h-3.5 w-3.5" /> Reset to defaults
                </button>
              </Card>

              <Card title="Local data" desc="Everything DevLab stores lives in this browser.">
                <ul className="space-y-1.5 text-[12.5px] text-zinc-400">
                  <li><code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">devlab.settings.v1</code> — preferences</li>
                  <li><code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">devlab.gemini.key</code> — AI key</li>
                  <li><code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">devlab.git.v1</code> — repo config + token</li>
                  <li><code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">devlab.deploy.v1</code> — deploy tokens</li>
                  <li><code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">devlab.files.v1</code> — editor workspace</li>
                </ul>
                <button
                  onClick={() => { if (confirm("Erase ALL DevLab data from this browser?")) { localStorage.clear(); location.reload(); } }}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300 hover:bg-rose-500/20">
                  <Trash2 className="h-3.5 w-3.5" /> Erase all local data
                </button>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.02] p-6 ring-soft">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      {desc && <p className="mb-4 mt-0.5 text-[12.5px] text-zinc-500">{desc}</p>}
      {!desc && <div className="mb-3" />}
      {children}
    </section>
  );
}

function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button disabled={disabled} onClick={() => onChange(!on)}
      className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition ${
        on ? "bg-cyan-500" : "bg-white/10"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}>
      <span className={`h-4 w-4 rounded-full bg-white transition ${on ? "translate-x-4" : ""}`} />
    </button>
  );
}

function Row({ label, desc, on, onChange }: { label: string; desc: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg px-1 py-2.5 transition hover:bg-white/[0.03]">
      <div>
        <div className="text-[13px] font-medium text-zinc-100">{label}</div>
        <div className="text-[11.5px] text-zinc-500">{desc}</div>
      </div>
      <div className="pt-0.5"><Switch on={on} onChange={onChange} /></div>
    </div>
  );
}

void KeyRound;
