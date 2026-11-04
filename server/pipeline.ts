// The This & That pipeline: strokes + voice → Spark (what to change at each
// mark) → SAM (exact region of each mark) → Muse Image (edit) → paste back.

import sharp from 'sharp';
import { editImage, imagePart, samObjects, sparkJson, videoPart, type Mask, type SamObject, type Turn } from './meta.ts';
import type { Trace } from './trace.ts';
import { colorNameOf, guideImage, pasteAlpha, pasteBack, strokeBox, type Stroke } from './render.ts';

export type Edit = {
  mark: number;
  heard?: string;
  kind?: 'object' | 'pointer';
  target: string;
  instruction: string;
  // With instant edits on: what kind of change, so simple ones run locally.
  op?: 'recolor' | 'tone' | 'scale' | 'move' | 'generative';
  color?: string;
  amount?: number;
};

// Fields Spark fills when instant edits are on.
const OP_FIELDS = {
  op: {
    type: 'string',
    enum: ['recolor', 'tone', 'scale', 'move', 'generative'],
    description: 'recolor: change the colour of the marked object, nothing else. tone: only brighter/darker. scale: only make it bigger/smaller in place. move: only move it somewhere else. generative: anything else (remove, add, replace, reshape, change pose or material, redraw). For a pointer mark use the op of the object it belongs to.',
  },
  color: { type: 'string', description: 'recolor only: the target colour as #rrggbb, a natural shade that suits the picture rather than a pure one (e.g. red #c0392b, green #3f9b4f, yellow #f2c230, black #1c1c1c, white #f2f2f2). Otherwise ""' },
  amount: { type: 'number', description: 'tone: brightness factor (1.3 brighter, 0.7 darker). scale: size factor (1.5 bigger, 0.7 smaller). Otherwise 1' },
};

// Spark's answer. Its latency follows the length of what it writes, so the
// app asks for short fields; `transcript` is only needed without the ASR hint.
function editsSchema(o: { transcript?: boolean; heard?: boolean; ops?: boolean } = { transcript: true, heard: true }) {
  const item: Record<string, object> = {
    mark: { type: 'integer', description: 'The number on the mark' },
    ...(o.heard ? { heard: { type: 'string', description: 'The words spoken while this mark was being drawn, verbatim' } } : {}),
    kind: { type: 'string', enum: ['object', 'pointer'], description: 'object: the mark circles, covers or scribbles over the thing to change. pointer: an arrow or line that shows a direction or a destination for another mark' },
    target: { type: 'string', description: 'The object or area the mark covers or points at: an English noun phrase of 1-4 words' },
    instruction: { type: 'string', description: 'The change to make there: a short English imperative of at most 12 words. Self-contained, no "this" or "that".' },
    ...(o.ops ? OP_FIELDS : {}),
  };
  return {
    type: 'object',
    properties: {
      ...(o.transcript ? { transcript: { type: 'string', description: 'Everything the person said, verbatim, in the original language' } } : {}),
      edits: { type: 'array', items: { type: 'object', properties: item, required: Object.keys(item) } },
    },
    required: [...(o.transcript ? ['transcript'] : []), 'edits'],
  };
}
const EDITS_SCHEMA = editsSchema();

const sec = (ms: number) => (ms / 1000).toFixed(1);

function markList(strokes: Stroke[], withTimes: boolean) {
  return strokes
    .map((s) => {
      const times = withTimes ? `, drawn from ${sec(s.points[0].t)} s to ${sec(s.points.at(-1)!.t)} s` : '';
      return `- mark ${s.mark}: ${colorNameOf(s.mark)}${times}`;
    })
    .join('\n');
}

const RULES = `Deictic words such as 이거/이것/이건/여기/이쪽 (this, here) and 저거/저건/저기/저쪽 (that, there) refer to the mark being drawn at the moment the word is spoken, not to the nearest object or to the order of the marks. One instruction can span several marks (e.g. "move this over here" with a circle and an arrow): then give each mark its part of the change. A mark the person said nothing about gets an instruction inferred from the other marks, or "No change".`;

