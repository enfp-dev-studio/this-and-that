# This & That

**Point at it, say it, done.** Refine an AI-generated image by drawing and speaking at the same time. Circle the mug and say "이거는 빨간색으로", scribble over the cactus and say "저건 지워 줘", and only those parts change. Every other pixel stays exactly as it was.

Built for the Meta Global AI Developer Hackathon (Indie track), November 2026.

One app, two modes (the switch is in the top bar):

- **Image** (the core): refine a picture by marking it and talking, as described below.
- **3D sketch mode (beta)**: draw strokes in 3D space, rotate and keep drawing, and say what it is ("의자야, 등받이는 이렇게"). Muse Spark looks at the sketch from six sides and answers a part list that becomes a low-poly model in a few seconds; keep editing by drawing on the model and talking, and paint it with Muse Image. Open it with the **3D** switch or `http://localhost:8787/#3d`. Details: [docs/3d-sketch-mode.md](docs/3d-sketch-mode.md).

Both modes use the same hold-to-talk button, realtime captions, QuickShape and theme, and one server.

## How it works (image mode)

The browser uploads the image once. While you talk, each mark goes to the server the moment its stroke ends, so SAM outlines it before you have finished speaking, and your voice streams to the server for realtime transcription. On release the server runs:

| Step | Model | What it does |
|---|---|---|
| 1. Find (during recording) | **SAM 3.1** | Turns each rough mark into an exact object mask (circle → box prompt, scribble → box + points), on a 768 px copy. The client tints the masks right away |
| 2. Hear (during recording) | **Muse Voice Transcribe** (realtime) | Transcribes the voice as you speak: live captions, and the final text ~0.3 s after release. Given to Spark as a hint. The batch endpoint is the fallback |
| 2′. Replay | (ffmpeg) | Re-draws the strokes over the image frame by frame, timed as you drew them, with your voice as the soundtrack → 512 px mp4 |
| 3. Understand | **Muse Spark 1.3** | Watches the drawing video *with its audio* and works out which instruction belongs to which mark: "this" means the mark being drawn while the word is spoken. Returns `[{mark, kind, op, target, instruction}]`, which the client lists at once |
| 4a. Instant edits | (local) | Recolor, brighter/darker and bigger are done on the server inside the SAM mask in ~0.2 s and shown immediately (⚡ instant) |
| 4b. Edit | **Muse Image** | Everything else (remove, add, reshape, move, redraw): edits the original, given a guide image with the numbered marks and the list of instructions (JPEG in and out) |
| 5. Paste back | (sharp) | Takes only each mark's SAM region plus what the edit clearly changed right next to it (grown and feathered) and blends it into the original. Outside that, the result is the original byte for byte |

Edits that are all instant come back in about 6 s. Anything that needs Muse Image takes about 13–22 s from release, most of it Muse (10–19 s, and it varies a lot). The outlines appear as you draw, the understood instructions after 5–9 s, instant edits right after them, and a sheen runs over the regions still being edited.

Every job writes its per-stage timing and the token usage of each call to `out/jobs/<id>/trace.json`. `node --env-file=.env m0/bench.ts` replays the test clips the way the client sends them and prints both. At list prices one edit costs about $0.02–0.03: Muse Image $0.01 per image, SAM $0.0025 per mark, Spark ~3k input + ~0.7k output tokens (~$0.007), transcription $0.18 per hour of audio.

## References, experiment mode and tasks

- **References.** Add reference pictures in the side panel (a character sheet, a style, a detail like an ornament). An open reference sits beside the picture, and marks on it share the take and the numbering with marks on the picture: circle the ornament on the reference, circle the brooch on the picture, say "이거 이렇게 바꿔 줘". Spark watches both side by side and is told which mark is on which image; Muse Image gets crops around the reference marks, plus pinned references ("always include", e.g. a character sheet), as extra images. Only the picture is pasted.
- **Experiment mode** (top bar) does the same task four ways: Type (typed request, whole-picture edit), Voice (spoken, no marks, whole picture), Pen (marks + voice) and Ref (marks + voice + reference). It logs per round the input time, characters or speech seconds, marks and wait, and per trial the rounds until Keep and the total, in a table you can export as JSON or CSV.
- **Tasks** (top bar) loads five production-style corrections on our own illustrations: a brooch to match a reference ornament, a cuff's lace to match the other cuff, a more resolute expression kept on-model, a hairpin redesigned from a reference, and a six-finger hand. `scripts/make-illustrations.ts` and `scripts/make-tasks.ts` make the pictures with Muse Image; no other artists' work is used.

