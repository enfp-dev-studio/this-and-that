// Demo footage for DEMO.md: each scene recorded as its own screen-only clip
// (captions are added in editing) into out/demo/<scene>.mp4. Drives the real
// app on BASE (default :8787; dark theme, no ?lab) in Chrome via Playwright:
// pen events at a human pace (the strokes are what you see), a synthetic
// English voice (say -v Samantha; VOICE= picks another) fed to the app as its
// microphone and written beside each clip for the edit, a small dot
// following the pen, and the screen recorded with Chrome's screencast, then
// encoded with ffmpeg at 30 fps. Waits are kept in full (sped up in editing).
//
//   node --env-file=.env scripts/capture-demo.ts [scene …]
//   scenes: hook macaron handle stripes three hold helmet (default), also heart coffee move chair brooch cuff; hold follows three
//   Each take also writes out/demo/<scene>.timing.json (when its voice starts, the
//   request goes out and the result comes back, and what is said when) for edit-demo.ts.
//   HEADED=1 shows the browser window.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type CDPSession, type Page } from 'playwright-core';
import { locate, strokePoints } from '../m0/clipkit.ts';
import { audioDurationMs, type Point, type Stroke } from '../server/render.ts';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const W = 1600, H = 1000;
const root = join(import.meta.dirname, '..');
const out = join(root, 'out', 'demo');
const clipDir = join(out, 'clips');
mkdirSync(clipDir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const VOICE = process.env.VOICE ?? 'Samantha';
const log = (...a: unknown[]) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a);

// ---------- the scenes ----------

// `path`: a contour's points (picture px), drawn in order (default: SPIKES).
type Mark = { say: string; object?: string; box?: number[]; shape: 'circle' | 'tap' | 'contour' | 'arrow' | 'scribble'; to?: [number, number]; path?: number[][]; on?: 'ref' };
type Scene = { image: string; ref?: string; marks: Mark[] };
const sample = (p: string) => join(root, 'samples', p);

// The pauldron's new outline (as in scripts/bench-sketch.ts): three spikes over the old dome.
const SPIKES = [[280, 640], [330, 470], [380, 560], [430, 395], [480, 530], [530, 440], [575, 600]];

// Closed outlines for detail edits (picture px), and the box around one.
const teardrop = (cx: number, cy: number, r: number) => Array.from({ length: 25 }, (_, i) => { const t = (2 * Math.PI * i) / 24; return [Math.round(cx + r * 0.78 * Math.sin(t) * Math.sin(t / 2)), Math.round(cy - r * Math.cos(t))]; });
const star = (cx: number, cy: number, R: number, r: number) => Array.from({ length: 11 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 5, k = i % 2 ? r : R; return [Math.round(cx + k * Math.cos(a)), Math.round(cy + k * Math.sin(a))]; });
const crescent = (cx: number, cy: number, R: number) => {
  const deg = (d: number) => (d * Math.PI) / 180;
  const outer = Array.from({ length: 14 }, (_, i) => deg(50 + (260 * i) / 13)).map((a) => [cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  const inner = Array.from({ length: 12 }, (_, i) => deg(284 - (208 * i) / 11)).map((a) => [cx + 0.45 * R + 0.793 * R * Math.cos(a), cy + 0.793 * R * Math.sin(a)]);
  return [...outer, ...inner].map(([x, y]) => [Math.round(x), Math.round(y)]);
};
const heart = (cx: number, cy: number, k: number) => Array.from({ length: 29 }, (_, i) => { const t = Math.PI + (2 * Math.PI * i) / 28; return [Math.round(cx + k * 16 * Math.sin(t) ** 3), Math.round(cy - k * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)))]; });
const outlined = (path: number[][]) => ({ path, box: [Math.min(...path.map((p) => p[0])), Math.min(...path.map((p) => p[1])), Math.max(...path.map((p) => p[0])), Math.max(...path.map((p) => p[1]))] });

