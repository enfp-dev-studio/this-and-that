# This & That

**Point at it, say it, done.** Refine an AI-generated image by drawing and speaking at the same time. Circle the mug and say "이거는 빨간색으로", scribble over the cactus and say "저건 지워 줘", and only those parts change. Every other pixel stays exactly as it was.

Built for the Meta Global AI Developer Hackathon (Indie track), November 2026.

## How it works

The browser records three things at once: the image, a stroke log (each mark gets a number and a colour, and every point carries a timestamp), and your voice. The local server then runs:

| Step | Model | What it does |
|---|---|---|
| 1. Replay | (ffmpeg) | Re-draws the strokes over the image frame by frame, timed exactly as you drew them, with your voice as the soundtrack → mp4 |
| 2. Hear | **Muse Voice Transcribe** | Transcribes the voice. Shown as captions, and given to Spark as a hint |
| 3. Understand | **Muse Spark 1.3** | Watches the drawing video *with its audio* and works out which instruction belongs to which mark: "this" means the mark being drawn while the word is spoken. Returns `[{mark, target, instruction}]` |
| 4. Find | **SAM 3.1** | Turns each rough mark (circle → box prompt, scribble → box + points) into an exact object mask |
| 5. Edit | **Muse Image** | Edits the original, given a guide image with the numbered marks and the list of instructions |
| 6. Paste back | (sharp) | Takes only the SAM regions (grown and feathered) from the edit and blends them into the original. Outside them, the result is the original byte for byte |

Steps 2–3 run alongside step 4. One round trip takes about 20–25 s, most of it the image edit.

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
- `server/`: Node server. `meta.ts` (Meta API calls), `render.ts` (video, guide image, paste-back), `pipeline.ts` (prompts and steps), `index.ts` (HTTP + jobs)
- `m0/`: the risk-spike scripts used to choose the approach (synthetic Korean clips made with `say -v Yuna`)
- `samples/desk.png`: demo image generated with Muse Image during the hackathon

## What the spike found (M0)

- Spark 1.3 at `reasoning_effort: minimal` mapped every spoken instruction to the right mark from video and audio alone (6/6 runs, 4–10 s). Default effort was just as accurate but took 13–29 s.
- Spark sometimes mishears a single word in the audio track. Giving it the Voice Transcribe text as a hint fixed that, so the app does this.
- Muse Image applied every marked instruction (recolour, remove, change, turn to look). It also drifts the rest of the image slightly (about 5/255 per channel), which the SAM paste-back removes entirely.
