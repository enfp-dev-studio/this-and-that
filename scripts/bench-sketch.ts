// Drawing a new shape: the knight's left pauldron, redrawn as three tall
// spikes over the old dome while saying "이 어깨갑주를 이렇게 뾰족하게 바꿔 줘".
// Replays it against a running server and saves original | marks | result,
// cropped to the shoulder, to out/sketch/<label>.jpg.
//
//   node --env-file=.env scripts/bench-sketch.ts <label>      (server on BASE, default :8787)
//   PEN=shape    drawn with the Shape pen (default: auto, Spark decides)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildClip } from '../m0/clipkit.ts';
import { guideImage, type Point, type Stroke } from '../server/render.ts';
import { imageIdOf, replay } from './replay.ts';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const label = process.argv[2] ?? 'run';
const root = join(import.meta.dirname, '..');
const dir = join(root, 'out', 'sketch');
const imagePath = join(root, 'samples', 'illust', 'armor.jpg');
const image = readFileSync(imagePath);

// The new outline: an open contour from the shoulder's left base over three
// spikes to its right base, above the current top edge (y ≈ 480).
const CORNERS = [[280, 640], [330, 470], [380, 560], [430, 395], [480, 530], [530, 440], [575, 600]];
function contour(t0: number, t1: number): Point[] {
  const pts: Point[] = [];
  const n = 12; // points per segment
  const segs = CORNERS.length - 1;
  for (let i = 0; i < segs; i++)
    for (let k = 0; k < n; k++) {
      const u = k / n, [x0, y0] = CORNERS[i], [x1, y1] = CORNERS[i + 1];
      const w = 1.5 * Math.sin((i * n + k) * 0.9); // a hand's wobble
      pts.push({ x: Math.round(x0 + (x1 - x0) * u + w), y: Math.round(y0 + (y1 - y0) * u + w), t: Math.round(t0 + ((t1 - t0) * (i * n + k)) / (segs * n)) });
    }
  pts.push({ x: CORNERS.at(-1)![0], y: CORNERS.at(-1)![1], t: t1 });
  return pts;
}

if (!existsSync(join(dir, 'pauldron.json'))) {
  await buildClip(dir, 'pauldron', image, [{ say: '이 어깨갑주를 이렇게 뾰족하게 바꿔 줘.', box: [280, 395, 575, 640], shape: 'circle' }]);
  const clip = JSON.parse(readFileSync(join(dir, 'pauldron.json'), 'utf8'));
  const s = clip.strokes[0];
  clip.strokes[0].points = contour(s.points[0].t, s.points.at(-1).t + 600);
  writeFileSync(join(dir, 'pauldron.json'), JSON.stringify(clip, null, 2));
}
const clip = JSON.parse(readFileSync(join(dir, 'pauldron.json'), 'utf8'));
const pen = process.env.PEN === 'shape' ? 'shape' : undefined;
const strokes: Stroke[] = clip.strokes.map((s: Stroke) => ({ ...s, ...(pen ? { pen } : {}) }));

const r = await replay(BASE, await imageIdOf(BASE, imagePath), strokes, join(dir, 'pauldron.wav'));
console.log(JSON.stringify({ label, pen: pen ?? 'auto', total: r.total, error: r.job.error ?? null, transcript: r.job.transcript, edits: r.job.edits }, null, 2));
if (r.job.error) process.exit(1);

// original | marks | result, cropped to the shoulder
const crop = { left: 180, top: 330, width: 520, height: 420 };
const result = Buffer.from(await (await fetch(`${BASE}/api/jobs/${r.id}/result.jpg`)).arrayBuffer());
const tiles = await Promise.all([image, await guideImage(image, strokes), result].map((b) => sharp(b).extract(crop).toBuffer()));
await sharp({ create: { width: crop.width * 3 + 20, height: crop.height, channels: 3, background: '#111' } })
  .composite(tiles.map((input, i) => ({ input, left: i * (crop.width + 10), top: 0 })))
  .jpeg({ quality: 90 })
  .toFile(join(dir, `${label}.jpg`));
console.log(`saved out/sketch/${label}.jpg (original | marks | result)`);
