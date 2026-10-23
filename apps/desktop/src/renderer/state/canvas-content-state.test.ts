// キャンバスの物の中身（本文）の持ち方と部品の描き方（canvas-content-state.ts。UI-07、ADR 0032）の試験。期待値は手で計算した値。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanvasContent, DesktopCanvasView } from '@buddy/contracts';
import {
  EMPTY_STORE,
  assignLanes,
  assignLanesWithin,
  bodySizeOf,
  chartNumber,
  clockLabel,
  columnCapacity,
  contentArrived,
  contentFailed,
  hourTicks,
  httpsLink,
  itemSignature,
  mailClosed,
  mailOpened,
  mailOpening,
  minuteLabel,
  moreLabel,
  niceScale,
  rowCapacity,
  rowsThatFit,
  syncContents,
  widthClassOf,
} from './canvas-content-state.js';
import type { ContentStore } from './canvas-content-state.js';
import type { CanvasViewItem } from './canvas-state.js';

const ref = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const item = (
  id: string,
  refs: number[],
  overrides: Partial<CanvasViewItem> = {},
): CanvasViewItem => ({
  item_id: id,
  kind: 'card',
  component: 'list',
  heading: id,
  emphasis: 'normal',
  group: null,
  relations: [],
  grid: { column: 1, span: 4, rows: 2 },
  placement: 'canvas',
  data: {
    item_refs: refs.map((n) => ({ kind: 'calendar_event', ref: ref(n) })),
    more_count: 0,
  },
  ...overrides,
});

const view = (
  revision: string,
  items: CanvasViewItem[],
): DesktopCanvasView => ({
  canvas_revision: revision,
  items,
  reading_order: items.map((entry) => entry.item_id),
});

const LIST: CanvasContent = {
  component: 'list',
  rows: [{ title: '用事', due_at: null, state: 'open' }],
};
const MAIL: CanvasContent = {
  component: 'mail_card',
  mails: [
    {
      from: 'a',
      subject: 's',
      received_at: '2026-10-24T00:00:00Z',
      labels: [],
      body: null,
    },
  ],
};

// 取れるまで進める（requests の中身を取り込む）。
function settle(store: ContentStore, view_: DesktopCanvasView): ContentStore {
  const synced = syncContents(store, view_, true);
  let next = synced.store;
  for (const request of synced.requests)
    next = contentArrived(next, request, LIST);
  return next;
}

test('a new item is requested once; a revision that does not change its data keeps the content and asks for nothing', () => {
  const first = syncContents(EMPTY_STORE, view('1', [item('a', [1, 2])]), true);
  assert.equal(first.requests.length, 1);
  assert.deepEqual(first.requests[0], {
    item_id: 'a',
    signature: itemSignature(item('a', [1, 2])),
    revision: '1',
    epoch: 0,
    seq: 1,
  });
  assert.equal(first.store.items['a']?.status, 'loading');
  const arrived = contentArrived(first.store, first.requests[0]!, LIST);
  assert.equal(arrived.items['a']?.status, 'ready');
  assert.deepEqual(arrived.items['a']?.content, LIST);
  // 版だけが進んだ（動かした・大きさを変えた）: 取り直さない。
  const again = syncContents(arrived, view('2', [item('a', [1, 2])]), true);
  assert.deepEqual(again.requests, []);
  assert.equal(again.store, arrived);
  // 中身が取れる前に同じ記述が届いても、重ねて取らない。
  const loading = syncContents(
    first.store,
    view('1', [item('a', [1, 2])]),
    true,
  );
  assert.deepEqual(loading.requests, []);
});

