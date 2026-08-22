import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./client/src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // noVNC 1.7 が top-level await を使うため (WebCodecs 対応検出)。noVNC の
    // 対応ブラウザー要件 (Chrome/Edge/Firefox 89+, Safari 15+) は es2022 相当。
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3711', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3711', ws: true },
    },
  },
});
