// Local server. The client uploads the image once, sends each mark the moment
// its stroke ends (SAM runs while the user is still talking), then sends the
// voice on release. Progress is polled.
//
//   POST /api/images                  { image: dataURL }            → { imageId, width, height }
//   POST /api/marks                   { imageId, stroke }           → { markId, overlay } once SAM is done
//   POST /api/jobs                    { imageId, strokes, audio }   → { id }   (strokes carry markId)
//                                     { image: dataURL, strokes, audio } also works (one shot)
//   GET  /api/jobs/:id                progress, transcript, edits, resultImageId
//   GET  /api/jobs/:id/:file          result.jpg, edited.jpg, guide.png, video.mp4, trace.json, …
//   GET  /api/images/:id.jpg  /api/marks/:id.png  /api/sample

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { transcribe, type Mask } from './meta.ts';
import { guideImage, museEdit, pasteMarked, segmentMark, smallCopy, understandTranscript, understandVideo, type Edit, type Small } from './pipeline.ts';
import { audioDurationMs, colorOf, renderVideo, toWav, type Stroke } from './render.ts';
import { Trace } from './trace.ts';

const PORT = Number(process.env.PORT ?? 8787);
const root = join(import.meta.dirname, '..');
const jobsDir = join(root, 'out', 'jobs');
const distDir = join(root, 'dist');
mkdirSync(jobsDir, { recursive: true });

const MAX_SIDE = 2048;
const newId = () => randomUUID().slice(0, 8);

// ---------- images ----------

// Uploads are scaled to ≤2048 px; `k` maps the client's pixel coordinates
// (the image as uploaded) to the stored ones.
type StoredImage = { id: string; png: Buffer; width: number; height: number; k: number; small: Promise<Small> };
const images = new Map<string, StoredImage>();

async function storeImage(buf: Buffer, id = newId()): Promise<StoredImage> {
  const meta = await sharp(buf).rotate().metadata();
  const k = Math.min(1, MAX_SIDE / Math.max(meta.width!, meta.height!));
  const width = Math.round(meta.width! * k);
  const height = Math.round(meta.height! * k);
  const png = await sharp(buf).rotate().resize(width, height).png().toBuffer();
  const img: StoredImage = { id, png, width, height, k, small: smallCopy(png) };
  images.set(id, img);
  return img;
}

const scaleStroke = (s: Stroke, k: number): Stroke => (k === 1 ? s : { ...s, points: s.points.map((p) => ({ x: p.x * k, y: p.y * k, t: p.t })) });

// ---------- marks: SAM per stroke, started as soon as the stroke ends ----------

type MarkResult = { mask?: Mask; small: Small; ms: number; usage?: unknown };
const marks = new Map<string, Promise<MarkResult>>();

function startMark(img: StoredImage, stroke: Stroke, id = newId()) {
  const done = (async () => {
    const small = await img.small;
    const trace = new Trace();
    const t0 = performance.now();
    const mask = await segmentMark(small, stroke, trace).catch((e) => (console.error(`[mark ${id}] SAM failed:`, e.message), undefined));
    return { mask, small, ms: Math.round(performance.now() - t0), usage: trace.usage[0]?.usage };
  })();
  marks.set(id, done);
  return { id, done };
}

