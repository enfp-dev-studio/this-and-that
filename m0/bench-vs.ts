// Same model, only the input differs. For each case (an image made with Muse
// Image and one wanted change):
//   text:  Muse Image edit with the instruction typed the way a user would in a
//          chat, whole image back, no paste-back
//   t&t:   This & That: a mark drawn while saying it in Korean, through the
//          running server (realtime transcript, Spark, SAM, Muse, paste-back)
// Measures time per round and drift: the share of pixels outside the intended
// region that changed (any channel by more than 24/255). Success is judged by
// eye from the side-by-side images in out/bench/.
//
//   node --env-file=.env m0/bench-vs.ts                 round 1, all cases
//   node --env-file=.env m0/bench-vs.ts 2 add,move      round 2 for these (on round 1's output)
//   TT_ONLY=1 …                                          re-run only This & That for that round

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { editImage, generateImage } from '../server/meta.ts';
import { buildClip, locate, replay, type Box, type Segment } from './clipkit.ts';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const out = join(import.meta.dirname, '..', 'out', 'bench');
mkdirSync(out, { recursive: true });

type Case = {
  name: string;
  prompt: string;
  objects: string[];
  text: string; // as typed in a chat
  followUp: string; // what a chat user types when round 1 missed
  segments: (b: Map<string, Box>, W: number, H: number) => Segment[];
  region: (b: Map<string, Box>, W: number, H: number) => Box[]; // where change is wanted
};

const grow = ([x0, y0, x1, y1]: Box, f: number): Box => [x0 - (x1 - x0) * f, y0 - (y1 - y0) * f, x1 + (x1 - x0) * f, y1 + (y1 - y0) * f];
const get = (b: Map<string, Box>, k: string) => {
  const v = b.get(k);
  if (!v) throw new Error(`not located: ${k}`);
  return v;
};

const CASES: Case[] = [
  {
    name: 'remove',
    prompt: 'Bright flat illustration of a kitchen counter: a white coffee cup on the left, a silver toaster in the middle, a bowl of oranges on the right, blue tiled wall behind.',
    objects: ['the coffee cup'],
    text: 'remove the coffee cup on the left',
    followUp: 'remove only the coffee cup and keep everything else exactly the same',
    segments: (b) => [{ say: '이거 지워 줘.', box: get(b, 'the coffee cup'), shape: 'circle' }],
    region: (b) => [grow(get(b, 'the coffee cup'), 0.2)],
  },
  {
    name: 'recolor',
    prompt: 'Illustration of a red bicycle leaning against a brick wall next to a blue wooden door, sunny street, clean shapes.',
    objects: ['the door'],
    text: 'make the blue door green',
    followUp: 'only the door should be green, keep everything else exactly the same',
    segments: (b) => [{ say: '이 문을 초록색으로 바꿔 줘.', box: get(b, 'the door'), shape: 'circle' }],
    region: (b) => [grow(get(b, 'the door'), 0.1)],
  },
  {
    name: 'add',
    prompt: 'Illustration of an empty wooden park bench under a big tree on green grass, afternoon light, clean shapes.',
    objects: ['the bench'],
    text: 'add a sleeping orange cat on the bench',
    followUp: 'add the sleeping orange cat on the left end of the bench, keep everything else exactly the same',
    // Circle the left half of the seat; the cat may rise above it.
    segments: (b) => {
      const [x0, y0, x1, y1] = get(b, 'the bench');
      return [{ say: '여기에 자는 주황색 고양이를 넣어 줘.', box: [x0 + (x1 - x0) * 0.08, y0, x0 + (x1 - x0) * 0.48, y0 + (y1 - y0) * 0.55], shape: 'circle' }];
    },
    region: (b) => {
      const [x0, y0, x1, y1] = get(b, 'the bench');
      return [[x0 - (x1 - x0) * 0.1, y0 - (y1 - y0) * 0.9, x1 + (x1 - x0) * 0.1, y1]];
    },
  },
  {
    name: 'move',
    prompt: 'Illustration of a cozy living room: a grey sofa in the middle, a tall floor lamp just left of the sofa, empty wooden floor to the right of the sofa, plain beige wall.',
    objects: ['the floor lamp', 'the sofa'],
    text: 'move the floor lamp to the right side of the sofa',
    followUp: 'put the floor lamp on the right of the sofa and nothing on its left, keep everything else exactly the same',
    segments: (b) => {
      const lamp = get(b, 'the floor lamp'), sofa = get(b, 'the sofa');
      const to: [number, number] = [sofa[2] + (lamp[2] - lamp[0]) * 0.8, (lamp[1] + lamp[3]) / 2];
      return [
        { say: '이 램프를', box: lamp, shape: 'circle' },
        { say: '여기로 옮겨 줘.', box: lamp, shape: 'arrow', to },
      ];
    },
    region: (b) => {
      const lamp = get(b, 'the floor lamp'), sofa = get(b, 'the sofa');
      const w = lamp[2] - lamp[0];
      return [grow(lamp, 0.15), grow([sofa[2] + 0.3 * w - w / 2, lamp[1], sofa[2] + 1.3 * w, lamp[3]], 0.15)];
    },
  },
  {
    name: 'reshape',
    prompt: 'Illustration of a study: a round white wall clock on a green wall above a wooden desk with a stack of books and a mug.',
    objects: ['the wall clock'],
    text: 'make the round wall clock square',
    followUp: 'only change the clock to a square one, keep everything else exactly the same',
    segments: (b) => [{ say: '이 시계를 네모나게 바꿔 줘.', box: get(b, 'the wall clock'), shape: 'circle' }],
    region: (b) => [grow(get(b, 'the wall clock'), 0.15)],
  },
  {
    name: 'hand',
    prompt: 'Illustration portrait of a smiling woman with short black hair raising one open hand to wave, plain light background, upper body.',
    objects: ['her raised hand'],
    text: 'change her raised open hand into a thumbs-up',
    followUp: 'only her raised hand should become a thumbs-up, keep her face and everything else exactly the same',
    segments: (b) => [{ say: '이 손을 엄지 척으로 바꿔 줘.', box: get(b, 'her raised hand'), shape: 'circle' }],
    region: (b) => [grow(get(b, 'her raised hand'), 0.4)],
  },
];

