// Replay a clip against a running server the way the client sends it: marks
// as strokes end (SAM starts), voice streamed for realtime transcription with
// the picture's part names as keywords, release when the voice ends.

import { readFileSync } from 'node:fs';
import type { Stroke } from '../server/render.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export const post = async (base: string, path: string, body: unknown) =>
  (await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

// Upload once per picture and wait for its part names, as after a few seconds in the app.
const imageIds = new Map<string, string>();
export async function imageIdOf(base: string, path: string) {
  const key = `${base} ${path}`;
  if (!imageIds.has(key)) {
    const { imageId } = await post(base, '/api/images', { image: `data:image/png;base64,${readFileSync(path).toString('base64')}` });
    await (await fetch(`${base}/api/images/${imageId}/parts`)).json();
    imageIds.set(key, imageId);
  }
  return imageIds.get(key)!;
}

export async function replay(base: string, imageId: string, strokes: Stroke[], wavPath: string, opts: { speculate?: boolean; keywords?: boolean } = {}) {
  const wav = readFileSync(wavPath);
  const pcm = wav.subarray(44); // 16 kHz mono s16le
  const audioMs = (pcm.length / 32000) * 1000;
  const t0 = Date.now();
  const asrId = (await post(base, '/api/asr', opts.keywords === false ? {} : { imageIds: [imageId] })).asrId;
  const streamed = (async () => {
    for (let off = 0, i = 0; off < pcm.length; off += 8000, i++) {
      await sleep(i * 250 - (Date.now() - t0));
      await fetch(`${base}/api/asr/${asrId}`, { method: 'POST', body: pcm.subarray(off, off + 8000) });
    }
  })();
  const marks = strokes.map((s) => ({ ...s, markId: '' }));
  const markCalls = marks.map(async (s) => {
    await sleep(s.points.at(-1)!.t - (Date.now() - t0));
    s.markId = (await post(base, '/api/marks', { imageId, stroke: { mark: s.mark, points: s.points } })).markId;
  });
  await sleep(audioMs + 300 - (Date.now() - t0));
  const released = Date.now();
  await Promise.all([...markCalls, streamed]);
  const { id } = await post(base, '/api/jobs', { imageId, strokes: marks, audio: `data:audio/wav;base64,${wav.toString('base64')}`, asrId, opts: { instant: true, ...(opts.speculate === undefined ? {} : { speculate: opts.speculate }) } });
  let job: any;
  for (;;) {
    job = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (job.error || job.stage === 'done') break;
    await sleep(150);
  }
  return { id, job, total: Date.now() - released };
}
