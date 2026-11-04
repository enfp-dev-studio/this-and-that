// This & That API proxy. The browser does all the work; this Worker only adds
// the Meta API key (which must never reach the browser), checks the optional
// demo passcode, checks inputs against fixed limits, and counts usage against
// two global daily caps. Responses stream straight through. The only state is
// the counters in the Limiter Durable Object.

import { DurableObject } from 'cloudflare:workers';

export interface Env {
  MODEL_API_KEY?: string;
  DEMO_PASSCODE?: string;
  ALLOWED_ORIGINS?: string;
  JOBS_PER_DAY?: string | number;
  REQUESTS_PER_DAY?: string | number;
  MAX_MARKS?: string | number;
  MAX_RECORDING_SECONDS?: string | number;
  MAX_IMAGE_SIDE?: string | number;
  ASR_SESSION_SECONDS?: string | number;
  LIMITER: DurableObjectNamespace<Limiter>;
}

const UPSTREAM = 'https://api.meta.ai/v1';
const PREFIX = '/api/meta/';
const MB = 1024 * 1024;

type Body = Record<string, unknown>;
type Route = {
  maxBytes: number;
  models?: string[]; // set = the body must be JSON with one of these models
  check?: (body: Body, env: Env) => string | null; // extra field checks: an error sentence, or null
};

// The only upstream paths allowed, with their input limits.
const ROUTES: Record<string, Route> = {
  'chat/completions': { maxBytes: 8 * MB, models: ['muse-spark-1.2', 'muse-spark-1.3'] },
  responses: { maxBytes: 3 * MB, models: ['sam-3.1'] },
  'images/edits': { maxBytes: 20 * MB, models: ['muse-image-1.0'], check: checkImageEdit },
  'asr/transcribe': { maxBytes: 1.5 * MB }, // multipart (request JSON + WAV): size only
};
const REALTIME = 'asr/realtime';
const MAX_PCM_BYTES = 960_000; // 30 s of 16 kHz mono s16
const JOB_KINDS = ['edit', 'whole', 'build', 'paint'];
const QUOTA = { error: 'quota', message: "Today's free quota is used up. It resets at 09:00 KST (00:00 UTC)." };

