// Shared by the spike and bench scripts: make synthetic "drawing while
// speaking" clips (strokes timed to a Korean `say -v Yuna` voice track), and
// replay one against the running server the way the client sends it.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { imagePart, sparkJson } from '../server/meta.ts';
import { audioDurationMs, type Point, type Stroke } from '../server/render.ts';

export type Box = number[]; // [x0, y0, x1, y1] in image pixels
export type Shape = 'circle' | 'scribble' | 'arrow';
export type Segment = { say: string; box: Box; shape: Shape; to?: [number, number] };

// Boxes of named objects, from Spark (0-1000 grid) scaled to image pixels.
export async function locate(image: Buffer, names: string[]): Promise<Map<string, Box>> {
  const { width, height } = await sharp(image).metadata();
  const small = await sharp(image).resize(768).jpeg().toBuffer();
  const r = await sparkJson<{ objects: { name: string; box: number[] }[] }>({
    effort: 'minimal',
    content: [{ type: 'text', text: `Give the bounding box of each object: ${names.map((o) => `"${o}"`).join(', ')}. Use exactly these names. Coordinates on a 0-1000 grid, (0,0) top-left.` }, imagePart(small, 'image/jpeg')],
    schema: { type: 'object', properties: { objects: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, box: { type: 'array', items: { type: 'integer' } } }, required: ['name', 'box'] } } }, required: ['objects'] },
  });
  return new Map(r.objects.map((o) => [o.name, o.box.map((v, i) => (v * (i % 2 ? height! : width!)) / 1000)]));
}

// Hand-drawn-looking stroke over a box, from t0 to t1 ms. An arrow starts at
// the box's edge and points at `to` (default: to the right).
export function strokePoints(box: Box, shape: Shape, t0: number, t1: number, W: number, H: number, to?: [number, number]): Point[] {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  const [tx, ty] = to ?? [x1 + Math.max(rx, W * 0.12), cy];
  const sx = tx > cx ? x1 : tx < cx - rx ? x0 : cx; // leave the box on the side facing the target
  const n = 40;
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const wob = 1 + 0.06 * Math.sin(u * 17);
    let x: number, y: number;
    if (shape === 'circle') {
      const a = -Math.PI / 2 + u * Math.PI * 2.15;
      x = cx + rx * 1.2 * wob * Math.cos(a);
      y = cy + ry * 1.2 * wob * Math.sin(a);
    } else if (shape === 'scribble') {
      x = x0 + rx * 0.3 + (rx * 1.4) * ((Math.floor(u * 6) % 2) ? 1 - (u * 6) % 1 : (u * 6) % 1);
      y = y0 + ry * 0.3 + ry * 1.4 * u;
    } else {
      // Shaft to the target, then two head strokes back from the tip.
      const len = Math.hypot(tx - sx, ty - cy), ux = (tx - sx) / len, uy = (ty - cy) / len, head = len * 0.2;
      if (u < 0.7) { x = sx + (tx - sx) * (u / 0.7); y = cy + (ty - cy) * (u / 0.7); }
      else if (u < 0.85) { const v = (u - 0.7) / 0.15; x = tx - v * head * (ux + uy * 0.8); y = ty - v * head * (uy - ux * 0.8); }
      else { const v = (u - 0.85) / 0.15; x = tx - v * head * (ux - uy * 0.8); y = ty - v * head * (uy + ux * 0.8); }
    }
    pts.push({ x: Math.round(Math.max(0, Math.min(W - 1, x))), y: Math.round(Math.max(0, Math.min(H - 1, y))), t: Math.round(t0 + u * (t1 - t0)) });
  }
  return pts;
}

// Voice each segment, lay the phrases out one after another with a short
// pause, and draw each segment's mark while its phrase starts.
// Writes <dir>/<name>.wav and <name>.json.
export async function buildClip(dir: string, name: string, image: Buffer, segments: Segment[]) {
  const { width: W, height: H } = await sharp(image).metadata();
  const parts: { file: string; at: number }[] = [];
  const strokes: Stroke[] = [];
  let at = 400;
  for (const [i, seg] of segments.entries()) {
    const aiff = join(dir, `${name}-${i}.aiff`);
    execFileSync('say', ['-v', 'Yuna', '-o', aiff, seg.say]);
    parts.push({ file: aiff, at });
    strokes.push({ mark: i + 1, points: strokePoints(seg.box, seg.shape, at + 100, at + 1300, W!, H!, seg.to) });
    at += Math.max(await audioDurationMs(aiff), 1300) + 350;
  }
  const wav = join(dir, `${name}.wav`);
  const inputs = parts.flatMap((p) => ['-i', p.file]);
  const filter = parts.map((p, i) => `[${i}:a]adelay=${p.at}|${p.at}[a${i}]`).join(';') + ';' + parts.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${parts.length}:normalize=0[o]`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[o]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  const speech = parts.map((p, i) => ({ at: p.at, say: segments[i].say }));
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ strokes, speech }, null, 2));
  return { strokes, wav, speech };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Replay a clip against the server: marks sent as each stroke ends, voice
// streamed for realtime transcription (unless realtime is false), release
// when the voice ends. Returns what the user would wait for.
export async function replay(base: string, imageId: string, strokes: Stroke[], wavPath: string, opts: { instant?: boolean; speculate?: boolean; realtime?: boolean; muse?: string } = {}) {
  const post = async (path: string, body: unknown) => (await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const wav = readFileSync(wavPath);
  const pcm = wav.subarray(44); // 16 kHz mono s16le
  const audioMs = (pcm.length / 32000) * 1000;
  const t0 = Date.now();

  let asrId: string | undefined;
  let streamed = Promise.resolve();
  if (opts.realtime !== false) {
    asrId = (await post('/api/asr', {})).asrId;
    streamed = (async () => {
      for (let off = 0, i = 0; off < pcm.length; off += 8000, i++) { // 250 ms chunks
        await sleep(i * 250 - (Date.now() - t0));
        await fetch(`${base}/api/asr/${asrId}`, { method: 'POST', body: pcm.subarray(off, off + 8000) });
      }
    })();
  }
  const marks = strokes.map((s) => ({ ...s, markId: '' }));
  const markCalls = marks.map(async (s) => {
    await sleep(s.points.at(-1)!.t - (Date.now() - t0));
    s.markId = (await post('/api/marks', { imageId, stroke: { mark: s.mark, points: s.points } })).markId;
  });
  await sleep(audioMs + 300 - (Date.now() - t0));
  const released = Date.now();
  await Promise.all([...markCalls, streamed]);
  const audio = `data:audio/wav;base64,${wav.toString('base64')}`;
  const { id } = await post('/api/jobs', { imageId, strokes: marks, audio, asrId, opts: { instant: opts.instant ?? true, speculate: opts.speculate ?? false, ...(opts.muse ? { muse: opts.muse } : {}) } });

  let editsAt = 0, previewAt = 0, job: any;
  for (;;) {
    job = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (job.error) throw new Error(job.error);
    if (job.edits && !editsAt) editsAt = Date.now() - released;
    if (job.previewImageId && !previewAt) previewAt = Date.now() - released;
    if (job.stage === 'done') break;
    await sleep(150);
  }
  return { id, total: Date.now() - released, editsAt, previewAt, job };
}