// Share of pixels outside the region that changed, original vs result.
async function drift(original: Buffer, result: Buffer, region: Box[]) {
  const { width: W, height: H } = await sharp(original).metadata();
  const a = await sharp(original).removeAlpha().raw().toBuffer();
  const b = await sharp(result).resize(W!, H!, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const inside = (x: number, y: number) => region.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  let outside = 0, changed = 0;
  for (let y = 0; y < H!; y++) for (let x = 0; x < W!; x++) {
    if (inside(x, y)) continue;
    outside++;
    const i = (y * W! + x) * 3;
    if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 24) changed++;
  }
  return Math.round((1000 * changed) / outside) / 10;
}

// Original | text | This & That, the intended region outlined on the original.
async function sideBySide(file: string, original: Buffer, text: Buffer, tt: Buffer, region: Box[], title: string) {
  const w = 640;
  const { width: W, height: H } = await sharp(original).metadata();
  const h = Math.round((H! * w) / W!);
  const k = w / W!;
  const rects = region.map(([x0, y0, x1, y1]) => `<rect x="${x0 * k}" y="${y0 * k}" width="${(x1 - x0) * k}" height="${(y1 - y0) * k}" fill="none" stroke="#ff2d55" stroke-width="3" stroke-dasharray="8 5"/>`).join('');
  const panel = async (b: Buffer, label: string, extra = '') =>
    sharp(b).resize(w, h, { fit: 'fill' }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${extra}<rect x="0" y="0" width="${w}" height="34" fill="black" fill-opacity="0.6"/><text x="10" y="24" font-size="20" font-family="Helvetica" fill="white">${label}</text></svg>`) }]).png().toBuffer();
  const panels = [await panel(original, 'original (dashed: intended region)', rects), await panel(text, 'text-only Muse edit'), await panel(tt, 'This &amp; That')];
  const header = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w * 3}" height="40"><rect width="100%" height="100%" fill="#111"/><text x="12" y="27" font-size="22" font-family="Helvetica" fill="white">${title.replace(/&/g, '&amp;')}</text></svg>`);
  await sharp({ create: { width: w * 3, height: h + 40, channels: 3, background: '#111' } })
    .composite([{ input: header, top: 0, left: 0 }, ...panels.map((p, i) => ({ input: p, top: 40, left: i * w }))])
    .jpeg({ quality: 88 }).toFile(file);
}

