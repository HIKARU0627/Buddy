// UI レンダラーの色のコントラストの試験（ADR 0024 の「コントラスト」）。HeroUI のテーマの変数（variables.css）と、
// apps/desktop/src/renderer/styles.css の上書きを読み、oklch・color-mix(in oklab) を解いて WCAG 2.2 のコントラスト比を測る。
// 文字は 4.5:1 以上（1.4.3）、境界・フォーカスの枠・状態の記号のような文字でないものは 3:1 以上（1.4.11）。
// 色の計算は CSS Color 4 の式（OKLab ⇔ sRGB）をここで書き、画面のコードとは共有しない。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const HEROUI_VARIABLES = `${root}apps/desktop/node_modules/@heroui/styles/dist/themes/default/variables.css`;
const OVERRIDES = `${root}apps/desktop/src/renderer/styles.css`;

// CSS の最も内側の「セレクター { 宣言 }」を取り出し、カスタムプロパティだけを読む。
function blocksOf(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const blocks = [];
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selector = match[1].replace(/\s+/gu, ' ').trim();
    const declarations = {};
    for (const part of match[2].split(';')) {
      const index = part.indexOf(':');
      if (index < 0) continue;
      const name = part.slice(0, index).trim();
      if (name.startsWith('--'))
        declarations[name] = part
          .slice(index + 1)
          .replace(/\s+/gu, ' ')
          .trim();
    }
    blocks.push({ selector, declarations });
  }
  return blocks;
}

function themes() {
  const common = {};
  const heroLight = {};
  const heroDark = {};
  for (const { selector, declarations } of blocksOf(
    readFileSync(HEROUI_VARIABLES, 'utf8'),
  )) {
    if (selector.includes('data-vibrant-palette')) continue;
    if (selector.includes('.dark')) Object.assign(heroDark, declarations);
    else if (selector.includes('.light'))
      Object.assign(heroLight, declarations);
    else if (selector.startsWith(':root')) Object.assign(common, declarations);
  }
  const myCommon = {};
  const myLight = {};
  const myDark = {};
  for (const { selector, declarations } of blocksOf(
    readFileSync(OVERRIDES, 'utf8'),
  )) {
    if (selector.includes(':not(.dark)')) Object.assign(myLight, declarations);
    else if (selector.includes('.dark')) Object.assign(myDark, declarations);
    else if (selector.startsWith(':root'))
      Object.assign(myCommon, declarations);
  }
  return {
    light: { ...common, ...myCommon, ...heroLight, ...myLight },
    // ダークでも HeroUI のライトの規則（:root）は当たり、.dark の規則が後から上書きする。
    dark: {
      ...common,
      ...myCommon,
      ...heroLight,
      ...myLight,
      ...heroDark,
      ...myDark,
    },
    myLight,
    myDark,
  };
}

// --- 色（OKLab と不透明度で持つ） ---
const clamp = (x) => Math.min(1, Math.max(0, x));
const encode = (c) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
const decode = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function toSrgb({ lab: [L, a, b] }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((x) => clamp(encode(clamp(x))));
}

function fromSrgb(rgb, alpha = 1) {
  const [r, g, b] = rgb.map(decode);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    lab: [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ],
    alpha,
  };
}

// 不透明の背景に重ねた色（sRGB で合成）。
function over(top, base) {
  if (top.alpha >= 1) return top;
  const t = toSrgb(top);
  const b = toSrgb(base);
  return fromSrgb(t.map((x, i) => top.alpha * x + (1 - top.alpha) * b[i]));
}

