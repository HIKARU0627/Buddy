// ビルド後の音声レンダラー（dist/voice）が隔離の約束に収まることの試験（B05-06、ADR 0050）。
// UI レンダラー（dist/renderer）とは別のディレクトリで、HTML と JS だけ。インラインのスクリプト・外部の読み込み・eval・
// 通信の API を持たない。`pnpm run build` の後に実行する。
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveVoiceAsset, voiceRequestAllowed } from './voice-window.js';

const voiceDir = fileURLToPath(new URL('../voice/', import.meta.url));

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

test('the built voice renderer exists apart from the UI renderer and holds only HTML and JS', () => {
  assert.ok(
    existsSync(join(voiceDir, 'voice.html')),
    'dist/voice/voice.html がありません。先に pnpm run build を実行してください。',
  );
  for (const path of files(voiceDir)) {
    assert.match(path, /\.(?:html|js)$/u, path);
    const url = `buddy-voice://renderer/${relative(voiceDir, path).split(sep).join('/')}`;
    assert.equal(voiceRequestAllowed(url), true, url);
    assert.equal(resolveVoiceAsset(voiceDir, url)?.path, path);
  }
  // UI レンダラーの入口は音声レンダラーのディレクトリにない（セッションからも読めない）。
  assert.equal(existsSync(join(voiceDir, 'index.html')), false);
});

test('the voice page keeps its CSP and loads only its own scripts', () => {
  const html = readFileSync(join(voiceDir, 'voice.html'), 'utf8');
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(
    html,
  )?.[1];
  assert.equal(
    meta,
    "default-src 'none'; script-src 'self'; style-src 'none'; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'",
  );
  const scripts = [
    ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu),
  ];
  assert.equal(scripts.length, 1);
  for (const [, attributes = '', body = ''] of scripts) {
    assert.match(attributes, /\bsrc="\.\/assets\/[\w.-]+\.js"/u);
    assert.equal(body.trim(), '');
  }
  assert.doesNotMatch(html, /<link\b|<style\b|\sstyle=|\son[a-z]+=/iu);
});

test('the voice scripts use no network, storage, eval or Node API', () => {
  for (const path of files(voiceDir).filter((file) => file.endsWith('.js'))) {
    const js = readFileSync(path, 'utf8');
    for (const banned of [
      /(?<![\w$.])eval\(/u,
      /\bnew Function\(/u,
      /\bfetch\(/u,
      /\bXMLHttpRequest\b/u,
      /\bWebSocket\b/u,
      /\bEventSource\b/u,
      /\bsendBeacon\b/u,
      /\blocalStorage\b/u,
      /\bindexedDB\b/u,
      /\bimport\(/u,
      /\brequire\(/u,
      /https?:\/\//u,
    ])
      assert.doesNotMatch(js, banned, `${path}: ${banned}`);
  }
});
