import { useState } from "react";
import { ciTemplates } from "../data/catalog";
import { PanelHeader } from "./AgentPanel";
import { CodeBlock } from "../components/CodeBlock";
import type { OpenGeneratedDrafts, VFile } from "../types";
import { FileCode2, Rocket, Unplug, FileDiff } from "lucide-react";

const RUN_STATUS_RECIPE = `# Run status stays with your CI provider. From the integrated terminal:
gh run list --limit 10        # recent GitHub Actions runs for this repository
gh run watch                  # follow the run that is currently in progress
gh run view --log-failed      # logs of the failed steps of the latest run`;

export function CicdPanel({ onOpenFiles }: { onOpenFiles?: OpenGeneratedDrafts }) {
  const [selected, setSelected] = useState(ciTemplates[0]);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [staging, setStaging] = useState(false);

  async function stageTemplate() {
    if (!onOpenFiles || staging) return;
    setStaging(true);
    setNotice(null);
    try {
      const files: VFile[] = [{ path: selected.filename, content: selected.yaml.endsWith("\n") ? selected.yaml : `${selected.yaml}\n`, language: "yaml" }];
      const opened = await onOpenFiles(files, `CI workflow template: ${selected.name}`);
      setNotice(opened
        ? { kind: "ok", text: `Staged ${selected.filename} for Editor review. Nothing is written until you apply it there; committing and pushing it stays with you.` }
        : { kind: "error", text: "The workflow template was not staged for editor review. Nothing was written." });
    } finally {
      setStaging(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="CI / CD Pipelines" subtitle="Workflow templates — authoring only; DevLab does not read or run CI" />

      <div className="flex min-h-0 flex-1">
        <div className="flex-1 overflow-y-auto border-r border-white/5 p-6">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
            <Rocket className="h-4 w-4 text-cyan-400" />
            Workflow runs
          </h3>
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-4 ring-soft">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-amber-100">
              <Unplug className="h-4 w-4 text-amber-300" /> Not connected
            </div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-amber-100/75">
              DevLab does not read GitHub Actions, GitLab CI or any other provider's run status in this checkpoint, and it
              never shows sample runs in place of real ones. Reading CI status is planned together with the bounded,
              audited GitHub operations in the enterprise agent roadmap. Until then, check runs in your provider's
              dashboard or from the integrated terminal:
            </p>
            <div className="mt-3">
              <CodeBlock code={RUN_STATUS_RECIPE} lang="bash" />
            </div>
          </div>

          <h3 className="mb-3 mt-8 flex items-center gap-2 text-sm font-semibold text-white">
            <FileCode2 className="h-4 w-4 text-cyan-400" />
            Workflow templates
          </h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {ciTemplates.map((t) => (
              <button
                key={t.id}
                onClick={() => { setSelected(t); setNotice(null); }}
                className={`rounded-xl border p-4 text-left transition ring-soft ${
                  selected.id === t.id
                    ? "border-cyan-500/40 bg-cyan-500/5"
                    : "border-white/10 hover:bg-white/[0.04]"
                }`}
              >
                <div className="text-sm font-semibold text-zinc-100">{t.name}</div>
                <div className="mt-0.5 text-[12px] text-zinc-500">{t.description}</div>
              </button>
            ))}
          </div>
          <p className="mt-3 text-[11.5px] leading-relaxed text-zinc-500">
            Templates are static starting points from DevLab's catalog. Review the steps, pinned action versions and
            secrets they expect before committing one; DevLab does not push to <span className="font-mono">.github/workflows/</span>.
          </p>
        </div>

        <div className="flex w-[48%] shrink-0 flex-col overflow-y-auto p-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-white">{selected.name}</h3>
              <p className="truncate font-mono text-[11px] text-zinc-500">{selected.filename}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="rounded-md bg-white/5 px-2 py-1 text-[11px] text-zinc-400">
                {selected.provider}
              </span>
              {onOpenFiles && (
                <button
                  onClick={() => { void stageTemplate(); }}
                  disabled={staging}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/25 px-3 py-1.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-400/10 disabled:opacity-50"
                >
                  <FileDiff className="h-3.5 w-3.5" /> Stage for review
                </button>
              )}
            </div>
          </div>
          <CodeBlock code={selected.yaml} lang="yaml" />
          {notice && (
            <div className={`mt-3 rounded-lg border px-3 py-2 text-[12px] ${notice.kind === "ok" ? "border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-200" : "border-amber-500/25 bg-amber-500/[0.06] text-amber-200"}`}>
              {notice.text}
            </div>
          )}
          <p className="mt-3 text-[11.5px] leading-relaxed text-zinc-500">
            Staging goes through the same reviewed-draft gate as Project Builder: the path policy runs first, Rust validates
            the draft metadata, and the file is written only when you click Apply in the Editor.
          </p>
        </div>
      </div>
    </div>
  );
}
