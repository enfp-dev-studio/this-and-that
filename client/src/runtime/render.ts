// Drawing the user's marks in the browser: the "drawing while speaking" video
// for Spark (WebCodecs H.264 + Opus/AAC, muxed to MP4), the guide image for
// Muse Image, and pasting the edit back only where marked. Canvas and
// OffscreenCanvas do what sharp and ffmpeg did on the server.

import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { Mask } from './meta';

export type Point = { x: number; y: number; t: number }; // image pixels, ms since recording start
// `pen`: the user's forced intent from the toolbar (Point or Shape); none = auto.
export type Stroke = { mark: number; points: Point[]; pen?: 'point' | 'shape' };

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

// ---------- canvases ----------

export type Canvas = OffscreenCanvas | HTMLCanvasElement;
export type Source = CanvasImageSource & { width: number; height: number };
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

// A DOM canvas on the page (it can encode synchronously, see `dataUrlOf`),
// an OffscreenCanvas in a worker.
export function canvas(w: number, h: number): Canvas {
  if (typeof document === 'undefined') return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}
export const ctx2d = (c: Canvas) => c.getContext('2d', { willReadFrequently: true }) as Ctx;

// `src` drawn at w×h (stretched, like sharp's fit: fill).
export function drawn(src: Source, w = src.width, h = src.height, smoothing: ImageSmoothingQuality = 'high') {
  const c = canvas(w, h);
  const g = ctx2d(c);
  g.imageSmoothingQuality = smoothing;
  g.drawImage(src, 0, 0, w, h);
  return c;
}

export const pixels = (src: Source, w = src.width, h = src.height) => ctx2d(drawn(src, w, h)).getImageData(0, 0, w, h);

export function fromPixels(img: ImageData) {
  const c = canvas(img.width, img.height);
  ctx2d(c).putImageData(img, 0, 0);
  return c;
}

// toBlob and convertToBlob encode in idle time, which Chrome can hold back
// for a second whatever the size (measured: 1.0 s for 768 px and 2048 px
// alike); toDataURL encodes at once (~30 ms for 1920×1280 JPEG).
const isCanvas = (s: Source): s is Canvas => (typeof OffscreenCanvas !== 'undefined' && s instanceof OffscreenCanvas) || (typeof HTMLCanvasElement !== 'undefined' && s instanceof HTMLCanvasElement);
export function dataUrlOf(src: Source, type: string, quality?: number): string {
  const c = isCanvas(src) && 'toDataURL' in src ? src : (drawn(src) as HTMLCanvasElement);
  return (c as HTMLCanvasElement).toDataURL(type, quality);
}

export async function encode(src: Source, type: string, quality?: number): Promise<Blob> {
  if (typeof document === 'undefined') return (isCanvas(src) ? (src as OffscreenCanvas) : (drawn(src) as OffscreenCanvas)).convertToBlob({ type, quality });
  const url = dataUrlOf(src, type, quality);
  const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (ch) => ch.charCodeAt(0));
  return new Blob([bytes], { type });
}

export const jpeg = (src: Source, quality = 0.92) => encode(src, 'image/jpeg', quality);
export const jpegUrl = (src: Source, quality = 0.92) => dataUrlOf(src, 'image/jpeg', quality);

// ---------- marks ----------