type Counter = 'jobs' | 'requests';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = new Headers({ Vary: 'Origin', 'Access-Control-Expose-Headers': 'Retry-After' });

    if (origin !== null) {
      if (!originAllowed(origin, env.ALLOWED_ORIGINS)) {
        return json(403, { error: 'origin', message: `Origin ${origin} is not allowed.` }, cors);
      }
      cors.set('Access-Control-Allow-Origin', origin);
    }

    if (request.method === 'OPTIONS') {
      cors.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      cors.set('Access-Control-Allow-Headers', 'content-type, accept, x-demo-passcode');
      cors.set('Access-Control-Max-Age', '86400');
      return new Response(null, { status: 204, headers: cors });
    }

    if (!url.pathname.startsWith(PREFIX)) return notFound(cors);
    const path = url.pathname.slice(PREFIX.length);

    // Public: what the app needs to know before it asks for anything.
    if (path === 'config') {
      if (request.method !== 'GET') return methodNotAllowed(cors);
      const cap = num(env.JOBS_PER_DAY, 500);
      let used: number | null = null;
      try {
        used = await limiter(env).used('jobs');
      } catch {} // the counts are informational here; the rest of config still helps the app
      return json(200, {
        passcode: Boolean(env.DEMO_PASSCODE),
        limits: {
          maxMarks: num(env.MAX_MARKS, 6),
          maxRecordingSeconds: num(env.MAX_RECORDING_SECONDS, 20),
          maxImageSide: num(env.MAX_IMAGE_SIDE, 2048),
        },
        ...(used === null ? {} : { jobs: { used, cap } }),
      }, cors);
    }

    const isRealtime = path === REALTIME;
    const route = Object.hasOwn(ROUTES, path) ? ROUTES[path] : null;
    if (path !== 'check' && path !== 'job' && !isRealtime && !route) return notFound(cors);

    const pass = await checkPasscode(request, env.DEMO_PASSCODE);
    if (!pass.ok) return json(401, { error: 'passcode', message: 'Enter the demo passcode.' }, cors);

    if (path === 'check') {
      if (request.method !== 'GET') return methodNotAllowed(cors);
      return json(200, { ok: true }, cors);
    }

    // One take (2D edit, whole-picture edit, 3D build, paint) = one job.
    if (path === 'job') {
      if (request.method !== 'POST') return methodNotAllowed(cors);
      const bytes = await readBody(request, 4096);
      const body = bytes && parseJson(bytes);
      const kind = body ? body.kind : undefined;
      if (typeof kind !== 'string' || !JOB_KINDS.includes(kind)) {
        return inputError(400, `kind must be one of ${JOB_KINDS.join(', ')}.`, cors);
      }
      const cap = num(env.JOBS_PER_DAY, 500);
      const counted = await count(env, 'jobs', cap, cors);
      if (counted instanceof Response) return counted;
      return json(200, { ok: true, used: counted, cap }, cors);
    }

    if (!env.MODEL_API_KEY) {
      return json(503, { error: 'config', message: 'MODEL_API_KEY is not set on the Worker.' }, cors);
    }

    if (isRealtime) {
      if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return json(426, { error: 'upgrade', message: 'This endpoint needs a WebSocket upgrade.' }, cors);
      }
      const counted = await count(env, 'requests', num(env.REQUESTS_PER_DAY, 10000), cors);
      if (counted instanceof Response) return counted;
      return relayRealtime(env, ctx, pass.protocol, cors);
    }

    // ---- an upstream HTTP call ----
    const r = route!;
    if (request.method !== 'POST') return methodNotAllowed(cors);
    const tooLarge = () => inputError(413, `The request body is over the ${r.maxBytes / MB} MB limit for ${path}.`, cors);
    const length = request.headers.get('Content-Length');
    if (length !== null && Number(length) > r.maxBytes) return tooLarge();
    const bytes = await readBody(request, r.maxBytes);
    if (!bytes) return tooLarge();

    if (r.models) {
      const body = parseJson(bytes);
      if (!body) return inputError(400, 'The request body must be a JSON object.', cors);
      if (typeof body.model !== 'string' || !r.models.includes(body.model)) {
        return inputError(400, `The model must be ${r.models.join(' or ')} on ${path}.`, cors);
      }
      const problem = r.check?.(body, env);
      if (problem) return inputError(400, problem, cors);
    }

    const counted = await count(env, 'requests', num(env.REQUESTS_PER_DAY, 10000), cors);
    if (counted instanceof Response) return counted;

    const headers = new Headers({ Authorization: `Bearer ${env.MODEL_API_KEY}` });
    for (const name of ['Content-Type', 'Accept']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    let upstream: Response;
    try {
      // The same bytes the client sent.
      upstream = await fetch(`${UPSTREAM}/${path}${url.search}`, { method: 'POST', headers, body: bytes });
    } catch (e) {
      return json(502, { error: 'upstream', message: `Could not reach the Meta API (${(e as Error).message}).` }, cors);
    }
    const out = new Headers(cors);
    for (const name of ['Content-Type', 'Cache-Control']) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    // Streamed through, not buffered (SSE for Spark and SAM).
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
} satisfies ExportedHandler<Env>;

// ---------- input checks ----------

function checkImageEdit(body: Body, env: Env): string | null {
  if (body.n !== undefined && body.n !== 1) return 'Only one image per edit: n must be 1.';
  const max = num(env.MAX_IMAGE_SIDE, 2048);
  const size = typeof body.size === 'string' ? /^(\d+)x(\d+)$/.exec(body.size) : null;
  if (!size || Number(size[1]) > max || Number(size[2]) > max || Number(size[1]) < 1 || Number(size[2]) < 1) {
    return `size must be "WxH" with both sides at most ${max} pixels.`;
  }
  if (body.images !== undefined && (!Array.isArray(body.images) || body.images.length > 10)) {
    return 'images must be a list of at most 10 pictures.';
  }
  return null;
}

// The body, or null once it passes `max` bytes (checked while reading, so a
// body without Content-Length can't get past the limit either).
async function readBody(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    size += chunk.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseJson(bytes: Uint8Array): Body | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Body) : null;
  } catch {
    return null;
  }
}

function inputError(status: 400 | 413, message: string, cors: Headers): Response {
  return json(status, { error: 'input', message }, cors);
}

// ---------- CORS ----------

