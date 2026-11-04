// M2 spike: realtime transcription. Stream a clip's PCM at real-time pace to
// the realtime endpoint and time how long the final transcript takes after
// the audio ends (the batch endpoint takes 1.1-2.6 s after release).
//
//   node --env-file=.env m0/spike-realtime.ts [clip]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const name = process.argv[2] ?? 'b';
const wav = readFileSync(join(import.meta.dirname, '..', 'out', 'm0', `${name}.wav`));
const pcm = wav.subarray(44); // 16 kHz mono s16le
const FRAME = 16000 * 2 * 0.08; // 80 ms

const ws = new WebSocket('wss://api.meta.ai/v1/asr/realtime');
ws.binaryType = 'arraybuffer';
const t0 = performance.now();
const at = () => `${Math.round(performance.now() - t0)} ms`;
let endedAt = 0;

ws.onopen = () => {
  ws.send(JSON.stringify({
    authorization: { accessToken: `Bearer ${process.env.MODEL_API_KEY}` },
    audioEncoding: 'PCM_16KHZ',
    model: 'muse-voice-transcribe-1.0',
    mode: 'PUSH_TO_TALK',
    partialMode: 'CUMULATIVE',
    emitAudioProgress: false,
    languageBias: ['Korean'],
  }));
};
ws.onmessage = async (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.sessionId && !msg.type) {
    console.log(`${at()} session ${msg.sessionId}, streaming ${pcm.length} bytes`);
    for (let off = 0; off < pcm.length; off += FRAME) {
      ws.send(pcm.subarray(off, off + FRAME));
      await new Promise((r) => setTimeout(r, 80));
    }
    endedAt = performance.now();
    ws.send(JSON.stringify({ type: 'endStream' }));
    console.log(`${at()} endStream`);
    return;
  }
  const after = endedAt ? ` (+${Math.round(performance.now() - endedAt)} ms after end)` : '';
  console.log(`${at()}${after} ${JSON.stringify(msg)}`);
};
ws.onclose = (ev) => console.log(`${at()} closed ${ev.code} ${ev.reason}`);
ws.onerror = (ev: any) => console.log(`${at()} error ${ev.message ?? ''}`);