function luminance(color) {
  const [r, g, b] = toSrgb(color).map(decode);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(foreground, background) {
  const a = luminance(over(foreground, background));
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const hex = (color) =>
  `#${toSrgb(color)
    .map((x) =>
      Math.round(x * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

// 上位のカンマで分ける。
function splitArgs(text) {
  const args = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else current += ch;
  }
  args.push(current.trim());
  return args;
}

function resolver(vars) {
  const resolve = (expression) => {
    const text = expression.trim();
    let match;
    if ((match = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/u.exec(text))) {
      const value = vars[match[1]];
      if (value !== undefined) return resolve(value);
      if (match[2] !== undefined) return resolve(match[2]);
      throw new Error(`未定義の変数: ${match[1]}`);
    }
    if (
      (match =
        /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\)$/u.exec(
          text,
        ))
    ) {
      const L = Number(match[1]) / (match[2] ? 100 : 1);
      const C = Number(match[3]);
      const h = (Number(match[4]) * Math.PI) / 180;
      const alpha =
        match[5] === undefined ? 1 : Number(match[5]) / (match[6] ? 100 : 1);
      return { lab: [L, C * Math.cos(h), C * Math.sin(h)], alpha };
    }
    if (text === 'transparent') return { lab: [0, 0, 0], alpha: 0 };
    if ((match = /^color-mix\(\s*in\s+oklab\s*,\s*(.+)\)$/u.exec(text))) {
      const parts = splitArgs(match[1]).map((arg) => {
        const p = /^(.*?)\s+([\d.]+)%$/u.exec(arg);
        return p
          ? { color: resolve(p[1]), percent: Number(p[2]) }
          : { color: resolve(arg), percent: null };
      });
      assert.equal(parts.length, 2, text);
      const [a, b] = parts;
      if (a.percent === null && b.percent === null) a.percent = b.percent = 50;
      else if (a.percent === null) a.percent = 100 - b.percent;
      else if (b.percent === null) b.percent = 100 - a.percent;
      // CSS Color 5: 合計が 100% を超えるときは比で割り、下回るときは不透明度を下げる。
      const sum = a.percent + b.percent;
      const wa = a.percent / sum;
      const wb = b.percent / sum;
      const alpha =
        (wa * a.color.alpha + wb * b.color.alpha) * Math.min(1, sum / 100);
      const premultiplied = wa * a.color.alpha + wb * b.color.alpha;
      if (premultiplied === 0) return { lab: [0, 0, 0], alpha: 0 };
      const lab = [0, 1, 2].map(
        (i) =>
          (wa * a.color.alpha * a.color.lab[i] +
            wb * b.color.alpha * b.color.lab[i]) /
          premultiplied,
      );
      return { lab, alpha };
    }
    throw new Error(`解けない色: ${text}`);
  };
  return (name) => resolve(`var(${name})`);
}

// [説明, 文字（前景）, 背景（配列なら先頭を後ろの色に重ねる）, 下限]
const PAIRS = [
  ['本文 / カード', '--foreground', ['--surface'], 4.5],
  ['本文 / 地', '--foreground', ['--background'], 4.5],
  ['補足（muted）/ カード', '--muted', ['--surface'], 4.5],
  ['補足（muted）/ 地', '--muted', ['--background'], 4.5],
  ['primary ボタンの文字 / accent', '--accent-foreground', ['--accent'], 4.5],
  [
    'secondary ボタンの文字 / default（地）',
    '--accent-soft-foreground',
    ['--default', '--background'],
    4.5,
  ],
  [
    'secondary ボタンの文字 / default（カード）',
    '--accent-soft-foreground',
    ['--default', '--surface'],
    4.5,
  ],
  [
    'tertiary ボタンの文字 / default',
    '--default-foreground',
    ['--default', '--surface'],
    4.5,
  ],
  [
    'danger-soft ボタンの文字 / danger-soft（カード）',
    '--danger-soft-foreground',
    ['--danger-soft', '--surface'],
    4.5,
  ],
  [
    'danger-soft ボタンの文字 / danger-soft（地）',
    '--danger-soft-foreground',
    ['--danger-soft', '--background'],
    4.5,
  ],
  [
    'success の文字・記号 / カード',
    '--success-soft-foreground',
    ['--surface'],
    4.5,
  ],
  [
    'success の文字・記号 / 地',
    '--success-soft-foreground',
    ['--background'],
    4.5,
  ],
  ['warning の文字 / カード', '--warning-soft-foreground', ['--surface'], 4.5],
  ['warning の文字 / 地', '--warning-soft-foreground', ['--background'], 4.5],
  ['danger の文字 / カード', '--danger-soft-foreground', ['--surface'], 4.5],
  ['danger の文字 / 地', '--danger-soft-foreground', ['--background'], 4.5],
  [
    '選ばれていないタブの文字（muted）/ タブの面（default）',
    '--muted',
    ['--default', '--background'],
    4.5,
  ],
  ['確認のダイアログの本文 / overlay', '--foreground', ['--overlay'], 4.5],
  [
    '確認のダイアログの accent のアイコン / accent-soft',
    '--accent-soft-foreground',
    ['--accent-soft', '--overlay'],
    3,
  ],
  [
    '確認のダイアログの danger のアイコン / danger-soft',
    '--danger-soft-foreground',
    ['--danger-soft', '--overlay'],
    3,
  ],
  [
    '入力欄の文字 / 入力欄（secondary）',
    '--field-foreground',
    ['--default', '--surface'],
    4.5,
  ],
  [
    '入力欄の placeholder / 入力欄（secondary）',
    '--field-placeholder',
    ['--default', '--surface'],
    4.5,
  ],
  ['入力欄の境界 / カード', '--field-border', ['--surface'], 3],
  ['フォーカスの枠（focus）/ カード', '--focus', ['--surface'], 3],
  ['フォーカスの枠（focus）/ 地', '--focus', ['--background'], 3],
];

function measure(vars) {
  const color = resolver(vars);
  return PAIRS.map(([label, fg, bg, minimum]) => {
    const background = bg
      .map(color)
      .reduceRight(
        (base, top) => (base === null ? top : over(top, base)),
        null,
      );
    const foreground = color(fg);
    return {
      label,
      minimum,
      value: ratio(foreground, background),
      fg: hex(over(foreground, background)),
      bg: hex(background),
    };
  });
}

test('the HeroUI theme variables are available to measure', () => {
  assert.ok(
    existsSync(HEROUI_VARIABLES),
    'HeroUI の variables.css がありません。pnpm install を実行してください。',
  );
});

test('the overrides are only colors, one light block and one dark block', () => {
  const { myLight, myDark } = themes();
  assert.deepEqual(Object.keys(myLight).sort(), [
    '--accent',
    '--danger',
    '--field-border',
    '--muted',
  ]);
  assert.deepEqual(Object.keys(myDark).sort(), [
    '--accent',
    '--border',
    '--danger',
    '--field-border',
    '--separator',
  ]);
});

for (const mode of ['light', 'dark'])
  test(`text is at least 4.5:1 and borders and focus at least 3:1 (${mode})`, (t) => {
    const results = measure(themes()[mode]);
    for (const row of results)
      t.diagnostic(
        `${row.value.toFixed(2)}:1 ≥ ${row.minimum}  ${row.label}  ${row.fg} / ${row.bg}`,
      );
    const failing = results
      .filter((row) => row.value < row.minimum)
      .map((row) => `${row.label}: ${row.value.toFixed(2)}`);
    assert.deepEqual(failing, []);
  });

test('the contrast measurement itself agrees with known WCAG values', () => {
  // 白と黒は 21:1、同じ色は 1:1、#767676 と白は 4.54:1（WCAG の理解の資料にある値）。
  const white = fromSrgb([1, 1, 1]);
  const black = fromSrgb([0, 0, 0]);
  const gray = fromSrgb([0x76 / 255, 0x76 / 255, 0x76 / 255]);
  assert.equal(ratio(black, white).toFixed(2), '21.00');
  assert.equal(ratio(white, white).toFixed(2), '1.00');
  assert.equal(ratio(gray, white).toFixed(2), '4.54');
  // oklch(100% 0 0) は白、oklch(0% 0 0) は黒。
  const color = resolver({ '--w': 'oklch(100% 0 0)', '--k': 'oklch(0% 0 0)' });
  assert.equal(hex(color('--w')), '#ffffff');
  assert.equal(hex(color('--k')), '#000000');
  // 半透明の黒を白に重ねると sRGB の値が 0.5 の灰色になる（相対輝度 0.2140、白と 3.98:1。手で計算した値）。
  assert.equal(ratio({ ...black, alpha: 0.5 }, white).toFixed(2), '3.98');
});
