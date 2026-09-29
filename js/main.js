import { GlyphAtlas } from './glyphs.js';
import { AsciiField } from './ascii.js';
import { Effects, INK } from './effects.js';
import { classifyHand, GestureEngine, COOLDOWN } from './gestures.js';
import { loadVision } from './vision.js';
import { DemoSitter } from './demo.js';

const $ = (s) => document.querySelector(s);
const PAPER = '#f2ede3';

const stageEl = $('#stage');
const canvas = $('#ascii');
const ctx = canvas.getContext('2d', { alpha: false });
const video = $('#video');
const overlay = $('#overlay');
const statusEl = $('#status');
const statusText = $('#statusText');
const statusAux = $('#statusAux');
const dimsEl = $('#dims');
const toastEl = $('#toast');
const hintEl = $('#hint');

const GESTURES = ['wave', 'fireworks', 'thumbsUp', 'doubleThumbs', 'peace', 'heart'];
const LABELS = {
  wave: ['01', 'wave', 'sparkles'],
  fireworks: ['02', 'fist → open', 'fireworks'],
  thumbsUp: ['03', 'thumbs up', 'spark'],
  doubleThumbs: ['04', 'two thumbs up', 'celebration'],
  peace: ['05', 'peace', 'star burst'],
  heart: ['06', 'heart hands', 'hearts'],
};
const PRESETS = {
  dot: ['.'],
  plus: ['+'],
  x: ['x'],
  o: ['o'],
  hash: ['#'],
  at: ['@'],
  mixed: ['.', '+', '*', 'o', ',', ':'],
};

// ───────────────────────────────────────── settings

const DEFAULTS = {
  charset: 'mixed',
  custom: '',
  density: 0.55,
  sensitivity: 0.5,
  effects: Object.fromEntries(GESTURES.map((g) => [g, true])),
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('ascii-camera:settings') || 'null');
    if (raw && typeof raw === 'object') return { ...DEFAULTS, ...raw, effects: { ...DEFAULTS.effects, ...(raw.effects || {}) } };
  } catch {}
  return structuredClone(DEFAULTS);
}
function saveSettings() {
  try {
    localStorage.setItem('ascii-camera:settings', JSON.stringify(settings));
  } catch {}
}

const settings = loadSettings();

// ───────────────────────────────────────── core objects

const atlas = new GlyphAtlas();
const field = new AsciiField();
const effects = new Effects(atlas);
const engine = new GestureEngine();
const demo = new DemoSitter();
effects.field = field;
effects.body = field.body;

const segCanvas = document.createElement('canvas');
const segCtx = segCanvas.getContext('2d', { willReadFrequently: false });

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
  fps: 0,
  fpsAcc: 0,
  fpsN: 0,
  previewWaveUntil: 0,
  previewWaveSide: 1,
  hintTimer: 0,
};

let style = null;

