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
    // Keep ort-web out of Vite prebundle — registerBackend breaks under deps optimizer.
    exclude: ['@xenova/transformers', 'onnxruntime-web'],
  },
  worker: {
    format: 'es',
  },
});
