# Browser runtime (Cloudflare build)

On the `browser-runtime` branch the whole app runs in the browser: the static build goes on Cloudflare Pages, and one stateless Worker (`worker/`) adds the Meta API key, checks a demo passcode and caps the cost. There is no server state. How to deploy it: [deploy-cloudflare.md](deploy-cloudflare.md).

## What moved where

| Was on the Node server | Now in the browser (`client/src/runtime/`) |
|---|---|
| `server/index.ts` (images, marks, jobs, priors, realtime ASR sessions) | `index.ts`: the same steps and job states, read by the editor the way it used to poll |
| `server/pipeline.ts`, `server/local.ts` (prompts, speculation, parts, instant edits) | `pipeline.ts`, `local.ts`: same code, pixels from Canvas instead of sharp |
| `server/render.ts`: ffmpeg video, sharp guide image and paste-back | `render.ts`: WebCodecs H.264 + Opus (AAC where Opus isn't offered) muxed with `mp4-muxer`; Canvas for the guide image, crops, outlines and paste-back |
| `server/meta.ts` with the key | `meta.ts`: the same calls (deadlines, one retry, hedged streaming Spark for 3D) through `/api/meta/*` on the Worker |
| `server/asr.ts` relay | `RealtimeAsr` in `meta.ts`: a WebSocket to the Worker, which adds the key to the first message |
| `server/3d/*` | `perceive.ts` (3D perception + Muse Image painting) |
| `out/jobs/<id>/…` files | `store.ts`: IndexedDB (`images`, `jobs`, `traces`, `parts`, `sessions` with versions and references, `models` for 3D) and OPFS for blobs (`images/<id>.jpg`, `jobs/<id>/{voice.wav,video.mp4,edited.jpg}`); `navigator.storage.persist()` is asked on load |

Storage stays bounded: 10 s after load the app drops pictures not used by the last 5 sessions (older than an hour) and the voice, video and raw edit files of all but the last 30 jobs; records and traces stay.

After a reload the empty state offers "Continue where you left off": the last session's versions and references come back from OPFS under their own ids (with their part names from IndexedDB), and Undo/Redo work across them.

The mic is captured once as 16 kHz PCM (`editor/live-asr.ts`): it streams to realtime transcription, and the same samples are the voice track of Spark's video and the batch fallback's WAV. The UI is unchanged except for one shadcn Dialog that asks for the demo passcode (`components/passcode-gate.tsx`) and a toast when a demo limit is reached.

Limits the app keeps to (the Worker reports them at `GET /api/meta/config` and checks what it can see itself, see [deploy-cloudflare.md](deploy-cloudflare.md)): at most 6 marks per edit (one per mark colour), a take of at most 20 s (it is sent when the time is up), pictures up to 40 MB / 60 MP (scaled to ≤2048 px before anything is sent). Each take (an edit, a typed whole-picture edit, a 3D build, a paint) is counted once at `POST /api/meta/job` against the free daily jobs; when they are used up the take doesn't start and a toast says "Today's free quota is used up". A small info button beside the name opens the privacy note.

`server/` is kept unchanged as the fallback (Cloudflare Tunnel to `npm start` on the `master` checkout).

## How Spark sees the drawing

Two ways were built and measured on the six bench clips (a–f, desk picture, synthetic Korean voice, realtime ASR transcript as hint, speculation off):

| | mapping right | Spark (median, range) |
|---|---|---|
| Video: WebCodecs H.264 + Opus in MP4, as on the server | 6/6 every round (5 rounds, 34 clip runs) | ~5.5 s (2.7–8.3 s) |
| Key frames (one per finished mark) + transcript words with when each first appeared in the realtime partials | 6/6 (1 round) | ~12 s (5.9–16.1 s) |

Both mapped every mark right, but Spark takes about twice as long on the key frames, so the video is the default. The key frames are used only where the browser has no `VideoEncoder` (or when `?understand=frames` is given to the bench). Spark was checked separately to accept H.264 + Opus MP4 and to hear its audio (`이거는 빨간색으로 바꾸고 저건 지워줘` transcribed from the Opus track), and the browser's MP4 and the server's ffmpeg MP4 of the same clip gave the same Spark times (4 calls each, alternating: median 4.5 s and 5.1 s). The video is encoded at 300 kbit/s (~100–160 KB for 5 s, like ffmpeg's): a 4× larger file was no faster for Spark and is slower to upload from a tablet.

## Timings against the Node server

Same clips, same machine, run back to back (`m0/bench.ts` against the Node server on :8801, `client/bench.html` against `wrangler dev` on :8801), release → result:

| | Node server (2 rounds) | Browser + Worker (3 rounds) |
|---|---|---|
| Clips that need Muse Image (a b c e), median | 20.2 s (16.6–28.9, 8 runs) | 20.2 s (17.9–27.1, 12 runs) |
| All-instant clips (d f), median | 4.7 s (2.9–7.0, 10 runs) | 6.1 s (3.9–7.5, 10 runs) |
| The two rounds run closest in time: Muse / instant | 20.2 s / 5.1 s | 20.1 s / 5.4 s |
| Building the video | 237–356 ms (ffmpeg) | 57–119 ms (WebCodecs) |
| Paste-back | ~200 ms (sharp) | 88–110 ms (Canvas) |
| Storing the result | 80–110 ms | ~35 ms |
| Realtime transcript ready after release | 0.23–0.48 s | 0.32–0.67 s |

Model time dominates and varies more between runs than the two versions differ (Muse Image 10–28 s, Spark 1.9–8.3 s); the instant clips are nearly all Spark time. The proxy itself adds nothing measurable: the same small chat completion took 1.6–2.6 s direct and 1.3–2.5 s through the Worker. Through the real UI (fake mic, synthetic strokes): 13.2 s for clip b in development and 14.3 s for clip a from the production build served cross-origin against the Worker (speculation on, as in the app).

3D mode: the scripted chair builds in 15.1 s (6 parts, Spark 6.4 s, first part 5.3 s; the server version took 14–17 s); "양쪽에 팔걸이 달아 줘" by voice adds both armrests 5.0 s after release; painting with Muse Image 8.8 s.

Public build (Worker v2: optional passcode, daily job cap, input limits): bench a–f 6/6 again (a 21.4, b 19.4, c 19.5, d 4.8, e 20.1, f 6.2 s); with no passcode the app opens straight to "Try a sample" and an edit counts exactly one job; with the job cap reached a take is refused at once with "Today's free quota is used up"; with a passcode set, the production build asks once, remembers it, and an edit runs cross-origin in 14.8 s. Main thread: the longest blocking task per job is 130–330 ms on this Mac (local edits and paste-back at full size).

Also checked: references (rose brooch reference → brooch redesigned, 31 s, Muse 23.8 s), a Shape sketch (pauldron spikes, kind `sketch`), Keep → next version, the passcode prompt (wrong passcode refused), a 429 shown as "Demo limit reached · Too many requests from your network (3 per minute). Try again in 45 seconds."

Two browser details that cost time until fixed: `canvas.toBlob` / `convertToBlob` wait for idle time and took 1.0 s for any size, so images are encoded with `toDataURL` (~30 ms for 1920×1280 JPEG); and the first video of a page paid ~2 s for probing codecs, so `warmUpVideo()` does that once after load.

## Running it locally

```sh
npm run worker:dev   # wrangler dev on :8801 (reads worker/.dev.vars)
npm run dev:web      # Vite on :5191, /api/meta → :8801 (adds the passcode from .dev.vars)
```

Bench: open `http://localhost:5191/bench.html?clips=a,b,c,d,e,f` (needs the clips in `out/m0/`, made by `m0/make-clips.ts`). Options: `&runs=n`, `&understand=frames`, `&speculate=1`, `&instant=0`.
