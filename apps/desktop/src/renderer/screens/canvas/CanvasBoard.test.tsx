// キャンバスの窓が描く記述（UI-03、ADR 0032）の試験。格子のヒントから位置、読む順、棚の物、見出しのプレーンテキスト、
// 行の数と残りの件数、強調の枠、ロック中に描かないことを、純粋な関数とサーバー描画（react-dom/server）で確かめる。
// 期待値は手で書く。実際の見た目は Electron の画面で撮って確かめる（docs/ui/canvas-vertical.md）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DesktopCanvasView } from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import {
  emphasisClass,
  gridClass,
  visibleItems,
} from '../../state/canvas-state.js';
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
): DesktopCanvasView => ({
  canvas_revision: '4',
  items,
  reading_order:
    readingOrder ??
    items
      .filter((entry) => entry.placement === 'canvas')
      .map((entry) => entry.item_id),
});

const render = (node: ReactNode) =>
  renderToStaticMarkup(<AppProviders>{node}</AppProviders>);

test('the grid hint decides the position: column start, column span and row span', () => {
  assert.equal(
    gridClass({ column: 2, span: 4, rows: 3 }),
    'col-start-2 col-span-4 row-span-3',
  );
  assert.equal(
    gridClass({ column: 1, span: 12, rows: 8 }),
    'col-start-1 col-span-12 row-span-8',
  );
  assert.equal(
    gridClass({ column: 12, span: 1, rows: 1 }),
    'col-start-12 col-span-1 row-span-1',
  );
  // 範囲外が来ても壊れない（列 + 幅が 12 を超えない・行は 1〜8 に収める）。検査を通った値では起きない。
  assert.equal(
    gridClass({ column: 11, span: 6, rows: 20 }),
    'col-start-11 col-span-2 row-span-8',
  );
});

test('items are drawn in reading order and shelved items are left to the shelf', () => {
  const a = item('a');
  const b = item('b');
  const shelved = item('c', { placement: 'shelf' });
  const ordered = visibleItems(view([a, b, shelved], ['b', 'a']));
  assert.deepEqual(
    ordered.map((entry) => entry.item_id),
    ['b', 'a'],
  );
  // 読む順にない物と、棚の物は描かない。
  assert.deepEqual(
    visibleItems(view([a, b, shelved], ['a', 'c', 'x'])).map(
      (entry) => entry.item_id,
    ),
    ['a'],
  );
  assert.deepEqual(visibleItems(null), []);
});

test('an errands list card shows the heading as plain text, one row per ref and the remaining count', () => {
  const html = render(
    <CanvasBoard
      view={view([
        item('errands', {
          data: {
            item_refs: Array.from({ length: 50 }, (_, index) => ({
              kind: 'calendar_event',
              ref: ref(index + 1),
            })),
            more_count: 7,
          },
        }),
      ])}
    />,
  );
  assert.match(html, /col-start-2 col-span-4 row-span-3/u);
  assert.match(html, /data-canvas-revision="4"/u);
  assert.match(html, />今日の用事</u);
  assert.equal((html.match(/<li\b/gu) ?? []).length, 50);
  assert.match(html, />\+7</u);
  // 説明文を置かない（見出しと、順番の数・残りの数だけ）。
  const text = html
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  assert.match(text, /^今日の用事 1 2 3 /u);
  assert.doesNotMatch(text, /予定|です|ます|ください/u);
  // 残りがなければ札を出さない。
  const small = render(<CanvasBoard view={view([item('errands')])} />);
  assert.equal((small.match(/<li\b/gu) ?? []).length, 3);
  assert.doesNotMatch(small, />\+/u);
});

test('a heading is drawn as text only: markup in it is escaped and never becomes an element or a link', () => {
  // 検査（Schema・domain）が先に拒否するが、画面もプレーンテキストとしてだけ描く（多重の防御）。
  const html = render(
    <CanvasBoard
      view={view([
        item('x', {
          heading: '<img src=x onerror=1> <a href="https://a.test">リンク</a>',
        }),
      ])}
    />,
  );
  assert.doesNotMatch(html, /<img\b/u);
  assert.doesNotMatch(html, /<a\b/u);
  assert.match(html, /&lt;img src=x onerror=1&gt;/u);
});

test('emphasis is shown by the frame, not by words', () => {
  assert.equal(emphasisClass('high'), 'border-2 border-accent');
  assert.equal(emphasisClass('normal'), '');
  assert.equal(emphasisClass('low'), 'opacity-70');
  const high = render(
    <CanvasBoard view={view([item('x', { emphasis: 'high' })])} />,
  );
  assert.match(high, /data-emphasis="high"/u);
  assert.match(high, /border-accent/u);
  const normal = render(<CanvasBoard view={view([item('x')])} />);
  assert.doesNotMatch(normal, /border-accent/u);
});

test('an empty list shows an empty mark instead of rows', () => {
  const html = render(
    <CanvasBoard
      view={view([item('x', { data: { item_refs: [], more_count: 0 } })])}
    />,
  );
  assert.match(html, /data-empty="true"/u);
  assert.equal((html.match(/<li\b/gu) ?? []).length, 0);
});

test('no items or no view draws nothing; the locked ground draws nothing inside', () => {
  assert.equal(render(<CanvasBoard view={null} />), '');
  assert.equal(render(<CanvasBoard view={view([])} />), '');
  const locked = render(
    <CanvasGround front={false} shown={false}>
      <CanvasBoard view={view([item('errands')])} />
    </CanvasGround>,
  );
  assert.doesNotMatch(locked, /今日の用事/u);
  const unlocked = render(
    <CanvasGround front={false} shown>
      <CanvasBoard view={view([item('errands')])} />
    </CanvasGround>,
  );
  assert.match(unlocked, /今日の用事/u);
});
