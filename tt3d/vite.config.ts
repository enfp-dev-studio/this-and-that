import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 5185, strictPort: true, host: true, proxy: { '/api': 'http://localhost:8795' } },
});