const round = Number(process.argv[2] ?? 1);
const only = process.argv[3]?.split(',');
const rows: string[] = [];

await Promise.all(CASES.filter((c) => !only || only.includes(c.name)).map(async (c) => {
  const dir = join(out, c.name);
  mkdirSync(dir, { recursive: true });
  const imagePath = join(dir, 'original.png');
  if (!existsSync(imagePath)) writeFileSync(imagePath, await generateImage(c.prompt));
  const original = readFileSync(imagePath);
  const { width: W, height: H } = await sharp(original).metadata();
  const boxesPath = join(dir, 'boxes.json');
  if (!existsSync(boxesPath)) writeFileSync(boxesPath, JSON.stringify(Object.fromEntries(await locate(original, c.objects))));
  const boxes = new Map<string, Box>(Object.entries(JSON.parse(readFileSync(boxesPath, 'utf8'))));
  const region = c.region(boxes, W!, H!);

  // Each round edits the previous round's output, as a user would.
  const textIn = round === 1 ? original : readFileSync(join(dir, `text-${round - 1}.jpg`));
  const ttIn = round === 1 ? original : readFileSync(join(dir, `tt-${round - 1}.jpg`));

  // TT_ONLY=1 re-runs This & That only, keeping this round's text result.
  const prev = process.env.TT_ONLY ? JSON.parse(readFileSync(join(dir, `round-${round}.json`), 'utf8')) : null;
  const [text, tt] = await Promise.all([
    prev ? { img: readFileSync(join(dir, `text-${round}.jpg`)), ms: prev.textMs as number } : (async () => {
      const t0 = performance.now();
      const { width, height } = await sharp(textIn).metadata();
      const img = await editImage(round === 1 ? c.text : c.followUp, [await sharp(textIn).jpeg({ quality: 92 }).toBuffer()], `${width}x${height}`, undefined, { output_format: 'jpeg' });
      return { img, ms: Math.round(performance.now() - t0) };
    })(),
    (async () => {
      const clip = await buildClip(dir, `clip-${round}`, original, c.segments(boxes, W!, H!));
      const image = `data:image/jpeg;base64,${(await sharp(ttIn).jpeg({ quality: 95 }).toBuffer()).toString('base64')}`;
      const { imageId } = await (await fetch(`${BASE}/api/images`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) })).json();
      const r = await replay(BASE, imageId, clip.strokes, clip.wav, { speculate: process.env.SPECULATE === '1' });
      return { img: readFileSync(join(import.meta.dirname, '..', 'out', 'jobs', r.id, 'result.jpg')), ms: r.total, edits: r.job.edits, transcript: r.job.transcript };
    })(),
  ]);
  writeFileSync(join(dir, `text-${round}.jpg`), text.img);
  writeFileSync(join(dir, `tt-${round}.jpg`), tt.img);
  const [dText, dTt] = [await drift(original, text.img, region), await drift(original, tt.img, region)];
  await sideBySide(join(out, `${c.name}-r${round}.jpg`), original, text.img, tt.img, region,
    `${c.name}, round ${round} | text: "${round === 1 ? c.text : c.followUp}" ${text.ms} ms, drift ${dText}% | T&T: ${tt.ms} ms, drift ${dTt}%`);
  const row = { case: c.name, round, textMs: text.ms, textDrift: dText, ttMs: tt.ms, ttDrift: dTt, heard: tt.transcript, edits: tt.edits.map((e: any) => `${e.mark}:${e.target}→${e.instruction} [${e.op ?? ''}]`) };
  writeFileSync(join(dir, `round-${round}.json`), JSON.stringify(row, null, 2));
  rows.push(JSON.stringify(row));
}));
console.log(rows.sort().join('\n'));
