// キャンバスの 9 つの部品（UI-07、ADR 0032）の描画の試験。サーバー描画（react-dom/server）で、部品ごとに 3 つの幅（狭い 200・
// 中くらい 320・広い 640）・上限（50 件・50 行 × 8 列・more_count）・読み上げの名前・プレーンテキスト（HTML・URL を描かない）・
// ライトとダークで同じ描画（色の分岐がない）を確かめる。期待値（行の数・列の数・位置・属性）は手で計算した値で、実装の出力から作らない。
// 箱から本文の大きさ: 幅 − 34、高さ − 78（余白 16・縁 1・見出しの帯 32・間 12）。狭い箱で道具の行があるときはさらに高さ − 28。
// 実際の見た目は Electron の画面で撮って確かめる（docs/ui/canvas-catalog.md）。本物のブラウザ・物理の入力ではない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CanvasContent } from '@buddy/contracts';
import { AppProviders } from '../../../app/AppProviders.js';
import type { ItemContent } from '../../../state/canvas-content-state.js';
import type { CanvasViewItem } from '../../../state/canvas-state.js';
import { ItemCard } from '../ItemCard.js';

const NB = String.fromCharCode(0xa0);
// ユーザー名とパスワードを持つ URL（公開前の検査に引っかからないよう、実行時に組み立てる）。
const CREDENTIAL_URL = ['https://', 'user', ':', 'pw', '@example.com/'].join(
  '',
);
const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime();
const ref = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const item = (
  component: CanvasViewItem['component'],
  refs: number,
  overrides: Partial<CanvasViewItem> = {},
): CanvasViewItem => ({
  item_id: 'part',
  kind: 'card',
  component,
  heading: '見出し',
  emphasis: 'normal',
  group: null,
  relations: [],
  grid: { column: 1, span: 4, rows: 3 },
  placement: 'canvas',
  data: {
    item_refs: Array.from({ length: refs }, (_, index) => ({
      kind: 'calendar_event',
      ref: ref(index + 1),
    })),
    more_count: 0,
  },
  ...overrides,
});

const ready = (
  content: CanvasContent,
  extra: Partial<ItemContent> = {},
): ItemContent => ({
  status: 'ready',
  content,
  signature: 's',
  revision: '1',
  opened: null,
  opening: null,
  ...extra,
});

const SIZES = {
  narrow: { width: 200, height: 300 },
  medium: { width: 320, height: 300 },
  wide: { width: 640, height: 400 },
} as const;

const render = (node: ReactNode) =>
  renderToStaticMarkup(<AppProviders>{node}</AppProviders>);

const card = (
  entry: ItemContent | undefined,
  it: CanvasViewItem,
  size: { width: number; height: number },
  options: { front?: boolean } = {},
) =>
  render(
    <ItemCard
      item={it}
      entry={entry}
      size={size}
      now={NOW}
      front={options.front ?? false}
    />,
  );

const count = (html: string, pattern: RegExp) =>
  (html.match(pattern) ?? []).length;

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

// --- list ---

const LIST = (rows: number): CanvasContent => ({
  component: 'list',
  rows: Array.from({ length: rows }, (_, index) => ({
    title: `用事${index}`,
    due_at: index === 0 ? new Date(2026, 9, 24, 14, 30).toISOString() : null,
    state: (['open', 'done', 'attention'] as const)[index % 3] ?? 'open',
  })),
});

