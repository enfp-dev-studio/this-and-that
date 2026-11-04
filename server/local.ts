// Instant edits: recolor, brighten/darken and enlarge run locally inside the
// SAM mask in well under a second, so they don't wait ~13 s for Muse Image.
// Moving or shrinking leaves a hole that a local fill can't make look right
// (tried: a blocky smear), so those still go to Muse Image.

import sharp from 'sharp';
import type { Mask } from './meta.ts';
import type { Edit } from './pipeline.ts';

export const LOCAL_OPS = new Set(['recolor', 'tone', 'scale']);

type Rgb = { data: Buffer; width: number; height: number };

// SAM's small 0/1 mask → soft 8-bit alpha at the image's size (the bilinear
// upscale gives a ~2 px anti-aliased edge).
async function alphaOf(mask: Mask, width: number, height: number) {
  const small = Buffer.from(mask.data.map((v) => (v ? 255 : 0)));
  return sharp(small, { raw: { width: mask.width, height: mask.height, channels: 1 } })
    .resize(width, height, { kernel: 'linear' }).extractChannel(0).raw().toBuffer();
}

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) || 0);
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

// New colour, same shading: each pixel's brightness relative to the object's
// average scales the target colour; highlights blend toward white.
function recolor(img: Rgb, alpha: Buffer, color: string) {
  const t = hex(color);
  let sum = 0, n = 0, max = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] < 128) continue;
    const y = luma(img.data[i * 3], img.data[i * 3 + 1], img.data[i * 3 + 2]);
    sum += y; n++;
    if (y > max) max = y;
  }
  if (!n) return;
  const mean = Math.max(1, sum / n);
  const top = Math.max(1.01, max / mean);
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i] / 255;
    if (!a) continue;
    const o = i * 3;
    const k = luma(img.data[o], img.data[o + 1], img.data[o + 2]) / mean;
    for (let c = 0; c < 3; c++) {
      const v = k <= 1 ? t[c] * k : t[c] + (255 - t[c]) * ((k - 1) / (top - 1)) * 0.85;
      img.data[o + c] = Math.round(img.data[o + c] * (1 - a) + Math.min(255, v) * a);
    }
  }
}

function tone(img: Rgb, alpha: Buffer, factor: number) {
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i] / 255;
    if (!a) continue;
    for (let c = 0; c < 3; c++) {
      const o = i * 3 + c;
      img.data[o] = Math.round(img.data[o] * (1 - a) + Math.min(255, img.data[o] * factor) * a);
    }
  }
}

// Fill a hole from its surroundings (push-pull over an image pyramid): smooth,
// not textured, so it only suits plain backgrounds.
function fillHole(img: Rgb, hole: Uint8Array) {
  type Level = { w: number; h: number; c: Float32Array; wt: Float32Array };
  const { width, height } = img;
  const base: Level = { w: width, h: height, c: new Float32Array(width * height * 3), wt: new Float32Array(width * height) };
  for (let i = 0; i < width * height; i++) {
    const known = hole[i] ? 0 : 1;
    base.wt[i] = known;
    for (let c = 0; c < 3; c++) base.c[i * 3 + c] = img.data[i * 3 + c] * known;
  }
  const levels = [base];
  while (levels.at(-1)!.w > 1 || levels.at(-1)!.h > 1) {
    const p = levels.at(-1)!;
    const w = Math.ceil(p.w / 2), h = Math.ceil(p.h / 2);
    const l: Level = { w, h, c: new Float32Array(w * h * 3), wt: new Float32Array(w * h) };
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
      const s = y * p.w + x, d = (y >> 1) * w + (x >> 1);
      l.wt[d] += p.wt[s];
      for (let c = 0; c < 3; c++) l.c[d * 3 + c] += p.c[s * 3 + c];
    }
    levels.push(l);
  }
  // Pull: normalise each level, then fill unknown pixels from the coarser one.
  for (let li = levels.length - 1; li >= 0; li--) {
    const l = levels[li], up = levels[li + 1];
    for (let y = 0; y < l.h; y++) for (let x = 0; x < l.w; x++) {
      const i = y * l.w + x;
      const w = Math.min(1, l.wt[i]);
      for (let c = 0; c < 3; c++) {
        const own = l.wt[i] > 0 ? l.c[i * 3 + c] / l.wt[i] : 0;
        const coarse = up ? up.c[((y >> 1) * up.w + (x >> 1)) * 3 + c] : own;
        l.c[i * 3 + c] = own * w + coarse * (1 - w);
      }
      l.wt[i] = 1;
    }
  }
  for (let i = 0; i < width * height; i++) if (hole[i]) for (let c = 0; c < 3; c++) img.data[i * 3 + c] = Math.round(base.c[i * 3 + c]);
}

