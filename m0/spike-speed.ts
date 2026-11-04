// M2 speed spike: which Muse Image edit request is fastest without losing
// quality? Same edits each time; variants differ in input size/format,
// reasoning strength and cropping around the marks.
//
//   node --env-file=.env m0/spike-speed.ts [clip] [runs]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { editImage } from '../server/meta.ts';
import { editPrompt, guideImage, type Edit } from '../server/pipeline.ts';
import { strokeBox, type Stroke } from '../server/render.ts';
import { Trace } from '../server/trace.ts';

const out = join(import.meta.dirname, '..', 'out', 'm0');
const name = process.argv[2] ?? 'a';
const runs = Number(process.argv[3] ?? 2);
const clip = JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8'));
const strokes: Stroke[] = clip.strokes;
const edits: Edit[] = JSON.parse(readFileSync(join(out, 'understand-fast.json'), 'utf8')).find((c: any) => c.clip === name).runs.find((r: any) => r.label === 'spark-1.3 minimal').r.edits;
const image = readFileSync(join(out, 'image.png'));
const guide = await guideImage(image, strokes);
const prompt = editPrompt(edits);
const W = 1920, H = 1280;

// Union box of the marks, padded by 40% of its size, clamped.
const boxes = strokes.map(strokeBox);
const ub = { left: Math.min(...boxes.map((b) => b.left)), top: Math.min(...boxes.map((b) => b.top)), right: Math.max(...boxes.map((b) => b.right)), bottom: Math.max(...boxes.map((b) => b.bottom)) };
const px = (ub.right - ub.left) * 0.4, py = (ub.bottom - ub.top) * 0.4;
const crop = { left: Math.max(0, Math.round(ub.left - px)), top: Math.max(0, Math.round(ub.top - py)) } as any;
crop.width = Math.min(W, Math.round(ub.right + px)) - crop.left;
crop.height = Math.min(H, Math.round(ub.bottom + py)) - crop.top;

const png = (b: Buffer, w?: number) => sharp(b).resize(w).png().toBuffer();
const jpg = (b: Buffer, w?: number) => sharp(b).resize(w).jpeg({ quality: 90 }).toBuffer();
const VARIANTS: Record<string, () => Promise<{ images: Buffer[]; size: string; extra?: object }>> = {
  'full png': async () => ({ images: [image, guide], size: `${W}x${H}` }),
  'full jpeg': async () => ({ images: [await jpg(image), await jpg(guide)], size: `${W}x${H}` }),
  'full jpeg, jpeg out': async () => ({ images: [await jpg(image), await jpg(guide)], size: `${W}x${H}`, extra: { output_format: 'jpeg' } }),
  '1024 jpeg': async () => ({ images: [await jpg(image, 1024), await jpg(guide, 1024)], size: `1024x683` }),
  'full jpeg, low': async () => ({ images: [await jpg(image), await jpg(guide)], size: `${W}x${H}`, extra: { reasoning_strength: 'low' } }),
  [`crop ${crop.width}x${crop.height} jpeg`]: async () => ({
    images: [await sharp(image).extract(crop).jpeg({ quality: 90 }).toBuffer(), await sharp(guide).extract(crop).jpeg({ quality: 90 }).toBuffer()],
    size: `${crop.width}x${crop.height}`,
  }),
};

const results: Record<string, number[]> = {};
await Promise.all(Object.entries(VARIANTS).flatMap(([label, make]) => Array.from({ length: runs }, async (_, i) => {
  const req = await make();
  const trace = new Trace();
  const t0 = performance.now();
  try {
    const buf = await editImage(prompt, req.images, req.size, trace, req.extra);
    const ms = Math.round(performance.now() - t0);
    (results[label] ??= []).push(ms);
    const meta = await sharp(buf).metadata();
    const file = join(out, `speed-${name}-${label.replace(/\W+/g, '_')}-${i}.png`);
    writeFileSync(file, await sharp(buf).png().toBuffer());
    console.log(`${label} #${i}: ${ms} ms, upload ${Math.round(req.images.reduce((n, b) => n + b.length, 0) / 1024)} KB, out ${meta.width}x${meta.height} ${meta.format} ${Math.round(buf.length / 1024)} KB, usage ${JSON.stringify(trace.usage[0]?.usage)}`);
  } catch (e: any) {
    console.log(`${label} #${i}: ✗ ${e.message.slice(0, 200)}`);
  }
})));
console.log('\nsummary (ms):');
for (const [k, v] of Object.entries(results)) console.log(`  ${k}: ${v.sort((a, b) => a - b).join(', ')}`);
console.log(`crop: ${JSON.stringify(crop)}`);
