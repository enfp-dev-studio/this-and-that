// Assembles the demo video, out/demo/this-and-that-demo.mp4 (1920×1080, 30 fps,
// AAC sound: each take's voice, silent cards, no music), from the clips
// scripts/capture-demo.ts recorded and their <scene>.timing.json, plus text
// cards, following DEMO.md: the drawing, the outlines and the instruction
// callouts in real time with the voice, the waits sped up ×4 (with a "×4"
// label), the result in real time, subtitles with the exact spoken words, and
// a camera that eases in on the marks while they are drawn. Cards and
// subtitles are drawn with sharp (this ffmpeg has no drawtext), then
// everything is encoded and concatenated with ffmpeg.
//
//   node scripts/edit-demo.ts

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';

const root = join(import.meta.dirname, '..');
const demo = join(root, 'out', 'demo');
const work = join(demo, 'edit');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const W = 1920, H = 1080, BG = '#0a0a0a';
const FONT = "'Helvetica Neue', Helvetica, 'Apple SD Gothic Neo', sans-serif";
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ff = (args: string[]) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
const dur = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
const ENC = ['-r', '30', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'];
let seq = 0;
const parts: string[] = [];

// ---------- cards ----------

type Line = { text: string; size: number; weight?: number; color?: string; gap?: number };
async function card(lines: Line[], seconds: number, image?: { file: string; width: number }) {
  // Lines stacked in the middle (above the image, if any).
  const img = image ? await sharp(image.file).resize(image.width).toBuffer() : null;
  const imgH = img ? (await sharp(img).metadata()).height! : 0;
  const textH = lines.reduce((h, l) => h + l.size * 1.25 + (l.gap ?? 18), 0);
  let y = (H - textH - (img ? imgH + 48 : 0)) / 2;
  const texts = lines.map((l) => {
    y += l.size;
    const t = `<text x="${W / 2}" y="${y}" font-family="${FONT}" font-size="${l.size}" font-weight="${l.weight ?? 500}" fill="${l.color ?? '#fafafa'}" text-anchor="middle">${esc(l.text)}</text>`;
    y += l.size * 0.25 + (l.gap ?? 18);
    return t;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="${BG}"/>${texts.join('')}</svg>`;
  const png = join(work, `card-${seq}.png`);
  const layers: OverlayOptions[] = img ? [{ input: img, left: Math.round((W - image!.width) / 2), top: Math.round(y + 30) }] : [];
  await sharp(Buffer.from(svg)).composite(layers).png().toFile(png);
  const out = join(work, `${String(seq++).padStart(2, '0')}-card.mp4`);
  ff(['-loop', '1', '-i', png, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(seconds), '-vf', `fade=in:0:8,fade=out:st=${seconds - 0.3}:d=0.3`, '-map', '0:v', '-map', '1:a', ...ENC, out]);
  parts.push(out);
}

// A transparent full frame with one subtitle line at the bottom.
async function subtitle(text: string, file: string) {
  const size = 46, padX = 28, w = Math.min(W - 160, Math.round(text.length * size * 0.52) + padX * 2), h = 76;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${(W - w) / 2}" y="${H - 150}" width="${w}" height="${h}" rx="10" fill="#000" fill-opacity="0.72"/><text x="${W / 2}" y="${H - 150 + 52}" font-family="${FONT}" font-size="${size}" font-weight="500" fill="#fff" text-anchor="middle">${esc(text)}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

// ---------- clips ----------

type Sub = { from: number; to: number; text: string };
// Real time until `real`, ×4 until `fastUntil`, then real time; `zoom`: the
// camera's keyframes (source time, zoom, focus in the clip's 1600×1000 px).
type Key = { t: number; z: number; x: number; y: number };
type Plan = { real: number; fastUntil: number; subs: Sub[]; zoom?: Key[]; voice?: { file: string; at: number }; hold?: number };

// An ffmpeg expression easing (smoothstep) between keyframes, of time `T`.
function eased(keys: Key[], pick: (k: Key) => number, T: string) {
  let e = String(pick(keys.at(-1)!).toFixed(3));
  for (let i = keys.length - 2; i >= 0; i--) {
    const [a, b] = [keys[i], keys[i + 1]];
    const u = `((${T}-${a.t.toFixed(2)})/${Math.max(0.01, b.t - a.t).toFixed(2)})`;
    e = `if(lt(${T},${b.t.toFixed(2)}),${pick(a).toFixed(3)}+(${(pick(b) - pick(a)).toFixed(3)})*${u}*${u}*(3-2*${u}),${e})`;
  }
  return `if(lt(${T},${keys[0].t.toFixed(2)}),${pick(keys[0]).toFixed(3)},${e})`;
}

async function clip(name: string, plan: Plan) {
  const src = join(demo, `${name}.mp4`);
  if (!existsSync(src)) return console.log(`(no ${name}.mp4, skipped)`);
  const inputs = ['-i', src];
  const subFiles: string[] = [];
  for (const [i, s] of plan.subs.entries()) {
    const f = join(work, `sub-${name}-${i}.png`);
    await subtitle(s.text, f);
    subFiles.push(f);
    inputs.push('-i', f);
  }
  const x4 = join(work, 'x4.png');
  if (!existsSync(x4)) await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="64"><rect width="120" height="64" rx="10" fill="#000" fill-opacity="0.7"/><text x="60" y="44" font-family="${FONT}" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">×4</text></svg>`)).png().toFile(x4);
  inputs.push('-i', x4);
  const x4i = subFiles.length + 1;
  // 1600×1000 on a 16:9 dark canvas (1778×1000), then the camera: zoompan
  // crops around the focus at the keyframed zoom and scales to 1920×1080.
  const keys = plan.zoom ?? [{ t: 0, z: 1, x: 800, y: 500 }];
  const T = 'on/30', PADX = 89;
  const z = eased(keys, (k) => k.z, T);
  const fx = eased(keys, (k) => k.x + PADX, T), fy = eased(keys, (k) => k.y, T);
  const f: string[] = [`[0:v]fps=30,pad=1778:1000:${PADX}:0:color=0x0a0a0a,zoompan=z='${z}':x='max(0,min(iw-iw/zoom,(${fx})-iw/zoom/2))':y='max(0,min(ih-ih/zoom,(${fy})-ih/zoom/2))':d=1:s=${W}x${H}:fps=30[v0]`];
  plan.subs.forEach((s, i) => f.push(`[v${i}][${i + 1}:v]overlay=0:0:enable='between(t,${s.from.toFixed(2)},${s.to.toFixed(2)})'[v${i + 1}]`));
  const v = `[v${plan.subs.length}]`;
  const fast = plan.fastUntil - plan.real > 1.5;
  const hold = plan.hold ? `,tpad=stop_mode=clone:stop_duration=${plan.hold}` : '';
  if (fast) {
    f.push(`${v}split=3[a][b][c]`, `[a]trim=0:${plan.real},setpts=PTS-STARTPTS[s1]`, `[b]trim=${plan.real}:${plan.fastUntil},setpts=(PTS-STARTPTS)/4[fb]`, `[fb][${x4i}:v]overlay=W-w-48:${H - 120}[s2]`, `[c]trim=${plan.fastUntil},setpts=PTS-STARTPTS${hold}[s3]`, `[s1][s2][s3]concat=n=3:v=1:a=0[out]`);
  } else f.push(`${v}null${hold}[out]`);
  // The take's voice at its time in the real-time part; silence after (the waits, the result).
  const D = dur(src);
  const outDur = (fast ? plan.real + (plan.fastUntil - plan.real) / 4 + (D - plan.fastUntil) : D) + (plan.hold ?? 0);
  if (plan.voice) {
    inputs.push('-i', plan.voice.file);
    const ms = Math.max(0, Math.round(plan.voice.at * 1000));
    const skip = Math.max(0, -plan.voice.at);
    f.push(`[${x4i + 1}:a]atrim=start=${skip.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${ms}|${ms},atrim=0:${(fast ? plan.real : outDur).toFixed(3)},aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${outDur.toFixed(3)}[aout]`);
  } else f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${outDur.toFixed(3)}[aout]`);
  const out = join(work, `${String(seq++).padStart(2, '0')}-${name}.mp4`);
  ff([...inputs, '-filter_complex', f.join(';'), '-map', '[out]', '-map', '[aout]', ...ENC, '-shortest', out]);
  parts.push(out);
  console.log(`${name}: ${dur(src).toFixed(1)} s → ${dur(out).toFixed(1)} s${fast ? ` (×4 from ${plan.real.toFixed(1)} to ${plan.fastUntil.toFixed(1)} s)` : ''}`);
}

// Each take's times in its clip and what was said when (capture-demo.ts).
type Timing = { voice: string; voiceAt: number; release: number; result: number; speech: { at: number; dur: number; say: string }[] };
const timing = (name: string): Timing => JSON.parse(readFileSync(join(demo, `${name}.timing.json`), 'utf8'));

// Subtitles: the exact spoken words, one cue at a time.
function speech(t: Timing): Sub[] {
  const subs = t.speech.map((p) => ({ from: t.voiceAt + p.at - 0.1, to: t.voiceAt + p.at + p.dur + 0.5, text: p.say }));
  for (let i = 0; i < subs.length - 1; i++) subs[i].to = Math.min(subs[i].to, subs[i + 1].from - 0.05);
  return subs;
}

// Where the picture (and an open reference) sit in the 1600×1000 capture,
// as client/src/editor/engine.ts fits them (theme.css lengths at 16 px/rem).
function fit(nw: number, nh: number, refOpen: boolean) {
  const pad = 32, above = 88, below = 128, left = refOpen ? 416 + pad : 0;
  const k = Math.min((1600 - left - 2 * pad) / nw, (1000 - above - below) / nh);
  return { x: left + (1600 - left - nw * k) / 2, y: above + (1000 - above - below - nh * k) / 2, k };
}
// The open reference card (left-4, 26rem wide, under the chrome, below its header).
const REF_FIT = (() => {
  const k = Math.min(350 / 1600, 703 / 1600);
  return { x: 17 + (414 - 1600 * k) / 2, y: 177 + (703 - 1600 * k) / 2, k };
})();
const size = (file: string) => {
  const o = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]).toString();
  return [Number(/pixelWidth: (\d+)/.exec(o)![1]), Number(/pixelHeight: (\d+)/.exec(o)![1])];
};

function plan2d(name: string, image: string, ref = false): Plan {
  const t = timing(name);
  const start = t.voiceAt + t.speech[0].at;
  // The camera: in on the marks while drawing and while the instructions
  // appear, back out for the wait and the result.
  const strokes = JSON.parse(readFileSync(join(demo, 'clips', `${name}.json`), 'utf8')).strokes as { points: { x: number; y: number }[]; on?: string }[];
  const [nw, nh] = size(image);
  const pic = fit(nw, nh, ref);
  const pts = strokes.flatMap((s) => s.points.map((p) => (s.on ? { x: REF_FIT.x + p.x * REF_FIT.k, y: REF_FIT.y + p.y * REF_FIT.k } : { x: pic.x + p.x * pic.k, y: pic.y + p.y * pic.k })));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const [bx0, bx1, by0, by1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const zm = Math.max(1.12, Math.min(1.38, 1778 / ((bx1 - bx0) * 2.4 + 1), 1000 / ((by1 - by0) * 2.2 + 1)));
  const focus = { x: (bx0 + bx1) / 2, y: (by0 + by1) / 2 };
  const out = Math.min(t.release + 6.5, t.result - 1);
  const zoom: Key[] = [
    { t: start - 0.5, z: 1, x: 800, y: 500 },
    { t: start + 0.5, z: zm, ...focus },
    { t: out, z: zm, ...focus },
    { t: out + 0.9, z: 1, x: 800, y: 500 },
  ];
  // Real time while drawing and while the instructions appear, ×4 for the wait, the result in real time (held 4 s more).
  return { real: out + 0.9, fastUntil: t.result - 0.6, subs: speech(t), zoom, voice: { file: t.voice, at: t.voiceAt }, hold: 4 };
}

// ---------- the cut (DEMO.md) ----------

const gray = '#a1a1aa';
// 0:00 the hook
await clip('hook', plan2d('hook', join(root, 'samples', 'illust', 'armor.jpg')));
await card([{ text: 'This & That', size: 120, weight: 700 }, { text: 'Show it. Say it. Done.', size: 54, color: gray }], 4);
// the problem
await card([{ text: 'AI art gets you 90% there.', size: 72, weight: 600 }], 3);
await card([{ text: 'The last 10% is details.', size: 72, weight: 600 }], 3);
await card([{ text: 'And words can’t point.', size: 72, weight: 600 }], 3);
const prompt = JSON.parse(readFileSync(join(root, 'out', 'bench-hard', 'grid', 'text-1.json'), 'utf8')).instruction as string;
await card(
  [
    { text: 'Typing it:', size: 40, color: gray, gap: 10 },
    { text: `“${prompt.slice(0, 64)}`, size: 38, gap: 6 },
    { text: `${prompt.slice(64)}”`, size: 38, gap: 24 },
    { text: 'Round 1: the wrong macaron changed (the 4th, not the 5th).', size: 36, color: '#f87171' },
  ],
  6,
  { file: join(root, 'out', 'bench-hard', 'grid', 'text-1.jpg'), width: 900 },
);
await clip('macaron', plan2d('macaron', join(root, 'out', 'bench-hard', 'grid', 'original.png')));
await card([{ text: '47 words, 2 rounds', size: 64, weight: 600, color: gray }, { text: 'vs', size: 40, color: gray }, { text: '“Make this one chocolate.” One tap, one sentence.', size: 60, weight: 600 }], 4);
// several edits at once
await card([{ text: 'Several edits, one sentence.', size: 72, weight: 600 }], 3);
await clip('three', plan2d('three', join(root, 'samples', 'illust', 'keyvisual.jpg')));
await clip('hold', { real: 99, fastUntil: 99, subs: [] });
await card([{ text: 'Only what you marked changes.', size: 72, weight: 600 }], 3.5);
// the evidence
await card(
  [
    { text: 'Text-only edits changed 10.4% of the pixels you didn’t ask about.', size: 46, weight: 600 },
    { text: 'This & That: 0.6%.', size: 46, weight: 600, gap: 10 },
    { text: 'What changed: text-only (left) vs This & That (right), removing one fire hydrant', size: 30, color: gray },
  ],
  7,
  { file: join(root, 'out', 'bench-hard', 'diff-street.jpg'), width: 1500 },
);
await card([{ text: '124 words → ~30', size: 72, weight: 600 }, { text: '~3 min of typing → ~18 s of drawing and talking', size: 52, color: gray }], 5);
// how it works
await card(
  [
    { text: 'How it works', size: 60, weight: 700, gap: 34 },
    { text: 'Your strokes and your voice become one video.', size: 40 },
    { text: 'Muse Spark watches and listens: which mark, which words.', size: 40 },
    { text: 'SAM 3.1 turns a rough circle into an exact mask.', size: 40 },
    { text: 'Muse Image makes the edit.', size: 40 },
    { text: 'Voice Transcribe hears you live, in any language.', size: 40 },
  ],
  9,
);
// next: 3D
await card([{ text: 'Next: the same gesture in 3D.', size: 72, weight: 600 }], 3);
{
  const t = timing('chair');
  const D = dur(join(demo, 'chair.mp4'));
  // In on the sketch while it is drawn, out to watch it built and turning.
  const zoom: Key[] = [{ t: 1, z: 1, x: 800, y: 500 }, { t: 2, z: 1.3, x: 800, y: 470 }, { t: 10.5, z: 1.3, x: 800, y: 470 }, { t: 11.5, z: 1.08, x: 800, y: 480 }];
  await clip('chair', { real: 11.5, fastUntil: Math.min(D - 8, t.result - 0.3), subs: speech(t), zoom, voice: { file: t.voice, at: t.voiceAt } });
}
await card([{ text: 'This & That', size: 120, weight: 700 }, { text: 'Built with Meta’s Muse models', size: 46, color: gray, gap: 40 }, { text: 'github.com/enfp-dev-studio/this-and-that', size: 40, color: gray }], 5.5);

// ---------- concat ----------

const list = join(work, 'list.txt');
writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
const final = join(demo, 'this-and-that-demo.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final]);
const total = dur(final);
console.log(`\n${final}: ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')} (${total.toFixed(1)} s, ${parts.length} parts)`);
