// PC side: receives the stream, shows stats, sends settings to the phone.
import {
  connectSignal, CandidateQueue, RTC_CONFIG, RESOLUTIONS, FRAMERATES, QUALITY_PRESETS, serialQueue,
} from './common.js';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const stage = $('#stage');
const params = new URLSearchParams(location.search);
if (params.has('clean')) document.body.classList.add('clean');

let pc = null;
let currentId = null;
let phonePresent = false;
let phone = null;        // last state message from the phone
let wsOpen = false;
const candidates = new CandidateQueue();
const enqueue = serialQueue();
const view = { fit: 'contain', rotate: 0, mirror: false };

const sig = connectSignal('viewer', (m) => enqueue(() => onSignal(m)), (s) => {
  wsOpen = s === 'open';
  $('#wsDot').className = 'dot ' + (wsOpen ? 'ok' : s === 'replaced' ? 'bad' : 'wait');
  $('#wsText').textContent = wsOpen ? 'Connected' : s === 'replaced' ? 'Opened in another tab' : 'Reconnecting…';
  if (!wsOpen) { phonePresent = false; closePc(); }
  render();
});

// ---------------------------------------------------------------- WebRTC

function closePc() {
  if (pc) { pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null; pc.close(); }
  pc = null;
  candidates.clear();
  video.srcObject = null;
  stopRecording();
}

