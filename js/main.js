import { GlyphAtlas } from './glyphs.js';
import { AsciiField } from './ascii.js';
import { Effects } from './effects.js';
import { classifyHand, GestureEngine, COOLDOWN } from './gestures.js';
import { loadVision } from './vision.js';
import { DemoSitter } from './demo.js';
import { THEMES } from './palette.js';

const $ = (s) => document.querySelector(s);

const stageEl = $('#stage');
const canvas = $('#ascii');
const ctx = canvas.getContext('2d', { alpha: false });
const video = $('#video');
const overlay = $('#overlay');
const statusEl = $('#status');
const statusText = $('#statusText');
const statusAux = $('#statusAux');
const hintEl = $('#hint');

const GESTURES = ['wave', 'fireworks', 'thumbsUp', 'doubleThumbs', 'peace', 'heart'];
const GESTURE_NAMES = {
  wave: 'Wave',
  fireworks: 'Fist → open',
  thumbsUp: 'Thumbs up',
  doubleThumbs: 'Two thumbs up',
  peace: 'Peace',
  heart: 'Heart hands',
};
const ALL_ON = Object.fromEntries(GESTURES.map((g) => [g, true]));

// ramps run from no ink to most ink; a space means an empty cell
const CHARSETS = {
  classic: ' .:-=+*#%@',
  detailed: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  blocks: ' ░▒▓█',
  symbols: ' .,:+*o',
  minimal: ' .:-',
  binary: ' 10',
};

// ───────────────────────────────────────── settings

const STORE = 'ascii-camera:settings:v2';
const DEFAULTS = {
  brightness: 0, // -100..100
  contrast: 1, // 0.2..3
  blur: 0, // cells
  invert: false,
  charset: 'classic',
  custom: '',
  density: 0.55,
  edges: 'none',
  effects: ALL_ON,
  sensitivity: 0.5,
  removeBg: false,
  mirror: true,
  theme: 'light',
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (raw && typeof raw === 'object') return { ...DEFAULTS, ...raw, effects: { ...ALL_ON, ...(raw.effects || {}) } };
  } catch {}
  return { ...DEFAULTS, effects: { ...ALL_ON } };
}
function saveSettings() {
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
  } catch {}
}

const settings = loadSettings();

// ───────────────────────────────────────── core objects

const atlas = new GlyphAtlas();
const field = new AsciiField();
const demo = new DemoSitter();
const effects = new Effects();
const engine = new GestureEngine();
effects.field = field;
effects.body = field.body;

const segCanvas = document.createElement('canvas');
const segCtx = segCanvas.getContext('2d');

const state = {
  mode: 'idle', // idle | camera | demo
  vision: null,
  visionState: 'off', // off | loading | ready | failed
  W: 0,
  H: 0,
  dpr: 1,
  lastVideoTime: -1,
  lastTs: 0,
  mask: null,
  maskBuf: null,
  hands: [],
  waving: [],
  moving: [],
  segEvery: 1,
  frameNo: 0,
  previewWaveUntil: 0,
  previewWaveSide: 1,
};

let style = null;

function theme() {
  return THEMES[settings.theme] || THEMES.light;
}

function buildStyle() {
  const ink = theme().ink;
  const glyph = (ch) => (ch === ' ' ? null : atlas.get(ch, ink));
  const edgeGlyphs = ['|', '/', '-', '\\'].map(glyph);
  const custom = settings.custom.trim();
  if (settings.charset === 'custom' && custom) {
    // words are written out along the rows; a handful of symbols becomes a ramp
    if (/[\p{L}\p{N}]/u.test(custom) && [...custom].length >= 2) {
      const chars = [...settings.custom.replace(/\s+/g, ' ').trim(), ' '];
      style = { mode: 'text', text: chars.map(glyph), edgeGlyphs };
      return;
    }
    const uniq = [...new Set([...custom.replace(/\s/g, '')])];
    uniq.sort((a, b) => atlas.inkOf(a) - atlas.inkOf(b));
    style = { mode: 'ramp', glyphs: [null, ...uniq.map(glyph)], edgeGlyphs };
    return;
  }
  const ramp = CHARSETS[settings.charset] || CHARSETS.classic;
  style = { mode: 'ramp', glyphs: [...ramp].map(glyph), edgeGlyphs };
  // blocks are drawn tall enough to meet the rows above and below
  if (settings.charset === 'blocks') style.scale = 1.01 / atlas.extent('█');
}

