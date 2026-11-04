// Is speculation safe to turn on? Replays clips against a running server with
// SPECULATE on, the way the client sends them (marks as strokes end, voice
// streamed for realtime transcription with the picture's part names as
// keywords), and counts a run right only when the server took the
// speculative edit AND the transcript it was built from matches what was said.
//
//   node --env-file=.env scripts/bench-spec.ts [clip …]     (server on BASE, default :8787)
//   SPECULATE=0     the same replay with speculation off, for timing
//   KEYWORDS=0      no image ids to /api/asr (no part-name keywords)
//   RUNS=n          repeat
//
// Clips: m0 a–f (desk) and part-word clips on our illustrations, built once
// into out/spec-clips with `say -v Yuna`.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClip, locate, type Segment } from '../m0/clipkit.ts';
import type { Stroke } from '../server/render.ts';
import { imageIdOf, replay } from './replay.ts';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const root = join(import.meta.dirname, '..');
const clipDir = join(root, 'out', 'spec-clips');
mkdirSync(clipDir, { recursive: true });

type PartClip = { image: string; segments: (Omit<Segment, 'box'> & { object: string })[] };
const PART_CLIPS: Record<string, PartClip> = {
  brooch: { image: 'illust/armor.jpg', segments: [
    { say: '이 브로치는 빨간색으로 바꾸고,', object: 'jewel brooch', shape: 'circle' },
    { say: '저 망토는 초록색으로 바꿔 줘.', object: 'blue cape', shape: 'circle' },
  ] },
  pin: { image: 'illust/armor.jpg', segments: [
    { say: '이 머리핀은 지워 줘,', object: 'hairpin', shape: 'circle' },
    { say: '이 어깨갑주는 금색으로 바꿔 줘.', object: 'pauldron', shape: 'circle' },
  ] },
  cameo: { image: 'illust/gothic.jpg', segments: [
    { say: '이 카메오 브로치는 지워 주고,', object: 'cameo brooch', shape: 'circle' },
    { say: '저 진주 목걸이는 금색으로 바꿔 줘.', object: 'pearl necklace', shape: 'scribble' },
  ] },
  parasol: { image: 'illust/gothic.jpg', segments: [
    { say: '이 장미 헤어밴드는 파란색으로 바꾸고,', object: 'rose headband', shape: 'circle' },
    { say: '저 레이스 양산은 지워 줘.', object: 'lace parasol', shape: 'circle' },
  ] },
  sword: { image: 'illust/armor.jpg', segments: [
    { say: '이 장갑은 금색으로 바꾸고,', object: 'gloved hand', shape: 'circle' },
    { say: '저 칼은 지워 줘.', object: 'sword', shape: 'scribble' },
  ] },
  star: { image: 'illust/armor.jpg', segments: [
    { say: '이 별 장식은 지워 주고,', object: 'star hair ornament', shape: 'circle' },
    { say: '저 스테인드글라스는 빨간색으로 바꿔 줘.', object: 'stained glass window', shape: 'circle' },
  ] },
};

type Clip = { image: string; strokes: Stroke[]; wav: string; said: string };
async function loadClip(name: string): Promise<Clip> {
  if (!PART_CLIPS[name]) {
    const c = JSON.parse(readFileSync(join(root, 'out', 'm0', `${name}.json`), 'utf8'));
    return { image: join(root, 'samples', 'desk.png'), strokes: c.strokes, wav: join(root, 'out', 'm0', `${name}.wav`), said: c.speech.map((s: any) => s.say).join(' ') };
  }
  const spec = PART_CLIPS[name];
  const image = join(root, 'samples', spec.image);
  if (!existsSync(join(clipDir, `${name}.json`))) {
    const boxes = await locate(readFileSync(image), spec.segments.map((s) => s.object));
    await buildClip(clipDir, name, readFileSync(image), spec.segments.map((s) => ({ say: s.say, shape: s.shape, box: boxes.get(s.object)! })));
  }
  const c = JSON.parse(readFileSync(join(clipDir, `${name}.json`), 'utf8'));
  return { image, strokes: c.strokes, wav: join(clipDir, `${name}.wav`), said: c.speech.map((s: any) => s.say).join(' ') };
}

// Character error rate, ignoring spaces and punctuation.
function cer(said: string, heard: string) {
  const norm = (s: string) => s.replace(/[\s.,!?]/g, '');
  const a = norm(said), b = norm(heard);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] / Math.max(1, a.length);
}

const speculate = process.env.SPECULATE !== '0';
const keywords = process.env.KEYWORDS !== '0';
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['a', 'b', 'c', 'd', 'e', 'f', ...Object.keys(PART_CLIPS)];
let right = 0, runs = 0;
for (let run = 1; run <= Number(process.env.RUNS ?? 1); run++) for (const name of names) {
  const clip = await loadClip(name);
  const r = await replay(BASE, await imageIdOf(BASE, clip.image), clip.strokes, clip.wav, { speculate, keywords });
  const trace = r.job.error ? {} : await (await fetch(`${BASE}/api/jobs/${r.id}/trace.json`)).json();
  const heard = r.job.transcript ?? '';
  const e = cer(clip.said, heard);
  const ok = !r.job.error && trace.speculation === 'right' && e <= 0.1;
  runs++;
  if (ok) right++;
  console.log(`RESULT ${JSON.stringify({ clip: name, run, speculate, keywords, total: r.total, speculation: trace.speculation ?? null, asr: trace.asr ?? null, cer: Number(e.toFixed(3)), ok, error: r.job.error ?? null })}`);
  console.log(`  said:  ${clip.said}\n  heard: ${heard}`);
  for (const ed of r.job.edits ?? []) console.log(`  ${ed.mark}. ${ed.target} → ${ed.instruction}`);
}
if (speculate) console.log(`\nspeculation right (taken, and heard as said): ${right}/${runs}`);
