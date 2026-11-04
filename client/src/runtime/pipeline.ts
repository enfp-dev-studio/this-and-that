// The This & That pipeline: strokes + voice → Spark (what to change at each
// mark) → SAM (exact region of each mark) → Muse Image (edit) → paste back.

import { editImage, imagePart, samObjects, sparkJson, videoPart, type Mask, type SamObject, type Turn } from './meta';
import type { Trace } from './trace';
import { colorNameOf, drawn, guideImage, jpegUrl, strokeBox, type Source, type Stroke } from './render';

export type Edit = {
  mark: number;
  heard?: string;
  kind?: 'object' | 'pointer' | 'reference' | 'sketch';
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
    kind: { type: 'string', enum: ['object', 'pointer', 'reference', 'sketch'], description: 'object: the mark circles, covers or scribbles over the thing to change (a selection). sketch: the stroke itself draws the wanted new shape, outline, silhouette or detail; its geometry is what to follow. pointer: an arrow or line that shows a direction or a destination for another mark. reference: a mark on a reference picture, showing what something should look like' },
    target: { type: 'string', description: 'The object or area the mark covers or points at: an English noun phrase of 1-4 words' },
    instruction: { type: 'string', description: 'The change to make there: a short English imperative of at most 12 words. Self-contained, no "this" or "that". For a sketch: "Reshape the <target> to follow the drawn outline" plus any detail said.' },
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

function markList(strokes: Stroke[], withTimes: boolean, places?: Map<number, string>) {
  return strokes
    .map((s) => {
      const times = withTimes ? `, drawn from ${sec(s.points[0].t)} s to ${sec(s.points.at(-1)!.t)} s` : '';
      const place = places?.get(s.mark) ? `, on ${places.get(s.mark)}` : '';
      const pen = s.pen === 'shape' ? ' (drawn with the Shape pen: kind sketch)' : s.pen === 'point' ? ' (drawn with the Point pen: a selection or pointer, never a sketch)' : '';
      return `- mark ${s.mark}: ${colorNameOf(s.mark)}${place}${pen}${times}`;
    })
    .join('\n');
}

const REF_RULES = `The video shows reference picture(s) on the left and the picture to edit on the right. A mark on a reference shows what something should look like (an ornament, a hairpin, a lace pattern, a face or pose): give it kind "reference" and say in target what it shows. The instruction for the related mark on the picture to edit must name the reference mark, e.g. "Redesign the hairpin to match reference mark 1".`;

const RULES = `Deictic words such as 이거/이것/이건/여기/이쪽 (this, here) and 저거/저건/저기/저쪽 (that, there) refer to the mark being drawn at the moment the word is spoken, not to the nearest object or to the order of the marks. One instruction can span several marks (e.g. "move this over here" with a circle and an arrow): then give each mark its part of the change. A mark the person said nothing about gets an instruction inferred from the other marks, or "No change".
A mark can draw the new shape itself rather than select something: the person says so (이렇게, 이 모양으로, 이런 모양, 이렇게 생기게, like this, this shape), and the stroke is a deliberate contour (an outline, spikes, a silhouette, an added detail) traced over or beside the object, not a loose loop or scribble around it. Give such a mark kind "sketch" and an instruction to reshape the target to follow the drawn outline, even when the stroke lies over an existing part. A loop drawn just to say "this one" is an object mark.`;

// Primary path: Spark watches the drawing video with the voice track.
// A transcript from Voice Transcribe, when given, guards against mishearing.
export async function understandVideo(mp4: string, strokes: Stroke[], opts: { model?: string; withTimes?: boolean; effort?: string; transcript?: string; trace?: Trace; fps?: number; heard?: boolean; ops?: boolean; places?: Map<number, string>; parts?: string } = {}) {
  const heard = opts.transcript ? `\nA speech recogniser heard: "${opts.transcript}". Trust these words; use the audio for when each word is said.\n` : '';
  const text = `This video shows a person refining a picture. While speaking (often Korean), they draw numbered marks on it with a pen; each mark has its own colour and a numbered badge, and a white dot shows the pen tip while it is moving. Listen to the audio and watch when each mark is drawn.

${RULES}${opts.places ? `\n${REF_RULES}` : ''}
${heard}
The marks:
${markList(strokes, !!opts.withTimes, opts.places)}
${opts.parts ?? ''}
For every mark, report ${opts.heard === false ? '' : 'what was said while drawing it and '}the change wanted there. Keep it short.`;
  const schema = opts.transcript || opts.ops ? editsSchema({ heard: opts.heard !== false, transcript: !opts.transcript, ops: opts.ops }) : EDITS_SCHEMA;
  return sparkJson<{ transcript?: string; edits: Edit[] }>({ model: opts.model, effort: opts.effort, content: [{ type: 'text', text }, videoPart(mp4, opts.fps)], schema, trace: opts.trace, label: 'spark video' });
}

// Fallback: no audio understanding; give Spark the transcript turns with
// their times plus the image with the marks.
export async function understandTranscript(guide: string, strokes: Stroke[], turns: Turn[], opts: { model?: string; effort?: string; trace?: Trace } = {}) {
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

// Fallback for browsers that can't encode video: a key frame at the end of
// each mark, and the realtime transcript as it grew (each word with when it
// first appeared), so "this" can still be matched to the mark being drawn.
export async function understandFrames(frames: { t: number; url: string }[], strokes: Stroke[], words: { word: string; at: number }[], opts: { effort?: string; transcript?: string; trace?: Trace; ops?: boolean; places?: Map<number, string>; parts?: string } = {}) {
  const said = words.map((w) => `${sec(w.at)} s: ${w.word}`).join('\n');
  const text = `A person is refining a picture. While speaking (often Korean), they draw numbered marks on it with a pen; each mark has its own colour and a numbered badge. The images are snapshots taken when each mark was finished.

${RULES}${opts.places ? `\n${REF_RULES}` : ''}
Match words to marks by time: a word belongs to the mark being drawn when it was said. Speech recognition reports each word ~0.5 s after it was spoken.

The marks, with when each was drawn:
${markList(strokes, true, opts.places)}

What the person said${opts.transcript ? ` ("${opts.transcript}")` : ''}, word by word with when each was recognised:
${said || '(no timings)'}
${opts.parts ?? ''}
For every mark, report what was said while drawing it and the change wanted there. Keep it short.`;
  const content: any[] = [{ type: 'text', text }];
  for (const f of frames) content.push({ type: 'text', text: `Snapshot at ${sec(f.t)} s:` }, imagePart(f.url));
  const schema = editsSchema({ heard: true, transcript: !opts.transcript, ops: opts.ops });
  return sparkJson<{ transcript?: string; edits: Edit[] }>({ effort: opts.effort, content, schema, trace: opts.trace, label: 'spark frames' });
}

// SAM works on a ≤768 px JPEG copy (2–3× faster than full size); masks come
// back at that size and are scaled up when pasting.
export type Small = { jpeg: string; width: number; height: number; scale: number }; // jpeg: data URL
export async function smallCopy(image: Source): Promise<Small> {
  const scale = Math.min(1, 768 / Math.max(image.width, image.height));
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  return { jpeg: jpegUrl(drawn(image, width, height), 0.9), width, height, scale };
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
  // A tap: the point alone. With a tiny box around it SAM outlines a
  // fragment (a 35×48 px blob of a macaron); with the point, the whole thing.
  if (size * scale < 8) return { id: s.mark, points: [{ x: cx(p0.x), y: cy(p0.y) }] };
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
export async function segmentMarks(image: Source, strokes: Stroke[], trace?: Trace) {
  const small = await smallCopy(image);
  const masks = await samObjects(small.jpeg, small.width, small.height, strokes.map((s) => samPrompt(s, small)), trace);
  return { masks, width: small.width, height: small.height };
}

export function editPrompt(edits: Edit[]) {
  const lines = edits
    .filter((e) => !/^no change/i.test(e.instruction))
    .map((e) => {
      const line = `${e.mark}. At the ${colorNameOf(e.mark)} mark numbered ${e.mark} (${e.target}): ${e.instruction}`;
      // A sketch: the line is the new outline, not a selection.
      return e.kind === 'sketch' ? `${line}. The ${colorNameOf(e.mark)} line ${e.mark} is the new outline drawn by the person: reshape the ${e.target} so its edge follows that line exactly (its path, proportions and size), keeping its material, colour, lighting and detail.` : line;
    });
  return `Edit the first image. The second image is the same picture with numbered coloured marks showing where each change goes. Make exactly these changes:
${lines.join('\n')}
Keep everything else exactly as in the first image: composition, framing, every other object, lighting and art style. The output must not contain any of the marks, lines or numbers from the second image.`;
}

// JPEG in and out: a tenth of the upload of PNG and ~2 s faster, same look
// (M2 spike). Cropping or shrinking the input did not help: Muse Image
// renders ~2.4 MP whatever it is given.
// Muse Image is an agentic planner with image search, web search and a shell
// on by default; an edit needs none of them. Turning them off kept quality and
// the median (~9.8 s) but cut the slow tail (max 15.9 → 11.8 s over 12 runs);
// reasoning_strength low halves input tokens but was no faster, and edits are
// billed per image, so it saves nothing.
export type MuseMode = 'default' | 'notools' | 'notools-low';
export const museParams = (mode: MuseMode = 'default') => ({
  output_format: 'jpeg',
  ...(mode !== 'default' ? { tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false } } : {}),
  ...(mode === 'notools-low' ? { reasoning_strength: 'low' } : {}),
});

// Extra images after the picture and its guide: crops around reference marks
// and pinned references (Muse Image takes up to 10 images in all).
export type Extra = { image: Source; label: string };

export async function museEdit(image: Source, guide: Source, edits: Edit[], trace?: Trace, mode?: MuseMode, extras: Extra[] = []) {
  const { width, height } = image;
  const used = extras.slice(0, 8);
  const refLines = used.map((x, i) => `Image ${i + 3} is ${x.label}.`).join('\n');
  const prompt = used.length ? `${editPrompt(edits)}\n${refLines}\nWhere an instruction refers to a reference, copy its design, pattern and details faithfully, adapted to the picture's angle, lighting and style.` : editPrompt(edits);
  return editImage(prompt, [image, guide, ...used.map((x) => x.image)].map((x) => jpegUrl(x)), `${width}x${height}`, trace, museParams(mode));
}

export { guideImage };
export { editAreas, pasteMarked, strokeHull, strokeMask, touchesAreas, type Seg } from './paste';

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
  // A clause with no "this / that" word means the recogniser lost it ("이거
  // 초콜릿으로" heard as "가초콜릿으로"): the words can't be trusted, Spark decides.
  if (!clauses.every((c) => c.some((w) => DEICTIC.test(w)))) return null;
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
export async function museEditSpoken(image: Source, guide: Source, clauses: string[], trace?: Trace, mode?: MuseMode) {
  const { width, height } = image;
  const lines = clauses.map((c, i) => `${i + 1}. At the ${colorNameOf(i + 1)} mark numbered ${i + 1}, the person said: "${c}"`);
  const prompt = `Edit the first image. The second image is the same picture with numbered coloured marks. While drawing each mark, the person said (in Korean) what to change there; words like 이거/이건/여기 (this/here) and 저거/저건/저기 (that/there) mean what that mark covers, and 이쪽/저쪽 (this way) mean the direction a mark points. The words come from speech recognition and may contain mistakes (a word that sounds alike): read each as the most plausible instruction for what is under its mark.
${lines.join('\n')}
Make exactly these changes. Keep everything else exactly as in the first image: composition, framing, every other object, lighting and art style. The output must not contain any of the marks, lines or numbers from the second image.`;
  return editImage(prompt, [image, guide].map((x) => jpegUrl(x)), `${width}x${height}`, trace, museParams(mode));
}

// ---------- parts: what is in the picture, found once in the background ----------

// A named part, its box on a 0–1000 grid, its parent (character → outfit →
// cuff → lace) and its mirror pair (left/right counterpart); 0 = none. `ko`
// is the word a Korean speaker would say for it, so speech recognition can
// be told to listen for it.
export type Part = { id: number; name: string; ko?: string; box: number[]; parent: number; pair: number };

const PARTS_SCHEMA = {
  type: 'object',
  properties: {
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'From 1' },
          name: { type: 'string', description: 'Short English name, with left/right as the viewer sees the picture where it matters' },
          ko: { type: 'string', description: 'What a Korean speaker would call it, in 1-2 Korean words without left/right (e.g. 브로치, 머리핀, 소매 레이스)' },
          box: { type: 'array', items: { type: 'integer' }, description: '[x_min, y_min, x_max, y_max] on a 0-1000 grid' },
          parent: { type: 'integer', description: 'id of the part this belongs to, or 0' },
          pair: { type: 'integer', description: 'id of its left/right counterpart (the other cuff, earring, eye), or 0' },
        },
        required: ['id', 'name', 'ko', 'box', 'parent', 'pair'],
      },
    },
  },
  required: ['parts'],
};

