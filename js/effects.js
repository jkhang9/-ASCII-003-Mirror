// Character particles that live inside the portrait's grid. Each particle
// moves with a little physics, but it is never painted freely on top of the
// mirror: every frame it lights up the cell it is over, swapping that cell's
// glyph for its own. Intensity follows a strict hierarchy: wave (ambient)
// < thumbs / peace (small) < hearts (medium) < celebration (large)
// < fireworks (biggest).

import { INK, SOFT, ACCENT } from './palette.js';

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const MAX = 1600;

const STARS = ['*', '+', '.', 'x', '*'];
const FIRE = ['*', '+', 'x', '.', 'o'];
const SPARK = ['+', '*', '.', "'"];
const HEARTS = ['♥', '♥', '*', '+', '.'];

export class Effects {
  constructor(atlas) {
    this.atlas = atlas;
    this.ps = [];
    this.unit = 1; // scales distances and speeds with the stage
    this.body = null;
    this.field = null;
  }

  setScale(width, height) {
    this.unit = Math.max(0.55, Math.min(1.6, Math.min(width, height) / 720));
  }

  add(p) {
    const q = {
      x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, drag: 1.2,
      age: 0, life: 1.5, delay: 0,
      ch: '*', color: INK, alpha: 1, r: 0,
      twinkle: 0, phase: Math.random() * TAU, sway: 0,
      trail: null, mode: 'free',
      ...p,
    };
    q.g = this.atlas.get(q.ch, q.color);
    if (q.trail) q.tg = this.atlas.get('.', q.color);
    if (this.ps.length >= MAX) this.ps.shift();
    this.ps.push(q);
    return q;
  }

  clear() {
    this.ps.length = 0;
  }

  get count() {
    return this.ps.length;
  }

  // random point on/near the subject's outline, for things that settle "around the body"
  bodyPoint(spread = 0) {
    const b = this.body, f = this.field;
    if (b && b.present && b.edges.length) {
      const p = f.cellPos(pick(b.edges));
      return { x: p.x + rand(-spread, spread), y: p.y + rand(-spread, spread) };
    }
    const a = Math.random() * TAU;
    return { x: b.cx + Math.cos(a) * b.rx, y: b.cy + Math.sin(a) * b.ry };
  }

  // ─────────────────────────────── 01 wave → sparkles (ambient)
  waveTrail(hand, dt) {
    const u = this.unit;
    const rate = 38; // particles / second
    let n = rate * dt;
    while (n > 0) {
      if (Math.random() > n) break;
      n -= 1;
      const r = hand.size * 0.55;
      const a = Math.random() * TAU;
      const toBody = Math.random() < 0.35;
      const p = {
        x: hand.x + Math.cos(a) * r * Math.random(),
        y: hand.y + Math.sin(a) * r * Math.random(),
        vx: hand.vx * 0.12 + rand(-30, 30) * u,
        vy: hand.vy * 0.12 + rand(-40, 10) * u,
        ay: -6 * u,
        drag: 1.4,
        life: rand(1.6, 3.2),
        ch: pick(STARS),
        color: Math.random() < 0.08 ? ACCENT : Math.random() < 0.35 ? SOFT : INK,
        twinkle: rand(5, 9),
        sway: rand(4, 12) * u,
      };
      if (toBody) {
        const t = this.bodyPoint(18 * u);
        p.mode = 'seek';
        p.tx = t.x;
        p.ty = t.y;
        p.life = rand(2.4, 3.6);
      }
      this.add(p);
    }
  }

