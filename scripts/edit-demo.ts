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

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';

const root = join(import.meta.dirname, '..');
const demo = join(root, 'out', 'demo');
const work = join(demo, 'edit');
// `--mix`: only the sound again, over the picture assembled last time (edit/joined.mp4).
const mixOnly = process.argv.includes('--mix');
if (!mixOnly) rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const W = 1920, H = 1080, BG = '#0a0a0a';
const FONT = "'Helvetica Neue', Helvetica, 'Apple SD Gothic Neo', sans-serif";
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ff = (args: string[]) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
const dur = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
// The marks' colours (theme.css --mark-1 … --mark-6, dark) and the takes' voice (capture-demo.ts).
const MARK = ['#ff3e3b', '#268bfc', '#40c95d', '#ffa326', '#b46afa', '#ff49a2'];
const VOICE = 'Samantha';
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

// A quiet line of explanation at the top left (clear of the subtitles at the bottom).
async function notePng(text: string, file: string) {
  const size = 32, w = Math.round(text.length * size * 0.5) + 48;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="40" y="40" width="${w}" height="58" rx="10" fill="#000" fill-opacity="0.55"/><text x="64" y="80" font-family="${FONT}" font-size="${size}" font-weight="400" fill="#e4e4e7">${esc(text)}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

// ---------- clips ----------

type Sub = { from: number; to: number; text: string; png?: string }; // `png`: a full frame to show instead of `text`
// Real time until `real`, a cut over the wait until `fastUntil`, then real time;
// `zoom`: the camera's keyframes (source time, zoom, focus in the clip's 1600×1000 px).
type Key = { t: number; z: number; x: number; y: number };
// `note`: one quiet line explaining the scene (top left, the whole clip).
type Plan = { real: number; fastUntil: number; subs: Sub[]; zoom?: Key[]; voice?: { file: string; at: number }; hold?: number; segs?: Seg[]; pulses?: Pulse[]; note?: string };
// A ring swelling out of a mark at source time `t` (capture px).
type Pulse = { t: number; x: number; y: number; rx: number; ry: number; color: string };
// Stretches of a clip in order, each in real time or cut (`fast`: a wait, left
// out; what follows shows how long it took, `wait` s, default its length).
// `segs` overrides real/fastUntil.
type Seg = { from: number; to: number; fast?: boolean; wait?: number; speed?: number }; // `speed`: a silent stretch played faster (the scripted pen, slower than a hand)

// How long a cut wait took: a stopwatch and the seconds, as a small label.
async function waitLabel(seconds: number, file: string) {
  const text = `${Math.max(1, Math.round(seconds))} s`, w = 96 + text.length * 19, h = 58;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="12" fill="#000" fill-opacity="0.78"/><circle cx="36" cy="32" r="13" fill="none" stroke="#fff" stroke-width="3"/><rect x="32" y="12" width="8" height="5" rx="1.5" fill="#fff"/><line x1="36" y1="32" x2="42" y2="25" stroke="#fff" stroke-width="3" stroke-linecap="round"/><text x="62" y="41" font-family="${FONT}" font-size="30" font-weight="600" fill="#fff">${text}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
  return { w, h };
}

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

// A ring that swells and fades over 0.67 s, as PNG frames (<prefix>-NN.png).
async function pulseFrames(prefix: string, p: Pulse) {
  const w = Math.ceil(p.rx * 2.9 + 40), h = Math.ceil(p.ry * 2.9 + 40);
  for (let i = 0; i < 20; i++) {
    const u = i / 19, k = 1 + 0.35 * u;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><ellipse cx="${w / 2}" cy="${h / 2}" rx="${(p.rx * k).toFixed(1)}" ry="${(p.ry * k).toFixed(1)}" fill="${p.color}" fill-opacity="${(0.22 * (1 - u)).toFixed(3)}" stroke="${p.color}" stroke-opacity="${(0.95 * (1 - u) ** 1.3).toFixed(3)}" stroke-width="${(14 * (1 - u) + 3).toFixed(1)}"/></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(`${prefix}-${String(i).padStart(2, '0')}.png`);
  }
  return { pattern: `${prefix}-%02d.png`, w, h };
}

async function clip(name: string, plan: Plan) {
  const src = join(demo, `${name}.mp4`);
  if (!existsSync(src)) return console.log(`(no ${name}.mp4, skipped)`);
  const inputs: string[] = [];
  const input = (...args: string[]) => (inputs.push(...args), inputs.filter((a) => a === '-i').length - 1); // its index
  input('-i', src);
  // 1600×1000 on a 16:9 dark canvas (1778×1000), the pulses drawn on it (so
  // the camera carries them), then the camera: zoompan crops around the focus
  // at the keyframed zoom and scales to 1920×1080.
  const T = 'on/30', PADX = 89;
  const f: string[] = [`[0:v]fps=30,pad=1778:1000:${PADX}:0:color=0x0a0a0a[p0]`];
  const pulses = plan.pulses ?? [];
  for (const [j, p] of pulses.entries()) {
    const { pattern, w, h } = await pulseFrames(join(work, `pulse-${name}-${j}`), p);
    const k = input('-framerate', '30', '-i', pattern);
    f.push(`[${k}:v]setpts=PTS-STARTPTS+${p.t.toFixed(3)}/TB[q${j}]`, `[p${j}][q${j}]overlay=${Math.round(p.x + PADX - w / 2)}:${Math.round(p.y - h / 2)}:eof_action=pass[p${j + 1}]`);
  }
  const keys = plan.zoom ?? [{ t: 0, z: 1, x: 800, y: 500 }];
  const z = eased(keys, (k) => k.z, T);
  const fx = eased(keys, (k) => k.x + PADX, T), fy = eased(keys, (k) => k.y, T);
  f.push(`[p${pulses.length}]zoompan=z='${z}':x='max(0,min(iw-iw/zoom,(${fx})-iw/zoom/2))':y='max(0,min(ih-ih/zoom,(${fy})-ih/zoom/2))':d=1:s=${W}x${H}:fps=30[v0]`);
  for (const [i, sub] of plan.subs.entries()) {
    let png = sub.png;
    if (!png) await subtitle(sub.text, (png = join(work, `sub-${name}-${i}.png`)));
    const k = input('-i', png);
    f.push(`[v${i}][${k}:v]overlay=0:0:enable='between(t,${sub.from.toFixed(3)},${sub.to.toFixed(3)})'[v${i + 1}]`);
  }
  const v = `[v${plan.subs.length}]`;
  const D = dur(src);
  const segs: Seg[] = plan.segs ?? (plan.fastUntil - plan.real > 1.5 ? [{ from: 0, to: plan.real }, { from: plan.real, to: plan.fastUntil, fast: true }, { from: plan.fastUntil, to: D }] : [{ from: 0, to: D }]);
  const hold = plan.hold ? `,tpad=stop_mode=clone:stop_duration=${plan.hold}` : '';
  // The waits are cut; the stretch after one opens with how long it took (top centre, under the app's status).
  const shown = segs.map((g, i) => ({ g, i, cut: segs[i - 1]?.fast ? segs[i - 1] : undefined })).filter(({ g }) => !g.fast);
  f.push(`${v}split=${shown.length}${shown.map(({ i }) => `[g${i}]`).join('')}`);
  for (const [n, { g, i, cut }] of shown.entries()) {
    const last = n === shown.length - 1 ? hold : '';
    const base = `[g${i}]trim=${g.from.toFixed(3)}:${g.to.toFixed(3)},setpts=(PTS-STARTPTS)/${g.speed ?? 1}`;
    if (cut) {
      const png = join(work, `wait-${name}-${i}.png`);
      const { w } = await waitLabel(cut.wait ?? cut.to - cut.from, png);
      const k = input('-i', png);
      f.push(`${base}[c${i}]`, `[c${i}][${k}:v]overlay=${Math.round((W - w) / 2)}:132:enable='lt(t,2.6)'${last}[s${i}]`);
    } else f.push(`${base}${last}[s${i}]`);
  }
  f.push(`${shown.map(({ i }) => `[s${i}]`).join('')}concat=n=${shown.length}:v=1:a=0${plan.note ? '[outc]' : '[out]'}`);
  if (plan.note) {
    const png = join(work, `note-${name}.png`);
    await notePng(plan.note, png);
    f.push(`[outc][${input('-i', png)}:v]overlay=0:0:enable='gte(t,0.3)'[out]`);
  }
  // The take's voice at its times in the clip, heard in the stretches shown.
  const outDur = shown.reduce((sum, { g }) => sum + (g.to - g.from) / (g.speed ?? 1), 0) + (plan.hold ?? 0);
  if (plan.voice) {
    const vi = input('-i', plan.voice.file);
    const ms = Math.max(0, Math.round(plan.voice.at * 1000));
    const skip = Math.max(0, -plan.voice.at);
    const A = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
    f.push(`[${vi}:a]atrim=start=${skip.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${ms}|${ms},aresample=48000,${A},apad=whole_dur=${D.toFixed(3)},asplit=${shown.length}${shown.map(({ i }) => `[va${i}]`).join('')}`);
    // Each stretch faded in and out over a few hundredths of a second: no clicks at the cuts.
    const fades = (d: number) => `afade=t=in:d=0.03,afade=t=out:st=${Math.max(0, d - 0.05).toFixed(3)}:d=0.05`;
    for (const { g, i } of shown) f.push(g.speed ? `[va${i}]atrim=0:${((g.to - g.from) / g.speed).toFixed(3)},volume=0,asetpts=PTS-STARTPTS[a${i}]` : `[va${i}]atrim=${g.from.toFixed(3)}:${g.to.toFixed(3)},asetpts=PTS-STARTPTS,${fades(g.to - g.from)}[a${i}]`);
    f.push(`${shown.map(({ i }) => `[a${i}]`).join('')}concat=n=${shown.length}:v=0:a=1,apad=whole_dur=${outDur.toFixed(3)}[aout]`);
  } else f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${outDur.toFixed(3)}[aout]`);
  const out = join(work, `${String(seq++).padStart(2, '0')}-${name}.mp4`);
  ff([...inputs, '-filter_complex', f.join(';'), '-map', '[out]', '-map', '[aout]', ...ENC, '-shortest', out]);
  parts.push(out);
  const cuts = segs.filter((g) => g.fast);
  console.log(`${name}: ${D.toFixed(1)} s → ${dur(out).toFixed(1)} s${cuts.length ? ` (cut: ${cuts.map((g) => `${g.from.toFixed(1)}–${g.to.toFixed(1)}`).join(', ')} s)` : ''}`);
}

// The problem in one shot: typing the macaron's position got the wrong one
// (the text-only bench, round 1), one tap and four words got the right one.
async function macaronBeat() {
  const t = timing('macaron');
  const gray2 = '#a1a1aa';
  const prompt = JSON.parse(readFileSync(join(root, 'out', 'bench-hard', 'grid', 'text-1.json'), 'utf8')).instruction as string;
  const words = prompt.split(/\s+/);
  const half = Math.ceil(words.length / 2);
  // Left: the typed instruction over the wrong result, the wrong macaron ringed.
  const ringed = await sharp(join(root, 'out', 'bench-hard', 'grid', 'text-1.jpg')).resize(1920, 1280).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1280"><ellipse cx="1022" cy="776" rx="140" ry="160" fill="none" stroke="#ef4444" stroke-width="14"/></svg>`), left: 0, top: 0 }]).toBuffer();
  const wrong = await sharp(ringed).resize(860).toBuffer();
  const line = (x: number, y: number, size: number, text: string, color = '#fafafa', weight = 500) => `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="middle">${esc(text)}</text>`;
  const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="${BG}"/><rect x="959" y="120" width="2" height="840" fill="#27272a"/>${line(480, 150, 34, 'Typing it', gray2)}${line(480, 205, 28, `“${words.slice(0, half).join(' ')}`)}${line(480, 245, 28, `${words.slice(half).join(' ')}”`)}${line(1440, 150, 34, 'Showing it', gray2)}${line(480, 990, 52, '47 words, 2 rounds', '#f87171', 700)}${line(1440, 990, 52, '4 words, 1 try', '#4ade80', 700)}</svg>`;
  const png = join(work, 'macaron-bg.png');
  await sharp(Buffer.from(bg)).composite([{ input: wrong, left: 50, top: 300 }]).png().toFile(png);
  // Right: the take, cropped to the picture: tap and say it, the wait cut (its time shown), the right one.
  const src = join(demo, 'macaron.mp4');
  const s0 = Math.max(0, t.voiceAt + t.speech[0].at - 0.6), s1 = t.release + 0.1, s2 = t.result + 0.8, s3 = Math.min(dur(src), s2 + 2.4);
  const subPng = join(work, 'sub-macaron.png');
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="80"><rect x="${(900 - 520) / 2}" y="4" width="520" height="70" rx="10" fill="#000" fill-opacity="0.72"/><text x="450" y="52" font-family="${FONT}" font-size="40" font-weight="500" fill="#fff" text-anchor="middle">${esc(t.speech[0].say)}</text></svg>`)).png().toFile(subPng);
  const waitPng = join(work, 'wait-macaron.png');
  const { w: ww } = await waitLabel(t.result - t.release, waitPng);
  const say = { from: t.voiceAt + t.speech[0].at - s0 - 0.1, to: t.voiceAt + t.speech[0].at + t.speech[0].dur - s0 + 0.5 };
  const d1 = s1 - s0, d3 = s3 - s2, total = d1 + d3 + 1.5;
  const f = [
    // the picture's place in the capture (fit(): 1176×784 at 212,88) and a little around it
    `[1:v]fps=30,crop=1236:824:182:58,scale=860:574,split=2[m0][m2]`,
    `[m0]trim=${s0.toFixed(3)}:${s1.toFixed(3)},setpts=PTS-STARTPTS[r0]`,
    `[m2]trim=${s2.toFixed(3)}:${s3.toFixed(3)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=1.5[m3]`,
    `[m3][3:v]overlay=${Math.round((860 - ww) / 2)}:16:enable='lt(t,2.6)'[r2]`,
    `[r0][r2]concat=n=2:v=1:a=0[mv]`,
    `[0:v][mv]overlay=1010:300:shortest=1[b0]`,
    `[b0][2:v]overlay=1010:${300 + 574 - 90}:enable='between(t,${say.from.toFixed(2)},${say.to.toFixed(2)})',fade=in:0:8,fade=out:st=${(total - 0.3).toFixed(2)}:d=0.3[out]`,
    `[4:a]atrim=start=${Math.max(0, s0 - t.voiceAt).toFixed(3)},asetpts=PTS-STARTPTS,adelay=${Math.round(Math.max(0, t.voiceAt - s0) * 1000)}|${Math.round(Math.max(0, t.voiceAt - s0) * 1000)},atrim=0:${d1.toFixed(3)},aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${total.toFixed(3)}[aout]`,
  ];
  const out = join(work, `${String(seq++).padStart(2, '0')}-macaron-beat.mp4`);
  ff(['-loop', '1', '-t', total.toFixed(3), '-i', png, '-i', src, '-loop', '1', '-t', total.toFixed(3), '-i', subPng, '-i', waitPng, '-i', t.voice, '-filter_complex', f.join(';'), '-map', '[out]', '-map', '[aout]', ...ENC, '-t', total.toFixed(3), out]);
  parts.push(out);
  console.log(`macaron beat: ${dur(out).toFixed(1)} s`);
}