export async function findParts(small: Small, trace?: Trace): Promise<Part[]> {
  const text = `List the parts of this picture someone might want to edit, as a hierarchy where it helps (character → outfit → left cuff → lace). Include small details: jewelry, hair accessories, ornaments, brooches, emblems, eyes, hands, lace, embroidery, buttons, and the main objects and background areas. Give each a short name, the Korean word for it, a tight box, its parent, and its left/right counterpart if it has one. At most 40 parts.`;
  // Background work, 12-16 s: a longer deadline than the interactive calls.
  const r = await sparkJson<{ parts: Part[] }>({ effort: 'minimal', content: [{ type: 'text', text }, imagePart(small.jpeg)], schema: PARTS_SCHEMA, trace, label: 'spark parts', timeoutMs: 45_000 });
  return r.parts.filter((p) => p.box?.length === 4);
}

// Words for Voice Transcribe to listen for: what the parts are called, in
// Korean and English, one or two words each.
export function partKeywords(parts: Part[], max = 80) {
  const words = parts.flatMap((p) => [p.ko, p.name.replace(/\b(left|right|upper|lower|top|bottom)\b/gi, '').trim()]);
  return [...new Set(words.filter((w): w is string => !!w && w.split(/\s+/).length <= 2))].slice(0, max);
}

