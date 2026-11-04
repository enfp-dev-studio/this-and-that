// Captures the mic as 16 kHz PCM while talking and streams it for realtime
// transcription (through the Worker), so the transcript is ready ~0.3 s after
// release and shows as live captions. The same PCM is the voice track of the
// video Spark watches, and what batch transcription falls back to.

import { runtime } from '../runtime';
import type { RealtimeAsr } from '../runtime/meta';

export class LiveAsr {
  private asr: Promise<RealtimeAsr | null>;
  private ctx = new AudioContext();
  private src: MediaStreamAudioSourceNode;
  private node: ScriptProcessorNode;
  private all: Int16Array[] = [];
  private pending: Int16Array[] = [];
  private pendingLength = 0;
  private queue = Promise.resolve();

  // `imageIds`: the picture and its references, whose part names Voice
  // Transcribe is told to listen for. `t0`: when the recording started.
  constructor(stream: MediaStream, onText: (text: string) => void, imageIds: Promise<string[]>, t0 = performance.now()) {
    this.asr = imageIds.then((ids) => {
      const asr = runtime.startAsr(ids);
      asr.startClock(t0);
      asr.onText = onText;
      return asr;
    }, () => null);
    this.src = this.ctx.createMediaStreamSource(stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => this.push(e.inputBuffer.getChannelData(0));
    this.src.connect(this.node);
    this.node.connect(this.ctx.destination); // outputs silence; needed for the callback to run
  }

  // Resample to 16 kHz (linear) and send every 250 ms.
  private push(input: Float32Array) {
    const ratio = this.ctx.sampleRate / 16000;
    const out = new Int16Array(Math.floor(input.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const x = i * ratio, i0 = Math.floor(x), f = x - i0;
      const v = input[i0] * (1 - f) + (input[Math.min(input.length - 1, i0 + 1)] ?? 0) * f;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    }
    this.all.push(out);
    this.pending.push(out);
    this.pendingLength += out.length;
    if (this.pendingLength >= 4000) this.flush();
  }

  private flush() {
    if (!this.pendingLength) return;
    const pcm = concat(this.pending);
    this.pending = [];
    this.pendingLength = 0;
    // One send at a time keeps the chunks in order.
    this.queue = this.queue.then(async () => (await this.asr)?.send(pcm)).catch(() => {});
  }

  // Stop: the whole recording as PCM, and the realtime session once every
  // chunk is sent, or null after 3 s (the recording is then transcribed in one batch).
  async stop() {
    this.node.disconnect();
    this.src.disconnect();
    this.flush();
    const sent = await Promise.race([this.queue.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 3000))]);
    this.ctx.close();
    const asr = await this.asr;
    if (!sent) asr?.close();
    return { pcm: concat(this.all), asr: sent ? asr : null };
  }

  // Throw the recording away.
  cancel() {
    this.node.disconnect();
    this.src.disconnect();
    this.ctx.close();
    this.asr.then((a) => a?.close());
  }
}

export function concat(parts: Int16Array[]) {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) out.set(p, off), (off += p.length);
  return out;
}
