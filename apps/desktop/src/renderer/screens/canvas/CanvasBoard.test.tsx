// キャンバスの窓が描く記述（UI-03・UI-06、ADR 0032）の試験。配置のエンジンが決めた位置・読む順・棚・見出しのプレーンテキスト、
// 行の数と残りの件数、強調の枠、前に出ている間だけの操作の印、ロック中に描かないことを、サーバー描画（react-dom/server）で
// 確かめる。期待値（ピクセル）は手で計算した（1280 × 800: 左 24・上 24、列の幅 82・間 16、行の高さ 72・間 16）。
// 実際の見た目は Electron の画面で撮って確かめる（docs/ui/canvas-layout.md）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DesktopCanvasView } from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import { emphasisClass } from '../../state/canvas-state.js';
import type { CanvasViewItem } from '../../state/canvas-state.js';
import { CanvasBoard } from './CanvasBoard.js';
import { CanvasGround } from './CanvasGround.js';

const ref = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const item = (
  id: string,
  overrides: Partial<CanvasViewItem> = {},
): CanvasViewItem => ({
  item_id: id,
  kind: 'card',
  component: 'list',
  heading: '今日の用事',
  emphasis: 'normal',
  group: null,
  relations: [],
  grid: { column: 2, span: 4, rows: 3 },
  placement: 'canvas',
  data: {
    item_refs: [
      { kind: 'calendar_event', ref: ref(1) },
      { kind: 'calendar_event', ref: ref(2) },
      { kind: 'calendar_event', ref: ref(3) },
    ],
    more_count: 0,
  },
  ...overrides,
});

const view = (
  items: CanvasViewItem[],
  readingOrder?: string[],
  extra: Partial<DesktopCanvasView> = {},
): DesktopCanvasView => ({
  canvas_revision: '4',
  items,
  reading_order:
    readingOrder ??
    items
      .filter((entry) => entry.placement === 'canvas')
      .map((entry) => entry.item_id),
  ...extra,
});

const WIDE = { width: 1280, height: 800 };

const render = (node: ReactNode) =>
  renderToStaticMarkup(<AppProviders>{node}</AppProviders>);

const board = (
  canvas: DesktopCanvasView | null,
  options: {
    front?: boolean;
    viewport?: { width: number; height: number };
  } = {},
) =>
  render(
    <CanvasBoard
      view={canvas}
      front={options.front ?? false}
      viewport={options.viewport ?? WIDE}
    />,
  );

// 物の箱の style（left・top・width・height）。
const boxOf = (html: string, id: string): string | null =>
  new RegExp(`data-item="${id}"[^>]*style="([^"]+)"`, 'u').exec(html)?.[1] ??
  null;

test('the layout engine decides the position in pixels from the grid hint and the emphasis', () => {
  // 補助（normal）で焦点がない: 1 行目・ヒントの列 2 から 4 列・3 行。x = 24 + 98 = 122、幅 = 24 + 5 × 98 − 16 − 122 = 376、
  // 高さ = 3 × 88 − 16 = 248。
  const html = board(view([item('errands')]));
  assert.equal(
    boxOf(html, 'errands'),
    'left:122px;top:24px;width:376px;height:248px',
  );
  assert.match(html, /data-canvas-revision="4"/u);
  assert.match(html, /data-layout-mode="grid"/u);
  // 焦点（high）は幅 6 以上・行 4 以上に広げ、1 行目に置く: 列 2 から 6 列（x 122、幅 = 24 + 7 × 98 − 16 − 122 = 572）・4 行（336）。
  const focus = board(view([item('focus', { emphasis: 'high' })]));
  assert.equal(
    boxOf(focus, 'focus'),
    'left:122px;top:24px;width:572px;height:336px',
  );
  // ユーザーの置き場所はそのマスにそのまま置く（列 7・行 2・4 列・2 行: x = 24 + 6 × 98 = 612、y = 24 + 88 = 112、
  // 幅 = 24 + 10 × 98 − 16 − 612 = 376、高さ 160）。
  const pinned = board(
    view([item('errands')], undefined, {
      user_pins: [
        {
          item_id: 'errands',
          cell: { column: 7, row: 2, span: 4, rows: 2 },
        },
      ],
    }),
  );
  assert.equal(
    boxOf(pinned, 'errands'),
    'left:612px;top:112px;width:376px;height:160px',
  );
  assert.match(pinned, /data-source="user"/u);
});

