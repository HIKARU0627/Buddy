// キャンバスの 9 つの部品（UI-07、ADR 0032）の画面のソースの約束の試験。部品のソース（試験を除く）のコメントを除いた部分に、
// 次のものがないことを確かめる: 色の直接の指定（16 進・rgb・Tailwind の色名・インラインの色）、グラデーション、HTML の直接の
// 挿入、Web の保存の API、ネットワーク・外部の URL・画像・スクリプト、説明文の部品（Alert・Description・Tooltip など）と
// 説明の言い回し。色は HeroUI のトークンだけ（ライト・ダークで同じ描画）、説明は数・形・位置で伝える（本人の原則）。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const renderer = fileURLToPath(
  new URL('../apps/desktop/src/renderer/', import.meta.url),
);

const partsDir = join(renderer, 'screens/canvas/parts');
const FILES = [
  ...readdirSync(partsDir)
    .filter((name) => /\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name))
    .map((name) => join(partsDir, name)),
  join(renderer, 'screens/canvas/ItemCard.tsx'),
  join(renderer, 'components/CanvasPartIcons.tsx'),
  join(renderer, 'state/canvas-content-state.ts'),
  join(renderer, 'state/use-canvas-contents.ts'),
];

const withoutComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//u.test(line))
    .join('\n');

const code = (path) => withoutComments(readFileSync(path, 'utf8'));

const PALETTE =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';

const FORBIDDEN = [
  ['hex color', /#[0-9a-fA-F]{3,8}\b/u],
  ['css color function', /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/u],
  [
    'tailwind palette color',
    new RegExp(
      `\\b(?:bg|text|border|fill|stroke|ring|from|to|via|divide|outline|shadow|accent|caret|decoration)-(?:${PALETTE})-\\d{2,3}\\b`,
      'u',
    ),
  ],
  [
    'black / white utility',
    /\b(?:bg|text|border|fill|stroke)-(?:black|white)\b/u,
  ],
  ['gradient', /gradient|bg-linear|bg-radial|bg-conic/u],
  [
    'inline color in a style prop',
    /style=\{\{[^}]*\b(?:color|background|backgroundColor|fill|stroke|borderColor)\b/u,
  ],
  [
    'raw html',
    /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write/u,
  ],
  ['web storage', /localStorage|sessionStorage|indexedDB|document\.cookie/u],
  [
    'network or code execution',
    /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|window\.open|\beval\(|new Function|importScripts/u,
  ],
  ['external url', /["'`]https?:\/\//u],
  [
    'image or script element',
    /<(?:img|image|iframe|script|object|embed|link|foreignObject)\b/u,
  ],
  [
    'explanatory component',
    /\b(?:Alert|Description|Tooltip|Popover|InfoIcon|Modal|Toast)\b/u,
  ],
  ['explanatory sentence', /(?:です|ます|ください|しましょう)[。.]/u],
];

test('the part sources use no direct colors, gradients, raw HTML, web storage, network, external URLs or explanatory components', () => {
  assert(FILES.length >= 14, `only ${FILES.length} files`);
  const found = [];
  for (const path of FILES) {
    const text = code(path);
    for (const [name, pattern] of FORBIDDEN)
      if (pattern.test(text))
        found.push(`${path.slice(renderer.length)}: ${name}`);
  }
  assert.deepEqual(found, []);
});

test('the check itself finds each kind of violation', () => {
  const samples = {
    'hex color': 'className="text-[#ff0000]"',
    'css color function': 'fill="rgb(1, 2, 3)"',
    'tailwind palette color': 'className="bg-blue-500"',
    'black / white utility': 'className="text-white"',
    gradient: 'className="bg-gradient-to-r"',
    'inline color in a style prop': 'style={{ color: x }}',
    'raw html': 'dangerouslySetInnerHTML={{ __html: x }}',
    'web storage': 'localStorage.setItem(a, b)',
    'network or code execution': 'fetch(url)',
    'external url': "const u = 'https://example.com'",
    'image or script element': '<img src={x} />',
    'explanatory component': "import { Alert } from '@heroui/react'",
    'explanatory sentence': "const t = 'ここを押してください。'",
  };
  for (const [name, pattern] of FORBIDDEN)
    assert(pattern.test(samples[name]), name);
  assert.equal(Object.keys(samples).length, FORBIDDEN.length);
  // 許す書き方: トークンの色・url(#id) の参照・コメントの中の URL。
  const allowed = [
    'className="text-muted fill-accent stroke-separator border-l-accent bg-accent-soft"',
    'fill={`url(#${id}-hatch)`}',
  ];
  for (const sample of allowed)
    for (const [name, pattern] of FORBIDDEN)
      assert(!pattern.test(sample), `${name}: ${sample}`);
  assert.equal(
    FORBIDDEN.some(([, pattern]) =>
      pattern.test(withoutComments('// https://example.com #fff rgb(1,2,3)')),
    ),
    false,
  );
});

test('every part uses only HeroUI color tokens: the classes that name a color are token names', () => {
  // text-/bg-/fill-/stroke-/border- の後ろが色の名前のものだけを集め、HeroUI のトークン（と透明・現在の色）に限る。
  const TOKENS = new Set([
    'foreground',
    'background',
    'muted',
    'accent',
    'accent-soft',
    'accent-soft-foreground',
    'accent-foreground',
    'default',
    'default-foreground',
    'surface',
    'surface-secondary',
    'surface-foreground',
    'separator',
    'border',
    'success',
    'success-soft',
    'success-soft-foreground',
    'warning',
    'warning-soft',
    'warning-soft-foreground',
    'danger',
    'danger-soft',
    'danger-soft-foreground',
    'focus',
    'overlay',
    'transparent',
    'current',
  ]);
  const NOT_COLORS = new Set([
    // text- / border- / stroke- の色以外の値。
    'xs',
    'sm',
    'base',
    'lg',
    'xl',
    'left',
    'right',
    'center',
    'start',
    'end',
    'justify',
    'ellipsis',
    'clip',
    'wrap',
    'nowrap',
    'balance',
    'pretty',
    'top',
    'bottom',
    'x',
    'y',
    'l',
    'r',
    't',
    'b',
    'collapse',
    'separate',
    'spacing-0',
    'fixed',
    'auto',
    'none',
    'dashed',
    'dotted',
    'solid',
  ]);
  const unknown = [];
  for (const path of FILES) {
    const text = code(path);
    for (const match of text.matchAll(
      /(?:^|[\s"'`{])(?:text|bg|fill|stroke|border(?:-[lrtbxy])?|ring|divide)-([a-z][a-z0-9-]*)(?=[\s"'`}/]|$)/gu,
    )) {
      const value = match[1];
      if (value === undefined || NOT_COLORS.has(value)) continue;
      // 数の付く値（border-2・text-[...]）は色ではない。
      if (
        /^\d/u.test(value) ||
        /^[lrtbxy]-\d/u.test(value) ||
        value.startsWith('spacing')
      )
        continue;
      if (!TOKENS.has(value))
        unknown.push(`${path.slice(renderer.length)}: ${match[0].trim()}`);
    }
  }
  assert.deepEqual(unknown, []);
});
