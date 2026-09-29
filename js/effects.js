import { INVERT } from './ascii.js?v=20260929034603';

// Character particles that live inside the portrait's grid. Each particle
// moves with a little physics, but it is never painted on top of the mirror:
// every frame it takes over the cell it is in, swapping that cell's glyph for
// its own, and fades the portrait's cells right around it so it reads clearly.
// Hearts are heart-shaped windows in which the portrait's tone is inverted. Everything is drawn in the
// canvas ink colour; `tone` only makes a particle lighter or heavier.

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const MAX = 2400;

const STARS = ['*', '+', 'x', '.', '*', 'o'];
const FIRE = ['*', '+', 'x', '.', 'o', '#'];
const SPARK = ['+', '*', 'x', "'", '.'];

// implicit heart: ≤ 0 inside. u right, v up, both in units of the heart's radius.
const heartF = (u, v) => {
  const a = u * u + v * v - 1;
  return a * a * a - u * u * v * v * v;
};

export class Effects {
  constructor() {
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
      ch: '*', tone: 1, shape: null, r: 0,
      twinkle: 0, phase: Math.random() * TAU, sway: 0,
      trail: null, mode: 'free',
      ...p,
    };
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

  // a starburst: characters thrown out in every direction, some with trails
  burst(x, y, n, speed, opts = {}) {
    const u = this.unit;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = (Math.pow(Math.random(), 0.6) * speed + speed * 0.13) * u;
      this.add({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        ay: 70 * u,
        drag: rand(2.6, 3.4),
        life: rand(1.2, 2.3),
        delay: opts.delay || 0,
        ch: pick(opts.chars || FIRE),
        tone: Math.random() < 0.3 ? 0.6 : 1,
        twinkle: Math.random() < 0.4 ? rand(8, 16) : 0,
        trail: Math.random() < 0.5 ? [] : null,
        crackle: Math.random() < (opts.crackle ?? 0.18),
      });
    }
  }

  // ─────────────────────────────── 01 wave → sparkles
  waveTrail(hand, dt) {
    const u = this.unit;
    const rate = 110; // particles / second
    let n = rate * dt;
    while (n > 0) {
      if (Math.random() > n) break;
      n -= 1;
      const r = hand.size * 0.6;
      const a = Math.random() * TAU;
      const toBody = Math.random() < 0.35;
      const p = {
        x: hand.x + Math.cos(a) * r * Math.random(),
        y: hand.y + Math.sin(a) * r * Math.random(),
        vx: hand.vx * 0.2 + rand(-60, 60) * u,
        vy: hand.vy * 0.2 + rand(-80, 20) * u,
        ay: -6 * u,
        drag: 1.4,
        life: rand(1.8, 3.4),
        ch: pick(STARS),
        tone: Math.random() < 0.35 ? 0.6 : 1,
        twinkle: rand(5, 9),
        sway: rand(4, 12) * u,
        trail: Math.random() < 0.3 ? [] : null,
      };
      if (toBody) {
        const t = this.bodyPoint(18 * u);
        p.mode = 'seek';
        p.tx = t.x;
        p.ty = t.y;
        p.life = rand(2.4, 3.6);
        p.trail = null;
      }
      this.add(p);
    }
  }

  // ─────────────────────────────── 02 fist → open → fireworks
  fireworks(x, y) {
    this.burst(x, y, 170, 950);
    this.field?.impulse(x, y, 320 * this.unit, 520);
  }

  // ─────────────────────────────── 03 thumbs up → spark fountain
  spark(x, y, scale = 1) {
    const u = this.unit * scale;
    // a fountain thrown up from the thumb that falls back down
    for (let i = 0; i < 110; i++) {
      const a = -Math.PI / 2 + rand(-0.6, 0.6);
      const sp = rand(260, 640) * u;
      this.add({
        x: x + rand(-6, 6) * u, y: y + rand(-6, 6) * u,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        ay: 520 * u, drag: 1.2,
        life: rand(1.1, 1.9),
        delay: Math.random() * 0.25,
        ch: pick(SPARK),
        tone: Math.random() < 0.3 ? 0.6 : 1,
        twinkle: rand(8, 14),
        trail: Math.random() < 0.5 ? [] : null,
      });
    }
    this.burst(x, y - 10 * u, 18, 320, { chars: ['+', '*'], crackle: 0 });
    this.field?.impulse(x, y, 180 * u, 260);
  }

  // ─────────────────────────────── 04 two thumbs up → celebration
  celebrate(a, b) {
    const u = this.unit;
    this.spark(a.x, a.y, 1.2);
    this.spark(b.x, b.y, 1.2);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const body = this.body, f = this.field;

    // sparkles bloom across the portrait, rippling out from between the hands
    const cells = body.present ? body.cells.concat(body.edges) : [];
    for (let i = 0; i < 260; i++) {
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
        vx: rand(-20, 20) * u, vy: rand(-60, -10) * u,
        drag: 0.6,
        delay: d / (900 * u),
        life: rand(1.3, 2.3),
        ch: pick(['*', '+', 'x', 'o', '#']),
        twinkle: rand(6, 12),
      });
    }

    // a halo of characters around the head and shoulders, turning slowly
    const hx = body.cx, hy = body.top + Math.min(body.ry * 0.5, 160 * u);
    const rx = Math.max(body.rx * 1.05, 150 * u), ry = Math.max(body.ry * 0.62, 150 * u);
    const m = 90;
    for (let i = 0; i < m; i++) {
      this.add({
        mode: 'orbit',
        cx: hx, cy: hy, rx, ry,
        ang: (i / m) * TAU, w: 0.55, orbitFor: rand(1.6, 2.2),
        grow: 0.08,
        delay: 0.15 + (i / m) * 0.35,
        life: rand(2.6, 3.2),
        ch: i % 3 === 0 ? '*' : i % 3 === 1 ? '+' : 'o',
        twinkle: 7,
        drag: 1,
      });
    }
    this.field?.impulse(mx, my, 420 * u, 260);
  }

  // ─────────────────────────────── 05 peace → star bursts at the fingertips
  peace(base, tipA, tipB) {
    const u = this.unit;
    const trace = (tip, off) => {
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        this.add({
          mode: 'hold', holdFor: 0.35,
          x: base.x + (tip.x - base.x) * t,
          y: base.y + (tip.y - base.y) * t,
          vx: rand(-40, 40) * u, vy: rand(-60, -10) * u,
          drag: 2.2, life: rand(1, 1.4),
          delay: off + t * 0.15,
          ch: i % 2 ? '*' : '+',
        });
      }
      this.burst(tip.x, tip.y, 45, 480, { delay: off + 0.18, chars: ['*', '+', 'x', '.'], crackle: 0.1 });
      this.field?.impulse(tip.x, tip.y, 120 * u, 220);
    };
    trace(tipA, 0);
    trace(tipB, 0.06);
  }

  // ─────────────────────────────── 06 heart hands → hearts made of cells
  hearts(x, y) {
    const u = this.unit;
    // one big heart that pops in and beats
    this.add({ shape: 'heart', x, y, r: 135 * u, life: 2.6, drag: 0, beat: true });

    // smaller hearts rising out of it
    for (let i = 0; i < 7; i++) {
      this.add({
        shape: 'heart',
        x: x + rand(-40, 40) * u, y: y + rand(-20, 20) * u,
        vx: rand(-90, 90) * u, vy: rand(-230, -120) * u,
        ay: -10 * u, drag: 1.1,
        r: rand(30, 44) * u,
        delay: 0.3 + Math.random() * 0.9,
        life: rand(1.6, 2.4),
        sway: rand(20, 40) * u,
      });
    }

    // a few orbit the subject once before drifting off
    const b = this.body;
    for (let i = 0; i < 5; i++) {
      this.add({
        shape: 'heart',
        mode: 'orbit',
        cx: b.cx, cy: b.cy - b.ry * 0.2,
        rx: b.rx * 1.15 + 50 * u, ry: b.ry * 0.85 + 40 * u,
        ang: Math.atan2(y - b.cy, x - b.cx) + (i / 5) * 1.6,
        w: 1.5 + Math.random() * 0.4,
        orbitFor: rand(1.6, 2.2),
        grow: 0.04,
        r: rand(26, 34) * u,
        delay: 0.4 + i * 0.1,
        life: rand(2.6, 3.2),
        drag: 1.2,
      });
    }
    this.field?.impulse(x, y, 220 * u, 240);
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
            born.push({ x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 3, life: rand(0.3, 0.6), ch: '.', tone: p.tone, twinkle: 20 });
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
        if (p.trail.length > 12) p.trail.splice(0, 2);
      }
      ps[w++] = p;
    }
    ps.length = w;
    for (const p of born) this.add(p);
  }

  // Write every live particle into the field's effect layer. glyph(ch) gives
  // the sprite for a character in the current ink. A particle claims its cell
  // (the strongest wins) and knocks back the portrait in the cells around it.
  rasterize(field, glyph) {
    const { cols, rows, cellW, cellH, fxA, fxG, fxK } = field;
    fxA.fill(0);
    fxK.fill(0);
    const cellOf = (x, y) => {
      if (x < 0 || y < 0) return -1;
      const c = (x / cellW) | 0, r = (y / cellH) | 0;
      return c >= cols || r >= rows ? -1 : r * cols + c;
    };
    const claim = (i, g, a) => {
      if (i >= 0 && a > fxA[i]) {
        fxA[i] = a;
        fxG[i] = g;
      }
    };
    const knock = (i, a) => {
      if (i >= 0 && a > fxK[i]) fxK[i] = a;
    };
    const around = (i, a) => {
      if (i < 0) return;
      const c = i % cols;
      if (c > 0) knock(i - 1, a);
      if (c < cols - 1) knock(i + 1, a);
      if (i >= cols) knock(i - cols, a);
      if (i + cols < cols * rows) knock(i + cols, a);
    };

    for (const p of this.ps) {
      if (p.delay > 0) continue;
      const t = p.age / p.life;
      let a = Math.min(1, p.age / 0.08); // fade in
      if (t > 0.6) a *= 1 - (t - 0.6) / 0.4; // fade out
      if (p.twinkle) a *= 0.65 + 0.35 * Math.sin(p.age * p.twinkle + p.phase);
      a *= p.tone;
      if (a <= 0.03) continue;

      if (p.shape === 'heart') {
        this.heart(p, a, cellW, cellH, cellOf, claim, knock);
      } else {
        const i = cellOf(p.x, p.y);
        claim(i, glyph(p.ch), a);
        around(i, a * 0.85);
      }

      if (p.trail && p.trail.length >= 4) {
        const tr = p.trail;
        const dot = glyph('.');
        for (let k = 0; k < tr.length - 2; k += 2) {
          const f = (k / 2 + 1) / (tr.length / 2);
          claim(cellOf(tr[k], tr[k + 1]), dot, a * 0.55 * f);
        }
      }
    }
  }

  // invert the cells inside a heart, and clear a one-cell outline around it
  heart(p, a, cellW, cellH, cellOf, claim, knock) {
    let r = p.r;
    const pop = Math.min(1, p.age / 0.3);
    r *= 0.4 + 0.6 * (1 - (1 - pop) * (1 - pop));
    if (p.beat) r *= 1 + 0.1 * Math.max(0, Math.sin(p.age * 9)) * (1 - p.age / p.life);
    const x0 = p.x - r * 1.35, x1 = p.x + r * 1.35;
    const y0 = p.y - r * 1.45, y1 = p.y + r * 1.2;
    for (let y = Math.floor(y0 / cellH) * cellH + cellH / 2; y < y1; y += cellH) {
      for (let x = Math.floor(x0 / cellW) * cellW + cellW / 2; x < x1; x += cellW) {
        const u = (x - p.x) / r, v = -(y - p.y) / r;
        const f = heartF(u, v);
        const i = cellOf(x, y);
        if (f <= 0) {
          // near the boundary (checked a half cell out) is outline
          const du = cellW / r / 1.6, dv = cellH / r / 1.6;
          const rim = heartF(u + du, v) > 0 || heartF(u - du, v) > 0 || heartF(u, v + dv) > 0 || heartF(u, v - dv) > 0;
          if (rim) knock(i, a);
          else claim(i, INVERT, a);
        }
      }
    }
  }
}
