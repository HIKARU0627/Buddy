// UI レンダラーのビルド（ADR 0015）。src/renderer を dist/renderer へ出力し、main が登録したスキームから読み込む。
// 開発用のサーバー（HMR）は使わない。インラインのスクリプトを許す CSP と http の画面を避けるため。
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('src/renderer/', import.meta.url)),
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('dist/renderer/', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
});
