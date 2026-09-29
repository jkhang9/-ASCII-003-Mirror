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

The panel is one column, ordered like a design tool's inspector: the controls you reach for most come first, set-and-forget options last.

| Section | Controls |
|---|---|
| Characters | character set (classic, detailed, blocks, symbols, minimal, binary, or type your own symbols or words into the last chip), density |
| Adjust | brightness, contrast, blur, invert |
| Edges | none, Sobel (draws `\| / - \` along edges), DoG (line-art outlines) |
| View | light or dark canvas, mirror, remove background |

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

The gestures sit in a strip under the mirror: each can be switched on or off, and its **Try** button (or number key) previews the effect without a camera.

## How it works

- **`js/vision.js`** loads MediaPipe Tasks Vision from jsDelivr. It runs a hand landmarker (2 hands) and a selfie segmenter, on the GPU when one is available and on the CPU otherwise.
- **`js/ascii.js`** shrinks the frame to one pixel per character cell and turns it into "ink": auto-levels, then blur, brightness, contrast, invert, edges and the optional background mask. Drawing maps ink onto the character ramp. Every cell has a small spring: image motion nudges glyphs so they lag behind you, hands and effects push them, and ink fades out slower than it fades in.
- **`js/gestures.js`** classifies each hand from MediaPipe's *world* landmarks, which are metric 3D, so finger curl doesn't depend on distance or rotation. Small state machines handle holds, the fist→open window, wave swings, heart geometry and a cooldown per gesture.
- **`js/effects.js`** is a character particle system. Particles are never drawn on their own: each frame they are written into the field's effect layer, where a particle takes over its cell and fades the portrait in the cells around it. Hearts invert the portrait's tone inside a heart shape.
- **`js/palette.js`** holds the canvas colours for the light and dark canvas, matched to `styles.css`.
- **`js/glyphs.js`** pre-renders each glyph once and stamps it with `drawImage`, which keeps a frame with 10k+ glyphs cheap.

Add `?debug` to the URL to expose the internals as `window.asciiCamera`.
