import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// dev サーバーの転送先。既定はサーバー側の既定ポートと揃える。
// 検証で別ポートに立てたいときのために PORT で上書きできる。
const SERVER_PORT = process.env.PORT || '3711';
const SERVER_ORIGIN = `http://localhost:${SERVER_PORT}`;
const SERVER_WS_ORIGIN = `ws://localhost:${SERVER_PORT}`;

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
      '/api': { target: SERVER_ORIGIN, changeOrigin: true },
      '/ws': { target: SERVER_WS_ORIGIN, ws: true },
      // VS Code タイル。HTML と WebSocket が同じ前置パスに来るので ws:true が要る
      // (サーバー側で --server-base-path を同じ値にしてある)。
      '/vscode': { target: SERVER_ORIGIN, changeOrigin: true, ws: true },
    },
  },
});
