import { useEffect, useRef, useState } from "react";
import { PanelHeader } from "./AgentPanel";
import {
  createInvite, acceptInvite, finishHandshake, closePeers,
  getPeers, onPeers, publishChat, subscribeChat, type ChatEv,
} from "../lib/sync";
import {
  Radio, Copy, Check, Users, Wifi, WifiOff, Send, MonitorSmartphone,
  Link2, Loader2, CircleHelp,
} from "lucide-react";

export function LiveSharePanel() {
  const [tab, setTab] = useState<"local" | "web">("local");
  const [invite, setInvite] = useState("");
  const [joinInput, setJoinInput] = useState("");
  const [answer, setAnswer] = useState("");
  const [hostInput, setHostInput] = useState("");
  const [busy, setBusy] = useState<"" | "creating" | "joining" | "finishing">("");
  const [err, setErr] = useState("");
  const [, force] = useState(0);
  const [chat, setChat] = useState<ChatEv[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [copied, setCopied] = useState<"invite" | "answer" | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const me = useRef(`dev-${Math.random().toString(36).slice(2, 6)}`);

  useEffect(() => { onPeers(() => force((x) => x + 1)); }, []);

  useEffect(() => { subscribeChat((msg) => setChat((c) => [...c.slice(-49), msg])); }, []);
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [chat]);

  const peers = getPeers();
  const connected = peers.filter((p) => p.connected).length;

  async function host() {
    setBusy("creating"); setErr("");
    try { setInvite(await createInvite()); }
    catch (e) { setErr((e as Error).message); }
    setBusy("");
  }
  async function join() {
    setBusy("joining"); setErr("");
    try { setAnswer(await acceptInvite(joinInput)); }
    catch (e) { setErr((e as Error).message); }
    setBusy("");
  }
  async function finish() {
    setBusy("finishing"); setErr("");
    try { await finishHandshake(hostInput); }
    catch (e) { setErr((e as Error).message); }
    setBusy("");
  }

  function sendChat() {
    const t = chatInput.trim();
    if (!t) return;
    const msg: ChatEv = { from: me.current, text: t, ts: Date.now() };
    publishChat(msg);
    setChat((c) => [...c.slice(-49), msg]);
    setChatInput("");
  }

  function copy(text: string, which: "invite" | "answer") {
    navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Live Share — zero server"
        subtitle="Same-browser tabs sync instantly via BroadcastChannel · WebRTC DataChannels for remote pairing"
        badge={connected ? `${connected} peer${connected > 1 ? "s" : ""} connected` : "Offline"}
        badgeOk={connected > 0}
      />

      <div className="flex gap-5 border-b border-white/5 bg-[#0d1017]/40 px-6 text-xs">
        {([["local", "This browser", MonitorSmartphone], ["web", "Remote peer", Radio]] as const).map(([id, label, Icon]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 py-3 font-medium ${
              tab === id ? "border-cyan-400 text-white" : "border-transparent text-zinc-500"
            }`}>
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex-1 overflow-y-auto p-6">
          {tab === "local" && (
            <div className="mx-auto max-w-xl space-y-5">
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-6 ring-soft">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/15 ring-1 ring-emerald-500/20">
                    <MonitorSmartphone className="h-5 w-5 text-emerald-300" />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-white">Automatic multi-tab sync</h3>
                    <p className="text-[12.5px] text-zinc-500">Already working — no setup needed.</p>
                  </div>
                </div>
                <p className="mt-4 text-[13px] leading-relaxed text-zinc-400">
                  Open DevLab in a second browser tab. Every keystroke in the Code Editor appears in
                  the other tab instantly — the source of truth is a live BroadcastChannel. Peer
                  chat below is shared too.
                </p>
                <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3.5 py-2.5 text-[12.5px] text-emerald-200">
                  <Wifi className="h-4 w-4" /> BroadcastChannel <code className="font-mono text-[11px]">devlab-live-files</code> is live for every tab of this browser.
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-6 ring-soft">
                <h3 className="mb-2 text-sm font-semibold text-white">Try it</h3>
                <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-zinc-400">
                  <li>Duplicate this tab (right-click the tab → Duplicate).</li>
                  <li>Open the Code Editor in one tab, this panel in the other.</li>
                  <li>Edit a file — watch it change in both. Send a chat message below.</li>
                </ol>
              </div>
            </div>
          )}

          {tab === "web" && (
            <div className="mx-auto max-w-xl space-y-5">
              <div className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-5 ring-soft">
                <CircleHelp className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" />
                <p className="text-[13px] leading-relaxed text-zinc-400">
                  DevLab uses <strong className="text-zinc-200">manual WebRTC signaling</strong> — copy
                  a short invite block to your teammate, they paste it and send back their answer. Once
                  connected, files and chat flow peer-to-peer with no server in between.
                </p>
              </div>

              {/* Host */}
              <section className="rounded-xl border border-white/10 bg-white/[0.02] p-5 ring-soft">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-cyan-500/15 text-[11px] font-bold text-cyan-300">A</span>
                  Host a session
                </h3>
                <button onClick={host} disabled={busy === "creating"}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40">
                  {busy === "creating" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                  Create invite
                </button>
                {invite && (
                  <div className="mt-3">
                    <label className="mb-1 block text-[11.5px] text-zinc-500">Send this to your teammate</label>
                    <div className="flex gap-2">
                      <textarea readOnly value={invite} rows={3}
                        className="flex-1 resize-none rounded-lg border border-white/10 bg-[#0b0e14] p-2.5 font-mono text-[10.5px] text-zinc-400 outline-none" />
                      <button onClick={() => copy(invite, "invite")}
                        className="self-start rounded-lg border border-white/10 p-2 text-zinc-300 hover:bg-white/5">
                        {copied === "invite" ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    <label className="mb-1 mt-3 block text-[11.5px] text-zinc-500">Paste their answer back here</label>
                    <div className="flex gap-2">
                      <textarea value={hostInput} onChange={(e) => setHostInput(e.target.value)} rows={3}
                        placeholder="Paste the answer block your teammate sends…"
                        className="flex-1 resize-none rounded-lg border border-white/10 bg-[#0b0e14] p-2.5 font-mono text-[10.5px] text-zinc-300 outline-none focus:border-cyan-500/50" />
                      <button onClick={finish} disabled={busy === "finishing" || !hostInput.trim()}
                        className="self-start rounded-lg bg-white/10 px-3 py-2 text-[12px] font-medium text-white hover:bg-white/15 disabled:opacity-40">
                        {busy === "finishing" ? "…" : "Connect"}
                      </button>
                    </div>
                  </div>
                )}
              </section>

              {/* Join */}
              <section className="rounded-xl border border-white/10 bg-white/[0.02] p-5 ring-soft">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/15 text-[11px] font-bold text-violet-300">B</span>
                  Join a session
                </h3>
                <label className="mb-1 block text-[11.5px] text-zinc-500">Paste the invite from the host</label>
                <textarea value={joinInput} onChange={(e) => setJoinInput(e.target.value)} rows={3}
                  placeholder="eyJ0eXBlIjoib2ZmZXIiLCJzZHAiOiIuLi4="
                  className="w-full resize-none rounded-lg border border-white/10 bg-[#0b0e14] p-2.5 font-mono text-[10.5px] text-zinc-300 outline-none focus:border-cyan-500/50" />
                <button onClick={join} disabled={busy === "joining" || !joinInput.trim()}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:from-violet-400 hover:to-fuchsia-500 disabled:opacity-40">
                  {busy === "joining" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radio className="h-3.5 w-3.5" />}
                  Generate my answer
                </button>
                {answer && (
                  <div className="mt-3">
                    <label className="mb-1 block text-[11.5px] text-zinc-500">Send this back to the host</label>
                    <div className="flex gap-2">
                      <textarea readOnly value={answer} rows={3}
                        className="flex-1 resize-none rounded-lg border border-white/10 bg-[#0b0e14] p-2.5 font-mono text-[10.5px] text-zinc-400 outline-none" />
                      <button onClick={() => copy(answer, "answer")}
                        className="self-start rounded-lg border border-white/10 p-2 text-zinc-300 hover:bg-white/5">
                        {copied === "answer" ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                )}
              </section>

              {err && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-[12.5px] text-rose-200">{err}</div>}

              {(peers.length > 0) && (
                <button onClick={() => { closePeers(); setInvite(""); setAnswer(""); setHostInput(""); setJoinInput(""); }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-[12.5px] text-rose-300 hover:bg-rose-500/20">
                  <WifiOff className="h-3.5 w-3.5" /> Disconnect all
                </button>
              )}
            </div>
          )}
        </div>

        {/* peers + chat sidebar */}
        <aside className="flex w-80 shrink-0 flex-col border-l border-white/5 bg-[#0d1017]/50">
          <div className="border-b border-white/5 px-4 py-3">
            <h4 className="flex items-center gap-2 text-[12.5px] font-semibold text-white">
              <Users className="h-4 w-4 text-cyan-400" /> Peers
            </h4>
          </div>
          <div className="border-b border-white/5 p-3">
            <PeerRow label={`${me.current} (you)`} on />
            {peers.map((p, i) => (
              <PeerRow key={i} label={p.label} on={p.connected} />
            ))}
            {peers.length === 0 && (
              <p className="px-1 py-2 text-[11.5px] text-zinc-600">No remote peers — other browser tabs still sync and chat.</p>
            )}
          </div>
          <div className="border-b border-white/5 px-4 py-2.5 text-[12px] font-semibold text-white">Session chat</div>
          <div ref={chatRef} className="flex-1 space-y-2.5 overflow-y-auto p-3">
            {chat.length === 0 && <p className="pt-8 text-center text-[11.5px] text-zinc-600">Messages sent here reach every tab and connected peer.</p>}
            {chat.map((m, i) => (
              <div key={i} className={`max-w-[85%] rounded-lg px-3 py-2 text-[12.5px] ${m.from === me.current ? "ml-auto bg-cyan-600 text-white" : "bg-white/[0.05] text-zinc-200"}`}>
                <div className="mb-0.5 text-[10px] opacity-60">{m.from === me.current ? "you" : m.from}</div>
                {m.text}
              </div>
            ))}
          </div>
          <div className="flex gap-2 border-t border-white/5 p-2.5">
            <input value={chatInput} onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendChat()}
              placeholder="Message the session…"
              className="flex-1 rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2 text-[12.5px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-500/50" />
            <button onClick={sendChat} className="rounded-lg bg-cyan-500 px-3 py-2 text-white hover:bg-cyan-400">
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function PeerRow({ label, on }: { label: string; on: boolean }) {
  return (
    <div className="mb-1 flex items-center gap-2.5 rounded-lg px-2 py-1.5">
      <span className={`h-2 w-2 shrink-0 rounded-full ${on ? "bg-emerald-400 shadow shadow-emerald-400/50" : "bg-zinc-600"}`} />
      <span className="truncate font-mono text-[12px] text-zinc-300">{label}</span>
      <span className="ml-auto text-[10.5px] text-zinc-600">{on ? "connected" : "pending"}</span>
    </div>
  );
}
