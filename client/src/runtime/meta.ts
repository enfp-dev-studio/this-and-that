// Thin wrappers around the Meta model APIs, called from the browser through
// the Worker proxy (/api/meta/* → https://api.meta.ai/v1/*). The Worker adds
// the API key, checks the demo passcode and caps the cost; the key never
// reaches the browser. Muse Spark (video + voice understanding), SAM 3.1
// (rough mark → exact mask), Muse Image (edit) and Muse Voice Transcribe.

import { buildObjectPrompt, decodeMaskToRaster, parseImageStream, recordsOfKind } from '@meta-sam/parser';
import type { Trace } from './trace';

// Empty = same origin (Vite proxies /api/meta to `wrangler dev` in development).
const API_BASE: string = ((import.meta as any).env?.VITE_API_BASE ?? '').replace(/\/$/, '');
const API = `${API_BASE}/api/meta`;

export const MODELS = {
  spark: 'muse-spark-1.3',
  // 3D sketch mode: 1.2 at minimal effort answers a part list in ~12 s; 1.3 thinks ~3x longer for a similar one.
  spark3d: 'muse-spark-1.2',
  image: 'muse-image-1.0',
  sam: 'sam-3.1',
  transcribe: 'muse-voice-transcribe-1.0',
};

// ---------- demo passcode ----------

const PASS_KEY = 'tt-passcode';
let passcode = (() => {
  try {
    return localStorage.getItem(PASS_KEY) ?? '';
  } catch {
    return '';
  }
})();
const passListeners = new Set<() => void>();
const limitListeners = new Set<(e: { error: string; message: string }) => void>();

export const getPasscode = () => passcode;
export function setPasscode(p: string) {
  passcode = p;
  try {
    localStorage.setItem(PASS_KEY, p);
  } catch {}
}
// The app shows its passcode prompt when a call is refused for want of one.
export function onPasscodeNeeded(f: () => void) {
  passListeners.add(f);
  return () => void passListeners.delete(f);
}

// The app shows the Worker's words when a limit is reached (429; error
// 'quota' when today's free jobs are used up).
export function onLimit(f: (e: { error: string; message: string }) => void) {
  limitListeners.add(f);
  return () => void limitListeners.delete(f);
}

// Refusals that a retry can't fix: no passcode, or a demo limit reached.
export class ProxyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function metaFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (passcode) headers.set('x-demo-passcode', passcode);
  const res = await fetch(`${API}/${path}`, { ...init, headers });
  if (res.status === 401 || res.status === 429 || res.status === 503) {
    const j: any = await res.json().catch(() => ({}));
    if (res.status === 401) passListeners.forEach((f) => f());
    if (res.status === 429) limitListeners.forEach((f) => f({ error: j.error ?? 'limit', message: j.message ?? 'Limit reached.' }));
    throw new ProxyError(j.message ?? (res.status === 401 ? 'Enter the demo passcode.' : `HTTP ${res.status}`), res.status);
  }
  return res;
}

// What the Worker allows: whether a passcode is needed, the input limits the
// app keeps to, and today's job count. Defaults if it can't be reached.
export type Config = { passcode: boolean; limits: { maxMarks: number; maxRecordingSeconds: number; maxImageSide: number }; jobs?: { used: number; cap: number } };
const DEFAULT_CONFIG: Config = { passcode: false, limits: { maxMarks: 6, maxRecordingSeconds: 20, maxImageSide: 2048 } };
let config: Config = DEFAULT_CONFIG;
export const configLoaded = fetch(`${API}/config`)
  .then((r) => (r.ok ? r.json() : DEFAULT_CONFIG))
  .then((c: Config) => (config = { ...DEFAULT_CONFIG, ...c, limits: { ...DEFAULT_CONFIG.limits, ...c.limits } }), () => config);
export const limits = () => config.limits;

// One take (an edit, a 3D build, a paint) counts against the free daily jobs.
// Throws a ProxyError when today's quota is used up.
export async function countJob(kind: 'edit' | 'whole' | 'build' | 'paint') {
  const res = await metaFetch('job', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) });
  if (!res.ok) throw new Error(`job: HTTP ${res.status}`);
}