// Comma-separated exact origins; an entry may use one `*` for a subdomain
// label, e.g. https://*.this-and-that.pages.dev for Pages preview deploys.
function originAllowed(origin: string, list = ''): boolean {
  return list.split(',').map((s) => s.trim()).filter(Boolean).some((entry) => {
    if (!entry.includes('*')) return entry === origin;
    const [head, tail] = entry.split('*', 2);
    if (!origin.startsWith(head) || !origin.endsWith(tail)) return false;
    const label = origin.slice(head.length, origin.length - tail.length);
    return /^[a-z0-9-]+$/i.test(label);
  });
}

// ---------- passcode (optional) ----------

// No DEMO_PASSCODE set = open. Otherwise the passcode may come as the
// x-demo-passcode header, the tt_pass cookie, or (browsers can't set headers
// on a WebSocket) a subprotocol entry ttpass.<base64url(utf8), no padding>.
// An offered ttpass.* protocol is always echoed, or the browser drops the socket.
async function checkPasscode(request: Request, secret?: string): Promise<{ ok: boolean; protocol: string | null }> {
  const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('ttpass.'));
  const protocol = offered[0] ?? null;
  if (!secret) return { ok: true, protocol };

  const header = request.headers.get('x-demo-passcode');
  if (header !== null && (await sameSecret(header, secret))) return { ok: true, protocol };
  const cookie = readCookie(request.headers.get('Cookie'), 'tt_pass');
  if (cookie !== null && (await sameSecret(cookie, secret))) return { ok: true, protocol };
  for (const entry of offered) {
    const value = fromBase64Url(entry.slice('ttpass.'.length));
    if (value !== null && (await sameSecret(value, secret))) return { ok: true, protocol: entry };
  }
  return { ok: false, protocol };
}

async function sameSecret(a: string, b: string): Promise<boolean> {
  // Hash first so both sides have the same length, then compare in constant time.
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function fromBase64Url(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

// ---------- daily caps ----------

function num(value: string | number | undefined, fallback: number): number {
  const n = Number(value);
  return value === undefined || value === '' || !Number.isFinite(n) ? fallback : n;
}

const limiter = (env: Env) => env.LIMITER.get(env.LIMITER.idFromName('global'));

// Today's count after this one, or the 429/503 to return.
async function count(env: Env, counter: Counter, cap: number, cors: Headers): Promise<number | Response> {
  let result: { ok: boolean; used: number };
  try {
    result = await limiter(env).take(counter, cap);
  } catch (e) {
    return json(503, { error: 'limiter', message: `Usage counter unavailable (${(e as Error).message}).` }, cors);
  }
  if (result.ok) return result.used;
  const toMidnight = Math.ceil((86_400_000 - (Date.now() % 86_400_000)) / 1000); // UTC days are 86400 s in epoch time
  return json(429, QUOTA, cors, { 'Retry-After': String(toMidnight) });
}

// One global instance (idFromName('global')) holding per-UTC-day counters:
// rows (bucket = 'd:<YYYY-MM-DD>', key = 'jobs' | 'requests') -> n. take() is
// synchronous inside the object, so the check and the increment are atomic.
export class Limiter extends DurableObject<Env> {
  private day = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS usage (bucket TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (bucket, key))',
    );
  }

  used(counter: Counter): number {
    return this.get(this.today(), counter);
  }

  take(counter: Counter, cap: number): { ok: boolean; used: number } {
    const day = this.today();
    const used = this.get(day, counter);
    if (used + 1 > cap) return { ok: false, used };
    this.ctx.storage.sql.exec(
      'INSERT INTO usage (bucket, key, n) VALUES (?, ?, 1) ON CONFLICT (bucket, key) DO UPDATE SET n = n + 1',
      day,
      counter,
    );
    return { ok: true, used: used + 1 };
  }

  // Today's bucket; rows from earlier days are dropped when the day changes.
  private today(): string {
    const day = `d:${new Date().toISOString().slice(0, 10)}`;
    if (day !== this.day) {
      this.ctx.storage.sql.exec('DELETE FROM usage WHERE bucket <> ?', day);
      this.day = day;
    }
    return day;
  }

  private get(day: string, counter: Counter): number {
    return (
      this.ctx.storage.sql.exec<{ n: number }>('SELECT n FROM usage WHERE bucket = ? AND key = ?', day, counter).toArray()[0]?.n ?? 0
    );
  }
}

// ---------- realtime ASR ----------

