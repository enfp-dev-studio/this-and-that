// Assembles the demo video, out/demo/this-and-that-demo.mp4 (1920×1080, 30 fps,
// no sound, no music), from the clips scripts/capture-demo.ts recorded and
// text cards, following DEMO.md: the drawing, the outlines and the
// instruction callouts in real time, the waits sped up ×4 (with a "×4" label),
// English subtitles for the Korean speech burned in. Cards and subtitles are
// drawn with sharp (this ffmpeg has no drawtext), then everything is encoded
// and concatenated with ffmpeg.
//
//   node scripts/edit-demo.ts [capture log]     (default: out/demo/capture.log; CUFF=1 adds the cuff scene)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

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
const ENC = ['-r', '30', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p'];
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
  const layers: sharp.OverlayOptions[] = img ? [{ input: img, left: Math.round((W - image!.width) / 2), top: Math.round(y + 30) }] : [];
  await sharp(Buffer.from(svg)).composite(layers).png().toFile(png);
  const out = join(work, `${String(seq++).padStart(2, '0')}-card.mp4`);
  ff(['-loop', '1', '-i', png, '-t', String(seconds), '-vf', `fade=in:0:8,fade=out:st=${seconds - 0.3}:d=0.3`, ...ENC, out]);
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
type Plan = { real: number; fastUntil: number; subs: Sub[] }; // real time until `real`, ×4 until `fastUntil`, then real time

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
  // 1600×1000 → 1728×1080, centred on the app's dark backdrop.
  const f: string[] = [`[0:v]scale=1728:1080,pad=${W}:${H}:96:0:color=0x0a0a0a,fps=30[v0]`];
  plan.subs.forEach((s, i) => f.push(`[v${i}][${i + 1}:v]overlay=0:0:enable='between(t,${s.from.toFixed(2)},${s.to.toFixed(2)})'[v${i + 1}]`));
  const v = `[v${plan.subs.length}]`;
  const fast = plan.fastUntil - plan.real > 1.5;
  if (fast) {
    f.push(`${v}split=3[a][b][c]`, `[a]trim=0:${plan.real},setpts=PTS-STARTPTS[s1]`, `[b]trim=${plan.real}:${plan.fastUntil},setpts=(PTS-STARTPTS)/4[fb]`, `[fb][${x4i}:v]overlay=W-w-48:${H - 120}[s2]`, `[c]trim=${plan.fastUntil},setpts=PTS-STARTPTS[s3]`, `[s1][s2][s3]concat=n=3:v=1:a=0[out]`);
  } else f.push(`${v}null[out]`);
  const out = join(work, `${String(seq++).padStart(2, '0')}-${name}.mp4`);
  ff([...inputs, '-filter_complex', f.join(';'), '-map', '[out]', ...ENC, out]);
  parts.push(out);
  console.log(`${name}: ${dur(src).toFixed(1)} s → ${dur(out).toFixed(1)} s${fast ? ` (×4 from ${plan.real.toFixed(1)} to ${plan.fastUntil.toFixed(1)} s)` : ''}`);
}

// When each clip's request went out and its result came back, from the
// capture log ("hook: result 37.4 s after release"); the clip ends 3.5 s
// after the result.
const log = readFileSync(process.argv[2] ?? join(demo, 'capture.log'), 'utf8');
// The last take of each scene counts (logs of several runs can be concatenated).
const after = (name: string) => Number([...log.matchAll(new RegExp(`${name}: result ([\\d.]+) s after release`, 'g'))].at(-1)?.[1] ?? NaN);
const builtAt = Number(/chair: \d+ parts ([\d.]+) s/.exec(log)?.[1] ?? 20);

// The voice's phrases, as capture-demo built them (clipkit.buildClip): the
// first at 400 ms, each next one after the last (at least 1.3 s) plus 350 ms.
// The voice starts with the first stroke, ~1.45 s into the clip (2 s later
// when a reference is dropped first).
function speech(name: string, english: string[], startsAt: number): Sub[] {
  let at = 0.4;
  return english.map((text, i) => {
    const d = dur(join(demo, 'clips', `${name}-${i}.aiff`));
    const sub = { from: startsAt + at - 0.5, to: startsAt + at + d + 0.7, text };
    at += Math.max(d, 1.3) + 0.35;
    return sub;
  });
}

