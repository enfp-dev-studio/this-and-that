// Streams the mic as 16 kHz PCM to the server for realtime transcription, so
// the transcript is ready ~0.3 s after release and shows as live captions.

import { postJson } from './api';

export class LiveAsr {
  id: Promise<string | null> = postJson('/api/asr', {}).then((r) => r.asrId as string, () => null);
  private ctx = new AudioContext();
  private src: MediaStreamAudioSourceNode;
  private node: ScriptProcessorNode;
  private pending: Int16Array[] = [];
  private pendingLength = 0;
  private queue = Promise.resolve();

  constructor(stream: MediaStream, private onText: (text: string) => void) {
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
    this.pending.push(out);
    this.pendingLength += out.length;
    if (this.pendingLength >= 4000) this.flush();
  }

  private flush() {
    if (!this.pendingLength) return;
    const pcm = new Int16Array(this.pendingLength);
    let off = 0;
    for (const p of this.pending) {
      pcm.set(p, off);
      off += p.length;
    }
    this.pending = [];
    this.pendingLength = 0;
    // One request at a time keeps the chunks in order.
    this.queue = this.queue.then(async () => {
      const id = await this.id;
      if (!id) return;
      const r = await fetch(`/api/asr/${id}`, { method: 'POST', body: pcm.buffer });
      if (r.ok) this.onText((await r.json()).text);
    }).catch(() => {});
  }

  // Stop streaming; resolves to the session id once every chunk is sent.
  async stop() {
    this.node.disconnect();
    this.src.disconnect();
    this.flush();
    await this.queue;
    this.ctx.close();
    return this.id;
  }
}
