// Shared bits for the phone and viewer pages.

/** WebSocket to the signalling server that reconnects on its own. */
export function connectSignal(role, onMessage, onStatus) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws = null;
  let stopped = false;

  function open() {
    ws = new WebSocket(`${proto}://${location.host}/ws?role=${role}`);
    ws.onopen = () => onStatus('open');
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'replaced') { stopped = true; onStatus('replaced'); }
      onMessage(m);
    };
    ws.onclose = () => {
      onStatus(stopped ? 'replaced' : 'closed');
      if (!stopped) setTimeout(open, 1500);
    };
  }
  open();

  return {
    send(m) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    },
  };
}

/** ICE candidates can arrive before the remote description; hold them until then. */
export class CandidateQueue {
  constructor() { this.items = []; }
  async add(pc, cand) {
    if (pc && pc.remoteDescription) {
      try { await pc.addIceCandidate(cand); } catch (e) { console.warn('addIceCandidate', e); }
    } else {
      this.items.push(cand);
    }
  }
  async flush(pc) {
    const items = this.items.splice(0);
    for (const c of items) {
      try { await pc.addIceCandidate(c); } catch (e) { console.warn('addIceCandidate', e); }
    }
  }
  clear() { this.items = []; }
}

// LAN only, so no STUN/TURN: host candidates are enough and it works offline.
export const RTC_CONFIG = { iceServers: [] };

export const RESOLUTIONS = [
  { label: '480p', w: 854, h: 480 },
  { label: '720p', w: 1280, h: 720 },
  { label: '1080p', w: 1920, h: 1080 },
  { label: '1440p', w: 2560, h: 1440 },
  { label: '4K', w: 3840, h: 2160 },
];

export const FRAMERATES = [15, 24, 30, 60];

export const QUALITY_PRESETS = [
  { label: 'Low', kbps: 800 },
  { label: 'Medium', kbps: 2500 },
  { label: 'High', kbps: 6000 },
  { label: 'Very high', kbps: 12000 },
  { label: 'Max', kbps: 25000 },
];

/** Run async tasks one at a time so rapid setting changes don't trample each other. */
export function serialQueue() {
  let chain = Promise.resolve();
  return (fn) => (chain = chain.then(fn).catch((e) => console.error(e)));
}
