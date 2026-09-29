# ASCII Camera

A live mirror drawn in text characters. A few hand gestures set off effects inside the same character grid: they swap glyphs cell by cell instead of being painted on top. It's a static page with no build step, and everything runs locally in the browser. No video leaves the machine.

## Run it

The camera only works over `https://` or on `localhost`, so serve the folder instead of opening the file directly:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Desktop Chrome, Edge or Arc works best. Safari and Firefox work too, but tracking runs slower there.

## Gestures

| # | Gesture | Effect | Intensity |
|---|---------|--------|-----------|
| 01 | Wave | `* + x .` shed from the hand and settle along your outline | ambient |
| 02 | Fist → quickly open | a firework bursts through the grid from the opening hand | biggest |
| 03 | Thumbs up | a small cluster of `+ * .` | small |
| 04 | Two thumbs up | sparkles across the whole portrait, plus a halo | large |
| 05 | Peace | stars trace the V of your fingers, then pop | small |
| 06 | Heart hands | a heart traced in `♥ . +` blooms, and hearts orbit you | medium |

Number keys `1`–`6`, or the **Try** buttons, preview each effect without a camera. Without a camera you can also choose **play without a camera**, which swaps in a paper-doll sitter.

## How it works

- **`js/vision.js`** loads MediaPipe Tasks Vision from jsDelivr. It runs a hand landmarker (2 hands) and a selfie segmenter, on the GPU when one is available and on the CPU otherwise.
- **`js/ascii.js`** shrinks the mirrored frame to one pixel per character cell. It turns that into "ink" using auto-levels, a local-contrast term for eyes and mouth, and the segmentation mask so the silhouette stays clean. Every cell has a small spring. Image motion (normal flow) nudges glyphs so they lag behind you, hands stir the glyphs they pass through, and ink fades out slower than it fades in, which leaves soft trails.
- **`js/gestures.js`** classifies each hand from MediaPipe's *world* landmarks, which are metric 3D. That makes finger curl independent of distance and rotation. The thresholds were calibrated on MediaPipe's sample photos. Small state machines then handle holds, the fist→open window, wave swings, heart geometry and one-shot-per-pose, with a cooldown per gesture. The sensitivity slider scales all of these.
- **`js/effects.js`** is a character particle system with free, seek, orbit and hold motion, twinkle and trails. Particles are never drawn on their own: each frame they are rasterised into the portrait's effect layer, so a particle takes over the cell it is in and the grid is drawn once. Big effects also send a shockwave through the portrait's springs.
- **`js/palette.js`** holds the canvas colours, matched to the custom properties in `styles.css`.
- **`js/glyphs.js`** pre-renders each glyph once and stamps it with `drawImage`, which keeps a frame with 10k+ glyphs cheap.

Add `?debug` to the URL to expose the internals as `window.asciiCamera`.
