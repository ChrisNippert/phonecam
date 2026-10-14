// Phone side: owns the camera, sends video over WebRTC, applies settings from the viewer.
import { connectSignal, CandidateQueue, RTC_CONFIG, serialQueue } from './common.js';

const $ = (s) => document.querySelector(s);
const preview = $('#preview');

// Current settings. The viewer edits these; the phone is the source of truth.
const state = {
  deviceId: null,           // explicit camera (e.g. ultrawide); null = use facingMode
  facingMode: 'environment',
  width: 1280,
  height: 720,
  fps: 30,
  bitrate: 2500,            // kbps
  degradation: 'balanced',  // balanced | maintain-framerate | maintain-resolution
  codec: 'auto',            // auto | VP8 | VP9 | H264 | AV1
  audio: false,
  torch: false,
  zoom: null,
};

let videoTrack = null;
let audioTrack = null;
let pc = null;
let videoSender = null;
let callId = 0;
let started = false;
let viewerPresent = false;
let devices = [];
let lastError = null;
let wakeLock = null;
const candidates = new CandidateQueue();
const enqueue = serialQueue();

const sig = connectSignal('phone', (m) => enqueue(() => onSignal(m)), onWsStatus);

// ---------------------------------------------------------------- camera

function videoConstraints() {
  const v = {
    width: { ideal: state.width },
    height: { ideal: state.height },
    frameRate: { ideal: state.fps, max: state.fps },
  };
  if (state.deviceId) v.deviceId = { exact: state.deviceId };
  else v.facingMode = { ideal: state.facingMode };
  return v;
}

async function acquireVideo() {
  // Phones generally can't open two cameras at once, so release first.
  if (videoTrack) { videoTrack.stop(); videoTrack = null; }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
    // Constraint too strict or device gone: relax and retry.
    console.warn('getUserMedia retry without strict constraints', e);
    state.deviceId = null;
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: state.facingMode }, width: { ideal: state.width }, height: { ideal: state.height } },
    });
  }
  videoTrack = stream.getVideoTracks()[0];
  videoTrack.onended = () => showError('Camera stopped (another app may have taken it).');
  applyContentHint();
  await applyExtras();

  preview.srcObject = new MediaStream([videoTrack]);
  if (videoSender) await videoSender.replaceTrack(videoTrack);
  await refreshDevices();
}

async function acquireAudio() {
  if (state.audio && !audioTrack) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioTrack = s.getAudioTracks()[0];
  } else if (!state.audio && audioTrack) {
    audioTrack.stop();
    audioTrack = null;
  }
}

function caps() {
  try { return videoTrack?.getCapabilities?.() || {}; } catch { return {}; }
}

/** Frame rate, torch and zoom can change on a live track without reopening the camera. */
async function applyTrackConstraints() {
  if (!videoTrack) return;
  const base = videoConstraints();
  delete base.deviceId; // can't switch device via applyConstraints
  delete base.facingMode;
  try {
    await videoTrack.applyConstraints({ ...base, advanced: extrasList() });
  } catch (e) {
    console.warn('applyConstraints failed, reopening camera', e);
    await acquireVideo();
  }
}

function extrasList() {
  const c = caps();
  const adv = {};
  if (c.torch) adv.torch = !!state.torch;
  if (c.zoom && state.zoom != null) adv.zoom = Math.min(c.zoom.max, Math.max(c.zoom.min, state.zoom));
  return Object.keys(adv).length ? [adv] : [];
}

async function applyExtras() {
  const adv = extrasList();
  if (!adv.length) return;
  const base = videoConstraints();
  delete base.deviceId;
  delete base.facingMode;
  try { await videoTrack.applyConstraints({ ...base, advanced: adv }); } catch (e) { console.warn('torch/zoom', e); }
}

function applyContentHint() {
  if (!videoTrack || !('contentHint' in videoTrack)) return;
  videoTrack.contentHint =
    state.degradation === 'maintain-resolution' ? 'detail' :
    state.degradation === 'maintain-framerate' ? 'motion' : '';
}

async function refreshDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    devices = all
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  } catch { devices = []; }
}

// ---------------------------------------------------------------- WebRTC

function closePc() {
  if (pc) { pc.onicecandidate = pc.onconnectionstatechange = null; pc.close(); }
  pc = null;
  videoSender = null;
  candidates.clear();
  renderPeer();
}

function supportedCodecs() {
  const list = (RTCRtpSender.getCapabilities?.('video')?.codecs || []).map((c) => c.mimeType.split('/')[1]);
  return ['VP8', 'VP9', 'H264', 'AV1'].filter((n) => list.some((x) => x.toUpperCase() === n));
}