// The client gets its socket at once; the upstream opens in the background and
// client messages queue (in order) until it does. The first client text
// message is the session config without credentials: the key is added here.
// A session ends with 1000 "recording too long" after ASR_SESSION_SECONDS or
// past MAX_PCM_BYTES of audio, since audio is billed by the second.
function relayRealtime(env: Env, ctx: ExecutionContext, protocol: string | null, cors: Headers): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  // Recent compatibility dates default binaryType to 'blob' (the web standard);
  // send() takes ArrayBuffer, so ask for that on both sockets.
  server.binaryType = 'arraybuffer';
  server.accept();

  let upstream: WebSocket | null = null;
  let configured = false;
  let closed = false;
  let pcmBytes = 0;
  const queue: (string | ArrayBuffer)[] = [];

  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    shut(server, code, reason);
    if (upstream) shut(upstream, code, reason);
  };
  const timer = setTimeout(() => finish(1000, 'recording too long'), num(env.ASR_SESSION_SECONDS, 30) * 1000);

  const forward = (data: string | ArrayBuffer) => {
    if (!configured) {
      if (typeof data !== 'string') return finish(1011, 'The first message must be the JSON session config.');
      let config: unknown;
      try {
        config = JSON.parse(data);
      } catch {}
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return finish(1011, 'The session config is not a JSON object.');
      }
      data = JSON.stringify({ ...config, authorization: { accessToken: `Bearer ${env.MODEL_API_KEY}` } });
      configured = true;
    }
    try {
      upstream!.send(data);
    } catch {
      finish(1011, 'Could not send to the realtime ASR upstream.');
    }
  };

  server.addEventListener('message', (ev) => {
    if (closed) return;
    if (typeof ev.data !== 'string') {
      pcmBytes += ev.data.byteLength;
      if (pcmBytes > MAX_PCM_BYTES) return finish(1000, 'recording too long');
    }
    if (upstream) forward(ev.data);
    else queue.push(ev.data);
  });
  server.addEventListener('close', (ev) => finish(closeCode(ev.code), ev.reason || 'Client closed.'));
  server.addEventListener('error', () => finish(1011, 'Client socket error.'));

  ctx.waitUntil(
    (async () => {
      try {
        const resp = await fetch(`${UPSTREAM}/${REALTIME}`, { headers: { Upgrade: 'websocket' } });
        const ws = resp.webSocket;
        if (!ws) throw new Error(`upstream answered ${resp.status}`);
        ws.binaryType = 'arraybuffer';
        ws.accept();
        if (closed) return shut(ws, 1000, 'Client left.');
        upstream = ws;
        ws.addEventListener('message', (ev) => {
          if (closed) return;
          try {
            server.send(ev.data);
          } catch {
            finish(1011, 'Could not send to the client.');
          }
        });
        ws.addEventListener('close', (ev) => finish(closeCode(ev.code), ev.reason || 'Upstream closed.'));
        ws.addEventListener('error', () => finish(1011, 'Realtime ASR upstream error.'));
        for (const data of queue.splice(0)) {
          if (closed) break;
          forward(data);
        }
      } catch (e) {
        finish(1011, `Realtime ASR upstream unavailable (${(e as Error).message}).`);
      }
    })(),
  );

  const headers = new Headers(cors);
  if (protocol) headers.set('Sec-WebSocket-Protocol', protocol);
  return new Response(null, { status: 101, webSocket: client, headers });
}

// close() only takes codes that may be sent on the wire: never 1005/1006.
function closeCode(code: number): number {
  if (code === 1000 || code === 1011 || (code >= 3000 && code <= 4999)) return code;
  return code === 1001 || code === 1005 ? 1000 : 1011;
}

function shut(ws: WebSocket, code: number, reason: string) {
  try {
    ws.close(code, truncate(reason, 120));
  } catch {}
}

function truncate(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  while (enc.encode(s).length > maxBytes) s = s.slice(0, -1);
  return s;
}

// ---------- helpers ----------

function json(status: number, body: unknown, cors: Headers, extra: Record<string, string> = {}): Response {
  const headers = new Headers(cors);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

function notFound(cors: Headers): Response {
  return json(404, { error: 'not_found', message: 'Not an allowed API path.' }, cors);
}

function methodNotAllowed(cors: Headers): Response {
  return json(405, { error: 'method', message: 'Method not allowed.' }, cors);
}