// Each take's times in its clip and what was said when (capture-demo.ts).
type Timing = { voice: string; voiceAt: number; release: number; result: number; edit?: { release: number; done: number; ok: boolean }; steps?: { say: number; release: number; done: number }[]; paint?: number; painted?: number; speech: { at: number; dur: number; say: string }[] };
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

// From just before the first word to the moment the talk button is let go,
// then a cut straight to the finished result (0.8 s after it lands, past the
// reveal), shown once for `show` s with the time the wait took.
// `maxZoom`: how close the camera may go on small marks.
function plan2d(name: string, image: string, ref = false, maxZoom = 1.38, show = 2.6): Plan {
  const t = timing(name);
  const start = t.voiceAt + t.speech[0].at;
  // The camera: in on the marks while drawing, and on them for the result too.
  const strokes = JSON.parse(readFileSync(join(demo, 'clips', `${name}.json`), 'utf8')).strokes as { points: { x: number; y: number }[]; on?: string }[];
  const [nw, nh] = size(image);
  const pic = fit(nw, nh, ref);
  const pts = strokes.flatMap((s) => s.points.map((p) => (s.on ? { x: REF_FIT.x + p.x * REF_FIT.k, y: REF_FIT.y + p.y * REF_FIT.k } : { x: pic.x + p.x * pic.k, y: pic.y + p.y * pic.k })));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const [bx0, bx1, by0, by1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const zm = Math.max(1.12, Math.min(maxZoom, 1778 / ((bx1 - bx0) * 2.4 + 1), 1000 / ((by1 - by0) * 2.2 + 1)));
  const focus = { x: (bx0 + bx1) / 2, y: (by0 + by1) / 2 };
  const lead = Math.max(0, start - 0.6);
  const zoom: Key[] = [
    { t: lead, z: 1, x: 800, y: 500 },
    { t: start + 0.4, z: zm, ...focus },
  ];
  const cut = t.release + 0.1, from = t.result + 0.8;
  const end = Math.min(dur(join(demo, `${name}.mp4`)), from + show);
  // The scripted pen draws a long outline slower than a hand: once the words are said, the rest of the stroke in ~2 s.
  const said = t.voiceAt + Math.max(...t.speech.map((p) => p.at + p.dur)) + 0.3;
  const drawing: Seg[] = cut - said > 3 ? [{ from: lead, to: said }, { from: said, to: cut, speed: (cut - said) / 2 }] : [{ from: lead, to: cut }];
  return { real: cut, fastUntil: from, segs: [...drawing, { from: cut, to: from, fast: true, wait: t.result - t.release }, { from, to: end }], subs: speech(t), zoom, voice: { file: t.voice, at: t.voiceAt } };
}

// The takes that passed scripts/accept-demo.ts (out/demo/accept.json).
const accepted = (name: string) => {
  const f = join(demo, 'accept.json');
  return existsSync(f) && !!JSON.parse(readFileSync(f, 'utf8'))[name]?.pass;
};

// ---------- pointing words ----------

// When each word of a line starts (s from the line's start) as `say -v VOICE`
// speaks it: how long saying the words before it takes.
function wordStarts(line: string) {
  const words = line.split(/\s+/);
  const f = join(work, 'prefix.aiff');
  return words.map((word, i) => {
    if (i === 0) return { word, at: 0.05 };
    execFileSync('say', ['-v', VOICE, '-o', f, words.slice(0, i).join(' ')]);
    return { word, at: Math.max(0, speechEnd(f) - 0.06) };
  });
}
// Where the sound ends: the start of the silence that runs to the file's end.
function speechEnd(file: string) {
  const log = spawnSync('ffmpeg', ['-i', file, '-af', 'silencedetect=n=-40dB:d=0.04', '-f', 'null', '-']).stderr.toString();
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const D = dur(file);
  const last = starts.at(-1);
  return last !== undefined && (ends.length < starts.length || ends.at(-1)! >= D - 0.05) ? last : D;
}

// Each mark's place in the capture (an ellipse around its stroke).
function markRings(name: string, image: string) {
  const strokes = JSON.parse(readFileSync(join(demo, 'clips', `${name}.json`), 'utf8')).strokes as { mark: number; points: { x: number; y: number }[] }[];
  const [nw, nh] = size(image);
  const pic = fit(nw, nh, false);
  return strokes.map((st) => {
    const xs = st.points.map((p) => pic.x + p.x * pic.k), ys = st.points.map((p) => pic.y + p.y * pic.k);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, rx: Math.max(28, (x1 - x0) / 2) * 1.08, ry: Math.max(28, (y1 - y0) / 2) * 1.08, color: MARK[(st.mark - 1) % MARK.length] };
  });
}

