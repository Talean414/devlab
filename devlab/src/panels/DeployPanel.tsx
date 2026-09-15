import { useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { CodeBlock } from "../components/CodeBlock";
import { deployProviders } from "../data/runtimes";
import { loadDeploy, saveDeploy, type DeployConfig } from "../lib/settings";
import { Rocket, ExternalLink, KeyRound, CheckCircle2, Save, Globe2 } from "lucide-react";

const tokenField: Record<string, keyof DeployConfig> = {
  vercel: "vercelToken", netlify: "netlifyToken", render: "renderKey",
  railway: "railwayToken", fly: "flyToken", cloudflare: "cloudflareToken",
  supabase: "supabaseKey",
};

export function DeployPanel() {
  const [cfg, setCfg] = useState<DeployConfig>(loadDeploy);
  const [selected, setSelected] = useState(deployProviders[0]);
  const [savedMsg, setSavedMsg] = useState(false);

  const field = tokenField[selected.id];
  const tokenValue = field ? (cfg[field] as string) : "";

  function persist(next: DeployConfig) {
    setCfg(next); saveDeploy(next);
    setSavedMsg(true); setTimeout(() => setSavedMsg(false), 1500);
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Deployment"
        subtitle="Vercel · Netlify · Render · Railway · Fly.io · Cloudflare · Supabase · Pages"
      />
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-white/5 bg-[#0d1017]/40 p-3">
          <div className="mb-2 px-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
            Providers
          </div>
          {deployProviders.map((p) => {
            const f = tokenField[p.id];
            const connected = f ? !!(cfg[f] as string) : false;
            return (
              <button
                key={p.id}
                onClick={() => setSelected(p)}
                className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${
                  selected.id === p.id
                    ? "border border-cyan-500/30 bg-cyan-500/10"
                    : "border border-transparent hover:bg-white/5"
                }`}
              >
                <span
                  className="h-6 w-6 shrink-0 rounded-md ring-1 ring-white/10"
                  style={{ background: `linear-gradient(135deg, ${p.color}40, ${p.color}10)` }}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-zinc-100">{p.name}</div>
                  <div className="truncate text-[11px] text-zinc-500">{p.freeTier}</div>
                </div>
                {connected && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
              </button>
            );
          })}
        </aside>

        <div className="flex-1 overflow-y-auto p-7">
          <div className="flex items-start gap-4">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ring-1 ring-white/10"
              style={{ background: `linear-gradient(135deg, ${selected.color}35, ${selected.color}10)` }}
            >
              <Rocket className="h-6 w-6" style={{ color: selected.color }} />
            </div>
            <div className="flex-1">
              <h2 className="text-2xl font-semibold text-white">{selected.name}</h2>
              <p className="mt-1 text-sm text-zinc-400">{selected.tagline}</p>
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11.5px] text-emerald-300 ring-1 ring-emerald-500/20">
                <CheckCircle2 className="h-3 w-3" /> Free tier: {selected.freeTier}
              </div>
            </div>
            <a
              href={selected.docs} target="_blank" rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5"
            >
              Docs <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          <div className="mt-5 flex flex-wrap gap-1.5">
            {selected.supports.map((s) => (
              <span key={s} className="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-zinc-400">{s}</span>
            ))}
          </div>

          {/* Token */}
          {field && (
            <section className="mt-7 rounded-xl border border-white/10 bg-white/[0.02] p-5 ring-soft">
              <div className="mb-3 flex items-center gap-2.5">
                <KeyRound className="h-4 w-4 text-cyan-300" />
                <h3 className="text-sm font-semibold text-white">{selected.tokenLabel}</h3>
              </div>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={tokenValue}
                  onChange={(e) => setCfg({ ...cfg, [field]: e.target.value })}
                  placeholder={`Paste your ${selected.name} token…`}
                  className="flex-1 rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-cyan-500/50"
                />
                <button
                  onClick={() => persist(cfg)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 px-4 py-2 text-sm font-semibold text-white hover:from-cyan-400 hover:to-blue-500"
                >
                  <Save className="h-3.5 w-3.5" /> Save
                </button>
              </div>
              {savedMsg && <p className="mt-2 text-[12px] text-emerald-400">Token saved locally.</p>}
              <p className="mt-2 text-[11.5px] text-zinc-500">
                Stored in this browser only. In the native DevLab build this is written to your
                shell profile so the CLI picks it up automatically.
              </p>
            </section>
          )}

          <h3 className="mb-2 mt-7 text-sm font-semibold text-white">1 · Install the CLI</h3>
          <CodeBlock code={selected.cliInstall} lang="bash" />

          <h3 className="mb-2 mt-5 text-sm font-semibold text-white">2 · Deploy</h3>
          <CodeBlock code={selected.deployCmd} lang="bash" />

          <h3 className="mb-2 mt-5 text-sm font-semibold text-white">3 · Wire it into CI</h3>
          <CodeBlock
            lang="yaml"
            code={`# .github/workflows/deploy-${selected.id}.yml
name: Deploy to ${selected.name}
on:
  push: { branches: [main] }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci && npm run build
      - name: Deploy
        env:
          DEPLOY_TOKEN: \${{ secrets.${selected.id.toUpperCase()}_TOKEN }}
        run: |
          ${selected.cliInstall.split("\n")[0].replace(/^#.*$/, "").trim() || "echo 'no cli install'"}
          ${selected.deployCmd.split("\n")[0]}`}
          />

          <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.05] p-4 text-[13px] text-cyan-100/90">
            <Globe2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Browsers cannot shell out to a CLI. In the packaged DevLab desktop build these
              commands run directly in the integrated terminal with your saved token already
              exported — one click deploys. See the <strong>Local Setup</strong> panel.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