// Primary path: Spark watches the drawing video with the voice track.
// A transcript from Voice Transcribe, when given, guards against mishearing.
export async function understandVideo(mp4: Buffer, strokes: Stroke[], opts: { model?: string; withTimes?: boolean; effort?: string; transcript?: string; trace?: Trace; fps?: number; heard?: boolean; ops?: boolean } = {}) {
  const heard = opts.transcript ? `\nA speech recogniser heard: "${opts.transcript}". Trust these words; use the audio for when each word is said.\n` : '';
  const text = `This video shows a person refining a picture. While speaking (often Korean), they draw numbered marks on it with a pen; each mark has its own colour and a numbered badge, and a white dot shows the pen tip while it is moving. Listen to the audio and watch when each mark is drawn.

${RULES}
${heard}
The marks:
${markList(strokes, !!opts.withTimes)}

For every mark, report ${opts.heard === false ? '' : 'what was said while drawing it and '}the change wanted there. Keep it short.`;
  const schema = opts.transcript || opts.ops ? editsSchema({ heard: opts.heard !== false, transcript: !opts.transcript, ops: opts.ops }) : EDITS_SCHEMA;
  return sparkJson<{ transcript?: string; edits: Edit[] }>({ model: opts.model, effort: opts.effort, content: [{ type: 'text', text }, videoPart(mp4, opts.fps)], schema, trace: opts.trace, label: 'spark video' });
}

// Fallback: no audio understanding; give Spark the transcript turns with
// their times plus the image with the marks.
export async function understandTranscript(guide: Buffer, strokes: Stroke[], turns: Turn[], opts: { model?: string; effort?: string; trace?: Trace } = {}) {
  const said = turns.map((t) => `- ${sec(t.startMs)}–${sec(t.endMs)} s: "${t.transcript}"`).join('\n');
  const text = `The image shows a picture with numbered marks a person drew while speaking (often Korean). Each mark has its own colour and a numbered badge.

${RULES} Match words to marks by time: within a sentence, words come roughly evenly spaced, so use where the word falls inside its sentence's time span.

The marks, with when each was drawn:
${markList(strokes, true)}

What the person said, with times:
${said}

For every mark, report what was said while drawing it and the change wanted there.`;
  return sparkJson<{ transcript: string; edits: Edit[] }>({ model: opts.model, effort: opts.effort, content: [{ type: 'text', text }, imagePart(guide)], schema: EDITS_SCHEMA, trace: opts.trace, label: 'spark transcript' });
}

// SAM works on a ≤768 px JPEG copy (2–3× faster than full size); masks come
// back at that size and are scaled up when pasting.
export type Small = { jpeg: Buffer; width: number; height: number; scale: number };
export async function smallCopy(image: Buffer): Promise<Small> {
  const meta = await sharp(image).metadata();
  const scale = Math.min(1, 768 / Math.max(meta.width!, meta.height!));
  const width = Math.round(meta.width! * scale);
  const height = Math.round(meta.height! * scale);
  return { jpeg: await sharp(image).resize(width, height).jpeg({ quality: 90 }).toBuffer(), width, height, scale };
}

