// Thin wrappers around the Meta model APIs this app uses: Muse Spark (video +
// voice understanding), SAM 3.1 (rough mark → exact mask), Muse Image (edit)
// and Muse Voice Transcribe (fallback / captions).

import OpenAI from 'openai';
import { buildObjectPrompt, decodeMaskToRaster, parseImageStream, recordsOfKind } from '@meta-sam/parser';
import type { Trace } from './trace.ts';

const BASE_URL = 'https://api.meta.ai/v1';
export const MODELS = {
  spark: process.env.SPARK_MODEL ?? 'muse-spark-1.3',
  // 3D sketch mode: 1.2 at minimal effort answers a part list in ~12 s; 1.3 thinks ~3x longer for a similar one.
  spark3d: process.env.SPARK3D_MODEL ?? 'muse-spark-1.2',
  image: 'muse-image-1.0',
  sam: 'sam-3.1',
  transcribe: 'muse-voice-transcribe-1.0',
};

const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error('MODEL_API_KEY is missing: put it in .env');
// Retries are ours (withRetry), not the SDK's.
const client = new OpenAI({ baseURL: BASE_URL, apiKey, maxRetries: 0 });

// Every model call has a deadline and one retry: Muse Image sometimes takes
// 200+ s or answers a content-filter 400, and the demo must never hang.
// (Each can be lowered by env, e.g. MUSE_TIMEOUT_MS=500, to rehearse failures.)
const limit = (name: string, ms: number) => Number(process.env[name] ?? ms);
export const LIMITS = { spark: limit('SPARK_TIMEOUT_MS', 20_000), sam: limit('SAM_TIMEOUT_MS', 10_000), image: limit('MUSE_TIMEOUT_MS', 40_000), transcribe: limit('TRANSCRIBE_TIMEOUT_MS', 10_000) };

export async function withRetry<R>(name: string, ms: number, f: (signal: AbortSignal) => Promise<R>): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    const ac = new AbortController();
    // The deadline holds even if a call ignores the signal.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => (timer = setTimeout(() => (ac.abort(), reject(new Error('timeout'))), ms)));
    const call = f(ac.signal);
    call.catch(() => {});
    try {
      return await Promise.race([call, deadline]);
    } catch (e: any) {
      const why = ac.signal.aborted ? `timed out after ${ms / 1000} s` : String(e?.message ?? e).slice(0, 300);
      if (attempt === 2) throw new Error(`${name} ${why}`);
      console.warn(`[${name}] ${why}; retrying once`);
      await new Promise((r) => setTimeout(r, 800));
    } finally {
      clearTimeout(timer);
    }
  }
}

const dataUrl = (buf: Buffer, mime: string) => `data:${mime};base64,${buf.toString('base64')}`;

// Chat completion with a JSON schema answer. `content` is the user message parts.
export async function sparkJson<T>(opts: {
  content: any[];
  schema: object;
  model?: string;
  effort?: string;
  system?: string;
  trace?: Trace;
  label?: string;
  timeoutMs?: number;
}): Promise<T> {
  const messages: any[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.content });
  return withRetry(opts.label ?? 'spark', opts.timeoutMs ?? LIMITS.spark, async (signal) => {
    const r = await client.chat.completions.create({
      model: opts.model ?? MODELS.spark,
      ...(opts.effort ? { reasoning_effort: opts.effort } : {}),
      messages,
      response_format: { type: 'json_schema', json_schema: { name: 'Answer', schema: opts.schema } },
    } as any, { signal });
    opts.trace?.addUsage(opts.label ?? 'spark', r.usage);
    return JSON.parse(r.choices[0].message.content ?? '{}');
  });
}

