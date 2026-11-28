// UI レンダラーの形の約束の試験（ADR 0181 の段階 1）。角の丸みは 4 段（小 6px・箱 12px・島 28px・完全な丸）だけを使い、
// 動きの時間は動きを減らす設定で 0 になることを、ソース（styles.css と画面のソース）を読んで確かめる。期待値は手で書く。
// ビルドした CSS に同じ値が出ることは apps/desktop/src/main/renderer-build.test.ts が確かめる。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const rendererDir = fileURLToPath(
  new URL('../apps/desktop/src/renderer/', import.meta.url),
);
const stylesPath = join(rendererDir, 'styles.css');

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)
      ? [path]
      : [];
  });
}

// コメント（/* */・行の先頭の //）を除く。renderer-copy.test.mjs と同じ前提（文字列の中の // は行の先頭にない）。
const withoutComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//u.test(line))
    .join('\n');

const cssWithoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '');

// --- 画面のソースの検査に使う関数 ---

// 丸みのクラス（rounded・rounded-md・rounded-t-lg・rounded-[10px]・rounded-(--x)・md:rounded-lg の rounded-lg など）。
const ROUNDED_TOKEN = /(?<![\w-])rounded(?:-[^\s'"`{}]+)?(?![\w])/gu;
const ALLOWED_ROUNDED = new Set([
  'rounded-part',
  'rounded-box',
  'rounded-island',
  'rounded-full',
]);

function roundedTokensOutsideTheScale(text) {
  return [...text.matchAll(ROUNDED_TOKEN)]
    .map((match) => match[0])
    .filter((token) => !ALLOWED_ROUNDED.has(token));
}

// クラスを並べる単位（'…'・"…"・`…`）。テンプレートは中の ${…} を含めて 1 つとみなす。
const CLASS_UNIT = /'[^'\n]*'|"[^"\n]*"|`[^`]*`/gu;

// 同じファイルの `const 名前 = …;` の右辺（同じ名前が複数あればすべて）。テンプレートに埋め込んだ変数を展開するのに使う。
function constantsOf(text) {
  const table = new Map();
  for (const match of text.matchAll(/\bconst\s+(\w+)\s*=\s*([^;]+);/gu)) {
    const [, name = '', value = ''] = match;
    table.set(name, `${table.get(name) ?? ''} ${value}`);
  }
  return table;
}

// 完全な丸は高さの決まった物（円・錠剤型・細い棒）だけに使う。同じ並びに h-数・size-数（または高さを入れた変数）があること。
const FIXED_HEIGHT = /(?<![\w-])(?:h|size)-(?:\d|\[)/u;

function fullRoundsWithoutHeight(text) {
  const constants = constantsOf(text);
  const found = [];
  for (const [unit] of text.matchAll(CLASS_UNIT)) {
    if (!/(?<![\w-])rounded-full(?![\w-])/u.test(unit)) continue;
    const expanded = unit.replace(
      /\$\{\s*(\w+)\s*\}/gu,
      (_, name) => constants.get(name) ?? '',
    );
    if (!FIXED_HEIGHT.test(expanded)) found.push(unit.replace(/\s+/gu, ' '));
  }
  return found;
}

// 位置・大きさ・変形を動かすクラスの並びは、時間を --motion-* にし、動きを減らす設定で止める。
const MOVING_TRANSITION =
  /(?<![\w:-])transition(?:-\[[^\]]*\]|-transform|-all)?(?![\w-])/u;

function movingTransitionsWithoutMotionTokens(text) {
  const found = [];
  for (const [unit] of text.matchAll(CLASS_UNIT)) {
    if (!MOVING_TRANSITION.test(unit)) continue;
    if (
      !/(?<![\w-])duration-\(--motion-[a-z]+\)/u.test(unit) ||
      !/(?<![\w-])motion-reduce:transition-none(?![\w-])/u.test(unit)
    )
      found.push(unit.replace(/\s+/gu, ' '));
  }
  return found;
}

// 時間を数で書いた duration-150・duration-[200ms] と、motion-safe: のない animate-*（Spinner は HeroUI の部品の中）。
function literalDurationsAndUnsafeAnimations(text) {
  const found = [];
  for (const match of text.matchAll(
    /(?<![\w-])(?:[\w-]+:)*(?:duration|animate)-[^\s'"`{}]+/gu,
  )) {
    const token = match[0];
    if (/(?:^|:)duration-\(--motion-[a-z]+\)$/u.test(token)) continue;
    if (/^motion-safe:animate-[\w-]+$/u.test(token)) continue;
    found.push(token);
  }
  return found;
}

// --- 画面のソースの試験 ---

test('the renderer uses only the four radius steps', () => {
  const found = [];
  for (const path of sources(rendererDir)) {
    const text = withoutComments(readFileSync(path, 'utf8'));
    for (const token of roundedTokensOutsideTheScale(text))
      found.push(`${path}: ${token}`);
  }
  assert.deepEqual(found, []);
});

test('rounded-full is used only on things with a fixed height', () => {
  const found = [];
  for (const path of sources(rendererDir)) {
    const text = withoutComments(readFileSync(path, 'utf8'));
    for (const unit of fullRoundsWithoutHeight(text))
      found.push(`${path}: ${unit}`);
  }
  assert.deepEqual(found, []);
});

test('moving transitions use the motion durations and stop when motion is reduced', () => {
  const found = [];
  for (const path of sources(rendererDir)) {
    const text = withoutComments(readFileSync(path, 'utf8'));
    for (const unit of movingTransitionsWithoutMotionTokens(text))
      found.push(`${path}: ${unit}`);
    for (const token of literalDurationsAndUnsafeAnimations(text))
      found.push(`${path}: ${token}`);
  }
  assert.deepEqual(found, []);
});

test('the shared shape classes use the radius steps', () => {
  // 枠・入力欄・浮いた物の縁取りの定数（shapes.ts）。手で書いた期待値。札は HeroUI の Chip にした（段階 3）。
  const text = readFileSync(join(rendererDir, 'shapes.ts'), 'utf8');
  const value = (name) =>
    new RegExp(`export const ${name} =\\s*'([^']*)'`, 'u').exec(text)?.[1];
  assert.equal(value('FRAME_CLASS'), 'rounded-box border border-separator');
  assert.equal(
    value('FRAME_DANGER_CLASS'),
    'rounded-box border border-danger-soft-foreground',
  );
  assert.equal(
    value('FIELD_CLASS'),
    'rounded-box border border-field-border bg-transparent px-2 py-1 text-sm text-foreground',
  );
  assert.equal(value('FLOAT_OUTLINE_CLASS'), 'border-2 border-field-border');
  assert.equal(value('BADGE_CLASS'), undefined);
});

test('only floating surfaces draw shadows, and only with the two elevation steps', () => {
  // 地に置いた物（カード・欄）は影を持たず、浮いた物だけが影を持つ（ADR 0204。ADR 0181 の段階 3 の「影をやめる」を、
  // 浮いた面に限って改めた）。使える影は shadow-float（島・入力バー）と shadow-raised の 2 段だけ。HeroUI の部品の影を
  // 消す shadow-none! は使える。キャンバスで掴んでいる物の影（CanvasBoard の shadow-overlay）は手で書いた 1 件だけを残す。
  const allowed = new Set(['shadow-float', 'shadow-raised', 'shadow-none!']);
  const floating = [];
  const others = [];
  for (const path of sources(rendererDir)) {
    const text = withoutComments(readFileSync(path, 'utf8'));
    const name = path.slice(rendererDir.length).replaceAll(sep, '/');
    for (const match of text.matchAll(
      /(?<![\w-])(?:[\w-]+:)*shadow(?:-[^\s'"`{}]+)?(?![\w])/gu,
    )) {
      if (match[0] === 'shadow-float') floating.push(name);
      else if (!allowed.has(match[0])) others.push(`${name}: ${match[0]}`);
    }
  }
  assert.deepEqual(others, ['screens/canvas/CanvasBoard.tsx: shadow-overlay']);
  // 浮いた面は、上の中央の島（キャンバス表示・従来の窓）と入力バーの 3 つ（手で書いた期待値）。
  assert.deepEqual(floating.sort(), [
    'components/StatusBand.tsx',
    'screens/canvas/CanvasIsland.tsx',
    'screens/canvas/InputBar.tsx',
  ]);
});

test('styles.css defines the two elevation shadows and the spring curve', () => {
  const css = cssWithoutComments(readFileSync(stylesPath, 'utf8'));
  const names = [...css.matchAll(/(--shadow-[a-z]+)\s*:/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(names, ['--shadow-raised', '--shadow-float']);
  // ばねの曲線は linear() で、0 から始まり 1 で終わる。行き過ぎは 2% 未満（手で書いた上限）。
  const spring = /--ease-spring:\s*linear\(([^)]*)\)/u.exec(css)?.[1];
  assert.ok(spring !== undefined);
  const points = spring.split(',').map((part) => Number(part.trim()));
  assert.equal(points[0], 0);
  assert.equal(points.at(-1), 1);
  assert.ok(points.every((value) => Number.isFinite(value)));
  assert.ok(Math.max(...points) > 1);
  assert.ok(Math.max(...points) < 1.02);
});

// --- styles.css の試験 ---

// 中に規則を持たない「セレクター { 宣言 }」を、外側の規則（@layer・@media）の前置きと空白でつないだ selector で取り出す
// （例: "@layer base @media (prefers-reduced-motion: reduce) :root, :host"）。宣言は名前 → 値。
function blocksOf(css) {
  const blocks = [];
  const stack = [];
  let buffer = '';
  for (const char of cssWithoutComments(css)) {
    if (char === '{') {
      // 前置きは最後の ; より後（@import・@source の文を含めない）。
      const selector = (buffer.split(';').at(-1) ?? '')
        .replace(/\s+/gu, ' ')
        .trim();
      const parent = stack.at(-1);
      if (parent !== undefined) parent.hasChild = true;
      stack.push({ selector, hasChild: false });
      buffer = '';
    } else if (char === '}') {
      const frame = stack.pop();
      if (frame !== undefined && !frame.hasChild) {
        const declarations = new Map();
        for (const part of buffer.split(';')) {
          const index = part.indexOf(':');
          if (index < 0) continue;
          declarations.set(
            part.slice(0, index).trim(),
            part
              .slice(index + 1)
              .replace(/\s+/gu, ' ')
              .trim(),
          );
        }
        const selector = [
          ...stack.map((outer) => outer.selector),
          frame.selector,
        ].join(' ');
        blocks.push({ selector, declarations });
      }
      buffer = '';
    } else buffer += char;
  }
  return blocks;
}

test('styles.css defines the four radius steps and maps the HeroUI scale onto them', () => {
  const css = readFileSync(stylesPath, 'utf8');
  const theme = blocksOf(css).filter(({ selector }) =>
    selector.endsWith('@theme'),
  );
  assert.equal(theme.length, 1);
  const declarations = theme[0]?.declarations ?? new Map();
  const expected = {
    '--radius-part': '6px',
    '--radius-box': '12px',
    '--radius-island': '28px',
    '--radius-xs': 'var(--radius-part)',
    '--radius-sm': 'var(--radius-part)',
    '--radius-md': 'var(--radius-part)',
    '--radius-lg': 'var(--radius-box)',
    '--radius-xl': 'var(--radius-box)',
    '--radius-2xl': 'var(--radius-island)',
    '--radius-3xl': 'var(--radius-island)',
    '--radius-4xl': 'var(--radius-island)',
    '--radius-field': 'var(--radius-box)',
  };
  const radii = Object.fromEntries(
    [...declarations].filter(([name]) => name.startsWith('--radius')),
  );
  assert.deepEqual(radii, expected);
  // HeroUI が calc(var(--radius) * n) で直に使う基準と、入力欄の丸み。
  const root = blocksOf(css).find(
    ({ selector, declarations: d }) =>
      selector.endsWith(':root, :host') && d.has('--radius'),
  );
  assert.equal(root?.declarations.get('--radius'), 'var(--radius-box)');
  assert.equal(root?.declarations.get('--field-radius'), 'var(--radius-box)');
});

test('every border-radius in styles.css is one of the four steps', () => {
  const css = cssWithoutComments(readFileSync(stylesPath, 'utf8'));
  const values = [...css.matchAll(/border-radius\s*:\s*([^;}]+)/gu)].map(
    (match) => (match[1] ?? '').trim(),
  );
  assert.ok(values.length >= 2);
  const allowed = new Set([
    'var(--radius-part)',
    'var(--radius-box)',
    'var(--radius-island)',
    '9999px',
  ]);
  assert.deepEqual(
    values.filter((value) => !allowed.has(value)),
    [],
  );
  // HeroUI の部品のうち、ボタンは完全な丸、カードは箱（手で書いた対応）。
  assert.match(
    css,
    /\.button,\s*\.chip,[^{]*\.tabs__tab,[^{]*\{\s*border-radius:\s*9999px;/u,
  );
  assert.match(
    css,
    /\.card,\s*\.alert,[^{]*\{\s*border-radius:\s*var\(--radius-box\);/u,
  );
});

test('motion durations become zero when the OS asks for reduced motion', () => {
  const css = cssWithoutComments(readFileSync(stylesPath, 'utf8'));
  const blocks = blocksOf(css);
  const motion = (declarations) =>
    Object.fromEntries(
      [...declarations].filter(([name]) => name.startsWith('--motion-')),
    );
  const normal = blocks.find(
    ({ selector, declarations }) =>
      selector.endsWith(':root, :host') &&
      !selector.includes('prefers-reduced-motion') &&
      declarations.has('--motion-move'),
  );
  assert.deepEqual(motion(normal?.declarations ?? new Map()), {
    '--motion-move': '180ms',
    '--motion-panel': '280ms',
    '--motion-island': '520ms',
  });
  const reduced = blocks.find(({ selector }) =>
    /@media \(prefers-reduced-motion: reduce\) :root, :host$/u.test(selector),
  );
  assert.deepEqual(motion(reduced?.declarations ?? new Map()), {
    '--motion-move': '0s',
    '--motion-panel': '0s',
    '--motion-island': '0s',
  });
});

// --- 検査そのものの試験 ---

test('the checks themselves find shapes outside the rules', () => {
  assert.deepEqual(
    roundedTokensOutsideTheScale(
      'a rounded-3xl b rounded-md rounded rounded-[10px] rounded-t-lg md:rounded-lg rounded-(--x)',
    ),
    [
      'rounded-3xl',
      'rounded-md',
      'rounded',
      'rounded-[10px]',
      'rounded-t-lg',
      'rounded-lg',
      'rounded-(--x)',
    ],
  );
  assert.deepEqual(
    roundedTokensOutsideTheScale(
      "'rounded-part rounded-box rounded-island size-6 rounded-full'",
    ),
    [],
  );
  assert.deepEqual(
    fullRoundsWithoutHeight(
      '<div className="flex flex-col rounded-full p-3" /><span className=\'size-6 rounded-full\' />',
    ),
    ['"flex flex-col rounded-full p-3"'],
  );
  assert.deepEqual(
    fullRoundsWithoutHeight(
      "const size = compact ? 'h-7' : 'h-9';\nconst a = `${size} rounded-full`;",
    ),
    [],
  );
  assert.deepEqual(
    fullRoundsWithoutHeight(
      "const pad = 'px-3';\nconst a = `${pad} rounded-full`;",
    ),
    ['`${pad} rounded-full`'],
  );
  assert.deepEqual(
    movingTransitionsWithoutMotionTokens(
      "'transition-[left,top] duration-150' 'transition-colors' 'transition-[left] duration-(--motion-move) motion-reduce:transition-none'",
    ),
    ["'transition-[left,top] duration-150'"],
  );
  assert.deepEqual(
    literalDurationsAndUnsafeAnimations(
      "'duration-150 animate-[x_1s] motion-safe:animate-status-panel-in duration-(--motion-move)'",
    ),
    ['duration-150', 'animate-[x_1s]'],
  );
});