function plan2d(name: string, english: string[], ref = false): Plan {
  const D = dur(join(demo, `${name}.mp4`));
  const release = D - 3.5 - after(name);
  return { real: release + 6.5, fastUntil: D - 4.2, subs: speech(name, english, 0.95 + (ref ? 2 : 0)) };
}

// ---------- the cut (DEMO.md) ----------

const gray = '#a1a1aa';
// 0:00 the hook
await clip('hook', plan2d('hook', ['This pauldron, spiky like this.']));
await card([{ text: 'This & That', size: 120, weight: 700 }, { text: 'Show it. Say it. Done.', size: 54, color: gray }], 3.2);
// the problem
await card([{ text: 'AI art gets you 90% there.', size: 72, weight: 600 }], 2.4);
await card([{ text: 'The last 10% is details.', size: 72, weight: 600 }], 2.4);
await card([{ text: 'And words can’t point.', size: 72, weight: 600 }], 2.4);
const prompt = JSON.parse(readFileSync(join(root, 'out', 'bench-hard', 'grid', 'text-1.json'), 'utf8')).instruction as string;
await card(
  [
    { text: 'Typing it:', size: 40, color: gray, gap: 10 },
    { text: `“${prompt.slice(0, 64)}`, size: 38, gap: 6 },
    { text: `${prompt.slice(64)}”`, size: 38, gap: 24 },
    { text: 'Round 1: the wrong macaron changed (the 4th, not the 5th).', size: 36, color: '#f87171' },
  ],
  5,
  { file: join(root, 'out', 'bench-hard', 'grid', 'text-1.jpg'), width: 900 },
);
await clip('macaron', plan2d('macaron', ['Make this one chocolate.']));
await card([{ text: '47 words, 2 rounds', size: 64, weight: 600, color: gray }, { text: 'vs', size: 40, color: gray }, { text: '“이거 초콜릿으로” — one tap, one sentence', size: 64, weight: 600 }], 3.4);
// the demo: production details
await card([{ text: 'Production details', size: 72, weight: 600 }, { text: process.env.CUFF ? 'a reference · a matching pair · several edits at once' : 'a reference · several edits at once', size: 40, color: gray }], 2.6);
await clip('brooch', plan2d('brooch', ['Change this brooch…', '…to look like that.'], true));
// The matching-pair scene fits the 3-minute cut only without it; CUFF=1 adds it back.
if (process.env.CUFF && existsSync(join(demo, 'cuff.mp4'))) await clip('cuff', plan2d('cuff', ['This lace…', '…exactly like that one.']));
await clip('three', plan2d('three', ['Remove this phone,', 'make this red,', 'and a small star here.']));
await clip('hold', { real: 99, fastUntil: 99, subs: [] });
await card([{ text: 'Only what you marked changes.', size: 72, weight: 600 }], 2.6);
// the evidence
await card(
  [
    { text: 'Text-only edits changed 10.4% of the pixels you didn’t ask about.', size: 46, weight: 600 },
    { text: 'This & That: 0.6%.', size: 46, weight: 600, gap: 10 },
    { text: 'What changed: text-only (left) vs This & That (right), removing one fire hydrant', size: 30, color: gray },
  ],
  5.5,
  { file: join(root, 'out', 'bench-hard', 'diff-street.jpg'), width: 1500 },
);
await card([{ text: '124 words → ~30', size: 72, weight: 600 }, { text: '~3 min of typing → ~18 s of drawing and talking', size: 52, color: gray }], 4);
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
  8,
);
// next: 3D
await card([{ text: 'Next: the same gesture in 3D.', size: 72, weight: 600 }], 2.4);
{
  const D = dur(join(demo, 'chair.mp4'));
  // Recording starts 1 s before the pen; the chair is built builtAt s after that, then turns for 9 s.
  await clip('chair', { real: 11, fastUntil: Math.min(D - 8, 1 + builtAt), subs: [{ from: 1.5, to: 5.5, text: 'It’s a chair,' }, { from: 5.5, to: 10.5, text: 'it’s a chair, the back goes like this.' }] });
}
await card([{ text: 'This & That', size: 120, weight: 700 }, { text: 'Built with Meta’s Muse models', size: 46, color: gray, gap: 40 }, { text: 'github.com/enfp-dev-studio/this-and-that', size: 40, color: gray }], 4.5);

// ---------- concat ----------

const list = join(work, 'list.txt');
writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
const final = join(demo, 'this-and-that-demo.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final]);
const total = dur(final);
console.log(`\n${final}: ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')} (${total.toFixed(1)} s, ${parts.length} parts)`);