// One line per mark, said while it is drawn ("this" at the moment of the stroke).
const SCENES: Record<string, Scene> = {
  hook: { image: sample('illust/armor.jpg'), marks: [{ say: 'Make this pauldron spiky, like this.', shape: 'contour', box: [280, 395, 575, 640] }] },
  macaron: { image: join(root, 'out', 'bench-hard', 'grid', 'original.png'), marks: [{ say: 'Make this one chocolate.', shape: 'tap', box: [1140, 668, 1305, 885] }] },
  brooch: {
    image: sample('illust/armor.jpg'),
    ref: sample('tasks/ref-rose-brooch.jpg'),
    marks: [
      { say: 'Change this brooch', object: 'the jewel brooch at her collar', shape: 'circle' },
      { say: 'to look like that.', object: 'the rose brooch ornament', shape: 'circle', on: 'ref' },
    ],
  },
  cuff: {
    image: sample('tasks/gothic-cuff.jpg'),
    marks: [
      { say: 'Make this lace', object: 'the sleeve cuff with a plain zigzag trim at the lower right', shape: 'circle' },
      { say: 'match that one.', object: 'the sleeve cuff with white rose lace near her chin', shape: 'circle' },
    ],
  },
  three: {
    image: sample('illust/keyvisual.jpg'),
    marks: [
      // Naming it: the synthetic "Remove this" / "Erase this" were heard as "move this" / "this".
      { say: 'Remove this phone,', object: 'the smartphone in her hand', shape: 'circle' },
      // The jacket's body, short of the backpack beside her (SAM then gets all of it, not a patch).
      { say: 'make this red,', box: [1060, 650, 1620, 1260], shape: 'circle' },
      { say: 'and add a little star here.', box: [170, 100, 290, 220], shape: 'circle' },
    ],
  },
  // Detail edits whose stroke is the shape and the place: a teardrop gem, a
// star hairpin, a crescent engraved on the breastplate (picture px).
  gem: { image: sample('illust/armor.jpg'), marks: [{ say: 'Make this gem this shape.', shape: 'contour', ...outlined(teardrop(740, 600, 48)) }] },
  hairpin: { image: sample('illust/gothic.jpg'), marks: [{ say: 'Turn this hairpin into this shape.', shape: 'contour', ...outlined(star(363, 543, 66, 28)) }] },
  cameo: { image: sample('illust/gothic.jpg'), marks: [{ say: 'Make this cameo this shape.', shape: 'contour', ...outlined(heart(721, 992, 3.6)) }] },
  clip: { image: sample('illust/armor.jpg'), marks: [{ say: 'Make this hair clip this shape.', shape: 'contour', ...outlined(crescent(576, 232, 34)) }] },
  emblem: { image: sample('illust/armor.jpg'), marks: [{ say: 'Engrave this crescent emblem here.', shape: 'contour', ...outlined(crescent(730, 750, 58)) }] },
  // Drawing-driven edits on the desk: a new handle's shape, a level, where the stripes go.
  handle: { image: sample('desk.png'), marks: [{ say: 'Make the handle this shape.', shape: 'contour', box: [1128, 880, 1252, 1012], path: [[1130, 882], [1250, 882], [1250, 1010], [1130, 1010]] }] },
  coffee: { image: sample('desk.png'), marks: [{ say: 'Fill the coffee up to here.', shape: 'contour', box: [915, 840, 1120, 850], path: [[915, 845], [1118, 845]] }] },
  heart: { image: sample('desk.png'), marks: [{ say: 'Paint a heart like this on the mug.', shape: 'contour', box: [962, 912, 1078, 1016], path: [[1020, 1016], [1019, 1013], [1015, 1006], [1006, 995], [992, 983], [978, 970], [967, 956], [962, 941], [967, 926], [978, 916], [992, 912], [1006, 916], [1015, 925], [1019, 933], [1020, 937], [1021, 933], [1025, 925], [1034, 916], [1048, 912], [1062, 916], [1073, 926], [1078, 941], [1073, 956], [1062, 970], [1048, 983], [1034, 995], [1025, 1006], [1021, 1013], [1020, 1016]] }] },
  stripes: { image: sample('desk.png'), marks: [{ say: 'Add stripes to the cat here.', shape: 'scribble', box: [270, 650, 520, 770] }] },
  // A destination: something a selection can't say.
  move: {
    image: sample('desk.png'),
    marks: [
      { say: 'Move this cactus', box: [1450, 625, 1675, 950], shape: 'circle' },
      { say: 'over here.', box: [1450, 625, 1675, 950], shape: 'arrow', to: [1290, 1000] },
    ],
  },
};

type Spoken = { at: number; dur: number; say: string }; // seconds into the voice track
type Clip = { strokes: (Stroke & { on?: 'ref' })[]; speech: Spoken[] };