test('list: rows have a state mark by shape with a spoken name, the due time, and only the rows that fit; the rest is a count', () => {
  // 広い 640 × 400: 本文 606 × 322、行の送り 32 + 間 4 → 全部なら floor((322 + 4) / 32) = 10 行だが、12 行 + more_count 5 は入らず
  // 件数の札の分（32）を空けて floor((290 + 4) / 32) = 9 行。隠れる = 3 + 5 = 8。
  const wide = item('list', 12, {
    data: {
      item_refs: item('list', 12).data.item_refs,
      more_count: 5,
    },
  });
  const html = card(ready(LIST(12)), wide, SIZES.wide);
  assert.equal(count(html, /<li\b/gu), 9);
  assert.match(html, /data-part="list"/u);
  // 状態の記号は形（data-mark）と読み上げの名前を持つ。0 番目は未了、1 は済み、2 は気づき（3 つずつ繰り返す。9 行なので各 3）。
  assert.equal(count(html, /aria-label="未了"/gu), 3);
  assert.equal(count(html, /aria-label="済み"/gu), 3);
  assert.equal(count(html, /aria-label="気づき"/gu), 3);
  assert.equal(count(html, /data-mark="open"/gu), 3);
  assert.equal(count(html, /data-mark="done"/gu), 3);
  assert.equal(count(html, /data-mark="attention"/gu), 3);
  // 0 番目の期限は今日の 14:30 なので時刻だけ。
  assert.match(html, /<time[^>]*>14:30<\/time>/u);
  assert.equal(count(html, /<time\b/gu), 1);
  // 隠れた数の札（読み上げは「ほか 8 件」）。
  assert.match(html, new RegExp(`aria-label="ほか${NB}8${NB}件"`, 'u'));
  assert.match(html, /data-more="rows"/u);
  // 狭い 200 × 300: 本文 166 × 222、行の送り 52（期限を題名の下へ）。全部なら floor((222 + 4) / 52) = 4 行だが 12 行は入らず、
  // 札の分を空けて floor((190 + 4) / 52) = 3 行。
  const narrow = card(ready(LIST(12)), item('list', 12), SIZES.narrow);
  assert.equal(count(narrow, /<li\b/gu), 3);
  assert.match(narrow, /data-width-class="narrow"/u);
  assert.match(narrow, /basis-full/u);
  // 中くらい 320 × 300: 本文 286 × 222。全部なら floor(226 / 32) = 7 行だが入らず、札の分を空けて floor((190 + 4) / 32) = 6 行。
  // 期限は題名と同じ行。
  const medium = card(ready(LIST(12)), item('list', 12), SIZES.medium);
  assert.equal(count(medium, /<li\b/gu), 6);
  assert.match(medium, /data-width-class="medium"/u);
  assert.doesNotMatch(medium, /basis-full/u);
});

test('list: 50 rows with more_count 7 in a tall box draws all 50 rows and the count 7', () => {
  const tall = item('list', 50, {
    data: { item_refs: item('list', 50).data.item_refs, more_count: 7 },
  });
  const html = card(ready(LIST(50)), tall, { width: 640, height: 2000 });
  assert.equal(count(html, /<li\b/gu), 50);
  assert.match(html, new RegExp(`aria-label="ほか${NB}7${NB}件"`, 'u'));
  assert.match(html, />\+7</u);
});

// --- table ---

// 生成型は上限つきの配列を長さごとの組の和にするので、動的に作った表は型を合わせるために断定する。
const TABLE = (rows: number, columns: number): CanvasContent =>
  ({
    component: 'table',
    columns: Array.from({ length: columns }, (_, index) => `列${index}`),
    rows: Array.from({ length: rows }, (_, row) => ({
      cells: Array.from({ length: columns }, (_, col) => `値${row}-${col}`),
    })),
  }) as unknown as CanvasContent;

test('table: 50 rows × 8 columns are all drawn when the box is big enough; a small box shows what fits and counts the rest by rows and columns', () => {
  const big = card(ready(TABLE(50, 8)), item('table', 50), {
    width: 800,
    height: 3000,
  });
  assert.match(big, /<table[^>]*aria-label="見出し"/u);
  assert.equal(count(big, /<th[^>]*scope="col"/gu), 8);
  // 本文の行は 50（先頭のセルが行の見出し）。1 行あたり 8 つのセル（th 1 + td 7）。
  assert.equal(count(big, /<tr\b/gu), 51);
  assert.equal(count(big, /<th[^>]*scope="row"/gu), 50);
  assert.equal(count(big, /<td\b/gu), 50 * 7);
  assert.doesNotMatch(big, /data-more=/u);
  // 狭い 200 × 300: 本文 166 → 列は floor(166 / 88) = 1。高さ 222 − 見出しの行 32 = 190。50 行は入らず（列も隠れる）、札の分 32
  // を空けて floor(158 / 32) = 4 行。隠れる行は 46。
  const narrow = card(ready(TABLE(50, 8)), item('table', 50), SIZES.narrow);
  assert.equal(count(narrow, /<th[^>]*scope="col"/gu), 1);
  assert.equal(count(narrow, /<th[^>]*scope="row"/gu), 4);
  assert.equal(count(narrow, /<td\b/gu), 0);
  assert.match(narrow, new RegExp(`aria-label="ほか${NB}46${NB}件"`, 'u'));
  assert.match(narrow, new RegExp(`aria-label="ほか${NB}7${NB}列"`, 'u'));
  // 中くらい 320 × 300: 本文 286 → 3 列。
  const medium = card(ready(TABLE(50, 8)), item('table', 50), SIZES.medium);
  assert.equal(count(medium, /<th[^>]*scope="col"/gu), 3);
});

