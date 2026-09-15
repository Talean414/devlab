// Zero-server live collaboration: BroadcastChannel (same-browser tabs) +
// WebRTC datachannels (cross-machine, manual copy-paste signaling — no server).

import type { VFile } from "../types";

export interface ChatEv { from: string; text: string; ts: number }
type Listener = (files: VFile[], source: string) => void;
type ChatListener = (msg: ChatEv, source: string) => void;

const BC_NAME = "devlab-live-files";
const bc: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(BC_NAME) : null;

let lastFiles: VFile[] = [];
const fileListeners = new Set<Listener>();
const chatListeners = new Set<ChatListener>();
let datachannels: RTCDataChannel[] = [];
let applyingRemote = false;

export function getLastFiles() {
  return lastFiles;
}

export function subscribeFiles(fn: Listener) {
  fileListeners.add(fn);
  return () => { fileListeners.delete(fn); };
}
export function subscribeChat(fn: ChatListener) {
  chatListeners.add(fn);
  return () => { chatListeners.delete(fn); };
}

export function publishFiles(files: VFile[], source = "local") {
  if (applyingRemote) return;
  lastFiles = files;
  bc?.postMessage({ type: "files", files, source });
  for (const dc of datachannels) {
    if (dc.readyState === "open") {
      try { dc.send(JSON.stringify({ type: "files", files })); } catch { /* full */ }
    }
  }
  fileListeners.forEach((fn) => fn(files, source));
}

export function publishChat(msg: ChatEv) {
  bc?.postMessage({ type: "chat", msg });
  for (const dc of datachannels) {
    if (dc.readyState === "open") {
      try { dc.send(JSON.stringify({ type: "chat", msg })); } catch { /* ignore */ }
    }
  }
}

function receive(fc: VFile[], source: string) {
  applyingRemote = true;
  lastFiles = fc;
  fileListeners.forEach((fn) => fn(fc, source));
  setTimeout(() => (applyingRemote = false), 50);
}

bc?.addEventListener("message", (e) => {
  if (e.data?.type === "files") receive(e.data.files, "tab");
  if (e.data?.type === "chat") chatListeners.forEach((fn) => fn(e.data.msg, "tab"));
});

// ── WebRTC manual signaling ──
export interface PeerState {
  pc: RTCPeerConnection | null;
  label: string;
  connected: boolean;
}

const peers: PeerState[] = [];
const peerListeners = new Set<() => void>();

export function onPeers(fn: () => void) {
  peerListeners.add(fn);
  return () => { peerListeners.delete(fn); };
}
export function getPeers() { return peers; }
function notifyPeers() { peerListeners.forEach((f) => f()); }

function waitForIce(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(resolve, 5000); // safety
  });
}

function attachChannel(dc: RTCDataChannel, label: string) {
  datachannels.push(dc);
  dc.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === "files") receive(d.files, label);
      if (d.type === "chat") chatListeners.forEach((fn) => fn(d.msg, label));
    } catch { /* ignore */ }
  };
  dc.onopen = () => {
    peers.forEach((p) => (p.connected = true));
    notifyPeers();
    // push current workspace to the new peer
    if (lastFiles.length) {
      dc.send(JSON.stringify({ type: "files", files: lastFiles }));
    }
  };
  dc.onclose = () => {
    datachannels = datachannels.filter((c) => c !== dc);
    notifyPeers();
  };
}

function makePc(label: string): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  pc.ondatachannel = (e) => attachChannel(e.channel, label);
  peers.push({ pc, label, connected: false });
  notifyPeers();
  return pc;
}

export async function createInvite(): Promise<string> {
  const pc = makePc("remote-guest");
  const dc = pc.createDataChannel("devlab");
  attachChannel(dc, "host");
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIce(pc);
  return btoa(JSON.stringify(pc.localDescription));
}

export async function acceptInvite(encoded: string): Promise<string> {
  const pc = makePc("remote-host");
  const offer = JSON.parse(atob(encoded.trim()));
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIce(pc);
  return btoa(JSON.stringify(pc.localDescription));
}

export async function finishHandshake(encoded: string): Promise<void> {
  const pc = peers.find((p) => p.pc && p.label === "remote-guest")?.pc;
  if (!pc) throw new Error("No pending connection — create an invite first.");
  await pc.setRemoteDescription(JSON.parse(atob(encoded.trim())));
}

export function closePeers() {
  datachannels.forEach((dc) => dc.close());
  datachannels = [];
  peers.forEach((p) => p.pc?.close());
  peers.length = 0;
  notifyPeers();
}
