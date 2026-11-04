// Meta model calls used by This & That 3D: Muse Spark (multi-view sketch →
// part list, JSON schema answer) and Muse Voice Transcribe (realtime while
// the talk button is held, batch as the fallback).

export const BASE_URL = 'https://api.meta.ai/v1';
export const MODELS = {
  // 1.2 at minimal effort answers this in ~12 s; 1.3 thinks ~3x longer for a similar part list.
  spark: process.env.SPARK_MODEL ?? 'muse-spark-1.2',
  image: 'muse-image-1.0',
  transcribe: 'muse-voice-transcribe-1.0',
};

const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error('MODEL_API_KEY is missing: put it in .env');

// A deadline and one retry per call, so the UI never hangs on a slow answer.
async function withRetry<R>(name: string, ms: number, f: (signal: AbortSignal) => Promise<R>): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      return await f(ac.signal);
    } catch (e: any) {
      const why = ac.signal.aborted ? `timed out after ${ms / 1000} s` : String(e?.message ?? e).slice(0, 400);
      if (attempt === 2) throw new Error(`${name} ${why}`);
      console.warn(`[${name}] ${why}; retrying once`);
      await new Promise((r) => setTimeout(r, 600));
    } finally {
      clearTimeout(timer);
    }
  }
}

export type Usage = Record<string, unknown> | undefined;

export async function sparkJson<T>(opts: { system: string; content: any[]; schema: object; effort?: string; timeoutMs?: number }): Promise<{ answer: T; usage: Usage }> {
  const body = {
    model: MODELS.spark,
    ...(opts.effort ? { reasoning_effort: opts.effort } : {}),
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.content },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'Model', schema: opts.schema } },
  };
  return withRetry('spark', opts.timeoutMs ?? 45_000, async (signal) => {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json: any = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
    return { answer: JSON.parse(json.choices[0].message.content ?? '{}') as T, usage: json.usage };
  });
}

// Streaming JSON answer, hedged: `copies` identical calls race, the first to
// start writing its answer wins and the others are cancelled (Spark's thinking
// time varies 2-3x between identical calls). `onText` gets the answer so far.
export async function sparkStream(opts: { system: string; content: any[]; schema: object; effort?: string; copies?: number; timeoutMs?: number; onText?: (text: string) => void }): Promise<{ text: string; usage: Usage; firstMs: number }> {
  const body = JSON.stringify({
    model: MODELS.spark,
    ...(opts.effort ? { reasoning_effort: opts.effort } : {}),
    stream: true,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.content },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'Model', schema: opts.schema } },
  });
  const t0 = Date.now();
  const copies = opts.copies ?? 3;
  const controllers = Array.from({ length: copies }, () => new AbortController());
  const timer = setTimeout(() => controllers.forEach((c) => c.abort()), opts.timeoutMs ?? 60_000);
  let winner = -1;
  const run = async (i: number) => {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: controllers[i].signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const dec = new TextDecoder();
    let buf = '', text = '', usage: Usage, firstMs = 0;
    for await (const chunk of res.body as any) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.usage) usage = ev.usage;
        const delta = ev.choices?.[0]?.delta?.content;
        if (!delta) continue;
        if (winner === -1) {
          winner = i;
          firstMs = Date.now() - t0;
          controllers.forEach((c, j) => j !== i && c.abort());
        }
        if (winner !== i) return null;
        text += delta;
        opts.onText?.(text);
      }
    }
    return winner === i ? { text, usage, firstMs } : null;
  };
  try {
    const results = await Promise.allSettled(controllers.map((_, i) => run(i)));
    const won = results[winner]?.status === 'fulfilled' ? (results[winner] as PromiseFulfilledResult<any>).value : null;
    if (won) return won;
    const err = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    throw new Error(`spark ${err ? String(err.reason?.message ?? err.reason).slice(0, 300) : 'gave no answer'}`);
  } finally {
    clearTimeout(timer);
  }
}

export const imagePart = (dataUrl: string) => ({ type: 'image_url', image_url: { url: dataUrl } });
export const textPart = (text: string) => ({ type: 'text', text });

// Batch transcription of a 16 kHz mono WAV, Korean-biased (English still works).
export async function transcribe(wav: Buffer, keywords: string[] = []): Promise<string> {
  const request = { model: MODELS.transcribe, audioEncoding: 'WAV', languageBias: ['Korean'], ...(keywords.length ? { keywords } : {}) };
  return withRetry('transcribe', 12_000, async (signal) => {
    const form = new FormData();
    form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
    form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
    const res = await fetch(`${BASE_URL}/asr/transcribe`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, body: form, signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text).transcript ?? '';
  });
}

// Realtime transcription: PCM chunks in while talking, the final text ~0.3 s
// after the end of audio. Any failure just means the batch call takes over.
export class RealtimeAsr {
  text = '';
  private ws = new WebSocket(`wss://api.meta.ai/v1/asr/realtime`);
  private ready: Promise<void>;
  private final: Promise<string>;
  private failed = false;

  constructor(keywords: string[] = []) {
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
    const opening = setTimeout(() => fail(new Error('realtime ASR did not open')), 4000);
    this.ws.onopen = () =>
      this.ws.send(JSON.stringify({
        authorization: { accessToken: `Bearer ${apiKey}` },
        audioEncoding: 'PCM_16KHZ',
        model: MODELS.transcribe,
        mode: 'PUSH_TO_TALK',
        partialMode: 'CUMULATIVE',
        emitAudioProgress: false,
        languageBias: ['Korean'],
        ...(keywords.length ? { keywords } : {}),
      }));
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.sessionId && !msg.type) {
        clearTimeout(opening);
        ready.resolve();
      } else if (msg.type === 'transcript') {
        this.text = msg.transcript;
        if (msg.final) final.resolve(msg.transcript);
      } else if (msg.type === 'error') fail(new Error(msg.message));
    };
    this.ws.onclose = (ev) => fail(new Error(`realtime ASR closed ${ev.code}`));
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