// Streaming JSON answer, hedged (3D sketch mode): `copies` identical calls
// race, the first to start writing its answer wins and the others are
// cancelled (Spark's thinking time varies 2-3x between identical calls).
// `onText` gets the answer so far.
export async function sparkStream(opts: { system: string; content: any[]; schema: object; model?: string; effort?: string; copies?: number; timeoutMs?: number; onText?: (text: string) => void }): Promise<{ text: string; usage: any; firstMs: number }> {
  const body = JSON.stringify({
    model: opts.model ?? MODELS.spark3d,
    ...(opts.effort ? { reasoning_effort: opts.effort } : {}),
    stream: true,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.content },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'Model', schema: opts.schema } },
  });
  const t0 = Date.now();
  const copies = opts.copies ?? 3;
  const controllers = Array.from({ length: copies }, () => new AbortController());
  const timer = setTimeout(() => controllers.forEach((c) => c.abort()), opts.timeoutMs ?? 60_000);
  let winner = -1;
  const run = async (i: number) => {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: controllers[i].signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const dec = new TextDecoder();
    let buf = '', text = '', usage: any, firstMs = 0;
    for await (const chunk of res.body as any) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
        const ev = JSON.parse(line.slice(5));
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
    }
    return winner === i ? { text, usage, firstMs } : null;
  };
  try {
    const results = await Promise.allSettled(controllers.map((_, i) => run(i)));
    const won = results[winner]?.status === 'fulfilled' ? (results[winner] as PromiseFulfilledResult<any>).value : null;
    if (won) return won;
    const err = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    throw new Error(`spark ${err ? String(err.reason?.message ?? err.reason).slice(0, 300) : 'gave no answer'}`);
  } finally {
    clearTimeout(timer);
  }
}

export const videoPart = (mp4: Buffer, fps = 4) => ({ type: 'video_url', video_url: { url: dataUrl(mp4, 'video/mp4'), fps } });
export const imagePart = (buf: Buffer, mime = 'image/png') => ({ type: 'image_url', image_url: { url: dataUrl(buf, mime) } });

export type Box = { left: number; top: number; right: number; bottom: number };
export type SamObject = { id: number; box?: Box; points?: { x: number; y: number; label?: 'negative' }[] };
// One 0/1 mask per object id, full image size (width × height of the image sent).
export type Mask = { width: number; height: number; data: Uint8Array };

// Segment the objects named by boxes/points in one SAM call.
export async function samObjects(image: Buffer, width: number, height: number, objects: SamObject[], trace?: Trace, label = 'sam'): Promise<Map<number, Mask>> {
  const text = buildObjectPrompt({
    size: { width, height },
    objects: objects.map((o) => ({
      id: o.id,
      prompts: [{ ...(o.box ? { box: o.box } : {}), ...(o.points?.length ? { points: o.points } : {}) }],
    })),
  });
  const result = await withRetry(label, LIMITS.sam, async (signal) => {
    const events = await client.responses.create({
      model: MODELS.sam,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: dataUrl(image, 'image/jpeg') }] }],
      stream: true,
      metadata: { mask_encoding: 'one_bit' },
    } as any, { signal });
    // Pass the events through to the parser, keeping the usage from the last one.
    async function* tap() {
      for await (const ev of events as any) {
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

async function imagesCall(path: string, body: object, trace?: Trace): Promise<Buffer> {
  const payload = JSON.stringify({ model: MODELS.image, n: 1, response_format: 'b64_json', output_format: 'png', ...body });
  return withRetry(`Muse Image ${path}`, LIMITS.image, async (signal) => {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: payload,
      signal,
    });
    const json: any = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
    trace?.addUsage(`image${path.replace('/images/', ' ')}`, json.usage);
    return Buffer.from(json.data[0].b64_json, 'base64');
  });
}

export const generateImage = (prompt: string, size?: string) => imagesCall('/images/generations', { prompt, ...(size ? { size } : {}) });

export const editImage = (prompt: string, images: Buffer[], size: string, trace?: Trace, extra: object = {}) =>
  imagesCall('/images/edits', { prompt, size, images: images.map((b) => ({ image_url: dataUrl(b, mimeOf(b)) })), ...extra }, trace);

const mimeOf = (b: Buffer) => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : 'image/png');

export type Turn = { transcript: string; startMs: number; endMs: number };
// Korean-biased transcription of a 16 kHz mono WAV.
// `keywords`: words to listen for (the picture's part names).
export async function transcribe(wav: Buffer, trace?: Trace, keywords: string[] = []): Promise<{ transcript: string; turns: Turn[] }> {
  const request = { model: MODELS.transcribe, audioEncoding: 'WAV', mode: 'DIARIZATION', languageBias: ['Korean'], ...(keywords.length ? { keywords } : {}) };
  return withRetry('transcribe', LIMITS.transcribe, async (signal) => {
    const form = new FormData();
    form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
    form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
    const res = await fetch(`${BASE_URL}/asr/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      body: form,
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    const json = JSON.parse(text);
    trace?.addUsage('transcribe', json.usage ?? { audioDurationMs: json.audioDurationMs });
    return { transcript: json.transcript ?? '', turns: json.turns ?? [] };
  });
}