test('items are drawn in reading order; shelved items go to the shelf, not the canvas', () => {
  const html = board(
    view(
      [
        item('a', { heading: '見出しA' }),
        item('b', { heading: '見出しB' }),
        item('c', { heading: '棚の物', placement: 'shelf' }),
      ],
      ['b', 'a'],
    ),
  );
  const a = html.indexOf('data-item="a"');
  const b = html.indexOf('data-item="b"');
  assert(a > 0 && b > 0 && b < a, 'reading order b, a');
  assert.doesNotMatch(html, /data-item="c"/u);
  assert.match(html, /data-shelved="c"/u);
  assert.match(html, /棚の物を棚から出す/u);
});

test('an errands list card shows the heading as plain text, one row per ref and the remaining count', () => {
  const html = board(
    view([
      item('errands', {
        data: {
          item_refs: Array.from({ length: 50 }, (_, index) => ({
            kind: 'calendar_event',
            ref: ref(index + 1),
          })),
          more_count: 7,
        },
      }),
    ]),
  );
  assert.match(html, />今日の用事</u);
  assert.equal((html.match(/<li\b/gu) ?? []).length, 50);
  assert.match(html, />\+7</u);
  // 説明文を置かない（見出しと、順番の数・残りの数だけ）。後ろにある間は操作の印も出さない。
  const text = html
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  assert.match(text, /^今日の用事 1 2 3 /u);
  assert.doesNotMatch(text, /予定|です|ます|ください/u);
  const small = board(view([item('errands')]));
  assert.equal((small.match(/<li\b/gu) ?? []).length, 3);
  assert.doesNotMatch(small, />\+/u);
});

test('the controls appear only while the canvas is in front', () => {
  const back = board(view([item('errands')]));
  assert.doesNotMatch(back, /を閉じる|を棚へ片付ける|data-resize-grip/u);
  assert.match(back, /data-item="errands"[^>]*tabindex="-1"/u);
  const front = board(view([item('errands')]), { front: true });
  assert.match(front, /aria-label="今日の用事を閉じる"/u);
  assert.match(front, /aria-label="今日の用事を棚へ片付ける"/u);
  assert.match(front, /data-resize-grip="true"/u);
  assert.match(front, /data-item="errands"[^>]*tabindex="0"/u);
  // 棚の物を出すボタンは、後ろにある間は押せない。
  const shelf = board(
    view([
      item('errands'),
      item('old', { heading: '前の物', placement: 'shelf' }),
    ]),
  );
  assert.match(
    shelf,
    /aria-label="前の物を棚から出す"[^>]*disabled=""|disabled=""[^>]*aria-label="前の物を棚から出す"/u,
  );
});

test('a narrow canvas is one column in reading order and does not offer moving or resizing', () => {
  const html = board(
    view([item('a', { emphasis: 'high' }), item('b')], ['b', 'a']),
    { front: true, viewport: { width: 600, height: 900 } },
  );
  assert.match(html, /data-layout-mode="column"/u);
  // 置ける幅 = 600 − 24 − 24 − 72 = 480。b（補助・ヒント 3 行）が上、a（焦点・ヒント 3 行なので 3 行）がその下。
  // 高さ = 3 × 72 + 2 × 16 = 248、a の上 = 24 + 248 + 16 = 288。
  assert.equal(boxOf(html, 'b'), 'left:24px;top:24px;width:480px;height:248px');
  assert.equal(
    boxOf(html, 'a'),
    'left:24px;top:288px;width:480px;height:248px',
  );
  assert.doesNotMatch(html, /data-resize-grip/u);
  // 閉じる・片付けるは 1 列でも使える。
  assert.match(html, /を閉じる/u);
});

test('a heading is drawn as text only: markup in it is escaped and never becomes an element or a link', () => {
  // 検査（Schema・domain）が先に拒否するが、画面もプレーンテキストとしてだけ描く（多重の防御）。
  const html = board(
    view([
      item('x', {
        heading: '<img src=x onerror=1> <a href="https://a.test">リンク</a>',
      }),
    ]),
  );
  assert.doesNotMatch(html, /<img\b/u);
  assert.doesNotMatch(html, /<a\b/u);
  assert.match(html, /&lt;img src=x onerror=1&gt;/u);
});

test('emphasis is shown by shape, not by words: focus is size and a left accent bar, selection is the outer ring', () => {
  assert.equal(emphasisClass('high'), 'border-l-4 border-l-accent');
  assert.equal(emphasisClass('normal'), '');
  assert.equal(emphasisClass('low'), 'opacity-70');
  const high = board(view([item('x', { emphasis: 'high' })]));
  assert.match(high, /data-emphasis="high"/u);
  assert.match(high, /border-l-4 border-l-accent/u);
  // 焦点は外周の輪を使わない（輪は選んだ物・キーボードのフォーカスだけ）。
  assert.doesNotMatch(high, /ring-focus/u);
  const normal = board(view([item('x')]));
  assert.doesNotMatch(normal, /border-l-accent/u);
});

