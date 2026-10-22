// UI レンダラーのビルド（ADR 0015）。src/renderer を dist/renderer へ出力し、main が登録したスキームから読み込む。
// 開発用のサーバー（HMR）は使わない。インラインのスクリプトを許す CSP と http の画面を避けるため。
// HeroUI のスタイルは Tailwind CSS v4 の Vite プラグインでビルド時に CSS ファイルへ出す（ADR 0024）。
// 実行時に style 要素を差し込まないので、CSP の style-src 'self' のままで表示できる。
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('src/renderer/', import.meta.url)),
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('dist/renderer/', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false },
    // 小さな画像・フォントを data: URI に埋め込まない（CSP の img-src・font-src は 'self' だけ）。
    assetsInlineLimit: 0,
  },
});
