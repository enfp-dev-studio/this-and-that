# Deploying to Cloudflare

## What runs where

| Piece | Where | What it does |
| --- | --- | --- |
| Web app | Static-assets Worker `this-and-that` (`web/wrangler.jsonc`) → **https://this-and-that.enfpdev.workers.dev** | The static build of `client/` (`npm run build:web` → `dist/`), no code. All app logic runs in the browser. |
| API proxy | Worker `this-and-that-api` (`worker/wrangler.jsonc`) → **https://this-and-that-api.enfpdev.workers.dev** | Adds the Meta API key, checks inputs and quotas, and streams responses back. Nothing else. |

The web app was meant for Cloudflare Pages, but `wrangler pages deploy` (4.157) failed with "Missing entry-point", so it is a Worker with static assets instead, on the same workers.dev subdomain.

The Meta API key exists only as a Worker secret. The browser never receives it.

### Worker endpoints (all under `/api/meta/`)

| Path | What it does | Passcode (if set) | Counts as |
| --- | --- | --- | --- |
| `GET config` | Returns `{ passcode, limits: { maxMarks, maxRecordingSeconds, maxImageSide }, jobs: { used, cap } }` | no | nothing |
| `GET check` | Returns 200 if no passcode is needed or the passcode is right, 401 otherwise | yes | nothing |
| `POST job` with body `{ "kind": "edit" \| "whole" \| "build" \| "paint" }` | Called once per take. Returns `{ ok, used, cap }` | yes | 1 job |
| `POST chat/completions`, `responses`, `images/edits`, `asr/transcribe` | Proxies to `https://api.meta.ai/v1/<path>` | yes | 1 request |
| `GET asr/realtime` (WebSocket) | Proxies to `wss://api.meta.ai/v1/asr/realtime` | yes | 1 request per session |

Any other path returns 404, including `images/generations`.

## What's protected, and how

1. **Optional passcode.** When the `DEMO_PASSCODE` secret is set, every route except `config` needs it. The app can send it as the `x-demo-passcode` header, the `tt_pass` cookie, or a WebSocket subprotocol `ttpass.<base64url>`. When the secret is unset or empty, the Worker is open.
2. **Job cap.** The app calls `POST job` once per take: each 2D edit, each 3D build and each paint. After `JOBS_PER_DAY` jobs for everyone together, `job` returns 429 with `{ "error": "quota", "message": "Today's free quota is used up. It resets at 09:00 KST (00:00 UTC)." }` and `Retry-After` set to the seconds until 00:00 UTC.
3. **Request backstop.** This catches clients that skip `job`. Each model request counts 1, and each realtime session counts 1. After `REQUESTS_PER_DAY` for everyone together, those requests get the same 429 quota response.
4. **Input limits.** A violation returns `{ "error": "input", "message": … }` with status 413 for size and 400 for bad fields:
   - Body size: chat 8 MB, responses 3 MB, images/edits 20 MB, asr/transcribe 1.5 MB. The Worker checks Content-Length and also counts the bytes as it reads them.
   - Models: chat `muse-spark-1.2` or `muse-spark-1.3`, responses `sam-3.1`, images/edits `muse-image-1.0`. The Worker parses the JSON, then forwards the same bytes.
   - images/edits: `n` must be absent or 1, `size` must be `WxH` with both sides ≤ `MAX_IMAGE_SIDE`, and `images` may have at most 10 entries.
   - Realtime: the Worker closes the session with 1000 "recording too long" after `ASR_SESSION_SECONDS`, or once the client has sent more than 960,000 bytes of PCM (30 s of 16 kHz s16).
   - `MAX_MARKS` and `MAX_RECORDING_SECONDS` are only reported in `config`. The app enforces them; the Worker doesn't parse prompts.
5. **Meta's own spend limit** on the API account is the last backstop.

The counters live in one SQLite-backed Durable Object (`Limiter`, a single global instance), one row per counter per UTC day. Earlier days are purged automatically. A Durable Object is used rather than KV because free-plan KV allows only 1,000 writes a day and its increments aren't atomic.

## Deploy in one command

`scripts/deploy-cloudflare.sh` runs the steps below in order: deploys the API Worker, pipes `MODEL_API_KEY` (from `../this-and-that/.env`, or `ENV_FILE=…`) and `DEMO_PASSCODE` (from the git-ignored `.deploy-notes.txt`, if it has a `DEMO_PASSCODE=` line) to `wrangler secret put` through stdin without printing them, builds the client with the API URL, and deploys the web app Worker. Then `node scripts/smoke-cloudflare.mjs https://this-and-that-api.enfpdev.workers.dev https://this-and-that.enfpdev.workers.dev` checks the result with one tiny Spark call and one realtime session (no jobs counted): the app and samples are served, CORS, the passcode (refused without, accepted with), Spark and the realtime socket through the Worker.

## Deploy by hand (from the repo root)

Each `wrangler` command runs in the folder of its config (`worker/` for the API, `web/` for the app).

1. Check that Wrangler is logged in. Run `npx wrangler@4 login` only if `whoami` fails:
   ```sh
   npx wrangler@4 whoami
   ```
2. Deploy the API Worker. The first deploy also creates the `Limiter` Durable Object (migration `v1`):
   ```sh
   (cd worker && npx wrangler@4 deploy)
   ```
   It prints `https://this-and-that-api.enfpdev.workers.dev`.