const anyGesture = () => GESTURES.some((g) => settings.effects[g]);

// effect glyphs always use the canvas ink, so they stay black and white
const glyphFor = (ch) => atlas.get(ch, theme().ink);

function renderOpts() {
  return {
    brightness: settings.brightness / 200,
    contrast: settings.contrast,
    blur: settings.blur,
    // on a dark canvas the characters are light, so ink follows brightness
    invert: settings.invert !== (settings.theme === 'dark'),
    edges: settings.edges,
  };
}

// ───────────────────────────────────────── layout

function resize() {
  const r = stageEl.getBoundingClientRect();
  const W = Math.max(200, Math.round(r.width));
  const H = Math.max(200, Math.round(r.height));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (W === state.W && H === state.H && dpr === state.dpr) return;
  state.W = W;
  state.H = H;
  state.dpr = dpr;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  field.resize(W, H, settings.density);
  effects.setScale(W, H);
  segCanvas.width = 256;
  segCanvas.height = Math.max(64, Math.round((256 * H) / W));
  state.mask = null;
}

new ResizeObserver(resize).observe(stageEl);

// cover-crop a source into the stage
function cover(sw, sh) {
  const { W, H } = state;
  const s = Math.max(W / sw, H / sh);
  const w = sw * s, h = sh * s;
  return { ox: (W - w) / 2, oy: (H - h) / 2, w, h };
}

function drawCamera(c, w, h) {
  const cr = cover(video.videoWidth, video.videoHeight);
  if (settings.mirror) c.setTransform(-w / state.W, 0, 0, h / state.H, w, 0);
  else c.setTransform(w / state.W, 0, 0, h / state.H, 0, 0);
  c.drawImage(video, cr.ox, cr.oy, cr.w, cr.h);
  c.setTransform(1, 0, 0, 1, 0, 0);
}

function drawDemo(c, w, h) {
  c.setTransform(w / state.W, 0, 0, h / state.H, 0, 0);
  demo.draw(c, state.W, state.H);
  c.setTransform(1, 0, 0, 1, 0, 0);
}

// ───────────────────────────────────────── camera + segmenter

async function startCamera() {
  setOverlay('requesting');
  if (!navigator.mediaDevices?.getUserMedia) {
    $('#unavailableDetail').textContent = window.isSecureContext
      ? 'This browser has no camera access.'
      : 'Cameras need a secure page. Open this over https or localhost.';
    setOverlay('unavailable');
    return;
  }
  // warm the models up while the permission prompt is open
  if (settings.removeBg || anyGesture()) startVision();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    video.srcObject = stream;
    await video.play();
    state.mode = 'camera';
    effects.clear();
    setOverlay('none');
    updateStatus();
    if (anyGesture()) showHint(state.visionState === 'ready' ? 'Try a gesture: wave, fist → open, thumbs up, peace, heart hands' : 'Loading hand tracking…', 5000);
  } catch (err) {
    console.warn('[ascii-camera] camera error', err);
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      setOverlay('denied');
    } else {
      $('#unavailableDetail').textContent =
        name === 'NotReadableError' || name === 'TrackStartError'
          ? 'It seems busy. Close other apps using the camera.'
          : 'Plug one in, or close other apps using it.';
      setOverlay('unavailable');
    }
  }
}