// A weak, last-resort naming hint for Spark: the named parts each mark covers
// (the most specific first) and their pairs. The strokes and the words decide;
// parts never pick SAM's target or the paste region (both come from the stroke).
export function partsHint(strokes: Stroke[], parts: Part[], width: number, height: number) {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const px = (p: Part) => ({ left: (p.box[0] * width) / 1000, top: (p.box[1] * height) / 1000, right: (p.box[2] * width) / 1000, bottom: (p.box[3] * height) / 1000 });
  const area = (b: { left: number; top: number; right: number; bottom: number }) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
  const lines = strokes.map((s) => {
    const m = strokeBox(s);
    const covered = parts
      .map((p) => {
        const b = px(p);
        const inter = area({ left: Math.max(b.left, m.left), top: Math.max(b.top, m.top), right: Math.min(b.right, m.right), bottom: Math.min(b.bottom, m.bottom) });
        return { p, size: area(b), share: inter / Math.max(1, Math.min(area(b), area(m))) };
      })
      .filter((c) => c.share > 0.4)
      .sort((a, b) => a.size - b.size)
      .slice(0, 3)
      .map(({ p }) => {
        const parent = byId.get(p.parent)?.name;
        const pair = byId.get(p.pair)?.name;
        return `"${p.name}"${parent ? ` (part of "${parent}")` : ''}${pair ? `, its pair: "${pair}"` : ''}`;
      });
    return covered.length ? `- mark ${s.mark} is over: ${covered.join('; ')}` : '';
  });
  const text = lines.filter(Boolean).join('\n');
  return text ? `\nOptional vocabulary for naming things. The person's strokes (their exact shape and where they are) and their words always decide what the mark means and what to change. Never treat a mark as a selection just because a named part is under it.\n${text}\n` : '';
}
