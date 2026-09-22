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
  libdbus-1-dev pkg-config \\
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

# Native Rust backend and workspace-boundary tests
npm run native:check
npm run native:test

# Produce this operating system's installer/bundle
npm run desktop:build`;

type PhaseStatus = "complete" | "active" | "next" | "planned";
interface MigrationPhase {
  n: number;
  title: string;
  status: PhaseStatus;
  detail: string;
}

const PHASES: readonly MigrationPhase[] = [
  {
    n: 1,
    title: "Native foundation",
    status: "complete",
    detail: "Tauri shell, typed runtime handshake, restrictive capabilities, branded application bundle and native/web detection.",
  },
  {
    n: 2,
    title: "Real workspaces",
    status: "complete",
    detail: "Native folder picker, canonical scope enforcement, guarded file CRUD, change watching and Monaco connected to actual files.",
  },
  {
    n: 3,
    title: "Real terminal",
    status: "complete",
    detail: "PTY-backed shell sessions with byte-stream output, resize, bounded history, termination and real exit codes.",
  },
  {
    n: 4,
    title: "Git and secure secrets",
    status: "complete",
    detail: "Workspace-root-scoped status, diffs, staging, commits, branches, remotes and confirmed network operations, with Git tokens protected by the OS credential store.",
  },
  {
    n: 5,
    title: "Docker, databases and native HTTP",
    status: "complete",
    detail: "Docker, SQLite, PostgreSQL and native HTTP are complete. Phase 6 now has bounded test execution, reviewed repair drafts, explicit reviewed-draft application, native audit metadata, permission-gated multi-file draft staging, reviewed draft diff inspection, unified generated-draft staging across generators, AI Agent reviewed draft extraction, read-only workspace file context, audited context metadata, refreshable Agent context revisions, a native context file browser, searchable Agent audit activity, metadata details, copyable metadata summaries, AI Agent reviewed-draft manifests, extraction diagnostics, Editor reviewed-draft summaries, explicit draft recompare guidance, a session applied-draft ledger, read-only native toolchain detection, task-aware model-routing metadata, bounded metadata-only Agent repository maps with client-side preview/filter/copy and focus hints, spec-first Builder review packs with acceptance/risk metadata, preview/copy affordances, task DAG implementation batches, metadata-only task handoff packets and per-task Editor review staging with a session-only staging ledger and session-only task apply progress fed back from explicit Editor apply and a per-task verification handoff that pre-selects a discovered profile in Self-Healing Tests and reports explicit run metadata back plus a repair handoff that offers failed-batch applied targets as reviewed repair-draft candidates, reviewed-draft verification guidance, a path-only reviewed-draft policy with a built-in secret-safe deny list enforced at the shared staging gate, a session-only Builder task run timeline with metadata-only loop-summary export, session-only named Editor review views, a Rust-owned loopback-only Ollama adapter for local model generation, native DeepSeek/OpenAI/Anthropic adapters with keys held only in the OS credential store, native in-memory workspace search (SQLite FTS5 plus optional local Ollama embeddings), inline Monaco diff review/navigation, session-only review annotations, review-queue filters, keyboard shortcuts, prompt-level generation guardrails, metadata-only starter blueprint guidance, design-system guidance, quality checklist guidance and read-only guidance previews; broader agent patch tools, Tree-Sitter context indexing and future provider adapters are next.",
  },
  {
    n: 6,
    title: "Agent tool execution",
    status: "active",
    detail: "Bounded native test execution, reviewed in-memory repair drafts, explicit draft application, native audit metadata, permission-gated multi-file draft staging, draft diff inspection, unified generator staging, AI Agent reviewed draft extraction, read-only workspace context, audited context metadata, explicit context refresh, a native context browser, searchable Agent audit visibility, shared event metadata details, copyable metadata summaries, reviewed-draft manifests, extraction diagnostics, Editor reviewed-draft summaries, explicit draft recompare guidance, a session applied-draft ledger, read-only native toolchain detection, task-aware model-router metadata, bounded metadata-only Agent repository maps with client-side preview/filter/copy and focus hints, spec-first Builder review packs with acceptance/risk metadata, preview/copy affordances, task DAG implementation batches, metadata-only task handoff packets and per-task Editor review staging with a session-only staging ledger and session-only task apply progress fed back from explicit Editor apply and a per-task verification handoff that pre-selects a discovered profile in Self-Healing Tests and reports explicit run metadata back plus a repair handoff that offers failed-batch applied targets as reviewed repair-draft candidates, reviewed-draft verification guidance, a path-only reviewed-draft policy with a built-in secret-safe deny list enforced at the shared staging gate, a session-only Builder task run timeline with metadata-only loop-summary export, session-only named Editor review views, a Rust-owned loopback-only Ollama adapter for local model generation, native DeepSeek/OpenAI/Anthropic adapters with keys held only in the OS credential store, native in-memory workspace search (SQLite FTS5 plus optional local Ollama embeddings), inline Monaco diff review/navigation, session-only review annotations, review-queue filters, keyboard shortcuts, prompt-level generation guardrails, metadata-only starter blueprint guidance, design-system guidance, quality checklist guidance and read-only guidance previews are implemented first. Broader agent patch tools, Tree-Sitter context indexing and the custom OpenAI-compatible endpoint adapter follow.",
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
                sub="Gemini continues to use its BYOK renderer flow. Phase 4 OS-protected storage is used for Git provider tokens." />
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
                creates only a browser UI preview. Workspace Editor, PTY Terminal, Source Control
                Docker, workspace-scoped SQLite, PostgreSQL connectivity/schema/bounded reads/separately confirmed writes, native HTTP, bounded native test execution, reviewed one-file repair drafts, and explicit reviewed-draft application are available through <code>npm run desktop:dev</code>;
                broader autonomous patch application stays disabled until its own reviewed native increment is implemented.
              </Note>
            </>
          )}

          {tab === "architecture" && (
            <>
              <Head icon={Cpu} title="Native boundary"
                sub="The React renderer receives typed session and workspace commands, never raw OS handles." />
              <div className="grid gap-3 md:grid-cols-2">
                <ArchitectureCard
                  icon={Laptop}
                  title="React renderer"
                  items={["DevLab interface", "Source previews", "User intent and approvals", "Typed IPC client", "No privileged APIs"]}
                />
                <ArchitectureCard
                  icon={Cpu}
                  title="Rust core · phased"
                  items={["Runtime handshake", "Canonical workspace boundary", "Guarded file CRUD and watcher", "Cross-platform PTY sessions", "Scoped Git, OS credentials, bounded Docker/SQLite/PostgreSQL, native HTTP, native test execution, reviewed repair drafts and explicit draft application"]}
                />
              </div>

              <div className="my-5 flex items-center gap-3 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.05] p-4">
                <Shield className="h-5 w-5 shrink-0 text-cyan-300" />
                <p className="text-[13px] leading-relaxed text-zinc-300">
                  Every privileged action crosses a typed Tauri command. Each backend validates
                  its capability-specific boundary: canonical paths for file operations and
                  Rust-owned session IDs, dimensions and payload limits for PTY operations.
                </p>
              </div>

              <Head icon={Shield} title="Default-deny rules" className="mt-8" sub="" />
              <ul className="space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-5 text-[13px] text-zinc-300">
                {[
                  "Only the main application window receives core Tauri permissions.",
                  "Every custom command has an explicit generated allow permission for that window.",
                  "A capability is not advertised until its backend and tests exist.",
                  "Filesystem API paths must resolve inside a user-selected workspace.",
                  "PTY shells start in that workspace but retain the user account's full authority.",
                  "Destructive agent commands require explicit approval unless a narrow policy permits them.",
                  "Saved Git tokens never return to the renderer; it receives only presence and backend metadata.",
                  "Docker commands accept validated IDs and typed creation fields; pulls have fixed arguments, and arbitrary CLI flags are not exposed.",
                  "SQLite files must resolve inside the selected workspace; writes are disabled by default and confirmed one statement at a time.",
                  "PostgreSQL TLS is explicit; schema uses fixed SQL; every statement runs as one bounded parameter-free statement, classified by the server in a read-only transaction before any confirmed mutation.",
                  "Remote pages are never loaded into a privileged application context.",
                  "Agent test runs, reviewed-draft writes and multi-file draft staging now have native audit metadata; broader agent tools will add timeout and cancellation metadata before autonomous actions are enabled.",
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
                    phase.status === "complete"
                      ? "border-emerald-500/25 bg-emerald-500/[0.05]"
                      : phase.status === "active"
                        ? "border-cyan-500/30 bg-cyan-500/[0.06]"
                        : phase.status === "next"
                          ? "border-amber-500/20 bg-amber-500/[0.04]"
                          : "border-white/10 bg-white/[0.02]"
                  }`}>
                    <div className="flex items-start gap-3">
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-bold ${
                        phase.status === "complete" ? "bg-emerald-500/15 text-emerald-200"
                          : phase.status === "active" ? "bg-cyan-500/20 text-cyan-200"
                            : phase.status === "next" ? "bg-amber-500/15 text-amber-200"
                              : "bg-white/5 text-zinc-500"
                      }`}>{phase.n}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-[13.5px] font-semibold text-white">{phase.title}</h3>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                            phase.status === "complete" ? "bg-emerald-500/15 text-emerald-300"
                              : phase.status === "active" ? "bg-cyan-500/15 text-cyan-300"
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
              <CodeBlock code={"npm ci\nnpm run check\nnpm run native:check\nnpm run native:test\nnpm run desktop:build"} lang="bash" />
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
