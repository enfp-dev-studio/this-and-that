// The app's "server", running in the browser. The client hands over the image
// once, each mark the moment its stroke ends (SAM runs while the user is still
// talking), then the voice on release; the job runs here and its progress is
// read the way it used to be polled. Every model call goes through the
// Worker proxy (meta.ts); pictures, results, voice and traces are kept in
// IndexedDB and OPFS (store.ts).
//
//   uploadImage(url | Blob)          → { imageId, width, height }
//   mark(imageId, markId, stroke)    → { markId, found, overlay } once SAM is done
//   startAsr(imageIds)               → a realtime transcription, keywords from the parts
//   startJob({ imageId, strokes, pcm, asr, … })  → { id }
//   job(id)                          progress, transcript, edits, resultImageId
//   imageUrl(id)                     the picture, for <img> and canvases

import { blobToDataUrl, editImage, RealtimeAsr, transcribe, type Mask, type Turn } from './meta';
import { editAreas, findParts, guideImage, partKeywords, museEdit, museEditSpoken, museParams, partsHint, touchesAreas, type MuseMode, type Part, segmentMark, smallCopy, specMatches, splitClauses, understandFrames, understandTranscript, understandVideo, type Edit, type Small } from './pipeline';
import { LOCAL_OPS } from './local';
import { applyLocalOff, pasteMarkedOff } from './pixels';
import { audioDurationMs, canEncodeVideo, warmUpVideo, colorOf, composeWithRefs, cropAround, dataUrlOf, drawn, encode, fromPixels, jpegUrl, keyFrames, maxVolumeDb, outlineImage, pixels, renderVideo, toWav, type Source, type Stroke } from './render';
import { Trace } from './trace';
import { all, del, get, loadBlob, put, removeBlob, saveBlob } from './store';

const MAX_SIDE = 2048;
const MAX_UPLOAD_BYTES = 40e6;
const MAX_UPLOAD_PIXELS = 60e6;
// Probe the video codecs and wake the encoder before the first edit needs them.
setTimeout(warmUpVideo, 1500);

// What this browser keeps stays bounded: the last few sessions' pictures
// (and anything from the last hour, such as a result not yet kept), and the
// voice, video and raw edit of the last 30 jobs. Records and traces are small
// and stay.
const KEEP_SESSIONS = 5;
const KEEP_JOB_FILES = 30;
async function prune() {
  const sessions = (await all<{ id: string; at: number; versions?: string[]; refs?: { imageId: string }[] }>('sessions')).sort((a, b) => b.at - a.at);
  for (const old of sessions.slice(KEEP_SESSIONS)) await del('sessions', old.id);
  const keep = new Set(sessions.slice(0, KEEP_SESSIONS).flatMap((x) => [...(x.versions ?? []), ...(x.refs ?? []).map((r) => r.imageId)]));
  const hourAgo = Date.now() - 3600_000;
  for (const img of await all<{ id: string; at?: number; type?: string }>('images')) {
    if (keep.has(img.id) || images.has(img.id) || (img.at ?? 0) > hourAgo) continue;
    await removeBlob(`images/${img.id}.${img.type === 'image/png' ? 'png' : 'jpg'}`);
    await del('images', img.id);
    await del('parts', img.id);
  }
  const jobRecords = (await all<{ id: string; startedAt?: number }>('jobs')).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  for (const j of jobRecords.slice(KEEP_JOB_FILES)) await removeBlob(`jobs/${j.id}`);
}
setTimeout(() => prune().catch((e) => console.warn('[store] prune:', e)), 10_000);
const newId = () => crypto.randomUUID().slice(0, 8);

// ---------- images ----------

// Uploads are scaled to ≤2048 px; `k` maps the client's pixel coordinates
// (the image as uploaded) to the stored ones.
type StoredImage = { id: string; bitmap: ImageBitmap; width: number; height: number; k: number; url: string; small: Promise<Small>; parts?: Promise<Part[]>; partsReady?: Part[] };
const images = new Map<string, StoredImage>();

