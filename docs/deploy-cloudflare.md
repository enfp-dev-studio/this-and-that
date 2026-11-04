# Deploying to Cloudflare

## What runs where

| Piece | Where | What it does |
| --- | --- | --- |
| Client | Cloudflare Pages (project `this-and-that`) | The static build of `client/` (`npm run build` → `dist/`). All app logic runs in the browser. |
| API proxy | Cloudflare Worker `this-and-that-api` (`worker/`) | Adds the Meta API key, checks the demo passcode, caps spend, and streams responses through. Nothing else. |

The Meta API key lives only in the Worker as a secret. The browser never sees it.

### Worker endpoints

All endpoints are under `/api/meta/`. Each request needs the demo passcode, sent in one of three ways: the `x-demo-passcode` header, the `tt_pass` cookie, or (for WebSockets) a `Sec-WebSocket-Protocol` entry `ttpass.<base64url(passcode), no padding>`.

| Path | Upstream | Units |
| --- | --- | --- |
| `GET /api/meta/check` | none (returns `{ "ok": true }`, used by the passcode prompt) | 0 |
| `POST chat/completions`, `responses`, `asr/transcribe` | `https://api.meta.ai/v1/<path>` | 1 |
| `POST images/edits`, `images/generations` | `https://api.meta.ai/v1/<path>` | 10 |
| `GET asr/realtime` (WebSocket) | `wss://api.meta.ai/v1/asr/realtime` | 1 per session |

Any other path returns 404. Bodies over 30 MB return 413. A wrong or missing passcode returns 401. If a cap is reached, the Worker returns 429 with `Retry-After` and a message the app can show. Realtime sessions are closed after `ASR_SESSION_SECONDS` (300 by default).

## First deploy (run these yourself, from the repo root)

1. Log in to Cloudflare:
   ```sh
   npx wrangler login
   ```
2. Store the two secrets. Wrangler prompts for each value, so it never appears in your shell history:
   ```sh
   npx wrangler secret put MODEL_API_KEY --config worker/wrangler.jsonc
   npx wrangler secret put DEMO_PASSCODE --config worker/wrangler.jsonc
   ```
   On a new account, the first `secret put` may offer to create the Worker. Answer yes.
3. Deploy the Worker. This also creates the `Limiter` Durable Object through the `v1` migration:
   ```sh
   npx wrangler deploy --config worker/wrangler.jsonc
   ```
   Note the URL it prints: `https://this-and-that-api.<account-subdomain>.workers.dev`. If the account has no workers.dev subdomain yet, Wrangler asks you to pick one.
4. Check the Worker:
   ```sh
   curl https://this-and-that-api.<sub>.workers.dev/api/meta/check -H 'x-demo-passcode: <passcode>'
   # → {"ok":true}
   ```
5. Build the client with the Worker URL baked in. The client reads `import.meta.env.VITE_API_BASE`; when it is empty, the client calls `/api/meta` on its own origin:
   ```sh
   VITE_API_BASE=https://this-and-that-api.<sub>.workers.dev npm run build
   ```
6. Create the Pages project once, then deploy:
   ```sh
   npx wrangler pages project create this-and-that --production-branch main
   npx wrangler pages deploy dist --project-name this-and-that --branch main
   ```
   `--branch main` makes it a production deploy at `https://this-and-that.pages.dev`. Without that flag, Wrangler uses the current git branch (for example `browser-runtime`), so the result is a preview deploy at `https://<hash>.this-and-that.pages.dev`. Preview deploys work too, because `https://*.this-and-that.pages.dev` is allowed.
7. If Pages gave the project a different URL (for example because the name was taken), add that origin to `ALLOWED_ORIGINS` in `worker/wrangler.jsonc` and redeploy the Worker (step 3). Requests from origins that aren't listed get 403.

Later releases repeat step 3 for Worker changes, and steps 5–6 (minus `project create`) for client changes.

## Configuration

All settings are `vars` in `worker/wrangler.jsonc`. To change one, edit the file and run `npx wrangler deploy --config worker/wrangler.jsonc`. Each deploy replaces the vars, so a change made only in the dashboard is lost at the next deploy.

| Var | Default | Meaning |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | Pages, Pages previews, `localhost:5191`, `127.0.0.1:5191` | Comma-separated list of browser origins. One `*` may stand for a single subdomain label. Requests with no `Origin` header (curl) are allowed but still need the passcode. |
| `IP_DAILY_UNITS` | 600 | Units per client IP per UTC day |
| `GLOBAL_DAILY_UNITS` | 6000 | Units for everyone together per UTC day |
| `IP_PER_MINUTE` | 60 | Requests per client IP per minute (burst cap) |
| `ASR_SESSION_SECONDS` | 300 | Longest realtime ASR session |

Daily counters reset at 00:00 UTC (09:00 KST). They are kept in one SQLite-backed Durable Object (`Limiter`, `idFromName('global')`), and rows from earlier days are purged automatically.

To change the passcode or rotate the key, run `npx wrangler secret put …` again. The new value takes effect at once; no redeploy is needed.

## Usage and logs

- Live request log (method, path, status, exceptions):
  ```sh
  npx wrangler tail --config worker/wrangler.jsonc
  ```
- Observability is turned on, so logs and request metrics are also in the dashboard under Workers & Pages → `this-and-that-api` → Observability / Metrics.
- Requests that hit a cap appear with status 429 in both places.

## Local development

`worker/.dev.vars` (git-ignored) holds the local secrets:

```
MODEL_API_KEY=…
DEMO_PASSCODE=…
```

Run the Worker and the web app in two terminals:

```sh
npm run worker:dev   # wrangler dev on http://localhost:8801 (reads worker/.dev.vars; the Durable Object runs locally too)
npm run dev:web      # Vite on http://localhost:5191, proxying /api/meta → :8801 (WebSocket included)
```

To try the caps locally with low values, add `--var` to the Worker command, for example `npx wrangler dev --config worker/wrangler.jsonc --port 8801 --var IP_PER_MINUTE:3`. Local counters are stored in `worker/.wrangler/state/`. Delete that folder to reset them.

## Free-plan notes

- Durable Objects are available on the Workers Free plan only with the SQLite storage backend. `Limiter` uses that backend (the `new_sqlite_classes` migration). Each counted request makes one Durable Object call and about three row writes, well within the free daily quotas at the default caps.
- The 10 ms CPU limit per request isn't a concern. The Worker hashes the passcode, copies a few headers, and streams the body; time spent waiting on the Meta API is wall time, not CPU time. Free plan request bodies can be up to 100 MB, above the Worker's own 30 MB cap.
- The free plan allows 100,000 Worker requests per day. `GLOBAL_DAILY_UNITS` keeps the demo far below that.

Fallback: if the Worker can't be used, run the Node server from the `master` checkout (`npm start`, :8787; that client still talks to it) and expose it with a Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:8787`).
