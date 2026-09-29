// The ASCII portrait. The camera frame is shrunk to one pixel per character
// cell and run through the customizer's adjustments (levels, brightness,
// contrast, blur, invert, edges, background removal) to give each cell an
// "ink" value. Drawing maps ink onto the character ramp, optionally dithered.
// Every cell also carries a tiny spring so characters lag a little behind
// motion, get pushed by effects, and settle back into place. Gesture effects
// write into a per-cell layer (fxA/fxG/fxK) that the draw pass honours, so
// they are part of the grid rather than painted on top.

import { stamp } from './glyphs.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// 4×4 Bayer thresholds, centred in 0..1
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

// fxG marker: the effect inverts this cell's tone instead of setting a glyph
export const INVERT = { invert: true };

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
    this.hist = new Uint32Array(64);
    this.body = { present: false, cx: 0, cy: 0, rx: 0, ry: 0, top: 0, edges: [], cells: [] };
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
    this.val = new Float32Array(n);
    this.tmp = new Float32Array(n);
    this.g1 = new Float32Array(n);
    this.g2 = new Float32Array(n);
    this.mask = new Float32Array(n);
    this.target = new Float32Array(n);
    this.prev = new Float32Array(n);
    this.ink = new Float32Array(n);
    this.motion = new Float32Array(n);
    this.edge = new Float32Array(n);
    this.edgeDir = new Uint8Array(n);
    this.err = new Float32Array(n);
    this.shown = new Array(n).fill(null);
    // effect layer, written by Effects.rasterize: strength, glyph, knockout
    this.fxA = new Float32Array(n);
    this.fxG = new Array(n).fill(null);
    this.fxK = new Float32Array(n);
    this.dx = new Float32Array(n);
    this.dy = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.sample.width = cols;
    this.sample.height = rows;
  }

  // separable box blur of `src` into `dst` (may be the same array)
  blur(src, dst, radius) {
    const { cols, rows, tmp } = this;
    const k = 2 * radius + 1;
    for (let r = 0; r < rows; r++) {
      const o = r * cols;
      for (let c = 0; c < cols; c++) {
        let s = 0;
        for (let d = -radius; d <= radius; d++) s += src[o + Math.min(cols - 1, Math.max(0, c + d))];
        tmp[o + c] = s / k;
      }
    }
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        let s = 0;
        for (let d = -radius; d <= radius; d++) s += tmp[Math.min(rows - 1, Math.max(0, r + d)) * cols + c];
        dst[r * cols + c] = s / k;
      }
    }
  }

  // draw(ctx, w, h) must paint the (cropped, possibly mirrored) frame into w×h.
  // mask is {data, width, height} aligned with the same crop, or null.
  ingest(draw, mask, opts) {
    const { cols, rows, sctx, lum, val, g1, g2, target, prev, motion, edge, edgeDir } = this;
    const n = cols * rows;
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    draw(sctx, cols, rows);
    const px = sctx.getImageData(0, 0, cols, rows).data;

    for (let i = 0, j = 0; i < n; i++, j += 4) {
      lum[i] = (0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2]) / 255;
    }

    // segmentation mask → grid (bilinear)
    const m = this.mask;
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
          m[i] += (v - m[i]) * 0.6;
        }
      }
    }

    // auto levels from the subject (or the whole frame without a mask)
    const hist = this.hist;
    hist.fill(0);
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (mask && m[i] < 0.5) continue;
      hist[Math.min(63, (lum[i] * 64) | 0)]++;
      count++;
    }
    if (count > 20) {
      const loK = count * 0.03, hiK = count * 0.97;
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

    // levels → blur → brightness / contrast, as a 0..1 brightness value
    const range = Math.max(0.12, this.hi - this.lo);
    for (let i = 0; i < n; i++) val[i] = clamp01((lum[i] - this.lo) / range);
    if (opts.blur > 0) this.blur(val, val, opts.blur);
    const { contrast, brightness, invert } = opts;
    for (let i = 0; i < n; i++) val[i] = clamp01((val[i] - 0.5) * contrast + 0.5 + brightness);

    // edges, measured on the adjusted image
    const edges = opts.edges;
    edge.fill(0);
    if (edges === 'sobel') {
      for (let r = 1; r < rows - 1; r++) {
        for (let c = 1; c < cols - 1; c++) {
          const i = r * cols + c;
          const tl = val[i - cols - 1], t = val[i - cols], tr = val[i - cols + 1];
          const l = val[i - 1], rr = val[i + 1];
          const bl = val[i + cols - 1], b = val[i + cols], br = val[i + cols + 1];
          const gx = tr + 2 * rr + br - tl - 2 * l - bl;
          const gy = bl + 2 * b + br - tl - 2 * t - tr;
          edge[i] = clamp01(Math.hypot(gx, gy) / 4);
          // the edge runs across the gradient: pick | / - \ for its direction
          let a = Math.atan2(gy, gx);
          if (a < 0) a += Math.PI;
          edgeDir[i] = a < Math.PI / 8 || a >= (7 * Math.PI) / 8 ? 0 : a < (3 * Math.PI) / 8 ? 1 : a < (5 * Math.PI) / 8 ? 2 : 3;
        }
      }
    } else if (edges === 'dog') {
      // difference of Gaussians: thin lines where a cell is darker (or, inverted, lighter) than its surroundings
      this.blur(val, g1, 1);
      this.blur(val, g2, 3);
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        let t = invert ? val[i] : 1 - val[i];
        if (edges === 'sobel') {
          t *= 0.4;
        } else if (edges === 'dog') {
          const line = clamp01((invert ? g1[i] - g2[i] : g2[i] - g1[i]) * 9 - 0.05);
          t = Math.max(t * 0.3, line);
        }
        if (mask) {
          const mm = smooth(0.35, 0.8, m[i]);
          t *= mm;
          edge[i] *= mm;
        }
        const d = Math.abs(t - prev[i]);
        motion[i] = Math.max(d, motion[i] * 0.86);
        prev[i] = target[i];
        target[i] = t;
      }
    }

    this.measureBody(!!mask);
  }

  // where the subject is, so effects can settle around it
  measureBody(hasMask) {
    const { cols, rows, cellW, cellH } = this;
    const src = hasMask ? this.mask : this.target;
    const thr = hasMask ? 0.5 : 0.4;
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

  update(dt) {
    const { cols, rows, ink, target, prev, motion, dx, dy, vx, vy, cellW, cellH } = this;
    const n = cols * rows;
    const attack = 1 - Math.exp(-dt * 26);
    const release = 1 - Math.exp(-dt * 5.5); // slow release = soft trails
    const K = 95, C = 10.5;
    const maxD = cellW * 2.6;
    const lag = 26;
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

  // Map ink onto n ramp levels: straight quantisation, error diffusion or ordered.
  levels(n, dither) {
    const { cols, rows, ink, err } = this;
    const top = n - 1;
    if (dither === 'floyd' || dither === 'atkinson') {
      // err holds the running error, and each cell is overwritten with its level once visited
      err.set(ink);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const v = err[i];
          const lvl = Math.max(0, Math.min(top, Math.round(v * top)));
          const e = v - lvl / top;
          err[i] = lvl;
          const R = c < cols - 1, L = c > 0, D = r < rows - 1;
          if (dither === 'floyd') {
            if (R) err[i + 1] += e * 0.4375;
            if (D) {
              if (L) err[i + cols - 1] += e * 0.1875;
              err[i + cols] += e * 0.3125;
              if (R) err[i + cols + 1] += e * 0.0625;
            }
          } else {
            const f = e / 8;
            if (R) err[i + 1] += f;
            if (c < cols - 2) err[i + 2] += f;
            if (D) {
              if (L) err[i + cols - 1] += f;
              err[i + cols] += f;
              if (R) err[i + cols + 1] += f;
            }
            if (r < rows - 2) err[i + 2 * cols] += f;
          }
        }
      }
    } else if (dither === 'bayer') {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          err[i] = Math.max(0, Math.min(top, Math.floor(ink[i] * top + BAYER4[(r & 3) * 4 + (c & 3)])));
        }
      }
    } else {
      for (let i = 0; i < cols * rows; i++) err[i] = Math.min(top, Math.floor(ink[i] * n));
    }
    return err;
  }

  draw(ctx, style, opts) {
    const { cols, rows, cellW, cellH, ink, dx, dy, edge, edgeDir, shown, fxA, fxG, fxK } = this;
    const textMode = style.mode === 'text';
    const ramp = style.glyphs;
    const lv = this.levels(textMode ? 2 : ramp.length, opts.dither);
    const sobel = opts.edges === 'sobel';
    const size = cellH * (style.scale || 0.98);

    for (let r = 0; r < rows; r++) {
      let seq = r * 11;
      const y0 = (r + 0.5) * cellH;
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        let g = null, alpha = 1;
        if (textMode) seq++;
        if (fxA[i] >= 0.05) {
          // an effect owns this cell
          alpha = Math.min(1, 0.3 + fxA[i]);
          if (fxG[i] === INVERT) {
            if (textMode) g = ink[i] < 0.3 ? style.text[(seq - 1) % style.text.length] : null;
            else g = ramp[ramp.length - 1 - lv[i]];
          } else {
            g = fxG[i];
          }
        } else if (sobel && edge[i] > 0.28) {
          g = style.edgeGlyphs[edgeDir[i]];
        } else if (textMode) {
          const on = opts.dither ? lv[i] > 0 : ink[i] > 0.08;
          if (on) {
            g = style.text[(seq - 1) % style.text.length];
            if (!opts.dither) alpha = 0.2 + ink[i];
          }
        } else {
          g = ramp[lv[i]];
        }
        // the portrait makes room around effects
        if (fxA[i] < 0.05 && fxK[i] > 0) alpha *= 1 - fxK[i];
        shown[i] = g;
        if (g) stamp(ctx, g, (c + 0.5) * cellW + dx[i], y0 + dy[i], size, alpha);
      }
    }
    ctx.globalAlpha = 1;
  }

  // the last drawn frame as plain text
  toText() {
    const { cols, rows, shown } = this;
    const lines = [];
    for (let r = 0; r < rows; r++) {
      let s = '';
      for (let c = 0; c < cols; c++) s += shown[r * cols + c]?.ch ?? ' ';
      lines.push(s.trimEnd());
    }
    return lines.join('\n');
  }
}
