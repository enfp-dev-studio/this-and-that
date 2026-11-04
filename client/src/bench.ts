/// <reference types="vite/client" />
// Development only (http://localhost:5191/bench.html?clips=a,b,c&runs=1):
// replays the M0 test clips through the in-browser runtime the way the client
// sends them (marks as strokes end, voice streamed for realtime transcription
// at real-time pace, release when the voice ends), like m0/bench.ts did
// against the Node server. Prints what the user waits for, each job's spans,
// and whether each mark got the instruction that was said.
// ?understand=frames uses the key-frame fallback instead of the video;
// ?speculate=0, ?instant=0 turn those off.

import { runtime } from './runtime';
import type { Stroke } from './runtime/render';

const files = import.meta.glob('../../out/m0/*.{json,wav}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const url = (name: string) => files[`../../out/m0/${name}`];

// What each mark should have been told, from the clip's speech.
const EXPECT: Record<string, RegExp[]> = {
  a: [/red/i, /remov|delet|eras/i],
  b: [/remov|delet|eras/i, /black/i, /yellow/i],
  c: [/look|turn|face/i, /.*/, /green/i],
  d: [/red/i, /bright|light/i],
  e: [/move/i, /.*/],
  f: [/big|enlarg|larg|scale/i],
};

const q = new URLSearchParams(location.search);
const clips = (q.get('clips') ?? 'a,b,c').split(',');
const runs = Number(q.get('runs') ?? 1);
const opts = {
  ...(q.get('understand') ? { understand: q.get('understand') as 'video' | 'frames' } : {}),
  speculate: q.get('speculate') === '1',
  instant: q.get('instant') !== '0',
};
const logEl = document.getElementById('log')!;
const log = (s: string) => {
  logEl.textContent += s + '\n';
  console.log(s);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const results: unknown[] = [];
(window as any).__bench = { results, done: false };

async function replay(imageId: string, strokes: Stroke[], wav: ArrayBuffer) {
  const pcm = new Int16Array(wav.slice(44)); // 16 kHz mono s16le
  const audioMs = pcm.length / 16;
  const t0 = performance.now();
  const asr = runtime.startAsr([]);
  asr.startClock(t0);
  const streamed = (async () => {
    for (let off = 0, i = 0; off < pcm.length; off += 4000, i++) { // 250 ms chunks
      await sleep(i * 250 - (performance.now() - t0));
      await asr.send(pcm.slice(off, off + 4000));
    }
  })();
  const marks = strokes.map((s) => ({ ...s, markId: crypto.randomUUID().slice(0, 8) }));
  const markCalls = marks.map(async (s) => {
    await sleep(s.points.at(-1)!.t - (performance.now() - t0));
    await runtime.mark(imageId, s.markId, { mark: s.mark, points: s.points });
  });
  await sleep(audioMs + 300 - (performance.now() - t0));
  const released = performance.now();
  await Promise.all([...markCalls, streamed]);
  const { id } = runtime.startJob({ imageId, strokes: marks, pcm, asr, opts });
  let editsAt = 0, previewAt = 0;
  for (;;) {
    const job = runtime.job(id)!;
    if (job.edits && !editsAt) editsAt = performance.now() - released;
    if (job.previewImageId && !previewAt) previewAt = performance.now() - released;
    if (job.error) throw new Error(job.error);
    if (job.stage === 'done') return { job, total: Math.round(performance.now() - released), editsAt: Math.round(editsAt), previewAt: Math.round(previewAt) };
    await sleep(100);
  }
}

const desk = await runtime.uploadImage('/desk.png');
log(`opts ${JSON.stringify(opts)}; image ${desk.imageId} ${desk.width}×${desk.height}`);
for (let run = 1; run <= runs; run++) for (const name of clips) {
  try {
    const clip = await (await fetch(url(`${name}.json`))).json();
    const wav = await (await fetch(url(`${name}.wav`))).arrayBuffer();
    const r = await replay(desk.imageId, clip.strokes, wav);
    const t: any = r.job.trace;
    const right = (EXPECT[name] ?? []).map((re, i) => re.test(r.job.edits?.find((e) => e.mark === i + 1)?.instruction ?? ''));
    const ok = right.every(Boolean);
    log(`\n${name} run ${run}: release→result ${r.total} ms, edits shown ${r.editsAt} ms, instant preview ${r.previewAt || '-'} ms, local ${JSON.stringify(r.job.localMarks ?? [])}, asr ${r.job.asrVia}, via ${r.job.via}, speculation ${r.job.speculation ?? '-'}, mapping ${ok ? 'RIGHT' : 'WRONG ' + JSON.stringify(right)}`);
    log(`  transcript: ${r.job.transcript}`);
    for (const s of [...t.spans].sort((a: any, b: any) => a.start - b.start)) log(`  ${s.name.padEnd(26)} @${String(s.start).padStart(6)} +${s.ms}`);
    for (const e of r.job.edits ?? []) log(`  ${e.mark}. ${e.target} → ${e.instruction}${e.op ? ` [${e.op} ${e.color || ''} ${e.amount ?? ''}]` : ''}`);
    const museSpan = t.spans.find((s: any) => s.name.startsWith('muse edit'));
    results.push({ clip: name, run, total: r.total, editsAt: r.editsAt, previewAt: r.previewAt, museMs: museSpan?.ms ?? null, sparkMs: t.spans.find((s: any) => s.name === 'spark')?.ms ?? null, videoMs: t.spans.find((s: any) => s.name === 'render video')?.ms ?? null, pasteMs: t.spans.find((s: any) => s.name === 'paste')?.ms ?? null, local: r.job.localMarks ?? [], via: r.job.via, asr: r.job.asrVia, mapping: ok });
    const img = new Image();
    img.src = runtime.imageUrl(r.job.resultImageId!);
    img.title = `${name} run ${run}`;
    img.style.width = '360px';
    document.getElementById('pics')!.append(img);
  } catch (e) {
    log(`\n${name} run ${run}: FAILED ${(e as Error).message}`);
    results.push({ clip: name, run, error: (e as Error).message });
  }
}
log(`\nRESULTS ${JSON.stringify(results)}`);
(window as any).__bench.done = true;
