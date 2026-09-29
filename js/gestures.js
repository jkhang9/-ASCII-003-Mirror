// Hand pose classification and the gesture state machines.
//
// Poses are read from MediaPipe's world landmarks (metric, hand-centred 3D),
// which makes finger curl independent of how far away or rotated the hand is.
// Positions and directions come from the image landmarks, already mapped to
// stage pixels by the caller.

const DEG = 180 / Math.PI;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

const FINGERS = {
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

function vec(a, b) {
  return [b.x - a.x, b.y - a.y, (b.z || 0) - (a.z || 0)];
}
function len(v) {
  return Math.hypot(v[0], v[1], v[2]);
}
function angle(u, v) {
  const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (len(u) * len(v) || 1);
  return Math.acos(Math.max(-1, Math.min(1, d))) * DEG;
}
function dist(a, b) {
  return len(vec(a, b));
}

// 1 = straight finger, 0 = fully curled
function fingerExtension(w, [m, p, d, t]) {
  const flexMcp = angle(vec(w[0], w[m]), vec(w[m], w[p]));
  const flexPip = angle(vec(w[m], w[p]), vec(w[p], w[d]));
  const flexDip = angle(vec(w[p], w[d]), vec(w[d], w[t]));
  const bend = flexPip + flexDip + flexMcp * 0.6;
  return 1 - clamp01((bend - 55) / 80);
}

// Calibrated on MediaPipe sample photos: an extended thumb is nearly straight
// (MCP + IP bend ≈ 30–40°) and its tip reaches ~0.8–0.9 palm-lengths from the
// middle knuckle; a tucked thumb bends 85–110° and stays within ~0.5.
function thumbExtension(w) {
  const bend = angle(vec(w[1], w[2]), vec(w[2], w[3])) + angle(vec(w[2], w[3]), vec(w[3], w[4]));
  const straight = 1 - clamp01((bend - 45) / 45);
  const palm = dist(w[0], w[9]) || 1;
  const reach = clamp01((dist(w[4], w[9]) / palm - 0.55) / 0.3);
  return 0.5 * straight + 0.5 * reach;
}

// world: 21 world landmarks; img: 21 {x,y} points in stage pixels
export function classifyHand(world, img) {
  const ext = {
    thumb: thumbExtension(world),
    index: fingerExtension(world, FINGERS.index),
    middle: fingerExtension(world, FINGERS.middle),
    ring: fingerExtension(world, FINGERS.ring),
    pinky: fingerExtension(world, FINGERS.pinky),
  };
  const up = (k) => ext[k] > 0.6;
  const down = (k) => ext[k] < 0.4;

  // thumb direction on screen
  const tx = img[4].x - img[2].x, ty = img[4].y - img[2].y;
  const tl = Math.hypot(tx, ty) || 1;
  const thumbUpness = -ty / tl; // 1 = straight up

  const fourDown = down('index') && down('middle') && down('ring') && down('pinky');
  const fingersOut = ['index', 'middle', 'ring', 'pinky'].filter(up).length;

  // V spread: fingertips further apart than the knuckles they grow from
  const spread = dist(world[8], world[12]) / (dist(world[5], world[9]) || 1);

  let pose = 'other';
  if (fourDown && ext.thumb > 0.55 && thumbUpness > 0.6) pose = 'thumbsUp';
  else if (fourDown) pose = 'fist';
  else if (fingersOut === 4) pose = 'open';
  else if (up('index') && up('middle') && down('ring') && down('pinky') && spread > 1.15) pose = 'peace';

  return { pose, ext, fingersOut, thumbUpness, spread };
}

export const COOLDOWN = {
  wave: 1800,
  fireworks: 650,
  thumbsUp: 1200,
  doubleThumbs: 2600,
  peace: 1200,
  heart: 2400,
};

export class GestureEngine {
  constructor() {
    this.hands = new Map();
    this.coolUntil = {};
    this.double = false;
    this.heart = { since: 0, lastOk: 0, fired: false };
  }

  cooling(type, now) {
    return (this.coolUntil[type] || 0) > now;
  }

  anyCooling(now) {
    for (const k in this.coolUntil) if (this.coolUntil[k] > now) return true;
    return false;
  }

  // hands: [{key, pose, palm:{x,y}, size, pts:[21 {x,y}]}] in stage px
  update(hands, now, sensitivity, enabled) {
    const s = clamp01(sensitivity);
    const hold = lerp(300, 110, s);
    const fistHold = lerp(170, 70, s);
    const openWindow = lerp(320, 700, s);
    const waveAmp = lerp(0.9, 0.38, s); // in hand-sizes
    const swingsNeeded = s > 0.66 ? 2 : 3;

    this.tick = (this.tick || 0) + 1;
    const events = [];
    const fire = (type, data) => {
      if (!enabled[type] || this.cooling(type, now)) return false;
      this.coolUntil[type] = now + COOLDOWN[type];
      events.push({ type, ...data });
      return true;
    };

    // ── per-hand bookkeeping
    const seen = new Set();
    const live = [];
    for (const hand of hands) {
      seen.add(hand.key);
      let h = this.hands.get(hand.key);
      if (!h) {
        h = { pose: hand.pose, since: now, cand: null, candN: 0, fistAt: 0, xs: [], waveUntil: 0, waving: false, firedSince: -1, x: hand.palm.x, y: hand.palm.y, vx: 0, vy: 0, t: now };
        this.hands.set(hand.key, h);
      }
      // velocity (px/s), smoothed
      const dt = Math.max(1, now - h.t) / 1000;
      const nvx = (hand.palm.x - h.x) / dt, nvy = (hand.palm.y - h.y) / dt;
      h.vx += (nvx - h.vx) * 0.5;
      h.vy += (nvy - h.vy) * 0.5;
      h.x = hand.palm.x;
      h.y = hand.palm.y;
      h.t = now;
      h.data = hand;

      // two-frame debounce on pose changes
      if (hand.pose === h.pose) {
        h.cand = null;
        h.candN = 0;
      } else if (hand.pose === h.cand) {
        if (++h.candN >= 2) {
          h.pose = hand.pose;
          h.since = now;
          h.cand = null;
        }
      } else {
        h.cand = hand.pose;
        h.candN = 1;
      }
      h.held = now - h.since;
      live.push(h);
    }
    for (const [k, h] of this.hands) if (!seen.has(k) && now - h.t > 500) this.hands.delete(k);

    const firedThisPose = (h) => h.firedSince === h.since;
    const markFired = (h) => { h.firedSince = h.since; };

    // ── wave: an open hand swinging side to side
    for (const h of live) {
      const handy = h.data.fingersOut >= 3;
      if (handy) h.xs.push({ t: now, x: h.x / h.data.size });
      while (h.xs.length && now - h.xs[0].t > 1100) h.xs.shift();
      if (!handy) h.xs.length = Math.max(0, h.xs.length - 2);
      let swings = 0;
      if (h.xs.length > 4) {
        let dir = 0, lo = h.xs[0].x, hi = lo, peak = lo;
        for (const { x } of h.xs) {
          if (dir === 0) {
            if (x < lo) lo = x;
            if (x > hi) hi = x;
            if (x - lo > waveAmp) { dir = 1; peak = x; swings = 1; }
            else if (hi - x > waveAmp) { dir = -1; peak = x; swings = 1; }
          } else if (dir > 0) {
            if (x > peak) peak = x;
            else if (peak - x > waveAmp) { dir = -1; peak = x; swings++; }
          } else {
            if (x < peak) peak = x;
            else if (x - peak > waveAmp) { dir = 1; peak = x; swings++; }
          }
        }
      }
      if (swings >= swingsNeeded) {
        if (!h.waving && enabled.wave) fire('wave', { x: h.x, y: h.y });
        h.waveUntil = now + 450;
      }
      h.waving = enabled.wave && h.waveUntil > now;
    }

    // ── fist → quickly open = fireworks
    for (const h of live) {
      if (h.pose === 'fist' && h.held >= fistHold) {
        h.fistAt = now;
        h.fistTick = this.tick;
      }
      // "quickly" is judged in time, but a slow machine gets a few frames' grace
      const quick = h.fistAt && (now - h.fistAt <= openWindow || this.tick - h.fistTick <= 4);
      if (h.pose === 'open' && quick && !h.waving) {
        fire('fireworks', { x: h.x, y: h.y, size: h.data.size });
        h.fistAt = 0;
      }
      if (h.fistAt && !quick) h.fistAt = 0;
    }

    // ── thumbs: two beats one
    const ups = live.filter((h) => h.pose === 'thumbsUp' && h.held >= hold);
    if (ups.length >= 2) {
      if (!this.double) {
        const [a, b] = ups;
        fire('doubleThumbs', {
          a: { x: a.data.pts[4].x, y: a.data.pts[4].y },
          b: { x: b.data.pts[4].x, y: b.data.pts[4].y },
          size: (a.data.size + b.data.size) / 2,
        });
        this.double = true;
        ups.forEach(markFired);
        this.coolUntil.thumbsUp = Math.max(this.coolUntil.thumbsUp || 0, now + COOLDOWN.thumbsUp);
      }
    } else {
      this.double = false;
      for (const h of ups) {
        const otherRising = live.some((o) => o !== h && (o.pose === 'thumbsUp' || o.cand === 'thumbsUp'));
        if (!firedThisPose(h) && h.held >= hold + 220 && !otherRising) {
          if (fire('thumbsUp', { x: h.data.pts[4].x, y: h.data.pts[4].y, size: h.data.size })) markFired(h);
        }
      }
    }

    // ── peace sign
    for (const h of live) {
      if (h.pose === 'peace' && h.held >= hold && !firedThisPose(h)) {
        const p = h.data.pts;
        const ok = fire('peace', {
          base: { x: (p[5].x + p[9].x) / 2, y: (p[5].y + p[9].y) / 2 },
          tipA: { x: p[8].x, y: p[8].y },
          tipB: { x: p[12].x, y: p[12].y },
          size: h.data.size,
        });
        if (ok) markFired(h);
      }
    }

    // ── heart hands: index tips touch on top, thumb tips touch below
    if (live.length >= 2) {
      const [a, b] = live;
      const pa = a.data.pts, pb = b.data.pts;
      const size = (a.data.size + b.data.size) / 2;
      const d = (u, v) => Math.hypot(u.x - v.x, u.y - v.y);
      const idx = Math.min(d(pa[8], pb[8]), d(pa[7], pb[7]) * 1.1);
      const thb = d(pa[4], pb[4]);
      const topY = (pa[8].y + pb[8].y) / 2, botY = (pa[4].y + pb[4].y) / 2;
      const tol = lerp(0.5, 0.8, s) * size;
      const ok = idx < tol && thb < tol * 1.1 && botY - topY > size * 0.35;
      if (ok) {
        if (!this.heart.lastOk || now - this.heart.lastOk > 180) this.heart.since = now;
        this.heart.lastOk = now;
        if (!this.heart.fired && now - this.heart.since >= hold) {
          fire('heart', { x: (pa[8].x + pb[8].x + pa[4].x + pb[4].x) / 4, y: (topY + botY) / 2, size });
          this.heart.fired = true;
        }
      } else if (now - this.heart.lastOk > 180) {
        this.heart.fired = false;
      }
    } else if (now - this.heart.lastOk > 180) {
      this.heart.fired = false;
    }

    const waving = live.filter((h) => h.waving).map((h) => ({ x: h.x, y: h.y, vx: h.vx, vy: h.vy, size: h.data.size }));
    const moving = live.map((h) => ({ x: h.x, y: h.y, vx: h.vx, vy: h.vy, size: h.data.size }));
    return { events, waving, moving };
  }
}
