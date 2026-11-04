// M0 risk spike, step 2: does Spark map each spoken instruction to the right mark?
//   (a) video with voice → Spark (1.3 and 1.2)
//   (b) fallback: Voice Transcribe turns + guide image → Spark
//
//   node --env-file=.env m0/spike-understand.ts [a b c]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transcribe } from '../server/meta.ts';
import { understandTranscript, understandVideo } from '../server/pipeline.ts';

const out = join(import.meta.dirname, '..', 'out', 'm0');
const clips = process.argv.slice(2).length ? process.argv.slice(2) : ['a', 'b', 'c'];

const timed = async <T>(label: string, f: () => Promise<T>) => {
  const t0 = performance.now();
  try {
    const r = await f();
    return { label, ms: Math.round(performance.now() - t0), r };
  } catch (e: any) {
    return { label, ms: Math.round(performance.now() - t0), error: e.message };
  }
};

const results: any[] = [];
await Promise.all(clips.map(async (name) => {
  const clip = JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8'));
  const mp4 = readFileSync(join(out, `${name}.mp4`));
  const guide = readFileSync(join(out, `${name}-guide.png`));
  const fast = process.env.FAST;
  const hybrid = async () => {
    const t0 = performance.now();
    const asr = await transcribe(readFileSync(join(out, `${name}.wav`)));
    const asrMs = Math.round(performance.now() - t0);
    const r = await understandVideo(mp4, clip.strokes, { model: 'muse-spark-1.3', effort: 'minimal', transcript: asr.transcript });
    return { ...r, asr, asrMs };
  };
  const runs = await Promise.all(process.env.HYBRID ? [
    timed('asr → spark-1.3 minimal #1', hybrid),
    timed('asr → spark-1.3 minimal #2', hybrid),
    timed('spark-1.3 minimal #2', () => understandVideo(mp4, clip.strokes, { model: 'muse-spark-1.3', effort: 'minimal' })),
  ] : fast ? [
    timed('spark-1.3 minimal', () => understandVideo(mp4, clip.strokes, { model: 'muse-spark-1.3', effort: 'minimal' })),
    timed('spark-1.3 low', () => understandVideo(mp4, clip.strokes, { model: 'muse-spark-1.3', effort: 'low' })),
    timed('spark-1.2 #2', () => understandVideo(mp4, clip.strokes, { model: 'muse-spark-1.2' })),
    timed('spark-1.2 minimal', () => understandVideo(mp4, clip.strokes, { model: 'muse-spark-1.2', effort: 'minimal' })),
  ] : [
    timed('spark-1.3 video', () => understandVideo(mp4, clip.strokes, { model: 'muse-spark-1.3' })),
    timed('spark-1.2 video', () => understandVideo(mp4, clip.strokes, { model: 'muse-spark-1.2' })),
    timed('spark-1.3 video+times', () => understandVideo(mp4, clip.strokes, { model: 'muse-spark-1.3', withTimes: true })),
    timed('transcribe → spark-1.3', async () => {
      const t0 = performance.now();
      const asr = await transcribe(readFileSync(join(out, `${name}.wav`)));
      const asrMs = Math.round(performance.now() - t0);
      const r = await understandTranscript(guide, clip.strokes, asr.turns, { model: 'muse-spark-1.3' });
      return { ...r, asr, asrMs };
    }),
  ]);
  results.push({ clip: name, speech: clip.speech, runs });
}));

results.sort((a, b) => a.clip.localeCompare(b.clip));
writeFileSync(join(out, process.env.HYBRID ? 'understand-hybrid.json' : process.env.FAST ? 'understand-fast.json' : 'understand.json'), JSON.stringify(results, null, 2));
for (const c of results) {
  console.log(`\n=== clip ${c.clip}: ${c.speech.map((s: any) => s.expect).join(' | ')}`);
  for (const run of c.runs) {
    if (run.error) { console.log(`  ✗ ${run.label} ${run.ms} ms: ${run.error}`); continue; }
    console.log(`  ${run.label} ${run.ms} ms${run.r.asrMs ? ` (asr ${run.r.asrMs} ms, turns ${JSON.stringify(run.r.asr.turns.map((t: any) => [t.startMs, t.endMs, t.transcript]))})` : ''} heard "${run.r.transcript}"`);
    for (const e of run.r.edits) console.log(`    ${e.mark}: [${e.heard}] ${e.target} → ${e.instruction}`);
  }
}
