import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { loadGit, saveGit, type GitConfig } from "../lib/settings";
import {
  commitGitChanges,
  deleteGitCredential,
  fetchGitRemote,
  getGitCredentialStatus,
  getGitDiff,
  getGitSnapshot,
  pullGitRemote,
  pushGitRemote,
  stageAllGitChanges,
  stageGitPaths,
  storeGitCredential,
  unstageAllGitChanges,
  unstageGitPaths,
  type CredentialStatus,
  type GitChange,
  type GitDiff,
  type GitOperationResult,
  type GitProvider,
  type GitRepository,
  type GitSnapshot,
} from "../lib/git";
import { onWorkspaceChange } from "../lib/workspace";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CheckCircle2,
  ChevronDown,
  FileDiff,
  GitBranch,
  GitCommit,
  History,
  KeyRound,
  Link2,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wifi,
} from "lucide-react";

const PROVIDERS: { id: GitProvider; label: string; host: string }[] = [
  { id: "github", label: "GitHub", host: "github.com" },
  { id: "gitlab", label: "GitLab", host: "gitlab.com" },
  { id: "bitbucket", label: "Bitbucket", host: "bitbucket.org" },
];
const COMMIT_TYPES = ["feat", "fix", "chore", "docs", "refactor", "test", "perf", "ci"];

type Tab = "changes" | "history" | "repository" | "credentials";

