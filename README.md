# ASCII Camera

A live mirror drawn in text characters, in black and white. A customizer tunes the image, and a few hand gestures set off effects inside the same character grid: they swap, invert or clear cells instead of being painted on top. It's a static page with no build step, and everything runs locally in the browser. No video leaves the machine.

## Run it

The camera only works over `https://` or on `localhost`, so serve the folder instead of opening the file directly:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Desktop Chrome, Edge or Arc works best. Safari and Firefox work too, but tracking runs slower there. Without a camera, choose **play without a camera** to get a paper-doll sitter.

## Customizer

The panel has three tabs:

| Tab | Controls |
|---|---|
| Style | character set (classic, detailed, blocks, symbols, minimal, binary, or type your own symbols or words into the last chip), density, edges (none, Sobel, DoG), light or dark canvas |
| Image | brightness, contrast, blur, invert, mirror, remove background |
| Gestures | each effect on/off with a **Try** button, sensitivity |

**Reset** restores the defaults, **Copy text** copies the current frame as plain text, and **Save PNG** downloads it. Settings are remembered in the browser.

## Gestures

| Key | Gesture | Effect |
|---|---------|--------|
| 1 | Wave | `* + x o` shed from the hand and settle along your outline |
| 2 | Fist → quickly open | a starburst of characters with trails |
| 3 | Thumbs up | a fountain of sparks that falls back down |
| 4 | Two thumbs up | sparks from both hands, sparkles across the portrait, and a halo |
| 5 | Peace | stars trace the V of your fingers, then burst at the fingertips |
| 6 | Heart hands | a beating heart-shaped window that inverts the portrait, plus smaller hearts |

The **Try** buttons and number keys preview each effect without a camera.

## How it works

- **`js/vision.js`** loads MediaPipe Tasks Vision from jsDelivr. It runs a hand landmarker (2 hands) and a selfie segmenter, on the GPU when one is available and on the CPU otherwise.
- **`js/ascii.js`** shrinks the frame to one pixel per character cell and turns it into "ink": auto-levels, then blur, brightness, contrast, invert, edges and the optional background mask. Drawing maps ink onto the character ramp. Every cell has a small spring: image motion nudges glyphs so they lag behind you, hands and effects push them, and ink fades out slower than it fades in.
- **`js/gestures.js`** classifies each hand from MediaPipe's *world* landmarks, which are metric 3D, so finger curl doesn't depend on distance or rotation. Small state machines handle holds, the fist→open window, wave swings, heart geometry and a cooldown per gesture. The sensitivity slider scales all of these.
- **`js/effects.js`** is a character particle system. Particles are never drawn on their own: each frame they are written into the field's effect layer, where a particle takes over its cell and fades the portrait in the cells around it. Hearts invert the portrait's tone inside a heart shape.
- **`js/palette.js`** holds the canvas colours for the light and dark canvas, matched to `styles.css`.
- **`js/glyphs.js`** pre-renders each glyph once and stamps it with `drawImage`, which keeps a frame with 10k+ glyphs cheap.

Add `?debug` to the URL to expose the internals as `window.asciiCamera`.