test('content is dropped when the item goes away or its data changes, and an item on the shelf is never fetched', () => {
  const ready = settle(
    EMPTY_STORE,
    view('1', [item('a', [1, 2]), item('b', [3])]),
  );
  assert.deepEqual(Object.keys(ready.items).sort(), ['a', 'b']);
  // b が閉じられた: b の中身は捨てる。
  const closed = syncContents(ready, view('2', [item('a', [1, 2])]), true);
  assert.deepEqual(Object.keys(closed.store.items), ['a']);
  assert.deepEqual(closed.requests, []);
  // a の参照が変わった（データが違う）: 古い中身を捨てて取り直す。
  const changed = syncContents(
    ready,
    view('2', [item('a', [1, 2, 9]), item('b', [3])]),
    true,
  );
  assert.equal(changed.store.items['a']?.status, 'loading');
  assert.equal(changed.store.items['a']?.content, null);
  assert.deepEqual(
    changed.requests.map((r) => r.item_id),
    ['a'],
  );
  // more_count・部品が変わっても同じ（データの印が変わる）。
  const more = item('b', [3], {
    data: {
      item_refs: [{ kind: 'calendar_event', ref: ref(3) }],
      more_count: 2,
    },
  });
  assert.notEqual(itemSignature(more), itemSignature(item('b', [3])));
  assert.notEqual(
    itemSignature(item('b', [3], { component: 'table' })),
    itemSignature(item('b', [3])),
  );
  // 棚の物は取らない（描かない物の本文を持たない）。
  const shelved = syncContents(
    EMPTY_STORE,
    view('1', [item('s', [1], { placement: 'shelf' })]),
    true,
  );
  assert.deepEqual(shelved.requests, []);
  assert.deepEqual(shelved.store.items, {});
});

test('lock, stop, disconnect (no description or not enabled) drop everything and invalidate answers that are still on the way', () => {
  const loading = syncContents(EMPTY_STORE, view('1', [item('a', [1])]), true);
  const request = loading.requests[0]!;
  // 記述がなくなった（ロック・停止・切断で main が空を通知した）: すべて捨て、世代を進める。
  const gone = syncContents(loading.store, null, true);
  assert.deepEqual(gone.store.items, {});
  assert.equal(gone.store.epoch, 1);
  assert.deepEqual(gone.requests, []);
  // 遅れて届いた答えは反映しない（世代が違う・項目がない）。
  assert.equal(contentArrived(gone.store, request, LIST), gone.store);
  // 同じ物が同じ印でもう一度現れても、前の世代の答えは反映しない。
  const back = syncContents(gone.store, view('2', [item('a', [1])]), true);
  assert.equal(back.requests[0]?.epoch, 1);
  assert.equal(contentArrived(back.store, request, LIST), back.store);
  assert.equal(
    contentArrived(back.store, back.requests[0]!, LIST).items['a']?.status,
    'ready',
  );
  // 描く条件を満たさない（enabled が false）でも同じ。すでに空なら何も変えない（世代も進めない）。
  const disabled = syncContents(back.store, view('2', [item('a', [1])]), false);
  assert.deepEqual(disabled.store.items, {});
  assert.equal(disabled.store.epoch, 2);
  assert.equal(syncContents(disabled.store, null, false).store, disabled.store);
});

test('a failed fetch is tried again once when a newer revision arrives, not on the same revision', () => {
  const first = syncContents(EMPTY_STORE, view('1', [item('a', [1])]), true);
  const failed = contentFailed(first.store, first.requests[0]!);
  assert.equal(failed.items['a']?.status, 'failed');
  assert.equal(failed.items['a']?.content, null);
  // 同じ版では取り直さない。
  const same = syncContents(failed, view('1', [item('a', [1])]), true);
  assert.deepEqual(same.requests, []);
  assert.equal(same.store, failed);
  // 次の版で 1 度だけ取り直す。
  const retry = syncContents(failed, view('2', [item('a', [1])]), true);
  assert.deepEqual(
    retry.requests.map((r) => [r.item_id, r.revision]),
    [['a', '2']],
  );
  assert.equal(retry.store.items['a']?.status, 'loading');
  // 取り直しの途中の同じ版では、さらに取らない。
  assert.deepEqual(
    syncContents(retry.store, view('2', [item('a', [1])]), true).requests,
    [],
  );
});

