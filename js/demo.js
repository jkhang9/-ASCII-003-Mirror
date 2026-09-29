// A stand-in sitter for when there's no camera: a soft paper-doll bust that
// sways and blinks, fed through exactly the same ASCII pipeline.

export class DemoSitter {
  constructor() {
    this.maskCanvas = document.createElement('canvas');
    this.mctx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
    this.mask = null;
    this.t = 0;
  }

  step(t) {
    this.t = t;
  }

  pose(w, h) {
    const t = this.t;
    return {
      cx: w * 0.5 + Math.sin(t * 0.55) * w * 0.018,
      tilt: Math.sin(t * 0.43 + 1) * 0.05,
      breath: Math.sin(t * 1.1) * h * 0.006,
      blink: (t % 4.3) > 4.15,
    };
  }

  // luminance picture
  draw(ctx, w, h) {
    const { cx, tilt, breath, blink } = this.pose(w, h);
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);

    // torso
    const g = ctx.createLinearGradient(cx - h * 0.4, 0, cx + h * 0.4, 0);
    g.addColorStop(0, '#55514a');
    g.addColorStop(0.5, '#8d877c');
    g.addColorStop(1, '#46433d');
    ctx.fillStyle = g;
    this.torso(ctx, cx, w, h, breath);
    ctx.fill();

    // neck
    ctx.fillStyle = '#b9b2a6';
    ctx.fillRect(cx - h * 0.045, h * 0.43, h * 0.09, h * 0.14);

    // head
    ctx.translate(cx, h * 0.33 + breath);
    ctx.rotate(tilt);
    const face = ctx.createRadialGradient(-h * 0.03, -h * 0.02, h * 0.02, 0, 0, h * 0.16);
    face.addColorStop(0, '#e8e2d8');
    face.addColorStop(1, '#9d968a');
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.ellipse(0, 0, h * 0.1, h * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();

    // hair
    ctx.fillStyle = '#23211e';
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.045, h * 0.112, h * 0.1, 0, Math.PI * 1.02, Math.PI * 1.98);
    ctx.ellipse(h * 0.02, -h * 0.06, h * 0.1, h * 0.075, 0.2, Math.PI * 0.95, Math.PI * 2.05);
    ctx.fill();

    // eyes, brows, mouth
    ctx.fillStyle = '#2a2723';
    const ey = -h * 0.005;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(sx * h * 0.04, ey, h * 0.014, blink ? h * 0.002 : h * 0.01, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(sx * h * 0.04 - h * 0.02, ey - h * 0.03, h * 0.04, h * 0.006);
    }
    ctx.beginPath();
    ctx.ellipse(0, h * 0.06, h * 0.026, h * 0.008, 0, 0, Math.PI);
    ctx.fill();
    ctx.restore();
  }

  torso(ctx, cx, w, h, breath) {
    ctx.beginPath();
    ctx.moveTo(cx - h * 0.42, h * 1.02);
    ctx.bezierCurveTo(cx - h * 0.42, h * 0.72 + breath, cx - h * 0.3, h * 0.62 + breath, cx - h * 0.06, h * 0.56 + breath);
    ctx.lineTo(cx + h * 0.06, h * 0.56 + breath);
    ctx.bezierCurveTo(cx + h * 0.3, h * 0.62 + breath, cx + h * 0.42, h * 0.72 + breath, cx + h * 0.42, h * 1.02);
    ctx.closePath();
  }

  // silhouette mask at a small, stage-shaped resolution
  maskFor(aspect) {
    const mw = 128, mh = Math.max(32, Math.round(128 / aspect));
    const c = this.maskCanvas, ctx = this.mctx;
    if (c.width !== mw || c.height !== mh) {
      c.width = mw;
      c.height = mh;
      this.mask = new Float32Array(mw * mh);
    }
    const { cx, tilt, breath } = this.pose(mw, mh);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, mw, mh);
    ctx.fillStyle = '#fff';
    this.torso(ctx, cx, mw, mh, breath);
    ctx.fill();
    ctx.fillRect(cx - mh * 0.045, mh * 0.43, mh * 0.09, mh * 0.14);
    ctx.save();
    ctx.translate(cx, mh * 0.33 + breath);
    ctx.rotate(tilt);
    ctx.beginPath();
    ctx.ellipse(0, 0, mh * 0.1, mh * 0.13, 0, 0, Math.PI * 2);
    ctx.ellipse(0, -mh * 0.045, mh * 0.112, mh * 0.1, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    const d = ctx.getImageData(0, 0, mw, mh).data;
    for (let i = 0, j = 0; i < this.mask.length; i++, j += 4) this.mask[i] = d[j] / 255;
    return { data: this.mask, width: mw, height: mh };
  }

  // where a hand might plausibly be, for previews (stage px)
  handSpot(W, H, side = 1) {
    const { cx } = this.pose(W, H);
    return { x: cx + side * H * 0.34, y: H * 0.62 };
  }
}
