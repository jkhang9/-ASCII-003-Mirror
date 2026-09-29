# ASCII Camera

*motion makes magic.*

A camera playground that draws you live in text characters. A few hand gestures set off typographic effects around you. It's a static page with no build step, and everything runs locally in the browser. No video leaves the machine.

## Run it

The camera only works over `https://` or on `localhost`, so serve the folder instead of opening the file directly:

```bash
cd ascii-camera
python3 -m http.server 8000
# open http://localhost:8000
```

Desktop Chrome, Edge or Arc works best. Safari and Firefox work too, but tracking runs slower there.

## Gestures

| # | Gesture | Effect | Intensity |
|---|---------|--------|-----------|
| 01 | Wave | stars shed from the hand and settle along your outline | ambient |
| 02 | Fist → quickly open | an ASCII firework bursts from the opening hand | biggest |
| 03 | Thumbs up | a small cluster of `+ ✦ *` | small |
| 04 | Two thumbs up | sparkles across the whole portrait, plus a halo | large |
| 05 | Peace | stars trace the V of your fingers, then pop | small |
| 06 | Heart hands | a heart drawn in `♡ . +` blooms, and `<3` hearts orbit you | medium |

Number keys `1`–`6`, or a click on a card, preview each effect without a camera. Without a camera you can also choose **play without a camera**, which swaps in a paper-doll sitter.

## How it works

- **`js/vision.js`** loads MediaPipe Tasks Vision from jsDelivr. It runs a hand landmarker (2 hands) and a selfie segmenter, on the GPU when one is available and on the CPU otherwise.
- **`js/ascii.js`** shrinks the mirrored frame to one pixel per character cell. It turns that into "ink" using auto-levels, a local-contrast term for eyes and mouth, and the segmentation mask so the silhouette stays clean. Every cell has a small spring. Image motion (normal flow) nudges glyphs so they lag behind you, hands stir the glyphs they pass through, and ink fades out slower than it fades in, which leaves soft trails.
- **`js/gestures.js`** classifies each hand from MediaPipe's *world* landmarks, which are metric 3D. That makes finger curl independent of distance and rotation. The thresholds were calibrated on MediaPipe's sample photos. Small state machines then handle holds, the fist→open window, wave swings, heart geometry and one-shot-per-pose, with a cooldown per gesture. The sensitivity slider scales all of these.
- **`js/effects.js`** is a character particle system with free, seek, orbit and hold motion, twinkle and trails. Each particle punches a small paper-coloured knockout so effects read clearly on top of the portrait. Big effects also send a shockwave through the portrait's springs.
- **`js/glyphs.js`** pre-renders each glyph once and stamps it with `drawImage`, which keeps a frame with 10k+ glyphs cheap.

Add `?debug` to the URL to expose the internals as `window.asciiCamera`.
