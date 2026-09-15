import type { ViewId } from "../types";
import { CodeBlock } from "../components/CodeBlock";
import {
  Bot, ArrowRight,
  Shield, KeyRound, Download, Package,
  Wand2, Code2, GitBranch, PenTool, Stethoscope, ScanLine, Radio,
} from "lucide-react";

const stats = [
  { label: "Project templates", value: "38" },
  { label: "Native runtimes", value: "28" },
  { label: "Deploy targets", value: "8" },
  { label: "Total cost", value: "$0" },
];

const quickCards: { view: ViewId; Icon: typeof Bot; title: string; desc: string; hot?: boolean }[] = [
  { view: "canvas",   Icon: PenTool,      title: "Sketch → Monorepo",    desc: "Draw boxes and arrows, get a real working codebase", hot: true },
  { view: "healer",   Icon: Stethoscope,  title: "Self-Healing Tests",   desc: "Agent diagnoses, patches and re-runs until green", hot: true },
  { view: "builder",  Icon: Wand2,        title: "Build with the agent", desc: "Describe an idea — get a plan, commands and real files" },
  { view: "vision",   Icon: ScanLine,     title: "Screenshot → App",     desc: "Reverse-engineer any UI into a working React clone" },
  { view: "editor",   Icon: Code2,        title: "Code Editor",          desc: "Full Monaco IDE with file tree, tabs and 20+ languages" },
  { view: "live",     Icon: Radio,        title: "Live Share",           desc: "Zero-server P2P collaboration with a short invite" },
];

const features = [
  { Icon: PenTool,    title: "Sketch-to-code architecture", desc: "Draw your system on an infinite canvas — frontend, API, DB, cache, workers — and DevLab generates the entire monorepo, docker-compose included." },
  { Icon: Stethoscope,title: "Autonomous self-healing",     desc: "Feed it broken code and a failing stack trace. The agent diagnoses, patches, shows live diffs and re-runs the suite — iterating until everything passes." },
  { Icon: ScanLine,   title: "Reverse-engineer anything",   desc: "Paste a screenshot or URL. Gemini's vision model extracts the palette, typography and components, then scaffolds a working clone in seconds." },
  { Icon: Radio,      title: "Zero-server live sharing",    desc: "Multi-tab sync via BroadcastChannel plus real WebRTC P2P for remote pairing — share your exact workspace with a short copy-paste invite, no backend." },
  { Icon: GitBranch,  title: "Git that knows your repo",    desc: "Connect a GitHub token once. DevLab verifies the repository, enforces Conventional Commits and can auto-commit and push agent changes." },
  { Icon: KeyRound,   title: "Bring Your Own Key",          desc: "Your free Google AI Studio key powers every agent. Never hardcoded, never uploaded — stored only in your browser." },
];

const packageJsonSnippet = `{
  "dependencies": {
    "@theia/core": "latest",
    "@theia/editor": "latest",
    "@theia/terminal": "latest",
    "@theia/preview": "latest",
    "@theia/plugin-ext-vscode": "latest"
  },
  "theiaPlugins": {
    "roo-code":        "https://open-vsx.org/api/RooVeterinaryInc/roo-cline/latest/file/RooVeterinaryInc.roo-cline-latest.vsix",
    "docker":          "https://open-vsx.org/api/ms-azuretools/vscode-docker/latest/file/ms-azuretools.vscode-docker-latest.vsix",
    "database-client": "https://open-vsx.org/api/cweijan/vscode-database-client2/latest/file/cweijan.vscode-database-client2-latest.vsix",
    "rest-client":     "https://open-vsx.org/api/humao/rest-client/latest/file/humao.rest-client-latest.vsix"
  }
}`;