test('a mail body is kept for one row only: opening another closes the first, closing drops it, and answers for a dropped state are ignored', () => {
  const ready = settle(
    EMPTY_STORE,
    view('1', [item('m', [1, 2, 3], { component: 'mail_card' })]),
  );
  const mailReady: ContentStore = {
    ...ready,
    items: {
      m: { ...ready.items['m']!, content: MAIL },
    },
  };
  const signature = mailReady.items['m']!.signature;
  const opening = mailOpening(mailReady, 'm', 1);
  assert.equal(opening.items['m']?.opening, 1);
  assert.equal(opening.items['m']?.opened, null);
  const opened = mailOpened(opening, 'm', signature, 0, {
    index: 1,
    body: '本文',
  });
  assert.deepEqual(opened.items['m']?.opened, { index: 1, body: '本文' });
  assert.equal(opened.items['m']?.opening, null);
  // 別の 1 通を開き始めると、前の本文はその時点で捨てる。
  const second = mailOpening(opened, 'm', 2);
  assert.equal(second.items['m']?.opened, null);
  assert.equal(second.items['m']?.opening, 2);
  // 開く途中の行と違う答え（遅れて届いた前の行）は反映しない。
  assert.equal(
    mailOpened(second, 'm', signature, 0, { index: 1, body: '前の本文' }),
    second,
  );
  // 世代・データの印が違う答えは反映しない。
  assert.equal(
    mailOpened(second, 'm', signature, 7, { index: 2, body: 'x' }),
    second,
  );
  assert.equal(
    mailOpened(second, 'm', 'other', 0, { index: 2, body: 'x' }),
    second,
  );
  // 開けなかった（null）なら、閉じた形に戻る。
  assert.equal(
    mailOpened(second, 'm', signature, 0, null).items['m']?.opening,
    null,
  );
  // 閉じると本文を捨てる。開いていなければ何も変えない。
  const closed = mailClosed(opened, 'm');
  assert.equal(closed.items['m']?.opened, null);
  assert.equal(mailClosed(closed, 'm'), closed);
  // 中身が ready でない物は開けない。
  const loading = syncContents(
    EMPTY_STORE,
    view('1', [item('m', [1])]),
    true,
  ).store;
  assert.equal(mailOpening(loading, 'm', 0), loading);
  // 物が閉じられたら本文も一緒に消える。
  assert.deepEqual(syncContents(opened, view('2', []), true).store.items, {});
});

test('width classes, body size and capacities (hand-calculated)', () => {
  assert.equal(widthClassOf(160), 'narrow');
  assert.equal(widthClassOf(239), 'narrow');
  assert.equal(widthClassOf(240), 'medium');
  assert.equal(widthClassOf(479), 'medium');
  assert.equal(widthClassOf(480), 'wide');
  // 本文の大きさ = 箱 − 余白と縁（2 × 17）− 見出しの帯 32 − 間 12（− 狭い箱の道具の行 28）。
  assert.deepEqual(
    bodySizeOf({ width: 640, height: 400 }, { stackedTools: false }),
    {
      width: 606,
      height: 322,
    },
  );
  assert.deepEqual(
    bodySizeOf({ width: 200, height: 300 }, { stackedTools: true }),
    {
      width: 166,
      height: 194,
    },
  );
  assert.deepEqual(
    bodySizeOf({ width: 10, height: 10 }, { stackedTools: false }),
    {
      width: 0,
      height: 0,
    },
  );
  // 行の数: 少なくとも 1 行、floor((高さ + 間) / 送り)。
  assert.equal(rowCapacity(322, 32, 4), 10);
  assert.equal(rowCapacity(0, 32, 4), 1);
  assert.equal(rowCapacity(31, 32, 0), 1);
  assert.equal(rowCapacity(64, 32, 0), 2);
  // 列の数: 少なくとも min、多くても total。
  assert.equal(columnCapacity(606, 88, 8), 6);
  assert.equal(columnCapacity(606, 88, 4), 4);
  assert.equal(columnCapacity(10, 88, 8), 1);
  assert.equal(columnCapacity(10, 80, 3, 2), 2);
  assert.equal(moreLabel(7), 'ほか 7 件');
});