// --- schedule_timeline ---

const TIMELINE: CanvasContent = {
  component: 'schedule_timeline',
  day_start_minute: 480,
  day_end_minute: 1200,
  events: [
    { title: '打ち合わせ', start_minute: 540, end_minute: 600 },
    { title: '資料づくり', start_minute: 570, end_minute: 660 },
    { title: '買い物', start_minute: 700, end_minute: 760 },
  ],
};

test('schedule_timeline: overlapping events sit side by side in lanes, a lone event takes the full width, positions follow the time', () => {
  const html = card(ready(TIMELINE), item('schedule_timeline', 3), SIZES.wide);
  // 打ち合わせ（9:00〜10:00）と資料づくり（9:30〜11:00）は重なる: 列 0 と 1（2 列）。買い物は重ならない: 列 0（1 列）。
  assert.match(
    html,
    /data-event="0" data-lane="0" data-lanes="2" data-overlap="true"/u,
  );
  assert.match(
    html,
    /data-event="1" data-lane="1" data-lanes="2" data-overlap="true"/u,
  );
  assert.match(
    html,
    /data-event="2" data-lane="0" data-lanes="1"(?! data-overlap)/u,
  );
  // 読み上げの名前は時刻と題名。
  assert.match(html, /aria-label="9:00から10:00 打ち合わせ"/u);
  assert.match(html, /aria-label="11:40から12:40 買い物"/u);
  // 広い 640 × 400 の本文の高さ 322、軸は 720 分: 打ち合わせの top = 60 / 720 × 322 = 26.83…px。
  assert.match(html, /data-event="0"[^>]*style="top:26\.83/u);
  // 軸の目盛りは時（322 / 12 時間 = 26.8px で 28 に足りないので 2 時間おき）: 8・10・…・20。
  assert.deepEqual(
    [...html.matchAll(/data-tick="(\d+)"/gu)].map((m) => Number(m[1])),
    [8, 10, 12, 14, 16, 18, 20],
  );
  assert.equal(count(html, /role="listitem"/gu), 3);
});

// --- mail_card ---

const MAILS = (body: number | null): CanvasContent => ({
  component: 'mail_card',
  mails: [0, 1, 2].map((index) => ({
    from: `差出人${index}`,
    subject: `件名${index}`,
    received_at: new Date(2026, 9, 24, 9 + index, 5).toISOString(),
    labels: index === 0 ? ['連絡', '日程'] : [],
    body: index === body ? '<b>本文</b> https://example.com/\n二行目' : null,
  })),
});

test('mail_card: sender, subject, time and labels; the body only for the opened row, as plain text; opening needs the canvas in front', () => {
  const closed = card(ready(MAILS(null)), item('mail_card', 3), SIZES.wide);
  assert.equal(count(closed, /data-mail="/gu), 3);
  assert.equal(count(closed, /aria-expanded="false"/gu), 3);
  assert.doesNotMatch(closed, /data-mail-body/u);
  assert.match(closed, />差出人0</u);
  assert.match(closed, />件名1</u);
  assert.match(closed, /<time[^>]*>9:05<\/time>|<time[^>]*>09:05<\/time>/u);
  // ラベルは狭くない箱で出す（狭い 200 では出さない）。
  assert.match(closed, />連絡</u);
  assert.match(closed, />日程</u);
  const narrow = card(ready(MAILS(null)), item('mail_card', 3), SIZES.narrow);
  assert.doesNotMatch(narrow, />連絡</u);
  // 後ろにある間は開くボタンが押せない。前に出ていれば押せる。
  assert.equal(count(closed, /disabled=""/gu), 3);
  const front = card(ready(MAILS(null)), item('mail_card', 3), SIZES.wide, {
    front: true,
  });
  assert.equal(count(front, /disabled=""/gu), 0);
  // 開いた 1 通（添字 1）だけに本文の領域が出る。HTML・URL はそのまま文字で、要素・リンクにならない。
  const opened = card(
    ready(MAILS(1), {
      opened: { index: 1, body: '<b>本文</b> https://example.com/\n二行目' },
    }),
    item('mail_card', 3),
    SIZES.wide,
    { front: true },
  );
  assert.equal(count(opened, /data-mail-body="true"/gu), 1);
  assert.equal(count(opened, /aria-expanded="true"/gu), 1);
  assert.match(
    opened,
    /role="region"[^>]*aria-label="件名1の本文"|aria-label="件名1の本文"[^>]*role="region"/u,
  );
  assert.match(opened, /&lt;b&gt;本文&lt;\/b&gt; https:\/\/example\.com\//u);
  assert.doesNotMatch(opened, /<b>|<a\b/u);
  assert.match(opened, /whitespace-pre-wrap/u);
});

// --- compare ---

const COMPARE: CanvasContent = {
  component: 'compare',
  columns: ['案 A', '案 B', '案 C'],
  rows: [
    { label: '場所', values: ['近い', '遠い', '近い'] },
    { label: '時間', values: ['午前', '午前', '午前'] },
  ],
};

test('compare: columns side by side, a row of equal values is one merged cell, a row that differs is split by column with an accent bar; narrow boxes drop columns into a count', () => {
  const wide = card(ready(COMPARE), item('compare', 3), SIZES.wide);
  assert.equal(count(wide, /role="columnheader"/gu), 3);
  assert.match(wide, /data-same="false"/u);
  assert.match(wide, /data-same="true"/u);
  // 違う行は 3 つのセルに分かれ、同じ行は 1 つにまとめる（位置で示す）。
  assert.equal(count(wide, /role="cell"/gu), 3 + 1);
  assert.equal(count(wide, /data-merged="true"/gu), 1);
  assert.match(wide, /border-l-accent/u);
  // 狭い 200 × 300: 本文 166 → floor(166 / 80) = 2 列。3 列目は「→1」の札。違う行は 2 つのセル。
  const narrow = card(ready(COMPARE), item('compare', 3), SIZES.narrow);
  assert.equal(count(narrow, /role="columnheader"/gu), 2);
  assert.match(narrow, new RegExp(`aria-label="ほか${NB}1${NB}列"`, 'u'));
  assert.equal(count(narrow, /role="cell"/gu), 2 + 1);
});

// --- progress ---

test('progress: a bar with a spoken name and value, the numbers written out, and a check shape on a finished one', () => {
  const content: CanvasContent = {
    component: 'progress',
    steps: [
      { label: '書類を集める', done: 4, total: 5 },
      { label: '申し込みを出す', done: 2, total: 2 },
    ],
  };
  const html = card(ready(content), item('progress', 0), SIZES.wide);
  assert.equal(count(html, /role="progressbar"/gu), 2);
  assert.match(html, /aria-label="書類を集める"/u);
  assert.match(html, /aria-valuenow="4"/u);
  assert.match(html, /aria-valuemax="5"/u);
  assert.match(html, /aria-valuenow="2"/u);
  assert.match(textOf(html), /4 \/ 5/u);
  assert.match(textOf(html), /2 \/ 2/u);
  // 終わった 1 つだけにチェックの形。
  assert.equal(count(html, /data-mark="check"/gu), 1);
  assert.match(html, /data-complete="true"/u);
});

// --- chart ---

const CHART: CanvasContent = {
  component: 'chart',
  x_labels: ['月', '火', '水'],
  series: [
    { label: '今週', mark: 'bar', values: [3, 5.5, 2] },
    { label: '先週', mark: 'bar', values: [2, 4, 1] },
    { label: '目標', mark: 'line', values: [4, 4, 4] },
  ],
};

test('chart: SVG drawn by React; series differ by fill pattern, dash and mark shape (not color alone), values are written, a table for readers holds the same numbers', () => {
  const html = card(ready(CHART), item('chart', 0), SIZES.wide);
  assert.match(html, /<svg[^>]*data-part="chart"[^>]*aria-hidden="true"/u);
  // 棒 2 系列 × 3 点 = 6、折れ線 1 本。
  assert.equal(count(html, /data-bar="/gu), 6);
  assert.equal(count(html, /data-line="/gu), 1);
  // 2 つ目の棒の系列は斜線の塗り（べたと違う）。1 つ目は塗りの属性がない（accent のべた）。
  assert.match(html, /fill="url\(#chart[A-Za-z0-9_-]*-hatch\)"/u);
  // 折れ線の点は丸（1 本目）。凡例は棒 2・線 1 の同じ形の印とラベル。
  assert.match(html, /data-shape="circle"/u);
  assert.equal(count(html, /data-series="bar"/gu), 2);
  assert.equal(count(html, /data-series="line"/gu), 1);
  // 目盛りは 0 から（棒を含む）で、きりのよい刻み。最大値 5.5 を含む 0〜6、広い箱は 5 つの目盛りまで → 刻み 2 で 0・2・4・6。
  assert.deepEqual(
    [...html.matchAll(/data-tick="([\d.]+)"/gu)].map((m) => Number(m[1])),
    [0, 2, 4, 6],
  );
  // 棒の値が書かれる（幅に余裕がある）。
  assert.match(html, />5\.5</u);
  // 読み上げ用の表（画面の外）。系列ごとの行と値。
  assert.match(html, /<table class="sr-only">/u);
  assert.match(
    html,
    /<th scope="row">今週<\/th><td>3<\/td><td>5\.5<\/td><td>2<\/td>/u,
  );
  // CSP: 外部の読み込み・インラインの style を使わない。
  const svg =
    /<svg[^>]*data-part="chart"[\s\S]*?<\/svg>/u.exec(html)?.[0] ?? '';
  assert.doesNotMatch(svg, /style=|<image|<foreignObject|https?:|<script/u);
});

test('chart: line series get different dash patterns and mark shapes', () => {
  const two: CanvasContent = {
    component: 'chart',
    x_labels: ['月', '火', '水'],
    series: [
      { label: 'a', mark: 'line', values: [1, 2, 3] },
      { label: 'b', mark: 'line', values: [3, 2, 1] },
      { label: 'c', mark: 'line', values: [2, 2, 2] },
    ],
  };
  const html = card(ready(two), item('chart', 0), SIZES.wide);
  assert.equal(count(html, /data-line="/gu), 3);
  assert.match(html, /data-line="0"[\s\S]*?data-shape="circle"/u);
  assert.match(
    html,
    /data-line="1"[\s\S]*?stroke-dasharray="7 4"[\s\S]*?data-shape="square"/u,
  );
  assert.match(
    html,
    /data-line="2"[\s\S]*?stroke-dasharray="2 4"[\s\S]*?data-shape="triangle"/u,
  );
});

// --- source_list ---

test('source_list: only https URLs become links, opened outside the app; other URLs stay plain text', () => {
  const content: CanvasContent = {
    component: 'source_list',
    sources: [
      { title: '公共の案内', url: 'https://www.example.com/guide/overview' },
      // 形式の検査が先に拒否するが、画面もリンクにしない（多重の防御）。
      { title: '平文', url: 'http://www.example.com/' },
      { title: '認証つき', url: CREDENTIAL_URL },
      { title: 'スクリプト', url: 'javascript:alert(1)' },
    ],
  };
  const html = card(ready(content), item('source_list', 4), {
    width: 640,
    height: 600,
  });
  assert.equal(count(html, /<a\b/gu), 1);
  const link = /<a\b[^>]*>/u.exec(html)?.[0] ?? '';
  assert.match(link, /href="https:\/\/www\.example\.com\/guide\/overview"/u);
  assert.match(link, /target="_blank"/u);
  assert.match(link, /rel="noopener noreferrer"/u);
  assert.match(html, />www\.example\.com</u);
  // 外部へ出る形（矢印）は https のリンクにだけ付く。
  assert.equal(count(html, /data-mark="external"/gu), 1);
  assert.equal(count(html, /data-linked="false"/gu), 3);
  assert.doesNotMatch(html, /href="http:|href="javascript:/u);
  assert(!html.includes(CREDENTIAL_URL));
});

// --- text ---

test('text: plain text only; markup and URLs are shown as characters, never as elements or links; line breaks are kept', () => {
  const content: CanvasContent = {
    component: 'text',
    text: '<script>alert(1)</script>\nhttps://example.com/ <a href="https://a.test">x</a>',
  };
  const html = card(ready(content), item('text', 0), SIZES.wide);
  assert.match(html, /data-part="text"/u);
  assert.doesNotMatch(html, /<script|<a\b/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /https:\/\/example\.com\//u);
  assert.match(html, /whitespace-pre-wrap/u);
  // 箱の高さに入る行数で切る（本文 322 → floor(322 / 24) = 13 行）。
  assert.match(html, /-webkit-line-clamp:13/u);
});

// --- 共通 ---

const ALL: [CanvasViewItem['component'], CanvasContent, number][] = [
  ['list', LIST(3), 3],
  ['table', TABLE(3, 4), 3],
  ['schedule_timeline', TIMELINE, 3],
  ['mail_card', MAILS(null), 3],
  ['compare', COMPARE, 0],
  [
    'progress',
    { component: 'progress', steps: [{ label: 'a', done: 1, total: 2 }] },
    0,
  ],
  ['chart', CHART, 0],
  [
    'source_list',
    {
      component: 'source_list',
      sources: [{ title: 't', url: 'https://example.com/' }],
    },
    1,
  ],
  ['text', { component: 'text', text: '本文' }, 0],
];

test('every part has the same markup in light and dark (no theme branch) and names the card by its heading', () => {
  for (const [component, content, refs] of ALL)
    for (const [name, size] of Object.entries(SIZES)) {
      const html = card(ready(content), item(component, refs), size);
      const dark = render(
        <div className="dark">
          <ItemCard
            item={item(component, refs)}
            entry={ready(content)}
            size={size}
            now={NOW}
          />
        </div>,
      );
      assert.equal(
        dark,
        `<div class="dark">${html}</div>`,
        `${component} ${name}`,
      );
      // カードは見出しで名前が付く（group の名前）。
      assert.match(
        html,
        /role="group"[^>]*aria-labelledby="/u,
        `${component} ${name}`,
      );
      assert.match(html, />見出し</u, `${component} ${name}`);
      assert.match(html, new RegExp(`data-component="${component}"`, 'u'));
      assert.match(html, new RegExp(`data-width-class="${name}"`, 'u'));
      // 説明文を置かない（記述にない文字は出ない）。
      assert.doesNotMatch(
        textOf(html),
        /ください|です。|ます。/u,
        `${component} ${name}`,
      );
    }
});

test('a heading and every content string are drawn as plain text in every part', () => {
  const evil = '<img src=x onerror=1>';
  const withEvil: [CanvasViewItem['component'], CanvasContent, number][] = [
    [
      'list',
      {
        component: 'list',
        rows: [{ title: evil, due_at: null, state: 'open' }],
      },
      1,
    ],
    [
      'table',
      { component: 'table', columns: [evil], rows: [{ cells: [evil] }] },
      1,
    ],
    [
      'schedule_timeline',
      {
        component: 'schedule_timeline',
        day_start_minute: 480,
        day_end_minute: 720,
        events: [{ title: evil, start_minute: 500, end_minute: 560 }],
      },
      1,
    ],
    [
      'mail_card',
      {
        component: 'mail_card',
        mails: [
          {
            from: evil,
            subject: evil,
            received_at: '2026-10-24T00:00:00Z',
            labels: [evil],
            body: null,
          },
        ],
      },
      1,
    ],
    [
      'compare',
      {
        component: 'compare',
        columns: [evil, 'b'],
        rows: [{ label: evil, values: [evil, 'x'] }],
      },
      2,
    ],
    [
      'progress',
      { component: 'progress', steps: [{ label: evil, done: 0, total: 1 }] },
      0,
    ],
    [
      'chart',
      {
        component: 'chart',
        x_labels: [evil, 'b'],
        series: [{ label: evil, mark: 'bar', values: [1, 2] }],
      },
      0,
    ],
    [
      'source_list',
      {
        component: 'source_list',
        sources: [{ title: evil, url: 'https://example.com/' }],
      },
      1,
    ],
    ['text', { component: 'text', text: evil }, 0],
  ];
  for (const [component, content, refs] of withEvil) {
    const html = card(
      ready(content),
      item(component, refs, { heading: evil }),
      SIZES.wide,
    );
    assert.doesNotMatch(html, /<img\b/u, component);
    assert.match(html, /&lt;img src=x onerror=1&gt;/u, component);
  }
});

test('a float is drawn with a shadow, a card without one; emphasis keeps the accent bar', () => {
  const float = card(
    ready(LIST(2)),
    item('list', 2, { kind: 'float' }),
    SIZES.wide,
  );
  assert.match(float, /data-kind="float"/u);
  assert.match(float, /shadow-overlay/u);
  const plain = card(ready(LIST(2)), item('list', 2), SIZES.wide);
  assert.doesNotMatch(plain, /shadow-overlay/u);
  const high = card(
    ready(LIST(2)),
    item('list', 2, { emphasis: 'high' }),
    SIZES.wide,
  );
  assert.match(high, /border-l-accent/u);
});

test('while the content is loading the card shows numbered empty bands, and when it could not be fetched only a warning mark with a spoken name', () => {
  const loading = card(undefined, item('list', 3), SIZES.wide);
  assert.match(loading, /data-state="loading"/u);
  assert.equal(count(loading, /<li\b/gu), 3);
  const failed = card(
    { ...ready(LIST(1)), status: 'failed', content: null },
    item('list', 3),
    SIZES.wide,
  );
  assert.match(
    failed,
    /role="img"[^>]*aria-label="中身を表示できません"|aria-label="中身を表示できません"[^>]*role="img"/u,
  );
  assert.equal(count(failed, /<li\b/gu), 0);
  // 部品と合わない中身は描かない（失敗と同じ形）。
  const mismatch = card(ready(TABLE(1, 1)), item('list', 1), SIZES.wide);
  assert.match(mismatch, /data-state="failed"/u);
});

test('timeline: dense events are limited to lanes that stay readable (the rest is a count), and an event at the end of the axis stays inside the box', () => {
  // 狭い 200 × 300: 本文 166 − 軸 36 = 130 → 読める列（56 以上）は floor(130 / 56) = 2。同じ時刻の 50 件のうち 2 件を描き、
  // 残りの 48 件は札（札の分 32 を空けて並べ直す）。列の幅は 63（130 ÷ 2 − 2）で、負にならない。
  const same: CanvasContent = {
    component: 'schedule_timeline',
    day_start_minute: 480,
    day_end_minute: 1200,
    events: Array.from({ length: 50 }, (_, index) => ({
      title: `予定${index}`,
      start_minute: 540,
      end_minute: 600,
    })),
  };
  const dense = card(ready(same), item('schedule_timeline', 50), SIZES.narrow);
  assert.equal(count(dense, /data-event="/gu), 2);
  assert.equal(count(dense, /data-lanes="2"/gu), 2);
  assert.match(dense, new RegExp(`aria-label="ほか${NB}48${NB}件"`, 'u'));
  // 広い 640 × 400: 本文 606 − 36 = 570 → 10 列まで。50 件の同時でも 10 件、残り 40 件は札。
  const wide = card(ready(same), item('schedule_timeline', 50), SIZES.wide);
  assert.equal(count(wide, /data-event="/gu), 10);
  assert.match(wide, new RegExp(`aria-label="ほか${NB}40${NB}件"`, 'u'));
  // 軸の終わり（20:00）の直前の 10 分の予定: 最小の高さ 20 を取ると下にはみ出すので、下の端にそろえる。
  // 本文の高さ 322 → top = 322 − 20 = 302。
  const last: CanvasContent = {
    component: 'schedule_timeline',
    day_start_minute: 480,
    day_end_minute: 1200,
    events: [{ title: '終わり際', start_minute: 1190, end_minute: 1200 }],
  };
  const edge = card(ready(last), item('schedule_timeline', 1), SIZES.wide);
  assert.match(edge, /data-event="0"[^>]*style="top:302px;height:20px/u);
});

test('chart: the table for readers keeps the exact values, apart from the rounded numbers drawn on the chart', () => {
  const fine: CanvasContent = {
    component: 'chart',
    x_labels: ['a', 'b'],
    series: [{ label: '細かい値', mark: 'bar', values: [0.001, 0.002] }],
  };
  const html = card(ready(fine), item('chart', 0), SIZES.wide);
  assert.match(html, /<td>0\.001<\/td><td>0\.002<\/td>/u);
});