test('an overflow tag offers show, shelve and close while in front; below the minimum height the shelf is a small strip at the top', () => {
  // 480 × 800 の 1 列で a・b（3 行ずつ）が入り、c は札。
  const three = view(
    ['a', 'b', 'c'].map((id) =>
      item(id, {
        heading: `見出し${id}`,
        grid: { column: 1, span: 4, rows: 3 },
      }),
    ),
  );
  const front = board(three, {
    front: true,
    viewport: { width: 480, height: 800 },
  });
  assert.match(front, /data-overflow="c"/u);
  assert.match(front, /aria-label="見出しcを見せる"/u);
  assert.match(front, /aria-label="見出しcを棚へ片付ける"/u);
  assert.match(front, /aria-label="見出しcを閉じる"/u);
  // 後ろにある間は、見せるボタンは押せず、片付ける・閉じるは出さない。
  const back = board(three, { viewport: { width: 480, height: 800 } });
  assert.match(
    back,
    /aria-label="見出しcを見せる"[^>]*disabled=""|disabled=""[^>]*aria-label="見出しcを見せる"/u,
  );
  assert.doesNotMatch(back, /見出しcを閉じる/u);
  // 高さ 200（最小の 272 に満たない）: 物は置かず、すべて札。棚は上の端の小さな帯（y 4・高さ 32）。
  const low = board(three, {
    front: true,
    viewport: { width: 1280, height: 200 },
  });
  assert.match(low, /data-layout-mode="minimal"/u);
  assert.doesNotMatch(low, /data-item=/u);
  assert.match(
    low,
    /data-shelf="compact" style="left:24px;top:4px;width:1160px;height:32px"/u,
  );
  // 最小の表示では見せられないので、札は見出しだけ（「見せる」のボタンと「…」の印を出さない）。片付ける・閉じるは残す。
  assert.doesNotMatch(low, /を見せる/u);
  assert.equal((low.match(/data-revealable="false"/gu) ?? []).length, 3);
  assert.match(low, /aria-label="見出しaを閉じる"/u);
  assert.match(low, /aria-label="見出しaを棚へ片付ける"/u);
});

test('an empty list shows an empty mark instead of rows', () => {
  const html = board(
    view([item('x', { data: { item_refs: [], more_count: 0 } })]),
  );
  assert.match(html, /data-empty="true"/u);
  assert.equal((html.match(/<li\b/gu) ?? []).length, 0);
});

test('no items or no view draws nothing; the locked ground draws nothing inside', () => {
  assert.equal(board(null), '');
  assert.equal(board(view([])), '');
  const locked = render(
    <CanvasGround front={false} shown={false}>
      <CanvasBoard view={view([item('errands')])} viewport={WIDE} />
    </CanvasGround>,
  );
  assert.doesNotMatch(locked, /今日の用事/u);
  const unlocked = render(
    <CanvasGround front={false} shown>
      <CanvasBoard view={view([item('errands')])} viewport={WIDE} />
    </CanvasGround>,
  );
  assert.match(unlocked, /今日の用事/u);
});

// UI-07（Issue #99 の持ち越し、PR #121 の P3）: 1 列でもカードの最小の幅 160 を守る。置ける幅は画面の幅 − 120。
test('a screen too narrow for a 160px card shows the minimal layout instead of squeezing the card; the narrowest column is exactly 160', () => {
  const canvas = view([item('a'), item('b')]);
  // 画面の幅 279（置ける幅 159）: 最小の表示。物は置かず、札だけ。
  const narrow = board(canvas, { viewport: { width: 279, height: 800 } });
  assert.match(narrow, /data-layout-mode="minimal"/u);
  assert.doesNotMatch(narrow, /data-item=/u);
  assert.equal((narrow.match(/data-overflow="/gu) ?? []).length, 2);
  // 画面の幅 280（置ける幅 160）: 1 列で、幅はちょうど 160。
  const edge = board(canvas, { viewport: { width: 280, height: 800 } });
  assert.match(edge, /data-layout-mode="column"/u);
  assert.match(
    edge,
    /data-item="a"[^>]*style="left:24px;top:24px;width:160px;/u,
  );
});
