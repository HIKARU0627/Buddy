// 気づきの欄（CandidatesPanel。B11-05、ADR 0132）の試験。サーバー描画（react-dom/server）で、頭の最終取得時刻・取得状態・新着
// の件数、見出し、行（題・期限・種類・状態・注記）、操作のボタンの出し分け、未取得を「気づきはありません」と言わないこと、
// 理由のコード・内部の ID を出さないことを確かめる。期待値は手で書く（基準は 2030-10-09（水）12:00 JST = 03:00Z）。
// 実際の見た目・クリックは Electron の画面で確かめる（未実施）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DesktopCandidateEntry,
  DesktopCandidateView,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import { INITIAL_CANDIDATE_STATE } from '../../state/candidate-state.js';
import type {
  CandidateActions,
  CandidateViewState,
} from '../../state/candidate-state.js';
import { CandidatesPanel } from './CandidatesPanel.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = Date.parse('2030-10-09T03:00:00.000Z');

const entry = (
  n: number,
  overrides: Partial<DesktopCandidateEntry> = {},
): DesktopCandidateEntry => ({
  ref: id(n),
  position: n,
  kind: 'mail_reply',
  state: 'new',
  title: `合成の気づき ${n}`,
  deadline: { kind: 'none' },
  initial_import: false,
  unread_partial: false,
  has_operations: false,
  delivery_unknown: false,
  ...overrides,
});

const view = (
  entries: DesktopCandidateEntry[],
  overrides: Partial<DesktopCandidateView> = {},
): DesktopCandidateView => ({
  fetch: 'loaded',
  fetched_at: '2030-10-09T03:00:00Z',
  zone: 'Asia/Tokyo',
  counts: { new: 2, seen: 1, acted: 1, dismissed: 0, snoozed: 0, resolved: 0 },
  entries,
  truncated: false,
  list_seq: 2,
  ...overrides,
});

const ENTRIES = [
  entry(0, {
    kind: 'schedule_overlap',
    title: '予定の重複：定例と面談',
    deadline: {
      kind: 'instant',
      local_datetime: '2030-10-09T15:00:00',
      zone: 'Asia/Tokyo',
      original_text: '15:00',
    },
  }),
  entry(1, {
    title: '参加可否の返信：10/10まで',
    deadline: { kind: 'date', date: '2030-10-10', original_text: '10/10' },
    unread_partial: true,
    has_operations: true,
  }),
  entry(2, {
    kind: 'mail_deadline',
    state: 'acted',
    title: '見積の提出',
    deadline: { kind: 'date', date: '2030-10-14', original_text: '10/14' },
  }),
  entry(3, {
    state: 'seen',
    title: '過去の依頼',
    initial_import: true,
    deadline: { kind: 'date', date: '2030-09-01', original_text: '9/1' },
  }),
];

const noop = () => undefined;
const ACTIONS: CandidateActions = {
  refresh: noop,
  open: noop,
  dismiss: noop,
  startSnooze: noop,
  cancelSnooze: noop,
  setSnoozeInput: noop,
  snooze: noop,
};

const render = (node: ReactNode) =>
  renderToStaticMarkup(<AppProviders>{node}</AppProviders>);

const panel = (state: Partial<CandidateViewState>) =>
  render(
    <CandidatesPanel
      state={{ ...INITIAL_CANDIDATE_STATE, ...state }}
      actions={ACTIONS}
      now={NOW}
    />,
  );

// 文字だけ（タグを除く）。
const text = (html: string) => html.replace(/<[^>]+>/gu, ' ');

test('nothing read yet says so and never says there are no candidates', () => {
  const html = text(panel({}));
  assert.match(html, /気づき/u);
  assert.match(html, /まだ取得できていません/u);
  assert.doesNotMatch(html, /気づきはありません/u);
  assert.doesNotMatch(html, /最終取得/u);
});