async function storeImage(input: Blob | ImageData, id = newId()): Promise<StoredImage> {
  let bitmap: ImageBitmap, blob: Blob, k = 1;
  if (input instanceof ImageData) {
    // A result: already at its stored size.
    const c = fromPixels(input);
    [bitmap, blob] = await Promise.all([createImageBitmap(c), encode(c, 'image/jpeg', 0.95)]);
  } else {
    const first = await createImageBitmap(input);
    if (first.width * first.height > MAX_UPLOAD_PIXELS) {
      first.close();
      throw new Error(`that picture is over ${MAX_UPLOAD_PIXELS / 1e6} megapixels`);
    }
    k = Math.min(1, MAX_SIDE / Math.max(first.width, first.height));
    if (k === 1) [bitmap, blob] = [first, input]; // <img> shows the upload itself
    else {
      const c = drawn(first, Math.round(first.width * k), Math.round(first.height * k));
      first.close();
      [bitmap, blob] = await Promise.all([createImageBitmap(c), encode(c, 'image/jpeg', 0.95)]);
    }
  }
  const { width, height } = bitmap;
  // SAM's small copy, made when first needed (a preview never is).
  let small: Promise<Small> | null = null;
  const img: StoredImage = { id, bitmap, width, height, k, url: URL.createObjectURL(blob), get small() { return (small ??= smallCopy(bitmap)); } };
  images.set(id, img);
  saveBlob(`images/${id}.${blob.type === 'image/png' ? 'png' : 'jpg'}`, blob);
  put('images', { id, width, height, k, type: blob.type, at: Date.now() });
  return img;
}

