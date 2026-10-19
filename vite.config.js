import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  publicDir: false,
  define: {
    __STATIC_HOST__: 'true',
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
