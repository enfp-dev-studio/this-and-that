// M0 risk spike, step 3: SAM masks from the marks, Muse Image edit with the
// guide image, paste back only the masked regions.
//
//   node --env-file=.env m0/spike-edit.ts [a b c]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { guideImage, museEdit, pasteMarked, segmentMarks, type Edit } from '../server/pipeline.ts';
import { colorOf } from '../server/render.ts';

const out = join(import.meta.dirname, '..', 'out', 'm0');
const clips = process.argv.slice(2).length ? process.argv.slice(2) : ['a', 'b', 'c'];
const understood = JSON.parse(readFileSync(join(out, 'understand-fast.json'), 'utf8'));
const image = readFileSync(join(out, 'image.png'));

await Promise.all(clips.map(async (name) => {
  const clip = JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8'));
  const edits: Edit[] = understood.find((c: any) => c.clip === name).runs.find((r: any) => r.label === 'spark-1.3 minimal').r.edits;
  const guide = await guideImage(image, clip.strokes);

  let t = performance.now();
  const [seg, edited] = await Promise.all([
    segmentMarks(image, clip.strokes).then((s) => { console.log(`${name}: sam ${Math.round(performance.now() - t)} ms, masks for marks ${[...s.masks.keys()]}`); return s; }),
    (existsSync(join(out, `${name}-edit-raw.png`)) && !process.env.FRESH ? Promise.resolve(readFileSync(join(out, `${name}-edit-raw.png`))) : museEdit(image, guide, edits)).then((e) => { console.log(`${name}: edit ${Math.round(performance.now() - t)} ms`); return e; }),
  ]);
  writeFileSync(join(out, `${name}-edit-raw.png`), edited);

  // SAM masks over the image, each in its mark's colour.
  const overlay = Buffer.alloc(seg.width * seg.height * 4);
  for (const [mark, m] of seg.masks) {
    const hex = colorOf(mark);
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    for (let i = 0; i < m.data.length; i++) if (m.data[i]) overlay.set([...rgb, 150], i * 4);
  }
  await sharp(image).resize(seg.width, seg.height)
    .composite([{ input: await sharp(overlay, { raw: { width: seg.width, height: seg.height, channels: 4 } }).png().toBuffer() }])
    .toFile(join(out, `${name}-sam.png`));

  t = performance.now();
  const { out: final, alpha } = await pasteMarked(image, edited, clip.strokes, seg, edits);
  writeFileSync(join(out, `${name}-final.png`), final);
  await sharp(alpha, { raw: { width: 1920, height: alpha.length / 1920, channels: 1 } }).png().toFile(join(out, `${name}-alpha.png`));

  // Outside the paste region the result must equal the original byte for byte.
  const o = await sharp(image).removeAlpha().raw().toBuffer();
  const f = await sharp(final).removeAlpha().raw().toBuffer();
  const e = await sharp(edited).resize(1920, alpha.length / 1920, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  let outside = 0, same = 0, rawDiff = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i]) continue;
    outside++;
    if (o[i * 3] === f[i * 3] && o[i * 3 + 1] === f[i * 3 + 1] && o[i * 3 + 2] === f[i * 3 + 2]) same++;
    rawDiff += Math.abs(o[i * 3] - e[i * 3]) + Math.abs(o[i * 3 + 1] - e[i * 3 + 1]) + Math.abs(o[i * 3 + 2] - e[i * 3 + 2]);
  }
  const { width: ew, height: eh } = await sharp(edited).metadata();
  console.log(`${name}: paste ${Math.round(performance.now() - t)} ms; edit size ${ew}x${eh}; region ${(100 * (1 - outside / alpha.length)).toFixed(1)}% of image; outside identical ${same}/${outside}; raw edit drift outside ${(rawDiff / outside / 3).toFixed(1)}/255 per channel`);
}));