export function WelcomePanel({
  onNavigate, hasKey,
}: {
  onNavigate: (v: ViewId) => void;
  hasKey: boolean;
}) {
  return (
    <div className="h-full overflow-y-auto">
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-white/5">
        <div className="absolute inset-0 grid-bg opacity-50" />
        <div className="absolute -top-32 left-1/2 h-64 w-[700px] -translate-x-1/2 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="absolute -bottom-32 right-1/3 h-64 w-[500px] rounded-full bg-violet-500/10 blur-3xl" />

        <div className="relative mx-auto max-w-5xl px-8 py-16">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs font-medium text-cyan-300">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
            Your all-in-one developer control plane
          </div>
          <h1 className="mt-5 max-w-3xl text-5xl font-bold tracking-tight text-white sm:text-6xl text-balance">
            One window.{" "}
            <span className="grad-text">Every tool.</span>
            <br />Zero context switching.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-zinc-400 text-pretty">
            DevLab unifies your AI agent, terminal, database client, API tester,
            Docker, Git and CI/CD into a single, free, open-source workspace.
            Stop juggling Cursor, Postman, DBeaver and twenty browser tabs.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              onClick={() => onNavigate("builder")}
              className="group inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition hover:from-cyan-400 hover:to-blue-500"
            >
              <Wand2 className="h-4 w-4" />
              Build a project with the agent
              <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </button>
            {!hasKey && (
              <button
                onClick={() => onNavigate("settings")}
                className="inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-5 py-2.5 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/20"
              >
                <KeyRound className="h-4 w-4" />
                Add your Gemini key
              </button>
            )}
            <button
              onClick={() => onNavigate("setup")}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-5 py-2.5 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06]"
            >
              <Download className="h-4 w-4" />
              Run DevLab locally
            </button>
          </div>

          {/* Stats */}
          <div className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {stats.map((s) => (
              <div key={s.label} className="glass ring-soft rounded-xl p-4">
                <div className="text-2xl font-bold text-white">{s.value}</div>
                <div className="mt-0.5 text-[12px] text-zinc-500">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Quick actions */}
      <section className="mx-auto max-w-5xl px-8 py-12">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          Jump right in
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {quickCards.map((c) => (
            <button
              key={c.view}
              onClick={() => onNavigate(c.view)}
              className="group flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-5 text-left transition hover:border-cyan-500/30 hover:bg-cyan-500/[0.04] ring-soft"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/20 to-violet-600/20 ring-1 ring-white/10 transition group-hover:from-cyan-500/30 group-hover:to-violet-600/30">
                <c.Icon className="h-5 w-5 text-cyan-200" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-100">{c.title}</span>
                  {c.hot && (
                    <span className="rounded-full bg-cyan-500/20 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-cyan-300">
                      New
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[12.5px] text-zinc-500">{c.desc}</div>
              </div>
              <ArrowRight className="h-4 w-4 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-zinc-300" />
            </button>
          ))}
        </div>

        {/* Features */}
        <h2 className="mt-12 text-sm font-semibold uppercase tracking-wider text-zinc-500">
          Why DevLab
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {features.map((f) => (
            <div key={f.title} className="glass ring-soft rounded-xl p-5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/20 to-violet-600/20 ring-1 ring-white/10">
                <f.Icon className="h-4.5 w-4.5 text-cyan-200" />
              </div>
              <h3 className="mt-3 text-sm font-semibold text-white">{f.title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Native build instructions */}
      <section className="border-t border-white/5 bg-[#0d1017]/50">
        <div className="mx-auto max-w-5xl px-8 py-12">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/20 to-violet-600/20 ring-1 ring-white/10">
              <Download className="h-5 w-5 text-cyan-200" />
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-white">Optional native desktop blueprint</h2>
              <p className="mt-2 max-w-2xl text-sm text-zinc-400">
                The current repository is a working browser app. A trusted native runtime would be
                needed to execute real terminal, Docker, database, and Git processes. The Eclipse
                Theia material below is a starting blueprint for that separate implementation—not
                a prebuilt
                <span className="mx-1 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[12px] text-zinc-200">
                  .exe / .dmg / .AppImage
                </span>
                release.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {[
              { step: "01", title: "Bootstrap",   cmd: "npx yo theia-extension devlab-app" },
              { step: "02", title: "Pre-bake tools", cmd: "Add theiaPlugins to package.json" },
              { step: "03", title: "Package",     cmd: "npm run theia package --electron" },
            ].map((s) => (
              <div key={s.step} className="rounded-xl border border-white/10 bg-white/[0.02] p-4 ring-soft">
                <div className="font-mono text-[10px] uppercase tracking-wider text-cyan-400">{s.step}</div>
                <div className="mt-1.5 text-sm font-semibold text-white">{s.title}</div>
                <div className="mt-2 truncate rounded-md bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-zinc-400">
                  {s.cmd}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6">
            <CodeBlock code={packageJsonSnippet} lang="json" />
          </div>

          <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.02] p-5 ring-soft">
            <div className="flex items-center gap-3">
              <Package className="h-5 w-5 text-zinc-300" />
              <h3 className="text-sm font-semibold text-white">Run the current browser app locally</h3>
            </div>
            <p className="mt-2 text-sm text-zinc-400">
              Clone the repository, install the locked dependencies, and start Vite:
            </p>
            <div className="mt-3">
              <CodeBlock
                code={"git clone https://github.com/Talean414/devlab.git\ncd devlab/devlab\nnpm ci\nnpm run dev"}
                lang="bash"
              />
            </div>
          </div>

          <button
            onClick={() => onNavigate("setup")}
            className="group mt-6 flex w-full items-center gap-4 rounded-xl border border-cyan-500/30 bg-gradient-to-r from-cyan-500/10 to-violet-600/10 p-5 text-left transition hover:border-cyan-500/50"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/25 to-violet-600/25 ring-1 ring-white/10">
              <Download className="h-5 w-5 text-cyan-200" />
            </span>
            <span className="flex-1">
              <span className="block text-sm font-semibold text-white">
                Open the Local Setup guide
              </span>
              <span className="block text-[12.5px] text-zinc-400">
                Run the web app, connect Gemini, verify production, or explore the optional native blueprint.
              </span>
            </span>
            <ArrowRight className="h-4 w-4 text-cyan-300 transition group-hover:translate-x-0.5" />
          </button>

          <div className="mt-8 flex items-center gap-2 text-[12px] text-zinc-500">
            <Shield className="h-3.5 w-3.5" />
            MIT licensed · no telemetry · no vendor lock-in
          </div>
        </div>
      </section>
    </div>
  );
}