// The picture's named parts: one Spark call in the background, once per image.
// Optional: nothing waits for it, and SAM at each stroke still makes the masks.
function partsOf(img: StoredImage) {
  img.parts ??= (async () => {
    const t0 = performance.now();
    const parts = await findParts(await img.small);
    img.partsReady = parts;
    put('parts', { id: img.id, parts, ms: Math.round(performance.now() - t0) });
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
async function overlayUrl(r: MarkResult, mark: number) {
  const { width, height } = r.small;
  const out = new ImageData(width, height);
  if (r.mask) {
    const [cr, cg, cb] = [1, 3, 5].map((i) => parseInt(colorOf(mark).slice(i, i + 2), 16));
    for (let i = 0; i < r.mask.data.length; i++) if (r.mask.data[i]) out.data.set([cr, cg, cb, 255], i * 4);
  }
  return URL.createObjectURL(await encode(fromPixels(out), 'image/png'));
}

// ---------- jobs ----------

export type Job = {
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
  trace?: unknown; // per-stage timing and token usage, once done
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

// Experiments, each switchable per request (opts). `understand`: how Spark
// is shown the drawing — the video with the voice, or key frames plus the
// realtime transcript's word timings (for browsers without WebCodecs).
export type Opts = { instant: boolean; speculate: boolean; muse: MuseMode; understand?: 'video' | 'frames' };
// Speculation is on: with part names as ASR keywords it was taken and right in
// 9/10 bench replays and 5/6 browser runs, never taken wrong (README).
const DEFAULT_OPTS: Opts = { instant: true, speculate: true, muse: 'notools' };

// Marks drawn on reference pictures, and references pinned to every edit.
type Refs = { marks: { ref: StoredImage; stroke: Stroke }[]; pinned: StoredImage[] };

// Words with when each first showed up in the realtime transcript.
function wordTimes(partials: { at: number; text: string }[]) {
  const words: { word: string; at: number }[] = [];
  for (const p of partials) {
    const ws = p.text.split(/\s+/).filter(Boolean);
    for (let i = 0; i < ws.length; i++) {
      if (i < words.length) {
        if (words[i].word !== ws[i]) words[i] = { word: ws[i], at: words[i].at };
      } else words.push({ word: ws[i], at: p.at });
    }
    words.length = Math.min(words.length, ws.length);
  }
  return words;
}

async function runJob(job: Job, img: StoredImage, strokes: Stroke[], markIds: (string | undefined)[], pcm: Int16Array | null, opts: Opts, live?: RealtimeAsr | null, refs: Refs = { marks: [], pinned: [] }, prior?: Prior) {
  const dir = `jobs/${job.id}`;
  const trace = new Trace();
  const T = <R>(name: string, f: () => Promise<R>) => trace.time(name, f);
  const image = img.bitmap;
  put('jobs', { id: job.id, imageId: img.id, startedAt: job.startedAt, strokes, refMarks: refs.marks.map((m) => ({ ref: m.ref.id, ...m.stroke })), pinned: refs.pinned.map((p) => p.id) });

  // Masks: from the marks sent while drawing, or started now for any that weren't.
  const markResults = strokes.map((s, i) => (markIds[i] && marks.get(markIds[i]!)) || startMark(img, s).done);

  const wav = pcm?.length ? toWav(pcm) : null;
  if (wav) saveBlob(`${dir}/voice.wav`, wav);
  // No voice, no edit. From a silent video Spark invents a request ("remove
  // the lamp, make the cat bigger"), and Voice Transcribe hears "Yeah".
  if (!prior?.transcript && !prior?.edits && (!pcm?.length || maxVolumeDb(pcm) < -40)) {
    live?.close();
    throw new Error('no speech');
  }
  // The realtime transcript (streamed while talking) if it arrives, else batch.
  const keywords = keywordsFor([img, ...refs.marks.map((m) => m.ref), ...refs.pinned]);
  const batch = () => T('transcribe', () => transcribe(wav!, trace, keywords)).catch((e) => (console.error(`[${job.id}] transcribe failed:`, e), null));
  const asr = (async () => {
    if (prior?.transcript) return { transcript: prior.transcript, turns: [] as Turn[] };
    const text = live ? await T('transcribe (realtime end)', () => live.finish()) : null;
    live?.close();
    job.asrVia = text ? 'realtime' : 'batch';
    if (text) {
      trace.addUsage('transcribe (realtime)', { audioDurationMs: audioDurationMs(pcm) });
      return { transcript: text, turns: [] as Turn[] };
    }
    return wav ? batch() : null;
  })();
  asr.then((r) => (job.transcript = r?.transcript, priors.set(job.id, { transcript: r?.transcript })));
  // With marks on references, Spark watches them side by side with the picture.
  const composed = refs.marks.length ? composeWithRefs(image, strokes, refs.marks.map((m) => ({ ref: { id: m.ref.id, bitmap: m.ref.bitmap }, stroke: m.stroke }))) : null;
  const understand = opts.understand ?? ((await canEncodeVideo()) ? 'video' : 'frames');
  const [videoImage, videoStrokes] = composed ? [composed.composite, composed.strokes] : [image as Source, strokes];
  const video = prior?.edits || understand !== 'video' ? Promise.resolve(null) : T('render video', async () => {
    const mp4 = await renderVideo(videoImage, videoStrokes, pcm, { durationMs: audioDurationMs(pcm), maxSide: composed ? 768 : 512 });
    saveBlob(`${dir}/video.mp4`, mp4);
    return blobToDataUrl(mp4);
  });
  video.catch(() => {});
  const guide = T('guide image', async () => guideImage(image, strokes));

  // Speculation: start Muse Image as soon as the transcript is in, guessing
  // that the n-th "this/that" goes with the n-th mark. Spark then checks.
  let spec: { clauses: string[]; edited: Promise<Blob> } | null = null;
  // Not for Shape-pen marks: the spoken words alone don't say to follow a drawn outline.
  if (opts.speculate && !prior?.edits && !refs.marks.length && !refs.pinned.length && !strokes.some((s) => s.pen === 'shape')) {
    const asrResult = await asr;
    // "이렇게 / 이 모양으로 / like this" may mean a drawn shape: leave that to Spark.
    const shapeWords = /이렇게|이런\s*(모양|식)|(이|저)\s*모양|모양으로|like this|this shape/i.test(asrResult?.transcript ?? '');
    const clauses = asrResult && !shapeWords ? splitClauses(asrResult.transcript, strokes.length) : null;
    if (clauses) {
      const edited = T('muse edit (speculative)', async () => museEditSpoken(image, await guide, clauses, trace, opts.muse));
      edited.catch(() => {});
      spec = { clauses, edited };
    }
  }

  // Spark, with the transcript as a hint: on its own it sometimes mishears a
  // word (in tests "노란색" became "검은색"); with the hint it doesn't.
  const [asrResult, mp4] = await Promise.all([asr, video.catch((e) => (console.error(`[${job.id}] video failed:`, e), null))]);
  let edits: Edit[];
  // Named parts if the background pass is already done; never waited for.
  const parts = img.partsReady ? partsHint(strokes, img.partsReady, img.width, img.height) : undefined;
  if (prior?.edits) {
    edits = prior.edits;
    job.via = 'retry';
  } else try {
    if (mp4) {
      const r = await T('spark', () => understandVideo(mp4, composed?.strokes ?? strokes, { effort: 'minimal', transcript: asrResult?.transcript, trace, ops: opts.instant, places: composed?.places, parts }));
      edits = r.edits;
      job.transcript ||= r.transcript;
      job.via = 'spark-video';
    } else {
      const frames = keyFrames(videoImage, videoStrokes).map((f) => ({ t: f.t, url: jpegUrl(f.canvas, 0.85) }));
      const words = live ? wordTimes(live.partials) : [];
      const r = await T('spark', () => understandFrames(frames, composed?.strokes ?? strokes, words, { effort: 'minimal', transcript: asrResult?.transcript, trace, ops: opts.instant, places: composed?.places, parts }));
      edits = r.edits;
      job.transcript ||= r.transcript;
      job.via = 'spark-frames';
    }
  } catch (e) {
    console.error(`[${job.id}] Spark failed, falling back to transcript:`, e);
    const guideUrl = dataUrlOf(await guide, 'image/png');
    edits = (await T('spark fallback', async () => understandTranscript(guideUrl, strokes, asrResult?.turns ?? [], { effort: 'minimal', trace }))).edits;
    job.via = 'transcript';
  }
  priors.set(job.id, { transcript: job.transcript, edits });
  // The pen the user picked wins over Spark's reading.
  for (const e of edits) {
    const pen = strokes.find((s) => s.mark === e.mark)?.pen;
    if (pen === 'shape') e.kind = 'sketch';
    else if (pen === 'point' && e.kind === 'sketch') e.kind = 'object';
  }
  const isRefMark = (mark: number) => refs.marks.some((m) => m.stroke.mark === mark);
  job.edits = edits.filter((e) => strokes.some((s) => s.mark === e.mark) || isRefMark(e.mark));
  // Only marks on the picture are edited; reference marks become extra images for Muse.
  const refEdits = edits.filter((e) => isRefMark(e.mark));
  edits = edits.filter((e) => strokes.some((s) => s.mark === e.mark));
  const extras = [
    ...refs.marks.map(({ ref, stroke }) => ({
      image: cropAround(ref.bitmap, stroke) as Source,
      label: `the area marked ${stroke.mark} on a reference picture${refEdits.find((e) => e.mark === stroke.mark)?.target ? ` (${refEdits.find((e) => e.mark === stroke.mark)!.target})` : ''}`,
    })),
    ...refs.pinned.map((p) => ({ image: p.bitmap as Source, label: 'a reference the user pinned (a character or style sheet): keep the character on-model and the style consistent with it' })),
    // Each sketch alone, so its exact geometry is unmistakable.
    ...edits.filter((e) => e.kind === 'sketch').map((e) => ({
      image: outlineImage(img.width, img.height, strokes.find((s) => s.mark === e.mark)!) as Source,
      label: `line ${e.mark} alone, black on white at the same size and place as in the picture: the exact new outline for the ${e.target}`,
    })),
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
  const original = pixels(image);

  // Instant edits run locally and are shown right away. A reference mark on
  // the picture (the good cuff to copy) is told to Muse but never changed.
  const promptEdits = edits.filter((e) => !/^no change/i.test(e.instruction));
  let generative = promptEdits.filter((e) => e.kind !== 'reference');
  let local: Awaited<ReturnType<typeof applyLocalOff>> | null = null;
  if (opts.instant) {
    // A local edit where a generative one may also change things (a recolored
    // mug with a plant drawn in front of it) would fight the paste: Muse Image
    // does both. Repeat, since a mark moved to Muse widens the generative area.
    const isLocal = (e: Edit) => e.kind !== 'pointer' && e.kind !== 'sketch' && !!e.op && LOCAL_OPS.has(e.op) && masks.has(e.mark);
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
    local = await T('local edits', () => applyLocalOff(original, edits, masks, toMuse));
    if (local.done.size) {
      generative = generative.filter((e) => !local!.done.has(e.mark));
      job.localMarks = [...local.done];
      // Shown when ready; Muse Image doesn't wait for it.
      if (generative.length) storeImage(local.out, `${job.id}p`).then((p) => (job.previewImageId ??= p.id));
    } else local = null;
  }

  let out = local?.out ?? original;
  if (generative.length) {
    job.stage = 'edit';
    const museFromEdits = () => {
      const toMuse = promptEdits.filter((e) => generative.includes(e) || e.kind === 'reference');
      const genStrokes = strokes.filter((s) => toMuse.some((e) => e.mark === s.mark));
      return T('muse edit', async () => museEdit(image, genStrokes.length === strokes.length ? await guide : guideImage(image, genStrokes), toMuse, trace, opts.muse, extras));
    };
    let edited: Blob;
    if (spec && !edits.some((e) => e.kind === 'sketch') && specMatches(spec.clauses, edits)) {
      job.speculation = 'right';
      // If the speculative call failed (a refusal, say), Spark's reading gets its own try.
      edited = await spec.edited.catch((e) => (console.warn(`[${job.id}] speculative edit failed, editing from Spark's reading:`, e.message), (job.speculation = 'failed'), museFromEdits()));
    } else {
      if (spec) job.speculation = 'wrong';
      edited = await museFromEdits();
    }
    if (spec === null && opts.speculate) job.speculation = 'skipped';
    saveBlob(`${dir}/edited.jpg`, edited);
    job.stage = 'paste';
    const editedBitmap = await createImageBitmap(edited);
    out = (await T('paste', () => pasteMarkedOff(original, editedBitmap, strokes, seg, generative))).out;
    // Local edits go on top, so a generative region that overlaps them (an
    // arrow crossing a recolored mug) can't undo them.
    if (local) {
      const notLocal = new Set(edits.map((e) => e.mark).filter((m) => !local!.done.has(m)));
      out = (await T('local edits again', () => applyLocalOff(out, edits, masks, notLocal))).out;
    }
  }

  const result = await T('store result', () => storeImage(out, `${job.id}r`));
  if (opts.speculate) console.log(`[${job.id}] speculation ${job.speculation ?? 'skipped'}`);
  job.resultImageId = result.id;
  job.stage = 'done';
  const totalMs = Date.now() - job.startedAt;
  console.log(`[${job.id}] done in ${totalMs} ms: ${trace.summary()}`);
  job.trace = { totalMs, opts: { ...opts, understand }, asr: job.asrVia, via: job.via, speculation: job.speculation, localMarks: job.localMarks, spans: trace.spans, usage: trace.usage };
  saveJob(job);
}

// The experiment's Type and Voice ways: no marks, the request as text (typed
// or transcribed), and Muse Image's whole picture as the result (no paste).
async function runWholeJob(job: Job, img: StoredImage, text: string | null, pcm: Int16Array | null, opts: Opts, live?: RealtimeAsr | null) {
  const trace = new Trace();
  const T = <R>(name: string, f: () => Promise<R>) => trace.time(name, f);
  let request = text;
  if (!request) {
    request = live ? await T('transcribe (realtime end)', () => live.finish()) : null;
    live?.close();
    if (!request && pcm?.length) request = (await T('transcribe', () => transcribe(toWav(pcm), trace, keywordsFor([img])))).transcript;
  }
  if (!request) throw new Error('nothing was said');
  job.transcript = request;
  job.stage = 'edit';
  const { width, height } = img;
  const edited = await T('muse edit (whole)', async () => editImage(request, [jpegUrl(img.bitmap, 0.92)], `${width}x${height}`, trace, museParams(opts.muse)));
  saveBlob(`jobs/${job.id}/edited.jpg`, edited);
  const result = await T('store result', () => storeImage(edited, `${job.id}r`));
  job.resultImageId = result.id;
  job.stage = 'done';
  job.trace = { totalMs: Date.now() - job.startedAt, whole: true, request, spans: trace.spans, usage: trace.usage };
  saveJob(job);
}

// The final state over the record written at the start (strokes, references).
async function saveJob(job: Job) {
  const { trace, ...record } = job;
  const first = await get<Record<string, unknown>>('jobs', job.id);
  put('jobs', { ...first, ...record, at: Date.now() });
  if (trace) put('traces', { id: job.id, ...(trace as object) });
}

// ---------- the client's side ----------

export type JobStroke = Stroke & { markId?: string; on?: string };
export type JobBody = {
  imageId: string;
  strokes?: JobStroke[];
  pinned?: string[];
  pcm?: Int16Array | null; // the voice, 16 kHz mono
  asr?: RealtimeAsr | null; // the realtime transcription of it, to finish
  opts?: Partial<Opts>;
  retryOf?: string;
  whole?: boolean;
  text?: string;
};

export const runtime = {
  async uploadImage(input: string | Blob) {
    const blob = typeof input === 'string' ? await (await fetch(input)).blob() : input;
    // It is scaled to ≤2048 px anyway; this keeps a huge file from filling the tab's memory.
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error(`that picture is over ${MAX_UPLOAD_BYTES / 1e6} MB`);
    const img = await storeImage(blob);
    return { imageId: img.id, width: img.width, height: img.height };
  },

  imageUrl: (id: string) => images.get(id)?.url ?? '',
  // The exact pixels (the url is a JPEG for results): the 3D surface edit compares them.
  bitmap: (id: string) => images.get(id)?.bitmap ?? null,

  // A picture kept in this browser (IndexedDB + OPFS), back under its own id,
  // with its part names if they were found. Null if it is gone.
  async restoreImage(id: string): Promise<string | null> {
    if (images.has(id)) return images.get(id)!.url;
    const rec = await get<{ type?: string }>('images', id);
    const blob = rec && (await loadBlob(`images/${id}.${rec.type === 'image/png' ? 'png' : 'jpg'}`));
    if (!blob) return null;
    const bitmap = await createImageBitmap(blob);
    let small: Promise<Small> | null = null;
    // Stored at its working size, so the client's coordinates need no scaling (k = 1).
    const img: StoredImage = { id, bitmap, width: bitmap.width, height: bitmap.height, k: 1, url: URL.createObjectURL(blob), get small() { return (small ??= smallCopy(bitmap)); } };
    const parts = (await get<{ parts: Part[] }>('parts', id))?.parts;
    if (parts) Object.assign(img, { parts: Promise.resolve(parts), partsReady: parts });
    images.set(id, img);
    return img.url;
  },

  // The most recent session with a picture in it.
  async lastSession() {
    const sessions = await all<{ id: string; at: number; versions: string[]; index: number; refs: { id: string; imageId: string; pinned: boolean }[] }>('sessions');
    return sessions.filter((x) => x.versions?.length).sort((a, b) => b.at - a.at)[0] ?? null;
  },

  // Asking starts the background parts pass, whose names Voice Transcribe listens for.
  async parts(imageId: string): Promise<Part[]> {
    const img = images.get(imageId);
    return img ? partsOf(img).catch(() => []) : [];
  },

  async mark(imageId: string, markId: string, stroke: Stroke) {
    const img = images.get(imageId);
    if (!img || !stroke.points?.length) throw new Error('need a known imageId and a stroke');
    // The client names the mark, so a job sent before SAM answers still finds it.
    const { id, done } = startMark(img, scaleStroke(stroke, img.k), markId || undefined);
    const r = await done;
    return { markId: id, found: !!r.mask, overlay: r.mask ? await overlayUrl(r, stroke.mark) : null, ms: r.ms };
  },

  // Realtime transcription: open on record; the client streams PCM into it.
  // `imageIds`: the picture and its references, whose part names to listen for.
  startAsr(imageIds: string[]) {
    const keywords = keywordsFor(imageIds.flatMap((id) => images.get(id) ?? []));
    return new RealtimeAsr(keywords);
  },

  startJob(body: JobBody) {
    const img = images.get(body.imageId);
    const opts: Opts = { ...DEFAULT_OPTS, ...(body.opts ?? {}) };
    if (!img) throw new Error('need an image');
    const job: Job = { id: newId(), stage: 'understand', startedAt: Date.now() };
    const failed = (e: any) => {
      console.error(`[${job.id}]`, e);
      job.error = String(e?.message ?? e);
      job.stage = 'error';
      saveJob(job);
    };
    if (body.whole) {
      jobs.set(job.id, job);
      runWholeJob(job, img, body.text ?? null, body.pcm ?? null, opts, body.asr).catch(failed);
      return { id: job.id };
    }
    const all = body.strokes ?? [];
    const raw = all.filter((s) => !s.on);
    if (!raw.length) throw new Error('need an image and at least one mark on it');
    jobs.set(job.id, job);
    const strokes = raw.map(({ mark, points, pen }) => scaleStroke({ mark, points, ...(pen === 'shape' || pen === 'point' ? { pen } : {}) }, img.k));
    const refs: Refs = {
      marks: all.flatMap(({ mark, points, on }) => {
        const ref = on ? images.get(on) : undefined;
        return ref ? [{ ref, stroke: scaleStroke({ mark, points }, ref.k) }] : [];
      }),
      pinned: (body.pinned ?? []).flatMap((id) => images.get(id) ?? []),
    };
    // Typed instead of said (the keyboard fallback): the text is the transcript.
    const prior = body.retryOf ? priors.get(body.retryOf) : body.text ? { transcript: body.text } : undefined;
    runJob(job, img, strokes, raw.map((s) => s.markId), body.pcm ?? null, opts, body.asr, refs, prior).catch(failed);
    return { id: job.id };
  },

  job(id: string) {
    const job = jobs.get(id);
    return job ? { ...job, elapsedMs: Date.now() - job.startedAt } : null;
  },
};