// Is the stored passcode right? (The prompt asks before anything is sent.)
export async function checkPasscode(p = passcode) {
  const res = await fetch(`${API}/check`, { headers: p ? { 'x-demo-passcode': p } : {} });
  return res.ok;
}

// The realtime transcription socket, through the Worker. Browsers can't set
// headers on a WebSocket, so the passcode travels as a subprotocol.
export function realtimeSocket() {
  const http = API_BASE || location.origin;
  const url = `${http.replace(/^http/, 'ws')}/api/meta/asr/realtime`;
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(passcode))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return new WebSocket(url, passcode ? [`ttpass.${b64}`] : []);
}

// ---------- deadlines and retries ----------

// Every model call has a deadline and one retry: Muse Image sometimes takes
// 200+ s or answers a content-filter 400, and the demo must never hang.
export const LIMITS = { spark: 20_000, sam: 10_000, image: 40_000, transcribe: 10_000 };

export async function withRetry<R>(name: string, ms: number, f: (signal: AbortSignal) => Promise<R>): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    const ac = new AbortController();
    // The deadline holds even if a call ignores the signal.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => (timer = setTimeout(() => (ac.abort(), reject(new Error('timeout'))), ms)));
    const call = f(ac.signal);
    call.catch(() => {});
    try {
      return await Promise.race([call, deadline]);
    } catch (e: any) {
      if (e instanceof ProxyError) throw e;
      const why = ac.signal.aborted ? `timed out after ${ms / 1000} s` : String(e?.message ?? e).slice(0, 300);
      if (attempt === 2) throw new Error(`${name} ${why}`);
      console.warn(`[${name}] ${why}; retrying once`);
      await new Promise((r) => setTimeout(r, 800));
    } finally {
      clearTimeout(timer);
    }
  }
}

export const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const postJson = (path: string, body: unknown, signal?: AbortSignal) =>
  metaFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });

async function jsonOrThrow(res: Response) {
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Server-sent events of a streamed response, one parsed `data:` JSON each.
async function* sseEvents(res: Response): AsyncGenerator<any> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
      yield JSON.parse(line.slice(5));
    }
  }
}

// ---------- Muse Spark ----------

// Chat completion with a JSON schema answer. `content` is the user message parts.
export async function sparkJson<T>(opts: { content: any[]; schema: object; model?: string; effort?: string; system?: string; trace?: Trace; label?: string; timeoutMs?: number }): Promise<T> {
  const messages: any[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.content });
  return withRetry(opts.label ?? 'spark', opts.timeoutMs ?? LIMITS.spark, async (signal) => {
    const r = await jsonOrThrow(await postJson('chat/completions', {
      model: opts.model ?? MODELS.spark,
      ...(opts.effort ? { reasoning_effort: opts.effort } : {}),
      messages,
      response_format: { type: 'json_schema', json_schema: { name: 'Answer', schema: opts.schema } },
    }, signal));
    opts.trace?.addUsage(opts.label ?? 'spark', r.usage);
    return JSON.parse(r.choices[0].message.content ?? '{}');
  });
}

// Streaming JSON answer, hedged (3D sketch mode): `copies` identical calls
// race, the first to start writing its answer wins and the others are
// cancelled (Spark's thinking time varies 2-3x between identical calls).
// `onText` gets the answer so far.
export async function sparkStream(opts: { system: string; content: any[]; schema: object; model?: string; effort?: string; copies?: number; timeoutMs?: number; onText?: (text: string) => void }): Promise<{ text: string; usage: any; firstMs: number }> {
  const body = {
    model: opts.model ?? MODELS.spark3d,
    ...(opts.effort ? { reasoning_effort: opts.effort } : {}),
    stream: true,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.content },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'Model', schema: opts.schema } },
  };
  const t0 = Date.now();
  const copies = opts.copies ?? 3;
  const controllers = Array.from({ length: copies }, () => new AbortController());
  const timer = setTimeout(() => controllers.forEach((c) => c.abort()), opts.timeoutMs ?? 60_000);
  let winner = -1;
  const run = async (i: number) => {
    const res = await postJson('chat/completions', body, controllers[i].signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    let text = '', usage: any, firstMs = 0;
    for await (const ev of sseEvents(res)) {
      if (ev.usage) usage = ev.usage;
      const delta = ev.choices?.[0]?.delta?.content;
      if (!delta) continue;
      if (winner === -1) {
        winner = i;
        firstMs = Date.now() - t0;
        controllers.forEach((c, j) => j !== i && c.abort());
      }
      if (winner !== i) return null;
      text += delta;
      opts.onText?.(text);
    }
    return winner === i ? { text, usage, firstMs } : null;
  };
  try {
    const results = await Promise.allSettled(controllers.map((_, i) => run(i)));
    const won = results[winner]?.status === 'fulfilled' ? (results[winner] as PromiseFulfilledResult<any>).value : null;
    if (won) return won;
    const err = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (err?.reason instanceof ProxyError) throw err.reason;
    throw new Error(`spark ${err ? String(err.reason?.message ?? err.reason).slice(0, 300) : 'gave no answer'}`);
  } finally {
    clearTimeout(timer);
  }
}