function startVision() {
  if (state.visionState !== 'off') return;
  state.visionState = 'loading';
  updateStatus();
  loadVision()
    .then((v) => {
      state.vision = v;
      state.visionState = 'ready';
      updateStatus();
      if (state.mode === 'camera' && anyGesture()) showHint(v.hands ? 'Try a gesture: wave, fist → open, thumbs up, peace, heart hands' : 'Hand tracking didn’t load', 5000);
    })
    .catch((err) => {
      console.warn('[ascii-camera] motion models failed to load', err);
      state.visionState = 'failed';
      updateStatus();
    });
}

function nextTs() {
  let ts = performance.now();
  if (ts <= state.lastTs) ts = state.lastTs + 1;
  state.lastTs = ts;
  return ts;
}

function runSegmenter() {
  const seg = state.vision?.segmenter;
  if (!seg) return;
  segCtx.setTransform(1, 0, 0, 1, 0, 0);
  drawCamera(segCtx, segCanvas.width, segCanvas.height);
  try {
    const res = seg.segmentForVideo(segCanvas, nextTs());
    const masks = res.confidenceMasks;
    if (masks && masks.length) {
      const m = masks[masks.length - 1];
      const data = m.getAsFloat32Array();
      if (!state.maskBuf || state.maskBuf.length !== data.length) state.maskBuf = new Float32Array(data.length);
      state.maskBuf.set(data);
      state.mask = { data: state.maskBuf, width: m.width, height: m.height };
    }
    res.close();
  } catch (err) {
    console.warn('[ascii-camera] segmenter stopped', err);
    state.vision.segmenter = null;
    state.visionState = 'failed';
    state.mask = null;
    updateStatus();
  }
}

function runHands() {
  const hl = state.vision?.hands;
  if (!hl) return [];
  let res;
  try {
    res = hl.detectForVideo(video, nextTs());
  } catch (err) {
    console.warn('[ascii-camera] hand tracking stopped', err);
    state.vision.hands = null;
    updateStatus();
    return [];
  }
  const cr = cover(video.videoWidth, video.videoHeight);
  const W = state.W;
  const out = [];
  const used = new Set();
  (res.landmarks || []).forEach((lm, k) => {
    const world = res.worldLandmarks?.[k];
    if (!world || lm.length < 21) return;
    const pts = lm.map((p) => {
      const x = cr.ox + p.x * cr.w;
      return { x: settings.mirror ? W - x : x, y: cr.oy + p.y * cr.h };
    });
    const cls = classifyHand(world, pts);
    const palm = {
      x: (pts[0].x + pts[5].x + pts[9].x + pts[17].x) / 4,
      y: (pts[0].y + pts[5].y + pts[9].y + pts[17].y) / 4,
    };
    const size = Math.max(Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y), Math.hypot(pts[5].x - pts[17].x, pts[5].y - pts[17].y) * 1.3, 20);
    let key = res.handedness?.[k]?.[0]?.categoryName || 'hand';
    if (used.has(key)) key += '2';
    used.add(key);
    out.push({ key, pose: cls.pose, fingersOut: cls.fingersOut, palm, size, pts });
  });
  return out;
}

// ───────────────────────────────────────── effects

function playEffect(ev) {
  switch (ev.type) {
    case 'wave':
      break; // ambient: emission happens every frame while the hand waves
    case 'fireworks':
      effects.fireworks(ev.x, ev.y);
      break;
    case 'thumbsUp':
      effects.spark(ev.x, ev.y);
      break;
    case 'doubleThumbs':
      effects.celebrate(ev.a, ev.b);
      break;
    case 'peace':
      effects.peace(ev.base, ev.tipA, ev.tipB);
      break;
    case 'heart':
      effects.hearts(ev.x, ev.y);
      break;
  }
  feedback(ev.type);
}