// The mask in the mark's colour, at SAM's size, for the client to lay over the image.
async function overlayPng(r: MarkResult, mark: number) {
  const { width, height } = r.small;
  const rgba = Buffer.alloc(width * height * 4);
  if (r.mask) {
    const [cr, cg, cb] = [1, 3, 5].map((i) => parseInt(colorOf(mark).slice(i, i + 2), 16));
    for (let i = 0; i < r.mask.data.length; i++) if (r.mask.data[i]) rgba.set([cr, cg, cb, 255], i * 4);
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

// ---------- jobs ----------

type Job = {
  id: string;
  stage: string; // understand, edit, paste, done, error
  transcript?: string;
  edits?: Edit[];
  via?: string;
  resultImageId?: string;
  error?: string;
  startedAt: number;
};
const jobs = new Map<string, Job>();

async function runJob(job: Job, img: StoredImage, strokes: Stroke[], markIds: (string | undefined)[], audioBuf: Buffer | null) {
  const dir = join(jobsDir, job.id);
  mkdirSync(dir, { recursive: true });
  const trace = new Trace();
  const T = <R>(name: string, f: () => Promise<R>) => trace.time(name, f);
  const image = img.png;
  writeFileSync(join(dir, 'strokes.json'), JSON.stringify(strokes));

  // Masks: from the marks sent while drawing, or started now for any that weren't.
  const markResults = strokes.map((s, i) => (markIds[i] && marks.get(markIds[i]!)) || startMark(img, s).done);

  // Audio → WAV, then the transcript and the drawing video side by side.
  let wavPath: string | null = null;
  if (audioBuf?.length) {
    writeFileSync(join(dir, 'voice.webm'), audioBuf);
    wavPath = await T('to wav', () => toWav(join(dir, 'voice.webm'), join(dir, 'voice.wav')));
  }
  const asr = wavPath
    ? T('transcribe', () => transcribe(readFileSync(wavPath!), trace)).catch((e) => (console.error(`[${job.id}] transcribe failed:`, e), null))
    : Promise.resolve(null);
  asr.then((r) => (job.transcript = r?.transcript));
  const video = T('render video', async () => {
    const durationMs = wavPath ? await audioDurationMs(wavPath) : 0;
    return readFileSync(await renderVideo(image, strokes, wavPath, join(dir, 'video.mp4'), { durationMs, maxSide: 512 }));
  });
  const guide = T('guide image', () => guideImage(image, strokes));

  // Spark, with the transcript as a hint: on its own it sometimes mishears a
  // word (in tests "노란색" became "검은색"); with the hint it doesn't.
  const [asrResult, mp4] = await Promise.all([asr, video]);
  let edits: Edit[];
  try {
    const r = await T('spark', () => understandVideo(mp4, strokes, { effort: 'minimal', transcript: asrResult?.transcript, trace }));
    edits = r.edits;
    job.transcript ||= r.transcript;
    job.via = 'spark-video';
  } catch (e) {
    console.error(`[${job.id}] Spark video failed, falling back to transcript:`, e);
    edits = (await T('spark fallback', async () => understandTranscript(await guide, strokes, asrResult?.turns ?? [], { effort: 'minimal', trace }))).edits;
    job.via = 'transcript';
  }
  edits = edits.filter((e) => strokes.some((s) => s.mark === e.mark));
  job.edits = edits;
  writeFileSync(join(dir, 'edits.json'), JSON.stringify(edits, null, 2));
  job.stage = 'edit';

  const edited = await T('muse edit', async () => museEdit(image, await guide, edits, trace));
  writeFileSync(join(dir, 'edited.jpg'), edited);
  job.stage = 'paste';

  const results = await Promise.all(markResults);
  for (const [i, r] of results.entries()) {
    trace.spans.push({ name: `sam mark ${strokes[i].mark}`, start: -1, ms: r.ms });
    trace.addUsage(`sam mark ${strokes[i].mark}`, r.usage);
  }
  const small = results[0].small;
  const masks = new Map<number, Mask>();
  results.forEach((r, i) => r.mask && masks.set(strokes[i].mark, r.mask));
  const { out } = await T('paste', () => pasteMarked(image, edited, strokes, { masks, width: small.width, height: small.height }, edits));
  const result = await T('store result', () => storeImage(out, `${job.id}r`));
  writeFileSync(join(dir, 'result.jpg'), await sharp(result.png).jpeg({ quality: 95 }).toBuffer());
  job.resultImageId = result.id;
  job.stage = 'done';
  const totalMs = Date.now() - job.startedAt;
  console.log(`[${job.id}] done in ${totalMs} ms: ${trace.summary()}`);
  writeFileSync(join(dir, 'trace.json'), JSON.stringify({ totalMs, spans: trace.spans, usage: trace.usage }, null, 2));
}

// ---------- http ----------

const decodeDataUrl = (s?: string) => (s ? Buffer.from(s.slice(s.indexOf(',') + 1), 'base64') : null);

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendBytes(res: ServerResponse, type: string, buf: Buffer) {
  res.writeHead(200, { 'Content-Type': type });
  res.end(buf);
}

function sendFile(res: ServerResponse, path: string) {
  if (!existsSync(path)) return send(res, 404, { error: 'not found' });
  sendBytes(res, TYPES[extname(path)] ?? 'application/octet-stream', readFileSync(path));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'POST' && url.pathname === '/api/images') {
      const buf = decodeDataUrl((await readJson(req)).image);
      if (!buf) return send(res, 400, { error: 'need an image' });
      const img = await storeImage(buf);
      return send(res, 200, { imageId: img.id, width: img.width, height: img.height });
    }
    if (req.method === 'POST' && url.pathname === '/api/marks') {
      const body = await readJson(req);
      const img = images.get(body.imageId);
      if (!img || !body.stroke?.points?.length) return send(res, 400, { error: 'need a known imageId and a stroke' });
      const stroke = scaleStroke(body.stroke, img.k);
      // The client names the mark, so a job sent before SAM answers still finds it.
      const { id, done } = startMark(img, stroke, String(body.markId ?? '').replace(/\W/g, '') || undefined);
      const r = await done;
      return send(res, 200, { markId: id, found: !!r.mask, overlay: `/api/marks/${id}.png?mark=${stroke.mark}`, ms: r.ms });
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const body = await readJson(req);
      const upload = decodeDataUrl(body.image);
      const img = upload ? await storeImage(upload) : images.get(body.imageId);
      const raw: (Stroke & { markId?: string })[] = body.strokes ?? [];
      if (!img || !raw.length) return send(res, 400, { error: 'need an image and at least one mark' });
      const job: Job = { id: newId(), stage: 'understand', startedAt: Date.now() };
      jobs.set(job.id, job);
      const strokes = raw.map(({ mark, points }) => scaleStroke({ mark, points }, img.k));
      runJob(job, img, strokes, raw.map((s) => s.markId), decodeDataUrl(body.audio)).catch((e) => {
        console.error(`[${job.id}]`, e);
        job.error = String(e.message ?? e);
        job.stage = 'error';
      });
      return send(res, 200, { id: job.id });
    }
    if (parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
      if (parts[3]) return sendFile(res, join(jobsDir, parts[2].replace(/\W/g, ''), parts[3].replace(/[^\w.]/g, '')));
      const job = jobs.get(parts[2]);
      return job ? send(res, 200, { ...job, elapsedMs: Date.now() - job.startedAt }) : send(res, 404, { error: 'no such job' });
    }
    if (parts[0] === 'api' && parts[1] === 'images' && parts[2]) {
      const img = images.get(parts[2].replace(/\.jpg$/, ''));
      return img ? sendBytes(res, 'image/jpeg', await sharp(img.png).jpeg({ quality: 95 }).toBuffer()) : send(res, 404, { error: 'no such image' });
    }
    if (parts[0] === 'api' && parts[1] === 'marks' && parts[2]) {
      const mark = marks.get(parts[2].replace(/\.png$/, ''));
      if (!mark) return send(res, 404, { error: 'no such mark' });
      return sendBytes(res, 'image/png', await overlayPng(await mark, Number(url.searchParams.get('mark') ?? 1)));
    }
    if (url.pathname === '/api/sample') return sendFile(res, join(root, 'samples', 'desk.png'));
    // Built client (npm run build), so one port serves everything.
    return sendFile(res, join(distDir, url.pathname === '/' ? 'index.html' : url.pathname.replace(/\.\./g, '')));
  } catch (e: any) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`This & That server on http://localhost:${PORT}`));
