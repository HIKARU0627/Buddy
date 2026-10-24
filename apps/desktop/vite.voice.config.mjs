// 音声レンダラーのビルド（B05-06、ADR 0050）。src/voice を dist/voice へ出力し、main が音声レンダラーの専用のセッションに
// 登録したスキーム（buddy-voice://renderer/）から読み込む。UI レンダラー（dist/renderer）とは別のディレクトリに出し、
// 音声レンダラーのセッションからは UI レンダラーのファイルを読めないようにする。スタイル・画像は持たない。
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('src/voice/', import.meta.url)),
  base: './',
  build: {
    outDir: fileURLToPath(new URL('dist/voice/', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rollupOptions: { input: { voice: 'voice.html' } },
  },
});
