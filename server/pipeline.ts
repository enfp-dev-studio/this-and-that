// The This & That pipeline: strokes + voice → Spark (what to change at each
// mark) → SAM (exact region of each mark) → Muse Image (edit) → paste back.

import sharp from 'sharp';
import { editImage, imagePart, samObjects, sparkJson, videoPart, type Mask, type Turn } from './meta.ts';
import { colorNameOf, guideImage, pasteAlpha, pasteBack, strokeBox, type Stroke } from './render.ts';

export type Edit = { mark: number; heard: string; kind?: 'object' | 'pointer'; target: string; instruction: string };

const EDITS_SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: 'string', description: 'Everything the person said, verbatim, in the original language' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          mark: { type: 'integer', description: 'The number on the mark' },
          heard: { type: 'string', description: 'The words spoken while this mark was being drawn, verbatim' },
          kind: { type: 'string', enum: ['object', 'pointer'], description: 'object: the mark circles, covers or scribbles over the thing to change. pointer: an arrow or line that shows a direction or a destination for another mark' },
          target: { type: 'string', description: 'Short English noun phrase for the object or area the mark covers or points at' },
          instruction: { type: 'string', description: 'One English sentence: the change to make there. Self-contained, no "this" or "that".' },
        },
        required: ['mark', 'heard', 'kind', 'target', 'instruction'],
      },
    },
  },
  required: ['transcript', 'edits'],
};

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
export async function understandVideo(mp4: Buffer, strokes: Stroke[], opts: { model?: string; withTimes?: boolean; effort?: string; transcript?: string } = {}) {
  const heard = opts.transcript ? `\nA speech recogniser heard: "${opts.transcript}". Trust these words; use the audio for when each word is said.\n` : '';
  const text = `This video shows a person refining a picture. While speaking (often Korean), they draw numbered marks on it with a pen; each mark has its own colour and a numbered badge, and a white dot shows the pen tip while it is moving. Listen to the audio and watch when each mark is drawn.

${RULES}
${heard}
The marks:
${markList(strokes, !!opts.withTimes)}

For every mark, report what was said while drawing it and the change wanted there.`;
  return sparkJson<{ transcript: string; edits: Edit[] }>({ model: opts.model, effort: opts.effort, content: [{ type: 'text', text }, videoPart(mp4)], schema: EDITS_SCHEMA });
}

// Fallback: no audio understanding; give Spark the transcript turns with
// their times plus the image with the marks.
export async function understandTranscript(guide: Buffer, strokes: Stroke[], turns: Turn[], opts: { model?: string; effort?: string } = {}) {
  const said = turns.map((t) => `- ${sec(t.startMs)}–${sec(t.endMs)} s: "${t.transcript}"`).join('\n');
  const text = `The image shows a picture with numbered marks a person drew while speaking (often Korean). Each mark has its own colour and a numbered badge.

${RULES} Match words to marks by time: within a sentence, words come roughly evenly spaced, so use where the word falls inside its sentence's time span.

The marks, with when each was drawn:
${markList(strokes, true)}

What the person said, with times:
${said}

For every mark, report what was said while drawing it and the change wanted there.`;
  return sparkJson<{ transcript: string; edits: Edit[] }>({ model: opts.model, effort: opts.effort, content: [{ type: 'text', text }, imagePart(guide)], schema: EDITS_SCHEMA });
}

// SAM on a ≤768 px copy: each mark's bounding box (a circle around an object,
// or a scribble over it) as the box prompt. Returns masks at that small size.
export async function segmentMarks(image: Buffer, strokes: Stroke[]) {
  const meta = await sharp(image).metadata();
  const scale = Math.min(1, 768 / Math.max(meta.width!, meta.height!));
  const w = Math.round(meta.width! * scale);
  const h = Math.round(meta.height! * scale);
  const small = await sharp(image).resize(w, h).jpeg({ quality: 90 }).toBuffer();
  const cx = (v: number) => Math.max(0, Math.min(w - 1, Math.round(v * scale)));
  const cy = (v: number) => Math.max(0, Math.min(h - 1, Math.round(v * scale)));
  const objects = strokes.map((s) => {
    const b = strokeBox(s);
    const [p0, p1] = [s.points[0], s.points.at(-1)!];
    const size = Math.max(b.right - b.left, b.bottom - b.top);
    const closed = Math.hypot(p1.x - p0.x, p1.y - p0.y) < 0.3 * size;
    // A loop around something: its box is the object. A scribble, line or tap
    // lies on the object: a looser box plus points along the stroke.
    const grow = closed ? 0 : Math.max(0.2 * size, 12 / scale);
    const box = { left: cx(b.left - grow), top: cy(b.top - grow), right: cx(b.right + grow) + 1, bottom: cy(b.bottom + grow) + 1 };
    if (box.right - box.left < 8) box.right = Math.min(w, box.left + 8);
    if (box.bottom - box.top < 8) box.bottom = Math.min(h, box.top + 8);
    const step = Math.max(1, Math.floor(s.points.length / 5));
    const points = closed ? [] : s.points.filter((_, i) => i % step === 0).slice(0, 5).map((p) => ({ x: cx(p.x), y: cy(p.y) }));
    return { id: s.mark, box, points };
  });
  return { masks: await samObjects(small, w, h, objects), width: w, height: h };
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

export async function museEdit(image: Buffer, guide: Buffer, edits: Edit[]) {
  const { width, height } = await sharp(image).metadata();
  const png = await sharp(image).png().toBuffer();
  return editImage(editPrompt(edits), [png, guide], `${width}x${height}`);
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
