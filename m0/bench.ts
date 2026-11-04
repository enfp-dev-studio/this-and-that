// Replay the M0 test clips against the running server the way the client
// does: upload the image, send each mark when its stroke ends (in real time),
// release when the voice ends. Prints what the user waits for, plus each
// job's timing and token usage.
//
//   node m0/bench.ts [a b c]       (server on :8787)
//   ONESHOT=1 node m0/bench.ts     (old flow: everything sent on release)
//   INSTANT=1 / SPECULATE=1        turn on an experiment for these jobs
//   LABEL=x                        copies each result to out/bench-runs/x-<clip>.jpg

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const out = join(import.meta.dirname, '..', 'out', 'm0');
const image = `data:image/png;base64,${readFileSync(join(import.meta.dirname, '..', 'samples', 'desk.png')).toString('base64')}`;
const clips = process.argv.slice(2).length ? process.argv.slice(2) : ['a', 'b', 'c'];
const post = async (path: string, body: unknown) => (await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const { imageId } = await post('/api/images', { image });

for (const name of clips) {
  const clip = JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8'));
  const wav = readFileSync(join(out, `${name}.wav`));
  const audio = `data:audio/wav;base64,${wav.toString('base64')}`;
  const audioMs = ((wav.length - 44) / 32000) * 1000; // 16 kHz mono 16-bit

  // Recording: each mark goes to the server when its stroke ends.
  const t0 = Date.now();
  let released = 0;
  const marksDone: number[] = [];
  const strokes = clip.strokes.map((s: any) => ({ ...s }));
  const markCalls = process.env.ONESHOT ? [] : strokes.map(async (s: any) => {
    await sleep(s.points.at(-1).t - (Date.now() - t0));
    const r = await post('/api/marks', { imageId, stroke: { mark: s.mark, points: s.points } });
    s.markId = r.markId;
    marksDone.push(Date.now());
  });
  await sleep(audioMs + 300 - (Date.now() - t0));
  released = Date.now();
  await Promise.all(markCalls);
  const masksAt = marksDone.length ? Math.max(...marksDone) - released : NaN;
  const opts = { instant: process.env.INSTANT === '1', speculate: process.env.SPECULATE === '1' };
  const { id } = await post('/api/jobs', process.env.ONESHOT ? { image, strokes, audio, opts } : { imageId, strokes, audio, opts });

  let editsAt = 0;
  let previewAt = 0;
  for (;;) {
    const job = await (await fetch(`${BASE}/api/jobs/${id}`)).json();
    if (job.error) throw new Error(job.error);
    if (job.edits && !editsAt) editsAt = Date.now() - released;
    if (job.previewImageId && !previewAt) previewAt = Date.now() - released;
    if (job.stage === 'done') break;
    await sleep(150);
  }
  const total = Date.now() - released;
  const trace = await (await fetch(`${BASE}/api/jobs/${id}/trace.json`)).json();
  const edits = await (await fetch(`${BASE}/api/jobs/${id}/edits.json`)).json();
  console.log(`\n${name} (${id}): release→result ${total} ms, masks ready ${Number.isNaN(masksAt) ? '-' : `${Math.max(0, masksAt)} ms`}, edits shown ${editsAt} ms, instant preview ${previewAt || '-'} ms, local marks ${JSON.stringify(trace.localMarks ?? [])}, speculation ${trace.speculation ?? '-'}`);
  console.log(`RESULT ${JSON.stringify({ clip: name, label: process.env.LABEL ?? '', total, editsAt, previewAt, local: trace.localMarks ?? [], speculation: trace.speculation ?? null })}`);
  if (process.env.LABEL) {
    mkdirSync(join(out, '..', 'bench-runs'), { recursive: true });
    copyFileSync(join(out, '..', 'jobs', id, 'result.jpg'), join(out, '..', 'bench-runs', `${process.env.LABEL}-${name}.jpg`));
  }
  for (const s of trace.spans.sort((a: any, b: any) => a.start - b.start)) console.log(`  ${s.name.padEnd(16)} @${String(s.start).padStart(6)} +${s.ms}`);
  for (const u of trace.usage) console.log(`  usage ${u.name}: ${JSON.stringify(u.usage)}`);
  for (const e of edits) console.log(`  ${e.mark}. ${e.target} → ${e.instruction}${e.op ? ` [${e.op} ${e.color || ''} ${e.amount ?? ''}]` : ''}`);
}
