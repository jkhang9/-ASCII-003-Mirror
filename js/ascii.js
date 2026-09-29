// The ASCII portrait. The camera frame is shrunk to one pixel per character
// cell, turned into "ink", and every cell carries a tiny spring so characters
// can be pushed around by motion and settle back into place.

import { stamp } from './glyphs.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// cheap deterministic hash → 0..1
function hash(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n ^= n >>> 4;
  n = Math.imul(n, 0x27d4eb2d);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967295;
}

export class AsciiField {
  constructor() {
    this.cols = 0;
    this.rows = 0;
    this.width = 0;
    this.height = 0;
    this.cellW = 10;
    this.cellH = 16;
    this.sample = document.createElement('canvas');
    this.sctx = this.sample.getContext('2d', { willReadFrequently: true });
    this.lo = 0.15;
    this.hi = 0.85;
    this.hasMask = false;
    this.body = { present: false, cx: 0, cy: 0, rx: 0, ry: 0, top: 0, edges: [], cells: [] };
    this.hist = new Uint32Array(64);
  }

  resize(width, height, density) {
    const target = lerp(19, 6.4, density);
    const cols = Math.max(24, Math.round(width / target));
    const cellW = width / cols;
    const rows = Math.max(12, Math.round(height / (cellW * 1.62)));
    this.width = width;
    this.height = height;
    this.cellW = cellW;
    this.cellH = height / rows;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    const n = cols * rows;
    this.lum = new Float32Array(n);
    this.blur = new Float32Array(n);
    this.tmp = new Float32Array(n);
    this.mask = new Float32Array(n);
    this.target = new Float32Array(n);
    this.prev = new Float32Array(n);
    this.ink = new Float32Array(n);
    this.motion = new Float32Array(n);
    this.dx = new Float32Array(n);
    this.dy = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.sample.width = cols;
    this.sample.height = rows;
  }

  // draw(ctx, w, h) must paint the (mirrored, cropped) frame into w×h.
  // mask is {data, width, height} aligned with the same crop, or null.
  ingest(draw, mask) {
    const { cols, rows, sctx } = this;
    const n = cols * rows;
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    draw(sctx, cols, rows);
    const px = sctx.getImageData(0, 0, cols, rows).data;
    const { lum, blur, tmp, target, prev, motion } = this;

    for (let i = 0, j = 0; i < n; i++, j += 4) {
      lum[i] = (0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2]) / 255;
    }

    // segmentation mask → grid (bilinear)
    this.hasMask = !!mask;
    if (mask) {
      const { data, width: mw, height: mh } = mask;
      for (let r = 0; r < rows; r++) {
        const fy = ((r + 0.5) / rows) * mh - 0.5;
        const y0 = Math.max(0, Math.min(mh - 1, Math.floor(fy)));
        const y1 = Math.min(mh - 1, y0 + 1);
        const ty = clamp01(fy - y0);
        for (let c = 0; c < cols; c++) {
          const fx = ((c + 0.5) / cols) * mw - 0.5;
          const x0 = Math.max(0, Math.min(mw - 1, Math.floor(fx)));
          const x1 = Math.min(mw - 1, x0 + 1);
          const tx = clamp01(fx - x0);
          const a = data[y0 * mw + x0], b = data[y0 * mw + x1];
          const cc = data[y1 * mw + x0], d = data[y1 * mw + x1];
          const v = (a + (b - a) * tx) * (1 - ty) + (cc + (d - cc) * tx) * ty;
          const i = r * cols + c;
          // a little temporal smoothing keeps the silhouette edge calm
          this.mask[i] += (v - this.mask[i]) * 0.6;
        }
      }
    }

