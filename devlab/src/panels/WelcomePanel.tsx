import type { ViewId } from "../types";
import { CodeBlock } from "../components/CodeBlock";
import {
  Bot, ArrowRight,
  Shield, KeyRound, Download, Package,
  Wand2, Code2, Container, Database, GitBranch, PenTool, Stethoscope, ScanLine, Terminal as TerminalIcon, Plug,
} from "lucide-react";

const stats = [
  { label: "Migration phase", value: "6C / 7" },
  { label: "Native capabilities", value: "9" },
  { label: "Simulations enabled", value: "0" },
  { label: "License", value: "MIT" },
];

const quickCards: { view: ViewId; Icon: typeof Bot; title: string; desc: string; hot?: boolean }[] = [
  { view: "canvas",   Icon: PenTool,      title: "Sketch → Source",      desc: "Draw an architecture and generate a reviewable code preview", hot: true },
  { view: "healer",   Icon: Stethoscope,  title: "Reviewed Repair Loop", desc: "Run native tests, draft repairs and explicitly apply reviewed drafts" },
  { view: "builder",  Icon: Wand2,        title: "Project Builder",      desc: "Reviewed multi-file workspace generation is a later milestone" },
  { view: "vision",   Icon: ScanLine,     title: "Screenshot → Source",  desc: "Use Gemini vision to generate a reviewable React preview" },
  { view: "editor",   Icon: Code2,        title: "Native Workspace",     desc: "Select a real folder and safely edit its files with Monaco" },
  { view: "terminal", Icon: TerminalIcon, title: "Native Terminal",      desc: "Run your real shell through a cross-platform PTY" },
  { view: "git",      Icon: GitBranch,    title: "Native Source Control", desc: "Inspect and operate on the selected real Git repository" },
  { view: "docker",   Icon: Container,    title: "Native Containers",     desc: "Pull images, create stopped containers and control real Docker state" },
  { view: "database", Icon: Database,     title: "Native Databases",      desc: "Run bounded SQLite and PostgreSQL reads plus separately confirmed writes" },
  { view: "api",      Icon: Plug,         title: "Native HTTP",           desc: "Send bounded HTTP/HTTPS requests without browser CORS limits" },
];

const features = [
  { Icon: PenTool,    title: "Sketch-to-code architecture", desc: "Draw a system on an infinite canvas and ask Gemini to produce reviewable source. AI output is never written to your workspace without a separate reviewed action." },
  { Icon: TerminalIcon,title: "Real PTY terminal",          desc: "Start your operating system’s default shell in the selected workspace with real streaming output, resize handling, termination and exit codes." },
  { Icon: ScanLine,   title: "Reverse-engineer interfaces", desc: "Paste a screenshot or URL. Gemini vision extracts visual details and generates source for you to review without pretending it has been built or run." },
  { Icon: Container,  title: "Real Docker engine operations", desc: "Read actual engine data, pull validated image references, create constrained stopped containers, and explicitly control validated container IDs." },
  { Icon: Database,   title: "Native SQLite and PostgreSQL", desc: "Run bounded SQLite work, or inspect and query PostgreSQL through explicit TLS, with bounded reads and separately confirmed writes." },
  { Icon: Plug,       title: "Native HTTP client",           desc: "Send real HTTP/HTTPS requests from Rust with verified TLS, fixed framing and bounded request, header and response sizes." },
  { Icon: Stethoscope,title: "Reviewed test repair",        desc: "Run backend-discovered tests, draft a one-file repair from real output, then apply it only after explicit editor review." },
  { Icon: GitBranch,  title: "Real native Git",             desc: "Read real status, diffs, commits, branches and remotes, then stage, commit or run a confirmed remote operation through fixed Rust commands." },
  { Icon: KeyRound,   title: "Protected Git credentials",   desc: "Saved Git provider tokens live in the operating system credential store and are never returned to the renderer. Gemini retains its separate BYOK renderer flow." },
];

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
            Phase 6L · Agent context browser
          </div>
          <h1 className="mt-5 max-w-3xl text-5xl font-bold tracking-tight text-white sm:text-6xl text-balance">
            Native shell.{" "}
            <span className="grad-text">Trusted tools.</span>
            <br />No simulated success.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-zinc-400 text-pretty">
            DevLab now connects Monaco to real files, xterm.js to your operating system shell,
            Source Control to real Git, Containers to the local Docker engine, and Database to a
            bounded SQLite plus verified PostgreSQL connectivity, fixed schema inspection, bounded reads, separately confirmed writes, a native HTTP client with no browser CORS path, a real bounded test runner, reviewed repair drafts from failed test evidence, and explicit native application of approved drafts. Unavailable operations stay disabled until their native backends are implemented.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              onClick={() => onNavigate("editor")}
              className="group inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition hover:from-cyan-400 hover:to-blue-500"
            >
              <Wand2 className="h-4 w-4" />
              Open a native workspace
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
              <h2 className="text-2xl font-semibold text-white">Run the Tauri desktop application</h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
                DevLab now launches through a trusted Rust process instead of treating a web page as
                a native application. Install the platform prerequisites, then use the desktop command.
                The browser command remains an interface preview only.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {[
              { step: "01", title: "Prerequisites", cmd: "Install Rust + Tauri system libraries" },
              { step: "02", title: "Develop", cmd: "npm run desktop:dev" },
              { step: "03", title: "Package", cmd: "npm run desktop:build" },
            ].map((s) => (
              <div key={s.step} className="rounded-xl border border-white/10 bg-white/[0.02] p-4 ring-soft">
                <div className="font-mono text-[10px] uppercase tracking-wider text-cyan-400">{s.step}</div>
                <div className="mt-1.5 text-sm font-semibold text-white">{s.title}</div>
                <div className="mt-2 rounded-md bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-zinc-400">
                  {s.cmd}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.02] p-5 ring-soft">
            <div className="flex items-center gap-3">
              <Package className="h-5 w-5 text-zinc-300" />
              <h3 className="text-sm font-semibold text-white">Start from the repository</h3>
            </div>
            <div className="mt-3">
              <CodeBlock
                code={"git clone https://github.com/Talean414/devlab.git\ncd devlab/devlab\nnpm ci\nnpm run desktop:dev"}
                lang="bash"
              />
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed text-zinc-500">
              Run <code className="font-mono text-zinc-300">npm run check</code> for the React build and
              <code className="ml-1 font-mono text-zinc-300">npm run native:check</code> for Rust.
              Native compilation requires Rust, WebKitGTK on Linux, and the other documented platform libraries.
            </p>
          </div>

          <button
            onClick={() => onNavigate("setup")}
            className="group mt-6 flex w-full items-center gap-4 rounded-xl border border-cyan-500/30 bg-gradient-to-r from-cyan-500/10 to-violet-600/10 p-5 text-left transition hover:border-cyan-500/50"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/25 to-violet-600/25 ring-1 ring-white/10">
              <Download className="h-5 w-5 text-cyan-200" />
            </span>
            <span className="flex-1">
              <span className="block text-sm font-semibold text-white">Open the native setup guide</span>
              <span className="block text-[12.5px] text-zinc-400">
                Inspect runtime diagnostics, security boundaries, migration phases and packaging commands.
              </span>
            </span>
            <ArrowRight className="h-4 w-4 text-cyan-300 transition group-hover:translate-x-0.5" />
          </button>

          <div className="mt-8 flex items-center gap-2 text-[12px] text-zinc-500">
            <Shield className="h-3.5 w-3.5" />
            MIT licensed · default-deny native permissions · no simulated native operations
          </div>
        </div>
      </section>
    </div>
  );
}
