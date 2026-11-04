// Smoke test of the deployed API Worker and web app, with as few model calls
// as possible (one tiny chat completion, one realtime session that sends no
// audio, no jobs counted). The passcode, if any, is read from the git-ignored
// .deploy-notes.txt and never printed.
//
//   node scripts/smoke-cloudflare.mjs https://this-and-that-api.enfpdev.workers.dev https://this-and-that.enfpdev.workers.dev

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [worker, app] = process.argv.slice(2).map((u) => u?.replace(/\/$/, ''));
if (!worker || !app) throw new Error('usage: node scripts/smoke-cloudflare.mjs <api url> <app url>');
const notes = join(import.meta.dirname, '..', '.deploy-notes.txt');
const pass = existsSync(notes) ? (/^DEMO_PASSCODE=(.*)$/m.exec(readFileSync(notes, 'utf8'))?.[1]?.trim() ?? '') : '';
const api = `${worker}/api/meta`;
const origin = { Origin: app };
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
};

// The web app and a sample picture are static files.
const page = await fetch(`${app}/`);
check('the app is served', page.ok && (await page.text()).includes('<div id="root">'), `HTTP ${page.status}`);
const sample = await fetch(`${app}/desk.png`);
check('the samples are served', sample.ok && sample.headers.get('content-type') === 'image/png', `HTTP ${sample.status}`);

// Worker: config, CORS for the app's origin, the passcode.
const cfg = await fetch(`${api}/config`, { headers: origin });
const config = await cfg.json().catch(() => ({}));
check('Worker config', cfg.ok, `passcode ${config.passcode}, jobs ${config.jobs?.used}/${config.jobs?.cap}`);
check('CORS allows the app origin', cfg.headers.get('access-control-allow-origin') === app);
const bad = await fetch(`${api}/config`, { headers: { Origin: 'https://evil.example' } });
check('CORS refuses other origins', bad.status === 403, `HTTP ${bad.status}`);
const without = await fetch(`${api}/check`, { headers: origin });
check(config.passcode ? 'check without the passcode is refused' : 'check passes (no passcode set)', config.passcode ? without.status === 401 : without.ok, `HTTP ${without.status}`);
const headers = { ...origin, 'Content-Type': 'application/json', ...(pass ? { 'x-demo-passcode': pass } : {}) };
if (config.passcode) {
  if (!pass) check('passcode in .deploy-notes.txt', false, 'missing');
  const withPass = await fetch(`${api}/check`, { headers });
  check('check with the passcode', withPass.ok, `HTTP ${withPass.status}`);
}

// One tiny model call through the proxy (the key is the Worker's).
const t0 = Date.now();
const chat = await fetch(`${api}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'muse-spark-1.3', reasoning_effort: 'minimal', messages: [{ role: 'user', content: 'Say hi in one word' }] }) });
const answer = await chat.json().catch(() => ({}));
check('Spark through the Worker', chat.ok, `${Date.now() - t0} ms · "${answer.choices?.[0]?.message?.content ?? JSON.stringify(answer).slice(0, 120)}"`);

// The realtime transcription socket opens upstream (a sessionId comes back).
const b64 = Buffer.from(pass, 'utf8').toString('base64url');
const sessionId = await new Promise((resolve) => {
  const ws = new WebSocket(`${api.replace(/^http/, 'ws')}/asr/realtime`, pass ? [`ttpass.${b64}`] : []);
  const done = (v) => (clearTimeout(timer), ws.close(), resolve(v));
  const timer = setTimeout(() => done(null), 8000);
  ws.onopen = () => ws.send(JSON.stringify({ audioEncoding: 'PCM_16KHZ', model: 'muse-voice-transcribe-1.0', mode: 'PUSH_TO_TALK', partialMode: 'CUMULATIVE', emitAudioProgress: false, languageBias: ['Korean'] }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.sessionId) done(msg.sessionId);
  };
  ws.onerror = () => done(null);
});
check('realtime ASR socket through the Worker', !!sessionId);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
