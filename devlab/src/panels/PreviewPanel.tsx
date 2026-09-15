import { useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { ArrowLeft, ArrowRight, RotateCw, Globe } from "lucide-react";

export function PreviewPanel() {
  const [url, setUrl] = useState("https://theia-ide.org");
  const [current, setCurrent] = useState(url);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Live Preview" subtitle="Embedded browser webview — no more dozens of external tabs" />

      <div className="flex items-center gap-2 border-b border-white/5 bg-[#0d1017]/40 px-4 py-2.5">
        <div className="flex items-center gap-1 text-zinc-500">
          <button className="rounded p-1.5 hover:bg-white/5 hover:text-zinc-300" title="Back">
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button className="rounded p-1.5 hover:bg-white/5 hover:text-zinc-300" title="Forward">
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setCurrent(url + "?r=" + Date.now())}
            className="rounded p-1.5 hover:bg-white/5 hover:text-zinc-300"
            title="Reload"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="relative flex-1">
          <Globe className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setCurrent(url)}
            className="w-full rounded-full border border-white/10 bg-[#0b0e14] py-1.5 pl-9 pr-4 text-xs text-zinc-200 outline-none focus:border-cyan-500/50"
          />
        </div>
        <button
          onClick={() => setCurrent(url)}
          className="rounded-md bg-white/5 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/10"
        >
          Go
        </button>
      </div>
      <div className="flex-1 bg-white">
        <iframe
          key={current}
          src={current}
          title="preview"
          className="h-full w-full"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      </div>
      <div className="border-t border-white/5 bg-[#0a0c11] px-4 py-2 text-[11.5px] text-zinc-500">
        Point this at <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-zinc-300">http://localhost:3000</span> to preview your running dev server.
        Some sites block embedding via <code className="font-mono">X-Frame-Options</code>.
      </div>
    </div>
  );
}
