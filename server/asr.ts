// Realtime transcription while the user is still talking: the client streams
// 16 kHz PCM here, we relay it to Muse Voice Transcribe's realtime endpoint,
// and on release the final transcript is ready ~0.3 s after the audio ends
// (the batch endpoint needs 1-2.5 s after release).

import { MODELS } from './meta.ts';

export class RealtimeAsr {
  text = ''; // latest (cumulative) transcript
  private ws: WebSocket;
  private ready: Promise<void>;
  private final: Promise<string>;
  private failed = false;

  constructor() {
    this.ws = new WebSocket('wss://api.meta.ai/v1/asr/realtime');
    const ready = Promise.withResolvers<void>();
    const final = Promise.withResolvers<string>();
    this.ready = ready.promise;
    this.final = final.promise;
    this.ready.catch(() => {});
    this.final.catch(() => {});
    const fail = (e: Error) => {
      this.failed = true;
      ready.reject(e);
      final.reject(e);
    };
    this.ws.onopen = () =>
      this.ws.send(JSON.stringify({
        // The key travels in the handshake, not in a header.
        authorization: { accessToken: `Bearer ${process.env.MODEL_API_KEY}` },
        audioEncoding: 'PCM_16KHZ',
        model: MODELS.transcribe,
        mode: 'PUSH_TO_TALK',
        partialMode: 'CUMULATIVE',
        emitAudioProgress: false,
        languageBias: ['Korean'],
      }));
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.sessionId && !msg.type) ready.resolve();
      else if (msg.type === 'transcript') {
        this.text = msg.transcript;
        if (msg.final) final.resolve(msg.transcript);
      } else if (msg.type === 'error') fail(new Error(msg.message));
    };
    this.ws.onclose = (ev) => fail(new Error(`realtime ASR closed ${ev.code} ${ev.reason}`));
    this.ws.onerror = () => fail(new Error('realtime ASR socket error'));
  }

  async send(pcm: Buffer) {
    if (this.failed) return;
    try {
      await this.ready;
      this.ws.send(pcm);
    } catch {
      this.failed = true;
    }
  }

  // End of audio: the final transcript, or null if it doesn't come in time.
  async finish(timeoutMs = 2000): Promise<string | null> {
    if (this.failed) return null;
    try {
      await this.ready;
      this.ws.send(JSON.stringify({ type: 'endStream' }));
      return await Promise.race([this.final, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    } catch {
      return null;
    }
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}
