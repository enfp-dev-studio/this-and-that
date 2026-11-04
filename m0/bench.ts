// Replay the M0 test clips against the running server the way the client
// does (marks sent as strokes end, voice streamed for realtime transcription,
// release when the voice ends). Prints what the user waits for, plus each
// job's timing and token usage.
//
//   node --env-file=.env m0/bench.ts [a b c …]      (server on :8787)
//   INSTANT=0 / REALTIME=0 / SPECULATE=1   turn an experiment off (on) for these jobs
//   LABEL=x                          copies each result to out/bench-runs/x-<clip>.jpg

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replay } from './clipkit.ts';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const out = join(import.meta.dirname, '..', 'out');
const clips = process.argv.slice(2).length ? process.argv.slice(2) : ['a', 'b', 'c'];
const image = `data:image/png;base64,${readFileSync(join(import.meta.dirname, '..', 'samples', 'desk.png')).toString('base64')}`;
const { imageId } = await (await fetch(`${BASE}/api/images`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) })).json();
const opts = { instant: process.env.INSTANT !== '0', speculate: process.env.SPECULATE === '1', realtime: process.env.REALTIME !== '0' };

for (const name of clips) {
  const clip = JSON.parse(readFileSync(join(out, 'm0', `${name}.json`), 'utf8'));
  const r = await replay(BASE, imageId, clip.strokes, join(out, 'm0', `${name}.wav`), opts);
  const trace = await (await fetch(`${BASE}/api/jobs/${r.id}/trace.json`)).json();
  console.log(`\n${name} (${r.id}): release→result ${r.total} ms, edits shown ${r.editsAt} ms, instant preview ${r.previewAt || '-'} ms, local marks ${JSON.stringify(trace.localMarks ?? [])}, speculation ${trace.speculation ?? '-'}, asr ${trace.asr}`);
  console.log(`RESULT ${JSON.stringify({ clip: name, label: process.env.LABEL ?? '', total: r.total, editsAt: r.editsAt, previewAt: r.previewAt, local: trace.localMarks ?? [], speculation: trace.speculation ?? null, asr: trace.asr })}`);
  if (process.env.LABEL) {
    mkdirSync(join(out, 'bench-runs'), { recursive: true });
    copyFileSync(join(out, 'jobs', r.id, 'result.jpg'), join(out, 'bench-runs', `${process.env.LABEL}-${name}.jpg`));
  }
  for (const s of trace.spans.sort((a: any, b: any) => a.start - b.start)) console.log(`  ${s.name.padEnd(16)} @${String(s.start).padStart(6)} +${s.ms}`);
  for (const u of trace.usage) console.log(`  usage ${u.name}: ${JSON.stringify(u.usage)}`);
  for (const e of r.job.edits) console.log(`  ${e.mark}. ${e.target} → ${e.instruction}${e.op ? ` [${e.op} ${e.color || ''} ${e.amount ?? ''}]` : ''}`);
}