3. Store the API key (required), piped so it never lands in the shell history:
   ```sh
   grep '^MODEL_API_KEY=' ../this-and-that/.env | cut -d= -f2- | tr -d '\n' | (cd worker && npx wrangler@4 secret put MODEL_API_KEY)
   ```
4. Optionally lock the app with a passcode. For the submission it is set (it is in `.deploy-notes.txt`, git-ignored) and given to the judges:
   ```sh
   grep '^DEMO_PASSCODE=' .deploy-notes.txt | cut -d= -f2- | tr -d '\n' | (cd worker && npx wrangler@4 secret put DEMO_PASSCODE)   # lock
   (cd worker && npx wrangler@4 secret delete DEMO_PASSCODE)                                                                  # unlock (open to everyone)
   ```
   Secrets take effect immediately, with no redeploy.
5. Check the API:
   ```sh
   curl https://this-and-that-api.enfpdev.workers.dev/api/meta/config
   ```
6. Build the client with the API URL baked in (`npm run build:web` refuses to build without it):
   ```sh
   VITE_API_BASE=https://this-and-that-api.enfpdev.workers.dev npm run build:web
   ```
7. Deploy the web app:
   ```sh
   (cd web && npx wrangler@4 deploy)
   ```
   It prints `https://this-and-that.enfpdev.workers.dev`. That origin is in `ALLOWED_ORIGINS` in `worker/wrangler.jsonc`; a different one (another account or name) must be added there and the API Worker deployed again (step 2), or the API answers 403.

For later releases, repeat step 2 for Worker changes, and steps 6–7 for client changes.

Through the deployed Worker, `muse-spark-1.2` (3D mode's model) answered `model_not_found` on 2026-11-05 while it worked from a Mac directly; the client then switches 3D builds to `muse-spark-1.3` for the rest of the page (slower to think, same answers).

## Vars

The vars live in `worker/wrangler.jsonc`. To change one, edit the file and redeploy (step 4). Each deploy replaces the vars, so a value changed only in the dashboard is lost on the next deploy.

| Var | Default | Meaning |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | the web app (`this-and-that.enfpdev.workers.dev`), Pages and Pages previews (unused), `localhost:5191`, `127.0.0.1:5191` | Comma-separated browser origins. One `*` may stand for one subdomain label. Requests without an `Origin` header (curl) are allowed. |
| `JOBS_PER_DAY` | 500 | Takes per UTC day, for everyone together |
| `REQUESTS_PER_DAY` | 10000 | Model requests plus realtime sessions per UTC day, for everyone together |
| `MAX_IMAGE_SIDE` | 2048 | Largest `size` side on images/edits (also reported in `config`) |
| `MAX_MARKS` | 6 | Marks per take (reported in `config`, enforced by the app) |
| `MAX_RECORDING_SECONDS` | 20 | Recording length (reported in `config`, enforced by the app) |
| `ASR_SESSION_SECONDS` | 30 | Longest realtime ASR session |

## Today's count and logs

```sh
curl https://this-and-that-api.<sub>.workers.dev/api/meta/config    # jobs: { used, cap }
npx wrangler tail --config worker/wrangler.jsonc                     # live requests and statuses
```

Observability is on, so logs and metrics also appear in the dashboard under Workers & Pages → `this-and-that-api`. Requests that hit a quota show status 429.

## Local development

`worker/.dev.vars` (git-ignored) holds the local secrets. Without a passcode it contains only:

```
MODEL_API_KEY=…
```

Run the Worker and the web app in two terminals:

```sh
npm run worker:dev   # wrangler dev on http://localhost:8801; the Durable Object runs locally too
npm run dev:web      # Vite on http://localhost:5191, proxying /api/meta (WebSocket included) to :8801
```

- **Without a passcode** (the default): no `DEMO_PASSCODE` in `.dev.vars`. Everything is open, and `config` reports `"passcode": false`.
- **With a passcode:** either add `DEMO_PASSCODE=…` to `worker/.dev.vars`, or start the Worker with `npx wrangler dev --config worker/wrangler.jsonc --port 8801 --var DEMO_PASSCODE:localtest`. With the `.dev.vars` line, the Vite proxy adds the passcode for you; start Vite with `VITE_ASK_PASSCODE=1 npm run dev:web` to see the prompt instead. With `--var`, the app always asks.

To test the caps, add `--var` with low values, for example `--var JOBS_PER_DAY:2 --var ASR_SESSION_SECONDS:5`. Local counters are stored in `worker/.wrangler/state/`. Delete that folder to reset them.

## Free-plan notes

- On the Workers Free plan, Durable Objects are available only with SQLite storage, which `Limiter` uses (`new_sqlite_classes`). Each counted call makes one Durable Object request and writes one row, well under the free daily quotas at the default caps.
- The Worker does little CPU work: a passcode hash, one JSON parse, header copies. Waiting on the Meta API is wall time, which doesn't count against the CPU limit. The largest JSON parse is on images/edits bodies of a few MB. If those ever hit the Free plan's 10 ms CPU limit (error 1102), move the Worker to the Paid plan.
- The free plan allows 100,000 Worker requests per day. `REQUESTS_PER_DAY` keeps model traffic far below that.

Fallback: if the Worker can't be used, run the Node server (`npm start`, :8787) and expose it with a Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:8787`).
