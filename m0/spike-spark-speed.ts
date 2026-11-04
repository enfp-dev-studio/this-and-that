// M2 speed spike: does a smaller or sparser drawing video make Spark faster
// without losing accuracy? Uses the transcript hint as the app does.
//
//   node --env-file=.env m0/spike-spark-speed.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transcribe } from '../server/meta.ts';
import { understandVideo } from '../server/pipeline.ts';
import { renderVideo } from '../server/render.ts';
import { Trace } from '../server/trace.ts';

const out = join(import.meta.dirname, '..', 'out', 'm0');
const image = readFileSync(join(out, 'image.png'));
const VARIANTS = [
  { side: 512, fps: 4, heard: true },
  { side: 512, fps: 4, heard: false },
];

const rows: string[] = [];
await Promise.all(['a', 'b', 'c'].map(async (name) => {
  const clip = JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8'));
  const wav = join(out, `${name}.wav`);
  const { transcript } = await transcribe(readFileSync(wav));
  await Promise.all(VARIANTS.flatMap((v) => [0, 1, 2].map(async (i) => {
    const mp4 = readFileSync(await renderVideo(image, clip.strokes, wav, join(out, `speed-${name}-${v.side}-${v.heard}-${i}.mp4`), { maxSide: v.side, fps: 8 }));
    const trace = new Trace();
    const t0 = performance.now();
    const r = await understandVideo(mp4, clip.strokes, { effort: 'minimal', transcript, trace, fps: v.fps, heard: v.heard });
    const u: any = trace.usage[0]?.usage;
    rows.push(`${name} ${v.side}px fps${v.fps} heard=${v.heard} #${i}: ${Math.round(performance.now() - t0)} ms, ${Math.round(mp4.length / 1024)} KB, prompt ${u?.prompt_tokens} completion ${u?.completion_tokens} | ${r.edits.map((e) => `${e.mark}:${e.target}→${e.instruction}`).join(' | ')}`);
  })));
}));
console.log(rows.sort().join('\n'));