function applyCodecPreference(transceiver) {
  if (state.codec === 'auto' || !transceiver.setCodecPreferences) return;
  const all = RTCRtpReceiver.getCapabilities?.('video')?.codecs || [];
  const want = all.filter((c) => c.mimeType.toLowerCase() === `video/${state.codec.toLowerCase()}`);
  if (!want.length) return;
  try {
    transceiver.setCodecPreferences([...want, ...all.filter((c) => !want.includes(c))]);
  } catch (e) { console.warn('setCodecPreferences', e); }
}

async function startCall() {
  closePc();
  if (!viewerPresent || !videoTrack) return;
  const id = ++callId;
  pc = new RTCPeerConnection(RTC_CONFIG);
  const stream = new MediaStream([videoTrack, ...(audioTrack ? [audioTrack] : [])]);

  const vt = pc.addTransceiver(videoTrack, { direction: 'sendonly', streams: [stream] });
  videoSender = vt.sender;
  applyCodecPreference(vt);
  if (audioTrack) pc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [stream] });

  pc.onicecandidate = (e) => { if (e.candidate) sig.send({ type: 'candidate', id, candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    renderPeer();
    if (pc?.connectionState === 'failed') enqueue(startCall); // e.g. Wi-Fi blip: try again
    broadcastState();
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sig.send({ type: 'offer', id, sdp: pc.localDescription.toJSON() });
  renderPeer();
}

/**
 * WebRTC normally starts around 300 kb/s and probes upward, which shows up as a few
 * seconds of blurry low-res video. On a LAN we can start near the target right away.
 * (Chromium reads these x-google-* hints; other browsers ignore them.)
 */
function fastStart(sdp) {
  const start = Math.max(300, Math.round(state.bitrate * 0.8));
  const hint = `x-google-start-bitrate=${start}`;
  const lines = sdp.split('\r\n');
  const media = /^(VP8|VP9|H264|AV1)\//i;

  // Payload types of real video codecs (not rtx/red/fec), and which already have fmtp lines.
  const pts = new Set();
  const hasFmtp = new Set();
  let inVideo = false;
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    if (!inVideo) continue;
    let m = l.match(/^a=rtpmap:(\d+) (.+)$/);
    if (m && media.test(m[2])) pts.add(m[1]);
    m = l.match(/^a=fmtp:(\d+) /);
    if (m) hasFmtp.add(m[1]);
  }

  const out = [];
  for (const l of lines) {
    const fm = l.match(/^a=fmtp:(\d+) /);
    if (fm && pts.has(fm[1]) && !l.includes('x-google-start-bitrate')) { out.push(`${l};${hint}`); continue; }
    out.push(l);
    const rm = l.match(/^a=rtpmap:(\d+) /);
    if (rm && pts.has(rm[1]) && !hasFmtp.has(rm[1])) out.push(`a=fmtp:${rm[1]} ${hint}`);
  }
  return out.join('\r\n');
}

async function applySenderParams() {
  if (!videoSender || !pc?.remoteDescription) return;
  const p = videoSender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = Math.round(state.bitrate * 1000);
  p.encodings[0].maxFramerate = state.fps;
  p.encodings[0].scaleResolutionDownBy = 1;
  p.degradationPreference = state.degradation;
  try {
    await videoSender.setParameters(p);
  } catch (e) {
    // Some browsers reject degradationPreference; retry without it.
    delete p.degradationPreference;
    try { await videoSender.setParameters(p); } catch (e2) { console.warn('setParameters', e2); }
  }
}

// ---------------------------------------------------------------- settings

async function applySettings(patch) {
  const prev = { ...state };
  if ('facingMode' in patch && !('deviceId' in patch)) patch.deviceId = null;
  Object.assign(state, patch);
  lastError = null;
  hideError();
  if (!started) return broadcastState();

  const changed = (k) => k in patch && patch[k] !== prev[k];
  const reopen = ['deviceId', 'facingMode', 'width', 'height'].some(changed);
  const renegotiate = changed('codec') || changed('audio');

  try {
    if (reopen) {
      if (!('zoom' in patch)) state.zoom = null; // zoom range differs per camera
      await acquireVideo();
    } else if (changed('fps') || changed('torch') || changed('zoom')) {
      await applyTrackConstraints();
    }
    if (changed('degradation')) applyContentHint();
    if (changed('audio')) await acquireAudio();
    if (renegotiate) await startCall();
    else await applySenderParams();
  } catch (e) {
    reportError(e);
  }
  renderTorch();
  broadcastState();
}

function broadcastState() {
  const s = videoTrack?.getSettings?.() || {};
  const c = caps();
  sig.send({
    type: 'state',
    state,
    started,
    actual: { width: s.width, height: s.height, fps: s.frameRate, facingMode: s.facingMode, deviceId: s.deviceId },
    caps: {
      maxWidth: c.width?.max, maxHeight: c.height?.max, maxFps: c.frameRate?.max,
      torch: !!c.torch, zoom: c.zoom ? { min: c.zoom.min, max: c.zoom.max, step: c.zoom.step || 0.1 } : null,
    },
    devices,
    codecs: supportedCodecs(),
    connection: pc?.connectionState || 'new',
    error: lastError,
  });
  renderActual();
}

// ---------------------------------------------------------------- signalling

async function onSignal(m) {
  switch (m.type) {
    case 'waiting':
      viewerPresent = false;
      break;
    case 'peer-joined':
      if (m.role !== 'viewer') break;
      viewerPresent = true;
      broadcastState();
      if (started) await startCall();
      break;
    case 'peer-left':
      viewerPresent = false;
      closePc();
      break;
    case 'answer':
      if (!pc || m.id !== callId) break;
      await pc.setRemoteDescription({ type: 'answer', sdp: fastStart(m.sdp.sdp) });
      await candidates.flush(pc);
      await applySenderParams();
      break;
    case 'candidate':
      if (m.id === callId) await candidates.add(pc, m.candidate);
      break;
    case 'settings':
      await applySettings(m.patch || {});
      break;
    case 'restart':
      await startCall();
      break;
    case 'request-state':
      broadcastState();
      break;
  }
  renderPeer();
}

// ---------------------------------------------------------------- UI

function onWsStatus(s) {
  const dot = $('#wsDot');
  const text = $('#wsText');
  dot.className = 'dot ' + (s === 'open' ? 'ok' : s === 'replaced' ? 'bad' : 'wait');
  text.textContent = s === 'open' ? 'Server' : s === 'replaced' ? 'Opened elsewhere' : 'Reconnecting…';
  if (s === 'replaced') showError('The phone page was opened on another device/tab. Reload to take over.');
  if (s !== 'open') { viewerPresent = false; renderPeer(); }
}

function renderPeer() {
  const dot = $('#peerDot');
  const text = $('#peerText');
  const st = pc?.connectionState;
  if (!viewerPresent) { dot.className = 'dot'; text.textContent = 'No viewer'; return; }
  if (st === 'connected') { dot.className = 'dot ok'; text.textContent = 'Streaming'; }
  else if (st === 'failed') { dot.className = 'dot bad'; text.textContent = 'Connection failed'; }
  else { dot.className = 'dot wait'; text.textContent = started ? 'Connecting…' : 'Viewer waiting'; }
}

function renderActual() {
  const s = videoTrack?.getSettings?.();
  $('#actual').textContent = s ? `${s.width}×${s.height} @ ${Math.round(s.frameRate || 0)}` : '';
}

function renderTorch() {
  const b = $('#torchBtn');
  b.classList.toggle('hidden', !caps().torch);
  b.classList.toggle('on', !!state.torch);
}

function showError(msg) {
  const el = $('#error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError() { $('#error').classList.add('hidden'); }

function reportError(e) {
  console.error(e);
  const msg =
    e?.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in the browser site settings and reload.' :
    e?.name === 'NotReadableError' ? 'Camera is busy — close other apps using it and try again.' :
    e?.name === 'OverconstrainedError' ? 'The camera does not support that setting.' :
    String(e?.message || e);
  lastError = msg;
  showError(msg);
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* not supported or denied - fine */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && started) requestWakeLock();
});

$('#startBtn').onclick = () => enqueue(async () => {
  try {
    await acquireVideo();
    await acquireAudio();
    started = true;
    $('#startScreen').classList.add('hidden');
    $('#controls').classList.remove('hidden');
    renderTorch();
    requestWakeLock();
    if (viewerPresent) await startCall();
    broadcastState();
  } catch (e) {
    reportError(e);
  }
});

$('#flipBtn').onclick = () => enqueue(() =>
  applySettings({ facingMode: state.facingMode === 'environment' ? 'user' : 'environment' }));

$('#torchBtn').onclick = () => enqueue(() => applySettings({ torch: !state.torch }));

$('#previewBtn').onclick = (e) => {
  // Hiding the preview saves a bit of battery/heat; the stream keeps going.
  const off = document.body.classList.toggle('dimmed');
  e.currentTarget.classList.toggle('on', !off);
  $('#dimnote').classList.toggle('hidden', !off);
};

// Keep the viewer's numbers fresh (actual fps can drift with lighting).
setInterval(() => { if (started) broadcastState(); }, 3000);

if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
  $('#startHint').textContent =
    'Camera access needs HTTPS. Open the https:// address the server printed (not http://).';
  $('#startBtn').disabled = true;
}
