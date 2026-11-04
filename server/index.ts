// Local server: takes an image, the stroke log and the voice recording,
// runs the pipeline as a background job, and reports progress by polling.
//
//   POST /api/jobs          { image: dataURL, strokes: Stroke[], audio: dataURL }  → { id }
//   GET  /api/jobs/:id      progress, transcript, edits, result URLs
//   GET  /api/jobs/:id/:file  result.png, edited.png, guide.png, video.mp4
//   GET  /api/sample        a demo image

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { transcribe } from './meta.ts';
import { guideImage, museEdit, pasteMarked, segmentMarks, understandTranscript, understandVideo, type Edit } from './pipeline.ts';
import { audioDurationMs, renderVideo, toWav, type Stroke } from './render.ts';

const PORT = Number(process.env.PORT ?? 8787);
const root = join(import.meta.dirname, '..');
const jobsDir = join(root, 'out', 'jobs');
const distDir = join(root, 'dist');
mkdirSync(jobsDir, { recursive: true });

type Job = {
  id: string;
  stage: string; // video, understand, edit, paste, done, error
  log: { stage: string; ms: number }[];
  transcript?: string;
  edits?: Edit[];
  via?: string;
  error?: string;
  startedAt: number;
};
const jobs = new Map<string, Job>();

const MAX_SIDE = 2048;

async function runJob(job: Job, imageBuf: Buffer, strokes: Stroke[], audioBuf: Buffer | null) {
  const dir = join(jobsDir, job.id);
  mkdirSync(dir, { recursive: true });
  let t = performance.now();
  const step = (stage: string) => {
    const now = performance.now();
    job.log.push({ stage: job.stage, ms: Math.round(now - t) });
    t = now;
    job.stage = stage;
  };

  // Big uploads are scaled down; strokes come in the uploaded image's pixels.
  const meta = await sharp(imageBuf).metadata();
  const k = Math.min(1, MAX_SIDE / Math.max(meta.width!, meta.height!));
  const image = await sharp(imageBuf).rotate().resize(Math.round(meta.width! * k), Math.round(meta.height! * k)).png().toBuffer();
  if (k < 1) for (const s of strokes) for (const p of s.points) { p.x *= k; p.y *= k; }
  writeFileSync(join(dir, 'input.png'), image);
  writeFileSync(join(dir, 'strokes.json'), JSON.stringify(strokes));

  let audioPath: string | null = null;
  let wav: Buffer | null = null;
  if (audioBuf?.length) {
    audioPath = join(dir, 'voice.webm');
    writeFileSync(audioPath, audioBuf);
    wav = readFileSync(await toWav(audioPath, join(dir, 'voice.wav')));
  }
  const durationMs = audioPath ? await audioDurationMs(join(dir, 'voice.wav')) : 0;
  const mp4 = readFileSync(await renderVideo(image, strokes, audioPath && join(dir, 'voice.wav'), join(dir, 'video.mp4'), { durationMs }));
  const guide = await guideImage(image, strokes);
  writeFileSync(join(dir, 'guide.png'), guide);
  step('understand');

  // SAM runs alongside. Voice Transcribe goes first: Spark mapping words to
  // marks is reliable, but on its own it sometimes mishears a word (in tests,
  // "노란색" became "검은색"); with the transcript as a hint it doesn't.
  const seg = segmentMarks(image, strokes);
  seg.catch(() => {});
  const asr = wav ? await transcribe(wav).catch((e) => (console.error(`[${job.id}] transcribe failed:`, e), null)) : null;
  job.transcript = asr?.transcript;
  let edits: Edit[];
  try {
    const r = await understandVideo(mp4, strokes, { effort: 'minimal', transcript: asr?.transcript });
    edits = r.edits;
    job.transcript ||= r.transcript;
    job.via = 'spark-video';
  } catch (e) {
    console.error(`[${job.id}] Spark video failed, falling back to transcript:`, e);
    edits = (await understandTranscript(guide, strokes, asr?.turns ?? [], { effort: 'minimal' })).edits;
    job.via = 'transcript';
  }
  edits = edits.filter((e) => strokes.some((s) => s.mark === e.mark));
  job.edits = edits;
  writeFileSync(join(dir, 'edits.json'), JSON.stringify(edits, null, 2));
  step('edit');

  const edited = await museEdit(image, guide, edits);
  writeFileSync(join(dir, 'edited.png'), edited);
  step('paste');

  const { out } = await pasteMarked(image, edited, strokes, await seg, edits);
  writeFileSync(join(dir, 'result.png'), out);
  step('done');
  console.log(`[${job.id}] done in ${Date.now() - job.startedAt} ms`, job.log.map((l) => `${l.stage} ${l.ms}`).join(', '));
}

const decodeDataUrl = (s?: string) => (s ? Buffer.from(s.slice(s.indexOf(',') + 1), 'base64') : null);

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const TYPES: Record<string, string> = { '.png': 'image/png', '.mp4': 'video/mp4', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendFile(res: ServerResponse, path: string) {
  if (!existsSync(path)) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const body = await readJson(req);
      const image = decodeDataUrl(body.image);
      const strokes: Stroke[] = body.strokes ?? [];
      if (!image || !strokes.length) return send(res, 400, { error: 'need an image and at least one mark' });
      const job: Job = { id: randomUUID().slice(0, 8), stage: 'video', log: [], startedAt: Date.now() };
      jobs.set(job.id, job);
      runJob(job, image, strokes, decodeDataUrl(body.audio)).catch((e) => {
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
    if (url.pathname === '/api/sample') return sendFile(res, join(root, 'samples', 'desk.png'));
    // Built client (npm run build), so one port serves everything.
    const file = join(distDir, url.pathname === '/' ? 'index.html' : url.pathname.replace(/\.\./g, ''));
    return sendFile(res, file);
  } catch (e: any) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`This & That server on http://localhost:${PORT}`));
