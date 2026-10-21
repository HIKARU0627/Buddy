// ビルド後の UI レンダラー（dist/renderer）が CSP と画面の読み込みの規則に収まることの試験（ADR 0015・0024）。
// HeroUI・Tailwind CSS のスタイルはビルド時に CSS ファイルへ出し、インラインのスクリプト・スタイル・eval・外部の読み込みを使わない。
// `pnpm run build`（vite build）の後に実行する。
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveAppAsset } from './window-policy.js';

const rendererDir = fileURLToPath(new URL('../renderer/', import.meta.url));

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

// ビルド後の index.html（説明のコメントを除く）。
const readPage = () =>
  readFileSync(join(rendererDir, 'index.html'), 'utf8').replace(
    /<!--[\s\S]*?-->/gu,
    '',
  );

const appUrl = (path: string) =>
  `buddy://app/${relative(rendererDir, path).split(sep).join('/')}`;

test('the built renderer exists', () => {
  assert.ok(
    existsSync(join(rendererDir, 'index.html')),
    'dist/renderer/index.html がありません。先に pnpm run build を実行してください。',
  );
});

test('the built page keeps the CSP and has no inline script, style or handler', () => {
  const html = readPage();
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(
    html,
  )?.[1];
  assert.equal(
    meta,
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'",
  );
  const scripts = [
    ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu),
  ];
  assert.ok(scripts.length >= 1);
  for (const [, attributes = '', body = ''] of scripts) {
    assert.match(attributes, /\bsrc="\.\/assets\/[^"]+\.js"/u);
    assert.equal(body.trim(), '');
  }
  assert.doesNotMatch(html, /<style\b/iu);
  assert.doesNotMatch(html, /\sstyle=/iu);
  assert.doesNotMatch(html, /\son[a-z]+=/iu);
});

test('the React Aria press style is built into CSS instead of injected at run time', () => {
  // React Aria は id="react-aria-pressable-style" の要素がないと <style> を差し込み、CSP に止められる。
  const html = readPage();
  assert.match(html, /<template id="react-aria-pressable-style"><\/template>/u);
  const css = files(rendererDir)
    .filter((path) => path.endsWith('.css'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  assert.match(
    css,
    /\[data-react-aria-pressable\]\s*\{\s*touch-action:\s*pan-x pan-y pinch-zoom/u,
  );
});

test('every file the page refers to is served by the app scheme', () => {
  const html = readPage();
  const refs = [...html.matchAll(/\b(?:src|href)="([^"]+)"/gu)].map(
    (match) => match[1] ?? '',
  );
  assert.ok(refs.some((ref) => ref.endsWith('.css')));
  for (const ref of refs) {
    assert.match(ref, /^\.\/assets\/[\w.-]+$/u);
    const resolved = resolveAppAsset(
      rendererDir,
      `buddy://app/${ref.slice(2)}`,
    );
    assert.notEqual(resolved, null, ref);
    assert.ok(existsSync(resolved?.path ?? ''), ref);
  }
});

test('every built file has a type the app scheme serves', () => {
  for (const path of files(rendererDir))
    assert.notEqual(resolveAppAsset(rendererDir, appUrl(path)), null, path);
});

test('the built styles and scripts load nothing from outside and use no eval', () => {
  const built = files(rendererDir);
  const styles = built.filter((path) => path.endsWith('.css'));
  const scripts = built.filter((path) => path.endsWith('.js'));
  assert.ok(styles.length >= 1);
  assert.ok(scripts.length >= 1);
  for (const path of styles) {
    const css = readFileSync(path, 'utf8');
    // @import はビルドで一つにまとめ、外部・data: の url() を使わない（style-src・img-src・font-src は 'self'）。
    assert.doesNotMatch(css, /@import\b/u, path);
    for (const [, target = ''] of css.matchAll(
      /url\(\s*['"]?([^'")]+)['"]?\s*\)/gu,
    ))
      assert.doesNotMatch(target, /^(?:[a-z]+:|\/\/)/iu, `${path}: ${target}`);
  }
  for (const path of scripts) {
    const js = readFileSync(path, 'utf8');
    assert.doesNotMatch(js, /(?<![\w$.])eval\(/u, path);
    assert.doesNotMatch(js, /\bnew Function\(/u, path);
    assert.doesNotMatch(js, /\bimport\(\s*['"`]https?:/u, path);
  }
});