// The voice, one phrase after another (a short pause between), and each
// mark drawn while its phrase is said (like clipkit.buildClip, with VOICE).
// Writes clips/<name>.wav (44.1 kHz mono): the app's microphone and the edit's sound.
async function voiceClip(name: string, image: Buffer, marks: { say: string; box: number[]; shape?: Mark['shape']; to?: [number, number] }[]) {
  const { width: W, height: H } = await (await import('sharp')).default(image).metadata();
  const parts: { file: string; at: number }[] = [];
  const strokes: Stroke[] = [];
  const speech: Spoken[] = [];
  let at = 400;
  for (const [i, m] of marks.entries()) {
    const aiff = join(clipDir, `${name}-${i}.aiff`);
    execFileSync('say', ['-v', VOICE, '-o', aiff, m.say]);
    const d = await audioDurationMs(aiff);
    parts.push({ file: aiff, at });
    speech.push({ at: at / 1000, dur: d / 1000, say: m.say });
    strokes.push({ mark: i + 1, points: strokePoints(m.box, m.shape === 'arrow' || m.shape === 'scribble' ? m.shape : 'circle', at + 100, at + Math.max(1300, d), W!, H!, m.to) });
    at += Math.max(d, 1300) + 350;
  }
  const inputs = parts.flatMap((p) => ['-i', p.file]);
  const filter = parts.map((p, i) => `[${i}:a]adelay=${p.at}|${p.at}[a${i}]`).join(';') + ';' + parts.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${parts.length}:normalize=0[o]`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[o]', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', join(clipDir, `${name}.wav`)]);
  return { strokes, speech };
}

// Boxes of the named things (Spark, cached), then the voice and the timed strokes.
async function prepare(name: string, scene: Scene): Promise<Clip> {
  const json = join(clipDir, `${name}.json`);
  if (existsSync(json)) return JSON.parse(readFileSync(json, 'utf8')) as Clip;
  const boxes = new Map<string, number[]>();
  for (const [img, marks] of [[scene.image, scene.marks.filter((m) => !m.on)], [scene.ref, scene.marks.filter((m) => m.on)]] as const) {
    const names = marks.filter((m) => m.object).map((m) => m.object!);
    if (img && names.length) for (const [k, v] of await locate(readFileSync(img), names)) boxes.set(k, v);
  }
  const box = (m: Mark) => m.box ?? boxes.get(m.object!)!;
  const { strokes, speech } = await voiceClip(name, readFileSync(scene.image), scene.marks.map((m) => ({ say: m.say, box: box(m), shape: m.shape, to: m.to })));
  const shaped = strokes.map((s, i) => {
    const m = scene.marks[i];
    const [x0, y0, x1, y1] = box(m);
    const [t0, t1] = [s.points[0].t, s.points.at(-1)!.t];
    let points: Point[] = s.points;
    if (m.shape === 'tap') points = [{ x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2), t: t0 }, { x: Math.round((x0 + x1) / 2) + 1, y: Math.round((y0 + y1) / 2), t: t0 + 70 }];
    if (m.shape === 'contour') {
      const path = m.path ?? SPIKES;
      const n = 14, segs = path.length - 1, end = t1 + 900;
      points = [];
      for (let k = 0; k < segs * n; k++) {
        const [a, b] = [path[Math.floor(k / n)], path[Math.floor(k / n) + 1]], u = (k % n) / n;
        points.push({ x: Math.round(a[0] + (b[0] - a[0]) * u), y: Math.round(a[1] + (b[1] - a[1]) * u), t: Math.round(t0 + ((end - t0) * k) / (segs * n)) });
      }
      points.push({ x: path.at(-1)![0], y: path.at(-1)![1], t: end });
    }
    return { mark: s.mark, points, ...(m.on ? { on: m.on } : {}) };
  });
  writeFileSync(json, JSON.stringify({ strokes: shaped, speech }, null, 1));
  return { strokes: shaped, speech };
}

// ---------- recording: Chrome's screencast → mp4 ----------

class Recorder {
  private frames: { file: string; t: number }[] = [];
  private dir = '';
  private n = 0;
  private cdp: CDPSession;
  constructor(cdp: CDPSession) {
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', async (f: any) => {
      if (this.dir) {
        const file = join(this.dir, `${String(this.n++).padStart(6, '0')}.jpg`);
        writeFileSync(file, Buffer.from(f.data, 'base64'));
        this.frames.push({ file, t: f.metadata.timestamp });
      }
      await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
  }
  async start(name: string) {
    this.dir = join(out, `frames-${name}`);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.frames = [];
    this.n = 0;
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: W, maxHeight: H });
    log(`● rec ${name}`);
  }
  async stop(name: string) {
    await this.cdp.send('Page.stopScreencast');
    const end = Date.now() / 1000;
    const dir = this.dir;
    this.dir = '';
    if (this.frames.length < 2) throw new Error(`${name}: no frames recorded`);
    // Each frame lasts until the next one (the screencast sends frames only on change).
    const list = this.frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (this.frames[i + 1]?.t ?? end) - f.t).toFixed(3)}`).join('\n') + `\nfile '${this.frames.at(-1)!.file}'\n`;
    writeFileSync(join(dir, 'list.txt'), list);
    const mp4 = join(out, `${name}.mp4`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '18', '-movflags', '+faststart', mp4]);
    rmSync(dir, { recursive: true, force: true });
    const secs = this.frames.at(-1)!.t - this.frames[0].t;
    log(`■ ${name}.mp4 (${this.frames.length} frames, ${secs.toFixed(1)} s)`);
    return this.frames[0].t; // the clip's time zero (seconds, like Date.now() / 1000)
  }
}