test('lanes: overlapping events go side by side in order, a lone event is full width, clusters count their own lanes', () => {
  const lanes = assignLanes([
    { start_minute: 540, end_minute: 600 },
    { start_minute: 570, end_minute: 660 },
    { start_minute: 700, end_minute: 760 },
  ]);
  assert.deepEqual(lanes, [
    { lane: 0, lanes: 2, overlaps: true },
    { lane: 1, lanes: 2, overlaps: true },
    { lane: 0, lanes: 1, overlaps: false },
  ]);
  // 3 つが同時: 列 0・1・2（3 列）。終わった列は次の予定が再利用する（4 つ目は列 0）。
  const three = assignLanes([
    { start_minute: 600, end_minute: 700 },
    { start_minute: 610, end_minute: 650 },
    { start_minute: 620, end_minute: 690 },
    { start_minute: 700, end_minute: 720 },
  ]);
  assert.deepEqual(
    three.map((slot) => slot.lane),
    [0, 1, 2, 0],
  );
  assert.deepEqual(
    three.map((slot) => slot.lanes),
    [3, 3, 3, 1],
  );
  assert.deepEqual(
    three.map((slot) => slot.overlaps),
    [true, true, true, false],
  );
  // つながって重なる（A と B、B と C が重なり、A と C は重ならない）は 1 つの塊: 2 列。C は A の列を再利用する。
  const chain = assignLanes([
    { start_minute: 0, end_minute: 60 },
    { start_minute: 30, end_minute: 90 },
    { start_minute: 60, end_minute: 120 },
  ]);
  assert.deepEqual(chain, [
    { lane: 0, lanes: 2, overlaps: true },
    { lane: 1, lanes: 2, overlaps: true },
    { lane: 0, lanes: 2, overlaps: true },
  ]);
  // 入力の順に依らず、同じ予定には同じ結果（開始の早い順に割り当てる）。
  const shuffled = assignLanes([
    { start_minute: 570, end_minute: 660 },
    { start_minute: 540, end_minute: 600 },
  ]);
  assert.deepEqual(shuffled, [
    { lane: 1, lanes: 2, overlaps: true },
    { lane: 0, lanes: 2, overlaps: true },
  ]);
  // 接するだけ（終わりと始まりが同じ）は重ならない。
  assert.deepEqual(
    assignLanes([
      { start_minute: 0, end_minute: 60 },
      { start_minute: 60, end_minute: 120 },
    ]),
    [
      { lane: 0, lanes: 1, overlaps: false },
      { lane: 0, lanes: 1, overlaps: false },
    ],
  );
  assert.deepEqual(assignLanes([]), []);
});