async function onOffer(m) {
  closePc();
  currentId = m.id;
  pc = new RTCPeerConnection(RTC_CONFIG);
  const remote = new MediaStream();
  pc.ontrack = (e) => {
    remote.addTrack(e.track);
    if (video.srcObject !== remote) video.srcObject = remote;
    video.muted = !remote.getAudioTracks().length; // allow audio playback when enabled
    video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) sig.send({ type: 'candidate', id: m.id, candidate: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = render;
  await pc.setRemoteDescription(m.sdp);
  await candidates.flush(pc);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sig.send({ type: 'answer', id: m.id, sdp: pc.localDescription.toJSON() });
  render();
}

async function onSignal(m) {
  switch (m.type) {
    case 'waiting':
      phonePresent = false;
      break;
    case 'peer-joined':
      if (m.role === 'phone') { phonePresent = true; sig.send({ type: 'request-state' }); }
      break;
    case 'peer-left':
      phonePresent = false;
      phone = null;
      closePc();
      break;
    case 'offer':
      await onOffer(m);
      break;
    case 'candidate':
      if (m.id === currentId) await candidates.add(pc, m.candidate);
      break;
    case 'state':
      phonePresent = true;
      phone = m;
      syncControls();
      break;
  }
  render();
}

function send(patch) {
  sig.send({ type: 'settings', patch });
}

// ---------------------------------------------------------------- controls

function fillSelect(sel, items) {
  const keep = sel.value;
  sel.innerHTML = '';
  for (const { value, label, disabled } of items) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    if (disabled) o.disabled = true;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

// Bitrate slider is logarithmic: 250 kbps .. 25 Mbps
const BR_MIN = 250, BR_MAX = 25000;
const toKbps = (v) => Math.round(BR_MIN * Math.pow(BR_MAX / BR_MIN, v / 100) / 50) * 50;
const toSlider = (k) => Math.round(100 * Math.log(k / BR_MIN) / Math.log(BR_MAX / BR_MIN));
const fmtRate = (k) => (k >= 1000 ? `${(k / 1000).toFixed(k >= 10000 ? 0 : 1)} Mb/s` : `${k} kb/s`);

fillSelect($('#quality'), [
  ...QUALITY_PRESETS.map((p) => ({ value: String(p.kbps), label: `${p.label} · ${fmtRate(p.kbps)}` })),
  { value: 'custom', label: 'Custom', disabled: true },
]);

function syncControls() {
  if (!phone) return;
  const { state: s, caps, devices, codecs, actual } = phone;
  const maxDim = Math.max(caps.maxWidth || 0, caps.maxHeight || 0);
  const minDim = Math.min(caps.maxWidth || 0, caps.maxHeight || 0);

  fillSelect($('#device'), [
    { value: '', label: 'Auto (by facing)' },
    ...devices.map((d) => ({ value: d.deviceId, label: d.label })),
  ]);
  $('#device').value = s.deviceId || '';

  for (const b of $('#facing').children) b.classList.toggle('on', !s.deviceId && b.dataset.v === s.facingMode);

  const resItems = RESOLUTIONS
    .filter((r) => !maxDim || (r.w <= maxDim && r.h <= minDim))
    .map((r) => ({ value: `${r.w}x${r.h}`, label: `${r.label} (${r.w}×${r.h})` }));
  const cur = `${s.width}x${s.height}`;
  if (!resItems.some((r) => r.value === cur)) resItems.push({ value: cur, label: `${s.width}×${s.height}` });
  fillSelect($('#resolution'), resItems);
  $('#resolution').value = cur;

  const fpsItems = FRAMERATES
    .filter((f) => !caps.maxFps || f <= Math.ceil(caps.maxFps))
    .map((f) => ({ value: String(f), label: `${f} fps` }));
  if (!fpsItems.some((f) => f.value === String(s.fps))) fpsItems.push({ value: String(s.fps), label: `${s.fps} fps` });
  fillSelect($('#fps'), fpsItems);
  $('#fps').value = String(s.fps);

  $('#zoomRow').classList.toggle('hidden', !caps.zoom);
  if (caps.zoom) {
    const z = $('#zoom');
    z.min = caps.zoom.min; z.max = caps.zoom.max; z.step = caps.zoom.step;
    z.value = s.zoom ?? caps.zoom.min;
    $('#zoomVal').textContent = `${Number(z.value).toFixed(1)}×`;
  }
  $('#torchRow').classList.toggle('hidden', !caps.torch);
  $('#torch').checked = !!s.torch;

  const preset = QUALITY_PRESETS.find((p) => p.kbps === s.bitrate);
  $('#quality').value = preset ? String(preset.kbps) : 'custom';
  $('#bitrate').value = toSlider(s.bitrate);
  $('#bitrateVal').textContent = fmtRate(s.bitrate);
  $('#degradation').value = s.degradation;

  fillSelect($('#codec'), [{ value: 'auto', label: 'Auto' }, ...codecs.map((c) => ({ value: c, label: c }))]);
  $('#codec').value = s.codec;
  $('#audio').checked = !!s.audio;

  $('#actualHint').textContent = actual?.width
    ? `Camera is delivering ${actual.width}×${actual.height} @ ${Math.round(actual.fps || 0)} fps` +
      (actual.width < actual.height ? ' (portrait — rotate the phone for landscape)' : '')
    : '';
  const err = $('#phoneErr');
  err.classList.toggle('hidden', !phone.error);
  err.textContent = phone.error ? `Phone: ${phone.error}` : '';
}

$('#device').onchange = (e) => send(e.target.value ? { deviceId: e.target.value } : { deviceId: null });
$('#facing').onclick = (e) => { if (e.target.dataset.v) send({ facingMode: e.target.dataset.v }); };
$('#resolution').onchange = (e) => {
  const [w, h] = e.target.value.split('x').map(Number);
  send({ width: w, height: h });
};
$('#fps').onchange = (e) => send({ fps: Number(e.target.value) });
$('#zoom').oninput = (e) => { $('#zoomVal').textContent = `${Number(e.target.value).toFixed(1)}×`; };
$('#zoom').onchange = (e) => send({ zoom: Number(e.target.value) });
$('#torch').onchange = (e) => send({ torch: e.target.checked });
$('#quality').onchange = (e) => send({ bitrate: Number(e.target.value) });
$('#bitrate').oninput = (e) => { $('#bitrateVal').textContent = fmtRate(toKbps(Number(e.target.value))); };
$('#bitrate').onchange = (e) => send({ bitrate: toKbps(Number(e.target.value)) });
$('#degradation').onchange = (e) => send({ degradation: e.target.value });
$('#codec').onchange = (e) => send({ codec: e.target.value });
$('#audio').onchange = (e) => send({ audio: e.target.checked });
$('#reconnectBtn').onclick = () => sig.send({ type: 'restart' });

// ---------------------------------------------------------------- local view options

function applyView() {
  stage.classList.toggle('cover', view.fit === 'cover');
  const sideways = view.rotate % 180 !== 0;
  const r = stage.getBoundingClientRect();
  video.style.width = sideways ? `${r.height}px` : '100%';
  video.style.height = sideways ? `${r.width}px` : '100%';
  video.style.transform = `translate(-50%, -50%) rotate(${view.rotate}deg) scaleX(${view.mirror ? -1 : 1})`;
  for (const b of $('#fit').children) b.classList.toggle('on', b.dataset.v === view.fit);
  for (const b of $('#rotate').children) b.classList.toggle('on', Number(b.dataset.v) === view.rotate);
  $('#mirror').checked = view.mirror;
  try { localStorage.setItem('phonecam.view', JSON.stringify(view)); } catch {}
}
try { Object.assign(view, JSON.parse(localStorage.getItem('phonecam.view') || '{}')); } catch {}
if (params.has('rotate')) view.rotate = Number(params.get('rotate')) || 0;
if (params.has('mirror')) view.mirror = true;
$('#fit').onclick = (e) => { if (e.target.dataset.v) { view.fit = e.target.dataset.v; applyView(); } };
$('#rotate').onclick = (e) => { if (e.target.dataset.v) { view.rotate = Number(e.target.dataset.v); applyView(); } };
$('#mirror').onchange = (e) => { view.mirror = e.target.checked; applyView(); };
new ResizeObserver(applyView).observe(stage);

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen?.();
}
$('#fsBtn').onclick = toggleFullscreen;
stage.ondblclick = toggleFullscreen;

function stamp() {
  return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function snapshot() {
  if (!video.videoWidth) return;
  const sideways = view.rotate % 180 !== 0;
  const w = video.videoWidth, h = video.videoHeight;
  const c = document.createElement('canvas');
  c.width = sideways ? h : w;
  c.height = sideways ? w : h;
  const g = c.getContext('2d');
  g.translate(c.width / 2, c.height / 2);
  g.rotate((view.rotate * Math.PI) / 180);
  if (view.mirror) g.scale(-1, 1);
  g.drawImage(video, -w / 2, -h / 2, w, h);
  c.toBlob((b) => download(b, `phonecam-${stamp()}.png`), 'image/png');
}
$('#snapBtn').onclick = snapshot;

// Recording saves the raw stream (rotation/mirror are display-only).
let recorder = null, recChunks = [], recStart = 0, recTimer = null;
function startRecording() {
  if (!video.srcObject) return;
  const types = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mimeType = types.find((t) => window.MediaRecorder?.isTypeSupported?.(t));
  recorder = new MediaRecorder(video.srcObject, mimeType ? { mimeType, videoBitsPerSecond: 16e6 } : {});
  recChunks = [];
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.onstop = () => {
    const type = recorder.mimeType || 'video/webm';
    download(new Blob(recChunks, { type }), `phonecam-${stamp()}.${type.includes('mp4') ? 'mp4' : 'webm'}`);
    recorder = null;
  };
  recorder.start(1000);
  recStart = Date.now();
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
  renderRec();
}
function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  clearInterval(recTimer);
  renderRec();
}
function renderRec() {
  const on = !!recorder && recorder.state === 'recording';
  $('#recBadge').classList.toggle('hidden', !on);
  $('#recBtn').textContent = on ? '⏹ Stop' : '⏺ Record';
  $('#recBtn').classList.toggle('on', on);
}
$('#recBtn').onclick = () => (recorder?.state === 'recording' ? stopRecording() : startRecording());

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'f') toggleFullscreen();
  else if (k === 'h') { document.body.classList.toggle('nopanel'); }
  else if (k === 's') snapshot();
});

