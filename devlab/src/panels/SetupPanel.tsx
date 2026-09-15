import { useEffect, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { CodeBlock } from "../components/CodeBlock";
import { detectRuntime, WEB_RUNTIME, type RuntimeInfo } from "../lib/native";
import {
  CheckCircle2, CircleDot, Cpu, Download, KeyRound, Laptop,
  Package, Rocket, Shield, Terminal, Wrench,
} from "lucide-react";

const TABS = [
  { id: "start",        label: "Start Here",   Icon: Rocket },
  { id: "architecture", label: "Architecture", Icon: Cpu },
  { id: "roadmap",      label: "Roadmap",      Icon: Wrench },
  { id: "distribute",   label: "Distribute",   Icon: Package },
] as const;

const LOCAL_SETUP = `# Clone and enter the actual application directory
git clone https://github.com/Talean414/devlab.git
cd devlab/devlab

# Node.js 22 is recommended; .nvmrc selects it
nvm install
nvm use

# Install the locked JavaScript dependencies
npm ci

# Launch the native Tauri application
npm run desktop:dev`;

const LINUX_PREREQS = `# Debian / Ubuntu
sudo apt update
sudo apt install -y \\
  libwebkit2gtk-4.1-dev \\
  build-essential \\
  curl wget file \\
  libxdo-dev libssl-dev \\
  libayatana-appindicator3-dev \\
  librsvg2-dev

# Install the current Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"`;

const MAC_PREREQS = `# Apple command-line build tools
xcode-select --install

# Install the current Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"`;

const VERIFY_COMMANDS = `# Frontend type-check and production bundle
npm run check

# Native Rust backend
npm run native:check

# Produce this operating system's installer/bundle
npm run desktop:build`;

const PHASES = [
  {
    n: 1,
    title: "Native foundation",
    status: "active",
    detail: "Tauri shell, typed runtime handshake, restrictive capabilities, branded application bundle and native/web detection.",
  },
  {
    n: 2,
    title: "Real workspaces",
    status: "next",
    detail: "Native folder picker, scoped filesystem service, file watching and Monaco connected to actual files.",
  },
  {
    n: 3,
    title: "Real terminal",
    status: "planned",
    detail: "PTY-backed shell sessions with streaming output, resize, cancellation and real exit codes.",
  },
  {
    n: 4,
    title: "Git and secure secrets",
    status: "planned",
    detail: "Real repository status and operations plus encrypted credentials outside browser localStorage.",
  },
  {
    n: 5,
    title: "Docker, databases and native HTTP",
    status: "planned",
    detail: "Detect real services and display only live data returned by their native integrations.",
  },
  {
    n: 6,
    title: "Agent tool execution",
    status: "planned",
    detail: "Permission-gated tools, actual test execution, reviewed patches, audit logs and Ollama support.",
  },
  {
    n: 7,
    title: "Signed distribution",
    status: "planned",
    detail: "Windows, Linux and macOS CI builds, signing, release artifacts and verified updates.",
  },
] as const;

export function SetupPanel() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("start");
  const [runtime, setRuntime] = useState<RuntimeInfo>(WEB_RUNTIME);

  useEffect(() => {
    let mounted = true;
    detectRuntime().then((info) => { if (mounted) setRuntime(info); });
    return () => { mounted = false; };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Native DevLab Setup"
        subtitle="Tauri 2 + React · real operating-system capabilities replace simulations phase by phase"
        badge={runtime.runtime === "tauri" ? "Native connected" : "Web preview"}
        badgeOk={runtime.runtime === "tauri"}
      />

      <div className="flex gap-5 overflow-x-auto border-b border-white/5 bg-[#0d1017]/40 px-6 text-xs">
        {TABS.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-1 py-3 font-medium ${
              tab === item.id
                ? "border-cyan-400 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <item.Icon className="h-3.5 w-3.5" /> {item.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-7 py-8">
          {tab === "start" && (
            <>
              <RuntimeCard runtime={runtime} />

              <Head icon={Rocket} title="1 · Launch the desktop application" className="mt-8"
                sub="Install Git, Node.js 20.19+ or 22.12+, Rust and your operating system's Tauri prerequisites first." />
              <CodeBlock code={LOCAL_SETUP} lang="bash" />

              <Head icon={Laptop} title="2 · Operating-system prerequisites" className="mt-8"
                sub="Tauri uses the operating system's native WebView and build toolchain." />
              <details className="rounded-xl border border-white/10 bg-white/[0.02] p-4" open>
                <summary className="cursor-pointer text-[13px] font-semibold text-white">Linux · Debian / Ubuntu</summary>
                <div className="mt-3"><CodeBlock code={LINUX_PREREQS} lang="bash" /></div>
              </details>
              <details className="mt-2 rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <summary className="cursor-pointer text-[13px] font-semibold text-white">Windows 10 / 11</summary>
                <div className="mt-3 space-y-2 text-[12.5px] leading-relaxed text-zinc-400">
                  <p>Install Microsoft C++ Build Tools with the “Desktop development with C++” workload, WebView2 and Rust using the MSVC toolchain.</p>
                  <p>Then run <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-cyan-300">npm ci</code> followed by <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-cyan-300">npm run desktop:dev</code> in PowerShell.</p>
                </div>
              </details>
              <details className="mt-2 rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <summary className="cursor-pointer text-[13px] font-semibold text-white">macOS</summary>
                <div className="mt-3"><CodeBlock code={MAC_PREREQS} lang="bash" /></div>
              </details>

              <Head icon={KeyRound} title="3 · Connect AI" className="mt-8"
                sub="During the native migration Gemini still uses the BYOK flow; secure native storage arrives in Phase 4." />
              <ol className="list-decimal space-y-2 rounded-xl border border-white/10 bg-white/[0.02] py-4 pl-10 pr-5 text-[13px] leading-relaxed text-zinc-300">
                <li>Create a key at <a className="text-cyan-400 hover:underline" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Google AI Studio</a>.</li>
                <li>Paste it into the first-run key window.</li>
                <li>Open <strong className="text-white">Settings → Providers</strong>, test it and select a stable Flash-Lite model.</li>
                <li>Send a small prompt from <strong className="text-white">AI Agent</strong>.</li>
              </ol>

              <Head icon={CheckCircle2} title="4 · Verify both halves" className="mt-8"
                sub="A release is not valid unless the React frontend and Rust backend both pass." />
              <CodeBlock code={VERIFY_COMMANDS} lang="bash" />

              <Note>
                <strong>No fake native results:</strong> opening the app with <code>npm run dev</code>
                creates only a browser UI preview. Terminal, Git, Docker, database and real test
                execution stay disabled until their native capability is implemented. Use
                <code>npm run desktop:dev</code> for the trusted desktop runtime.
              </Note>
            </>
          )}

          {tab === "architecture" && (
            <>
              <Head icon={Cpu} title="Native boundary"
                sub="The React renderer has no direct shell, filesystem or secret access." />
              <div className="grid gap-3 md:grid-cols-2">
                <ArchitectureCard
                  icon={Laptop}
                  title="React renderer"
                  items={["DevLab interface", "Source previews", "User intent and approvals", "Typed IPC client", "No privileged APIs"]}
                />
                <ArchitectureCard
                  icon={Cpu}
                  title="Rust core · phased"
                  items={["Runtime handshake now", "Workspace boundary next", "PTY, Git and Docker later", "Database and HTTP clients later", "Secrets and audit log later"]}
                />
              </div>

              <div className="my-5 flex items-center gap-3 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.05] p-4">
                <Shield className="h-5 w-5 shrink-0 text-cyan-300" />
                <p className="text-[13px] leading-relaxed text-zinc-300">
                  Every privileged action will cross a narrowly typed Tauri command. Before a new
                  action is enabled, its backend must validate the selected workspace, requested
                  capability and autonomy policy.
                </p>
              </div>

              <Head icon={Shield} title="Default-deny rules" className="mt-8" sub="" />
              <ul className="space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-5 text-[13px] text-zinc-300">
                {[
                  "Only the main application window receives core Tauri permissions.",
                  "A capability is not advertised until its backend and tests exist.",
                  "Paths must resolve inside a user-selected workspace.",
                  "Destructive commands require explicit approval unless a narrow policy permits them.",
                  "The renderer never receives raw long-lived secrets after secure storage is enabled.",
                  "Remote pages are never loaded into a privileged application context.",
                  "Every agent tool action will have timeout, cancellation and audit metadata.",
                ].map((rule) => (
                  <li key={rule} className="flex gap-2.5">
                    <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" /> {rule}
                  </li>
                ))}
              </ul>
            </>
          )}

          {tab === "roadmap" && (
            <>
              <Head icon={Wrench} title="Simulation-removal roadmap"
                sub="A panel is re-enabled only when it is backed by live native data and verifiable operations." />
              <div className="space-y-3">
                {PHASES.map((phase) => (
                  <div key={phase.n} className={`rounded-xl border p-4 ${
                    phase.status === "active"
                      ? "border-cyan-500/30 bg-cyan-500/[0.06]"
                      : phase.status === "next"
                        ? "border-amber-500/20 bg-amber-500/[0.04]"
                        : "border-white/10 bg-white/[0.02]"
                  }`}>
                    <div className="flex items-start gap-3">
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-bold ${
                        phase.status === "active" ? "bg-cyan-500/20 text-cyan-200"
                          : phase.status === "next" ? "bg-amber-500/15 text-amber-200"
                            : "bg-white/5 text-zinc-500"
                      }`}>{phase.n}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-[13.5px] font-semibold text-white">{phase.title}</h3>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                            phase.status === "active" ? "bg-cyan-500/15 text-cyan-300"
                              : phase.status === "next" ? "bg-amber-500/15 text-amber-300"
                                : "bg-white/5 text-zinc-500"
                          }`}>{phase.status}</span>
                        </div>
                        <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-400">{phase.detail}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === "distribute" && (
            <>
              <Head icon={Download} title="Desktop bundles"
                sub="Tauri produces platform-native installers from the same application source." />
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  { os: "Windows", formats: ".msi / setup .exe", note: "Build on Windows" },
                  { os: "Linux", formats: ".deb / .AppImage", note: "Build on Linux" },
                  { os: "macOS", formats: ".app / .dmg", note: "Build on macOS" },
                ].map((target) => (
                  <div key={target.os} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                    <div className="text-sm font-semibold text-white">{target.os}</div>
                    <div className="mt-1 font-mono text-[11px] text-cyan-300">{target.formats}</div>
                    <div className="mt-2 text-[11.5px] text-zinc-500">{target.note}</div>
                  </div>
                ))}
              </div>
              <Head icon={Terminal} title="Local package command" className="mt-8"
                sub="Run this on each target operating system after all checks pass." />
              <CodeBlock code={"npm ci\nnpm run check\nnpm run native:check\nnpm run desktop:build"} lang="bash" />
              <Note>
                Signing and automatic updates arrive in Phase 7. Unsigned development builds are
                suitable for local testing, but public Windows and macOS downloads will trigger
                trust warnings until signing is configured.
              </Note>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RuntimeCard({ runtime }: { runtime: RuntimeInfo }) {
  const native = runtime.runtime === "tauri";
  return (
    <section className={`rounded-xl border p-5 ${
      native ? "border-emerald-500/25 bg-emerald-500/[0.05]" : "border-amber-500/25 bg-amber-500/[0.05]"
    }`}>
      <div className="flex items-start gap-3">
        {native
          ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
          : <CircleDot className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />}
        <div className="min-w-0 flex-1">
          <h3 className={`text-sm font-semibold ${native ? "text-emerald-200" : "text-amber-200"}`}>
            {native ? "Trusted native runtime connected" : "Browser UI preview"}
          </h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-400">
            {native
              ? `Tauri ${runtime.appVersion} · ${runtime.os}/${runtime.arch}${runtime.debug ? " · debug build" : ""}`
              : "Native commands are intentionally unavailable. Start DevLab with npm run desktop:dev."}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(runtime.capabilities.length ? runtime.capabilities : ["no native capabilities"]).map((capability) => (
              <span key={capability} className="rounded bg-black/20 px-2 py-0.5 font-mono text-[10.5px] text-zinc-400">
                {capability}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ArchitectureCard({
  icon: Icon, title, items,
}: {
  icon: typeof Laptop;
  title: string;
  items: string[];
}) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-cyan-300" />
        <h3 className="text-sm font-semibold text-white">{title}</h3>
      </div>
      <ul className="mt-3 space-y-1.5 text-[12.5px] text-zinc-400">
        {items.map((item) => <li key={item}>• {item}</li>)}
      </ul>
    </section>
  );
}

function Head({
  icon: Icon, title, sub, className = "",
}: {
  icon: typeof Rocket;
  title: string;
  sub: string;
  className?: string;
}) {
  return (
    <div className={`mb-3 flex items-start gap-3 ${className}`}>
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/20 to-violet-600/20 ring-1 ring-white/10">
        <Icon className="h-4 w-4 text-cyan-200" />
      </span>
      <div>
        <h2 className="text-[15px] font-semibold text-white">{title}</h2>
        {sub && <p className="mt-0.5 text-[12.5px] text-zinc-500">{sub}</p>}
      </div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-4 text-[13px] leading-relaxed text-amber-100/90 [&_code]:rounded [&_code]:bg-black/30 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px]">
      {children}
    </div>
  );
}
