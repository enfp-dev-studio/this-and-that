// HTTP server for This & That 3D on :8795. Serves the built client from dist/
// and the API: realtime transcription relay, batch transcription fallback,
// and perception (multi-view sketch → part list with Muse Spark).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { editImage, RealtimeAsr, transcribe } from './meta.ts';
import { perceive } from './perceive.ts';

const PORT = Number(process.env.PORT ?? 8795);
const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'out', 'jobs');

// Words Voice Transcribe should listen for.
const KEYWORDS = ['의자', '등받이', '다리', '좌석', '집', '지붕', '창문', '문', '굴뚝', '테이블', '손잡이', '컵', '나무', '높게', '길게'];

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const live = new Map<string, RealtimeAsr>();
let seq = 0;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    // Open a realtime transcription when the talk button goes down.
    if (req.method === 'POST' && url.pathname === '/api/asr') {
      const id = `a${Date.now().toString(36)}${seq++}`;
      const asr = new RealtimeAsr(KEYWORDS);
      live.set(id, asr);
      setTimeout(() => (asr.close(), live.delete(id)), 90_000);
      return send(res, 200, { asrId: id });
    }
    // PCM chunk while talking → the transcript so far (live caption).
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'asr' && parts[2] && !parts[3]) {
      const asr = live.get(parts[2]);
      if (!asr) return send(res, 404, { error: 'no such transcription' });
      await asr.send(await readBody(req));
      return send(res, 200, { text: asr.text });
    }
    // Release: the realtime final text, or batch transcription of the WAV sent.
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'asr' && parts[2] && parts[3] === 'finish') {
      const wav = await readBody(req);
      const asr = live.get(parts[2]);
      live.delete(parts[2]);
      const t0 = Date.now();
      const text = asr ? await asr.finish() : null;
      asr?.close();
      if (text) return send(res, 200, { text, via: 'realtime', ms: Date.now() - t0 });
      if (wav.length < 2000) return send(res, 200, { text: '', via: 'none', ms: Date.now() - t0 });
      return send(res, 200, { text: await transcribe(wav, KEYWORDS), via: 'batch', ms: Date.now() - t0 });
    }
    if (req.method === 'POST' && url.pathname === '/api/perceive') {
      const body = JSON.parse((await readBody(req)).toString());
      const dir = join(OUT, new Date().toISOString().replace(/[:.]/g, '-'));
      mkdirSync(dir, { recursive: true });
      body.views?.forEach((v: { name: string; image: string }, i: number) => writeFileSync(join(dir, `${i}-${v.name.replace(/\W+/g, '_')}.jpg`), Buffer.from(v.image.split(',')[1], 'base64')));
      writeFileSync(join(dir, 'request.json'), JSON.stringify({ ...body, views: body.views?.map((v: any) => ({ name: v.name, note: v.note })) }, null, 1));
      // NDJSON: the sentence and each part as soon as Spark has written it, then the whole answer.
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
      try {
        const r = await perceive(body, (e) => res.write(JSON.stringify(e) + '\n'));
        writeFileSync(join(dir, 'answer.json'), JSON.stringify(r, null, 1));
        console.log(`[perceive] first ${r.firstMs} ms, done ${r.ms} ms, ${r.answer.parts?.length} parts: ${r.answer.subject} (${dir})`);
      } catch (e: any) {
        console.error('[perceive]', e);
        res.write(JSON.stringify({ type: 'error', error: String(e?.message ?? e) }) + '\n');
      }
      return res.end();
    }
    // Muse Image repaints a render of the model; the client projects it back on.
    if (req.method === 'POST' && url.pathname === '/api/paint') {
      const { image, subject, style } = JSON.parse((await readBody(req)).toString());
      const prompt = `This is a plain 3D render of a simple low-poly ${subject || 'object'} on a white background. Repaint it as a finished, stylized, hand-painted 3D game asset. This is texture painting only: the result is projected back onto the 3D model, so every edge, the silhouette, the position, the size and the camera angle must stay exactly where they are in this render, even if a shape looks odd. Only add surface materials and detail (for example wood grain, roof tiles, bricks, fabric weave), richer painted colors and soft lighting. Do not add, remove, move or reshape anything. Keep the plain white background.${style ? ` Style: ${style}.` : ''}`;
      const t0 = Date.now();
      const out = await editImage(prompt, image);
      const dir = join(OUT, `paint-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'in.jpg'), Buffer.from(image.split(',')[1], 'base64'));
      writeFileSync(join(dir, 'out.jpg'), Buffer.from(out.split(',')[1], 'base64'));
      console.log(`[paint] ${Date.now() - t0} ms (${dir})`);
      return send(res, 200, { image: out, ms: Date.now() - t0 });
    }
    // Static client.
    if (req.method === 'GET' && existsSync(DIST)) {
      const path = normalize(join(DIST, url.pathname === '/' ? 'index.html' : url.pathname));
      if (path.startsWith(DIST) && existsSync(path) && extname(path)) {
        res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
        return res.end(readFileSync(path));
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(readFileSync(join(DIST, 'index.html')));
    }
    send(res, 404, { error: 'not found' });
  } catch (e: any) {
    console.error(e);
    send(res, 500, { error: String(e?.message ?? e) });
  }
}).listen(PORT, () => console.log(`tt3d server on http://localhost:${PORT}`));
