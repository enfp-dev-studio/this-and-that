# Surface edit (3D, spike)

Draw on a textured glTF model and say what to change ("여기에 빨간 초승달 엠블럼을 새겨 줘"); only the marked part of its texture changes, and the change stays on the surface from every angle. It is the 2D feature run on a rendered view of the model, then baked back into the model's textures.

In the app: 3D mode, Open → Sample model, then draw on the model and say the change; marks on its surface with a request to change its look go this way (strokes off it, or "add … here", make parts). Lab page (dev server only, not in the build): `client/surface.html` (`client/src/surface/`). Model: `samples/3d/SciFiHelmet/`, the same copy as 3D mode's sample model, from the [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/SciFiHelmet) (textures resized to 1024 px; its `README.md` and `LICENSE.md` are kept beside it):

> © 2017, Public. [Creative Commons Zero v1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/legalcode) — Michael Pavlovic for Everything
> © 2017, Public. [Creative Commons Zero v1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/legalcode) — Norbert Nopper for Conversion to glTF

(DamagedHelmet was tried first, but its model files are also CC BY-NC 4.0, so it is not used.)

## How it works

1. **Draw and talk.** Pen or left mouse draws marks that stick to the surface (raycast, lifted a hair off it); right mouse or a finger orbits; touches near the pen are ignored. Hold the mic (or Space) to talk, or type.
2. **The 2D pipeline, unchanged.** On release the current view is rendered (without the marks) and handed to `client/src/runtime` like an uploaded picture, with the marks projected into it and the voice: Muse Spark maps the words to the marks, SAM 3.1 finds each marked region, Muse Image edits, and only the marked regions are pasted back. Every other pixel of the result is identical to the render.
3. **Bake** (`bake.ts`). The mesh is rendered unwrapped (in UV space) into a new texture. Each texel projects its surface point into the edited view and takes the edit there only if
   - that pixel changed (|result − render| above a small threshold, so untouched pixels stay exactly as they were),
   - the point was visible in the view (depth test against a depth pass from the same camera),
   - it faced the camera (a facing weight, so oblique areas don't smear).

   Color is transferred as a ratio, new albedo = old × result / render-without-emission, so the view's lighting isn't baked in. Where the edit painted, an emissive map (if the model has one) is turned off, so old glowing lines can't shine through the new design. Contributions are accumulated with their weights, because models often share mirrored UVs between left and right parts (SciFiHelmet's ear grilles do): the part the camera saw outweighs the hidden one.
4. **Undo** restores the previous base-color and emissive textures; **전/후** (hold) shows the originals.

## Run

```sh
PORT=8811 node --env-file=.env server/index.ts                    # /api/meta proxy (key from .env) + built pages
VITE_PORT=5201 META_PROXY=http://localhost:8811 npx vite          # dev, then open http://localhost:5201/surface.html
```

The Node proxy doesn't relay the realtime transcription socket, so speech is transcribed in one batch after release (~2 s more); through the Worker (`npm run worker:dev`) realtime works as in the 2D app.

In the console, `demoTake()` replays a take: it orbits to the front-left view, circles the white crown plate above the visor with pen events, sends "여기에 빨간 초승달 엠블럼을 새겨 줘", bakes, and glides to an upper-right angle. `demoTake('', pcm)` sends 16 kHz PCM as the voice instead.

## Measured (2048×1536 view)

- SciFiHelmet, typed: 15.2 s from release to the baked texture; Spark read "Engrave red crescent emblem on helmet" for the circled crown plate.
- Same pipeline on the earlier test model: 11–19 s typed, 23.5 s spoken (synthetic Korean speech, batch transcription).

## Limits

- Mirrored UVs: an edit on a part whose UVs are shared with its mirror twin (SciFiHelmet's ear grilles) appears on both. Its large panels have their own texels.
- Only the base color (and any emissive glow) change; the normal map keeps the old relief, so an "engraving" is painted, not carved.
- The edit is seen from one view: parts of the marked region the camera couldn't see keep their old texture; a second take from another angle fills them.
