import { useState } from "react";
import { setApiKey, pickBestModel } from "../lib/gemini";
import { KeyRound, Shield, ExternalLink } from "lucide-react";

export function KeyModal({
  onClose, onSaved,
}: { onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#12161f] p-7 shadow-2xl ring-soft">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/20 to-violet-600/20 ring-1 ring-white/10">
          <KeyRound className="h-5 w-5 text-cyan-200" />
        </div>
        <h2 className="text-lg font-semibold text-white">Bring Your Own Key</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-400">
          DevLab has no subscription fee. Its AI agents use your Google AI Studio key,
          subject to Google's free per-project quotas. The key stays in this browser.
        </p>

        <div className="mt-5 flex gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/[0.06] p-3 text-[12px] text-cyan-200/90">
          <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Your key is held in browser localStorage and never leaves your machine except in HTTPS calls to Google's API.</span>
        </div>

        <input
          autoFocus
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Paste your Gemini API key…"
          className="mt-4 w-full rounded-lg border border-white/10 bg-[#0d1017] px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-cyan-500/50"
        />

        <div className="mt-4 flex gap-2">
          <button
            onClick={async () => {
              if (!key.trim()) return;
              setApiKey(key);
              await pickBestModel();
              onSaved();
            }}
            disabled={!key.trim()}
            className="flex-1 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 py-2.5 text-sm font-semibold text-white hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40"
          >
            Save & Continue
          </button>
          <button
            onClick={onClose}
            className="rounded-lg border border-white/10 px-4 py-2.5 text-sm text-zinc-400 hover:bg-white/5"
          >
            Later
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          <a
            href="https://aistudio.google.com/app/apikey"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12px] text-cyan-400 hover:underline"
          >
            Get a free key
            <ExternalLink className="h-3 w-3" />
          </a>
          <a
            href="https://ai.dev/rate-limit"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12px] text-zinc-500 hover:text-cyan-400 hover:underline"
          >
            Check quota
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
}
