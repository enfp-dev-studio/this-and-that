# This & That

**Point at it, say it, done.** Refine an AI-generated image by drawing and speaking at the same time. Circle the mug and say "이거는 빨간색으로", scribble over the cactus and say "저건 지워 줘", and only those parts change. Every other pixel stays exactly as it was.

Built for the Meta Global AI Developer Hackathon (Indie track), November 2026.

## How it works

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

With a stylus, finger touches on the image are ignored (palm rejection), so one hand can hold the talk button while the other draws.

## Repo layout

- `client/`: Vite + TypeScript web client (canvas, Pointer Events, MediaRecorder)
- `server/`: Node server. `meta.ts` (Meta API calls), `asr.ts` (realtime transcription relay), `render.ts` (video, guide image, paste-back), `pipeline.ts` (prompts and steps), `local.ts` (instant edits), `trace.ts` (timing and usage), `index.ts` (HTTP + jobs)
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
- Tried and left off: starting Muse Image speculatively from the transcript alone, in parallel with Spark (`SPECULATE=1`). It saved ~5 s (median 14.8 s vs 20.9 s) and guessed the mark mapping right 12/12 times, but it passes the transcript as is, so a misheard word ("시계" heard as "시기") gave a wrong edit in 3 of 4 runs, where Spark's reading was right.

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

