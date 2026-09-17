import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 3000,
  },
  optimizeDeps: {
    exclude: ['@xenova/transformers'],
  },
});
