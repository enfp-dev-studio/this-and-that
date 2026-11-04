// This & That API proxy. The browser does all the work; this Worker only adds
// the Meta API key (which must never reach the browser), checks the demo
// passcode, and caps spend. It streams bodies straight through and keeps no
// state besides the usage counters in the Limiter Durable Object.

import { DurableObject } from 'cloudflare:workers';

export interface Env {
  MODEL_API_KEY?: string;
  DEMO_PASSCODE?: string;
  ALLOWED_ORIGINS?: string;
  IP_DAILY_UNITS?: string | number;
  GLOBAL_DAILY_UNITS?: string | number;
  IP_PER_MINUTE?: string | number;
  ASR_SESSION_SECONDS?: string | number;
  LIMITER: DurableObjectNamespace<Limiter>;
}

const UPSTREAM = 'https://api.meta.ai/v1';
const PREFIX = '/api/meta/';
const MAX_BODY = 30 * 1024 * 1024;

// Allowed upstream paths and the units each request costs.
const ROUTES: Record<string, number> = {
  'chat/completions': 1,
  responses: 1,
  'images/edits': 10,
  'images/generations': 10,
  'asr/transcribe': 1,
};
const REALTIME = 'asr/realtime';
const REALTIME_UNITS = 1;

type Caps = { ipDaily: number; globalDaily: number; ipPerMinute: number };
type Verdict =
  | { ok: true }
  | { ok: false; scope: 'minute' | 'ip' | 'global'; cap: number; retryAfter: number };

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
    const isCheck = path === 'check';
    const isRealtime = path === REALTIME;
    if (!isCheck && !isRealtime && !Object.hasOwn(ROUTES, path)) return notFound(cors);

    // Fail closed when the Worker isn't configured.
    if (!env.DEMO_PASSCODE) {
      return json(503, { error: 'config', message: 'DEMO_PASSCODE is not set on the Worker.' }, cors);
    }
    if (!env.MODEL_API_KEY && !isCheck) {
      return json(503, { error: 'config', message: 'MODEL_API_KEY is not set on the Worker.' }, cors);
    }

    const pass = await checkPasscode(request, env.DEMO_PASSCODE);
    if (!pass.ok) return json(401, { error: 'passcode', message: 'Enter the demo passcode.' }, cors);

    if (isCheck) {
      if (request.method !== 'GET') return methodNotAllowed(cors);
      return json(200, { ok: true }, cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'local';

    if (isRealtime) {
      if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return json(426, { error: 'upgrade', message: 'This endpoint needs a WebSocket upgrade.' }, cors);
      }
      const limited = await limit(env, ip, REALTIME_UNITS, cors);
      if (limited) return limited;
      // A client that offered a ttpass.* subprotocol fails the handshake unless
      // one is echoed, even when the header or cookie is what let it in.
      return relayRealtime(env, ctx, pass.protocol ?? offeredProtocol(request), cors);
    }

    if (request.method !== 'GET' && request.method !== 'POST') return methodNotAllowed(cors);
    const length = request.headers.get('Content-Length');
    if (length !== null && Number(length) > MAX_BODY) {
      return json(413, { error: 'too_large', message: 'Request body is over 30 MB.' }, cors);
    }

    const limited = await limit(env, ip, ROUTES[path], cors);
    if (limited) return limited;

    const headers = new Headers({ Authorization: `Bearer ${env.MODEL_API_KEY}` });
    for (const name of ['Content-Type', 'Accept']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    let body: ReadableStream | null = request.body;
    if (body && length === null) body = body.pipeThrough(capStream(MAX_BODY));

    let upstream: Response;
    try {
      upstream = await fetch(`${UPSTREAM}/${path}${url.search}`, { method: request.method, headers, body });
    } catch (e) {
      return json(502, { error: 'upstream', message: `Could not reach the Meta API (${(e as Error).message}).` }, cors);
    }
    const out = new Headers(cors);
    for (const name of ['Content-Type', 'Cache-Control']) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
} satisfies ExportedHandler<Env>;

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

// ---------- passcode ----------

async function checkPasscode(request: Request, secret: string): Promise<{ ok: boolean; protocol: string | null }> {
  const header = request.headers.get('x-demo-passcode');
  if (header !== null && (await sameSecret(header, secret))) return { ok: true, protocol: null };

  const cookie = readCookie(request.headers.get('Cookie'), 'tt_pass');
  if (cookie !== null && (await sameSecret(cookie, secret))) return { ok: true, protocol: null };

  // Browsers can't set headers on a WebSocket, so the passcode rides in a
  // subprotocol entry: ttpass.<base64url(utf8 passcode), no padding>.
  for (const entry of (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',')) {
    const protocol = entry.trim();
    if (!protocol.startsWith('ttpass.')) continue;
    const value = fromBase64Url(protocol.slice('ttpass.'.length));
    if (value !== null && (await sameSecret(value, secret))) return { ok: true, protocol };
  }
  return { ok: false, protocol: null };
}

function offeredProtocol(request: Request): string | null {
  const entry = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((e) => e.trim()).find((e) => e.startsWith('ttpass.'));
  return entry ?? null;
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

// ---------- limits ----------

function capsFrom(env: Env): Caps {
  return {
    ipDaily: num(env.IP_DAILY_UNITS, 600),
    globalDaily: num(env.GLOBAL_DAILY_UNITS, 6000),
    ipPerMinute: num(env.IP_PER_MINUTE, 60),
  };
}

function num(value: string | number | undefined, fallback: number): number {
  const n = Number(value);
  return value === undefined || value === '' || !Number.isFinite(n) ? fallback : n;
}

// null when the request may go ahead (its units are already counted), else the 429/503 to return.
async function limit(env: Env, ip: string, units: number, cors: Headers): Promise<Response | null> {
  let verdict: Verdict;
  try {
    verdict = await env.LIMITER.get(env.LIMITER.idFromName('global')).take(ip, units, capsFrom(env));
  } catch (e) {
    return json(503, { error: 'limiter', message: `Usage limiter unavailable (${(e as Error).message}).` }, cors);
  }
  if (verdict.ok) return null;
  const message =
    verdict.scope === 'minute'
      ? `Too many requests from your network (${verdict.cap} per minute). Try again in ${verdict.retryAfter} seconds.`
      : verdict.scope === 'ip'
        ? `Daily demo limit reached for your network (${verdict.cap} units). It resets at 00:00 UTC.`
        : `The demo's daily limit for everyone has been reached (${verdict.cap} units). It resets at 00:00 UTC.`;
  return json(429, { error: 'limit', message }, cors, { 'Retry-After': String(verdict.retryAfter) });
}

// One global instance (idFromName('global')). Rows: (bucket, key) -> n, where
// bucket is `d:<UTC day>` (units per IP and `*` for everyone) or `m:<epoch
// minute>` (requests per IP). take() is synchronous inside the object, so the
// check and the increment are atomic.
export class Limiter extends DurableObject<Env> {
  private day = '';
  private minute = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS usage (bucket TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (bucket, key))',
    );
  }

  take(ip: string, units: number, caps: Caps): Verdict {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const day = `d:${new Date(now).toISOString().slice(0, 10)}`;
    const minute = `m:${Math.floor(now / 60_000)}`;
    // Purge old windows when the window changes (keeps the table tiny).
    if (day !== this.day) {
      sql.exec("DELETE FROM usage WHERE bucket LIKE 'd:%' AND bucket <> ?", day);
      this.day = day;
    }
    if (minute !== this.minute) {
      sql.exec("DELETE FROM usage WHERE bucket LIKE 'm:%' AND bucket <> ?", minute);
      this.minute = minute;
    }
    const get = (bucket: string, key: string) =>
      sql.exec<{ n: number }>('SELECT n FROM usage WHERE bucket = ? AND key = ?', bucket, key).toArray()[0]?.n ?? 0;
    const ipKey = `ip:${ip}`;
    const toMidnight = Math.ceil((86_400_000 - (now % 86_400_000)) / 1000); // UTC days are 86400 s in epoch time

    if (get(minute, ipKey) + 1 > caps.ipPerMinute) {
      return { ok: false, scope: 'minute', cap: caps.ipPerMinute, retryAfter: Math.ceil((60_000 - (now % 60_000)) / 1000) };
    }
    if (get(day, ipKey) + units > caps.ipDaily) return { ok: false, scope: 'ip', cap: caps.ipDaily, retryAfter: toMidnight };
    if (get(day, '*') + units > caps.globalDaily) {
      return { ok: false, scope: 'global', cap: caps.globalDaily, retryAfter: toMidnight };
    }

    const add = (bucket: string, key: string, n: number) =>
      sql.exec(
        'INSERT INTO usage (bucket, key, n) VALUES (?, ?, ?) ON CONFLICT (bucket, key) DO UPDATE SET n = n + excluded.n',
        bucket,
        key,
        n,
      );
    add(minute, ipKey, 1);
    add(day, ipKey, units);
    add(day, '*', units);
    return { ok: true };
  }
}

// ---------- realtime ASR ----------

// The client gets its socket at once; the upstream opens in the background and
// client messages queue (in order) until it does. The first client text
// message is the session config without credentials: the key is added here.
function relayRealtime(env: Env, ctx: ExecutionContext, protocol: string | null, cors: Headers): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  // Recent compatibility dates default binaryType to 'blob' (the web standard);
  // send() takes ArrayBuffer, so ask for that on both sockets.
  server.binaryType = 'arraybuffer';
  server.accept();

  let upstream: WebSocket | null = null;
  let configured = false;
  let closed = false;
  const queue: (string | ArrayBuffer)[] = [];

  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    shut(server, code, reason);
    if (upstream) shut(upstream, code, reason);
  };
  // A hard ceiling on one session's length, since audio is billed by the second.
  const timer = setTimeout(
    () => finish(1000, 'Session time limit reached.'),
    num(env.ASR_SESSION_SECONDS, 300) * 1000,
  );

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

// For bodies without Content-Length: error the stream past `max` bytes.
function capStream(max: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > max) controller.error(new Error('Request body is over 30 MB.'));
      else controller.enqueue(chunk);
    },
  });
}

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