// A mark as a SAM prompt. A loop around something: its box is the object. A
// scribble, line or tap lies on the object: a looser box plus points along it.
function samPrompt(s: Stroke, small: Small): SamObject {
  const { width: w, height: h, scale } = small;
  const cx = (v: number) => Math.max(0, Math.min(w - 1, Math.round(v * scale)));
  const cy = (v: number) => Math.max(0, Math.min(h - 1, Math.round(v * scale)));
  const b = strokeBox(s);
  const [p0, p1] = [s.points[0], s.points.at(-1)!];
  const size = Math.max(b.right - b.left, b.bottom - b.top);
  const closed = Math.hypot(p1.x - p0.x, p1.y - p0.y) < 0.3 * size;
  const grow = closed ? 0 : Math.max(0.2 * size, 12 / scale);
  const box = { left: cx(b.left - grow), top: cy(b.top - grow), right: cx(b.right + grow) + 1, bottom: cy(b.bottom + grow) + 1 };
  if (box.right - box.left < 8) box.right = Math.min(w, box.left + 8);
  if (box.bottom - box.top < 8) box.bottom = Math.min(h, box.top + 8);
  const step = Math.max(1, Math.floor(s.points.length / 5));
  const points = closed ? [] : s.points.filter((_, i) => i % step === 0).slice(0, 5).map((p) => ({ x: cx(p.x), y: cy(p.y) }));
  return { id: s.mark, box, points };
}

// One mark, one SAM call: run as soon as the stroke ends.
export async function segmentMark(small: Small, s: Stroke, trace?: Trace): Promise<Mask | undefined> {
  const masks = await samObjects(small.jpeg, small.width, small.height, [samPrompt(s, small)], trace, `sam mark ${s.mark}`);
  return masks.get(s.mark);
}

// All marks in one SAM call.
export async function segmentMarks(image: Buffer, strokes: Stroke[], trace?: Trace) {
  const small = await smallCopy(image);
  const masks = await samObjects(small.jpeg, small.width, small.height, strokes.map((s) => samPrompt(s, small)), trace);
  return { masks, width: small.width, height: small.height };
}

// The mark itself as a filled region (its bounding box as an ellipse), for
// marks SAM returned nothing for, and for arrows whose path matters too.
export function strokeMask(s: Stroke, width: number, height: number, scale: number): Mask {
  const b = strokeBox(s);
  const pad = 0.15;
  const cx = ((b.left + b.right) / 2) * scale;
  const cy = ((b.top + b.bottom) / 2) * scale;
  const rx = Math.max(12, ((b.right - b.left) / 2) * scale * (1 + pad));
  const ry = Math.max(12, ((b.bottom - b.top) / 2) * scale * (1 + pad));
  const data = new Uint8Array(width * height);
  for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(height, cy + ry); y++)
    for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(width, cx + rx); x++)
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) data[y * width + x] = 1;
  return { width, height, data };
}

export function editPrompt(edits: Edit[]) {
  const lines = edits
    .filter((e) => !/^no change/i.test(e.instruction))
    .map((e) => `${e.mark}. At the ${colorNameOf(e.mark)} mark numbered ${e.mark} (${e.target}): ${e.instruction}`);
  return `Edit the first image. The second image is the same picture with numbered coloured marks showing where each change goes. Make exactly these changes:
${lines.join('\n')}
Keep everything else exactly as in the first image: composition, framing, every other object, lighting and art style. The output must not contain any of the marks, lines or numbers from the second image.`;
}

// JPEG in and out: a tenth of the upload of PNG and ~2 s faster, same look
// (M2 spike). Cropping or shrinking the input did not help: Muse Image
// renders ~2.4 MP whatever it is given.
export async function museEdit(image: Buffer, guide: Buffer, edits: Edit[], trace?: Trace) {
  const { width, height } = await sharp(image).metadata();
  const jpeg = (b: Buffer) => sharp(b).jpeg({ quality: 92 }).toBuffer();
  return editImage(editPrompt(edits), [await jpeg(image), await jpeg(guide)], `${width}x${height}`, trace, { output_format: 'jpeg' });
}