export function GitPanel({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<Tab>("changes");
  const [config, setConfig] = useState<GitConfig>(loadGit);
  const [message, setMessage] = useState("");
  const [commitType, setCommitType] = useState("feat");
  const [scope, setScope] = useState("");
  const [selectedDiff, setSelectedDiff] = useState<GitDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState("");
  const [selectedRemote, setSelectedRemote] = useState("");
  const [credentials, setCredentials] = useState<Partial<Record<GitProvider, CredentialStatus>>>({});
  const [credentialInputs, setCredentialInputs] = useState<Partial<Record<GitProvider, string>>>({});
  const [credentialError, setCredentialError] = useState("");

  const repository = snapshot?.repository ?? null;

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const next = await getGitSnapshot();
      setSnapshot(next);
      setSelectedDiff(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const refreshCredentials = useCallback(async () => {
    setCredentialError("");
    const results = await Promise.allSettled(
      PROVIDERS.map(async ({ id }) => [id, await getGitCredentialStatus(id)] as const),
    );
    const next: Partial<Record<GitProvider, CredentialStatus>> = {};
    let failure = "";
    for (const result of results) {
      if (result.status === "fulfilled") next[result.value[0]] = result.value[1];
      else failure ||= errorMessage(result.reason);
    }
    setCredentials(next);
    setCredentialError(failure);
  }, []);

  useEffect(() => {
    void refresh();
    void refreshCredentials();
  }, [refresh, refreshCredentials]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | undefined;
    void onWorkspaceChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refresh(true); }, 400);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [refresh]);

  useEffect(() => {
    if (!repository?.remotes.length) {
      setSelectedRemote("");
      return;
    }
    if (!repository.remotes.some((remote) => remote.name === selectedRemote)) {
      setSelectedRemote(
        repository.remotes.find((remote) => remote.name === "origin")?.name
          ?? repository.remotes[0].name,
      );
    }
  }, [repository?.remotes, selectedRemote]);

  const staged = useMemo(
    () => repository?.changes.filter((change) => change.staged) ?? [],
    [repository],
  );
  const unstaged = useMemo(
    () => repository?.changes.filter((change) => change.unstaged) ?? [],
    [repository],
  );

  const fullMessage = config.commitStyle === "conventional"
    ? `${commitType}${scope.trim() ? `(${scope.trim()})` : ""}: ${message.trim()}`
    : message.trim();

  function persistConfig(next: GitConfig) {
    setConfig(next);
    saveGit(next);
  }

  async function runOperation(
    label: string,
    operation: () => Promise<GitOperationResult>,
  ) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const result = await operation();
      setSnapshot((current) => current ? { ...current, repository: result.repository } : current);
      setSelectedDiff(null);
      setNotice([result.message, result.output].filter(Boolean).join(" "));
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function openDiff(change: GitChange) {
    setDiffLoading(change.path);
    setError("");
    try {
      setSelectedDiff(await getGitDiff(change.path));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setDiffLoading("");
    }
  }

  async function commit() {
    if (!fullMessage || staged.length === 0) return;
    if (await runOperation("commit", () => commitGitChanges(fullMessage))) {
      setMessage("");
      setScope("");
    }
  }

  async function networkAction(action: "fetch" | "pull" | "push") {
    if (!selectedRemote) return;
    const prompt = action === "fetch"
      ? `Fetch and prune refs from “${selectedRemote}”? This starts a real network operation.`
      : action === "pull"
        ? `Fast-forward the current branch from “${selectedRemote}”? DevLab will refuse a merge or rebase.`
        : `Push the current branch to “${selectedRemote}”? This updates the real remote repository.`;
    if (!confirm(prompt)) return;
    const operations = {
      fetch: () => fetchGitRemote(selectedRemote),
      pull: () => pullGitRemote(selectedRemote),
      push: () => pushGitRemote(selectedRemote),
    };
    await runOperation(action, operations[action]);
  }

  async function saveCredential(provider: GitProvider) {
    const token = credentialInputs[provider] ?? "";
    if (!token.trim()) return;
    setBusy(`credential-${provider}`);
    setCredentialError("");
    try {
      const status = await storeGitCredential(provider, token);
      setCredentials((current) => ({ ...current, [provider]: status }));
      setCredentialInputs((current) => ({ ...current, [provider]: "" }));
      setNotice(`${providerLabel(provider)} credential saved to ${status.backend}.`);
    } catch (caught) {
      setCredentialError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function removeCredential(provider: GitProvider) {
    if (!confirm(`Delete the saved ${providerLabel(provider)} credential from the operating-system credential store?`)) return;
    setBusy(`credential-${provider}`);
    setCredentialError("");
    try {
      const status = await deleteGitCredential(provider);
      setCredentials((current) => ({ ...current, [provider]: status }));
      setNotice(`${providerLabel(provider)} credential deleted.`);
    } catch (caught) {
      setCredentialError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  const ready = snapshot?.state.code === "ready" && !!repository;
  const subtitle = ready
    ? `${repository.root} · ${repository.branch ?? "detached HEAD"}`
    : snapshot?.state.message ?? "Inspecting the selected native workspace";

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Source Control"
        subtitle={subtitle}
        badge={ready ? "Native Git" : "Unavailable"}
        badgeOk={ready}
      />

      <div className="flex items-center justify-between border-b border-white/5 bg-[#0d1017]/40 px-6">
        <div className="flex gap-5 text-xs">
          {([
            { id: "changes", Icon: GitCommit, label: `Changes${repository ? ` (${repository.changes.length})` : ""}` },
            { id: "history", Icon: History, label: "History" },
            { id: "repository", Icon: GitBranch, label: "Repository" },
            { id: "credentials", Icon: KeyRound, label: "Credentials" },
          ] as const).map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 py-3 font-medium ${
                tab === item.id
                  ? "border-cyan-400 text-white"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <item.Icon className="h-3.5 w-3.5" /> {item.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading || !!busy}
          title="Refresh from Git"
          className="rounded-lg p-2 text-zinc-500 hover:bg-white/5 hover:text-zinc-200 disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && <Banner tone="error" text={error} />}
      {notice && <Banner tone="success" text={notice} onClose={() => setNotice("")} />}

      {loading && !snapshot ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin text-cyan-400" /> Reading the real repository…
        </div>
      ) : tab !== "credentials" && !ready ? (
        <UnavailableState snapshot={snapshot} onRefresh={() => void refresh()} onOpenWorkspace={onOpenWorkspace} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "changes" && repository && (
            <div className="mx-auto grid max-w-6xl gap-5 p-6 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="min-w-0 space-y-5">
                <ChangeSection
                  title="Staged changes"
                  changes={staged}
                  empty="No changes are staged."
                  action="unstage"
                  busy={busy}
                  diffLoading={diffLoading}
                  onOpenDiff={openDiff}
                  onAction={(change) => void runOperation(
                    "unstage",
                    () => unstageGitPaths(change.originalPath ? [change.path, change.originalPath] : [change.path]),
                  )}
                  onAll={() => void runOperation("unstage-all", unstageAllGitChanges)}
                />
                <ChangeSection
                  title="Working tree"
                  changes={unstaged}
                  empty="The working tree is clean."
                  action="stage"
                  busy={busy}
                  diffLoading={diffLoading}
                  onOpenDiff={openDiff}
                  onAction={(change) => void runOperation(
                    "stage",
                    () => stageGitPaths(change.originalPath ? [change.path, change.originalPath] : [change.path]),
                  )}
                  onAll={() => void runOperation("stage-all", stageAllGitChanges)}
                />
                {selectedDiff && <DiffViewer diff={selectedDiff} onClose={() => setSelectedDiff(null)} />}
              </div>

              <aside className="space-y-4">
                <section className="rounded-xl border border-white/10 bg-white/[0.02] p-5 ring-soft">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-white">Create commit</h3>
                    <span className="text-[11px] text-zinc-500">{staged.length} staged</span>
                  </div>
                  <label className="mt-4 block text-[11.5px] font-medium text-zinc-400">Message</label>
                  {config.commitStyle === "conventional" && (
                    <div className="mt-1.5 grid grid-cols-[110px_1fr] gap-2">
                      <select
                        value={commitType}
                        onChange={(event) => setCommitType(event.target.value)}
                        className={inputClass}
                      >
                        {COMMIT_TYPES.map((type) => <option key={type} className="text-zinc-900">{type}</option>)}
                      </select>
                      <input
                        value={scope}
                        onChange={(event) => setScope(event.target.value)}
                        className={inputClass}
                        placeholder="scope (optional)"
                      />
                    </div>
                  )}
                  <textarea
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    rows={4}
                    maxLength={4096}
                    className={`${inputClass} mt-2 resize-none`}
                    placeholder="Describe the staged changes"
                  />
                  {message.trim() && (
                    <div className="mt-2 break-words rounded-lg bg-black/30 px-3 py-2 font-mono text-[11px] text-zinc-400">
                      {fullMessage}
                    </div>
                  )}
                  <button
                    onClick={() => void commit()}
                    disabled={!!busy || !fullMessage || staged.length === 0}
                    className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:from-cyan-400 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy === "commit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCommit className="h-3.5 w-3.5" />}
                    Commit staged changes
                  </button>
                  <label className="mt-4 flex items-center justify-between gap-3 text-[11.5px] text-zinc-400">
                    Conventional Commit helper
                    <input
                      type="checkbox"
                      checked={config.commitStyle === "conventional"}
                      onChange={(event) => persistConfig({ commitStyle: event.target.checked ? "conventional" : "plain" })}
                      className="accent-cyan-500"
                    />
                  </label>
                  <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
                    Git uses your existing user.name and user.email configuration. DevLab does not fabricate author data and disables repository hooks for this operation.
                  </p>
                </section>

                <NetworkControls
                  repository={repository}
                  selectedRemote={selectedRemote}
                  onRemoteChange={setSelectedRemote}
                  busy={busy}
                  onAction={networkAction}
                />
              </aside>
            </div>
          )}

          {tab === "history" && repository && <HistoryView repository={repository} />}
          {tab === "repository" && repository && (
            <RepositoryView
              repository={repository}
              selectedRemote={selectedRemote}
              onRemoteChange={setSelectedRemote}
              busy={busy}
              onAction={networkAction}
            />
          )}
          {tab === "credentials" && (
            <CredentialsView
              credentials={credentials}
              inputs={credentialInputs}
              error={credentialError}
              busy={busy}
              onInput={(provider, value) => setCredentialInputs((current) => ({ ...current, [provider]: value }))}
              onSave={(provider) => void saveCredential(provider)}
              onDelete={(provider) => void removeCredential(provider)}
              onRefresh={() => void refreshCredentials()}
            />
          )}
        </div>
      )}
    </div>
  );
}

function UnavailableState({
  snapshot,
  onRefresh,
  onOpenWorkspace,
}: {
  snapshot: GitSnapshot | null;
  onRefresh: () => void;
  onOpenWorkspace: () => void;
}) {
  const state = snapshot?.state;
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-lg rounded-2xl border border-amber-500/20 bg-amber-500/[0.05] p-7 text-center ring-soft">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/10 ring-1 ring-amber-500/20">
          <AlertCircle className="h-6 w-6 text-amber-300" />
        </div>
        <h3 className="mt-4 text-lg font-semibold text-white">
          {state?.code === "git_not_installed" ? "Git is not installed" : "Repository unavailable"}
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-zinc-400">
          {state?.message ?? "DevLab could not inspect Git in this workspace."}
        </p>
        {snapshot?.gitVersion && <p className="mt-2 font-mono text-[11px] text-zinc-600">{snapshot.gitVersion}</p>}
        <div className="mt-5 flex justify-center gap-2">
          <button
            onClick={onOpenWorkspace}
            className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-400"
          >
            Open workspace
          </button>
          <button onClick={onRefresh} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-300 hover:bg-white/5">
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}

function ChangeSection({
  title,
  changes,
  empty,
  action,
  busy,
  diffLoading,
  onOpenDiff,
  onAction,
  onAll,
}: {
  title: string;
  changes: GitChange[];
  empty: string;
  action: "stage" | "unstage";
  busy: string | null;
  diffLoading: string;
  onOpenDiff: (change: GitChange) => void;
  onAction: (change: GitChange) => void;
  onAll: () => void;
}) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.02] ring-soft">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <p className="text-[11px] text-zinc-600">{changes.length} path{changes.length === 1 ? "" : "s"}</p>
        </div>
        {changes.length > 0 && (
          <button
            onClick={onAll}
            disabled={!!busy}
            className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-white disabled:opacity-40"
          >
            {action === "stage" ? "Stage all" : "Unstage all"}
          </button>
        )}
      </div>
      <div className="p-2">
        {changes.length === 0 ? (
          <div className="px-3 py-5 text-center text-[12px] text-zinc-600">{empty}</div>
        ) : changes.map((change) => (
          <div key={`${action}-${change.path}`} className="group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-white/5">
            <StatusBadge change={change} mode={action === "stage" ? "worktree" : "index"} />
            <button onClick={() => onOpenDiff(change)} className="min-w-0 flex-1 text-left">
              <div className="truncate font-mono text-[12px] text-zinc-300">{change.path}</div>
              {change.originalPath && <div className="truncate font-mono text-[10px] text-zinc-600">from {change.originalPath}</div>}
            </button>
            {diffLoading === change.path && <Loader2 className="h-3 w-3 animate-spin text-cyan-400" />}
            <button
              onClick={() => onAction(change)}
              disabled={!!busy}
              title={action === "stage" ? "Stage path" : "Unstage path"}
              className="rounded-md border border-white/10 p-1.5 text-zinc-500 opacity-0 transition hover:text-white group-hover:opacity-100 disabled:opacity-30"
            >
              {action === "stage" ? <Plus className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function StatusBadge({ change, mode }: { change: GitChange; mode: "index" | "worktree" }) {
  const value = mode === "index" ? change.indexStatus : change.worktreeStatus;
  const display = value === "?" ? "U" : value;
  const colors = change.conflicted
    ? "bg-rose-500/15 text-rose-300"
    : display === "A" || display === "U"
      ? "bg-emerald-500/15 text-emerald-300"
      : display === "D"
        ? "bg-rose-500/15 text-rose-300"
        : "bg-amber-500/15 text-amber-300";
  return (
    <span title={`${change.kind} · ${mode}`} className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[10px] font-bold ${colors}`}>
      {display}
    </span>
  );
}

function DiffViewer({ diff, onClose }: { diff: GitDiff; onClose: () => void }) {
  const content = [
    diff.staged && `# Staged diff\n${diff.staged}`,
    diff.unstaged && `# Working-tree diff\n${diff.unstaged}`,
  ].filter(Boolean).join("\n\n");
  return (
    <section className="rounded-xl border border-cyan-500/20 bg-[#0b0e14] ring-soft">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-white"><FileDiff className="h-4 w-4 text-cyan-300" /> Diff</div>
          <div className="truncate font-mono text-[10.5px] text-zinc-600">{diff.path}</div>
        </div>
        <button onClick={onClose} className="rounded px-2 py-1 text-[11px] text-zinc-500 hover:bg-white/5 hover:text-white">Close</button>
      </div>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-relaxed text-zinc-300">
        {content || "No textual diff is available for this path."}
      </pre>
    </section>
  );
}

function NetworkControls({
  repository,
  selectedRemote,
  onRemoteChange,
  busy,
  onAction,
}: {
  repository: GitRepository;
  selectedRemote: string;
  onRemoteChange: (remote: string) => void;
  busy: string | null;
  onAction: (action: "fetch" | "pull" | "push") => void;
}) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.02] p-5 ring-soft">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Remote operations</h3>
        {(repository.ahead > 0 || repository.behind > 0) && (
          <span className="text-[10.5px] text-zinc-500">↑{repository.ahead} ↓{repository.behind}</span>
        )}
      </div>
      {repository.remotes.length === 0 ? (
        <p className="mt-3 text-[12px] leading-relaxed text-zinc-500">
          No Git remote is configured. Add one with the terminal before fetching or pushing.
        </p>
      ) : (
        <>
          <div className="relative mt-3">
            <select value={selectedRemote} onChange={(event) => onRemoteChange(event.target.value)} className={`${inputClass} appearance-none pr-8`}>
              {repository.remotes.map((remote) => <option key={remote.name} className="text-zinc-900">{remote.name}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-2.5 h-3.5 w-3.5 text-zinc-600" />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <NetworkButton label="Fetch" Icon={Wifi} running={busy === "fetch"} disabled={!!busy} onClick={() => onAction("fetch")} />
            <NetworkButton label="Pull" Icon={ArrowDownToLine} running={busy === "pull"} disabled={!!busy || repository.detached} onClick={() => onAction("pull")} />
            <NetworkButton label="Push" Icon={ArrowUpFromLine} running={busy === "push"} disabled={!!busy || repository.detached || repository.unborn} onClick={() => onAction("push")} />
          </div>
          <p className="mt-3 text-[10.5px] leading-relaxed text-zinc-600">
            Every network action requires confirmation. Pull is fast-forward only; force push is not exposed.
          </p>
        </>
      )}
    </section>
  );
}

function NetworkButton({
  label,
  Icon,
  running,
  disabled,
  onClick,
}: {
  label: string;
  Icon: typeof Wifi;
  running: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} disabled={disabled} className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/10 px-2 py-2 text-[11.5px] text-zinc-300 hover:bg-white/5 disabled:opacity-40">
      {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />} {label}
    </button>
  );
}

function HistoryView({ repository }: { repository: GitRepository }) {
  return (
    <div className="mx-auto max-w-4xl p-6">
      <section className="rounded-xl border border-white/10 bg-white/[0.02] ring-soft">
        <div className="border-b border-white/5 px-5 py-4">
          <h3 className="text-sm font-semibold text-white">Commit history</h3>
          <p className="mt-0.5 text-[11px] text-zinc-600">Latest {repository.commits.length} real commit{repository.commits.length === 1 ? "" : "s"}</p>
        </div>
        {repository.commits.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-600">This repository has no commits yet.</div>
        ) : (
          <div className="divide-y divide-white/5">
            {repository.commits.map((commit) => (
              <div key={commit.hash} className="flex gap-4 px-5 py-3.5">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-cyan-400 ring-4 ring-cyan-500/10" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-zinc-100">{commit.subject}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-zinc-600">
                    <span className="font-mono text-cyan-400">{commit.shortHash}</span>
                    <span>{commit.authorName} &lt;{commit.authorEmail}&gt;</span>
                    <span>{formatDate(commit.timestamp)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RepositoryView({
  repository,
  selectedRemote,
  onRemoteChange,
  busy,
  onAction,
}: {
  repository: GitRepository;
  selectedRemote: string;
  onRemoteChange: (remote: string) => void;
  busy: string | null;
  onAction: (action: "fetch" | "pull" | "push") => void;
}) {
  return (
    <div className="mx-auto grid max-w-5xl gap-5 p-6 lg:grid-cols-2">
      <section className="rounded-xl border border-white/10 bg-white/[0.02] p-5 ring-soft">
        <h3 className="text-sm font-semibold text-white">Repository identity</h3>
        <dl className="mt-4 space-y-3 text-[12px]">
          <Definition label="Root" value={repository.root} mono />
          <Definition label="Current branch" value={repository.branch ?? "Detached HEAD"} />
          <Definition label="HEAD" value={repository.head?.slice(0, 12) ?? "No commits"} mono />
          <Definition label="Upstream" value={repository.upstream ?? "Not configured"} />
          <Definition label="Author" value={repository.userName && repository.userEmail ? `${repository.userName} <${repository.userEmail}>` : "Not configured in Git"} />
          <Definition label="Divergence" value={`${repository.ahead} ahead · ${repository.behind} behind`} />
        </dl>
      </section>

      <NetworkControls repository={repository} selectedRemote={selectedRemote} onRemoteChange={onRemoteChange} busy={busy} onAction={onAction} />

      <section className="rounded-xl border border-white/10 bg-white/[0.02] ring-soft">
        <div className="border-b border-white/5 px-5 py-4">
          <h3 className="text-sm font-semibold text-white">Branches</h3>
        </div>
        <div className="max-h-80 divide-y divide-white/5 overflow-y-auto">
          {repository.branches.length === 0 ? <p className="p-5 text-[12px] text-zinc-600">No branch refs.</p> : repository.branches.map((branch) => (
            <div key={`${branch.kind}-${branch.name}`} className="flex items-center gap-3 px-5 py-3">
              <GitBranch className={`h-3.5 w-3.5 ${branch.current ? "text-cyan-300" : "text-zinc-600"}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-zinc-200">{branch.name}</div>
                <div className="text-[10px] text-zinc-600">{branch.kind}{branch.upstream ? ` · ${branch.upstream}` : ""}</div>
              </div>
              <span className="font-mono text-[10px] text-zinc-600">{branch.hash}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/[0.02] ring-soft">
        <div className="border-b border-white/5 px-5 py-4">
          <h3 className="text-sm font-semibold text-white">Remotes</h3>
        </div>
        <div className="divide-y divide-white/5">
          {repository.remotes.length === 0 ? <p className="p-5 text-[12px] text-zinc-600">No remotes configured.</p> : repository.remotes.map((remote) => (
            <div key={remote.name} className="px-5 py-3">
              <div className="flex items-center gap-2 text-[12px] font-medium text-zinc-200">
                <Link2 className="h-3.5 w-3.5 text-violet-300" /> {remote.name}
                <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] uppercase text-zinc-500">{remote.usesSsh ? "SSH" : remote.provider ?? "Git"}</span>
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-zinc-600">fetch {remote.fetchUrl}</div>
              {remote.pushUrl !== remote.fetchUrl && <div className="truncate font-mono text-[10px] text-zinc-600">push {remote.pushUrl}</div>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function CredentialsView({
  credentials,
  inputs,
  error,
  busy,
  onInput,
  onSave,
  onDelete,
  onRefresh,
}: {
  credentials: Partial<Record<GitProvider, CredentialStatus>>;
  inputs: Partial<Record<GitProvider, string>>;
  error: string;
  busy: string | null;
  onInput: (provider: GitProvider, value: string) => void;
  onSave: (provider: GitProvider) => void;
  onDelete: (provider: GitProvider) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-4 text-[12px] leading-relaxed text-emerald-100/80">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
        <div>
          Git provider tokens are stored by the operating system, never in localStorage. The renderer can save, replace, delete, and inspect presence metadata, but it cannot read a saved token back. HTTPS network operations inject a matching token only into the child Git process environment. SSH remotes continue to use your SSH setup.
        </div>
      </div>
      {error && <Banner tone="error" text={error} />}
      <div className="space-y-3">
        {PROVIDERS.map((provider) => {
          const status = credentials[provider.id];
          const running = busy === `credential-${provider.id}`;
          return (
            <section key={provider.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-5 ring-soft">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-white">
                    {provider.label}
                    {status?.configured && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9.5px] font-medium text-emerald-300"><Check className="h-2.5 w-2.5" /> Stored</span>}
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-zinc-600">{provider.host}{status ? ` · ${status.backend}` : ""}</div>
                </div>
                {status?.configured && (
                  <button onClick={() => onDelete(provider.id)} disabled={running} className="rounded-lg p-2 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-40" title="Delete credential">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="mt-4 flex gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  value={inputs[provider.id] ?? ""}
                  onChange={(event) => onInput(provider.id, event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") onSave(provider.id); }}
                  className={`${inputClass} flex-1`}
                  placeholder={status?.configured ? "Enter a replacement token" : "Enter a personal access token"}
                />
                <button
                  onClick={() => onSave(provider.id)}
                  disabled={running || !(inputs[provider.id] ?? "").trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3 py-2 text-[12px] font-semibold text-white hover:bg-cyan-400 disabled:opacity-40"
                >
                  {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                  {status?.configured ? "Replace" : "Save securely"}
                </button>
              </div>
            </section>
          );
        })}
      </div>
      <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-[11.5px] text-zinc-500">
        <span>DevLab also honors existing Git credential helpers when no DevLab token matches the HTTPS host.</span>
        <button onClick={onRefresh} className="ml-3 rounded p-1.5 hover:bg-white/5 hover:text-white" title="Refresh credential metadata"><RefreshCw className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  );
}

function Definition({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3">
      <dt className="text-zinc-600">{label}</dt>
      <dd className={`min-w-0 break-words text-zinc-300 ${mono ? "font-mono text-[11px]" : ""}`}>{value}</dd>
    </div>
  );
}

function Banner({ tone, text, onClose }: { tone: "error" | "success"; text: string; onClose?: () => void }) {
  return (
    <div className={`flex items-start gap-2 border-b px-6 py-2.5 text-[11.5px] ${tone === "error" ? "border-rose-500/20 bg-rose-500/[0.07] text-rose-200" : "border-emerald-500/20 bg-emerald-500/[0.07] text-emerald-200"}`}>
      {tone === "error" ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 break-words">{text}</span>
      {onClose && <button onClick={onClose} className="text-current opacity-60 hover:opacity-100">Dismiss</button>}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The native Git operation failed.";
}

function providerLabel(provider: GitProvider): string {
  return PROVIDERS.find((item) => item.id === provider)?.label ?? provider;
}

function formatDate(timestamp: number): string {
  if (!timestamp) return "Unknown time";
  return new Date(timestamp * 1000).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const inputClass = "min-w-0 rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-500/50";
