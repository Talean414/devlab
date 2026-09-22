import { useEffect, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import {
  getApiKey, setApiKey, clearApiKey, getModel, setModel,
  verifyKey, listAvailableModels, pickBestModel, getPicked,
} from "../lib/gemini";
import type { ModelInfo } from "../lib/gemini";
import {
  loadSettings, saveSettings, DEFAULT_SETTINGS, THEMES, ALL_PANELS,
  type DevLabSettings, type ThemeId, type Autonomy, type Density, type AiProviderId, type ModelRoutingMode,
} from "../lib/settings";
import { starterBlueprintInstruction } from "../lib/generationBlueprints";
import { componentScaffoldInstruction, designSystemInstruction, qualityChecklistInstruction, summarizeGenerationGuidance } from "../lib/generationGuidance";
import {
  BUILTIN_SECRET_ALLOW_EXCEPTIONS, BUILTIN_SECRET_DENY_PATTERNS, MAX_POLICY_PATTERNS,
  describeDraftPolicy, evaluateDraftPath, loadDraftPolicy, parsePatternList, saveDraftPolicy,
} from "../lib/draftPolicy";
import {
  aiCredentialDelete, aiCredentialStatus, aiCredentialStore, cloudAdapterAvailable, isCloudAiProvider,
  rememberCredentialConfigured, type AiCredentialStatus, type CloudAiProvider,
} from "../lib/aiProviders";
import {
  OLLAMA_DEFAULT_ENDPOINT, describeOllamaEndpoint, formatOllamaSize, listOllamaModels, ollamaAdapterAvailable,
  type OllamaModelInfo,
} from "../lib/ollama";
import {
  AI_PROVIDER_PROFILES,
  AI_TASK_PROFILES,
  describeAiRoute,
  generationGuardrailInstruction,
  resolveAiRoute,
} from "../lib/modelRouting";
import {
  Eye, EyeOff, Save, RefreshCw, Trash2, Shield, KeyRound, CheckCircle2,
  Sparkles, Palette, LayoutGrid, Bot, SlidersHorizontal, RotateCcw, Cpu, ExternalLink,
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
  const [draftPolicy, setDraftPolicy] = useState(loadDraftPolicy);
  const [policyAllowText, setPolicyAllowText] = useState(() => loadDraftPolicy().allow.join("\n"));
  const [policyDenyText, setPolicyDenyText] = useState(() => loadDraftPolicy().deny.join("\n"));
  const [policyProbePath, setPolicyProbePath] = useState("src/config/.env");
  const [policyNotice, setPolicyNotice] = useState("");
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[]>([]);
  const [ollamaBusy, setOllamaBusy] = useState(false);
  const [ollamaNotice, setOllamaNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const ollamaEndpointCheck = describeOllamaEndpoint(s.customEndpoint);
  const cloudProvider: CloudAiProvider | null = isCloudAiProvider(s.aiProvider) ? s.aiProvider : null;
  const [cloudKeyInput, setCloudKeyInput] = useState("");
  const [cloudKeyShow, setCloudKeyShow] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<AiCredentialStatus | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudNotice, setCloudNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    setCloudKeyInput("");
    setCloudNotice(null);
    setCloudStatus(null);
    if (!cloudProvider || !cloudAdapterAvailable()) return;
    let cancelled = false;
    aiCredentialStatus(cloudProvider)
      .then((status) => { if (!cancelled) { setCloudStatus(status); rememberCredentialConfigured(cloudProvider, status.configured); } })
      .catch((error) => { if (!cancelled) setCloudNotice({ kind: "error", text: nativeErrorText(error) }); });
    return () => { cancelled = true; };
  }, [cloudProvider]);

  async function storeCloudKey() {
    if (!cloudProvider) return;
    setCloudNotice(null);
    if (!cloudAdapterAvailable()) {
      setCloudNotice({ kind: "error", text: "Provider keys can only be stored inside the DevLab desktop app, where the OS credential store is available." });
      return;
    }
    setCloudBusy(true);
    try {
      const status = await aiCredentialStore(cloudProvider, cloudKeyInput);
      setCloudStatus(status);
      rememberCredentialConfigured(cloudProvider, status.configured);
      setCloudKeyInput("");
      setCloudKeyShow(false);
      setCloudNotice({ kind: "ok", text: `Key stored in the ${status.backend}. DevLab never reads it back into the interface; Rust attaches it only to requests for ${status.host}.` });
    } catch (error) {
      setCloudNotice({ kind: "error", text: nativeErrorText(error) });
    } finally {
      setCloudBusy(false);
    }
  }

  async function deleteCloudKey() {
    if (!cloudProvider) return;
    setCloudNotice(null);
    setCloudBusy(true);
    try {
      const status = await aiCredentialDelete(cloudProvider);
      setCloudStatus(status);
      rememberCredentialConfigured(cloudProvider, status.configured);
      setCloudNotice({ kind: "ok", text: `Removed the stored key from the ${status.backend}.` });
    } catch (error) {
      setCloudNotice({ kind: "error", text: nativeErrorText(error) });
    } finally {
      setCloudBusy(false);
    }
  }

  async function detectOllamaModels() {
    setOllamaNotice(null);
    setOllamaModels([]);
    if (!ollamaAdapterAvailable()) {
      setOllamaNotice({ kind: "error", text: "The native Ollama adapter is only available inside the DevLab desktop app, not the web preview." });
      return;
    }
    if (!ollamaEndpointCheck.ok) {
      setOllamaNotice({ kind: "error", text: `Endpoint refused before any request: ${ollamaEndpointCheck.reason}` });
      return;
    }
    setOllamaBusy(true);
    try {
      const result = await listOllamaModels(s.customEndpoint);
      setOllamaModels(result.models);
      setOllamaNotice({
        kind: "ok",
        text: result.models.length === 0
          ? `Reached Ollama at ${result.endpoint} in ${result.elapsedMs} ms, but no models are installed. Pull one with \`ollama pull llama3.1\`.`
          : `Found ${result.models.length}${result.truncated ? "+" : ""} installed model${result.models.length === 1 ? "" : "s"} at ${result.endpoint} in ${result.elapsedMs} ms.`,
      });
    } catch (error) {
      const detail = typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : String(error);
      setOllamaNotice({ kind: "error", text: detail });
    } finally {
      setOllamaBusy(false);
    }
  }
  const policyProbe = policyProbePath.trim() ? evaluateDraftPath(policyProbePath, draftPolicy) : null;

  function savePolicy() {
    const next = saveDraftPolicy({ allow: parsePatternList(policyAllowText), deny: parsePatternList(policyDenyText) });
    setDraftPolicy(next);
    setPolicyAllowText(next.allow.join("\n"));
    setPolicyDenyText(next.deny.join("\n"));
    setPolicyNotice(`Saved draft path policy: ${describeDraftPolicy(next)}. Applies at the next reviewed-draft staging; nothing was re-evaluated or written.`);
  }

  function resetPolicy() {
    const next = saveDraftPolicy({ allow: [], deny: [] });
    setDraftPolicy(next);
    setPolicyAllowText("");
    setPolicyDenyText("");
    setPolicyNotice("Cleared user allow/deny patterns. The built-in secret-safe deny list remains enforced.");
  }
  const providerProfile = AI_PROVIDER_PROFILES.find((profile) => profile.id === s.aiProvider) ?? AI_PROVIDER_PROFILES[0];
  const routePreview = AI_TASK_PROFILES.map((task) => resolveAiRoute(task.id, {
    selectedModel: model,
    pickedModel: autoPicked,
  }, s));
  const guidancePreview = routePreview.map((route) => ({
    route,
    guardrail: generationGuardrailInstruction(route.task),
    blueprint: starterBlueprintInstruction(route.task),
    component: componentScaffoldInstruction(route.task),
    designSystem: designSystemInstruction(route.task),
    quality: qualityChecklistInstruction(route.task),
    summary: summarizeGenerationGuidance(route.task),
  }));

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

              <Card title="Reviewed-draft path policy" desc="Path-only allow/deny patterns enforced at the shared reviewed-draft staging gate for every generator, before Rust validation and before Editor review. Patterns never read file contents, never write, and cannot relax native path checks.">
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] px-3 py-2 text-[11.5px] leading-relaxed text-emerald-100/75">
                  <div className="flex items-center gap-2 font-semibold text-emerald-100"><Shield className="h-3.5 w-3.5 text-emerald-300" /> Built-in secret-safe deny list (always on)</div>
                  <div className="mt-1 font-mono text-[10.5px] text-emerald-100/60">{BUILTIN_SECRET_DENY_PATTERNS.filter((pattern) => !pattern.startsWith("**/")).join("  ")}</div>
                  <div className="mt-1 text-[10.5px] text-emerald-100/55">Exceptions kept allowed: {BUILTIN_SECRET_ALLOW_EXCEPTIONS.filter((pattern) => !pattern.startsWith("**/")).join(", ")}. Generated drafts matching the deny list are refused at staging with a visible reason.</div>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="text-[12px] font-medium text-zinc-100">Deny patterns</div>
                    <div className="text-[11px] text-zinc-500">One glob per line. Matching draft paths are refused.</div>
                    <textarea value={policyDenyText} onChange={(e) => setPolicyDenyText(e.target.value)} rows={5} placeholder={"infra/**\n*.lock\ndocs/generated/**"}
                      className="mt-1.5 w-full resize-none rounded-lg border border-white/10 bg-[#0d1017] p-3 font-mono text-[12px] text-zinc-100 outline-none focus:border-cyan-500/50" />
                  </div>
                  <div>
                    <div className="text-[12px] font-medium text-zinc-100">Allow patterns (optional allow-list mode)</div>
                    <div className="text-[11px] text-zinc-500">When non-empty, a draft path must match at least one pattern.</div>
                    <textarea value={policyAllowText} onChange={(e) => setPolicyAllowText(e.target.value)} rows={5} placeholder={"src/**\ntests/**\npackage.json"}
                      className="mt-1.5 w-full resize-none rounded-lg border border-white/10 bg-[#0d1017] p-3 font-mono text-[12px] text-zinc-100 outline-none focus:border-cyan-500/50" />
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button onClick={savePolicy} className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-400">
                    <Save className="h-3.5 w-3.5" /> Save policy
                  </button>
                  <button onClick={resetPolicy} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-white/5">
                    <RotateCcw className="h-3.5 w-3.5" /> Clear user patterns
                  </button>
                  <span className="text-[10.5px] text-zinc-500">Up to {MAX_POLICY_PATTERNS} patterns per list · {describeDraftPolicy(draftPolicy)}</span>
                </div>
                <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Test a path against the saved policy</div>
                  <input value={policyProbePath} onChange={(e) => setPolicyProbePath(e.target.value)} placeholder="src/lib/example.ts"
                    className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2 font-mono text-[12px] text-zinc-100 outline-none focus:border-cyan-500/50" />
                  {policyProbe && (
                    <div className={`mt-2 text-[11.5px] ${policyProbe.kind === "allowed" ? "text-emerald-300" : "text-amber-300"}`}>
                      {policyProbe.kind === "allowed" ? "Allowed" : "Refused"} · {policyProbe.reason}
                    </div>
                  )}
                </div>
                {policyNotice && <div className="mt-2 text-[12px] text-emerald-300">{policyNotice}</div>}
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
                  <strong>Security:</strong> the Gemini key is currently held in WebView localStorage and sent
                  only to Google's official endpoint. DeepSeek, OpenAI and Anthropic keys are written through Rust into the
                  operating system's protected credential store and never returned to this interface; Ollama needs no key.
                  Git tokens likewise live only in the OS credential store.
                </div>
              </div>

              <Card title="AI provider routing" desc="Gemini, Ollama (local), DeepSeek, OpenAI and Anthropic route through native adapters inside the desktop app; the custom endpoint profile stores non-secret metadata only until its adapter exists.">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {AI_PROVIDER_PROFILES.map((profile) => (
                    <button key={profile.id} onClick={() => update({ aiProvider: profile.id as AiProviderId })}
                      className={`rounded-lg border px-3 py-2.5 text-left transition ${
                        s.aiProvider === profile.id ? "border-cyan-500/50 bg-cyan-500/10 text-white" : "border-white/10 text-zinc-400 hover:bg-white/5"
                      }`}>
                      <span className="block text-[12.5px] font-semibold">{profile.shortName}</span>
                      <span className={`mt-0.5 block text-[10.5px] ${profile.availableNow ? "text-emerald-300" : "text-amber-300/80"}`}>
                        {profile.statusLabel}
                      </span>
                    </button>
                  ))}
                </div>

                <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-[12.5px] leading-relaxed text-zinc-400">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-zinc-200">{providerProfile.name}</div>
                      <div className="mt-1">{providerProfile.note}</div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${providerProfile.availableNow ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
                      {providerProfile.statusLabel}
                    </span>
                  </div>
                  <dl className="mt-3 grid gap-2 text-[11.5px] sm:grid-cols-2">
                    <div>
                      <dt className="text-zinc-600">Credential storage</dt>
                      <dd className="text-zinc-300">{providerProfile.credentialStorage}</dd>
                    </div>
                    <div>
                      <dt className="text-zinc-600">Transport</dt>
                      <dd className="text-zinc-300">{providerProfile.transport}</dd>
                    </div>
                  </dl>
                </div>

                {cloudProvider && (
                  <div className="mt-3 space-y-3">
                    <label className="block text-[12px] text-zinc-400">
                      {providerProfile.shortName} model id
                      <input
                        value={cloudProvider === "deepseek" ? s.deepseekModel : cloudProvider === "openai" ? s.openaiModel : s.anthropicModel}
                        onChange={(e) => update(cloudProvider === "deepseek" ? { deepseekModel: e.target.value } : cloudProvider === "openai" ? { openaiModel: e.target.value } : { anthropicModel: e.target.value })}
                        placeholder={providerProfile.modelExamples.join(", ")}
                        className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-cyan-500/50" />
                      <span className="mt-1 block text-[11px] text-zinc-500">Non-secret preference. Requests go only to {providerProfile.transport.match(/fixed host ([^ ]+)/)?.[1] ?? "the provider's fixed host"}; the model id is validated by Rust before sending.</span>
                    </label>
                    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                      <div className="flex items-center justify-between gap-2 text-[12px]">
                        <span className="inline-flex items-center gap-1.5 font-semibold text-zinc-200"><KeyRound className="h-3.5 w-3.5 text-cyan-300" /> {providerProfile.shortName} API key</span>
                        <span className={`text-[11px] ${cloudStatus?.configured ? "text-emerald-300" : "text-zinc-500"}`}>
                          {!cloudAdapterAvailable() ? "desktop app only" : cloudStatus ? (cloudStatus.configured ? `stored in ${cloudStatus.backend}` : "not stored") : "checking…"}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <div className="relative min-w-[220px] flex-1">
                          <input
                            type={cloudKeyShow ? "text" : "password"}
                            value={cloudKeyInput}
                            onChange={(e) => setCloudKeyInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void storeCloudKey(); } }}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={cloudStatus?.configured ? "Enter a new key to replace the stored one" : "Paste the API key"}
                            className="w-full rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2 pr-9 font-mono text-[12.5px] text-zinc-100 outline-none focus:border-cyan-500/50"
                          />
                          <button type="button" onClick={() => setCloudKeyShow((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200" aria-label={cloudKeyShow ? "Hide key" : "Show key"}>
                            {cloudKeyShow ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                        <button type="button" onClick={() => { void storeCloudKey(); }} disabled={cloudBusy || !cloudKeyInput.trim()}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-400/20 disabled:opacity-40">
                          <Save className="h-3.5 w-3.5" /> Store in OS credential store
                        </button>
                        <button type="button" onClick={() => { void deleteCloudKey(); }} disabled={cloudBusy || !cloudStatus?.configured}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-zinc-300 hover:bg-white/5 disabled:opacity-40">
                          <Trash2 className="h-3.5 w-3.5" /> Remove
                        </button>
                      </div>
                      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                        The key is written once through Rust into the operating-system credential store and is never returned to this interface, logged, or persisted in localStorage or recovery snapshots. Rust attaches it only to HTTPS requests for {cloudStatus?.host ?? "the provider's fixed host"}.
                      </p>
                      {cloudNotice && <div className={`mt-2 text-[11.5px] ${cloudNotice.kind === "ok" ? "text-emerald-300" : "text-rose-300"}`}>{cloudNotice.text}</div>}
                    </div>
                    <p className="text-[11px] text-zinc-500">
                      Chat, planning, coding, architecture, migration and repair run through the native adapter with a 120 s non-streamed bound per reply and no fallback to Gemini. Vision stays on Gemini.
                    </p>
                  </div>
                )}
                {s.aiProvider === "ollama" && (
                  <div className="mt-3 space-y-2">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="block text-[12px] text-zinc-400">
                        Ollama loopback endpoint
                        <input value={s.customEndpoint} onChange={(e) => update({ customEndpoint: e.target.value })}
                          placeholder={OLLAMA_DEFAULT_ENDPOINT}
                          className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-cyan-500/50" />
                        <span className={`mt-1 block text-[11px] ${ollamaEndpointCheck.ok ? "text-emerald-300/80" : "text-amber-300/90"}`}>
                          {ollamaEndpointCheck.ok ? `Will call ${ollamaEndpointCheck.origin}` : ollamaEndpointCheck.reason} · empty means {OLLAMA_DEFAULT_ENDPOINT}
                        </span>
                      </label>
                      <label className="block text-[12px] text-zinc-400">
                        Local model id
                        <input value={s.ollamaModel} onChange={(e) => update({ ollamaModel: e.target.value })}
                          placeholder="llama3.1, qwen2.5-coder, deepseek-r1"
                          list="devlab-ollama-models"
                          className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-cyan-500/50" />
                        <datalist id="devlab-ollama-models">
                          {ollamaModels.map((m) => <option key={m.name} value={m.name} />)}
                        </datalist>
                      </label>
                      <label className="block text-[12px] text-zinc-400 sm:col-span-2">
                        Embedding model for semantic workspace search (Phase 9D)
                        <input value={s.ollamaEmbedModel} onChange={(e) => update({ ollamaEmbedModel: e.target.value })}
                          placeholder="nomic-embed-text, mxbai-embed-large, bge-m3"
                          list="devlab-ollama-models"
                          className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-cyan-500/50" />
                        <span className="mt-1 block text-[11px] text-zinc-500">
                          Used only by the Agent context picker's Search → Embed step. Vectors are computed through the same loopback-only adapter, kept in Rust memory and dropped with the index. Pull it with <code>ollama pull nomic-embed-text</code>.
                        </span>
                      </label>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => { void detectOllamaModels(); }}
                        disabled={ollamaBusy}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-400/20 disabled:opacity-40"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${ollamaBusy ? "animate-spin" : ""}`} /> Detect installed models
                      </button>
                      <span className="text-[11px] text-zinc-500">Rust calls GET /api/tags on the loopback endpoint; the WebView never contacts localhost. Nothing is installed or pulled.</span>
                    </div>
                    {ollamaNotice && (
                      <div className={`text-[11.5px] ${ollamaNotice.kind === "ok" ? "text-emerald-300" : "text-rose-300"}`}>{ollamaNotice.text}</div>
                    )}
                    {ollamaModels.length > 0 && (
                      <ul className="grid gap-1 sm:grid-cols-2">
                        {ollamaModels.map((m) => (
                          <li key={m.name}>
                            <button
                              type="button"
                              onClick={() => update({ ollamaModel: m.name })}
                              className={`w-full rounded-lg border px-2.5 py-1.5 text-left text-[11.5px] ${s.ollamaModel === m.name ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100" : "border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/5"}`}
                            >
                              <span className="font-mono font-semibold">{m.name}</span>
                              <span className="ml-2 text-[10.5px] text-zinc-500">{[m.parameterSize, m.quantization, m.family, formatOllamaSize(m.sizeBytes)].filter(Boolean).join(" · ")}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="text-[11px] text-zinc-500">
                      Generation for chat, planning, coding, architecture, migration and repair runs on this machine through the native adapter with a 120 s non-streamed bound per reply. Vision stays on Gemini. There is no fallback from Ollama to Gemini.
                    </p>
                  </div>
                )}
                {s.aiProvider === "custom" && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <label className="block text-[12px] text-zinc-400">
                      Endpoint profile
                      <input value={s.customEndpoint} onChange={(e) => update({ customEndpoint: e.target.value })}
                        placeholder="https://provider.example/v1"
                        className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-cyan-500/50" />
                    </label>
                    <label className="block text-[12px] text-zinc-400">
                      Model id
                      <input value={s.customModel} onChange={(e) => update({ customModel: e.target.value })}
                        placeholder="provider-specific model"
                        className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-cyan-500/50" />
                    </label>
                  </div>
                )}
              </Card>

              <Card title="Task-aware model router" desc="Routes are explicit metadata today. Auto mode can bias Gemini fallback candidates by task; future providers remain closed until native adapters land.">
                <div className="mb-3 grid gap-2 sm:grid-cols-2">
                  {([
                    ["auto", "Auto route by task", "Planning, coding, repair and vision prompts get task-specific route instructions and fallback order."],
                    ["fixed", "Fixed selected model", "Always try the selected Gemini model first before fallback handling."],
                  ] as const).map(([id, label, desc]) => (
                    <button key={id} onClick={() => update({ modelRouting: id as ModelRoutingMode })}
                      className={`rounded-lg border p-3 text-left transition ${
                        s.modelRouting === id ? "border-cyan-500/50 bg-cyan-500/10" : "border-white/10 hover:bg-white/5"
                      }`}>
                      <span className="block text-[12.5px] font-semibold text-zinc-100">{label}</span>
                      <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500">{desc}</span>
                    </button>
                  ))}
                </div>
                <div className="space-y-1.5">
                  {routePreview.map((route) => (
                    <div key={route.task} className="rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-[11.5px]">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-semibold text-zinc-200">{route.taskLabel}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${route.status === "active" ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
                          {route.status === "active" ? "Active" : "Future"}
                        </span>
                      </div>
                      <div className="mt-1 text-zinc-500">{describeAiRoute(route)}</div>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
                  This router does not install models, run commands, store non-Gemini secrets, or send requests to future providers. It only selects the current approved Gemini path unless a future native adapter is implemented.
                </p>
              </Card>

              <Card title="Generation guidance preview" desc="Read-only metadata showing the guidance DevLab injects into generation prompts. It does not run tools, install dependencies, write files or bypass reviewed apply.">
                <div className="space-y-2">
                  {guidancePreview.map(({ route, guardrail, blueprint, component, designSystem, quality, summary }) => (
                    <details key={route.task} className="rounded-lg border border-white/10 bg-black/15 p-3 text-[11.5px] text-zinc-400">
                      <summary className="cursor-pointer select-none font-semibold text-zinc-200">
                        {route.taskLabel} · {summary.join(" · ")}
                      </summary>
                      <div className="mt-2 grid gap-2">
                        <div>
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">Prompt guardrails</div>
                          <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-black/25 p-2 font-mono text-[10.5px] leading-relaxed text-zinc-500">{guardrail}</pre>
                        </div>
                        {blueprint && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">Starter blueprint guidance</div>
                            <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-black/25 p-2 font-mono text-[10.5px] leading-relaxed text-zinc-500">{blueprint}</pre>
                          </div>
                        )}
                        {component && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">Component/style guidance</div>
                            <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-black/25 p-2 font-mono text-[10.5px] leading-relaxed text-zinc-500">{component}</pre>
                          </div>
                        )}
                        {designSystem && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">Design-system guidance</div>
                            <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-black/25 p-2 font-mono text-[10.5px] leading-relaxed text-zinc-500">{designSystem}</pre>
                          </div>
                        )}
                        {quality && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">Quality checklist guidance</div>
                            <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-black/25 p-2 font-mono text-[10.5px] leading-relaxed text-zinc-500">{quality}</pre>
                          </div>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
                  This preview is metadata only. It does not include your Gemini key, custom prompt text, file contents or attached workspace context.
                </p>
              </Card>

              <Card title="Google AI Studio API key" desc="Bring your own key; Google's per-project free-tier limits still apply.">
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
                  {(availableModels.length > 0
                    ? availableModels.filter((m) => m.supported).map((m) => m.name.replace("models/", ""))
                    : [model])
                    .map((m) => <option key={m} value={m} className="text-zinc-900">{m}</option>)}
                </select>

                <div className="mt-3 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.05] p-3 text-[12px] leading-relaxed text-zinc-400">
                  <p>
                    DevLab automatically retries short throttles and falls back across up to three
                    available models. For the highest free-tier throughput, choose a stable
                    <strong className="text-cyan-200"> Flash-Lite</strong> model. Daily quota cannot
                    be bypassed in code and resets at midnight Pacific time.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-3">
                    <a href="https://ai.dev/rate-limit" target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 text-cyan-400 hover:underline">
                      View my usage <ExternalLink className="h-3 w-3" />
                    </a>
                    <a href="https://ai.google.dev/gemini-api/docs/rate-limits" target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 text-cyan-400 hover:underline">
                      Rate-limit guide <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>

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
                  {status === "ok" && (
                    <span className="inline-flex items-center gap-1 text-sm text-emerald-400" title="Generation quota is checked only when you send a prompt.">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Key valid
                    </span>
                  )}
                  {status === "bad" && <span className="text-sm text-rose-400">Key rejected or network unavailable</span>}
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

              <Card title="Local data" desc="Non-secret preferences remain WebView-local; Git credentials are separate.">
                <ul className="space-y-1.5 text-[12.5px] text-zinc-400">
                  <li><code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">devlab.settings.v1</code> — preferences and non-secret provider/router metadata</li>
                  <li><code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">devlab.gemini.key</code> — Gemini key used by the renderer</li>
                  <li><code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">devlab.git.v1</code> — commit-message preference only; no token</li>
                  <li><code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">devlab.deploy.v1</code> — disabled deployment preference only; legacy tokens are purged</li>
                  <li><span className="font-medium text-emerald-300">OS credential store</span> — GitHub, GitLab and Bitbucket token presence; values are not readable by the renderer</li>
                </ul>
                <button
                  onClick={() => { if (confirm("Erase DevLab WebView preferences and the Gemini key? Git credentials must be deleted separately in Source Control → Credentials.")) { localStorage.clear(); location.reload(); } }}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300 hover:bg-rose-500/20">
                  <Trash2 className="h-3.5 w-3.5" /> Erase WebView data
                </button>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function nativeErrorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
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