// ---------- the page: fake microphone, pen dot ----------

const INIT = () => {
  // The voice clip plays into this stream; the app records it as the microphone.
  const w = window as any;
  w.__mic = () => {
    w.__ac ??= new AudioContext();
    w.__dest ??= w.__ac.createMediaStreamDestination();
    return w.__dest.stream;
  };
  navigator.mediaDevices.getUserMedia = async () => w.__mic();
  w.__play = async (b64: string, offsetMs: number) => {
    w.__mic();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const audio = await w.__ac.decodeAudioData(bytes.buffer);
    await w.__ac.resume();
    const src = w.__ac.createBufferSource();
    src.buffer = audio;
    src.connect(w.__dest);
    src.start(0, offsetMs / 1000);
    return audio.duration * 1000;
  };
  // A dot that follows the pen or mouse (screen recordings show no cursor).
  addEventListener('DOMContentLoaded', () => {
    const dot = document.createElement('div');
    Object.assign(dot.style, { position: 'fixed', left: '0', top: '0', width: '14px', height: '14px', margin: '-7px 0 0 -7px', borderRadius: '50%', border: '2px solid white', boxShadow: '0 0 0 1px rgba(0,0,0,.6), 0 2px 6px rgba(0,0,0,.4)', pointerEvents: 'none', zIndex: '2147483647', opacity: '0', transition: 'opacity .2s, background .1s' });
    document.body.appendChild(dot);
    const at = (e: PointerEvent) => {
      dot.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      dot.style.opacity = '1';
    };
    addEventListener('pointermove', at, true);
    addEventListener('pointerdown', (e) => (at(e), (dot.style.background = 'rgba(255,255,255,.85)')), true);
    addEventListener('pointerup', () => (dot.style.background = 'transparent'), true);
  });
};

// Where an image pixel is on screen: the picture (its framed box) or the open reference.
async function toScreen(page: Page, on: 'target' | 'ref', imgW: number, imgH: number) {
  return page.evaluate(([on, nw, nh]) => {
    const canvases = [...document.querySelectorAll('canvas')];
    const ring = (c: Element) => [...c.parentElement!.children].find((e) => typeof (e as HTMLElement).className === 'string' && (e as HTMLElement).className.includes('ring-1'));
    const target = canvases.find((c) => ring(c))!;
    if (on === 'target') {
      const r = ring(target)!.getBoundingClientRect();
      return { x: r.left, y: r.top, k: r.width / (nw as number) };
    }
    // The reference canvas fits its image inside --stage-padding on every side (editor/engine.ts).
    const c = canvases.find((x) => x !== target)!;
    const b = c.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stage-padding')) * parseFloat(getComputedStyle(document.documentElement).fontSize);
    const k = Math.min((b.width - 2 * pad) / (nw as number), (b.height - 2 * pad) / (nh as number));
    return { x: b.left + (b.width - (nw as number) * k) / 2, y: b.top + pad + (b.height - 2 * pad - (nh as number) * k) / 2, k };
  }, [on, imgW, imgH] as const);
}

const size = (file: string) => {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]).toString();
  return [Number(/pixelWidth: (\d+)/.exec(out)![1]), Number(/pixelHeight: (\d+)/.exec(out)![1])];
};

// ---------- 2D scenes ----------

async function openPicture(page: Page, file: string) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('input[type=file][accept="image/*"]').first().setInputFiles(file);
  await page.waitForSelector('[aria-label="Hold to talk"]');
  await sleep(17_000); // the background part names, as when someone looks at the picture first
}

