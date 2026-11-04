// Hold-to-talk: streams the mic as 16 kHz PCM for realtime Voice Transcribe
// (live caption, through the Worker), and keeps the PCM so that on release
// the same audio can be transcribed in one batch if the realtime final is late.

import { RealtimeAsr, transcribe } from '../runtime/meta';
import { toWav } from '../runtime/render';
import { concat } from '../editor/live-asr';

// Words Voice Transcribe should listen for.
const KEYWORDS = ['의자', '등받이', '다리', '좌석', '집', '지붕', '창문', '문', '굴뚝', '테이블', '손잡이', '컵', '나무', '높게', '길게'];

export class Voice {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private node: ScriptProcessorNode | null = null;
  private all: Int16Array[] = [];
  private pending: Int16Array[] = [];
  private pendingLength = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private asr: RealtimeAsr | null = null;
  recording = false;

  constructor(private onText: (text: string) => void) {}

  async start() {
    if (this.recording) return;
    this.recording = true;
    this.all = [];
    this.pending = [];
    this.pendingLength = 0;
    try {
      this.asr = new RealtimeAsr(KEYWORDS);
      this.asr.onText = (text) => this.recording && this.onText(text);
    } catch {
      this.asr = null;
    }
    this.stream ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    this.ctx ??= new AudioContext();
    await this.ctx.resume();
    if (!this.recording) return; // released while the mic was opening
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => this.recording && this.push(e.inputBuffer.getChannelData(0));
    this.src.connect(this.node);
    this.node.connect(this.ctx.destination);
  }

  private push(input: Float32Array) {
    const ratio = this.ctx!.sampleRate / 16000;
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
    const asr = this.asr;
    this.queue = this.queue.then(() => asr?.send(pcm)).catch(() => {});
  }

  // Release: the final transcript ('' if nothing was said).
  async stop(): Promise<{ text: string; via: string; ms: number }> {
    if (!this.recording) return { text: '', via: 'none', ms: 0 };
    this.recording = false;
    this.node?.disconnect();
    this.src?.disconnect();
    this.flush();
    const sent = await Promise.race([this.queue.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 3000))]);
    const asr = this.asr;
    this.asr = null;
    const t0 = Date.now();
    const text = asr && sent ? await asr.finish() : null;
    asr?.close();
    if (text) return { text, via: 'realtime', ms: Date.now() - t0 };
    const pcm = concat(this.all);
    if (pcm.length * 2 < 2000) return { text: '', via: 'none', ms: Date.now() - t0 };
    const r = await transcribe(toWav(pcm), undefined, KEYWORDS);
    return { text: r.transcript, via: 'batch', ms: Date.now() - t0 };
  }
}
