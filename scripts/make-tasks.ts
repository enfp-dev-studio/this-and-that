// Make the inputs for the production-style correction tasks from our own
// illustrations (samples/illust): reference pictures, and pictures with the
// kind of flaw generators leave (an off-pattern cuff, a six-finger hand).
//
//   node --env-file=.env scripts/make-tasks.ts [name …]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { editImage, generateImage } from '../server/meta.ts';
import { museParams } from '../server/pipeline.ts';

const root = join(import.meta.dirname, '..');
const out = join(root, 'samples', 'tasks');
mkdirSync(out, { recursive: true });
const illust = (n: string) => readFileSync(join(root, 'samples', 'illust', `${n}.jpg`));

const flaw = async (base: string, prompt: string) => {
  const img = illust(base);
  const { width, height } = await sharp(img).metadata();
  return editImage(prompt, [img], `${width}x${height}`, undefined, museParams('notools'));
};

const JOBS: Record<string, () => Promise<Buffer>> = {
  'ref-rose-brooch': () => generateImage('Jewelry design illustration of an ornate gold brooch shaped like an open rose, a round cabochon ruby at its center, fine engraved petals and small seed pearls around the rim, centered on dark velvet, soft studio light, highly detailed, no text', '1024x1024'),
  'ref-crescent-pin': () => generateImage('Product illustration of an ornate silver hairpin shaped like a thin crescent moon, with three tiny sapphires along the curve and fine engraved filigree, a small pearl drop hanging from the tip, centered on dark navy velvet, soft studio light, highly detailed jewelry design sheet, no text', '1024x1024'),
  'gothic-cuff': () => flaw('gothic', 'Change only the lace on the sleeve cuff at the lower right (the hand holding the parasol handle) into a plain white zigzag trim with no rose pattern, so it no longer matches the other cuff. Keep everything else exactly the same.'),
  'keyvisual-hand': () => flaw('keyvisual', 'Change only her hand holding the phone so it has six fingers, a typical drawing mistake. Keep everything else exactly the same.'),
};

const names = process.argv.slice(2);
await Promise.all((names.length ? names : Object.keys(JOBS)).map(async (name) => {
  const file = join(out, `${name}.jpg`);
  if (existsSync(file) && !names.length) return console.log(`${file} exists`);
  const t0 = performance.now();
  const png = await JOBS[name]();
  await sharp(png).jpeg({ quality: 92 }).toFile(file);
  console.log(`${file} ${Math.round(performance.now() - t0)} ms`);
}));
