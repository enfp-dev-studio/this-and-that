// Thin wrappers around the Meta model APIs this app uses: Muse Spark (video +
// voice understanding), SAM 3.1 (rough mark → exact mask), Muse Image (edit)
// and Muse Voice Transcribe (fallback / captions).

import OpenAI from 'openai';
import { buildObjectPrompt, decodeMaskToRaster, parseImageStream, recordsOfKind } from '@meta-sam/parser';
import type { Trace } from './trace.ts';

const BASE_URL = 'https://api.meta.ai/v1';
export const MODELS = {
  spark: process.env.SPARK_MODEL ?? 'muse-spark-1.3',
  image: 'muse-image-1.0',
  sam: 'sam-3.1',
  transcribe: 'muse-voice-transcribe-1.0',
};

const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error('MODEL_API_KEY is missing: put it in .env');
const client = new OpenAI({ baseURL: BASE_URL, apiKey });

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
}): Promise<T> {
  const messages: any[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.content });
  const r = await client.chat.completions.create({
    model: opts.model ?? MODELS.spark,
    ...(opts.effort ? { reasoning_effort: opts.effort } : {}),
    messages,
    response_format: { type: 'json_schema', json_schema: { name: 'Answer', schema: opts.schema } },
  } as any);
  opts.trace?.addUsage(opts.label ?? 'spark', r.usage);
  return JSON.parse(r.choices[0].message.content ?? '{}');
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
  const events = await client.responses.create({
    model: MODELS.sam,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: dataUrl(image, 'image/jpeg') }] }],
    stream: true,
    metadata: { mask_encoding: 'one_bit' },
  } as any);
  // Pass the events through to the parser, keeping the usage from the last one.
  async function* tap() {
    for await (const ev of events as any) {
      if (ev.type === 'response.completed') trace?.addUsage(label, ev.response?.usage);
      yield ev;
    }
  }
  const result = await parseImageStream(tap() as any).finalResult;
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
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODELS.image, n: 1, response_format: 'b64_json', output_format: 'png', ...body }),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`Muse Image ${path}: HTTP ${res.status}: ${JSON.stringify(json)}`);
  trace?.addUsage(`image${path.replace('/images/', ' ')}`, json.usage);
  return Buffer.from(json.data[0].b64_json, 'base64');
}

export const generateImage = (prompt: string, size?: string) => imagesCall('/images/generations', { prompt, ...(size ? { size } : {}) });

export const editImage = (prompt: string, images: Buffer[], size: string, trace?: Trace, extra: object = {}) =>
  imagesCall('/images/edits', { prompt, size, images: images.map((b) => ({ image_url: dataUrl(b, mimeOf(b)) })), ...extra }, trace);

const mimeOf = (b: Buffer) => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : 'image/png');

export type Turn = { transcript: string; startMs: number; endMs: number };
// Korean-biased transcription of a 16 kHz mono WAV.
export async function transcribe(wav: Buffer, trace?: Trace): Promise<{ transcript: string; turns: Turn[] }> {
  const request = { model: MODELS.transcribe, audioEncoding: 'WAV', mode: 'DIARIZATION', languageBias: ['Korean'] };
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
  form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
  const res = await fetch(`${BASE_URL}/asr/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`transcribe: HTTP ${res.status}: ${text}`);
  const json = JSON.parse(text);
  trace?.addUsage('transcribe', json.usage ?? { audioDurationMs: json.audioDurationMs });
  return { transcript: json.transcript ?? '', turns: json.turns ?? [] };
}