async function scene2d(page: Page, cdp: CDPSession, rec: Recorder, name: string) {
  const scene = SCENES[name];
  const clip = await prepare(name, scene);
  const wav = readFileSync(join(clipDir, `${name}.wav`)).toString('base64');
  const [iw, ih] = size(scene.image);
  const [rw, rh] = scene.ref ? size(scene.ref) : [0, 0];
  await openPicture(page, scene.image);
  await rec.start(name);
  await sleep(1200);
  if (scene.ref) {
    // The reference is dropped onto the picture (it opens beside it).
    await page.evaluate(async (url) => {
      const blob = await (await fetch(url)).blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'reference.jpg', { type: blob.type }));
      const stage = [...document.querySelectorAll('canvas')].map((c) => c.parentElement!).find((p) => p.className.includes('canvas-dots'))!;
      stage.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      stage.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, `/api/samples/tasks/${scene.ref.split('/').pop()}`);
    await sleep(2000);
  }
  const target = await toScreen(page, 'target', iw, ih);
  const ref = scene.ref ? await toScreen(page, 'ref', rw, rh) : null;
  const pen = (type: string, x: number, y: number, buttons: number) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'pen' } as any);
  // Draw at the clip's timing; the voice starts with the first stroke (that is when recording starts).
  const lead = clip.strokes[0].points[0].t;
  const t0 = Date.now() - lead;
  let audioMs = 0, voiceAt = 0;
  for (const [i, s] of clip.strokes.entries()) {
    const f = s.on === 'ref' ? ref! : target;
    const P = (p: Point) => [f.x + p.x * f.k, f.y + p.y * f.k] as const;
    await sleep(s.points[0].t - (Date.now() - t0));
    await pen('mousePressed', ...P(s.points[0]), 1);
    if (i === 0) {
      voiceAt = Date.now() / 1000 - lead / 1000; // when the voice track's time zero is, had it played from its start
      audioMs = await page.evaluate(([b64, off]) => (window as any).__play(b64, off), [wav, lead] as const);
    }
    for (const p of s.points.slice(1)) {
      await sleep(p.t - (Date.now() - t0));
      await pen('mouseMoved', ...P(p), 1);
    }
    await pen('mouseReleased', ...P(s.points.at(-1)!), 0);
  }
  await sleep(audioMs + 400 - (Date.now() - t0));
  // Send: a tap on the talk button (recording began with the first stroke).
  const talk = page.locator('[aria-label="Hold to talk"]');
  const b = (await talk.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
  const t1 = Date.now();
  const releaseAt = t1 / 1000;
  const outcome = await Promise.race([
    page.waitForSelector('button:has-text("Keep")', { timeout: 150_000 }).then(() => 'result'),
    page.waitForSelector('text=That edit didn’t come through', { timeout: 150_000 }).then(() => 'failed'),
    page.waitForSelector('text=Didn’t hear anything', { timeout: 150_000 }).then(() => 'no speech'),
  ]).catch(() => 'timeout');
  const resultAt = Date.now() / 1000;
  // The result picture itself, for the acceptance check (accept-demo.ts).
  if (outcome === 'result') {
    const b64 = await page.evaluate(async () => {
      const r = (window as any).editor?.getSnapshot().result;
      if (!r) return null;
      const blob = await (await fetch(r.url)).blob();
      return new Promise<string>((done) => {
        const fr = new FileReader();
        fr.onload = () => done(String(fr.result).split(',')[1]);
        fr.readAsDataURL(blob);
      });
    });
    if (b64) writeFileSync(join(out, `${name}.result.png`), Buffer.from(b64, 'base64'));
  }
  log(`${name}: ${outcome} ${((Date.now() - t1) / 1000).toFixed(1)} s after release`);
  await sleep(3500);
  const zero = await rec.stop(name);
  writeFileSync(join(out, `${name}.timing.json`), JSON.stringify({ image: scene.image, voice: join(clipDir, `${name}.wav`), voiceAt: voiceAt - zero, release: releaseAt - zero, result: resultAt - zero, speech: clip.speech }, null, 1));
  return outcome;
}

// The before/after hold on the last result: press the picture, let go, again.
async function sceneHold(page: Page, rec: Recorder) {
  await rec.start('hold');
  const box = (await page.locator('img[alt="After"]').boundingBox())!;
  const [x, y] = [box.x + box.width * 0.55, box.y + box.height * 0.5];
  await page.mouse.move(x, y, { steps: 10 });
  for (let i = 0; i < 2; i++) {
    await sleep(1200);
    await page.mouse.down();
    await sleep(1800);
    await page.mouse.up();
  }
  await sleep(1500);
  await rec.stop('hold');
  return 'result';
}

// ---------- 3D: the chair from the front and the side, then a turn around it ----------