test('hour ticks thin out until they are at least 28px apart', () => {
  // 8:00〜20:00（12 時間）。高さ 322 → 1 時間あたり 26.8px（28 に足りない）→ 2 時間おき。
  assert.deepEqual(hourTicks(480, 1200, 322), [8, 10, 12, 14, 16, 18, 20]);
  // 高さ 600 → 50px → 毎時。
  assert.deepEqual(
    hourTicks(480, 1200, 600),
    [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  );
  // 高さ 100 → 8.3px で、4 時間おき（33px）が最初に 28 を超える（8・12・16・20）。
  assert.deepEqual(hourTicks(480, 1200, 100), [8, 12, 16, 20]);
  // どの間隔でも 28 に届かない高さでは、いちばん広い 6 時間おき（8・14・20）。
  assert.deepEqual(hourTicks(480, 1200, 40), [8, 14, 20]);
  // 時の途中から始まる軸は、次の時から。
  assert.deepEqual(hourTicks(510, 690, 600), [9, 10, 11]);
});

test('chart scales: from zero when there are bars, nice steps, always containing the data', () => {
  assert.deepEqual(niceScale([3, 5.5, 2], { includeZero: true, maxTicks: 5 }), {
    min: 0,
    max: 6,
    ticks: [0, 2, 4, 6],
  });
  assert.deepEqual(niceScale([0, 100], { includeZero: true, maxTicks: 5 }), {
    min: 0,
    max: 100,
    ticks: [0, 50, 100],
  });
  // 折れ線だけは 0 を含めない（範囲 8、3 つまでの目盛りなら刻み 5 → 95〜105）。
  assert.deepEqual(niceScale([96, 104], { includeZero: false, maxTicks: 3 }), {
    min: 95,
    max: 105,
    ticks: [95, 100, 105],
  });
  // 負の値と 0 を含む。
  assert.deepEqual(niceScale([-5, 5], { includeZero: true, maxTicks: 3 }), {
    min: -5,
    max: 5,
    ticks: [-5, 0, 5],
  });
  // 全部同じ値でも幅を持つ。
  const flat = niceScale([4, 4, 4], { includeZero: false, maxTicks: 3 });
  assert(flat.min <= 4 && flat.max >= 4 && flat.max > flat.min);
  assert.equal(chartNumber(5.5), '5.5');
  assert.equal(chartNumber(2), '2');
  assert.equal(chartNumber(1.23456), '1.23');
  assert.equal(chartNumber(0.1 + 0.2), '0.3');
});

test('times and links', () => {
  const now = new Date(2026, 9, 24, 12, 0, 0).getTime();
  assert.equal(
    clockLabel(new Date(2026, 9, 24, 9, 5).toISOString(), now),
    '09:05',
  );
  assert.equal(
    clockLabel(new Date(2026, 9, 25, 9, 5).toISOString(), now),
    '10/25 09:05',
  );
  assert.equal(clockLabel('not a date', now), '');
  assert.equal(minuteLabel(540), '9:00');
  assert.equal(minuteLabel(545), '9:05');
  assert.equal(minuteLabel(1439), '23:59');
  assert.deepEqual(httpsLink('https://www.example.com/a?b=1'), {
    href: 'https://www.example.com/a?b=1',
    host: 'www.example.com',
  });
  for (const bad of [
    'http://example.com/',
    'javascript:alert(1)',
    'data:text/html,x',
    ['https://', 'user', ':', 'pw', '@example.com/'].join(''),
    'https://user@example.com/',
    '//example.com/',
    'example.com',
    '',
  ])
    assert.equal(httpsLink(bad), null, bad);
});

test('rows that fit leave room for the count tag only when something is hidden', () => {
  // 10 行がちょうど入る高さ（322、送り 32・間 4）。全部入るなら札は出さないので、空けない。
  assert.equal(rowsThatFit(10, 322, 32, 4, false), 10);
  // 11 行は入らない: 札の分 32 を空けて floor((290 + 4) / 32) = 9 行。
  assert.equal(rowsThatFit(11, 322, 32, 4, false), 9);
  // 行は全部入っても、別の隠れた物（more_count・入らない列）があれば札を出すので、空ける。
  assert.equal(rowsThatFit(10, 322, 32, 4, true), 9);
  assert.equal(rowsThatFit(3, 322, 32, 4, true), 9);
  // 少なくとも 1 行。
  assert.equal(rowsThatFit(5, 20, 32, 4, true), 1);
  assert.equal(rowsThatFit(0, 0, 32, 4, false), 1);
});

test('lanes with a limit: an event that finds every lane busy is left out (null), the cluster counts only the placed ones', () => {
  // 同時の 5 件を 2 列まで: 先の 2 件（元の順）だけ置き、残りの 3 件は null。置いた塊は 2 列。
  const same = Array.from({ length: 5 }, () => ({
    start_minute: 600,
    end_minute: 660,
  }));
  assert.deepEqual(assignLanesWithin(same, 2), [
    { lane: 0, lanes: 2, overlaps: true },
    { lane: 1, lanes: 2, overlaps: true },
    null,
    null,
    null,
  ]);
  // 1 列まで: 重なる予定は先の 1 件だけ。重ならない次の予定は置く（塊が変わるので全幅）。
  assert.deepEqual(
    assignLanesWithin(
      [
        { start_minute: 0, end_minute: 60 },
        { start_minute: 30, end_minute: 90 },
        { start_minute: 60, end_minute: 120 },
      ],
      1,
    ),
    [
      { lane: 0, lanes: 1, overlaps: false },
      null,
      { lane: 0, lanes: 1, overlaps: false },
    ],
  );
  // 上限が十分なら、上限なしと同じ。
  const some = [
    { start_minute: 540, end_minute: 600 },
    { start_minute: 570, end_minute: 660 },
    { start_minute: 700, end_minute: 760 },
  ];
  assert.deepEqual(assignLanesWithin(some, 8), assignLanes(some));
  // 50 件が同時でも、上限の列の数を超えない。
  const fifty = Array.from({ length: 50 }, () => ({
    start_minute: 0,
    end_minute: 30,
  }));
  const placed = assignLanesWithin(fifty, 3).filter((slot) => slot !== null);
  assert.equal(placed.length, 3);
  assert(placed.every((slot) => slot.lanes === 3 && slot.lane < 3));
});

test('every fetch has its own number: a failure or an answer of an older fetch of the same data cannot spoil a newer fetch (shelf and back)', () => {
  const card = (revision: string, placement: 'canvas' | 'shelf') =>
    view(revision, [item('a', [1, 2], { placement })]);
  // 版 1 で取得を始める（番号 1）→ 版 2 で棚へ（項目を捨てる）→ 版 3 で戻して取得を始める（番号 2。参照は同じなので印も同じ）。
  const first = syncContents(EMPTY_STORE, card('1', 'canvas'), true);
  const old = first.requests[0]!;
  assert.equal(old.seq, 1);
  const shelved = syncContents(first.store, card('2', 'shelf'), true);
  assert.deepEqual(shelved.store.items, {});
  const back = syncContents(shelved.store, card('3', 'canvas'), true);
  const current = back.requests[0]!;
  assert.equal(current.seq, 2);
  assert.equal(current.signature, old.signature);
  assert.equal(current.epoch, old.epoch);
  // 版 1 の失敗が届いても、版 3 の取得は loading のまま。そのあと版 3 の成功が届けば ready になる。
  const afterOldFailure = contentFailed(back.store, old);
  assert.equal(afterOldFailure, back.store);
  assert.equal(afterOldFailure.items['a']?.status, 'loading');
  const done = contentArrived(afterOldFailure, current, LIST);
  assert.equal(done.items['a']?.status, 'ready');
  // 版 1 の成功が先に届いても、版 3 の取得を終わらせない（古い取得の中身を使わない）。
  assert.equal(contentArrived(back.store, old, MAIL), back.store);
  // 数は捨てても戻らない（ロックで全部捨てた後の取得も新しい番号）。
  const cleared = syncContents(done, null, true);
  const again = syncContents(cleared.store, card('4', 'canvas'), true);
  assert.equal(again.requests[0]?.seq, 3);
  // 失敗した物の取り直しも新しい番号。
  const failed = contentFailed(again.store, again.requests[0]!);
  const retry = syncContents(failed, card('5', 'canvas'), true);
  assert.equal(retry.requests[0]?.seq, 4);
  assert.equal(contentFailed(retry.store, again.requests[0]!), retry.store);
});