    // auto levels from the subject (or whole frame without a mask)
    const hist = this.hist;
    hist.fill(0);
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (mask && this.mask[i] < 0.5) continue;
      hist[Math.min(63, (lum[i] * 64) | 0)]++;
      count++;
    }
    if (count > 20) {
      const loK = count * 0.04, hiK = count * 0.97;
      let acc = 0, lo = 0, hi = 63;
      for (let b = 0; b < 64; b++) {
        acc += hist[b];
        if (acc < loK) lo = b;
        if (acc < hiK) hi = b;
      }
      const L = lo / 64, H = Math.max(L + 0.18, (hi + 1) / 64);
      this.lo += (L - this.lo) * 0.08;
      this.hi += (H - this.hi) * 0.08;
    }

    // 3×3 box blur for a local-contrast "detail" term (eyes, brows, mouth)
    for (let r = 0; r < rows; r++) {
      const o = r * cols;
      for (let c = 0; c < cols; c++) {
        const l = c > 0 ? lum[o + c - 1] : lum[o + c];
        const rr = c < cols - 1 ? lum[o + c + 1] : lum[o + c];
        tmp[o + c] = (l + lum[o + c] + rr) / 3;
      }
    }
    for (let r = 0; r < rows; r++) {
      const up = r > 0 ? r - 1 : r, dn = r < rows - 1 ? r + 1 : r;
      for (let c = 0; c < cols; c++) {
        blur[r * cols + c] = (tmp[up * cols + c] + tmp[r * cols + c] + tmp[dn * cols + c]) / 3;
      }
    }

    const range = Math.max(0.12, this.hi - this.lo);
    const m = this.mask;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const dark = Math.pow(clamp01((this.hi - lum[i]) / range), 0.9);
        const detail = clamp01((blur[i] - lum[i]) * 3.4);
        let t;
        if (mask) {
          const mm = smooth(0.35, 0.8, m[i]);
          const gx = (c < cols - 1 ? m[i + 1] : m[i]) - (c > 0 ? m[i - 1] : m[i]);
          const gy = (r < rows - 1 ? m[i + cols] : m[i]) - (r > 0 ? m[i - cols] : m[i]);
          const edge = clamp01(Math.sqrt(gx * gx + gy * gy) * 1.4);
          t = mm * (0.18 + 0.7 * dark + 0.55 * detail);
          if (edge * 0.7 > t) t = edge * 0.7;
        } else {
          t = clamp01(dark * 1.12 - 0.14 + detail * 0.5);
        }
        t = t > 1 ? 1 : t;
        const d = Math.abs(t - prev[i]);
        motion[i] = Math.max(d, motion[i] * 0.86);
        prev[i] = target[i];
        target[i] = t;
      }
    }

    this.measureBody();
  }

  measureBody() {
    const { cols, rows, cellW, cellH } = this;
    const src = this.hasMask ? this.mask : this.target;
    const thr = this.hasMask ? 0.5 : 0.4;
    let sx = 0, sy = 0, cnt = 0, minX = cols, maxX = 0, minY = rows, maxY = 0;
    const edges = [];
    const cells = [];
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        if (src[i] < thr) continue;
        sx += c; sy += r; cnt++;
        if (c < minX) minX = c;
        if (c > maxX) maxX = c;
        if (r < minY) minY = r;
        if (r > maxY) maxY = r;
        if (src[i - 1] < thr || src[i + 1] < thr || src[i - cols] < thr || src[i + cols] < thr) edges.push(i);
        else if ((i & 3) === 0) cells.push(i);
      }
    }
    const b = this.body;
    b.present = cnt > cols * rows * 0.02;
    if (!b.present) {
      b.cx = this.width / 2;
      b.cy = this.height * 0.55;
      b.rx = this.width * 0.22;
      b.ry = this.height * 0.4;
      b.top = this.height * 0.2;
      b.edges = [];
      b.cells = [];
      return;
    }
    b.cx = (sx / cnt + 0.5) * cellW;
    b.cy = (sy / cnt + 0.5) * cellH;
    b.rx = Math.max(60, ((maxX - minX) / 2) * cellW);
    b.ry = Math.max(80, ((maxY - minY) / 2) * cellH);
    b.top = minY * cellH;
    b.edges = edges;
    b.cells = cells;
  }

  cellPos(i) {
    const c = i % this.cols, r = (i / this.cols) | 0;
    return { x: (c + 0.5) * this.cellW, y: (r + 0.5) * this.cellH };
  }

  // radial push: fireworks shockwaves, heart pulses, celebration ripples
  impulse(x, y, radius, strength) {
    const { cols, rows, cellW, cellH, vx, vy } = this;
    const c0 = Math.max(0, Math.floor((x - radius) / cellW)), c1 = Math.min(cols - 1, Math.ceil((x + radius) / cellW));
    const r0 = Math.max(0, Math.floor((y - radius) / cellH)), r1 = Math.min(rows - 1, Math.ceil((y + radius) / cellH));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const ex = (c + 0.5) * cellW - x, ey = (r + 0.5) * cellH - y;
        const d = Math.sqrt(ex * ex + ey * ey);
        if (d >= radius || d < 1) continue;
        const f = (1 - d / radius) ** 2 * strength;
        const i = r * cols + c;
        vx[i] += (ex / d) * f;
        vy[i] += (ey / d) * f;
      }
    }
  }

  // hands stir the characters they pass through
  stir(x, y, radius, hvx, hvy, amount) {
    const { cols, rows, cellW, cellH, vx, vy } = this;
    const c0 = Math.max(0, Math.floor((x - radius) / cellW)), c1 = Math.min(cols - 1, Math.ceil((x + radius) / cellW));
    const r0 = Math.max(0, Math.floor((y - radius) / cellH)), r1 = Math.min(rows - 1, Math.ceil((y + radius) / cellH));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const ex = (c + 0.5) * cellW - x, ey = (r + 0.5) * cellH - y;
        const d2 = ex * ex + ey * ey;
        if (d2 >= radius * radius) continue;
        const f = (1 - Math.sqrt(d2) / radius) * amount;
        const i = r * cols + c;
        vx[i] += hvx * f;
        vy[i] += hvy * f;
      }
    }
  }

  update(dt, liveliness = 1) {
    const { cols, rows, ink, target, prev, motion, dx, dy, vx, vy, cellW, cellH } = this;
    const n = cols * rows;
    const attack = 1 - Math.exp(-dt * 26);
    const release = 1 - Math.exp(-dt * 5.5); // slow release = soft trails
    const K = 95, C = 10.5;
    const maxD = cellW * 2.6;
    const lag = 26 * liveliness;
    const seed = (performance.now() / 90) | 0;
    for (let i = 0; i < n; i++) {
      const t = target[i];
      ink[i] += (t - ink[i]) * (t > ink[i] ? attack : release);

      // normal flow: which way is the image moving here? Nudge glyphs the
      // opposite way so they appear to lag behind, then let the spring
      // pull them home.
      const mo = motion[i];
      if (mo > 0.06) {
        const c = i % cols;
        const r = (i / cols) | 0;
        const gx = (c < cols - 1 ? target[i + 1] : t) - (c > 0 ? target[i - 1] : t);
        const gy = (r < rows - 1 ? target[i + cols] : t) - (r > 0 ? target[i - cols] : t);
        const it = t - prev[i];
        const g2 = gx * gx + gy * gy + 0.02;
        let fx = (-it * gx) / g2, fy = (-it * gy) / g2; // cells per frame
        const fm = Math.hypot(fx, fy);
        if (fm > 2) { fx *= 2 / fm; fy *= 2 / fm; }
        const k = lag * Math.min(1, (mo - 0.06) * 4);
        vx[i] += -fx * cellW * k * dt * 4 + (hash(i * 7 + seed) - 0.5) * mo * 60;
        vy[i] += -fy * cellH * k * dt * 4;
      }

      vx[i] += (-K * dx[i] - C * vx[i]) * dt;
      vy[i] += (-K * dy[i] - C * vy[i]) * dt;
      dx[i] += vx[i] * dt;
      dy[i] += vy[i] * dt;
      if (dx[i] > maxD) dx[i] = maxD; else if (dx[i] < -maxD) dx[i] = -maxD;
      if (dy[i] > maxD) dy[i] = maxD; else if (dy[i] < -maxD) dy[i] = -maxD;
    }
  }

  draw(ctx, atlas, style, time) {
    const { cols, rows, cellW, cellH, ink, dx, dy, vx, vy } = this;
    const glyphs = style.glyphs;
    const ng = glyphs ? glyphs.length : 0;
    const dot = style.dot;
    const tick = (time * 1.4) | 0;

    // background: a sparse dotted field, like graph paper
    const bgSize = cellH * 0.62;
    for (let r = 1; r < rows; r += 2) {
      for (let c = (r >> 1) % 2 ? 1 : 2; c < cols; c += 3) {
        const i = r * cols + c;
        if (ink[i] > 0.05) continue;
        stamp(ctx, dot, (c + 0.5) * cellW + dx[i], (r + 0.5) * cellH + dy[i], bgSize, 0.11);
      }
    }

    const textMode = style.mode === 'text';
    const text = style.text;
    const tl = text ? text.length : 0;

    for (let r = 0; r < rows; r++) {
      let seq = r * 11;
      const y0 = (r + 0.5) * cellH;
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const v = ink[i];
        if (v < 0.035) continue;
        const breathe = Math.sin(time * 1.2 + c * 0.37 + r * 0.23) * 0.45;
        const x = (c + 0.5) * cellW + dx[i];
        const y = y0 + dy[i] + breathe;
        let g, size, alpha;
        if (textMode) {
          const ch = style.textGlyphs[seq++ % tl];
          if (!ch) continue;
          g = ch;
          size = cellH * (0.74 + 0.34 * v);
          alpha = 0.14 + v * 1.1;
        } else {
          let idx = Math.min(ng - 1, (v * ng) | 0);
          // an occasional glyph flickers one step — the portrait breathes
          if (ng > 1 && hash(i * 131 + tick) < 0.015) idx = Math.max(0, Math.min(ng - 1, idx + (hash(i + tick) < 0.5 ? -1 : 1)));
          g = glyphs[idx];
          size = ng === 1 ? cellH * (0.46 + 0.8 * v) : cellH * (0.8 + 0.32 * v);
          alpha = 0.16 + v * 1.05;
        }
        stamp(ctx, g, x, y, size, alpha);

        // fast-moving glyphs leave a faint echo — a subtle stretch
        const sp = vx[i] * vx[i] + vy[i] * vy[i];
        if (sp > 1600) {
          stamp(ctx, g, x - vx[i] * 0.045, y - vy[i] * 0.045, size * 0.82, alpha * 0.3);
        }
      }
    }
    ctx.globalAlpha = 1;
  }
}