function buildStyle() {
  const dot = atlas.get('.', INK);
  const custom = (settings.custom || '').trim();
  if (settings.charset === 'custom' && custom) {
    const isText = /[\p{L}\p{N}]/u.test(custom) && [...custom].length >= 2;
    if (isText) {
      const chars = [...settings.custom.replace(/\s+/g, ' ').trim(), ' '];
      style = { mode: 'text', text: chars, textGlyphs: chars.map((ch) => (ch === ' ' ? null : atlas.get(ch, INK))), dot };
      return;
    }
    const uniq = [...new Set([...custom.replace(/\s/g, '')])];
    uniq.sort((a, b) => atlas.inkOf(a) - atlas.inkOf(b));
    style = { mode: 'density', glyphs: uniq.map((ch) => atlas.get(ch, INK)), dot };
    return;
  }
  const chars = [...(PRESETS[settings.charset] || PRESETS.mixed)];
  chars.sort((a, b) => atlas.inkOf(a) - atlas.inkOf(b));
  style = { mode: 'density', glyphs: chars.map((ch) => atlas.get(ch, INK)), dot };
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

// cover-crop a source into the stage, mirrored like a looking glass
function cover(sw, sh) {
  const { W, H } = state;
  const s = Math.max(W / sw, H / sh);
  const w = sw * s, h = sh * s;
  return { ox: (W - w) / 2, oy: (H - h) / 2, w, h };
}

function drawCamera(c, w, h) {
  const cr = cover(video.videoWidth, video.videoHeight);
  c.setTransform(-w / state.W, 0, 0, h / state.H, w, 0);
  c.drawImage(video, cr.ox, cr.oy, cr.w, cr.h);
  c.setTransform(1, 0, 0, 1, 0, 0);
}

function drawDemo(c, w, h) {
  c.setTransform(w / state.W, 0, 0, h / state.H, 0, 0);
  demo.draw(c, state.W, state.H);
  c.setTransform(1, 0, 0, 1, 0, 0);
}

// ───────────────────────────────────────── camera + model

async function startCamera() {
  setOverlay('requesting');
  if (!navigator.mediaDevices?.getUserMedia) {
    $('#unavailableDetail').textContent = window.isSecureContext
      ? 'This browser has no camera access.'
      : 'Cameras need a secure page — open this over https or localhost.';
    setOverlay('unavailable');
    return;
  }
  // warm the model up while the permission prompt is open
  startVision();
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
    showHint(state.visionState === 'ready' ? 'try a wave ✦' : 'warming up the motion sensor …', 0);
  } catch (err) {
    console.warn('[ascii-camera] camera error', err);
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      setOverlay('denied');
    } else {
      $('#unavailableDetail').textContent =
        name === 'NotReadableError' || name === 'TrackStartError'
          ? 'It seems busy — close other apps using the camera.'
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
      state.visionState = v.hands ? 'ready' : 'failed';
      updateStatus();
      if (state.mode === 'camera') showHint(v.hands ? 'try a wave ✦' : 'gestures are offline — portrait only', 4200);
    })
    .catch((err) => {
      console.warn('[ascii-camera] motion model failed to load', err);
      state.visionState = 'failed';
      updateStatus();
      if (state.mode === 'camera') showHint('the motion model didn’t load — portrait only', 5000);
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
    state.mask = null;
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
    state.visionState = 'failed';
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
    const pts = lm.map((p) => ({ x: W - (cr.ox + p.x * cr.w), y: cr.oy + p.y * cr.h }));
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

// ───────────────────────────────────────── effects + feedback

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

let toastTimer = 0;
function feedback(type) {
  window.dispatchEvent(new CustomEvent('ascii-camera:gesture', { detail: { type } }));
  const [num, , word] = LABELS[type];
  toastEl.innerHTML = `<span class="toast__kicker">${num} — got it</span><span class="toast__word"><b>✦</b> ${word}</span>`;
  toastEl.classList.remove('is-on');
  void toastEl.offsetWidth;
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 1500);

  const card = document.querySelector(`.card[data-gesture="${type}"]`);
  if (card) {
    card.style.setProperty('--cooldown', COOLDOWN[type] + 'ms');
    card.classList.remove('is-cooling', 'is-hit');
    void card.offsetWidth;
    card.classList.add('is-cooling', 'is-hit');
    clearTimeout(card._t);
    card._t = setTimeout(() => card.classList.remove('is-hit'), 1400);
  }
  if (hintEl.classList.contains('is-on') && state.visionState === 'ready') hideHint();
}

// previews from the cards and number keys, placed where a hand would be
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
  if (name === 'requesting') spin();
}

let spinTimer = 0;
function spin() {
  const frames = ['.    ', '. o  ', '. o O', '  o O', '    O', '  o O', '. o  '];
  const el = overlay.querySelector('[data-for="requesting"] .spinner');
  let i = 0;
  clearInterval(spinTimer);
  spinTimer = setInterval(() => {
    if (overlay.dataset.state !== 'requesting') return clearInterval(spinTimer);
    el.textContent = frames[i++ % frames.length];
  }, 150);
}

function updateStatus(aux) {
  let s, text;
  if (state.mode === 'demo') {
    s = 'demo';
    text = 'DEMO MODE';
    aux = aux ?? '· press 1–6';
  } else if (state.mode !== 'camera') {
    s = 'idle';
    text = 'MOTION SENSOR STANDING BY';
  } else if (state.visionState === 'ready') {
    s = 'active';
    text = 'MOTION SENSOR ACTIVE';
  } else if (state.visionState === 'loading') {
    s = 'loading';
    text = 'MOTION SENSOR WARMING UP';
  } else {
    s = 'offline';
    text = 'MOTION SENSOR OFFLINE';
    aux = aux ?? '· portrait only';
  }
  statusEl.dataset.state = s;
  if (statusText.textContent !== text) statusText.textContent = text;
  const a = aux || '';
  if (statusAux.textContent !== a) statusAux.textContent = a;
}

function showHint(text, ms) {
  hintEl.textContent = text;
  hintEl.classList.add('is-on');
  clearTimeout(state.hintTimer);
  if (ms) state.hintTimer = setTimeout(hideHint, ms);
}
function hideHint() {
  hintEl.classList.remove('is-on');
}

// ───────────────────────────────────────── main loop