// the effect plays inside the mirror; its row in the panel lights up briefly
function feedback(type) {
  window.dispatchEvent(new CustomEvent('ascii-camera:gesture', { detail: { type } }));
  const row = document.querySelector(`.gesture[data-gesture="${type}"]`);
  if (row) {
    row.classList.add('is-hit');
    clearTimeout(row._t);
    row._t = setTimeout(() => row.classList.remove('is-hit'), 1200);
  }
}

// previews from the Try buttons and number keys, placed where a hand would be
function preview(type) {
  const now = performance.now();
  if (engine.cooling(type, now) && type !== 'fireworks') return;
  engine.coolUntil[type] = now + (type === 'fireworks' ? 250 : COOLDOWN[type]);
  const b = field.body;
  const side = Math.random() < 0.5 ? -1 : 1;
  const hx = b.cx + side * Math.max(b.rx * 0.75, state.W * 0.16);
  const hy = Math.min(state.H * 0.8, b.cy + b.ry * 0.05);
  const size = 70 * effects.unit;
  switch (type) {
    case 'wave':
      state.previewWaveUntil = now + 2000;
      state.previewWaveSide = side;
      feedback('wave');
      return;
    case 'fireworks':
      return playEffect({ type, x: hx, y: hy - state.H * 0.12 });
    case 'thumbsUp':
      return playEffect({ type, x: hx, y: hy - size * 0.6 });
    case 'doubleThumbs':
      return playEffect({ type, a: { x: b.cx - Math.max(b.rx * 0.75, state.W * 0.16), y: hy - size * 0.6 }, b: { x: b.cx + Math.max(b.rx * 0.75, state.W * 0.16), y: hy - size * 0.6 } });
    case 'peace': {
      const base = { x: hx, y: hy };
      return playEffect({ type, base, tipA: { x: hx - size * 0.45, y: hy - size * 1.4 }, tipB: { x: hx + size * 0.45, y: hy - size * 1.35 } });
    }
    case 'heart':
      return playEffect({ type, x: b.cx, y: Math.min(state.H * 0.72, b.cy) });
  }
}

// ───────────────────────────────────────── status + overlays

function setOverlay(name) {
  overlay.dataset.state = name;
}

function updateStatus() {
  let s = 'idle', text = 'Standing by', aux = '';
  if (state.mode === 'demo') {
    s = 'demo';
    text = 'Demo';
  } else if (state.mode === 'camera') {
    s = 'active';
    text = 'Live';
  }
  if (state.mode === 'camera' && (settings.removeBg || anyGesture())) {
    if (state.visionState === 'loading') aux = '· loading hand tracking';
    else if (state.visionState === 'failed') aux = '· tracking unavailable';
    else if (anyGesture() && state.vision && !state.vision.hands) aux = '· gestures unavailable';
    else if (anyGesture() && state.hands.length) aux = `· ${state.hands.length} hand${state.hands.length > 1 ? 's' : ''}`;
  }
  statusEl.dataset.state = s;
  statusText.textContent = text;
  statusAux.textContent = aux;
}

let hintTimer = 0;
function showHint(text, ms = 2500) {
  hintEl.textContent = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => (hintEl.textContent = ''), ms);
}

// ───────────────────────────────────────── main loop

