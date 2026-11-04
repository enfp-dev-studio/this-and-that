// M0 risk spike, step 1: make "drawing while speaking" test clips.
// An AI image (Muse Image), objects located with Spark, numbered strokes timed
// to overlap a Korean voice track (macOS `say -v Yuna`), rendered to mp4.
//
//   node --env-file=.env m0/make-clips.ts

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { generateImage, imagePart, sparkJson } from '../server/meta.ts';
import { audioDurationMs, guideImage, renderVideo, type Point, type Stroke } from '../server/render.ts';

const out = join(import.meta.dirname, '..', 'out', 'm0');
mkdirSync(out, { recursive: true });

const PROMPT = 'Cozy digital illustration of a wooden desk by a window: a ginger cat sleeping on the left, a blue ceramic mug in the middle, a small green potted cactus on the right, a yellow desk lamp at the back right. Soft warm light, clean shapes.';
const OBJECTS = ['the cat', 'the mug', 'the cactus', 'the lamp'];

type Shape = 'circle' | 'scribble' | 'arrow-right';
type Clip = { name: string; segments: { say: string; object: string; shape: Shape; expect: string }[] };
const CLIPS: Clip[] = [
  {
    name: 'a',
    segments: [
      { say: '이거는 빨간색으로 바꾸고,', object: 'the mug', shape: 'circle', expect: 'mug → red' },
      { say: '저건 지워 줘.', object: 'the cactus', shape: 'scribble', expect: 'cactus → remove' },
    ],
  },
  {
    name: 'b',
    segments: [
      { say: '이건 없애 줘.', object: 'the lamp', shape: 'circle', expect: 'lamp → remove' },
      { say: '이거는 검은 고양이로 바꿔 줘.', object: 'the cat', shape: 'circle', expect: 'cat → black cat' },
      { say: '그리고 여기는 노란색으로.', object: 'the mug', shape: 'scribble', expect: 'mug → yellow' },
    ],
  },
  {
    name: 'c',
    segments: [
      { say: '이 고양이가', object: 'the cat', shape: 'circle', expect: 'cat → looks right (with mark 2)' },
      { say: '이쪽을 보게 해 줘.', object: 'the cat', shape: 'arrow-right', expect: 'direction for mark 1' },
      { say: '그리고 저건 초록색으로.', object: 'the mug', shape: 'circle', expect: 'mug → green' },
    ],
  },
];

const imagePath = join(out, 'image.png');
if (!existsSync(imagePath)) {
  console.log('generating image…');
  writeFileSync(imagePath, await generateImage(PROMPT));
}
const image = readFileSync(imagePath);
const { width, height } = await sharp(image).metadata();
const W = width!;
const H = height!;

const boxesPath = join(out, 'boxes.json');
if (!existsSync(boxesPath)) {
  console.log('locating objects…');
  const small = await sharp(image).resize(768).jpeg().toBuffer();
  const r = await sparkJson<{ objects: { name: string; box: number[] }[] }>({
    effort: 'minimal',
    content: [{ type: 'text', text: `Give the bounding box of each object: ${OBJECTS.map((o) => `"${o}"`).join(', ')}. Use exactly these names. Coordinates on a 0-1000 grid, (0,0) top-left.` }, imagePart(small, 'image/jpeg')],
    schema: { type: 'object', properties: { objects: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, box: { type: 'array', items: { type: 'integer' } } }, required: ['name', 'box'] } } }, required: ['objects'] },
  });
  writeFileSync(boxesPath, JSON.stringify(r.objects, null, 2));
}
const boxes = new Map<string, number[]>(JSON.parse(readFileSync(boxesPath, 'utf8')).map((o: any) => [o.name, o.box.map((v: number, i: number) => (v * (i % 2 ? H : W)) / 1000)]));

// Hand-drawn-looking stroke over a box, from t0 to t1 ms.
function strokePoints(box: number[], shape: Shape, t0: number, t1: number): Point[] {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
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
      // Arrow from the object's right edge pointing right, then a head.
      const len = Math.max(rx, W * 0.12);
      if (u < 0.7) { x = x1 + (u / 0.7) * len; y = cy; }
      else if (u < 0.85) { const v = (u - 0.7) / 0.15; x = x1 + len - v * len * 0.25; y = cy - v * len * 0.2; }
      else { const v = (u - 0.85) / 0.15; x = x1 + len - v * len * 0.25; y = cy + v * len * 0.2; }
    }
    pts.push({ x: Math.round(Math.max(0, Math.min(W - 1, x))), y: Math.round(Math.max(0, Math.min(H - 1, y))), t: Math.round(t0 + u * (t1 - t0)) });
  }
  return pts;
}

for (const clip of CLIPS) {
  const strokes: Stroke[] = [];
  const delays: { file: string; at: number }[] = [];
  let t = 400;
  clip.segments.forEach((seg, i) => {
    const aiff = join(out, `${clip.name}-${i}.aiff`);
    execFileSync('say', ['-v', 'Yuna', '-o', aiff, seg.say]);
    delays.push({ file: aiff, at: t });
    const box = boxes.get(seg.object);
    if (!box) throw new Error(`no box for ${seg.object}`);
    strokes.push({ mark: i + 1, points: strokePoints(box, seg.shape, t + 100, t + 1300) });
    (seg as any).at = t;
  });
  // Each phrase starts after the previous one ends, plus a short pause.
  for (let i = 0; i < delays.length; i++) {
    const d = await audioDurationMs(delays[i].file);
    if (i + 1 < delays.length) {
      const next = delays[i].at + Math.max(d, 1300) + 350;
      const shift = next - delays[i + 1].at;
      delays[i + 1].at = next;
      for (const p of strokes[i + 1].points) p.t += shift;
      for (let j = i + 2; j < delays.length; j++) { delays[j].at += shift; for (const p of strokes[j].points) p.t += shift; }
    }
  }
  const wav = join(out, `${clip.name}.wav`);
  const inputs = delays.flatMap((d) => ['-i', d.file]);
  const filter = delays.map((d, i) => `[${i}:a]adelay=${d.at}|${d.at}[a${i}]`).join(';') + ';' + delays.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${delays.length}:normalize=0[o]`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[o]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  const durationMs = await audioDurationMs(wav);
  const mp4 = join(out, `${clip.name}.mp4`);
  await renderVideo(image, strokes, wav, mp4, { durationMs });
  writeFileSync(join(out, `${clip.name}-guide.png`), await guideImage(image, strokes));
  writeFileSync(join(out, `${clip.name}.json`), JSON.stringify({ strokes, speech: delays.map((d, i) => ({ at: d.at, say: clip.segments[i].say, expect: clip.segments[i].expect })) }, null, 2));
  console.log(`${clip.name}: ${mp4} (${durationMs} ms) — ${clip.segments.map((s) => s.expect).join('; ')}`);
}