## Setup

Needs Node 23.6+ (runs TypeScript directly), ffmpeg on the PATH, and a Meta model API key.

```sh
npm install
echo "MODEL_API_KEY=your-key" > .env
```

## Run

```sh
npm start            # builds the client and serves everything on http://localhost:8787
```

For development, run `npm run server` and `npm run dev` (Vite on :5173, proxies `/api` to :8787).

**On an Android tablet:** connect it over USB with USB debugging on, then

```sh
adb reverse tcp:8787 tcp:8787
```

and open `http://localhost:8787` in Chrome on the tablet. Because it is `localhost`, the microphone works without HTTPS.

## Using it

1. **Open** an image (or paste or drop one), or press **Sample**.
2. Hold the talk button, or tap it once, or just start drawing. Then draw marks and talk at the same time: "이거는 빨간색으로 바꾸고, 저건 지워 줘."
3. Release (or tap again) to send. Watch the progress, the caption and the list of understood edits.
4. Drag the before/after slider. **Keep** makes the result the new image to keep refining, **Discard** throws it away, **Undo** goes back a version.

The canvas fills the window and the tools float over it: the name and Undo/Redo at the top left, the mode switch and the Point/Shape pens in the centre, Open, Export and the details sheet at the top right, the talk button at the bottom, and the zoom at the bottom right. Wheel or pinch zooms the picture around the pointer, right or middle drag (or two fingers, once a pen is in use) pans, and the bottom-right button fits it back to the screen. In 3D sketch mode the same chrome holds Undo, the drawing plane, sketch visibility and Clear; the view presets and zoom-to-fit sit at the bottom right over an infinite floor grid, and the part under the pointer glows.

QuickShape: end a stroke and hold the pen still for about 0.4 s, and it snaps to the shape it was meant to be when the fit is close: a nearly straight stroke to a line, a loop to an ellipse or circle, a line ending in a hook or V to a straight arrow; anything else stays freehand. The snapped shape is what Spark and SAM get. A quick tap on it (within 2.5 s) or Undo brings the freehand stroke back.

With a stylus, finger touches on the image are ignored (palm rejection, the pen toggle in the toolbar), so one hand can hold the talk button while the other draws. Undo/Redo and the History list move between kept versions; Before / After compares a pending result, or the current version with the previous one. The sun/moon button switches light and dark.

## Repo layout

- `client/`: Vite + React + Tailwind + shadcn/ui. `editor/engine.ts` is the image editor without UI (canvas, Pointer Events, MediaRecorder, realtime captions, jobs, history); `three/` is 3D sketch mode (three.js scene, 3D strokes and drawing planes, multi-view renders, part builder, paint projection; `three/engine.ts` is its engine, loaded only when 3D opens); `components/` is the layout built only from shadcn components (`three-mode.tsx` is the 3D view). Every colour and radius lives in `client/src/theme.css` (shadcn variables, light and dark, plus `--mark-1..6` and `--viewport`), so a new theme is a new copy of that one file
- `server/`: one Node server for both modes. `meta.ts` (Meta API calls, shared: deadlines and retries, hedged streaming Spark for 3D), `asr.ts` (realtime transcription relay, shared), `render.ts` (video, guide image, paste-back), `pipeline.ts` (prompts and steps), `local.ts` (instant edits), `trace.ts` (timing and usage), `index.ts` (HTTP + jobs); `3d/routes.ts` (the `/api/3d/*` routes) and `3d/perceive.ts` (the 3D prompt, schema and streamed part parsing)
- `scripts/`: `bench-spec.ts`, `bench-sketch.ts` (image mode), `bench-3d.ts` (replays a saved 3D request), `check-ui.mjs`
- 3D sketch mode started as a separate spike; its commits are kept in this history (subtree merge), then it moved into the app
- `m0/`: spike and benchmark scripts (synthetic Korean clips made with `say -v Yuna`; `clipkit.ts` builds and replays them, `bench.ts` times the app, `bench-vs.ts` compares it with text-only editing)
- `samples/desk.png`: demo image generated with Muse Image during the hackathon

