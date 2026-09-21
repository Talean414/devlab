import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import {
  getDockerLogs,
  getDockerSnapshot,
  removeDockerContainer,
  restartDockerContainer,
  startDockerContainer,
  stopDockerContainer,
  type DockerContainer,
  type DockerLogs,
  type DockerOperationResult,
  type DockerSnapshot,
} from "../lib/docker";
import {
  AlertCircle,
  Box,
  CheckCircle2,
  Container,
  FileText,
  Gauge,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  Network,
  Play,
  RefreshCw,
  RotateCw,
  Server,
  ShieldAlert,
  Square,
  Trash2,
  X,
} from "lucide-react";

type Tab = "containers" | "images" | "engine";

export function DockerPanel() {
  const [snapshot, setSnapshot] = useState<DockerSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<Tab>("containers");
  const [logs, setLogs] = useState<DockerLogs | null>(null);
  const [logsLoading, setLogsLoading] = useState("");
  const refreshInFlight = useRef(false);

  const refresh = useCallback(async (quiet = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (!quiet) setLoading(true);
    setError("");
    try {
      setSnapshot(await getDockerSnapshot());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      refreshInFlight.current = false;
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(true); }, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const running = useMemo(
    () => snapshot?.containers.filter((container) => container.running).length ?? 0,
    [snapshot],
  );

  async function runOperation(
    key: string,
    operation: () => Promise<DockerOperationResult>,
  ) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const result = await operation();
      setSnapshot(result.snapshot);
      setNotice([result.message, result.output].filter(Boolean).join(" "));
      if (logs && !result.snapshot.containers.some((container) => container.id === logs.containerId)) {
        setLogs(null);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  async function openLogs(container: DockerContainer) {
    setLogsLoading(container.id);
    setError("");
    try {
      setLogs(await getDockerLogs(container.id));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLogsLoading("");
    }
  }

  function start(container: DockerContainer) {
    void runOperation(`start-${container.id}`, () => startDockerContainer(container.id));
  }

  function stop(container: DockerContainer) {
    if (!confirm(`Stop the real container “${container.name || container.shortId}”? Docker will wait up to 10 seconds before terminating it.`)) return;
    void runOperation(`stop-${container.id}`, () => stopDockerContainer(container.id));
  }

  function restart(container: DockerContainer) {
    if (!confirm(`Restart the real container “${container.name || container.shortId}”? Active connections may be interrupted.`)) return;
    void runOperation(`restart-${container.id}`, () => restartDockerContainer(container.id));
  }

  function remove(container: DockerContainer) {
    if (!confirm(`Permanently remove the stopped container “${container.name || container.shortId}”? Its writable container layer will be deleted.`)) return;
    void runOperation(`remove-${container.id}`, () => removeDockerContainer(container.id));
  }

  const ready = snapshot?.state.code === "ready" && snapshot.daemonConnected;
  const subtitle = ready
    ? `Docker Engine ${snapshot.daemonVersion ?? "connected"} · ${running} running · ${snapshot.containers.length} total`
    : snapshot?.state.message ?? "Detecting Docker CLI and engine";

  return (
    <div className="relative flex h-full flex-col">
      <PanelHeader
        title="Docker & Containers"
        subtitle={subtitle}
        badge={ready ? "Engine connected" : "Unavailable"}
        badgeOk={ready}
      />

      <div className="flex items-center justify-between border-b border-white/5 bg-[#0d1017]/40 px-6">
        <div className="flex gap-5 text-xs">
          {([
            { id: "containers", Icon: Container, label: `Containers${ready ? ` (${snapshot.containers.length})` : ""}` },
            { id: "images", Icon: ImageIcon, label: `Images${ready ? ` (${snapshot.images.length})` : ""}` },
            { id: "engine", Icon: Server, label: "Engine" },
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
          title="Refresh from Docker"
          className="rounded-lg p-2 text-zinc-500 hover:bg-white/5 hover:text-zinc-200 disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && <Banner tone="error" text={error} onClose={() => setError("")} />}
      {notice && <Banner tone="success" text={notice} onClose={() => setNotice("")} />}

      {loading && !snapshot ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin text-cyan-400" /> Reading the real Docker engine…
        </div>
      ) : !ready ? (
        <UnavailableState snapshot={snapshot} onRefresh={() => void refresh()} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "containers" && (
            <ContainersView
              containers={snapshot.containers}
              busy={busy}
              logsLoading={logsLoading}
              onStart={start}
              onStop={stop}
              onRestart={restart}
              onRemove={remove}
              onLogs={(container) => void openLogs(container)}
            />
          )}
          {tab === "images" && <ImagesView snapshot={snapshot} />}
          {tab === "engine" && <EngineView snapshot={snapshot} running={running} />}
        </div>
      )}

      {logs && <LogsDrawer logs={logs} onClose={() => setLogs(null)} onRefresh={() => {
        const container = snapshot?.containers.find((candidate) => candidate.id === logs.containerId);
        if (container) void openLogs(container);
      }} />}
    </div>
  );
}

function ContainersView({
  containers,
  busy,
  logsLoading,
  onStart,
  onStop,
  onRestart,
  onRemove,
  onLogs,
}: {
  containers: DockerContainer[];
  busy: string;
  logsLoading: string;
  onStart: (container: DockerContainer) => void;
  onStop: (container: DockerContainer) => void;
  onRestart: (container: DockerContainer) => void;
  onRemove: (container: DockerContainer) => void;
  onLogs: (container: DockerContainer) => void;
}) {
  if (containers.length === 0) {
    return (
      <div className="flex min-h-[420px] items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-cyan-500/10 ring-1 ring-cyan-500/20">
            <Container className="h-6 w-6 text-cyan-300" />
          </div>
          <h3 className="mt-4 text-lg font-semibold text-white">No containers</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">
            Docker returned an empty container list. DevLab does not seed examples or claim that a workload is running.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-3 p-6">
      {containers.map((container) => {
        return (
          <section key={container.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-4 ring-soft">
            <div className="flex flex-wrap items-center gap-4">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${container.running ? "animate-pulse bg-emerald-400 shadow shadow-emerald-400/50" : "bg-zinc-600"}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-100">{container.name || "Unnamed container"}</span>
                  <span className="font-mono text-[10.5px] text-zinc-600">{container.shortId}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[9.5px] font-semibold uppercase ${container.running ? "bg-emerald-500/15 text-emerald-300" : "bg-white/5 text-zinc-500"}`}>
                    {container.state || "unknown"}
                  </span>
                </div>
                <div className="mt-1 truncate text-[11.5px] text-zinc-500">{container.image}</div>
                <div className="mt-0.5 truncate text-[10.5px] text-zinc-600">{container.status}{container.ports ? ` · ${container.ports}` : ""}</div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <ActionButton
                  title="View the latest 500 log lines"
                  label="Logs"
                  Icon={FileText}
                  loading={logsLoading === container.id}
                  disabled={!!busy || !!logsLoading}
                  onClick={() => onLogs(container)}
                />
                {container.running ? (
                  <>
                    <ActionButton title="Restart container" label="Restart" Icon={RotateCw} loading={busy === `restart-${container.id}`} disabled={!!busy} onClick={() => onRestart(container)} />
                    <ActionButton title="Stop container" label="Stop" Icon={Square} loading={busy === `stop-${container.id}`} disabled={!!busy} danger onClick={() => onStop(container)} />
                  </>
                ) : (
                  <>
                    <ActionButton title="Start container" label="Start" Icon={Play} loading={busy === `start-${container.id}`} disabled={!!busy} positive onClick={() => onStart(container)} />
                    <ActionButton title="Remove stopped container" label="Remove" Icon={Trash2} loading={busy === `remove-${container.id}`} disabled={!!busy} danger onClick={() => onRemove(container)} />
                  </>
                )}
              </div>
            </div>

            {container.stats && (
              <div className="mt-4 grid gap-2 border-t border-white/5 pt-3 sm:grid-cols-3 lg:grid-cols-6">
                <Metric Icon={Gauge} label="CPU" value={container.stats.cpuPercent || "—"} />
                <Metric Icon={HardDrive} label="Memory" value={container.stats.memoryUsage || "—"} />
                <Metric Icon={Gauge} label="Memory %" value={container.stats.memoryPercent || "—"} />
                <Metric Icon={Network} label="Network I/O" value={container.stats.networkIo || "—"} />
                <Metric Icon={HardDrive} label="Block I/O" value={container.stats.blockIo || "—"} />
                <Metric Icon={Box} label="PIDs" value={container.stats.pids || "—"} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ImagesView({ snapshot }: { snapshot: DockerSnapshot }) {
  return (
    <div className="mx-auto max-w-6xl p-6">
      <section className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] ring-soft">
        <div className="border-b border-white/5 px-5 py-4">
          <h3 className="text-sm font-semibold text-white">Local images</h3>
          <p className="mt-0.5 text-[11px] text-zinc-600">Read directly from Docker Engine · image mutation is not exposed in this step</p>
        </div>
        {snapshot.images.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-600">Docker returned no local images.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-[#12161f]/90 text-[10px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Repository</th>
                  <th className="px-5 py-3 font-medium">Tag</th>
                  <th className="px-5 py-3 font-medium">Image ID</th>
                  <th className="px-5 py-3 font-medium">Size</th>
                  <th className="px-5 py-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {snapshot.images.map((image, index) => (
                  <tr key={`${image.id}-${image.repository}-${image.tag}-${index}`} className="text-zinc-300 hover:bg-white/[0.03]">
                    <td className="max-w-xs truncate px-5 py-3 font-medium text-zinc-200">{image.repository || "<none>"}</td>
                    <td className="px-5 py-3 text-cyan-300">{image.tag || "<none>"}</td>
                    <td className="px-5 py-3 font-mono text-[10.5px] text-zinc-500" title={image.id}>{image.shortId}</td>
                    <td className="px-5 py-3">{image.size || "—"}</td>
                    <td className="px-5 py-3 text-zinc-500">{image.createdSince || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function EngineView({ snapshot, running }: { snapshot: DockerSnapshot; running: number }) {
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <section className="rounded-xl border border-white/10 bg-white/[0.02] p-5 ring-soft">
        <h3 className="text-sm font-semibold text-white">Native Docker connection</h3>
        <dl className="mt-4 space-y-3 text-[12px]">
          <Definition label="CLI" value={snapshot.cliVersion ?? "Not found"} mono />
          <Definition label="Engine" value={snapshot.daemonVersion ?? "Unavailable"} mono />
          <Definition label="Containers" value={`${snapshot.containers.length} total · ${running} running · ${snapshot.containers.length - running} stopped`} />
          <Definition label="Images" value={`${snapshot.images.length} local image records`} />
          <Definition label="Refresh" value="Manual and every 15 seconds while this panel is open" />
        </dl>
      </section>

      <section className="flex gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-5 text-[12.5px] leading-relaxed text-amber-100/80">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
        <div>
          <strong className="text-amber-200">Docker access is privileged.</strong> Anyone who can control a Docker daemon can usually obtain the same authority as the account or service running that daemon. DevLab uses fixed CLI commands, validates full container IDs, bounds output, and requires confirmation for stop, restart, and removal. It does not claim to sandbox Docker workloads.
        </div>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/[0.02] p-5 text-[12px] leading-relaxed text-zinc-500 ring-soft">
        This step intentionally exposes no arbitrary Docker arguments, shell execution, image deletion, volume deletion, builds, pulls, or Compose deployment. Use the real terminal for operations not yet represented by a typed command.
      </section>
    </div>
  );
}

function UnavailableState({ snapshot, onRefresh }: { snapshot: DockerSnapshot | null; onRefresh: () => void }) {
  const installed = snapshot?.cliInstalled;
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-lg rounded-2xl border border-amber-500/20 bg-amber-500/[0.05] p-7 text-center ring-soft">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/10 ring-1 ring-amber-500/20">
          <AlertCircle className="h-6 w-6 text-amber-300" />
        </div>
        <h3 className="mt-4 text-lg font-semibold text-white">{installed ? "Docker Engine unavailable" : "Docker is not installed"}</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-zinc-400">
          {snapshot?.state.message ?? "DevLab could not inspect Docker on this machine."}
        </p>
        {snapshot?.cliVersion && <p className="mt-3 font-mono text-[10.5px] text-zinc-600">{snapshot.cliVersion}</p>}
        <div className="mt-4 rounded-lg bg-black/20 p-3 text-left text-[11.5px] leading-relaxed text-zinc-500">
          {installed
            ? "Start Docker Desktop or the Docker daemon, then ensure your user can access the selected Docker context. DevLab reports permission errors instead of showing sample containers."
            : "Install Docker Engine or Docker Desktop and make the docker command available on PATH, then restart DevLab."}
        </div>
        <button onClick={onRefresh} className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-400">
          <RefreshCw className="h-3.5 w-3.5" /> Retry detection
        </button>
      </div>
    </div>
  );
}

function LogsDrawer({ logs, onClose, onRefresh }: { logs: DockerLogs; onClose: () => void; onRefresh: () => void }) {
  return (
    <div className="absolute inset-x-6 bottom-8 z-20 flex max-h-[55%] flex-col overflow-hidden rounded-xl border border-cyan-500/25 bg-[#090c11] shadow-2xl ring-soft">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-white"><FileText className="h-4 w-4 text-cyan-300" /> Container logs</div>
          <div className="truncate font-mono text-[10.5px] text-zinc-600">{logs.containerName} · {logs.containerId.slice(0, 12)} · latest 500 lines</div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onRefresh} title="Refresh logs" className="rounded p-2 text-zinc-500 hover:bg-white/5 hover:text-white"><RefreshCw className="h-3.5 w-3.5" /></button>
          <button onClick={onClose} title="Close logs" className="rounded p-2 text-zinc-500 hover:bg-white/5 hover:text-white"><X className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-relaxed text-zinc-300">
        {logs.content || "The container returned no log output."}
      </pre>
    </div>
  );
}

function ActionButton({
  title,
  label,
  Icon,
  loading,
  disabled,
  danger = false,
  positive = false,
  onClick,
}: {
  title: string;
  label: string;
  Icon: typeof Play;
  loading: boolean;
  disabled: boolean;
  danger?: boolean;
  positive?: boolean;
  onClick: () => void;
}) {
  const colors = danger
    ? "border-rose-500/20 text-rose-300 hover:bg-rose-500/10"
    : positive
      ? "border-emerald-500/20 text-emerald-300 hover:bg-emerald-500/10"
      : "border-white/10 text-zinc-400 hover:bg-white/5 hover:text-white";
  return (
    <button onClick={onClick} disabled={disabled} title={title} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] transition disabled:cursor-not-allowed disabled:opacity-40 ${colors}`}>
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />} {label}
    </button>
  );
}

function Metric({ Icon, label, value }: { Icon: typeof Gauge; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-black/20 px-3 py-2">
      <div className="flex items-center gap-1 text-[9.5px] uppercase tracking-wider text-zinc-600"><Icon className="h-2.5 w-2.5" /> {label}</div>
      <div className="mt-0.5 truncate font-mono text-[10.5px] text-zinc-300" title={value}>{value}</div>
    </div>
  );
}

function Definition({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[100px_1fr] gap-3">
      <dt className="text-zinc-600">{label}</dt>
      <dd className={`min-w-0 break-words text-zinc-300 ${mono ? "font-mono text-[11px]" : ""}`}>{value}</dd>
    </div>
  );
}

function Banner({ tone, text, onClose }: { tone: "error" | "success"; text: string; onClose: () => void }) {
  return (
    <div className={`flex items-start gap-2 border-b px-6 py-2.5 text-[11.5px] ${tone === "error" ? "border-rose-500/20 bg-rose-500/[0.07] text-rose-200" : "border-emerald-500/20 bg-emerald-500/[0.07] text-emerald-200"}`}>
      {tone === "error" ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 break-words">{text}</span>
      <button onClick={onClose} className="text-current opacity-60 hover:opacity-100">Dismiss</button>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The native Docker operation failed.";
}