let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;
  if (!state.W) return;

  const t = now / 1000;
  const opts = renderOpts();
  let fresh = false;
  if (state.mode === 'camera' && video.readyState >= 2 && video.videoWidth) {
    if (video.currentTime !== state.lastVideoTime) {
      state.lastVideoTime = video.currentTime;
      fresh = true;
      state.frameNo++;
      if (state.visionState === 'ready') {
        const t0 = performance.now();
        if (settings.removeBg && state.frameNo % state.segEvery === 0) runSegmenter();
        const had = state.hands.length;
        state.hands = anyGesture() ? runHands() : [];
        if (had !== state.hands.length) updateStatus();
        // if the machine struggles, segment every other frame
        const cost = performance.now() - t0;
        state.segEvery = cost > 26 ? 2 : cost < 14 ? 1 : state.segEvery;
      }
      field.ingest(drawCamera, settings.removeBg ? state.mask : null, opts);
    }
  } else {
    demo.step(t);
    field.ingest(drawDemo, settings.removeBg ? demo.maskFor(state.W / state.H) : null, opts);
  }

  // gestures
  if (state.mode === 'camera' && fresh && state.visionState === 'ready') {
    const out = engine.update(state.hands, now, settings.sensitivity, settings.effects);
    state.waving = out.waving;
    state.moving = out.moving;
    for (const ev of out.events) playEffect(ev);
  } else if (state.mode === 'camera' && state.visionState !== 'ready') {
    state.waving = [];
    state.moving = [];
  }

  // hands stir the portrait; waving hands shed sparkles
  for (const h of state.moving) field.stir(h.x, h.y, h.size * 1.3, h.vx, h.vy, dt * 1.6);
  for (const h of state.waving) effects.waveTrail(h, dt);
  if (now < state.previewWaveUntil) {
    const b = field.body;
    const k = (state.previewWaveUntil - now) / 2000;
    const x = b.cx + state.previewWaveSide * Math.max(b.rx * 0.75, state.W * 0.16) + Math.sin(t * 9) * 40 * effects.unit;
    const y = b.cy - b.ry * 0.1 + Math.cos(t * 9) * 6;
    effects.waveTrail({ x, y, vx: Math.cos(t * 9) * 360 * effects.unit, vy: 0, size: 70 * effects.unit }, dt * (0.4 + k));
    field.stir(x, y, 90 * effects.unit, Math.cos(t * 9) * 360, 0, dt * 1.2);
  }

  field.update(dt);
  effects.update(dt);
  effects.rasterize(field, glyphFor);

  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme().bg;
  ctx.fillRect(0, 0, state.W, state.H);
  field.draw(ctx, style, opts);
}

// ───────────────────────────────────────── controls

const controls = [...document.querySelectorAll('[data-setting]')];

function formatValue(key, v) {
  if (key === 'brightness') return (v > 0 ? '+' : '') + v;
  if (key === 'contrast') return (+v).toFixed(1);
  if (key === 'density' || key === 'sensitivity') return Math.round(v * 100) + '%';
  return String(v);
}

function syncControls() {
  for (const el of controls) {
    const key = el.dataset.setting;
    const v = settings[key];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') el.checked = el.value === v;
    else if (el.value !== String(v)) el.value = v;
  }
  document.querySelectorAll('output[data-for]').forEach((o) => {
    o.textContent = formatValue(o.dataset.for, settings[o.dataset.for]);
  });
  $('#customChip').classList.toggle('is-active', settings.charset === 'custom');
  document.querySelectorAll('[data-effect]').forEach((el) => {
    el.checked = !!settings.effects[el.dataset.effect];
    el.closest('.gesture').classList.toggle('is-off', !el.checked);
  });
  $('#sensitivity').disabled = !anyGesture();
}

// typing in the custom chip selects it; clearing it goes back to the last preset
let lastPreset = settings.charset === 'custom' ? 'classic' : settings.charset;
function useCustom(on) {
  if (on && settings.charset !== 'custom') {
    lastPreset = settings.charset;
    settings.charset = 'custom';
  } else if (!on && settings.charset === 'custom') {
    settings.charset = lastPreset;
  }
}

function apply(key) {
  if (key === 'custom') useCustom(!!settings.custom.trim());
  if (key === 'density') field.resize(state.W, state.H, settings.density);
  if (key === 'charset' || key === 'custom' || key === 'theme') buildStyle();
  if (key === 'removeBg' && settings.removeBg && state.mode === 'camera') startVision();
  if (key === 'removeBg') updateStatus();
}

