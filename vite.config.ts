import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Local development: the dev proxy adds the passcode from worker/.dev.vars,
// so the app doesn't ask for it (VITE_ASK_PASSCODE=1 to see the prompt).
const devVars = fileURLToPath(new URL('./worker/.dev.vars', import.meta.url));
const devPasscode = !process.env.VITE_ASK_PASSCODE && existsSync(devVars) ? /^DEMO_PASSCODE=(.*)$/m.exec(readFileSync(devVars, 'utf8'))?.[1]?.trim() : undefined;

export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./client/src', import.meta.url)) } },
  // Our own sample pictures ship as static files (/desk.png, /illust/…, /tasks/…).
  publicDir: fileURLToPath(new URL('./samples', import.meta.url)),
  build: { outDir: '../dist', emptyOutDir: true },
  // The pixels worker (instant edits, paste-back) is an ES module.
  worker: { format: 'es' },
  // The browser does the work; /api/meta goes to the Worker proxy (`wrangler dev`).
  server: { port: 5191, strictPort: true, proxy: { '/api/meta': { target: 'http://localhost:8801', ws: true, ...(devPasscode ? { headers: { 'x-demo-passcode': devPasscode } } : {}) } } },
});