## What the spike found (M0)

- Spark 1.3 at `reasoning_effort: minimal` mapped every spoken instruction to the right mark from video and audio alone (6/6 runs, 4–10 s). Default effort was just as accurate but took 13–29 s.
- Spark sometimes mishears a single word in the audio track. Giving it the Voice Transcribe text as a hint fixed that, so the app does this.
- Muse Image applied every marked instruction (recolour, remove, change, turn to look). It also drifts the rest of the image slightly (about 5/255 per channel), which the SAM paste-back removes entirely.

## Speed work (M2)

- Muse Image renders about 2.4 MP whatever it is given, so cropping around the marks or shrinking the input did not make it faster. JPEG instead of PNG (8.5 MB → 0.9 MB upload) and JPEG output saved about 1 s. `reasoning_strength: low` halves its input tokens but is not faster.
- Spark's latency follows the length of its answer, not the video size. A 512 px video uses about 10% fewer prompt tokens at the same accuracy. Short answer fields help; dropping the per-mark "heard" text was faster but cost accuracy, so it stays.
- SAM now runs per mark while you talk, off the critical path.
- Muse Image runs with its tools off (image search, web search, shell): same quality and median (~9.8 s over 12 runs each), but no more slow tool-using calls (max 15.9 → 11.8 s). `reasoning_strength: low` on top halves input tokens but is no faster, and edits are billed per image.
- Realtime transcription during recording: the transcript is ready 0.24–0.29 s after release instead of 1.0–1.6 s, and gives live captions.
- Instant edits: recolor, tone and enlarge run locally (all-local edits ~6 s instead of 15–22 s). Moving or shrinking leaves a hole that a local fill could not make look right, so those still go to Muse Image.
- Speculation (`SPECULATE`, now on by default, `SPECULATE=0` turns it off): Muse Image starts from the transcript alone, guessing that the n-th "this/that" goes with the n-th mark, while Spark checks the guess; a wrong guess falls back to Spark's reading. At first it passed a misheard word ("시계" heard as "시기") into the edit in 3 of 4 browser runs. See "Speculation, re-tested" below.

## Robustness

