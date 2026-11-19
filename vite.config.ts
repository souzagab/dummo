import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.DUMMO_BASE ?? '/dummo/',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
});
