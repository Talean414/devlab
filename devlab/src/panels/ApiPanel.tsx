import { useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { Send, Loader2, FileJson, List } from "lucide-react";

type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

const methodColor: Record<Method, string> = {
  GET: "text-emerald-400",
  POST: "text-amber-400",
  PUT: "text-blue-400",
  DELETE: "text-rose-400",
  PATCH: "text-violet-400",
};

export function ApiPanel() {
  const [method, setMethod] = useState<Method>("GET");
  const [url, setUrl] = useState("https://api.github.com/repos/eclipse-theia/theia");
  const [body, setBody] = useState('{\n  "key": "value"\n}');
  const [tab, setTab] = useState<"body" | "headers">("headers");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<{ status: number; time: number; text: string } | null>(null);

  async function send() {
    setLoading(true);
    setResponse(null);
    const start = performance.now();
    try {
      const opts: RequestInit = { method };
      if (method !== "GET" && method !== "DELETE") {
        opts.headers = { "Content-Type": "application/json" };
        opts.body = body;
      }
      const res = await fetch(url, opts);
      const text = await res.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
      setResponse({ status: res.status, time: Math.round(performance.now() - start), text: pretty.slice(0, 6000) });
    } catch (e) {
      setResponse({
        status: 0,
        time: Math.round(performance.now() - start),
        text: `Request failed: ${(e as Error).message}\n\n(CORS may block cross-origin browser requests — the native DevLab REST Client bypasses this.)`,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="API Client" subtitle="Send real HTTP requests — replaces Postman / Insomnia" />

      <div className="space-y-3 p-5">
        <div className="flex gap-2">
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as Method)}
            className={`rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2 text-sm font-bold outline-none focus:border-cyan-500/50 ${methodColor[method]}`}
          >
            {(["GET", "POST", "PUT", "PATCH", "DELETE"] as Method[]).map((m) => (
              <option key={m} value={m} className="text-zinc-900">{m}</option>
            ))}
          </select>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="flex-1 rounded-lg border border-white/10 bg-[#0d1017] px-4 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-cyan-500/50"
          />
          <button
            onClick={send}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-cyan-900/20 transition hover:from-cyan-400 hover:to-blue-500 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {loading ? "Sending…" : "Send"}
          </button>
        </div>

        <div className="flex gap-5 border-b border-white/5 text-xs">
          {([
            { id: "headers", Icon: List,    label: "Headers" },
            { id: "body",    Icon: FileJson, label: "Body" },
          ] as const).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 py-2 font-medium capitalize ${
                tab === t.id ? "border-cyan-400 text-white" : "border-transparent text-zinc-500"
              }`}
            >
              <t.Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          ))}
        </div>
        {tab === "body" ? (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            className="w-full resize-none rounded-lg border border-white/10 bg-[#0d1017] p-4 font-mono text-[12.5px] leading-relaxed text-emerald-200 outline-none focus:border-cyan-500/50"
          />
        ) : (
          <div className="rounded-lg border border-white/10 bg-[#0d1017] p-4 font-mono text-[12.5px] leading-relaxed text-zinc-400">
            Accept: application/json<br />
            User-Agent: DevLab-REST-Client
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-5 pb-5">
        <div className="flex h-full flex-col rounded-xl border border-white/10 bg-[#0a0c11] ring-soft">
          <div className="flex items-center gap-4 border-b border-white/5 px-4 py-2 text-xs">
            <span className="font-medium text-zinc-400">Response</span>
            {response && (
              <>
                <span
                  className={
                    response.status >= 200 && response.status < 300
                      ? "text-emerald-400"
                      : response.status === 0
                        ? "text-rose-400"
                        : "text-amber-400"
                  }
                >
                  ● {response.status || "ERR"}
                </span>
                <span className="text-zinc-500">{response.time} ms</span>
              </>
            )}
          </div>
          <pre className="flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed text-zinc-300">
            {loading ? "Waiting for response…" : response ? response.text : "Send a request to see the response here."}
          </pre>
        </div>
      </div>
    </div>
  );
}