// ---------------------------------------------------------------- status & stats

function render() {
  const st = pc?.connectionState;
  const live = st === 'connected' && video.srcObject;
  $('#phoneDot').className = 'dot ' + (live ? 'ok' : phonePresent ? 'wait' : '');
  $('#phoneText').textContent =
    live ? 'Streaming' :
    !phonePresent ? 'Not connected' :
    st === 'failed' ? 'Connection failed' :
    phone && !phone.started ? 'Connected — camera not started' : 'Connecting…';

  $('#waiting').classList.toggle('hidden', !!live);
  $('#waitTitle').textContent =
    !wsOpen ? 'Can\'t reach the PhoneCam server' :
    !phonePresent ? 'Waiting for the phone…' :
    phone && !phone.started ? 'Phone connected — tap “Start camera” on it' :
    st === 'failed' ? 'Connection failed — are both on the same network?' : 'Connecting…';
  const showUrl = wsOpen && !phonePresent;
  $('#waitSub').classList.toggle('hidden', !showUrl);
  $('#phoneUrl').classList.toggle('hidden', !showUrl);
  $('#qr').classList.toggle('hidden', !showUrl || !$('#qr').src);
  document.querySelectorAll('#cameraSection select, #cameraSection input, #cameraSection button, #encodingSection select, #encodingSection input').forEach((el) => { el.disabled = !phone; });
}

