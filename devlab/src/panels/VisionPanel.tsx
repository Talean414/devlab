import { useCallback, useEffect, useRef, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { getApiKey, streamVision, streamChat, fileToBase64 } from "../lib/gemini";
import type { OpenGeneratedDrafts, VFile } from "../types";
import {
  ScanLine, Upload, Link2, Wand2, Loader2, ImageIcon, Trash2, Globe2,
} from "lucide-react";

export function VisionPanel({ onOpenFiles }: { onOpenFiles: OpenGeneratedDrafts }) {
  const [image, setImage] = useState<{ data: string; mime: string; preview: string } | null>(null);
  const [url, setUrl] = useState("https://vercel.com");
  const [mode, setMode] = useState<"image" | "url">("image");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const pushLog = (s: string) => setLog((l) => [...l, s]);

  const loadImage = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const data = await fileToBase64(file);
    setImage({ data, mime: file.type, preview: URL.createObjectURL(file) });
  }, []);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = Array.from(e.clipboardData?.files || [])[0];
      if (f) loadImage(f);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [loadImage]);

  async function reverseEngineer() {
    if (!getApiKey()) { pushLog("No Gemini key — add one in Settings."); return; }
    if (mode === "image" && !image) { pushLog("Drop or paste a screenshot first."); return; }
    setBusy(true); setLog([]);

    try {
      pushLog("Extracting design system…");
      const prompt = `You are DevLab's reverse-engineering engine. Analyze the UI in this ${mode === "image" ? "screenshot" : "target page"} and respond with ONLY valid JSON (no fences):

{
  "summary": "one-paragraph description of the app and its layout",
  "palette": ["#hex", "..."],
  "typography": "fonts and scale observed",
  "components": ["list", "of", "ui", "components"],
  "files": [
    { "path": "src/App.tsx", "description": "main layout", "language": "typescript" },
    { "path": "src/index.css", "description": "tokens + base", "language": "css" },
    { "path": "src/components/Nav.tsx", "description": "navigation", "language": "typescript" }
  ]
}
Rules: 3 to 6 files forming a working React + TypeScript + Tailwind clone. Reproduce REAL structure from the image — do not hallucinate generic placeholders.`;

      let acc = "";
      if (mode === "image" && image) {
        for await (const ch of streamVision(prompt + (brief ? `\n\nExtra context: ${brief}` : ""), [{ data: image.data, mime: image.mime }])) acc += ch;
      } else {
        let htmlSnippet = "";
        try {
          pushLog(`Fetching ${url} via CORS proxy…`);
          const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`);
          const text = await res.text();
          htmlSnippet = text.slice(0, 16000);
          pushLog(`Captured ${text.length.toLocaleString()} chars of markup.`);
        } catch {
          pushLog("Direct fetch blocked — analyzing from URL + your description instead.");
        }
        for await (const ch of streamChat([{ role: "user", text: `${prompt}\n\nTARGET URL: ${url}\n\nHTML excerpt (may be empty/none):\n${htmlSnippet}\n\nUser description: ${brief}` }])) acc += ch;
      }

      const clean = acc.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      const plan = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)) as {
        summary: string; palette: string[]; typography: string; components: string[];
        files: { path: string; description: string; language: string }[];
      };

      pushLog(`Design system: ${plan.palette.slice(0, 5).join("  ")}`);
      pushLog(`Components: ${plan.components.join(", ")}`);
      pushLog(`Generating ${plan.files.length} files…`);

      const out: VFile[] = [
        { path: "DESIGN-NOTES.md", content: `# Reverse-engineered design\n\n${plan.summary}\n\n## Palette\n${plan.palette.map((p) => `- ${p}`).join("\n")}\n\n## Typography\n${plan.typography}\n\n## Components\n${plan.components.map((c) => `- ${c}`).join("\n")}`, language: "markdown" },
      ];

      for (const f of plan.files) {
        pushLog(`  drafting ${f.path}…`);
        const filePrompt = `${mode === "image" ? "Using the analyzed screenshot" : "Using the target page analysis"}, write the COMPLETE file \`${f.path}\`.\n\nDesign: ${plan.summary}\nPalette: ${plan.palette.join(", ")}\nTypography: ${plan.typography}\nComponents: ${plan.components.join(", ")}\nThis file's role: ${f.description}\n\nOutput ONLY raw file contents, no fences, no commentary. React + TypeScript + Tailwind, production-quality, under 150 lines.`;
        let content = "";
        for await (const ch of streamChat([{ role: "user", text: filePrompt }])) content += ch;
        out.push({
          path: f.path,
          content: content.replace(/^```[\w]*\n?/, "").replace(/```\s*$/, "").trim(),
          language: f.language || "typescript",
        });
      }

      pushLog(`✓ Clone ready — ${out.length} in-memory drafts. Nothing was written to disk.`);
      pushLog("OPENING_IN_EDITOR");
      const opened = await onOpenFiles(out, `Reverse-engineered app draft: ${plan.summary}`);
      if (!opened) pushLog("error: draft staging failed; nothing was opened or written.");
    } catch (e) {
      pushLog("error: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="URL / Screenshot → App"
        subtitle="Reverse-engineer any interface into a working React clone"
        badge="Experimental" badgeOk
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[46%] shrink-0 flex-col border-r border-white/5 p-5">
          <div className="mb-4 flex gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-1">
            {([["image", "Screenshot", ImageIcon], ["url", "URL", Globe2]] as const).map(([id, label, Icon]) => (
              <button key={id} onClick={() => setMode(id)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-2 text-[12px] font-medium transition ${
                  mode === id ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>

          {mode === "image" ? (
            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadImage(f); }}
              className="relative flex min-h-48 flex-1 cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-white/15 bg-[#0a0c11] transition hover:border-cyan-500/40"
            >
              {image ? (
                <>
                  <img src={image.preview} alt="screenshot" className="max-h-full w-full object-contain" />
                  <button onClick={(e) => { e.stopPropagation(); setImage(null); }}
                    className="absolute right-2 top-2 rounded-lg bg-black/70 p-1.5 text-zinc-300 hover:text-rose-400">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : (
                <div className="flex flex-col items-center gap-2.5 p-6 text-center text-zinc-600">
                  <Upload className="h-8 w-8" />
                  <p className="text-[13px]">Drop a screenshot, click to browse, or just <strong className="text-zinc-300">Ctrl+V paste</strong> from your clipboard.</p>
                </div>
              )}
              <input ref={inputRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => e.target.files?.[0] && loadImage(e.target.files[0])} />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="relative">
                <Link2 className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                <input value={url} onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://stripe.com/checkout"
                  className="w-full rounded-lg border border-white/10 bg-[#0d1017] py-2.5 pl-9 pr-3 text-sm text-zinc-100 outline-none focus:border-cyan-500/50" />
              </div>
              <p className="text-[11.5px] leading-relaxed text-zinc-500">
                DevLab fetches the page through a CORS proxy when possible and reconstructs the UI.
                For JS-heavy sites, add a description below for better results.
              </p>
            </div>
          )}

          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3}
            placeholder="Optional: extra context — e.g. 'this is a pricing page with 3 tiers and an FAQ'"
            className="mt-3 w-full resize-none rounded-lg border border-white/10 bg-[#0d1017] p-3 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-500/50" />

          <button onClick={reverseEngineer} disabled={busy || !getApiKey()}
            className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 py-2.5 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            {busy ? "Reverse-engineering…" : "Clone this app"}
          </button>
          {!getApiKey() && <p className="mt-2 text-center text-[11.5px] text-amber-300">Add your Gemini key in Settings first.</p>}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2.5 text-[12.5px] font-medium text-zinc-200">
            <ScanLine className="h-4 w-4 text-cyan-400" /> Analysis
          </div>
          <div className="flex-1 space-y-1.5 overflow-y-auto p-4 font-mono text-[11.5px] leading-relaxed">
            {log.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-zinc-600">
                <ScanLine className="h-10 w-10" />
                <p className="max-w-xs text-[13px]">
                  Point DevLab at a screenshot or URL. It extracts the palette, typography and
                  components, then generates a reviewable in-memory clone without writing to disk.
                </p>
              </div>
            ) : (
              log.map((l, i) => (
                <div key={i}
                  className={
                    l.startsWith("✓") ? "text-emerald-300"
                    : l.startsWith("error") ? "text-rose-400"
                    : l === "OPENING_IN_EDITOR" ? "text-cyan-300 underline"
                    : "text-zinc-400"
                  }>
                  {l === "OPENING_IN_EDITOR" ? "→ Opening generated-draft review…" : l}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
