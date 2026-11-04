// Drawing the user's marks: the "drawing while speaking" video for Spark, the
// guide image for Muse Image, and pasting the edit back only where marked.

import { spawn } from 'node:child_process';
import sharp from 'sharp';
import type { Mask } from './meta.ts';

export type Point = { x: number; y: number; t: number }; // image pixels, ms since recording start
export type Stroke = { mark: number; points: Point[] };

// Six, like the client's --mark-1..6; the models are told the colour names.
export const COLORS = ['#ff3b30', '#0a84ff', '#34c759', '#ff9f0a', '#bf5af2', '#ff2d95'];
export const colorOf = (mark: number) => COLORS[(mark - 1) % COLORS.length];
export const COLOR_NAMES = ['red', 'blue', 'green', 'orange', 'purple', 'pink'];
export const colorNameOf = (mark: number) => COLOR_NAMES[(mark - 1) % COLOR_NAMES.length];

export function strokeBox(s: Stroke) {
  const xs = s.points.map((p) => p.x);
  const ys = s.points.map((p) => p.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

// SVG of the strokes as drawn up to time `until` (all of them if omitted), in
// a w×h canvas, coordinates multiplied by `scale`. Each mark gets its colour,
// and a numbered badge at its first point.
export function strokesSvg(strokes: Stroke[], w: number, h: number, scale = 1, until = Infinity, cursor = false) {
  const unit = Math.max(w, h) / 160;
  const parts: string[] = [];
  let tip: Point | undefined;
  for (const s of strokes) {
    const pts = s.points.filter((p) => p.t <= until);
    if (!pts.length) continue;
    const c = colorOf(s.mark);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(p.x * scale).toFixed(1)} ${(p.y * scale).toFixed(1)}`).join('');
    parts.push(`<path d="${d}" fill="none" stroke="white" stroke-opacity="0.8" stroke-width="${unit * 1.6}" stroke-linecap="round" stroke-linejoin="round"/>`);
    parts.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="${unit}" stroke-linecap="round" stroke-linejoin="round"/>`);
    const p0 = pts[0];
    const r = unit * 2.6;
    const bx = Math.min(Math.max(p0.x * scale, r), w - r);
    const by = Math.min(Math.max(p0.y * scale - r * 1.3, r), h - r);
    parts.push(`<circle cx="${bx}" cy="${by}" r="${r}" fill="${c}" stroke="white" stroke-width="${unit * 0.5}"/>`);
    parts.push(`<text x="${bx}" y="${by + r * 0.38}" font-size="${r * 1.15}" font-family="Helvetica, Arial, sans-serif" font-weight="bold" fill="white" text-anchor="middle">${s.mark}</text>`);
    if (pts.length < s.points.length) tip = pts.at(-1);
  }
  if (cursor && tip) parts.push(`<circle cx="${tip.x * scale}" cy="${tip.y * scale}" r="${unit * 1.4}" fill="white" stroke="black" stroke-width="${unit * 0.3}"/>`);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join('')}</svg>`);
}

// Full-size image with all marks drawn on it, for Muse Image.
export async function guideImage(image: Buffer, strokes: Stroke[]) {
  const { width, height } = await sharp(image).metadata();
  return sharp(image).composite([{ input: strokesSvg(strokes, width!, height!) }]).png().toBuffer();
}

function run(cmd: string, args: string[], stdin?: (w: NodeJS.WritableStream) => Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr!.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-600)}`))));
    if (stdin) stdin(p.stdin!).then(() => p.stdin!.end(), reject);
  });
}

// Replay the drawing over the image, frame by frame, with the voice on top.
// Returns the mp4 path. maxSide keeps the clip small for upload.
export async function renderVideo(image: Buffer, strokes: Stroke[], audioPath: string | null, outPath: string, opts: { fps?: number; maxSide?: number; durationMs?: number } = {}) {
  const fps = opts.fps ?? 8;
  const meta = await sharp(image).metadata();
  const scale = Math.min(1, (opts.maxSide ?? 768) / Math.max(meta.width!, meta.height!));
  const w = Math.round((meta.width! * scale) / 2) * 2;
  const h = Math.round((meta.height! * scale) / 2) * 2;
  const base = await sharp(image).resize(w, h).removeAlpha().raw().toBuffer();
  const lastT = Math.max(0, ...strokes.flatMap((s) => s.points.map((p) => p.t)));
  const durationMs = Math.max(opts.durationMs ?? 0, lastT) + 600;
  const frames = Math.ceil((durationMs / 1000) * fps);

  const args = ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0'];
  if (audioPath) args.push('-i', audioPath);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast');
  if (audioPath) args.push('-c:a', 'aac', '-b:a', '96k', '-map', '0:v', '-map', '1:a');
  args.push('-t', (frames / fps).toFixed(2), '-movflags', '+faststart', outPath);

  await run('ffmpeg', args, async (stdin) => {
    for (let f = 0; f < frames; f++) {
      const t = (f * 1000) / fps;
      const frame = await sharp(base, { raw: { width: w, height: h, channels: 3 } })
        .composite([{ input: strokesSvg(strokes, w, h, scale, t, true) }])
        .removeAlpha().raw().toBuffer();
      if (!stdin.write(frame)) await new Promise((r) => stdin.once('drain', r));
    }
  });
  return outPath;
}

