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
import { editImage, transcribe, type Mask, type Turn } from './meta.ts';
import { editAreas, findParts, guideImage, partKeywords, museEdit, museEditSpoken, museParams, partsHint, touchesAreas, type MuseMode, type Part, pasteMarked, segmentMark, smallCopy, specMatches, splitClauses, understandTranscript, understandVideo, type Edit, type Small } from './pipeline.ts';
import { applyLocal, LOCAL_OPS } from './local.ts';
import { RealtimeAsr } from './asr.ts';
import { audioDurationMs, maxVolumeDb, colorOf, composeWithRefs, cropAround, renderVideo, toWav, type Stroke } from './render.ts';
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
type StoredImage = { id: string; png: Buffer; width: number; height: number; k: number; small: Promise<Small>; parts?: Promise<Part[]>; partsReady?: Part[] };
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

// The picture's named parts: one Spark call in the background, once per image.
// Optional: nothing waits for it, and SAM at each stroke still makes the masks.
function partsOf(img: StoredImage) {
  img.parts ??= (async () => {
    const t0 = performance.now();
    const parts = await findParts(await img.small);
    img.partsReady = parts;
    console.log(`[parts ${img.id}] ${parts.length} parts in ${Math.round(performance.now() - t0)} ms`);
    return parts;
  })();
  img.parts.catch((e) => console.error(`[parts ${img.id}]`, e.message));
  return img.parts;
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
  previewImageId?: string; // instant edits, shown while Muse Image still works
  asrVia?: string; // realtime or batch
  localMarks?: number[];
  speculation?: string; // right, wrong, skipped
  error?: string;
  startedAt: number;
};
const jobs = new Map<string, Job>();
// What a job understood, so "Try again" after a failed edit skips straight to Muse Image.
type Prior = { transcript?: string; edits?: Edit[] };
const priors = new Map<string, Prior>();

// What Voice Transcribe should listen for: the part names of the picture and
// its references, from the background parts pass (asking starts it for next time).
function keywordsFor(imgs: StoredImage[]) {
  for (const img of imgs) partsOf(img);
  return partKeywords(imgs.flatMap((img) => img.partsReady ?? []));
}