export const videoPart = (mp4: string, fps = 4) => ({ type: 'video_url', video_url: { url: mp4, fps } });
export const imagePart = (url: string) => ({ type: 'image_url', image_url: { url } });

// ---------- SAM 3.1 ----------

export type Box = { left: number; top: number; right: number; bottom: number };
export type SamObject = { id: number; box?: Box; points?: { x: number; y: number; label?: 'negative' }[] };
// One 0/1 mask per object id, full image size (width × height of the image sent).
export type Mask = { width: number; height: number; data: Uint8Array };

// Segment the objects named by boxes/points in one SAM call. `jpeg`: data URL.
export async function samObjects(jpeg: string, width: number, height: number, objects: SamObject[], trace?: Trace, label = 'sam'): Promise<Map<number, Mask>> {
  const text = buildObjectPrompt({
    size: { width, height },
    objects: objects.map((o) => ({
      id: o.id,
      prompts: [{ ...(o.box ? { box: o.box } : {}), ...(o.points?.length ? { points: o.points } : {}) }],
    })),
  });
  const result = await withRetry(label, LIMITS.sam, async (signal) => {
    const res = await postJson('responses', {
      model: MODELS.sam,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: jpeg }] }],
      stream: true,
      metadata: { mask_encoding: 'one_bit' },
    }, signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    // Pass the events through to the parser, keeping the usage from the last one.
    async function* tap() {
      for await (const ev of sseEvents(res)) {
        if (ev.type === 'response.completed') trace?.addUsage(label, ev.response?.usage);
        yield ev;
      }
    }
    return parseImageStream(tap() as any).finalResult;
  });
  const masks = new Map<number, Mask>();
  for (const rec of recordsOfKind(result.records, 'mask')) {
    const id = Number(rec.objectId);
    const full = masks.get(id) ?? { width, height, data: new Uint8Array(width * height) };
    const raster = decodeMaskToRaster(rec.mask);
    const { left, top, right, bottom } = rec.bounds;
    const bw = right - left;
    const bh = bottom - top;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const my = Math.floor((y * rec.mask.height) / bh);
        const mx = Math.floor((x * rec.mask.width) / bw);
        if (raster[my * rec.mask.width + mx] && top + y < height && left + x < width) full.data[(top + y) * width + left + x] = 1;
      }
    }
    masks.set(id, full);
  }
  return masks;
}

// ---------- Muse Image ----------

// `images`: data URLs. Returns the picture as a Blob.
async function imagesCall(path: string, body: object, trace?: Trace): Promise<Blob> {
  const payload = { model: MODELS.image, n: 1, response_format: 'b64_json', output_format: 'png', ...body };
  return withRetry(`Muse Image ${path}`, LIMITS.image, async (signal) => {
    const json: any = await jsonOrThrow(await postJson(path, payload, signal));
    trace?.addUsage(`image${path.replace('images/', ' ')}`, json.usage);
    const b64: string = json.data[0].b64_json;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : 'image/png' });
  });
}

export const editImage = (prompt: string, images: string[], size: string, trace?: Trace, extra: object = {}) =>
  imagesCall('images/edits', { prompt, size, images: images.map((url) => ({ image_url: url })), ...extra }, trace);

// ---------- Voice Transcribe ----------

