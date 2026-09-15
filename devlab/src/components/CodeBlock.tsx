import { useState } from "react";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-medium text-zinc-300 transition hover:bg-white/10 hover:text-white"
    >
      {copied ? "✓ Copied" : label}
    </button>
  );
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return (
    <div className="group relative overflow-hidden rounded-lg border border-white/10 bg-[#0b0e14]">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          {lang || "shell"}
        </span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed text-emerald-200">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// Very small markdown renderer: fenced code blocks + inline code + line breaks.
export function Markdown({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <div className="space-y-2 text-[13.5px] leading-relaxed text-zinc-200">
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          const firstNl = part.indexOf("\n");
          const lang = firstNl > -1 ? part.slice(0, firstNl).trim() : "";
          const code = firstNl > -1 ? part.slice(firstNl + 1) : part;
          return <CodeBlock key={i} code={code.replace(/\n$/, "")} lang={lang || undefined} />;
        }
        return (
          <div key={i} className="whitespace-pre-wrap break-words">
            {part.split(/(`[^`]+`)/g).map((seg, j) =>
              seg.startsWith("`") && seg.endsWith("`") ? (
                <code
                  key={j}
                  className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[12px] text-cyan-200"
                >
                  {seg.slice(1, -1)}
                </code>
              ) : (
                <span key={j}>{seg}</span>
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}
