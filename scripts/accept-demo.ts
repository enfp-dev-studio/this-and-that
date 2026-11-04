// Acceptance check for the demo's detail takes: did the edit land where the
// stroke was drawn, in its shape? The changed region (the result against the
// original, in 8 px blocks where over a quarter of the pixels moved by more
// than 40 levels) against the target (every mark's stroke filled as an outline
// and widened by 12 px). A take passes with IoU or containment (the share of
// the change inside the target) ≥ 0.5 and coverage (the share of the target
// that changed) ≥ 0.2. Also draws out/demo/accept/<take>.png: the change in
// red, the target in green, for a look.
//
//   node scripts/accept-demo.ts gem hairpin emblem three
// Reads out/demo/<take>.timing.json (the picture), <take>.result.png and clips/<take>.json (the strokes);
// writes the verdicts to out/demo/accept.json (edit-demo.ts keeps the takes that pass).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const demo = join(import.meta.dirname, '..', 'out', 'demo');
const B = 8;

async function check(name: string) {
  const { image } = JSON.parse(readFileSync(join(demo, `${name}.timing.json`), 'utf8')) as { image: string };
  const strokes = JSON.parse(readFileSync(join(demo, 'clips', `${name}.json`), 'utf8')).strokes as { points: { x: number; y: number }[]; on?: string }[];
  const meta = await sharp(image).metadata();
  const [w, h] = [meta.width!, meta.height!];
  const a = await sharp(image).removeAlpha().raw().toBuffer();
  const b = await sharp(join(demo, `${name}.result.png`)).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const polys = strokes.filter((s) => !s.on).map((s) => `<polygon points="${s.points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="#fff" stroke="#fff" stroke-width="24" stroke-linejoin="round"/>`);
  const t = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${polys.join('')}</svg>`)).extractChannel(0).raw().toBuffer();
  const [bw, bh] = [Math.ceil(w / B), Math.ceil(h / B)];
  const changed = new Uint8Array(bw * bh), target = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      let n = 0, c = 0, g = 0;
      for (let y = by * B; y < Math.min(h, by * B + B); y++)
        for (let x = bx * B; x < Math.min(w, bx * B + B); x++) {
          const i = (y * w + x) * 3;
          n++;
          if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 40) c++;
          if (t[y * w + x] > 127) g++;
        }
      changed[by * bw + bx] = c > n / 4 ? 1 : 0;
      target[by * bw + bx] = g > n / 4 ? 1 : 0;
    }
  let inter = 0, nc = 0, nt = 0;
  for (let i = 0; i < changed.length; i++) (inter += changed[i] & target[i]), (nc += changed[i]), (nt += target[i]);
  const iou = inter / Math.max(1, nc + nt - inter), contain = inter / Math.max(1, nc), cover = inter / Math.max(1, nt);
  const pass = (iou >= 0.5 || contain >= 0.5) && cover >= 0.2;
  // The look: the result dimmed, the change red, the target's edge green.
  const over = Buffer.alloc(bw * bh * 4);
  for (let i = 0; i < changed.length; i++) {
    const edge = target[i] && (!target[i - 1] || !target[i + 1] || !target[i - bw] || !target[i + bw]);
    if (edge) over.set([60, 220, 90, 255], i * 4);
    else if (changed[i]) over.set([255, 40, 40, 150], i * 4);
  }
  mkdirSync(join(demo, 'accept'), { recursive: true });
  const layer = await sharp(over, { raw: { width: bw, height: bh, channels: 4 } }).resize(w, h, { kernel: 'nearest' }).png().toBuffer();
  const dim = await sharp(join(demo, `${name}.result.png`)).resize(w, h, { fit: 'fill' }).modulate({ brightness: 0.6 }).composite([{ input: layer }]).png().toBuffer();
  await sharp(dim).resize(640).jpeg().toFile(join(demo, 'accept', `${name}.jpg`));
  console.log(`${name.padEnd(8)} ${pass ? 'PASS' : 'FAIL'}  IoU ${iou.toFixed(2)}  containment ${contain.toFixed(2)}  coverage ${cover.toFixed(2)}  (changed ${nc}, target ${nt} blocks)`);
  return { pass, iou: +iou.toFixed(2), containment: +contain.toFixed(2), coverage: +cover.toFixed(2) };
}

const file = join(demo, 'accept.json');
const verdicts = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
for (const name of process.argv.slice(2)) {
  const v = await check(name).catch((e) => console.log(`${name}: ${e.message}`));
  if (v) verdicts[name] = v;
}
writeFileSync(file, JSON.stringify(verdicts, null, 1));