// The strokes as drawn up to time `until` (all of them if omitted), on a w×h
// canvas, coordinates multiplied by `scale`. Each mark gets its colour, and a
// numbered badge at its first point. Same look as the server's SVG.
export function drawStrokes(g: Ctx, strokes: Stroke[], w: number, h: number, scale = 1, until = Infinity, cursor = false) {
  const unit = Math.max(w, h) / 160;
  let tip: Point | undefined;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const s of strokes) {
    const pts = s.points.filter((p) => p.t <= until);
    if (!pts.length) continue;
    const c = colorOf(s.mark);
    const path = () => {
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(p.x * scale, p.y * scale) : g.moveTo(p.x * scale, p.y * scale)));
      if (pts.length === 1) g.lineTo(pts[0].x * scale + 0.1, pts[0].y * scale);
    };
    path();
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.lineWidth = unit * 1.6;
    g.stroke();
    path();
    g.strokeStyle = c;
    g.lineWidth = unit;
    g.stroke();
    const p0 = pts[0];
    const r = unit * 2.6;
    const bx = Math.min(Math.max(p0.x * scale, r), w - r);
    const by = Math.min(Math.max(p0.y * scale - r * 1.3, r), h - r);
    g.beginPath();
    g.arc(bx, by, r, 0, Math.PI * 2);
    g.fillStyle = c;
    g.fill();
    g.strokeStyle = 'white';
    g.lineWidth = unit * 0.5;
    g.stroke();
    g.fillStyle = 'white';
    g.font = `bold ${r * 1.15}px Helvetica, Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillText(String(s.mark), bx, by + r * 0.38);
    if (pts.length < s.points.length) tip = pts.at(-1);
  }
  if (cursor && tip) {
    g.beginPath();
    g.arc(tip.x * scale, tip.y * scale, unit * 1.4, 0, Math.PI * 2);
    g.fillStyle = 'white';
    g.fill();
    g.strokeStyle = 'black';
    g.lineWidth = unit * 0.3;
    g.stroke();
  }
  g.restore();
}

// A sketch mark alone, black on white at the picture's size and place: the
// new outline Muse Image is asked to follow.
export function outlineImage(width: number, height: number, s: Stroke) {
  const c = canvas(width, height);
  const g = ctx2d(c);
  g.fillStyle = 'white';
  g.fillRect(0, 0, width, height);
  g.beginPath();
  s.points.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.strokeStyle = 'black';
  g.lineWidth = Math.max(width, height) / 220;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.stroke();
  return c;
}

// Full-size image with all marks drawn on it, for Muse Image.
export function guideImage(image: Source, strokes: Stroke[]) {
  const c = drawn(image);
  drawStrokes(ctx2d(c), strokes, c.width, c.height);
  return c;
}

// ---------- audio ----------

// 16 kHz mono PCM → WAV, for batch transcription.
export function toWav(pcm: Int16Array) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

// Peak level in dB (0 = full scale): speech peaks near -3 dB, a quiet room near -50.
export function maxVolumeDb(pcm: Int16Array) {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  return peak ? 20 * Math.log10(peak / 32768) : -Infinity;
}

export const audioDurationMs = (pcm: Int16Array | null) => (pcm ? Math.round(pcm.length / 16) : 0);

// ---------- the video Spark watches ----------

// What this browser can encode, found once: H.264 for the picture, Opus (or
// AAC) for the voice. Spark accepts either in an MP4 and hears both.
let codecs: Promise<{ video: VideoEncoderConfig | null; audio: (AudioEncoderConfig & { mux: 'opus' | 'aac' }) | null }> | null = null;
function findCodecs(w: number, h: number) {
  codecs ??= (async () => {
    if (typeof VideoEncoder === 'undefined') return { video: null, audio: null };
    let video: VideoEncoderConfig | null = null;
    for (const codec of ['avc1.42001f', 'avc1.4d001f', 'avc1.640028', 'avc1.42002a']) {
      const cfg: VideoEncoderConfig = { codec, width: w, height: h, bitrate: 1_200_000, framerate: 8, avc: { format: 'avc' } };
      if ((await VideoEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }))).supported) {
        video = { codec, width: 0, height: 0, bitrate: 1_200_000, framerate: 8, avc: { format: 'avc' } };
        break;
      }
    }
    let audio: (AudioEncoderConfig & { mux: 'opus' | 'aac' }) | null = null;
    if (typeof AudioEncoder !== 'undefined') {
      for (const cfg of [
        { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 48000, mux: 'opus' as const },
        { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1, bitrate: 96000, mux: 'aac' as const },
        { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 1, bitrate: 96000, mux: 'aac' as const },
      ]) {
        const { mux, ...c } = cfg;
        if ((await AudioEncoder.isConfigSupported(c).catch(() => ({ supported: false }))).supported) {
          audio = cfg;
          break;
        }
      }
    }
    return { video, audio };
  })();
  return codecs;
}

export async function canEncodeVideo() {
  return !!(await findCodecs(768, 512)).video;
}

// The first encode of a page pays for probing the codecs and starting the
// hardware encoder (~2 s measured); do that once while the page is idle.
export async function warmUpVideo() {
  try {
    if (!(await canEncodeVideo())) return;
    const c = canvas(64, 64);
    ctx2d(c).fillRect(0, 0, 64, 64);
    await renderVideo(c, [], new Int16Array(1600), { durationMs: 100 });
  } catch {}
}

// 16 kHz PCM → Float32 at `rate` (linear).
function resample(pcm: Int16Array, rate: number) {
  const n = Math.floor((pcm.length * rate) / 16000);
  const out = new Float32Array(n);
  const k = 16000 / rate;
  for (let i = 0; i < n; i++) {
    const x = i * k, i0 = Math.floor(x), f = x - i0;
    out[i] = ((pcm[i0] ?? 0) * (1 - f) + (pcm[Math.min(pcm.length - 1, i0 + 1)] ?? 0) * f) / 32768;
  }
  return out;
}

// Replay the drawing over the image, frame by frame, with the voice on top.
// Returns an MP4 Blob. maxSide keeps the clip small for upload.
export async function renderVideo(image: Source, strokes: Stroke[], pcm: Int16Array | null, opts: { fps?: number; maxSide?: number; durationMs?: number } = {}) {
  const fps = opts.fps ?? 8;
  const scale = Math.min(1, (opts.maxSide ?? 768) / Math.max(image.width, image.height));
  const w = Math.round((image.width * scale) / 2) * 2;
  const h = Math.round((image.height * scale) / 2) * 2;
  const { video, audio } = await findCodecs(w, h);
  if (!video) throw new Error('this browser cannot encode video');
  const base = drawn(image, w, h);
  const frameCanvas = canvas(w, h);
  const g = ctx2d(frameCanvas);
  const lastT = Math.max(0, ...strokes.flatMap((s) => s.points.map((p) => p.t)));
  const durationMs = Math.max(opts.durationMs ?? 0, lastT) + 600;
  const frames = Math.ceil((durationMs / 1000) * fps);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: w, height: h, frameRate: fps },
    ...(audio && pcm?.length ? { audio: { codec: audio.mux, numberOfChannels: 1, sampleRate: audio.sampleRate } } : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let failure: Error | null = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (failure = e) });
  venc.configure({ ...video, width: w, height: h, framerate: fps });
  for (let f = 0; f < frames; f++) {
    const t = (f * 1000) / fps;
    g.drawImage(base, 0, 0);
    drawStrokes(g, strokes, w, h, scale, t, true);
    const frame = new VideoFrame(frameCanvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: f % (fps * 2) === 0 });
    frame.close();
    if (venc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
  }
  const videoDone = venc.flush();

  let audioDone: Promise<void> = Promise.resolve();
  if (audio && pcm?.length) {
    const { mux, ...cfg } = audio;
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => (failure = e) });
    aenc.configure(cfg);
    // Only as long as the video, like ffmpeg's -t.
    const samples = resample(pcm, cfg.sampleRate).subarray(0, Math.round((frames / fps) * cfg.sampleRate));
    const block = Math.round(cfg.sampleRate / 10);
    for (let off = 0; off < samples.length; off += block) {
      const data = samples.slice(off, off + block);
      const ad = new AudioData({ format: 'f32', sampleRate: cfg.sampleRate, numberOfFrames: data.length, numberOfChannels: 1, timestamp: Math.round((off * 1e6) / cfg.sampleRate), data });
      aenc.encode(ad);
      ad.close();
    }
    audioDone = aenc.flush().then(() => aenc.close());
  }
  await Promise.all([videoDone, audioDone]);
  venc.close();
  if (failure) throw failure;
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

// ---------- key frames: the fallback when the browser can't encode video ----------

// One frame at the end of each mark (the picture with the marks drawn so
// far), at most `max`: what Spark sees when it can't watch a video.
export function keyFrames(image: Source, strokes: Stroke[], maxSide = 768, max = 6) {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const w = Math.round(image.width * scale), h = Math.round(image.height * scale);
  const base = drawn(image, w, h);
  const ends = strokes.map((s) => s.points.at(-1)!.t).sort((a, b) => a - b).slice(-max);
  return ends.map((t) => {
    const c = canvas(w, h);
    const g = ctx2d(c);
    g.drawImage(base, 0, 0);
    drawStrokes(g, strokes, w, h, scale, t, false);
    return { t, canvas: c };
  });
}

// ---------- paste back ----------

// Union of masks at the image's size, grown by `grow` px and feathered by
// `feather` px, as an 8-bit alpha buffer (0 = keep original, 255 = take edit).
export function pasteAlpha(masks: Mask[], width: number, height: number, grow: number, feather: number) {
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
  const alpha = upscaleGray(a, w, h, width, height);
  for (let i = 0; i < alpha.length; i++) if (alpha[i] < 3) alpha[i] = 0; // resampling noise
  return alpha;
}

// A small one-channel buffer (0..1 floats or 0..255 bytes) scaled to w2×h2
// through a canvas (grey RGBA), back as bytes.
export function upscaleGray(v: Float32Array | Uint8Array, w: number, h: number, w2: number, h2: number, quality: ImageSmoothingQuality = 'high') {
  const small = new ImageData(w, h);
  const k = v instanceof Float32Array ? 255 : 1;
  for (let i = 0; i < w * h; i++) {
    const g = Math.round(v[i] * k);
    small.data[i * 4] = small.data[i * 4 + 1] = small.data[i * 4 + 2] = g;
    small.data[i * 4 + 3] = 255;
  }
  const big = ctx2d(drawn(fromPixels(small), w2, h2, quality)).getImageData(0, 0, w2, h2);
  const out = new Uint8Array(w2 * h2);
  for (let i = 0; i < out.length; i++) out[i] = big.data[i * 4];
  return out;
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
export function pasteBack(original: ImageData, edited: Source, alpha: Uint8Array) {
  const { width, height } = original;
  const o = original.data;
  const e = pixels(edited, width, height).data;
  const out = new ImageData(new Uint8ClampedArray(o), width, height);
  const d = out.data;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i];
    if (!a) continue;
    for (let c = 0; c < 3; c++) d[i * 4 + c] = Math.round((e[i * 4 + c] * a + o[i * 4 + c] * (255 - a)) / 255);
  }
  return out;
}

// ---------- references ----------

// The video Spark watches when marks are also drawn on references: each
// reference (scaled to the picture's height) on the left, the picture on the
// right, with every stroke moved to where its image now sits.
export function composeWithRefs(image: Source, strokes: Stroke[], refMarks: { ref: { id: string; bitmap: Source }; stroke: Stroke }[]) {
  const H = image.height, W = image.width;
  const refs = [...new Map(refMarks.map((m) => [m.ref.id, m.ref])).values()];
  const offset = new Map<string, { x: number; k: number }>();
  let x = 0;
  const placed: { src: Source; left: number; w: number }[] = [];
  for (const ref of refs) {
    const k = H / ref.bitmap.height;
    const w = Math.round(ref.bitmap.width * k);
    placed.push({ src: ref.bitmap, left: x, w });
    offset.set(ref.id, { x, k });
    x += w;
  }
  const composite = canvas(x + W, H);
  const g = ctx2d(composite);
  g.fillStyle = '#000000';
  g.fillRect(0, 0, x + W, H);
  g.imageSmoothingQuality = 'high';
  for (const p of placed) g.drawImage(p.src, p.left, 0, p.w, H);
  g.drawImage(image, x, 0);
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
export function cropAround(src: Source, s: Stroke) {
  const { width, height } = src;
  const b = strokeBox(s);
  const side = Math.max(192, (b.right - b.left) * 1.4, (b.bottom - b.top) * 1.4);
  const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
  const left = Math.max(0, Math.round(cx - side / 2)), top = Math.max(0, Math.round(cy - side / 2));
  const w = Math.min(width - left, Math.round(side)), h = Math.min(height - top, Math.round(side));
  const c = canvas(w, h);
  ctx2d(c).drawImage(src, left, top, w, h, 0, 0, w, h);
  return c;
}