// Any audio (webm/opus from the browser, aiff, …) → 16 kHz mono WAV for transcription.
export async function toWav(inPath: string, outPath: string) {
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', inPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outPath]);
  return outPath;
}

export async function audioDurationMs(path: string) {
  return new Promise<number>((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => resolve(Math.round(parseFloat(out) * 1000) || 0));
  });
}

// Union of masks at the image's size, grown by `grow` px and feathered by
// `feather` px, as an 8-bit alpha buffer (0 = keep original, 255 = take edit).
export async function pasteAlpha(masks: Mask[], width: number, height: number, grow: number, feather: number) {
  const { width: w, height: h } = masks[0];
  const scale = width / w;
  let a = new Float32Array(w * h);
  for (const m of masks) for (let i = 0; i < m.data.length; i++) if (m.data[i]) a[i] = 1;
  // Dilate: anything within `grow` of the mask (two box passes round the corners).
  const r = Math.max(1, Math.round(grow / scale / 2));
  a = boxBlur(boxBlur(a, w, h, r), w, h, r).map((v) => (v > 0.001 ? 1 : 0));
  // Feather: three box passes ≈ a gaussian, kept inside the grown area's halo.
  const f = Math.max(1, Math.round(feather / scale / 3));
  for (let i = 0; i < 3; i++) a = boxBlur(a, w, h, f);
  const small = Buffer.from(a.map((v) => Math.round(v * 255)));
  // sharp treats 1-channel raw as colour; take the first channel back out.
  const alpha = await sharp(small, { raw: { width: w, height: h, channels: 1 } }).resize(width, height).extractChannel(0).raw().toBuffer();
  for (let i = 0; i < alpha.length; i++) if (alpha[i] < 3) alpha[i] = 0; // resampling noise
  return alpha;
}

// Separable box blur with radius r (window 2r+1), edges clamped.
function boxBlur(src: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / n;
      sum += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// Blend: original everywhere, edited where alpha says. Outside the alpha the
// output is the original byte for byte.
export async function pasteBack(original: Buffer, edited: Buffer, alpha: Buffer) {
  const { width, height } = await sharp(original).metadata();
  const o = await sharp(original).removeAlpha().raw().toBuffer();
  const e = await sharp(edited).resize(width!, height!, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const out = Buffer.from(o);
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i];
    if (!a) continue;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round((e[i * 3 + c] * a + o[i * 3 + c] * (255 - a)) / 255);
  }
  return sharp(out, { raw: { width: width!, height: height!, channels: 3 } }).png().toBuffer();
}

// The video Spark watches when marks are also drawn on references: each
// reference (scaled to the picture's height) on the left, the picture on the
// right, with every stroke moved to where its image now sits.
export async function composeWithRefs(image: Buffer, strokes: Stroke[], refMarks: { ref: { id: string; png: Buffer }; stroke: Stroke }[]) {
  const { height: H, width: W } = await sharp(image).metadata();
  const refs = [...new Map(refMarks.map((m) => [m.ref.id, m.ref])).values()];
  const placed: { input: Buffer; left: number; top: number }[] = [];
  const offset = new Map<string, { x: number; k: number }>();
  let x = 0;
  for (const ref of refs) {
    const m = await sharp(ref.png).metadata();
    const k = H! / m.height!;
    const w = Math.round(m.width! * k);
    placed.push({ input: await sharp(ref.png).resize(w, H!).png().toBuffer(), left: x, top: 0 });
    offset.set(ref.id, { x, k });
    x += w;
  }
  placed.push({ input: image, left: x, top: 0 });
  const composite = await sharp({ create: { width: x + W!, height: H!, channels: 3, background: '#000000' } }).composite(placed).png().toBuffer();
  const moved: Stroke[] = [
    ...refMarks.map(({ ref, stroke }) => {
      const o = offset.get(ref.id)!;
      return { mark: stroke.mark, points: stroke.points.map((p) => ({ x: o.x + p.x * o.k, y: p.y * o.k, t: p.t })) };
    }),
    ...strokes.map((s) => ({ mark: s.mark, points: s.points.map((p) => ({ x: x + p.x, y: p.y, t: p.t })) })),
  ].sort((a, b) => a.mark - b.mark);
  const letter = (id: string) => String.fromCharCode(65 + refs.findIndex((r) => r.id === id));
  const places = new Map<number, string>([
    ...refMarks.map(({ ref, stroke }) => [stroke.mark, `reference ${letter(ref.id)} (left part of the video)`] as [number, string]),
    ...strokes.map((s) => [s.mark, 'the picture to edit (right part of the video)'] as [number, string]),
  ]);
  return { composite, strokes: moved, places };
}

// The area around a mark on a reference, for Muse Image to copy from.
export async function cropAround(png: Buffer, s: Stroke) {
  const { width, height } = await sharp(png).metadata();
  const b = strokeBox(s);
  const side = Math.max(192, (b.right - b.left) * 1.4, (b.bottom - b.top) * 1.4);
  const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
  const left = Math.max(0, Math.round(cx - side / 2)), top = Math.max(0, Math.round(cy - side / 2));
  const w = Math.min(width! - left, Math.round(side)), h = Math.min(height! - top, Math.round(side));
  return sharp(png).extract({ left, top, width: w, height: h }).jpeg({ quality: 92 }).toBuffer();
}