// Enlarge the object by `s` about its centre (filling under it first, in case
// the bigger copy leaves a sliver uncovered).
function enlarge(img: Rgb, alpha: Buffer, s: number) {
  const { width, height } = img;
  const src = Buffer.from(img.data);
  let cx = 0, cy = 0, n = 0, x0 = width, y0 = height, x1 = 0, y1 = 0;
  const hole = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = alpha[y * width + x];
    if (!a) continue;
    hole[y * width + x] = 1;
    if (a >= 128) { cx += x; cy += y; n++; }
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (!n) return;
  cx /= n; cy /= n;
  // Grow the hole a little so the object's fringe goes too.
  const r = Math.round(Math.max(width, height) * 0.006);
  const grown = new Uint8Array(hole);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!hole[y * width + x]) continue;
    for (let yy = Math.max(0, y - r); yy <= Math.min(height - 1, y + r); yy += r) for (let xx = Math.max(0, x - r); xx <= Math.min(width - 1, x + r); xx += r) grown[yy * width + xx] = 1;
  }
  fillHole(img, grown);
  // Paste: for each destination pixel, sample the source object.
  const nx0 = Math.max(0, Math.floor(cx + (x0 - cx) * s)), nx1 = Math.min(width - 1, Math.ceil(cx + (x1 - cx) * s));
  const ny0 = Math.max(0, Math.floor(cy + (y0 - cy) * s)), ny1 = Math.min(height - 1, Math.ceil(cy + (y1 - cy) * s));
  for (let y = ny0; y <= ny1; y++) for (let x = nx0; x <= nx1; x++) {
    const sx = Math.round(cx + (x - cx) / s), sy = Math.round(cy + (y - cy) / s);
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
    const a = alpha[sy * width + sx] / 255;
    if (!a) continue;
    for (let c = 0; c < 3; c++) {
      const o = (y * width + x) * 3 + c;
      img.data[o] = Math.round(img.data[o] * (1 - a) + src[(sy * width + sx) * 3 + c] * a);
    }
  }
}

// Apply the edits that can run locally. Returns the new image (PNG) and the
// marks it handled; everything else still needs Muse Image.
export async function applyLocal(image: Buffer, edits: Edit[], masks: Map<number, Mask>) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const img: Rgb = { data, width: info.width, height: info.height };
  const done = new Set<number>();
  for (const e of edits) {
    if (e.kind === 'pointer' || !e.op || !LOCAL_OPS.has(e.op)) continue;
    const mask = masks.get(e.mark);
    if (!mask) continue;
    const alpha = await alphaOf(mask, img.width, img.height);
    if (e.op === 'recolor' && /^#[0-9a-f]{6}$/i.test(e.color ?? '')) recolor(img, alpha, e.color!);
    else if (e.op === 'tone' && e.amount && e.amount > 0) tone(img, alpha, e.amount);
    else if (e.op === 'scale' && e.amount && e.amount >= 1) enlarge(img, alpha, e.amount);
    else continue;
    done.add(e.mark);
  }
  const out = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } }).png().toBuffer();
  return { out, done };
}
