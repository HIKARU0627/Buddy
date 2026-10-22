// UI レンダラーの文言の約束の試験（ADR 0024 の約束 1）。数と単位の間は U+00A0（折り返さない空白）にし、
// 「5 分」が行末で「5」と「分」に分かれないようにする（UI レビュー 3 回目 R2-M1）。画面のソース（試験を除く）の
// コメントを除いた部分に、「数字（または式の閉じ括弧）＋半角の空白＋単位」が残っていないことを確かめる。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const rendererDir = fileURLToPath(
  new URL('../apps/desktop/src/renderer/', import.meta.url),
);
const UNITS = ['分', '回', '桁', '件', '秒', '日', '行', '組', '台', '文字'];

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)
      ? [path]
      : [];
  });
}

// コメント（// 行・/* */・JSX の {/* */}）を除く。文字列の中の // は URL などに使っていない前提で、行の先頭だけ除く。
const withoutComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//u.test(line))
    .join('\n');

test('numbers and their units are joined by a no-break space in the renderer copy', () => {
  // JSX の文は整形で行が分かれることがあるので、改行と字下げも折り返しの候補として数える。
  const pattern = new RegExp(
    `(?:[0-9]|\\})[ \\t]*(?:\\n[ \\t]*)?[ \\t](?:${UNITS.join('|')})|(?:[0-9]|\\})\\n[ \\t]*(?:${UNITS.join('|')})`,
    'gu',
  );
  const found = [];
  for (const path of sources(rendererDir)) {
    const text = withoutComments(readFileSync(path, 'utf8'));
    for (const match of text.matchAll(pattern))
      found.push(`${path}: ${match[0].replace(/\s+/gu, ' ')}`);
  }
  assert.deepEqual(found, []);
});

test('the check itself finds a breakable space and accepts a no-break space', () => {
  const pattern = new RegExp(
    `(?:[0-9]|\\})[ \\t]*(?:\\n[ \\t]*)?[ \\t](?:${UNITS.join('|')})|(?:[0-9]|\\})\\n[ \\t]*(?:${UNITS.join('|')})`,
    'u',
  );
  assert.ok(pattern.test("'有効 5 分'"));
  assert.ok(pattern.test('`${n} 件`'));
  assert.ok(!pattern.test("'有効 5 分'"));
  assert.ok(!pattern.test('手順 1 / 4'));
  assert.ok(pattern.test('、8\n          桁すべて'));
});
