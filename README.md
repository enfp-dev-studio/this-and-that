# This & That 3D (spike)

**Sketch it in 3D, say what it is, get a model.** Draw strokes in 3D space the way Blender's Grease Pencil does, rotate and keep drawing, and say what you're drawing ("의자야, 등받이는 이렇게"). Muse Spark looks at the sketch from six viewpoints, reads its 3D coordinates and your words, and answers a part list that becomes a low-poly model in a few seconds. Then you keep editing by drawing on the model and talking ("굴뚝을 이만큼 더 높게").

A time-boxed spike (2026-11-04, 23:30 → 03:00 KST) for the Meta Global AI Developer Hackathon, as the "and it works in 3D too" coda of [This & That](../this-and-that/). All code is new.

## How it works

| Step | Model | What it does |
|---|---|---|
| Draw | (three.js) | Pen or left mouse draws; fingers or right mouse orbit, two fingers / middle mouse pan and zoom. Each stroke is projected onto a drawing plane picked at pen-down: the model's surface under the pen, else a plane through the nearest existing stroke point (so strokes connect in depth), else through the orbit target. The plane faces the camera (시점면) or lies flat (바닥면) and shows as a faint grid. Strokes are 3D polylines with ids and timestamps |
| Hear | **Muse Voice Transcribe** (realtime) | Hold the mic button (or Space, or tap to toggle): 16 kHz PCM streams to the server and on to the realtime endpoint, with live captions. The final text is ready ~0.35 s after release; batch transcription of the same audio is the fallback (~2 s) |
| See | (three.js) | On release, the strokes (and the model, when editing) are rendered from FRONT, SIDE, TOP (orthographic), two 3/4 views and the user's view, each stroke in its own color with its id number. The six thumbnails show while Spark works |
| Understand | **Muse Spark 1.2** (minimal effort, JSON schema, streaming) | Gets the six images, the transcript, and per stroke its id, drawing plane, the direction it was drawn from, 3D bbox and 8 sampled points. Answers `{subject, say, parts[]}`; each part has a primitive (box, cylinder, sphere, cone, capsule, extrude of a stroke outline), center, size, rotation, color, material and the stroke ids it explains. When editing it also gets the current part list and returns the updated one |
| Build | (three.js) | Parts are built as soon as each one is complete in the stream, growing in over the dimmed strokes; then the model turns slowly. A tilted part whose rotation sign fits its own strokes better flipped (Spark once tipped a roof slab the wrong way) is flipped. On an edit, unchanged parts stay, changed ones morph, removed ones shrink away |
| Paint (optional) | **Muse Image** (edit, tools off) | 칠하기 renders the model from the current view, Muse Image repaints it as a finished asset (10–20 s), and the painting is projected back onto the parts from that camera. Muse Image tends to redraw the object slightly smaller or shifted, so the painting's silhouette box is mapped onto the render's (from a flat mask render). Faces turned away from that camera keep their plain color |

## Speed

Spark's thinking time varies 2-3× between identical calls, so the server sends **three identical streaming calls and keeps the first that starts writing** (the others are cancelled). Measured on the chair and house sketches:

| Setup | First part | Whole model |
|---|---|---|
| Spark 1.3, effort low, one call | – | 36–42 s |
| Spark 1.3, minimal, one call | – | 34–38 s |
| Spark 1.2, minimal, one call | – | 8–19 s |
| **Spark 1.2, minimal, 3 hedged streaming calls** | **2.9–6.8 s** | **3.6–8.2 s** |

Quality is similar; 1.3 at low effort was the most consistent about leg counts. Four views instead of six did not save time and placed legs worse.

## Run

```sh
npm install
cp ../this-and-that/.env .env      # MODEL_API_KEY=...
npm run server                     # API on :8795
npm run dev                        # Vite on :5185, proxies /api
```

Open http://localhost:5185. **Tablet:** `adb reverse tcp:5185 tcp:5185`, then open `http://localhost:5185` in Chrome on the tablet (localhost, so the microphone works without HTTPS). `npm start` builds and serves everything on :8795 instead.

Without a pen or mic: draw with the mouse, type the sentence in the box and press Enter. In the console, `demoChair()` / `demoHouse()` add scripted front + side sketches.

`node --env-file=.env server/bench.ts out/jobs/<id> minimal` replays a saved request (`COPIES=1` for a single call). Every request and answer is saved under `out/jobs/`.

## Using it

1. Draw from the front (정면). Rotate (right mouse / finger, or 측면) and draw the side profile. Start a stroke on an existing stroke to draw at its depth.
2. Hold the mic and say what it is while drawing ("의자야, 등받이는 이렇게"), then release. Or type it and press 만들기.
3. Draw on the model and say the change ("이거 더 높게", "여기 손잡이 달아 줘", "문은 파란색으로").
4. 되돌리기 undoes strokes, then whole builds. 다시 만들기 asks again with the same sketch and words.

## Demo clip (20–30 s)

1. Tablet, 정면. Hold the mic with one thumb and draw with the pen: "의자야," seat line, two legs, the back as two posts and a top rail.
2. Tap 측면 and draw the side profile while talking: seat depth, front leg, back leg running up into a reclined back ("등받이는 이렇게 뒤로").
3. Release: the six views Spark looks at appear top right, the parts pop in over the sketch within ~5–8 s, and the chair starts turning.
4. Optional: draw two lines at the side and say "여기 팔걸이 달아 줘" (armrests on both sides, ~8 s), or press 칠하기.

## What works, what doesn't

- Works (browser, mouse): drawing in 3D, multi-view perception, chair and house from front + side sketches (latest prompt: 3/3 chairs with legs and back posts, 3/3 houses with walls, two roof slabs, door, chimney), edits by drawing on the model and talking (taller chimney + blue door 3.6 s; armrests 7.7 s), painting with Muse Image, realtime and batch transcription (synthetic Korean speech).
- Not tried yet: the S Pen and the browser mic on the tablet. The stylus path is the same Pointer Events code (pen draws, fingers orbit, touches near pen activity are ignored as palm), and the mic code mirrors This & That's.
- Varies: hedging takes the fastest answer, which is sometimes the simplest (a solid backrest instead of posts and a rail). 다시 만들기 asks again in ~8 s.
- Paint looks right from the painted direction only; other sides keep their plain colors.

## Layout

- `client/src/scene.ts`: renderer, camera, orbit controls, grid, lights, view presets
- `client/src/sketch.ts`: drawing planes, stroke capture, 3D polylines
- `client/src/views.ts`: the six labeled renders for Spark
- `client/src/build.ts`: parts → low-poly meshes, grow / morph / shrink animations
- `client/src/fit.ts`: rotation sign check against the strokes
- `client/src/paint.ts`: model render, mask, projective painting
- `client/src/voice.ts`: hold-to-talk, PCM streaming, WAV fallback
- `server/meta.ts`: Spark (hedged streaming JSON), Muse Image edit, Voice Transcribe (realtime + batch)
- `server/perceive.ts`: the prompt, the schema, incremental part parsing
- `server/index.ts`: HTTP API (NDJSON stream for perception) and static files