let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;
  if (!state.W) return;

  const t = now / 1000;
  let fresh = false;

  if (state.mode === 'camera' && video.readyState >= 2 && video.videoWidth) {
    if (video.currentTime !== state.lastVideoTime) {
      state.lastVideoTime = video.currentTime;
      fresh = true;
      state.frameNo++;
      if (state.visionState === 'ready') {
        const t0 = performance.now();
        if (state.frameNo % state.segEvery === 0) runSegmenter();
        state.hands = runHands();
        // if the machine struggles, segment every other frame
        const cost = performance.now() - t0;
        state.segEvery = cost > 26 ? 2 : cost < 14 ? 1 : state.segEvery;
      }
      field.ingest(drawCamera, state.mask);
    }
  } else {
    demo.step(t);
    field.ingest(drawDemo, demo.maskFor(state.W / state.H));
    fresh = true;
  }

  // gestures
  if (state.mode === 'camera' && fresh && state.visionState === 'ready') {
    const out = engine.update(state.hands, now, settings.sensitivity, settings.effects);
    state.waving = out.waving;
    state.moving = out.moving;
    for (const ev of out.events) playEffect(ev);
    updateStatus(engine.anyCooling(now) ? '· cooling down' : state.hands.length ? `· ${state.hands.length} hand${state.hands.length > 1 ? 's' : ''}` : '');
  } else if (state.mode === 'camera' && state.visionState !== 'ready') {
    state.waving = [];
    state.moving = [];
  }

  // hands stir the portrait; waving hands shed stars
  for (const h of state.moving) {
    field.stir(h.x, h.y, h.size * 1.3, h.vx, h.vy, dt * 1.6);
  }
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

  // paint
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, state.W, state.H);
  field.draw(ctx, atlas, style, t);
  effects.draw(ctx, PAPER);

  // tiny annotation: grid size and frame rate
  state.fpsAcc += dt;
  state.fpsN++;
  if (state.fpsAcc > 0.5) {
    state.fps = Math.round(state.fpsN / state.fpsAcc);
    state.fpsAcc = 0;
    state.fpsN = 0;
    dimsEl.textContent = `${field.cols} × ${field.rows} ch · ${state.fps} fps`;
  }
}

// ───────────────────────────────────────── controls

function syncControls() {
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.setAttribute('aria-checked', String(settings.charset === chip.dataset.set));
    chip.tabIndex = settings.charset === chip.dataset.set || (settings.charset === 'custom' && chip.dataset.set === 'mixed') ? 0 : -1;
  });
  $('#customText').value = settings.custom;
  $('.custom').classList.toggle('is-active', settings.charset === 'custom');
  $('#density').value = settings.density;
  $('#sensitivity').value = settings.sensitivity;
  document.querySelectorAll('[data-effect]').forEach((el) => {
    el.checked = !!settings.effects[el.dataset.effect];
  });
  document.querySelectorAll('.card').forEach((card) => {
    card.classList.toggle('is-off', !settings.effects[card.dataset.gesture]);
  });
}

const chipEls = [...document.querySelectorAll('.chip')];
chipEls.forEach((chip, i) => {
  chip.addEventListener('click', () => {
    settings.charset = chip.dataset.set;
    buildStyle();
    syncControls();
    saveSettings();
  });
  chip.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = chipEls[(i + d + chipEls.length) % chipEls.length];
    next.focus();
    next.click();
  });
});

let lastPreset = settings.charset === 'custom' ? 'mixed' : settings.charset;
$('#customText').addEventListener('input', (e) => {
  settings.custom = e.target.value;
  if (settings.custom.trim()) {
    if (settings.charset !== 'custom') lastPreset = settings.charset;
    settings.charset = 'custom';
  } else if (settings.charset === 'custom') {
    settings.charset = lastPreset;
  }
  buildStyle();
  syncControls();
  saveSettings();
});
$('#customText').addEventListener('focus', () => {
  if (settings.custom.trim() && settings.charset !== 'custom') {
    lastPreset = settings.charset;
    settings.charset = 'custom';
    buildStyle();
    syncControls();
  }
});

$('#density').addEventListener('input', (e) => {
  settings.density = +e.target.value;
  field.resize(state.W, state.H, settings.density);
  saveSettings();
});
$('#sensitivity').addEventListener('input', (e) => {
  settings.sensitivity = +e.target.value;
  saveSettings();
});
document.querySelectorAll('[data-effect]').forEach((el) => {
  el.addEventListener('change', () => {
    settings.effects[el.dataset.effect] = el.checked;
    syncControls();
    saveSettings();
  });
});

document.querySelectorAll('.card').forEach((card) => {
  card.addEventListener('click', () => {
    preview(card.dataset.gesture);
    if (window.matchMedia('(max-width: 980px)').matches) stageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
});

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
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
    showHint('no camera? no problem — tap a card or press 1–6', 5000);
  }
});

$('#snapBtn').addEventListener('click', () => {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ascii-camera-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
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

  // re-rasterise glyphs once the web fonts arrive
  try {
    await Promise.race([
      Promise.all([document.fonts.load('64px "IBM Plex Mono"'), document.fonts.load('64px "Instrument Serif"')]),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
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