export type Turn = { transcript: string; startMs: number; endMs: number };
// Korean-biased transcription of a 16 kHz mono WAV.
// `keywords`: words to listen for (the picture's part names).
export async function transcribe(wav: Blob, trace?: Trace, keywords: string[] = []): Promise<{ transcript: string; turns: Turn[] }> {
  const request = { model: MODELS.transcribe, audioEncoding: 'WAV', mode: 'DIARIZATION', languageBias: ['Korean'], ...(keywords.length ? { keywords } : {}) };
  return withRetry('transcribe', LIMITS.transcribe, async (signal) => {
    const form = new FormData();
    form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
    form.append('audio', wav, 'speech.wav');
    const json = await jsonOrThrow(await metaFetch('asr/transcribe', { method: 'POST', headers: { Accept: 'application/json' }, body: form, signal }));
    trace?.addUsage('transcribe', json.usage ?? { audioDurationMs: json.audioDurationMs });
    return { transcript: json.transcript ?? '', turns: json.turns ?? [] };
  });
}

// Promise.withResolvers, for browsers before Safari 17.4.
function resolvers<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

// Realtime transcription while the user is still talking: the browser streams
// 16 kHz PCM over a WebSocket (through the Worker, which adds the key), and on
// release the final transcript is ready ~0.3 s after the audio ends (the batch
// endpoint needs 1-2.5 s after release). `partials` keeps when each cumulative
// transcript arrived, for the key-frame fallback's word timings.
export class RealtimeAsr {
  text = ''; // latest (cumulative) transcript
  partials: { at: number; text: string }[] = [];
  onText: (text: string) => void = () => {};
  private ws: WebSocket;
  private ready: Promise<void>;
  private final: Promise<string>;
  private failed = false;
  private t0 = performance.now();

  // `keywords`: words to listen for (the picture's part names).
  constructor(keywords: string[] = []) {
    this.ws = realtimeSocket();
    this.ws.binaryType = 'arraybuffer';
    const ready = resolvers<void>();
    const final = resolvers<string>();
    this.ready = ready.promise;
    this.final = final.promise;
    this.ready.catch(() => {});
    this.final.catch(() => {});
    const fail = (e: Error) => {
      this.failed = true;
      ready.reject(e);
      final.reject(e);
    };
    // A socket that never opens must not hold up the recording: batch takes over.
    const opening = setTimeout(() => fail(new Error('realtime ASR did not open in time')), 4000);
    this.ws.onopen = () =>
      this.ws.send(JSON.stringify({
        // The Worker adds the key to this first message.
        audioEncoding: 'PCM_16KHZ',
        model: MODELS.transcribe,
        mode: 'PUSH_TO_TALK',
        partialMode: 'CUMULATIVE',
        emitAudioProgress: false,
        languageBias: ['Korean'],
        ...(keywords.length ? { keywords } : {}),
      }));
    this.ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const msg = JSON.parse(ev.data);
      if (msg.sessionId && !msg.type) {
        clearTimeout(opening);
        ready.resolve();
      } else if (msg.type === 'transcript') {
        this.text = msg.transcript;
        this.partials.push({ at: performance.now() - this.t0, text: msg.transcript });
        this.onText(msg.transcript);
        if (msg.final) final.resolve(msg.transcript);
      } else if (msg.type === 'error') fail(new Error(msg.message));
    };
    this.ws.onclose = (ev) => fail(new Error(`realtime ASR closed ${ev.code} ${ev.reason}`));
    this.ws.onerror = () => fail(new Error('realtime ASR socket error'));
  }

  // The PCM clock starts with this session (the recording starts with it).
  startClock(t0: number) {
    this.t0 = t0;
  }

  async send(pcm: Int16Array) {
    if (this.failed) return;
    try {
      await this.ready;
      this.ws.send(pcm);
    } catch {
      this.failed = true;
    }
  }

  // End of audio: the final transcript, or null if it doesn't come in time.
  async finish(timeoutMs = 2000): Promise<string | null> {
    if (this.failed) return null;
    try {
      await this.ready;
      this.ws.send(JSON.stringify({ type: 'endStream' }));
      return await Promise.race([this.final, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    } catch {
      return null;
    }
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}