test('the header shows the last fetch in the person zone, the fetch state and the new count', () => {
  const html = text(panel({ view: view(ENTRIES), seq: 2 }));
  assert.match(html, /気づき（新着 2\u00a0件）/u);
  assert.match(html, /取得できています/u);
  assert.match(html, /最終取得 10\/9 12:00/u);
  const stale = text(
    panel({ view: view(ENTRIES, { fetch: 'stale' }), seq: 2 }),
  );
  assert.match(stale, /最新の取得に失敗しました。前回の内容を表示しています/u);
  assert.match(stale, /最終取得 10\/9 12:00/u);
});

test('rows are grouped under the headings with the deadline, kind, state and notes', () => {
  const html = panel({ view: view(ENTRIES), seq: 2 });
  const words = text(html);
  // 見出しの順（今日・明日・それ以降・初回取り込み）。
  const order = [
    '今日（1\u00a0件）',
    '明日（1\u00a0件）',
    'それ以降（1\u00a0件）',
    '初回取り込み（過去の期限）（1\u00a0件）',
  ].map((label) => words.indexOf(label));
  assert(
    order.every((index) => index >= 0),
    String(order),
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  assert.match(words, /10\/10（日付のみの期限）/u);
  assert.doesNotMatch(words, /23:59/u);
  assert.match(words, /10\/9 15:00/u);
  assert.match(words, /予定の重複/u);
  assert.match(words, /返信の依頼/u);
  assert.match(words, /新着/u);
  assert.match(words, /対応済み/u);
  // 注記（メールの候補は常に「対応済みかは未確認」、一部未読、自動実行の操作）。予定の重複には出さない。
  assert.match(words, /対応済みかは未確認/u);
  assert.match(words, /本文・添付の一部は未読/u);
  assert.match(words, /自動実行の操作があります/u);
  // 初回取り込みの過去の期限は折りたたみ（Disclosure）。
  assert.match(html, /data-heading="initial_import_past"/u);
  // 内部の ID・理由のコード・API の名前は出さない。相談する・根拠を見るはまだ出さない（ADR 0132）。
  for (const banned of [
    'candidate_id',
    'preview_stale',
    '/v1/',
    'expected_state',
    '相談する',
    '根拠を見る',
  ])
    assert(!words.includes(banned), banned);
});

test('buttons follow the state: new can be opened; acted has none', () => {
  const html = panel({ view: view(ENTRIES), seq: 2 });
  assert.match(html, /aria-label="開く（参加可否の返信：10\/10まで）"/u);
  assert.doesNotMatch(html, /aria-label="開く（過去の依頼）"/u);
  assert.match(html, /aria-label="今回は扱わない（過去の依頼）"/u);
  assert.match(html, /aria-label="再通知（過去の依頼）"/u);
  assert.doesNotMatch(html, /（見積の提出）"/u);
});

test('a row with an unknown outcome shows the hold and no buttons', () => {
  const html = panel({
    view: view([entry(1, { delivery_unknown: true, title: '保留の行' })]),
    seq: 2,
  });
  assert.match(text(html), /結果を確認できませんでした/u);
  assert.doesNotMatch(html, /（保留の行）"/u);
});

test('an empty loaded list says there are none; a cut list says it is partial', () => {
  assert.match(
    text(panel({ view: view([]), seq: 2 })),
    /今は気づきはありません。/u,
  );
  assert.match(
    text(panel({ view: view(ENTRIES, { truncated: true }), seq: 2 })),
    /一部だけを表示しています/u,
  );
});

test('without the person zone the list is flat and says why', () => {
  const words = text(panel({ view: view(ENTRIES, { zone: null }), seq: 2 }));
  assert.match(words, /見出しで分けずに表示しています/u);
  assert.doesNotMatch(words, /今日（/u);
});

test('the snooze choices show the times in the person zone', () => {
  const words = text(
    panel({
      view: view(ENTRIES),
      seq: 2,
      snooze: { ref: id(1), input: '', problem: null },
    }),
  );
  assert.match(words, /明日（同じ時刻） 10\/10 12:00/u);
  assert.match(words, /来週（同じ時刻） 10\/16 12:00/u);
  assert.match(words, /再通知する日時（Asia\/Tokyo）/u);
});
