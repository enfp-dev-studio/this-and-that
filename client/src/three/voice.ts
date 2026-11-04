// Hold-to-talk: streams the mic as 16 kHz PCM to the server for realtime
// Voice Transcribe (live caption), and keeps the PCM so that on release the
// server can fall back to batch transcription of the same audio as a WAV.

export class Voice {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private node: ScriptProcessorNode | null = null;
  private all: Int16Array[] = [];
  private pending: Int16Array[] = [];
  private pendingLength = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private id: Promise<string | null> = Promise.resolve(null);
  recording = false;

  constructor(private onText: (text: string) => void) {}

  async start() {
    if (this.recording) return;
    this.recording = true;
    this.all = [];
    this.pending = [];
    this.pendingLength = 0;
    this.id = fetch('/api/3d/asr', { method: 'POST' }).then((r) => r.json()).then((j) => j.asrId as string, () => null);
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
    this.queue = this.queue.then(async () => {
      const id = await this.id;
      if (!id) return;
      const r = await fetch(`/api/3d/asr/${id}`, { method: 'POST', body: pcm.buffer as ArrayBuffer });
      if (r.ok && this.recording) this.onText((await r.json()).text);
    }).catch(() => {});
  }

  // Release: the final transcript ('' if nothing was said).
  async stop(): Promise<{ text: string; via: string; ms: number }> {
    if (!this.recording) return { text: '', via: 'none', ms: 0 };
    this.recording = false;
    this.node?.disconnect();
    this.src?.disconnect();
    this.flush();
    await Promise.race([this.queue, new Promise((r) => setTimeout(r, 3000))]);
    const id = (await this.id) ?? 'none';
    const r = await fetch(`/api/3d/asr/${id}/finish`, { method: 'POST', body: wav(concat(this.all)) });
    return r.json();
  }
}

function concat(parts: Int16Array[]) {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) out.set(p, off), (off += p.length);
  return out;
}

function wav(pcm: Int16Array) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}