// The freeform take: a knight's helmet sketched front and side and named, then
// horns and wings drawn on it as guides and said, then painted. Drawn with the
// app's replay harness (drawGuides: pen events from a view; make: the words),
// the voice laid in by edit-demo.ts where each line starts.
const HELMET = {
  front: [
    [[-0.17, 0.03, 0], [-0.185, 0.2, 0], [-0.15, 0.34, 0], [-0.08, 0.42, 0], [0, 0.445, 0], [0.08, 0.42, 0], [0.15, 0.34, 0], [0.185, 0.2, 0], [0.17, 0.03, 0]],
    [[-0.13, 0.24, 0], [0.13, 0.24, 0]],
    [[0, 0.27, 0], [0, 0.08, 0]],
  ],
  side: [[[0, 0.03, 0.17], [0, 0.2, 0.19], [0, 0.33, 0.16], [0, 0.42, 0.08], [0, 0.445, 0], [0, 0.42, -0.09], [0, 0.32, -0.17], [0, 0.18, -0.2], [0, 0.03, -0.19]]],
  // Started just off the dome, so they are drawn facing the camera (not on its steep side).
  horns: [-1, 1].map((k) => [[0.17, 0.38], [0.24, 0.44], [0.31, 0.53], [0.33, 0.64], [0.29, 0.73]].map(([x, y]) => [k * x, y, 0])),
  // A bat wing from the side of the helmet, back and up: three pointed tips, scallops between.
  wings: [[[0, 0.3, -0.02], [0, 0.48, -0.12], [0, 0.66, -0.26], [0, 0.72, -0.36], [0, 0.6, -0.33], [0, 0.56, -0.44], [0, 0.46, -0.37], [0, 0.4, -0.45], [0, 0.34, -0.33], [0, 0.28, -0.2], [0, 0.27, -0.06]].map(([, y, z]) => [0.19, y, z])],
};

async function sceneHelmet(page: Page, rec: Recorder) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('[role=radio][aria-label="3D"]').click();
  await page.waitForFunction(() => !!(window as any).drawGuides && !!document.querySelector('canvas'), undefined, { timeout: 60_000 });
  // Closer than the default framing (made for a chair): the helmet and its horns fill most of the view.
  await page.evaluate(() => {
    const { stage } = window as any;
    const d = stage.camera.position.clone().sub(stage.controls.target).multiplyScalar(0.5);
    stage.controls.target.set(0, 0.36, -0.08);
    stage.camera.position.copy(stage.controls.target).add(d);
    stage.controls.update();
  });
  await sleep(1500);
  const steps = [
    { say: 'A knight’s helmet.', draw: [['front', HELMET.front], ['side', HELMET.side]] as const },
    { say: 'Add horns like this.', draw: [['front', HELMET.horns]] as const },
    { say: 'Add wings here.', draw: [['side', HELMET.wings]] as const },
  ];
  await rec.start('helmet');
  await sleep(1000);
  const voiceAt = Date.now() / 1000;
  const done: { say: number; release: number; done: number; parts: string }[] = [];
  for (const [i, st] of steps.entries()) {
    if (i) await sleep(2600); // it turns a moment
    const say = Date.now() / 1000;
    for (const [view, strokes] of st.draw) await page.evaluate(([v, s, c]) => (window as any).drawGuides(v, s, c), [view, strokes, st.say] as const);
    const release = Date.now() / 1000;
    await page.evaluate((text) => (window as any).make(text), st.say);
    const parts = await page.evaluate(() => (window as any).builder.parts.map((p: any) => `${p.name}:${p.primitive}`).join(', '));
    done.push({ say, release, done: Date.now() / 1000, parts });
    log(`helmet: "${st.say}" ${(Date.now() / 1000 - release).toFixed(1)} s → ${parts}`);
    await page.evaluate(() => (window as any).sketch.strokes.forEach((s: any) => Object.assign(s.line.material, { depthTest: false, opacity: 0.35 }, (s.line.renderOrder = 3) && {})));
  }
  await sleep(3000);
  const pb = (await page.locator('button:has-text("Paint")').boundingBox())!;
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2, { steps: 12 });
  await sleep(300);
  const paintAt = Date.now() / 1000;
  await page.mouse.down();
  await sleep(80);
  await page.mouse.up();
  await page.waitForSelector('text=Muse Image is painting', { timeout: 10_000 }).catch(() => {});
  const painted = await page.waitForSelector('text=Muse Image is painting', { state: 'detached', timeout: 120_000 }).then(() => true, () => false);
  const paintedAt = Date.now() / 1000;
  log(`helmet: painted ${painted} ${(paintedAt - paintAt).toFixed(1)} s`);
  await page.evaluate(() => Object.assign((window as any).stage.controls, { autoRotate: true, autoRotateSpeed: 1.6 }));
  await sleep(5500);
  const zero = await rec.stop('helmet');
  // The voice: each line as its drawing starts.
  const speech: Spoken[] = [];
  for (const [i, st] of steps.entries()) {
    const f = join(clipDir, `helmet-${i}.aiff`);
    execFileSync('say', ['-v', VOICE, '-o', f, st.say.replace('’', "'")]);
    speech.push({ at: done[i].say - voiceAt + 0.3, dur: (await audioDurationMs(f)) / 1000, say: st.say });
  }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...speech.flatMap((_, i) => ['-i', join(clipDir, `helmet-${i}.aiff`)]), '-filter_complex', `${speech.map((p, i) => `[${i}:a]adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)}[a${i}]`).join(';')};${speech.map((_, i) => `[a${i}]`).join('')}amix=inputs=${speech.length}:normalize=0[o]`, '-map', '[o]', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', join(clipDir, 'helmet.wav')]);
  const rel = (t: number) => t - zero;
  writeFileSync(join(out, 'helmet.timing.json'), JSON.stringify({ voice: join(clipDir, 'helmet.wav'), voiceAt: voiceAt - zero, release: rel(done[0].release), result: rel(done[0].done), steps: done.map((d) => ({ say: rel(d.say), release: rel(d.release), done: rel(d.done), parts: d.parts })), paint: rel(paintAt), painted: rel(paintedAt), speech }, null, 1));
  return painted ? 'result' : 'failed';
}