fetch('/api/info').then((r) => r.json()).then((info) => {
  $('#phoneUrl').textContent = info.phoneUrl;
  if (info.qr) { $('#qr').src = '/qr.svg'; }
  render();
}).catch(() => {});

let last = null;
setInterval(async () => {
  if (!pc || pc.connectionState !== 'connected') { $('#overlay').textContent = ''; last = null; return; }
  const report = await pc.getStats();
  let inb = null, pair = null;
  const codecs = {};
  report.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') inb = s;
    else if (s.type === 'codec') codecs[s.id] = s;
    else if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pair = s;
  });
  if (!inb) return;
  let kbps = null;
  if (last && last.id === inb.id && inb.timestamp > last.ts) {
    kbps = Math.round(((inb.bytesReceived - last.bytes) * 8) / (inb.timestamp - last.ts));
  }
  last = { id: inb.id, bytes: inb.bytesReceived, ts: inb.timestamp };

  const codec = codecs[inb.codecId]?.mimeType?.split('/')[1] || '?';
  const fps = inb.framesPerSecond != null ? Math.round(inb.framesPerSecond) : '?';
  const res = inb.frameWidth ? `${inb.frameWidth}×${inb.frameHeight}` : '?';
  const rtt = pair?.currentRoundTripTime != null ? `${Math.round(pair.currentRoundTripTime * 1000)} ms` : '?';
  const rows = [
    ['Resolution', res],
    ['Frame rate', `${fps} fps`],
    ['Bitrate', kbps != null ? fmtRate(kbps) : '…'],
    ['Codec', codec],
    ['Round trip', rtt],
    ['Lost pkts', inb.packetsLost ?? 0],
    ['Dropped', inb.framesDropped ?? 0],
    ['Jitter buf', inb.jitterBufferEmittedCount ? `${Math.round((inb.jitterBufferDelay / inb.jitterBufferEmittedCount) * 1000)} ms` : '?'],
  ];
  $('#stats').innerHTML = rows.map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('');
  $('#overlay').textContent = `${res} · ${fps} fps · ${kbps != null ? fmtRate(kbps) : '…'} · ${codec}`;
}, 1000);

applyView();
render();
