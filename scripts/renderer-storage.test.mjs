// UI レンダラーが端末に何も保存しないことの試験（UI-06、ADR 0032 の「端末に保存してよいのは配置の設定だけ」）。
// キャンバスの本文・見出し・参照・ユーザーの置き場所は Core の RAM にだけ持ち、画面は Web の保存の API を使わない。
// 配置の設定（複数のモニターの設定）は main が保存する（apps/desktop/src/main/canvas-display.ts。保存の試験は main の試験）。
// 画面のソース（試験を除く）と、ビルドした画面（dist/renderer の JavaScript。依存のライブラリを含む）の両方を調べる。
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const rendererDir = fileURLToPath(
  new URL('../apps/desktop/src/renderer/', import.meta.url),
);
const builtDir = fileURLToPath(
  new URL('../apps/desktop/dist/renderer/', import.meta.url),
);

// Web の保存の API（手で書いた一覧）。
const STORAGE = [
  /\blocalStorage\b/u,
  /\bsessionStorage\b/u,
  /\bindexedDB\b/u,
  /document\.cookie/u,
  /\bcaches\.open\b/u,
  /navigator\.storage/u,
  /\bopenDatabase\b/u,
];

function files(directory, accept) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path, accept);
    return accept(entry.name) ? [path] : [];
  });
}

test('the renderer source never uses web storage (the canvas content stays in the core RAM)', () => {
  const sources = files(
    rendererDir,
    (name) => /\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name),
  );
  assert(sources.length > 10);
  const found = sources.flatMap((path) => {
    const text = readFileSync(path, 'utf8');
    return STORAGE.filter((pattern) => pattern.test(text)).map(
      (pattern) => `${path} ${pattern}`,
    );
  });
  assert.deepEqual(found, []);
});

test('the built renderer (with its libraries) contains no web storage call either', () => {
  assert(existsSync(builtDir), 'build the desktop renderer first');
  const bundles = files(builtDir, (name) => /\.m?js$/u.test(name));
  assert(bundles.length > 0);
  const found = bundles.flatMap((path) => {
    const text = readFileSync(path, 'utf8');
    return STORAGE.filter((pattern) => pattern.test(text)).map(
      (pattern) => `${path} ${pattern}`,
    );
  });
  assert.deepEqual(found, []);
});