- Every model call has a deadline and one retry with a short backoff: Muse Image 40 s, Spark 20 s (45 s for the background parts pass), SAM 10 s, Voice Transcribe 10 s. Muse Image sometimes takes 200+ s or answers a content-filter 400; the deadline cuts the first, the retry often gets past both. Lower them by env (`MUSE_TIMEOUT_MS=500`, `SPARK_TIMEOUT_MS`, `SAM_TIMEOUT_MS`, `TRANSCRIBE_TIMEOUT_MS`) to rehearse failures.
- The realtime transcription socket must open within 4 s, and the client waits at most 3 s for its last audio chunks; otherwise the recording is transcribed in one batch.
- If an edit still fails, the canvas says "That edit didn't come through" with **Try again**. The marks stay on the picture, and the resend reuses what the server already understood (transcript and Spark's mapping), so it goes straight to Muse Image. The client also gives up on its own after 150 s, so it is never stuck "working".
- Voice Transcribe is told the picture's part names as `keywords` (Korean and English, from the background parts pass; references included), so "브로치" or "머리핀" is heard as said.

## Speculation, re-tested (`scripts/bench-spec.ts`)

With the part names as Voice Transcribe keywords, a run counts as right when the speculative edit was taken and built from what was said:

| | taken, right | skipped (fell back to Spark) | taken, wrong |
|---|---|---|---|
| replay, 10 clips that need Muse Image (desk a b c e; part words brooch pin cameo parasol sword star) | 9 | 1 | 0 |
| browser, fake mic through the real client (a b c e brooch pin) | 5 | 1 | 0 |

Strictly letter by letter the replay is 7/10: "카메오 브로치" came back as the English keyword "cameo brooch", and one word was echoed ("바꾸고, 바꾸고"), which the clause splitter drops; both edits were right. The skips: the ASR glued "저" to the next word, and in the browser "이 브로치는" was heard as "비브로 치는"; the clause count then didn't match the marks, so Spark (which heard "brooch") decided. Clips d and f are all instant edits, where speculation doesn't apply. Median release → result 18.3 s with speculation vs 20.2 s without on the same clips; Muse Image's own spread (12–45 s tonight, one 40 s deadline + retry in each mode) is larger than the saving. Speculation is skipped for Shape-pen marks and when the speech says 이렇게 / 이 모양 / like this, and a sketch in Spark's reading rejects it.

## Drawing a new shape (`sketch` marks)

A mark can select a thing or draw its new shape. Spark gives a mark kind `sketch` when the person says so (이렇게, 이 모양으로, like this) and the stroke is a deliberate contour rather than a loop around the object; the part names under a mark say what is being changed, not that the mark only selects it. For a sketch, Muse Image is told to reshape the target so its edge follows the line exactly, and gets the line alone (black on white, same size and place) as an extra image; the paste region is the old part's SAM mask plus the stroke's hull, so a larger new shape isn't clipped. Sketches never run as instant edits.

The toolbar's **Point / Shape** toggle forces the intent (neither pressed = auto): a Shape-pen mark is always a sketch, a Point-pen mark never is.

The part tags (a background Spark pass per picture) are background information only: never shown in the everyday app (hover labels and part outlines appear only with `?lab`, as a debug aid), never a snap or suggested selection, and never above what was drawn and said. Spark gets them last, as "optional vocabulary for naming things", with the rule that the strokes and words decide and that a part under a mark doesn't make it a selection. SAM's target and the paste region come from the stroke alone. The one place the names help is invisible: Voice Transcribe keywords.

`scripts/bench-sketch.ts`: the knight's left pauldron redrawn as three spikes while saying "이 어깨갑주를 이렇게 뾰족하게 바꿔 줘". Before this change Spark called it an object mark ("make pointed") and Muse added one generic spike; now Spark picks `sketch` on its own (2/2 auto runs) and the result follows the drawn spikes (4/4 runs reshaped along the line; how tall the spikes come out varies by run). Results: `out/sketch/{old-auto,new-auto,new-shape,new-auto-2,new-shape-2}.jpg` (original | marks | result).

## Same model, different input (benchmark)

`m0/bench-vs.ts` makes six pictures with Muse Image and asks for one change in each, two ways: typed as a chat instruction to Muse Image ("remove the coffee cup on the left"), and through This & That (a circle drawn while saying it in Korean, synthetic voice). Drift is the share of pixels outside the intended region that changed by more than 24/255. Side-by-side images are written to `out/bench/`.

| Case | Text-only: success / drift / time | This & That: success / drift / time |
|---|---|---|
| remove a cup | ✓ / 18.6% / 12.1 s | ✓ / 3.0% / 14.0 s |
| recolor a door | ✓ / 7.2% / 14.1 s | ✓ / 0% / 4.0 s (instant) |
| add a sleeping cat | ✓ / 2.4% / 12.9 s | ✗ cat added but sitting: the synthetic voice's "자는" was transcribed as 다른/작은/자른 in all runs / 0% / 14.3 s |
| move a floor lamp | ✓ / 5.8% / 13.3 s | ✓ / 2.8% / 22.4 s |
| make a clock square | ✓ / 5.6% / 14.3 s | ✓ / 0.6% / 17.3 s |
| hand to thumbs-up | ✓ / 6.8% / 15.4 s | ✓ / 1.2% / 14.7 s |

Text-only Muse Image got every change right on the first try, so the win is not the edit itself: it redraws the whole picture, changing 2–19% of the pixels you didn't ask about (7.7% on average), while This & That changes 0–3% (1.3%), and you never have to describe where ("on the left"). Simple edits are also 3× faster. An earlier version lost 4 of 6 cases because its paste region was too tight (leftover steam, a door edge, a cut-off lamp); that is what the paste-what-changed-nearby rule fixes.

## License

MIT, see [LICENSE](LICENSE).