for (const el of controls) {
  const key = el.dataset.setting;
  el.addEventListener(el.type === 'range' || el.type === 'text' ? 'input' : 'change', () => {
    if (el.type === 'checkbox') settings[key] = el.checked;
    else if (el.type === 'range') settings[key] = +el.value;
    else if (el.type === 'radio') {
      if (!el.checked) return;
      settings[key] = el.value;
    } else settings[key] = el.value;
    apply(key);
    syncControls();
    saveSettings();
  });
}

document.querySelectorAll('[data-effect]').forEach((el) => {
  el.addEventListener('change', () => {
    settings.effects = { ...settings.effects, [el.dataset.effect]: el.checked };
    if (el.checked && state.mode === 'camera') startVision();
    syncControls();
    updateStatus();
    saveSettings();
  });
});

document.querySelectorAll('[data-try]').forEach((btn) => {
  btn.addEventListener('click', () => {
    preview(btn.dataset.try);
    if (window.matchMedia('(max-width: 900px)').matches) stageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
});

$('#customChip input').addEventListener('focus', () => {
  if (!settings.custom.trim()) return;
  useCustom(true);
  buildStyle();
  syncControls();
  saveSettings();
});

// ───────────────────────────────────────── tabs

const tabs = [...document.querySelectorAll('[role="tab"]')];

function selectTab(name, focus) {
  for (const t of tabs) {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $('#' + t.getAttribute('aria-controls')).hidden = !on;
    if (on && focus) t.focus();
  }
  try {
    localStorage.setItem('ascii-camera:tab', name);
  } catch {}
}

tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t.dataset.tab));
  t.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    selectTab(tabs[(i + d + tabs.length) % tabs.length].dataset.tab, true);
  });
});

let savedTab = 'style';
try {
  savedTab = localStorage.getItem('ascii-camera:tab') || 'style';
} catch {}
selectTab(tabs.some((t) => t.dataset.tab === savedTab) ? savedTab : 'style');

$('#resetBtn').addEventListener('click', () => {
  Object.assign(settings, DEFAULTS, { effects: { ...ALL_ON } });
  field.resize(state.W, state.H, settings.density);
  buildStyle();
  syncControls();
  updateStatus();
  saveSettings();
});

$('#copyBtn').addEventListener('click', async () => {
  const text = field.toText();
  try {
    await navigator.clipboard.writeText(text);
    showHint(`Copied ${field.cols} × ${field.rows} characters`);
  } catch {
    download(new Blob([text], { type: 'text/plain' }), 'txt');
    showHint('Clipboard unavailable, saved as a text file');
  }
});

$('#snapBtn').addEventListener('click', () => {
  canvas.toBlob((blob) => blob && download(blob, 'png'), 'image/png');
});

function download(blob, ext) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ascii-camera-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 6) preview(GESTURES[n - 1]);
});

$('#startBtn').addEventListener('click', startCamera);
overlay.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'retry') startCamera();
  if (action === 'demo') {
    state.mode = 'demo';
    setOverlay('none');
    updateStatus();
    showHint('Press Try, or keys 1–6, to preview the gestures', 5000);
  }
});

// ───────────────────────────────────────── boot

// ?debug exposes internals on window for tinkering from the console
if (new URLSearchParams(location.search).has('debug')) window.asciiCamera = { state, engine, field, effects, settings };

async function boot() {
  syncControls();
  resize();
  buildStyle();
  updateStatus();
  requestAnimationFrame(frame);

  // re-rasterise glyphs once the web font arrives
  try {
    await Promise.race([document.fonts.load('64px "IBM Plex Mono"'), new Promise((r) => setTimeout(r, 2500))]);
  } catch {}
  atlas.clear();
  buildStyle();

  // skip the intro if the camera is already allowed
  try {
    const p = await navigator.permissions?.query({ name: 'camera' });
    if (p?.state === 'granted' && state.mode === 'idle') startCamera();
  } catch {}
}

boot();
