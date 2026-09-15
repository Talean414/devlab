import { useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { CodeBlock } from "../components/CodeBlock";
import { loadGit, saveGit, type GitConfig } from "../lib/settings";
import {
  CheckCircle2, Plus, Minus, GitCommit, Upload, Link2, Loader2,
  AlertCircle, Settings2, GitBranch,
} from "lucide-react";

interface FileChange { path: string; status: "M" | "A" | "D"; staged: boolean }

const initialChanges: FileChange[] = [
  { path: "src/App.tsx", status: "M", staged: false },
  { path: "src/panels/BuilderPanel.tsx", status: "A", staged: false },
  { path: "README.md", status: "M", staged: false },
  { path: "old-config.json", status: "D", staged: false },
];

const seedCommits = [
  { hash: "a1b2c3d", msg: "feat: add agentic project builder", author: "you", time: "2m ago" },
  { hash: "d4e5f6g", msg: "chore: bootstrap devlab shell", author: "you", time: "1h ago" },
  { hash: "h7i8j9k", msg: "initial commit", author: "you", time: "3h ago" },
];

const statusColor = { M: "text-amber-400 bg-amber-500/10", A: "text-emerald-400 bg-emerald-500/10", D: "text-rose-400 bg-rose-500/10" };
const TYPES = ["feat", "fix", "chore", "docs", "refactor", "test", "perf", "ci"];

export function GitPanel() {
  const [cfg, setCfg] = useState<GitConfig>(loadGit);
  const [changes, setChanges] = useState(initialChanges);
  const [message, setMessage] = useState("");
  const [type, setType] = useState("feat");
  const [scope, setScope] = useState("");
  const [log, setLog] = useState(seedCommits);
  const [tab, setTab] = useState<"changes" | "connect">(loadGit().repo ? "changes" : "connect");
  const [verify, setVerify] = useState<"idle" | "checking" | "ok" | "bad">("idle");
  const [repoMeta, setRepoMeta] = useState<{ stars: number; branch: string; priv: boolean } | null>(null);
  const [pushLog, setPushLog] = useState<string[]>([]);

  const staged = changes.filter((c) => c.staged);
  const unstaged = changes.filter((c) => !c.staged);
  const connected = !!(cfg.token && cfg.owner && cfg.repo);

  const fullMessage =
    cfg.commitStyle === "conventional"
      ? `${type}${scope ? `(${scope})` : ""}: ${message}`
      : message;

  function persist(next: GitConfig) { setCfg(next); saveGit(next); }

  async function verifyRepo() {
    setVerify("checking"); setRepoMeta(null);
    try {
      const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}`, {
        headers: cfg.token
          ? { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" }
          : { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) { setVerify("bad"); return; }
      const j = await res.json();
      setRepoMeta({ stars: j.stargazers_count ?? 0, branch: j.default_branch ?? "main", priv: !!j.private });
      persist({ ...cfg, branch: j.default_branch || cfg.branch });
      setVerify("ok");
    } catch { setVerify("bad"); }
  }

  function stage(path: string, val: boolean) {
    setChanges((cs) => cs.map((c) => (c.path === path ? { ...c, staged: val } : c)));
  }

  function commit() {
    if (!message.trim() || staged.length === 0) return;
    const hash = Math.random().toString(16).slice(2, 9);
    setLog((l) => [{ hash, msg: fullMessage, author: cfg.authorName || "you", time: "now" }, ...l]);
    setPushLog((p) => [
      `[commit] ${hash} — ${staged.length} file(s) → ${cfg.branch}`,
      ...p,
    ]);
    setChanges((cs) => cs.filter((c) => !c.staged));
    setMessage("");
    if (cfg.autoPush) push(hash);
  }

  function push(hash?: string) {
    if (!connected) {
      setPushLog((p) => ["[push] blocked — connect a repository first", ...p]);
      return;
    }
    setPushLog((p) => [
      `[push] ${cfg.owner}/${cfg.repo} ${cfg.branch} ${hash ? `(${hash})` : ""} — queued for native runtime`,
      ...p,
    ]);
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Source Control"
        subtitle={connected ? `${cfg.owner}/${cfg.repo} · ${cfg.branch}` : "Connect a repository to enable commit & push"}
        badge={connected ? "Connected" : "Not connected"}
        badgeOk={connected}
      />

      <div className="flex gap-5 border-b border-white/5 bg-[#0d1017]/40 px-6 text-xs">
        {([
          { id: "changes", Icon: GitCommit, label: "Changes" },
          { id: "connect", Icon: Settings2, label: "Repository" },
        ] as const).map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 py-3 font-medium ${
              tab === t.id ? "border-cyan-400 text-white" : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}>
            <t.Icon className="h-3.5 w-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {/* ── Repository config ── */}
      {tab === "connect" && (
        <div className="flex-1 overflow-y-auto p-7">
          <div className="mx-auto max-w-2xl space-y-5">
            <section className="rounded-xl border border-white/10 bg-white/[0.02] p-6 ring-soft">
              <div className="mb-4 flex items-center gap-2.5">
                <Link2 className="h-4 w-4 text-cyan-300" />
                <h3 className="text-sm font-semibold text-white">Connect your repository</h3>
              </div>

              <Grid>
                <Field label="Provider">
                  <select value={cfg.provider} onChange={(e) => persist({ ...cfg, provider: e.target.value as GitConfig["provider"] })} className={inputCls}>
                    <option value="github" className="text-zinc-900">GitHub</option>
                    <option value="gitlab" className="text-zinc-900">GitLab</option>
                    <option value="bitbucket" className="text-zinc-900">Bitbucket</option>
                  </select>
                </Field>
                <Field label="Default branch">
                  <input value={cfg.branch} onChange={(e) => persist({ ...cfg, branch: e.target.value })} className={inputCls} placeholder="main" />
                </Field>
                <Field label="Owner / org">
                  <input value={cfg.owner} onChange={(e) => persist({ ...cfg, owner: e.target.value })} className={inputCls} placeholder="your-username" />
                </Field>
                <Field label="Repository">
                  <input value={cfg.repo} onChange={(e) => persist({ ...cfg, repo: e.target.value })} className={inputCls} placeholder="my-project" />
                </Field>
                <Field label="Author name">
                  <input value={cfg.authorName} onChange={(e) => persist({ ...cfg, authorName: e.target.value })} className={inputCls} placeholder="Jane Dev" />
                </Field>
                <Field label="Author email">
                  <input value={cfg.authorEmail} onChange={(e) => persist({ ...cfg, authorEmail: e.target.value })} className={inputCls} placeholder="jane@example.com" />
                </Field>
              </Grid>

              <Field label="Personal access token" className="mt-4">
                <input type="password" value={cfg.token} onChange={(e) => persist({ ...cfg, token: e.target.value })} className={inputCls} placeholder="ghp_… (scopes: repo, workflow)" />
              </Field>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button onClick={verifyRepo} className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 px-4 py-2 text-sm font-semibold text-white hover:from-cyan-400 hover:to-blue-500">
                  {verify === "checking" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                  Verify connection
                </button>
                {verify === "ok" && repoMeta && (
                  <span className="inline-flex items-center gap-1.5 text-sm text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Found · {repoMeta.priv ? "private" : "public"} · default {repoMeta.branch}
                  </span>
                )}
                {verify === "bad" && (
                  <span className="inline-flex items-center gap-1.5 text-sm text-rose-400">
                    <AlertCircle className="h-3.5 w-3.5" /> Repo not found or token invalid
                  </span>
                )}
              </div>
            </section>

            <section className="rounded-xl border border-white/10 bg-white/[0.02] p-6 ring-soft">
              <h3 className="mb-3 text-sm font-semibold text-white">Automation rules</h3>
              <Toggle label="Use Conventional Commits" desc="Prefix messages with feat/fix/chore and an optional scope."
                on={cfg.commitStyle === "conventional"}
                onChange={(v) => persist({ ...cfg, commitStyle: v ? "conventional" : "plain" })} />
              <Toggle label="Auto-commit agent changes" desc="When the agent writes files, stage and commit them automatically."
                on={cfg.autoCommit} onChange={(v) => persist({ ...cfg, autoCommit: v })} />
              <Toggle label="Auto-push after commit" desc="Push straight to the remote branch once a commit succeeds."
                on={cfg.autoPush} onChange={(v) => persist({ ...cfg, autoPush: v })} />
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold text-white">Equivalent local setup</h3>
              <CodeBlock lang="bash" code={`git config --global user.name  "${cfg.authorName || "Your Name"}"
git config --global user.email "${cfg.authorEmail || "you@example.com"}"

# authenticate once with the GitHub CLI
gh auth login

# connect an existing folder
git init -b ${cfg.branch}
git remote add origin git@github.com:${cfg.owner || "you"}/${cfg.repo || "repo"}.git
git add . && git commit -m "chore: initial commit"
git push -u origin ${cfg.branch}`} />
            </section>
          </div>
        </div>
      )}

      {/* ── Changes ── */}
      {tab === "changes" && (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-96 shrink-0 flex-col border-r border-white/5 bg-[#0d1017]/40">
            <div className="space-y-2 border-b border-white/5 p-4">
              {cfg.commitStyle === "conventional" && (
                <div className="flex gap-2">
                  <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-lg border border-white/10 bg-[#0b0e14] px-2 py-1.5 text-[12px] text-cyan-300 outline-none">
                    {TYPES.map((t) => <option key={t} value={t} className="text-zinc-900">{t}</option>)}
                  </select>
                  <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="scope (optional)"
                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#0b0e14] px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600" />
                </div>
              )}
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2}
                placeholder="Commit message…"
                className="w-full resize-none rounded-lg border border-white/10 bg-[#0b0e14] p-3 text-sm text-zinc-100 outline-none focus:border-cyan-500/50" />
              {message && (
                <div className="truncate rounded-md bg-black/30 px-2.5 py-1.5 font-mono text-[11px] text-zinc-400">
                  {fullMessage}
                </div>
              )}
              <button onClick={commit} disabled={!message.trim() || staged.length === 0}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 py-2 text-sm font-semibold text-white hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40">
                <CheckCircle2 className="h-4 w-4" /> Commit ({staged.length})
              </button>
              <button onClick={() => push()} disabled={!connected}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] py-2 text-sm text-zinc-200 hover:bg-white/[0.06] disabled:opacity-40">
                <Upload className="h-4 w-4" /> Push to {cfg.owner || "origin"}/{cfg.branch}
              </button>
              {!connected && (
                <button onClick={() => setTab("connect")} className="w-full text-[11.5px] text-amber-300 hover:underline">
                  Connect a repository to enable push
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <Section title={`Staged (${staged.length})`}>
                {staged.map((c) => <Row key={c.path} c={c} onToggle={() => stage(c.path, false)} action="minus" />)}
              </Section>
              <Section title={`Changes (${unstaged.length})`}>
                {unstaged.map((c) => <Row key={c.path} c={c} onToggle={() => stage(c.path, true)} action="plus" />)}
              </Section>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
              <GitBranch className="h-4 w-4 text-cyan-400" /> Commit graph
            </h3>
            <div className="relative space-y-5 pl-7">
              <div className="absolute bottom-3 left-[10px] top-3 w-px bg-white/10" />
              {log.map((c) => (
                <div key={c.hash} className="relative">
                  <span className="absolute -left-7 top-1 h-3.5 w-3.5 rounded-full border-2 border-cyan-400 bg-[#0b0d12]" />
                  <div className="text-sm font-medium text-zinc-100">{c.msg}</div>
                  <div className="text-[11.5px] text-zinc-500">
                    <span className="font-mono text-cyan-400">{c.hash}</span>
                    <span className="mx-1.5 text-zinc-700">·</span>{c.author}
                    <span className="mx-1.5 text-zinc-700">·</span>{c.time}
                  </div>
                </div>
              ))}
            </div>

            {pushLog.length > 0 && (
              <>
                <h3 className="mb-2 mt-8 text-sm font-semibold text-white">Activity</h3>
                <div className="space-y-1 rounded-xl border border-white/10 bg-[#0b0e14] p-3 font-mono text-[11.5px] text-zinc-400">
                  {pushLog.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-500/50";

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}
function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="mb-1.5 block text-[12px] font-medium text-zinc-400">{label}</label>
      {children}
    </div>
  );
}
function Toggle({ label, desc, on, onChange }: { label: string; desc: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className="flex w-full items-start gap-3 rounded-lg px-1 py-2.5 text-left transition hover:bg-white/[0.03]">
      <span className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition ${on ? "bg-cyan-500" : "bg-white/10"}`}>
        <span className={`h-4 w-4 rounded-full bg-white transition ${on ? "translate-x-4" : ""}`} />
      </span>
      <span className="flex-1">
        <span className="block text-[13px] font-medium text-zinc-100">{label}</span>
        <span className="block text-[11.5px] text-zinc-500">{desc}</span>
      </span>
    </button>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 px-2 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}
function Row({ c, onToggle, action }: { c: FileChange; onToggle: () => void; action: "plus" | "minus" }) {
  return (
    <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-white/5">
      <span className={`inline-flex h-4 w-4 items-center justify-center rounded font-mono text-[10px] font-bold ${statusColor[c.status]}`}>{c.status}</span>
      <span className="flex-1 truncate font-mono text-[12.5px] text-zinc-300">{c.path}</span>
      <button onClick={onToggle} className="rounded bg-white/10 px-1.5 py-0.5 text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:text-white">
        {action === "plus" ? <Plus className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
      </button>
    </div>
  );
}
