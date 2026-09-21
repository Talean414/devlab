import { useMemo, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { Send, Loader2, FileJson, List, ShieldCheck, Clock3 } from "lucide-react";
import {
  parseHeaderLines,
  runHttpRequest,
  type HttpHeader,
  type HttpResponse,
} from "../lib/http";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

type ViewResponse = HttpResponse | {
  status: 0;
  statusText: "ERR";
  headers: HttpHeader[];
  body: string;
  bodyKind: "text";
  bodyTruncated: false;
  bytesReceived: 0;
  requestBodyBytes: number;
  elapsedMs: number;
  url: string;
};

const methodColor: Record<Method, string> = {
  GET: "text-emerald-400",
  POST: "text-amber-400",
  PUT: "text-blue-400",
  DELETE: "text-rose-400",
  PATCH: "text-violet-400",
  HEAD: "text-cyan-400",
  OPTIONS: "text-zinc-300",
};

const METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const BODY_METHODS = new Set<Method>(["POST", "PUT", "PATCH", "DELETE"]);

function formatError(error: unknown) {
  if (error && typeof error === "object") {
    const maybe = error as { code?: unknown; message?: unknown };
    if (typeof maybe.message === "string" && typeof maybe.code === "string") {
      return `${maybe.message}\n\n[${maybe.code}]`;
    }
    if (typeof maybe.message === "string") return maybe.message;
  }
  return String(error);
}

function prettyBody(response: HttpResponse): string {
  if (response.bodyKind !== "text") return response.body;
  const contentType = response.headers.find((header) => header.name.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
  if (!contentType.includes("json") || response.bodyTruncated) return response.body;
  try {
    return JSON.stringify(JSON.parse(response.body), null, 2);
  } catch {
    return response.body;
  }
}

export function ApiPanel() {
  const [method, setMethod] = useState<Method>("GET");
  const [url, setUrl] = useState("https://api.github.com/repos/eclipse-theia/theia");
  const [headers, setHeaders] = useState("Accept: application/json\nUser-Agent: DevLab-Native-HTTP");
  const [body, setBody] = useState('{\n  "key": "value"\n}');
  const [timeoutSecs, setTimeoutSecs] = useState(15);
  const [tab, setTab] = useState<"body" | "headers">("headers");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ViewResponse | null>(null);

  const sendsBody = BODY_METHODS.has(method);
  const responseHeaders = useMemo(() => (
    response?.headers.map((header) => `${header.name}: ${header.value}`).join("\n") ?? ""
  ), [response]);

  async function send() {
    setLoading(true);
    setResponse(null);
    const started = performance.now();
    const requestBody = sendsBody ? body : "";
    try {
      const parsedHeaders = parseHeaderLines(headers);
      const result = await runHttpRequest({
        method,
        url,
        headers: parsedHeaders,
        body: requestBody,
        timeoutSecs,
      });
      setResponse({ ...result, body: prettyBody(result) });
    } catch (error) {
      setResponse({
        status: 0,
        statusText: "ERR",
        headers: [],
        body: `Request failed: ${formatError(error)}\n\nThe browser fetch simulation is retired. This panel uses the bounded native Rust HTTP client only.`,
        bodyKind: "text",
        bodyTruncated: false,
        bytesReceived: 0,
        requestBodyBytes: new TextEncoder().encode(requestBody).length,
        elapsedMs: Math.round(performance.now() - started),
        url,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="API Client" subtitle="Native HTTP/1.1 requests — no browser CORS path, bounded output" />

      <div className="space-y-3 p-5">
        <div className="rounded-xl border border-cyan-500/15 bg-cyan-500/[0.04] p-3 text-[11.5px] leading-relaxed text-cyan-100/80">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
            <div>
              Rust opens the socket directly with verified HTTPS, fixed request framing, a 2 MiB request-body cap, 5 MiB response-body cap and 64 KiB header cap. Redirects are not followed automatically; inspect the returned <span className="font-mono">Location</span> header before sending another request.
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          <select
            value={method}
            onChange={(event) => setMethod(event.target.value as Method)}
            className={`rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2 text-sm font-bold outline-none focus:border-cyan-500/50 ${methodColor[method]}`}
          >
            {METHODS.map((value) => (
              <option key={value} value={value} className="text-zinc-900">{value}</option>
            ))}
          </select>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            className="flex-1 rounded-lg border border-white/10 bg-[#0d1017] px-4 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-cyan-500/50"
            placeholder="https://api.example.com/resource"
          />
          <label className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2 text-[11.5px] text-zinc-400">
            <Clock3 className="h-3.5 w-3.5 text-zinc-500" />
            <input
              type="number"
              min={10}
              max={30}
              value={timeoutSecs}
              onChange={(event) => setTimeoutSecs(Number(event.target.value))}
              className="w-12 bg-transparent text-right font-mono text-zinc-200 outline-none"
            />
            s
          </label>
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
          ] as const).map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 py-2 font-medium capitalize ${
                tab === item.id ? "border-cyan-400 text-white" : "border-transparent text-zinc-500"
              }`}
            >
              <item.Icon className="h-3.5 w-3.5" />
              {item.label}
            </button>
          ))}
        </div>
        {tab === "body" ? (
          <div className="space-y-2">
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={5}
              disabled={!sendsBody}
              className="w-full resize-none rounded-lg border border-white/10 bg-[#0d1017] p-4 font-mono text-[12.5px] leading-relaxed text-emerald-200 outline-none focus:border-cyan-500/50 disabled:text-zinc-600 disabled:opacity-60"
            />
            {!sendsBody && (
              <p className="text-[11px] text-zinc-600">{method} requests are sent without a body in this checkpoint.</p>
            )}
          </div>
        ) : (
          <textarea
            value={headers}
            onChange={(event) => setHeaders(event.target.value)}
            rows={5}
            className="w-full resize-none rounded-lg border border-white/10 bg-[#0d1017] p-4 font-mono text-[12.5px] leading-relaxed text-zinc-300 outline-none focus:border-cyan-500/50"
          />
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
                        : response.status >= 300 && response.status < 400
                          ? "text-cyan-400"
                          : "text-amber-400"
                  }
                >
                  ● {response.status || "ERR"} {response.statusText}
                </span>
                <span className="text-zinc-500">{response.elapsedMs} ms</span>
                <span className="text-zinc-600">{response.bytesReceived.toLocaleString()} B received</span>
                {response.bodyTruncated && <span className="text-amber-300">truncated</span>}
              </>
            )}
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_18rem]">
            <pre className="overflow-auto p-4 font-mono text-[12.5px] leading-relaxed text-zinc-300">
              {loading ? "Waiting for native HTTP response…" : response ? response.body : "Send a request to see the response here."}
            </pre>
            <aside className="overflow-auto border-l border-white/5 bg-black/10 p-4 font-mono text-[11px] leading-relaxed text-zinc-500">
              {response ? (
                <>
                  <div className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Headers</div>
                  <pre className="whitespace-pre-wrap">{responseHeaders || "(none)"}</pre>
                  <div className="mt-4 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Request</div>
                  <div className="mt-1 break-all text-zinc-600">{response.url}</div>
                  <div className="mt-1 text-zinc-600">body sent: {response.requestBodyBytes.toLocaleString()} B</div>
                </>
              ) : (
                "Response headers will appear here."
              )}
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
