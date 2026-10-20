# ASCII-art dither landing — 21st.dev "page 2" recipe

The live vanilla site implements this in `index.html` (`rHome` + `startAscii`,
styles under `.al`): a Canvas2D ordered-dither render of `assets/landing.jpg`
with the MAISTRO wordmark centered (Unbounded, gold "Ai" — same logo treatment
as the app shell).

Pipeline (as implemented):
1. Draw source photo cover-cropped into an offscreen canvas at grid resolution
   (one pixel per cell), sample each cell's average color + luminance.
2. `renderMode: "dither"` — 4×4 Bayer ordered dithering; a cell draws a square
   dot (sized by luminance) only when its pulsed luminance clears the Bayer
   threshold. `bgMode: "none"` — pure black behind.
3. Color pipeline: contrast 158 applied per-channel; saturation 100 /
   grayscale 0 / tintOpacity 0 → source colors kept.
4. `animated: true, animStyle: "pulse"` — global sinusoidal luminance + dot-size
   modulation (`animSpeed` 100, `animIntensity` 60). Redraw throttled to ~30fps.

Original recipe parameters (for re-tuning):

```json
{
  "renderMode": "dither", "bgMode": "none", "cellSize": 9, "coverage": 100,
  "invert": false, "charSet": "standard", "brightness": 0, "contrast": 158,
  "edgeEmphasis": 0, "density": 20, "tint": "#3ca6ff", "tintOpacity": 0,
  "overlayBlend": "multiply", "saturation": 100, "grayscale": 0,
  "blurType": "off", "pfx": "all disabled",
  "animated": true, "animStyle": "pulse",
  "animSpeed": {"enabled": true, "intensity": 100},
  "animIntensity": {"enabled": true, "intensity": 60},
  "lights": {"enabled": false}, "mask": {"enabled": false}
}
```

Source: `assets/landing-smoke.png` — the user's capture of the actual
"Page 2" render (21st.dev, by PRO TECHnology, /community/ascii/page-2-af85970c…):
cream smoke wisps on black hugging the left/right edges, empty center.
Contrast is baked into this render, so the live code applies none — it
downscale-averages the capture back to a luminance field (1.3× gain) and
re-dithers it at a fine 4px pitch; only active (non-black) cells are kept
so the animation loop stays cheap. Dot size runs .45→1× of the cell with
luminance, so wisp cores read near-solid while fringes break into dots.
Stretch-to-fill, not cover-crop, so both edge wisps survive every aspect.
