# Surface edit (3D, spike)

Draw on a textured glTF model and say what to change ("이 문양을 금색 초승달 엠블럼으로 바꿔 줘"); only the marked part of its texture changes, and the change stays on the surface from every angle. It is the 2D feature run on a rendered view of the model, then baked back into the model's textures.

Page: `client/surface.html` (`client/src/surface/`). Model: Khronos DamagedHelmet (`samples/3d/DamagedHelmet.glb`, CC BY 4.0, from KhronosGroup/glTF-Sample-Assets; not committed here, copy it from the main checkout).

## How it works

1. **Draw and talk.** Pen or left mouse draws marks that stick to the surface (raycast, lifted a hair off it); right mouse or a finger orbits; touches near the pen are ignored. Hold the mic (or Space) to talk, or type.
2. **The 2D pipeline, unchanged.** On release the current view is rendered (without the marks) and handed to `client/src/runtime` like an uploaded picture, with the marks projected into it and the voice: Muse Spark maps the words to the marks, SAM 3.1 finds each marked region, Muse Image edits, and only the marked regions are pasted back. Every other pixel of the result is identical to the render.
3. **Bake** (`bake.ts`). The mesh is rendered unwrapped (in UV space) into a new texture. Each texel projects its surface point into the edited view and takes the edit there only if
   - that pixel changed (|result − render| above a small threshold, so untouched pixels stay exactly as they were),
   - the point was visible in the view (depth test against a depth pass from the same camera),
   - it faced the camera (a facing weight, so oblique areas don't smear).

   Color is transferred as a ratio, new albedo = old × result / render-without-emission, so the view's lighting isn't baked in. Where the edit painted, the emissive map is turned off (the helmet's glowing lines would otherwise shine through the new design). Contributions are accumulated with their weights, because DamagedHelmet's left and right halves share mirrored UVs: the half the camera saw outweighs the hidden one.
4. **Undo** restores the previous base-color and emissive textures; **전/후** (hold) shows the originals.

## Run

```sh
PORT=8811 node --env-file=.env server/index.ts                    # /api/meta proxy (key from .env) + built pages
VITE_PORT=5201 META_PROXY=http://localhost:8811 npx vite          # dev, then open http://localhost:5201/surface.html
```

The Node proxy doesn't relay the realtime transcription socket, so speech is transcribed in one batch after release (~2 s more); through the Worker (`npm run worker:dev`) realtime works as in the 2D app.

In the console, `demoTake()` replays a take: it orbits to the front, circles the forehead crest with pen events, sends "이 문양을 금색 초승달 엠블럼으로 바꿔 줘", bakes, and glides to a side angle. `demoTake('', pcm)` sends 16 kHz PCM as the voice instead.

## Measured (DamagedHelmet, 2048×1536 view)

- Typed sentence: 11–19 s from release to the baked texture; spoken (batch transcription): 23.5 s.
- Spark read "Replace forehead pattern with gold crescent emblem" in every run, from text and from synthetic Korean speech.

## Limits

- Mirrored UVs: an edit on one side of the helmet also appears on the other side, because both halves share the texels. The center strip (crest, visor, chin) has its own texels.
- Only the base color and the emissive glow change; the normal map keeps the old relief, so an "engraving" is painted, not carved.
- The edit is seen from one view: parts of the marked region the camera couldn't see keep their old texture; a second take from another angle fills them.
