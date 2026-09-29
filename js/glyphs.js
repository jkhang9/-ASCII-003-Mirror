// Pre-rendered glyph sprites. Every character is drawn once, large, into its own
// little canvas and then stamped with drawImage — far cheaper than thousands of
// fillText calls per frame, and it lets us scale and fade glyphs freely.

const BASE = 64; // px the sprite is rendered at
const PAD = 1.5; // sprite box = BASE * PAD, glyph centred

export const FONTS = {
  mono: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
  serif: '"Instrument Serif", Georgia, serif',
  // symbols like ✦ ♡ fall back to whatever the system has, which is fine
};

export class GlyphAtlas {
  constructor() {
    this.cache = new Map();
    this.coverage = new Map();
  }

  clear() {
    this.cache.clear();
    this.coverage.clear();
  }

  get(ch, color, font = 'mono') {
    const key = font + '|' + color + '|' + ch;
    let g = this.cache.get(key);
    if (!g) {
      g = this.render(ch, color, font);
      this.cache.set(key, g);
    }
    return g;
  }

  render(ch, color, font) {
    const size = Math.ceil(BASE * PAD * (ch.length > 1 ? 1.4 : 1));
    const c = document.createElement('canvas');
    c.width = size;
    c.height = Math.ceil(BASE * PAD);
    const ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${BASE}px ${FONTS[font] || FONTS.mono}`;
    ctx.fillText(ch, c.width / 2, c.height / 2 + BASE * 0.04);
    // draw size is expressed relative to BASE, so remember the sprite ratio
    return { canvas: c, w: c.width / BASE, h: c.height / BASE };
  }

  // How much ink a glyph lays down, 0..1. Used to order a character set from
  // lightest to darkest so any custom set maps onto brightness sensibly.
  inkOf(ch, font = 'mono') {
    const key = font + '|' + ch;
    if (this.coverage.has(key)) return this.coverage.get(key);
    const g = this.render(ch, '#000', font);
    const ctx = g.canvas.getContext('2d', { willReadFrequently: true });
    const { data } = ctx.getImageData(0, 0, g.canvas.width, g.canvas.height);
    let sum = 0;
    for (let i = 3; i < data.length; i += 4) sum += data[i];
    const v = sum / (255 * (data.length / 4));
    this.coverage.set(key, v);
    return v;
  }
}

// Stamp a glyph centred on (x, y). `size` is the nominal font size in px.
export function stamp(ctx, g, x, y, size, alpha) {
  if (alpha <= 0.004) return;
  const w = g.w * size;
  const h = g.h * size;
  ctx.globalAlpha = alpha > 1 ? 1 : alpha;
  ctx.drawImage(g.canvas, x - w / 2, y - h / 2, w, h);
}