type Word = { text: string; at: number; mark?: number };
// The whole line, the first `lit` words said; "this"/"here" bold, in its mark's colour once said.
async function karaokeLine(words: Word[], lit: number, file: string) {
  const size = 46, text = words.map((w) => w.text).join(' ');
  const w = Math.min(W - 120, Math.round(text.length * size * 0.5) + 64);
  const spans = words.map((x, i) => {
    const said = i < lit;
    const fill = said ? (x.mark !== undefined ? MARK[x.mark] : '#ffffff') : '#71717a';
    return `<tspan fill="${fill}"${x.mark !== undefined ? ' font-weight="700"' : ''}>${esc(x.text)}</tspan>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${(W - w) / 2}" y="${H - 150}" width="${w}" height="76" rx="10" fill="#000" fill-opacity="0.75"/><text xml:space="preserve" x="${W / 2}" y="${H - 150 + 52}" font-family="${FONT}" font-size="${size}" font-weight="500" text-anchor="middle">${spans.join(' ')}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
// Which word went to which mark: numbered chips, the first `n` shown (places fixed).
async function chips(items: string[], n: number, file: string) {
  const size = 40, gap = 24, y = H - 150;
  const widths = items.map((t) => Math.round(t.length * size * 0.5) + 104);
  let x = (W - widths.reduce((a, b) => a + b, 0) - gap * (items.length - 1)) / 2;
  const out = items.map((t, i) => {
    const c = `<rect x="${x}" y="${y}" width="${widths[i]}" height="76" rx="10" fill="#000" fill-opacity="0.78"/><circle cx="${x + 40}" cy="${y + 38}" r="22" fill="${MARK[i]}"/><text x="${x + 40}" y="${y + 48}" font-family="${FONT}" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">${i + 1}</text><text x="${x + 74}" y="${y + 52}" font-family="${FONT}" font-size="${size}" font-weight="500" fill="#fff">${esc(t)}</text>`;
    x += widths[i] + gap;
    return i < n ? c : '';
  });
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${out.join('')}</svg>`)).png().toFile(file);
}

// A take whose words point: karaoke subtitles (each word lit as it is said,
// "this"/"here" in its mark's colour) with that mark pulsing the moment it is
// said; then, as the app's numbered callouts land, which word went to which mark.
async function pointing(name: string, image: string, plan: Plan, legend: string[]): Promise<Plan> {
  const t = timing(name);
  const rings = markRings(name, image);
  const words: Word[] = [];
  t.speech.forEach((p, i) => {
    let pointed = false;
    for (const w of wordStarts(p.say)) {
      const deictic: boolean = !pointed && /^(this|that|here|there)\b/i.test(w.word);
      pointed ||= deictic;
      words.push({ text: w.word, at: t.voiceAt + p.at + w.at, mark: deictic ? i : undefined });
    }
  });
  const landed = plan.fastUntil; // the result, where the cut lands
  const subs: Sub[] = [];
  for (let k = 0; k <= words.length; k++) {
    const png = join(work, `say-${name}-${k}.png`);
    await karaokeLine(words, k, png);
    subs.push({ from: k ? words[k - 1].at : words[0].at - 0.5, to: k < words.length ? words[k].at - 0.001 : landed - 0.05, text: '', png });
  }
  for (let i = 0; i < legend.length; i++) {
    const png = join(work, `chips-${name}-${i}.png`);
    await chips(legend, i + 1, png);
    subs.push({ from: landed + 0.3 * i, to: i < legend.length - 1 ? landed + 0.3 * (i + 1) - 0.001 : plan.segs!.at(-1)!.to, text: '', png });
  }
  const pulses: Pulse[] = words.filter((w) => w.mark !== undefined).map((w) => ({ t: w.at, ...rings[w.mark!] }));
  legend.forEach((_, i) => pulses.push({ t: landed + 0.3 * i, ...rings[i] }));
  return { ...plan, subs, pulses };
}

// Select → type → wait, three times, beside one take (sped up, generic boxes
// and a text field: no real product's look).
async function compareCard(seconds: number) {
  const img = join(root, 'samples', 'illust', 'keyvisual.jpg');
  const [nw, nh] = size(img);
  const tw = 760, th = Math.round((tw * nh) / nw), k = tw / nw;
  const thumb = await sharp(img).resize(tw).toBuffer();
  const L = { x: 100, y: 220 }, R = { x: 1060, y: 220 };
  const strokes = JSON.parse(readFileSync(join(demo, 'clips', 'three.json'), 'utf8')).strokes as { points: { x: number; y: number }[] }[];
  const boxes = strokes.map((st) => {
    const xs = st.points.map((p) => p.x * k), ys = st.points.map((p) => p.y * k);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
  const prompts = ['Remove the phone in her hand', 'Make her blazer red', 'Add a small star in the sky'];
  const said = timing('three').speech.map((p) => p.say);
  const txt = (x: number, y: number, size: number, text: string, color = '#fafafa', weight = 500, anchor = 'middle', op = 1) => `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${color}" fill-opacity="${op}" text-anchor="${anchor}">${esc(text)}</text>`;
  const base = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="${BG}"/><rect x="959" y="110" width="2" height="900" fill="#27272a"/>${txt(480, 160, 44, 'Select → type → wait, ×3', '#e4e4e7', 600)}${txt(1440, 160, 44, 'One take', '#e4e4e7', 600)}</svg>`))
    .composite([{ input: thumb, left: L.x, top: L.y }, { input: thumb, left: R.x, top: R.y }]).png().toBuffer();
  const dir = join(work, 'compare');
  mkdirSync(dir, { recursive: true });
  const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
  const N = Math.round(seconds * 30);
  for (let i = 0; i < N; i++) {
    const t = i / 30;
    let o = '';
    // Left: a round per edit (2 s): drag a box, type, wait.
    const round = Math.min(2, Math.floor((t - 0.4) / 2)), u = t - 0.4 - 2 * round;
    if (t >= 0.4) {
      for (let j = 0; j <= round; j++) {
        const [x0, y0, x1, y1] = boxes[j];
        const g = j < round || u >= 2 ? 1 : ease(u / 0.5);
        o += `<rect x="${L.x + x0}" y="${L.y + y0}" width="${((x1 - x0) * g).toFixed(1)}" height="${((y1 - y0) * g).toFixed(1)}" fill="#fff" fill-opacity="${j === round && u < 2 ? 0.12 : 0.05}" stroke="#fff" stroke-opacity="${j === round && u < 2 ? 1 : 0.4}" stroke-width="3" stroke-dasharray="10 7"/>`;
      }
      const fy = L.y + th + 22;
      const typed = u < 0.5 ? '' : prompts[round].slice(0, Math.ceil(prompts[round].length * Math.min(1, (u - 0.5) / 0.8)));
      o += `<rect x="${L.x}" y="${fy}" width="${tw}" height="62" rx="8" fill="#18181b" stroke="#3f3f46" stroke-width="2"/>`;
      o += txt(L.x + 20, fy + 41, 30, typed + (u >= 0.5 && u < 1.3 && Math.floor(t * 4) % 2 ? '|' : ''), '#e4e4e7', 400, 'start');
      if (u < 0.5 && round < 3) o += txt(L.x + 20, fy + 41, 30, 'Describe the change…', '#52525b', 400, 'start');
      if (u >= 1.3 && u < 2) o += `<rect x="${L.x}" y="${fy + 78}" width="${tw}" height="8" rx="4" fill="#27272a"/><rect x="${L.x}" y="${fy + 78}" width="${(tw * Math.min(1, (u - 1.3) / 0.7)).toFixed(1)}" height="8" rx="4" fill="#a1a1aa"/>` + txt(L.x + tw, fy + 118, 26, 'Generating…', '#a1a1aa', 400, 'end');
      o += txt(L.x, fy + 118, 26, `Edit ${round + 1} of 3`, '#a1a1aa', 400, 'start');
    }
    // Right: the three marks drawn while the sentence is said.
    for (let j = 0; j < 3; j++) {
      const a = 0.4 + 0.8 * j, g = Math.max(0, Math.min(1, (t - a) / 0.75));
      if (g <= 0) continue;
      const pts = strokes[j].points;
      const n = Math.max(2, Math.round(pts.length * g));
      o += `<polyline points="${pts.slice(0, n).map((p) => `${(R.x + p.x * k).toFixed(1)},${(R.y + p.y * k).toFixed(1)}`).join(' ')}" fill="none" stroke="${MARK[j]}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    const lines = [said.slice(0, 2).join(' '), said[2]];
    const shown = said.filter((_, j) => t >= 0.4 + 0.8 * j).length;
    if (shown) o += txt(1440, R.y + th + 62, 32, shown >= 2 ? lines[0] : said[0], '#fafafa', 500) + (shown >= 3 ? txt(1440, R.y + th + 106, 32, lines[1], '#fafafa', 500) : '');
    // The times: one take is done long before the third round.
    if (t >= 3) o += txt(1440, 1010, 64, 'One take: 6 s', '#4ade80', 700, 'middle', ease((t - 3) / 0.3));
    if (t >= 6.4) o += txt(480, 1010, 64, '~1.5 min', '#f87171', 700, 'middle', ease((t - 6.4) / 0.3));
    await sharp(base).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${o}</svg>`), left: 0, top: 0 }]).png().toFile(join(dir, `${String(i).padStart(3, '0')}.png`));
  }
  const out = join(work, `${String(seq++).padStart(2, '0')}-compare.mp4`);
  ff(['-framerate', '30', '-i', join(dir, '%03d.png'), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(seconds), '-vf', `fade=in:0:8,fade=out:st=${seconds - 0.3}:d=0.3`, '-map', '0:v', '-map', '1:a', ...ENC, out]);
  parts.push(out);
  console.log(`compare: ${dur(out).toFixed(1)} s`);
}

// The proof of a detail edit: a close-up from the full-size pictures around
// the mark, the original with the stroke drawn on it, then the result (with
// the time the edit took), crossfaded.
async function closeUp(name: string, image: string) {
  const t = timing(name);
  const strokes = JSON.parse(readFileSync(join(demo, 'clips', `${name}.json`), 'utf8')).strokes as { points: { x: number; y: number }[] }[];
  const pts = strokes.flatMap((st) => st.points);
  const [nw, nh] = size(image);
  const [x0, x1, y0, y1] = [Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y))];
  let h = Math.max(240, (y1 - y0) * 3), w = (h * 16) / 9;
  if (w > nw) (w = nw), (h = (w * 9) / 16);
  const left = Math.round(Math.min(nw - w, Math.max(0, (x0 + x1) / 2 - w / 2))), top = Math.round(Math.min(nh - h, Math.max(0, (y0 + y1) / 2 - h / 2)));
  const region = { left, top, width: Math.round(w), height: Math.round(h) };
  const k = W / region.width;
  const tag = (text: string) => `<rect x="40" y="40" width="${40 + text.length * 22}" height="64" rx="12" fill="#000" fill-opacity="0.72"/><text x="60" y="84" font-family="${FONT}" font-size="36" font-weight="600" fill="#fff">${esc(text)}</text>`;
  const outline = strokes.map((st) => `<polyline points="${st.points.map((p) => `${((p.x - left) * k).toFixed(1)},${((p.y - top) * k).toFixed(1)}`).join(' ')}" fill="none" stroke="${MARK[0]}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  const waitPng = join(work, `wait-close-${name}.png`);
  const { w: ww } = await waitLabel(t.result - t.release, waitPng);
  const still = async (file: string, overlay: string, extra: OverlayOptions[], out: string) => {
    const full = await sharp(file).resize(nw, nh, { fit: 'fill' }).toBuffer();
    const base = await sharp(await sharp(full).extract(region).toBuffer()).resize(W, H).toBuffer();
    await sharp(base).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${overlay}</svg>`) }, ...extra]).png().toFile(out);
  };
  const before = join(work, `close-${name}-before.png`), after = join(work, `close-${name}-after.png`);
  await still(image, outline + tag('Before'), [], before);
  await still(join(demo, `${name}.result.png`), tag('After'), [{ input: waitPng, left: Math.round((W - ww) / 2), top: 44 }], after);
  const out = join(work, `${String(seq++).padStart(2, '0')}-close-${name}.mp4`);
  ff(['-loop', '1', '-t', '1.4', '-i', before, '-loop', '1', '-t', '2.0', '-i', after, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-filter_complex', '[0:v]fps=30,format=yuv420p[a];[1:v]fps=30,format=yuv420p[b];[a][b]xfade=transition=fade:duration=0.5:offset=0.9[out]', '-map', '[out]', '-map', '2:a', ...ENC, '-t', '2.9', out]);
  parts.push(out);
  console.log(`close-up ${name}: ${region.width}×${region.height} px at ${left},${top} (×${(W / region.width).toFixed(1)} of the picture)`);
}

// The same proof for a surface edit in 3D: two frames of the take (before the
// mark, after the result, same view), cropped around what changed.
async function closeUpFrames(name: string, before: number, after: number, wait: number) {
  const src = join(demo, `${name}.mp4`);
  const fa = join(work, `close-${name}-a.png`), fb = join(work, `close-${name}-b.png`);
  ff(['-ss', before.toFixed(2), '-i', src, '-frames:v', '1', fa]);
  ff(['-ss', after.toFixed(2), '-i', src, '-frames:v', '1', fb]);
  const { width: cw, height: ch } = await sharp(fa).metadata();
  const [a, b] = [await sharp(fa).removeAlpha().raw().toBuffer(), await sharp(fb).removeAlpha().raw().toBuffer()];
  // What the edit added: pixels that turned red (the emblem), inside the picture area.
  const vivid = (p: Buffer, i: number) => p[i] - Math.max(p[i + 1], p[i + 2]) > 28;
  let [x0, y0, x1, y1] = [cw!, ch!, 0, 0];
  for (let y = 90; y < ch! - 140; y += 2)
    for (let x = 0; x < cw!; x += 2) {
      const i = (y * cw! + x) * 3;
      if (vivid(b, i) && !vivid(a, i)) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
    }
  if (x1 <= x0) return console.log(`(no change found for ${name}'s close-up)`);
  let h = Math.max(200, (y1 - y0) * 3), w = (h * 16) / 9;
  if (w > cw!) (w = cw!), (h = (w * 9) / 16);
  const region = { left: Math.round(Math.min(cw! - w, Math.max(0, (x0 + x1) / 2 - w / 2))), top: Math.round(Math.min(ch! - h, Math.max(0, (y0 + y1) / 2 - h / 2))), width: Math.round(w), height: Math.round(h) };
  const tag = (text: string) => `<rect x="40" y="40" width="${40 + text.length * 22}" height="64" rx="12" fill="#000" fill-opacity="0.72"/><text x="60" y="84" font-family="${FONT}" font-size="36" font-weight="600" fill="#fff">${esc(text)}</text>`;
  const waitPng = join(work, `wait-close-${name}.png`);
  const { w: ww } = await waitLabel(wait, waitPng);
  const still = async (file: string, label: string, extra: OverlayOptions[], out: string) => {
    const base = await sharp(await sharp(file).extract(region).toBuffer()).resize(W, H).toBuffer();
    await sharp(base).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${tag(label)}</svg>`) }, ...extra]).png().toFile(out);
  };
  const sb = join(work, `close-${name}-before.png`), sa = join(work, `close-${name}-after.png`);
  await still(fa, 'Before', [], sb);
  await still(fb, 'After', [{ input: waitPng, left: Math.round((W - ww) / 2), top: 44 }], sa);
  const out = join(work, `${String(seq++).padStart(2, '0')}-close-${name}.mp4`);
  ff(['-loop', '1', '-t', '1.4', '-i', sb, '-loop', '1', '-t', '2.0', '-i', sa, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-filter_complex', '[0:v]fps=30,format=yuv420p[a];[1:v]fps=30,format=yuv420p[b];[a][b]xfade=transition=fade:duration=0.5:offset=0.9[out]', '-map', '[out]', '-map', '2:a', ...ENC, '-t', '2.9', out]);
  parts.push(out);
  console.log(`close-up ${name}: ${region.width}×${region.height} px at ${region.left},${region.top} (×${(W / region.width).toFixed(1)})`);
}

// ---------- the cut (DEMO.md) ----------

if (mixOnly) {
  mixSound(join(work, 'joined.mp4'), join(demo, 'this-and-that-demo.mp4'));
  process.exit(0);
}

const gray = '#a1a1aa';
const LINE = ['Complex edits, asked simply:', 'draw and talk at the same time.'];
// 0:00 the hook: the strongest detail edit that passed (a teardrop drawn on the gem), then the line and the problem
const illust = (f: string) => join(root, 'samples', 'illust', f);
const opener = accepted('gem') ? 'gem' : null;
if (opener) {
  await clip(opener, { ...(await pointing(opener, illust('armor.jpg'), plan2d(opener, illust('armor.jpg'), false, 1.6), [])), note: 'The stroke draws the new shape. Only that part changes.' });
  await closeUp(opener, illust('armor.jpg'));
}
await card([{ text: LINE[0], size: 72, weight: 600 }, { text: LINE[1], size: 72, weight: 600, gap: 40 }, { text: 'This & That', size: 44, color: gray }], 3.5);
await card([{ text: 'AI art gets you 90% there.', size: 72, weight: 600 }, { text: 'The last 10% is details, and words can’t point.', size: 52, color: gray }], 3.5);
// simple to complex: one tap, then edits where the stroke is the shape and the
// place (only those that passed the acceptance check), three in one breath, 3D
await macaronBeat();
// (The cameo passed the check, but Spark's callout read "Recolor the cameo", not the shape asked for: left out.)
const NOTES: Record<string, string> = { hairpin: 'Drawn as a star, it becomes a star, right where the pin was.' };
const takes = [['clip', 'armor.jpg'], ['hairpin', 'gothic.jpg'], ['hook', 'armor.jpg'], ['emblem', 'armor.jpg']];
for (const [name, image] of takes) {
  if (name === opener || !accepted(name)) continue;
  await clip(name, { ...(await pointing(name, illust(image), plan2d(name, illust(image), false, 1.6), [])), note: NOTES[name] ?? 'The stroke draws the new shape. Only that part changes.' });
  await closeUp(name, illust(image));
}
if (accepted('three')) {
  await clip('three', { ...(await pointing('three', illust('keyvisual.jpg'), plan2d('three', illust('keyvisual.jpg')), ['“this” → the phone', '“this” → the blazer', '“here” → the sky'])), note: 'Each “this” goes to the mark drawn at that moment.' });
  // One before/after toggle: before (held), then after again.
  await clip('hold', { real: 99, fastUntil: 99, segs: [{ from: 1.25, to: 3.9 }], subs: [], note: 'Before, then after: everything you didn’t mark stays the same.' });
}
// the evidence
await card(
  [
    { text: 'Text-only edits changed 10.4% of the pixels you didn’t ask about.', size: 46, weight: 600 },
    { text: 'This & That: 0.6%.', size: 46, weight: 600, gap: 10 },
    { text: 'What changed: text-only (left) vs This & That (right), removing one fire hydrant', size: 30, color: gray },
  ],
  4,
  { file: join(root, 'out', 'bench-hard', 'diff-street.jpg'), width: 1500 },
);
// how it works
await card(
  [
    { text: 'How it works', size: 60, weight: 700, gap: 34 },
    { text: 'Strokes + voice → one video', size: 44 },
    { text: 'Muse Spark: which mark, which words', size: 44 },
    { text: 'SAM 3.1: rough circle → exact mask', size: 44 },
    { text: 'Muse Image: the edit', size: 44 },
    { text: 'Voice Transcribe: hears you live', size: 44 },
  ],
  4.5,
);
// next: 3D
await card([{ text: 'The same gesture, on a 3D model.', size: 72, weight: 600 }, { text: 'Draw the shape on it and say what it is: the strokes become the parts.', size: 44, color: gray }], 3.5);
// A detailed model opened (a sample model: the sword, else the helmet), parts
// drawn on it and said: they follow the strokes. No paint: it would repaint the
// model's own textures.
const take3d = ['reshape', 'lowsword', 'sword', 'model3d'].find((n) => existsSync(join(demo, `${n}.timing.json`)))!;
if (existsSync(join(demo, `${take3d}.timing.json`))) {
  const t = timing(take3d);
  const steps = t.steps!;
  const zoom: Key[] = [{ t: 0, z: 1.08, x: 800, y: 470 }];
  const segs: Seg[] = [];
  let at = 0;
  for (const st of steps) {
    segs.push({ from: at, to: st.release + 0.1 }, { from: st.release + 0.1, to: st.done + 1.1, fast: true, wait: st.done - st.release });
    at = st.done + 1.1;
  }
  // Without a paint step the take ends on a slow turn around the new parts: keep it.
  segs.push({ from: at, to: t.paint ? Math.min(t.paint - 0.6, at + 3.2) : Math.min(dur(join(demo, `${take3d}.mp4`)), at + 3.0) });
  await clip(take3d, { real: 0, fastUntil: 0, segs, subs: speech(t), zoom, voice: { file: t.voice, at: t.voiceAt }, note: take3d === 'reshape' ? 'The model itself is reshaped: the blade follows the drawn line and arc.' : 'Strokes on a 3D model become parts that follow the drawn curve, in its low-poly style.' });
}
// A surface edit on the opened helmet: drawn and said, the result baked into its
// textures, held from that view, then turned: it stays on the surface.
if (existsSync(join(demo, 'emblem3d.timing.json'))) {
  const t = timing('emblem3d');
  const st = t.steps![0];
  const D = dur(join(demo, 'emblem3d.mp4'));
  await clip('emblem3d', { real: 0, fastUntil: 0, segs: [{ from: 0, to: st.release + 0.1 }, { from: st.release + 0.1, to: st.done + 0.6, fast: true, wait: st.done - st.release }, { from: st.done + 0.6, to: D }], subs: speech(t), zoom: [{ t: 0, z: 1.12, x: 800, y: 470 }], voice: { file: t.voice, at: t.voiceAt }, note: 'The emblem is baked into the model’s texture, so it stays from every angle.' });
  await closeUpFrames('emblem3d', st.say - 0.3, st.done + 0.9, st.done - st.release);
}
await card(
  [
    { text: 'This & That', size: 120, weight: 700, gap: 36 },
    { text: `${LINE[0]} ${LINE[1]}`, size: 46, weight: 500 },
    { text: 'Show it. Say it. Done.', size: 46, color: gray, gap: 44 },
    { text: 'Built with Meta’s Muse models', size: 38, color: gray },
    { text: 'github.com/enfp-dev-studio/this-and-that', size: 38, color: gray },
    { text: `3D sample models, CC0: ${take3d === 'lowsword' || take3d === 'reshape' ? '“Sword” by Quaternius (Poly Pizza)' : '“Antique Estoc” by Ulan Cabanilla and James Ray Cock (Poly Haven)'}; “SciFiHelmet” by Michael Pavlovic (Khronos glTF Sample Assets)`, size: 24, color: gray, gap: 28 },
  ],
  6,
);

// ---------- concat ----------

const list = join(work, 'list.txt');
writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
const joined = join(work, 'joined.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
const final = join(demo, 'this-and-that-demo.mp4');
mixSound(joined, final);
const total = dur(final);
console.log(`\n${final}: ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')} (${total.toFixed(1)} s, ${parts.length} parts)`);

// The sound over the assembled picture. The voice ~17 dB down (peaks near
// -22 dB before the final level), its synthetic edge softened (-3 dB above
// 5 kHz) and lightly compressed. Under it a soft pad made here (no music anyone
// else owns): Cmaj7 and Fmaj7 sine tones crossfading over 16 s, a slow swell,
// lowpassed with a light echo, ~-30 dB, ducked ~3 dB under the voice, faded in
// and out. Then the whole mix to -23 LUFS integrated, true peak <= -9 dB (loudnorm allows no lower; this mix lands near -11.5)
// (loudnorm, two passes), so the voice sits close to the music.
function mixSound(picture: string, out: string) {
  const T = dur(picture);
  const tone = (f: number, a = 1) => `${a}*sin(2*PI*${f}*t)+${(a * 0.18).toFixed(3)}*sin(4*PI*${f}*t)`;
  const chord = (fs: number[]) => fs.map((f) => tone(f)).join('+');
  const w = '(0.5-0.5*cos(2*PI*t/16))';
  const pad = `(1-${w})*(${chord([65.41, 130.81, 164.81, 196.0, 246.94])})+${w}*(${chord([87.31, 174.61, 220.0, 261.63, 329.63])})`;
  const graph = [
    `[0:a]volume=-17dB,treble=g=-3:f=5000,acompressor=threshold=0.03:ratio=2:attack=10:release=200:makeup=1,asplit=2[v][key]`,
    `[1:a]lowpass=f=900,aecho=0.8:0.6:120|260:0.3|0.2,aformat=channel_layouts=stereo,volume=7dB,afade=t=in:d=2.5,afade=t=out:st=${(T - 3).toFixed(2)}:d=3[bed]`,
    `[bed][key]sidechaincompress=threshold=0.008:ratio=1.6:attack=40:release=600[ducked]`,
    `[v][ducked]amix=inputs=2:normalize=0:duration=first[mix]`,
  ].join(';');
  const inputs = ['-i', picture, '-f', 'lavfi', '-i', `aevalsrc='0.035*(${pad})*(0.8+0.2*sin(2*PI*t/9))':s=48000:d=${T.toFixed(2)}`];
  // Pass 1: measure.
  const log = spawnSync('ffmpeg', ['-hide_banner', ...inputs, '-filter_complex', `${graph};[mix]loudnorm=I=-23:TP=-9:LRA=11:print_format=json[a]`, '-map', '[a]', '-f', 'null', '-']).stderr.toString();
  const m = JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1));
  // Pass 2: the measured values in, a linear gain out.
  const norm = `loudnorm=I=-23:TP=-9:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  ff([...inputs, '-filter_complex', `${graph};[mix]${norm},aresample=48000[a]`, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', out]);
  console.log(`sound: ${m.input_i} LUFS measured → -23 LUFS`);
}