// Paste only the marked regions of `edited` onto `image`.
export async function pasteMarked(image: Buffer, edited: Buffer, strokes: Stroke[], seg: { masks: Map<number, Mask>; width: number; height: number }, edits: Edit[]) {
  const { width, height } = await sharp(image).metadata();
  const scale = seg.width / width!;
  const regions: Mask[] = [];
  for (const s of strokes) {
    const e = edits.find((e) => e.mark === s.mark);
    if (!e || /^no change/i.test(e.instruction)) continue;
    // A pointer's own area may be where something moves to: paste around the stroke.
    const m = e.kind === 'pointer' ? undefined : seg.masks.get(s.mark);
    regions.push(m ?? strokeMask(s, seg.width, seg.height, scale));
  }
  if (!regions.length) return { out: await sharp(image).png().toBuffer(), alpha: Buffer.alloc(width! * height!) };
  const side = Math.max(width!, height!);
  const alpha = await pasteAlpha(regions, width!, height!, side * 0.03, side * 0.012);
  return { out: await pasteBack(image, edited, alpha), alpha };
}

export { guideImage };

// ---------- speculation: guess the mapping from the transcript alone ----------

// 이/저 only as a word of their own ("이 고양이"), so 이상한 or 저녁 don't count.
const DEICTIC = /^(?:[이저요]$|이거|이것|이건|이게|이걸|여기|이쪽|요거|요기|저거|저것|저건|저게|저걸|저기|저쪽|그거|그건|거기)/;

// Split what was said into one clause per mark, cutting before each "this /
// that / here" word, on the guess that people name marks in drawing order.
// Returns null when the count doesn't match the marks.
export function splitClauses(transcript: string, marks: number): string[] | null {
  const words = transcript.replace(/[.,!?]/g, ' ').split(/\s+/).filter(Boolean);
  // ASR sometimes repeats a word ("이거는 이거는", "이건 건"): drop the echo.
  const clean = words.filter((w, i) => i === 0 || !(w === words[i - 1] || words[i - 1].endsWith(w)));
  const clauses: string[][] = [];
  for (const w of clean) {
    if (DEICTIC.test(w) || !clauses.length) clauses.push([w]);
    else clauses.at(-1)!.push(w);
  }
  // Words before the first deictic word ("그리고") belong to it.
  if (clauses.length > 1 && !DEICTIC.test(clauses[0][0])) clauses[1].unshift(...clauses.shift()!);
  return clauses.length === marks ? clauses.map((c) => c.join(' ')) : null;
}

// Did Spark hear, mark by mark, the same words the guess assigned?
export function specMatches(clauses: string[], edits: Edit[]) {
  const bigrams = (s: string) => {
    const t = s.replace(/[^가-힣a-z0-9]/gi, '');
    return new Set(Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2)));
  };
  return clauses.every((c, i) => {
    const e = edits.find((e) => e.mark === i + 1);
    if (!e?.heard) return false;
    const a = bigrams(c), b = bigrams(e.heard);
    const shared = [...a].filter((x) => b.has(x)).length;
    return (2 * shared) / Math.max(1, a.size + b.size) >= 0.5;
  });
}

// Muse Image with the spoken words per mark, before Spark has answered.
export async function museEditSpoken(image: Buffer, guide: Buffer, clauses: string[], trace?: Trace) {
  const { width, height } = await sharp(image).metadata();
  const lines = clauses.map((c, i) => `${i + 1}. At the ${colorNameOf(i + 1)} mark numbered ${i + 1}, the person said: "${c}"`);
  const prompt = `Edit the first image. The second image is the same picture with numbered coloured marks. While drawing each mark, the person said (in Korean) what to change there; words like 이거/이건/여기 (this/here) and 저거/저건/저기 (that/there) mean what that mark covers, and 이쪽/저쪽 (this way) mean the direction a mark points:
${lines.join('\n')}
Make exactly these changes. Keep everything else exactly as in the first image: composition, framing, every other object, lighting and art style. The output must not contain any of the marks, lines or numbers from the second image.`;
  const jpeg = (b: Buffer) => sharp(b).jpeg({ quality: 92 }).toBuffer();
  return editImage(prompt, [await jpeg(image), await jpeg(guide)], `${width}x${height}`, trace, { output_format: 'jpeg' });
}
