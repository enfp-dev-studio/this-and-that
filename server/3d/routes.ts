// 3D sketch mode's API, under /api/3d on the same server as the image mode:
// realtime transcription relay with a batch fallback at release, perception
// (multi-view sketch → part list, streamed as NDJSON), and painting the model
// with Muse Image. Shares meta.ts and asr.ts with the image mode.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { editImage, transcribe } from '../meta.ts';
import { RealtimeAsr } from '../asr.ts';
import { museParams } from '../pipeline.ts';
import { perceive } from './perceive.ts';

const OUT = join(import.meta.dirname, '..', '..', 'out', '3d', 'jobs');

// Words Voice Transcribe should listen for.
const KEYWORDS = ['의자', '등받이', '다리', '좌석', '집', '지붕', '창문', '문', '굴뚝', '테이블', '손잡이', '컵', '나무', '높게', '길게'];

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const live = new Map<string, RealtimeAsr>();
let seq = 0;

// Handles /api/3d/*; false if the path isn't one of them.
export async function handle3d(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<boolean> {
  const [, , route, id, action] = parts; // api, 3d, …
  // Open a realtime transcription when the talk button goes down.
  if (req.method === 'POST' && route === 'asr' && !id) {
    const asrId = `a${Date.now().toString(36)}${seq++}`;
    const asr = new RealtimeAsr(KEYWORDS);
    live.set(asrId, asr);
    setTimeout(() => (asr.close(), live.delete(asrId)), 90_000);
    send(res, 200, { asrId });
    return true;
  }
  // PCM chunk while talking → the transcript so far (live caption).
  if (req.method === 'POST' && route === 'asr' && id && !action) {
    const asr = live.get(id);
    if (!asr) return send(res, 404, { error: 'no such transcription' }), true;
    await asr.send(await readBody(req));
    send(res, 200, { text: asr.text });
    return true;
  }
  // Release: the realtime final text, or batch transcription of the WAV sent.
  if (req.method === 'POST' && route === 'asr' && id && action === 'finish') {
    const wav = await readBody(req);
    const asr = live.get(id);
    live.delete(id);
    const t0 = Date.now();
    const text = asr ? await asr.finish() : null;
    asr?.close();
    if (text) return send(res, 200, { text, via: 'realtime', ms: Date.now() - t0 }), true;
    if (wav.length < 2000) return send(res, 200, { text: '', via: 'none', ms: Date.now() - t0 }), true;
    const r = await transcribe(wav, undefined, KEYWORDS);
    send(res, 200, { text: r.transcript, via: 'batch', ms: Date.now() - t0 });
    return true;
  }
  if (req.method === 'POST' && route === 'perceive') {
    const body = JSON.parse((await readBody(req)).toString());
    const dir = join(OUT, stamp());
    mkdirSync(dir, { recursive: true });
    body.views?.forEach((v: { name: string; image: string }, i: number) => writeFileSync(join(dir, `${i}-${v.name.replace(/\W+/g, '_')}.jpg`), Buffer.from(v.image.split(',')[1], 'base64')));
    writeFileSync(join(dir, 'request.json'), JSON.stringify({ ...body, views: body.views?.map((v: any) => ({ name: v.name, note: v.note })) }, null, 1));
    // NDJSON: the sentence and each part as soon as Spark has written it, then the whole answer.
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    try {
      const r = await perceive(body, (e) => res.write(JSON.stringify(e) + '\n'));
      writeFileSync(join(dir, 'answer.json'), JSON.stringify(r, null, 1));
      console.log(`[3d perceive] first ${r.firstMs} ms, done ${r.ms} ms, ${r.answer.parts?.length} parts: ${r.answer.subject} (${dir})`);
    } catch (e: any) {
      console.error('[3d perceive]', e);
      res.write(JSON.stringify({ type: 'error', error: String(e?.message ?? e) }) + '\n');
    }
    res.end();
    return true;
  }
  // Muse Image repaints a render of the model; the client projects it back on.
  if (req.method === 'POST' && route === 'paint') {
    const { image, subject, style } = JSON.parse((await readBody(req)).toString());
    const prompt = `This is a plain 3D render of a simple low-poly ${subject || 'object'} on a white background. Repaint it as a finished, stylized, hand-painted 3D game asset. This is texture painting only: the result is projected back onto the 3D model, so every edge, the silhouette, the position, the size and the camera angle must stay exactly where they are in this render, even if a shape looks odd. Only add surface materials and detail (for example wood grain, roof tiles, bricks, fabric weave), richer painted colors and soft lighting. Do not add, remove, move or reshape anything. Keep the plain white background.${style ? ` Style: ${style}.` : ''}`;
    const t0 = Date.now();
    const input = Buffer.from(String(image).split(',')[1], 'base64');
    const out = await editImage(prompt, [input], '1024x1024', undefined, museParams('notools'));
    const dir = join(OUT, `paint-${stamp()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'in.jpg'), input);
    writeFileSync(join(dir, 'out.jpg'), out);
    console.log(`[3d paint] ${Date.now() - t0} ms (${dir})`);
    send(res, 200, { image: `data:image/jpeg;base64,${out.toString('base64')}`, ms: Date.now() - t0 });
    return true;
  }
  return false;
}