// Realtime transcription sessions, one per recording; dropped after a minute.
const liveAsr = new Map<string, RealtimeAsr>();
function startLiveAsr(keywords: string[]) {
  const id = newId();
  const asr = new RealtimeAsr(keywords);
  liveAsr.set(id, asr);
  setTimeout(() => (asr.close(), liveAsr.delete(id)), 60_000);
  return id;
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

// Experiments, each switchable per request (body.opts) or by env default.
type Opts = { instant: boolean; speculate: boolean; muse: MuseMode };
// Speculation is on: with part names as ASR keywords it was taken and right in
// 9/10 bench replays and 5/6 browser runs, never taken wrong (README).
const DEFAULT_OPTS: Opts = { instant: process.env.INSTANT_EDITS !== '0', speculate: process.env.SPECULATE !== '0', muse: (process.env.MUSE_MODE as MuseMode) ?? 'notools' };

// Marks drawn on reference pictures, and references pinned to every edit.
type Refs = { marks: { ref: StoredImage; stroke: Stroke }[]; pinned: StoredImage[] };

async function runJob(job: Job, img: StoredImage, strokes: Stroke[], markIds: (string | undefined)[], audioBuf: Buffer | null, opts: Opts, live?: RealtimeAsr, refs: Refs = { marks: [], pinned: [] }, prior?: Prior) {
  const dir = join(jobsDir, job.id);
  mkdirSync(dir, { recursive: true });
  const trace = new Trace();
  const T = <R>(name: string, f: () => Promise<R>) => trace.time(name, f);
  const image = img.png;
  writeFileSync(join(dir, 'strokes.json'), JSON.stringify({ strokes, refMarks: refs.marks.map((m) => ({ ref: m.ref.id, ...m.stroke })), pinned: refs.pinned.map((p) => p.id) }));

  // Masks: from the marks sent while drawing, or started now for any that weren't.
  const markResults = strokes.map((s, i) => (markIds[i] && marks.get(markIds[i]!)) || startMark(img, s).done);

  // Audio → WAV, then the transcript and the drawing video side by side.
  let wavPath: string | null = null;
  if (audioBuf?.length) {
    writeFileSync(join(dir, 'voice.webm'), audioBuf);
    wavPath = await T('to wav', () => toWav(join(dir, 'voice.webm'), join(dir, 'voice.wav')));
  }
  // No voice, no edit. From a silent video Spark invents a request ("remove
  // the lamp, make the cat bigger"), and Voice Transcribe hears "Yeah".
  if (!prior?.edits && (!wavPath || (await maxVolumeDb(wavPath)) < -40)) throw new Error('no speech');
  // The realtime transcript (streamed while talking) if it arrives, else batch.
  const keywords = keywordsFor([img, ...refs.marks.map((m) => m.ref), ...refs.pinned]);
  const batch = () => T('transcribe', () => transcribe(readFileSync(wavPath!), trace, keywords)).catch((e) => (console.error(`[${job.id}] transcribe failed:`, e), null));
  const asr = (async () => {
    if (prior?.transcript) return { transcript: prior.transcript, turns: [] as Turn[] };
    const text = live ? await T('transcribe (realtime end)', () => live.finish()) : null;
    live?.close();
    job.asrVia = text ? 'realtime' : 'batch';
    if (text) {
      trace.addUsage('transcribe (realtime)', { audioDurationMs: wavPath ? await audioDurationMs(wavPath) : 0 });
      return { transcript: text, turns: [] };
    }
    return wavPath ? batch() : null;
  })();
  asr.then((r) => (job.transcript = r?.transcript, priors.set(job.id, { transcript: r?.transcript })));
  // With marks on references, Spark watches them side by side with the picture.
  const composed = refs.marks.length ? await T('compose refs', () => composeWithRefs(image, strokes, refs.marks)) : null;
  const video = prior?.edits ? Promise.resolve(null) : T('render video', async () => {
    const durationMs = wavPath ? await audioDurationMs(wavPath) : 0;
    const [videoImage, videoStrokes] = composed ? [composed.composite, composed.strokes] : [image, strokes];
    return readFileSync(await renderVideo(videoImage, videoStrokes, wavPath, join(dir, 'video.mp4'), { durationMs, maxSide: composed ? 768 : 512 }));
  });
  const guide = T('guide image', () => guideImage(image, strokes));

  // Speculation: start Muse Image as soon as the transcript is in, guessing
  // that the n-th "this/that" goes with the n-th mark. Spark then checks.
  let spec: { clauses: string[]; edited: Promise<Buffer> } | null = null;
  if (opts.speculate && !prior?.edits && !refs.marks.length && !refs.pinned.length) {
    const asrResult = await asr;
    const clauses = asrResult ? splitClauses(asrResult.transcript, strokes.length) : null;
    if (clauses) {
      const edited = T('muse edit (speculative)', async () => museEditSpoken(image, await guide, clauses, trace, opts.muse));
      edited.catch(() => {});
      spec = { clauses, edited };
    }
  }

  // Spark, with the transcript as a hint: on its own it sometimes mishears a
  // word (in tests "노란색" became "검은색"); with the hint it doesn't.
  const [asrResult, mp4] = await Promise.all([asr, video]);
  let edits: Edit[];
  if (prior?.edits) {
    edits = prior.edits;
    job.via = 'retry';
  } else try {
    // Named parts if the background pass is already done; never waited for.
    const parts = img.partsReady ? partsHint(strokes, img.partsReady, img.width, img.height) : undefined;
    if (parts) writeFileSync(join(dir, 'parts-hint.txt'), parts);
    const r = await T('spark', () => understandVideo(mp4!, composed?.strokes ?? strokes, { effort: 'minimal', transcript: asrResult?.transcript, trace, ops: opts.instant, places: composed?.places, parts }));
    edits = r.edits;
    job.transcript ||= r.transcript;
    job.via = 'spark-video';
  } catch (e) {
    console.error(`[${job.id}] Spark video failed, falling back to transcript:`, e);
    edits = (await T('spark fallback', async () => understandTranscript(await guide, strokes, asrResult?.turns ?? [], { effort: 'minimal', trace }))).edits;
    job.via = 'transcript';
  }
  priors.set(job.id, { transcript: job.transcript, edits });
  const isRefMark = (mark: number) => refs.marks.some((m) => m.stroke.mark === mark);
  job.edits = edits.filter((e) => strokes.some((s) => s.mark === e.mark) || isRefMark(e.mark));
  writeFileSync(join(dir, 'edits.json'), JSON.stringify(job.edits, null, 2));
  // Only marks on the picture are edited; reference marks become extra images for Muse.
  const refEdits = edits.filter((e) => isRefMark(e.mark));
  edits = edits.filter((e) => strokes.some((s) => s.mark === e.mark));
  const extras = [
    ...(await Promise.all(refs.marks.map(async ({ ref, stroke }) => ({
      image: await cropAround(ref.png, stroke),
      label: `the area marked ${stroke.mark} on a reference picture${refEdits.find((e) => e.mark === stroke.mark)?.target ? ` (${refEdits.find((e) => e.mark === stroke.mark)!.target})` : ''}`,
    })))),
    ...refs.pinned.map((p) => ({ image: p.png, label: 'a reference the user pinned (a character or style sheet): keep the character on-model and the style consistent with it' })),
  ];

  const results = await Promise.all(markResults);
  for (const [i, r] of results.entries()) {
    trace.spans.push({ name: `sam mark ${strokes[i].mark}`, start: -1, ms: r.ms });
    trace.addUsage(`sam mark ${strokes[i].mark}`, r.usage);
  }
  const small = results[0].small;
  const masks = new Map<number, Mask>();
  results.forEach((r, i) => r.mask && masks.set(strokes[i].mark, r.mask));
  const seg = { masks, width: small.width, height: small.height };

  // Instant edits run locally and are shown right away. A reference mark on
  // the picture (the good cuff to copy) is told to Muse but never changed.
  const promptEdits = edits.filter((e) => !/^no change/i.test(e.instruction));
  let generative = promptEdits.filter((e) => e.kind !== 'reference');
  let local: Awaited<ReturnType<typeof applyLocal>> | null = null;
  if (opts.instant) {
    // A local edit where a generative one may also change things (a recolored
    // mug with a plant drawn in front of it) would fight the paste: Muse Image
    // does both. Repeat, since a mark moved to Muse widens the generative area.
    const isLocal = (e: Edit) => e.kind !== 'pointer' && !!e.op && LOCAL_OPS.has(e.op) && masks.has(e.mark);
    const toMuse = new Set<number>();
    for (let moved = true; moved; ) {
      moved = false;
      const areas = editAreas(strokes, generative.filter((e) => !isLocal(e) || toMuse.has(e.mark)), seg, seg.width / img.width);
      for (const e of generative) {
        if (isLocal(e) && !toMuse.has(e.mark) && touchesAreas(masks.get(e.mark)!, areas)) {
          toMuse.add(e.mark);
          moved = true;
        }
      }
    }
    local = await T('local edits', () => applyLocal(image, edits, masks, toMuse));
    if (local.done.size) {
      generative = generative.filter((e) => !local!.done.has(e.mark));
      job.localMarks = [...local.done];
      if (generative.length) job.previewImageId = (await storeImage(local.out, `${job.id}p`)).id;
    } else local = null;
  }

  let out = local?.out ?? image;
  if (generative.length) {
    job.stage = 'edit';
    const museFromEdits = () => {
      const toMuse = promptEdits.filter((e) => generative.includes(e) || e.kind === 'reference');
      const genStrokes = strokes.filter((s) => toMuse.some((e) => e.mark === s.mark));
      return T('muse edit', async () => museEdit(image, genStrokes.length === strokes.length ? await guide : await guideImage(image, genStrokes), toMuse, trace, opts.muse, extras));
    };
    let edited: Buffer;
    if (spec && specMatches(spec.clauses, edits)) {
      job.speculation = 'right';
      // If the speculative call failed (a refusal, say), Spark's reading gets its own try.
      edited = await spec.edited.catch((e) => (console.warn(`[${job.id}] speculative edit failed, editing from Spark's reading:`, e.message), (job.speculation = 'failed'), museFromEdits()));
    } else {
      if (spec) job.speculation = 'wrong';
      edited = await museFromEdits();
    }
    if (spec === null && opts.speculate) job.speculation = 'skipped';
    writeFileSync(join(dir, 'edited.jpg'), edited);
    job.stage = 'paste';
    out = (await T('paste', () => pasteMarked(image, edited, strokes, seg, generative))).out;
    // Local edits go on top, so a generative region that overlaps them (an
    // arrow crossing a recolored mug) can't undo them.
    if (local) {
      const notLocal = new Set(edits.map((e) => e.mark).filter((m) => !local!.done.has(m)));
      out = (await T('local edits again', () => applyLocal(out, edits, masks, notLocal))).out;
    }
  }

  const result = await T('store result', () => storeImage(out, `${job.id}r`));
  if (opts.speculate) console.log(`[${job.id}] speculation ${job.speculation ?? 'skipped'}`);
  writeFileSync(join(dir, 'result.jpg'), await sharp(result.png).jpeg({ quality: 95 }).toBuffer());
  job.resultImageId = result.id;
  job.stage = 'done';
  const totalMs = Date.now() - job.startedAt;
  console.log(`[${job.id}] done in ${totalMs} ms: ${trace.summary()}`);
  writeFileSync(join(dir, 'trace.json'), JSON.stringify({ totalMs, opts, asr: job.asrVia, speculation: job.speculation, localMarks: job.localMarks, spans: trace.spans, usage: trace.usage }, null, 2));
}

// The experiment's Type and Voice ways: no marks, the request as text (typed
// or transcribed), and Muse Image's whole picture as the result (no paste).
async function runWholeJob(job: Job, img: StoredImage, text: string | null, audioBuf: Buffer | null, opts: Opts, live?: RealtimeAsr) {
  const dir = join(jobsDir, job.id);
  mkdirSync(dir, { recursive: true });
  const trace = new Trace();
  const T = <R>(name: string, f: () => Promise<R>) => trace.time(name, f);
  let request = text;
  if (!request) {
    request = live ? await T('transcribe (realtime end)', () => live.finish()) : null;
    live?.close();
    if (!request && audioBuf?.length) {
      writeFileSync(join(dir, 'voice.webm'), audioBuf);
      const wav = await toWav(join(dir, 'voice.webm'), join(dir, 'voice.wav'));
      request = (await T('transcribe', () => transcribe(readFileSync(wav), trace, keywordsFor([img])))).transcript;
    }
  }
  if (!request) throw new Error('nothing was said');
  job.transcript = request;
  job.stage = 'edit';
  const { width, height } = img;
  const edited = await T('muse edit (whole)', async () => editImage(request, [await sharp(img.png).jpeg({ quality: 92 }).toBuffer()], `${width}x${height}`, trace, museParams(opts.muse)));
  writeFileSync(join(dir, 'edited.jpg'), edited);
  const result = await T('store result', () => storeImage(edited, `${job.id}r`));
  writeFileSync(join(dir, 'result.jpg'), await sharp(result.png).jpeg({ quality: 95 }).toBuffer());
  job.resultImageId = result.id;
  job.stage = 'done';
  writeFileSync(join(dir, 'trace.json'), JSON.stringify({ totalMs: Date.now() - job.startedAt, whole: true, request, spans: trace.spans, usage: trace.usage }, null, 2));
}

// ---------- http ----------

const decodeDataUrl = (s?: string) => (s ? Buffer.from(s.slice(s.indexOf(',') + 1), 'base64') : null);

const readJson = async (req: IncomingMessage) => JSON.parse((await readBody(req)).toString('utf8'));

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
    // Realtime transcription: open on record, PCM chunks while talking (each
    // reply carries the transcript so far, for live captions).
    // Body: { imageIds } — the picture and its references, whose part names to listen for.
    if (req.method === 'POST' && url.pathname === '/api/asr') {
      const body = await readJson(req).catch(() => ({}));
      const imgs = ((body.imageIds ?? []) as string[]).flatMap((id) => images.get(String(id)) ?? []);
      const keywords = keywordsFor(imgs);
      const asrId = startLiveAsr(keywords);
      console.log(`[asr ${asrId}] listening for ${keywords.length} part words`);
      return send(res, 200, { asrId });
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'asr' && parts[2]) {
      const asr = liveAsr.get(parts[2]);
      if (!asr) return send(res, 404, { error: 'no such transcription' });
      await asr.send(await readBody(req));
      return send(res, 200, { text: asr.text });
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
      if (body.whole) {
        if (!img) return send(res, 400, { error: 'need an image' });
        const job: Job = { id: newId(), stage: 'understand', startedAt: Date.now() };
        jobs.set(job.id, job);
        const live = body.asrId ? liveAsr.get(String(body.asrId)) : undefined;
        if (live) liveAsr.delete(String(body.asrId));
        runWholeJob(job, img, body.text ? String(body.text) : null, decodeDataUrl(body.audio), { ...DEFAULT_OPTS, ...(body.opts ?? {}) }, live).catch((e) => {
          console.error(`[${job.id}]`, e);
          job.error = String(e.message ?? e);
          job.stage = 'error';
        });
        return send(res, 200, { id: job.id });
      }
      const all: (Stroke & { markId?: string; on?: string })[] = body.strokes ?? [];
      const raw = all.filter((s) => !s.on);
      if (!img || !raw.length) return send(res, 400, { error: 'need an image and at least one mark on it' });
      const job: Job = { id: newId(), stage: 'understand', startedAt: Date.now() };
      jobs.set(job.id, job);
      const strokes = raw.map(({ mark, points }) => scaleStroke({ mark, points }, img.k));
      const refs: Refs = {
        marks: all.flatMap(({ mark, points, on }) => {
          const ref = on ? images.get(String(on)) : undefined;
          return ref ? [{ ref, stroke: scaleStroke({ mark, points }, ref.k) }] : [];
        }),
        pinned: ((body.pinned ?? []) as string[]).flatMap((id) => images.get(String(id)) ?? []),
      };
      const opts: Opts = { ...DEFAULT_OPTS, ...(body.opts ?? {}) };
      const live = body.asrId ? liveAsr.get(String(body.asrId)) : undefined;
      if (live) liveAsr.delete(String(body.asrId));
      const prior = body.retryOf ? priors.get(String(body.retryOf)) : undefined;
      runJob(job, img, strokes, raw.map((s) => s.markId), decodeDataUrl(body.audio), opts, live, refs, prior).catch((e) => {
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
    if (parts[0] === 'api' && parts[1] === 'images' && parts[2] && parts[3] === 'parts') {
      const img = images.get(parts[2]);
      if (!img) return send(res, 404, { error: 'no such image' });
      return send(res, 200, { parts: await partsOf(img).catch(() => []) });
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
    // Our own sample pictures (task presets and their references).
    if (parts[0] === 'api' && parts[1] === 'samples' && parts.length > 2 && parts.slice(2).every((p) => /^[\w.-]+$/.test(p) && p !== '..')) {
      return sendFile(res, join(root, 'samples', ...parts.slice(2)));
    }
    // Built client (npm run build), so one port serves everything.
    return sendFile(res, join(distDir, url.pathname === '/' ? 'index.html' : url.pathname.replace(/\.\./g, '')));
  } catch (e: any) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`This & That server on http://localhost:${PORT}`));