  // ─────────────────────────────── 02 fist → open → fireworks (biggest)
  fireworks(x, y) {
    const u = this.unit;
    // the flash at the origin fills a small patch of cells
    this.add({ x, y, ch: '#', r: 40 * u, life: 0.45, drag: 0, color: ACCENT });

    // shockwave ring of dots
    const ring = 42;
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * TAU;
      const sp = 620 * u;
      this.add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 4.2, life: 0.75, ch: '.', color: SOFT });
    }

    // the main burst: fast out, slow drift, gentle fall
    const n = 150;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = Math.pow(Math.random(), 0.6) * 950 * u + 120 * u;
      this.add({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        ay: 70 * u,
        drag: rand(2.6, 3.4),
        life: rand(1.3, 2.5),
        ch: pick(FIRE),
        color: Math.random() < 0.18 ? ACCENT : INK,
        twinkle: Math.random() < 0.4 ? rand(8, 16) : 0,
        trail: Math.random() < 0.45 ? [] : null,
        crackle: Math.random() < 0.18,
      });
    }

    // a second, lazier ring for depth
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU + 0.13;
      const sp = 300 * u;
      this.add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, ay: 40 * u, drag: 2.2, life: 2.2, delay: 0.12, ch: '*', twinkle: 10 });
    }

    this.field?.impulse(x, y, 320 * u, 520);
  }

  // ─────────────────────────────── 03 thumbs up → spark (small)
  spark(x, y, scale = 1) {
    const u = this.unit * scale;
    const n = 16;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + rand(-1.5, 1.5);
      const sp = rand(60, 190) * u;
      this.add({
        x: x + rand(-6, 6) * u, y: y + rand(-6, 6) * u,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        ay: -10 * u, drag: 3,
        life: rand(0.8, 1.35),
        ch: pick(SPARK),
        color: Math.random() < 0.2 ? ACCENT : INK,
        twinkle: rand(8, 14),
      });
    }
    this.add({ x, y: y - 8 * u, ch: '+', r: 16 * u, life: 0.4, drag: 0, color: ACCENT });
    this.field?.impulse(x, y, 90 * u, 90);
  }

  // ─────────────────────────────── 04 two thumbs up → celebration (large)
  celebrate(a, b) {
    const u = this.unit;
    this.spark(a.x, a.y, 1.2);
    this.spark(b.x, b.y, 1.2);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const body = this.body, f = this.field;

    // sparkles bloom across the portrait, rippling out from between the hands
    const cells = body.present ? body.cells.concat(body.edges) : [];
    const n = 130;
    for (let i = 0; i < n; i++) {
      let x, y;
      if (cells.length) {
        const p = f.cellPos(pick(cells));
        x = p.x; y = p.y;
      } else {
        const ang = Math.random() * TAU, rr = Math.sqrt(Math.random());
        x = body.cx + Math.cos(ang) * body.rx * rr;
        y = body.cy + Math.sin(ang) * body.ry * rr;
      }
      const d = Math.hypot(x - mx, y - my);
      this.add({
        x, y,
        vx: rand(-14, 14) * u, vy: rand(-36, -8) * u,
        drag: 0.6,
        delay: d / (900 * u),
        life: rand(1.1, 2),
        ch: pick(['*', '+', 'x', '.', ':']),
        color: Math.random() < 0.14 ? ACCENT : INK,
        twinkle: rand(6, 12),
      });
    }

    // a halo: characters on an ellipse around the head and shoulders, turning slowly
    const hx = body.cx, hy = body.top + Math.min(body.ry * 0.5, 160 * u);
    const rx = Math.max(body.rx * 1.05, 150 * u), ry = Math.max(body.ry * 0.62, 150 * u);
    const m = 56;
    for (let i = 0; i < m; i++) {
      const ang = (i / m) * TAU;
      this.add({
        mode: 'orbit',
        cx: hx, cy: hy, rx, ry,
        ang, w: 0.55, orbitFor: rand(1.4, 2),
        grow: 0.08,
        delay: 0.15 + (i / m) * 0.35,
        life: rand(2.4, 3),
        ch: i % 4 === 0 ? '*' : i % 4 === 2 ? '+' : '.',
        color: i % 7 === 0 ? ACCENT : INK,
        twinkle: 7,
        drag: 1,
      });
    }
    // a soft ripple through the portrait itself
    this.field?.impulse(mx, my, 420 * u, 180);
  }

  // ─────────────────────────────── 05 peace → star burst (small)
  peace(base, tipA, tipB) {
    const u = this.unit;
    const trace = (tip, off) => {
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = base.x + (tip.x - base.x) * t;
        const y = base.y + (tip.y - base.y) * t;
        const ang = Math.atan2(tip.y - base.y, tip.x - base.x) + rand(-0.6, 0.6);
        const sp = rand(40, 120) * u;
        this.add({
          mode: 'hold', holdFor: 0.22 + (1 - t) * 0.08,
          x, y,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 20 * u,
          drag: 2.2, life: rand(0.9, 1.3),
          delay: off + t * 0.12,
          ch: i === steps ? '*' : i % 2 ? '.' : '+',
          color: i === steps && Math.random() < 0.5 ? ACCENT : INK,
        });
      }
      // a little pop at the fingertip
      for (let k = 0; k < 7; k++) {
        const ang = Math.random() * TAU;
        const sp = rand(80, 200) * u;
        this.add({
          x: tip.x, y: tip.y,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
          drag: 3.2, life: rand(0.6, 1),
          delay: off + 0.16,
          ch: pick(['*', '+', '.', 'x']),
          twinkle: 12,
        });
      }
    };
    trace(tipA, 0);
    trace(tipB, 0.04);
  }

  // ─────────────────────────────── 06 heart hands → hearts (medium)
  hearts(x, y) {
    const u = this.unit;
    // a heart outline traced through the grid, which then blooms outward
    const pts = 34;
    for (let i = 0; i < pts; i++) {
      const t = (i / pts) * TAU;
      const hx = 16 * Math.pow(Math.sin(t), 3);
      const hy = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
      const s = 4.6 * u;
      this.add({
        mode: 'hold', holdFor: 0.6,
        x: x + hx * s, y: y + hy * s,
        vx: hx * 9 * u, vy: hy * 9 * u - 30 * u,
        drag: 1.6, life: 1.9,
        delay: (i / pts) * 0.25,
        ch: i % 3 === 0 ? '♥' : i % 3 === 1 ? '.' : '+',
        color: i % 3 === 0 ? ACCENT : INK,
      });
    }

    // hearts rising out of the hand-heart over about a second
    for (let i = 0; i < 26; i++) {
      const ch = pick(HEARTS);
      this.add({
        x: x + rand(-10, 10) * u, y: y + rand(-8, 8) * u,
        vx: rand(-70, 70) * u, vy: rand(-170, -60) * u,
        ay: -8 * u, drag: 1.4,
        delay: 0.2 + Math.random() * 0.9,
        life: rand(1.6, 2.6),
        ch,
        color: ch === '♥' && Math.random() < 0.6 ? ACCENT : INK,
        sway: rand(14, 30) * u,
      });
    }

    // a few orbit the subject once before drifting off
    const b = this.body;
    for (let i = 0; i < 12; i++) {
      this.add({
        mode: 'orbit',
        cx: b.cx, cy: b.cy - b.ry * 0.2,
        rx: b.rx * 1.15 + 40 * u, ry: b.ry * 0.85 + 30 * u,
        ang: Math.atan2(y - b.cy, x - b.cx) + (i / 12) * 0.9,
        w: 1.6 + Math.random() * 0.5,
        orbitFor: rand(1.4, 2.2),
        grow: 0.05,
        delay: 0.35 + i * 0.07,
        life: rand(2.6, 3.4),
        ch: '♥',
        color: i % 3 === 0 ? ACCENT : INK,
        drag: 1.2,
      });
    }
    this.field?.impulse(x, y, 150 * u, 160);
  }

  update(dt) {
    const ps = this.ps;
    const b = this.body;
    const born = [];
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.delay > 0) {
        p.delay -= dt;
        ps[w++] = p;
        continue;
      }
      p.age += dt;
      if (p.age >= p.life) {
        if (p.crackle) {
          for (let k = 0; k < 3; k++) {
            const a = Math.random() * TAU, sp = rand(30, 90) * this.unit;
            born.push({ x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 3, life: rand(0.3, 0.6), ch: '.', color: p.color, twinkle: 20 });
          }
        }
        continue;
      }

      if (p.mode === 'hold') {
        if (p.age >= p.holdFor) p.mode = 'free';
      } else if (p.mode === 'seek') {
        // ease toward a point on the outline, then hover and twinkle there
        const k = 2.2;
        p.vx += ((p.tx - p.x) * k - p.vx * 1.8) * dt;
        p.vy += ((p.ty - p.y) * k - p.vy * 1.8) * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      } else if (p.mode === 'orbit') {
        if (b && b.present) {
          p.cx += (b.cx - p.cx) * 0.04;
        }
        p.ang += p.w * dt;
        const g = 1 + p.grow * p.age;
        const nx = p.cx + Math.cos(p.ang) * p.rx * g;
        const ny = p.cy + Math.sin(p.ang) * p.ry * g;
        if (p.placed) {
          p.vx = (nx - p.x) / Math.max(dt, 1e-3);
          p.vy = (ny - p.y) / Math.max(dt, 1e-3);
        }
        p.placed = true;
        p.x = nx;
        p.y = ny;
        if (p.age >= p.orbitFor) {
          p.mode = 'free';
          p.vx *= 0.7;
          p.vy *= 0.7;
        }
      }

      if (p.mode === 'free') {
        p.vx += p.ax * dt;
        p.vy += p.ay * dt;
        const d = Math.exp(-p.drag * dt);
        p.vx *= d;
        p.vy *= d;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.sway) p.x += Math.sin(p.age * 3 + p.phase) * p.sway * dt;
      }

      if (p.trail) {
        p.trail.push(p.x, p.y);
        if (p.trail.length > 10) p.trail.splice(0, 2);
      }
      ps[w++] = p;
    }
    ps.length = w;
    for (const p of born) this.add(p);
  }

  // Write every live particle into the field's effect layer: the cell under
  // it takes the particle's glyph, and the strongest particle wins the cell.
  rasterize(field) {
    const { cols, rows, cellW, cellH, fxA, fxG } = field;
    fxA.fill(0);
    const put = (x, y, g, a) => {
      if (x < 0 || y < 0) return;
      const c = (x / cellW) | 0, r = (y / cellH) | 0;
      if (c >= cols || r >= rows) return;
      const i = r * cols + c;
      if (a > fxA[i]) {
        fxA[i] = a;
        fxG[i] = g;
      }
    };
    for (const p of this.ps) {
      if (p.delay > 0) continue;
      const t = p.age / p.life;
      let a = p.alpha;
      a *= Math.min(1, p.age / 0.08); // fade in
      if (t > 0.55) a *= 1 - (t - 0.55) / 0.45; // fade out
      if (p.twinkle) a *= 0.62 + 0.38 * Math.sin(p.age * p.twinkle + p.phase);
      if (a <= 0.03) continue;

      if (p.r) {
        // a patch of cells, strongest at the centre
        const c0 = Math.floor((p.x - p.r) / cellW), c1 = Math.floor((p.x + p.r) / cellW);
        const r0 = Math.floor((p.y - p.r) / cellH), r1 = Math.floor((p.y + p.r) / cellH);
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            const x = (c + 0.5) * cellW, y = (r + 0.5) * cellH;
            const d = Math.hypot(x - p.x, y - p.y);
            if (d < p.r) put(x, y, p.g, a * (1 - (d / p.r) * 0.6));
          }
        }
      } else {
        put(p.x, p.y, p.g, a);
      }

      if (p.trail && p.trail.length >= 4) {
        const tr = p.trail;
        for (let k = 0; k < tr.length - 2; k += 2) {
          const f = (k / 2 + 1) / (tr.length / 2);
          put(tr[k], tr[k + 1], p.tg, a * 0.45 * f);
        }
      }
    }
  }
}