async function sceneChair(page: Page, cdp: CDPSession, rec: Recorder) {
  // 3D through the mode switch (on camera), from a fresh page.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('[role=radio][aria-label="3D"]').click();
  await page.waitForFunction(() => !!(window as any).replayChair && !!document.querySelector('canvas'), undefined, { timeout: 60_000 });
  await sleep(1500);
  // The voice for the edit: the first line while the front is drawn, the second
  // with the side (replayChair settles 0.75 s per view, ~2.9 s of front strokes).
  const lines = [{ say: 'It’s a chair.', at: 0.85 }, { say: 'The back goes like this.', at: 4.45 }];
  for (const [i, l] of lines.entries()) execFileSync('say', ['-v', VOICE, '-o', join(clipDir, `chair-${i}.aiff`), l.say.replace('’', "'")]);
  const speech: Spoken[] = [];
  for (const [i, l] of lines.entries()) speech.push({ at: l.at, dur: (await audioDurationMs(join(clipDir, `chair-${i}.aiff`))) / 1000, say: l.say });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...lines.flatMap((_, i) => ['-i', join(clipDir, `chair-${i}.aiff`)]), '-filter_complex', `${lines.map((l, i) => `[${i}:a]adelay=${Math.round(l.at * 1000)}|${Math.round(l.at * 1000)}[a${i}]`).join(';')};[a0][a1]amix=inputs=2:normalize=0[o]`, '-map', '[o]', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', join(clipDir, 'chair.wav')]);
  await rec.start('chair');
  await sleep(1000);
  const t1 = Date.now();
  const voiceAt = t1 / 1000;
  await page.evaluate(() => (window as any).replayChair('It’s a chair, the back goes like this.').then(() => ((window as any).__built = true)));
  const ok = await page.waitForFunction(() => (window as any).__built === true, undefined, { timeout: 150_000 }).then(() => true, () => false);
  const parts = await page.evaluate(() => (window as any).builder?.parts?.length ?? 0);
  log(`chair: ${ok ? `${parts} parts` : 'timeout'} ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  const builtAt = Date.now() / 1000;
  // The strokes faded over the parts, as Sketch.settle() now does (this local
  // build predates it), so the parts can be seen landing on them.
  const overParts = () => page.evaluate(() => (window as any).sketch.strokes.forEach((s: any) => Object.assign(s.line.material, { depthTest: false, opacity: 0.35 }, (s.line.renderOrder = 3) && {})));
  await overParts();
  await sleep(2500); // the model turns slowly after it is built
  // Then an edit drawn on the model and said, through the mic like a user:
  // hold Space (hold to talk), a line along each side of the seat while saying
  // "Add armrests here.", let go to send. (A tap on the talk button can read
  // as a hold when the page is busy recording, so it stops at once.)
  const edit = 'Add armrests here.';
  const editWav = join(clipDir, 'chair-edit.aiff');
  execFileSync('say', ['-v', VOICE, '-o', editWav, edit]);
  const editDur = (await audioDurationMs(editWav)) / 1000;
  await page.evaluate(() => {
    const w = window as any;
    w.stage.controls.autoRotate = false;
    w.stage.goTo('three');
    w.__before = w.builder.parts;
  });
  await sleep(900);
  const sides = await page.evaluate(() => {
    const { THREE, stage } = window as any;
    const r = stage.renderer.domElement.getBoundingClientRect();
    const at = (x: number, y: number, z: number) => {
      const v = new THREE.Vector3(x, y, z).project(stage.camera);
      return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
    };
    // From the front of the seat to the back, on its top, at each side.
    return [-0.21, 0.21].map((x) => Array.from({ length: 24 }, (_, i) => at(x, 0.47, 0.17 - (0.34 * i) / 23)));
  });
  await page.keyboard.down('Space');
  await sleep(900); // the transcription socket opens
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', editWav, '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', join(clipDir, 'chair-edit.wav')]);
  const ffwav = readFileSync(join(clipDir, 'chair-edit.wav')).toString('base64');
  const editVoiceAt = Date.now() / 1000;
  const editMs = await page.evaluate(([b64]) => (window as any).__play(b64, 0), [ffwav] as const);
  const pen = (type: string, [x, y]: number[], buttons: number) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'pen' } as any);
  for (const [k, pts] of sides.entries()) {
    await sleep(k ? 150 : 250);
    await pen('mousePressed', pts[0], 1);
    for (const q of pts.slice(1)) {
      await sleep(26);
      await pen('mouseMoved', q, 1);
    }
    await pen('mouseReleased', pts.at(-1)!, 0);
  }
  await sleep(editMs + 500 - (Date.now() - editVoiceAt * 1000));
  await page.keyboard.up('Space');
  const editRelease = Date.now() / 1000;
  const edited = await page.waitForFunction(() => (window as any).builder.parts !== (window as any).__before && (window as any).stage.controls.autoRotate, undefined, { timeout: 90_000 }).then(() => true, () => false);
  const editedAt = Date.now() / 1000;
  const after = await page.evaluate(() => (window as any).builder.parts.map((p: any) => p.name).join(', '));
  await overParts();
  log(`chair: edit ${edited} ${(editedAt - editRelease).toFixed(1)} s: ${after}`);
  await sleep(3000); // and it turns
  // Then "Paint" (Muse Image paints it from this view), and it turns again.
  const paintBtn = page.locator('button:has-text("Paint")');
  const pb = (await paintBtn.boundingBox())!;
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2, { steps: 12 });
  await sleep(300);
  const paintAt = Date.now() / 1000;
  await page.mouse.down();
  await sleep(80);
  await page.mouse.up();
  await page.waitForSelector('text=Muse Image is painting', { timeout: 10_000 }).catch(() => {});
  const painted = await page.waitForSelector('text=Muse Image is painting', { state: 'detached', timeout: 120_000 }).then(() => true, () => false);
  const paintedAt = Date.now() / 1000;
  log(`chair: painted ${painted} ${(paintedAt - paintAt).toFixed(1)} s`);
  await page.evaluate(() => Object.assign((window as any).stage.controls, { autoRotate: true, autoRotateSpeed: 1.6 }));
  await sleep(5500);
  const zero = await rec.stop('chair');
  // The take's sound for the edit: the chair lines, then the edit line where it was said.
  const editAt = editVoiceAt - voiceAt;
  speech.push({ at: editAt, dur: editDur, say: edit });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(clipDir, 'chair.wav'), '-i', editWav, '-filter_complex', `[1:a]aresample=44100,adelay=${Math.round(editAt * 1000)}|${Math.round(editAt * 1000)}[e];[0:a][e]amix=inputs=2:normalize=0:duration=longest[o]`, '-map', '[o]', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', join(clipDir, 'chair-take.wav')]);
  writeFileSync(join(out, 'chair.timing.json'), JSON.stringify({ voice: join(clipDir, 'chair-take.wav'), voiceAt: voiceAt - zero, release: 11, result: builtAt - zero, edit: { release: editRelease - zero, done: editedAt - zero, ok: edited, parts: after }, paint: paintAt - zero, painted: paintedAt - zero, speech }, null, 1));
  return ok && parts ? 'result' : 'failed';
}

// ---------- run ----------

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['hook', 'macaron', 'handle', 'stripes', 'three', 'hold', 'helmet'];
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: !process.env.HEADED,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'dark' });
await page.addInitScript(INIT);
const cdp = await page.context().newCDPSession(page);
const rec = new Recorder(cdp);
const results: Record<string, string> = {};
for (const name of wanted) {
  try {
    if (name === 'hold') results[name] = results.three === 'result' ? await sceneHold(page, rec) : 'skipped (no result from "three")';
    else if (name === 'chair') results[name] = await sceneChair(page, cdp, rec);
    else if (name === 'helmet') results[name] = await sceneHelmet(page, rec);
    else results[name] = await scene2d(page, cdp, rec, name);
  } catch (e: any) {
    results[name] = `error: ${String(e?.message ?? e).split('\n')[0]}`;
    log(`${name}:`, results[name]);
    await cdp.send('Page.stopScreencast').catch(() => {});
  }
}
await browser.close();
console.log('\nclips:', JSON.stringify(results, null, 1));
console.log(readdirSync(out).filter((f) => f.endsWith('.mp4')).map((f) => `out/demo/${f}`).join('\n'));
