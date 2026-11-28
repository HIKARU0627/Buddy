// 気づきの欄（CandidatesPanel。B11-05、ADR 0132）の試験。サーバー描画（react-dom/server）で、頭の最終取得時刻・取得状態・新着
// の件数、見出し、行（題・期限・種類・状態・注記）、操作のボタンの出し分け、未取得を「気づきはありません」と言わないこと、
// 理由のコード・内部の ID を出さないことを確かめる。期待値は手で書く（基準は 2030-10-09（水）12:00 JST = 03:00Z）。
// 実際の見た目・クリックは Electron の画面で確かめる（未実施）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DesktopAutoActionEntry,
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
  auto_actions: [],
  auto_actions_unlisted: 0,
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
  alert: null,
  auto_action_fetch: 'loaded',
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
    auto_actions_unlisted: 1,
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
  reload: noop,
  open: noop,
  dismiss: noop,
  startSnooze: noop,
  cancelSnooze: noop,
  setSnoozeInput: noop,
  snooze: noop,
  setAlert: noop,
  undoAutoAction: noop,
  showEvidence: noop,
  hideEvidence: noop,
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
  // 注記（メールの候補は常に「対応済みかは未確認」、一部未読）。予定の重複には出さない。自動実行の操作は行の中の欄で出す。
  assert.match(words, /対応済みかは未確認/u);
  assert.match(words, /本文・添付の一部は未読/u);
  assert.match(words, /この気づきから自動で行った操作/u);
  assert.equal(words.split('この気づきから自動で行った操作').length - 1, 1);
  // 初回取り込みの過去の期限は折りたたみ（Disclosure）。
  assert.match(html, /data-heading="initial_import_past"/u);
  // 内部の ID・理由のコード・API の名前は出さない。相談するはまだ出さない（ADR 0132）。根拠を見る（ADR 0201）は行ごと。
  for (const banned of [
    'candidate_id',
    'preview_stale',
    '/v1/',
    'expected_state',
    'source_id',
    '相談する',
  ])
    assert(!words.includes(banned), banned);
  assert.equal(words.split('根拠を見る').length - 1, ENTRIES.length);
});

test('buttons follow the state: new can be opened; acted has only the evidence', () => {
  const html = panel({ view: view(ENTRIES), seq: 2 });
  assert.match(html, /aria-label="開く（参加可否の返信：10\/10まで）"/u);
  assert.doesNotMatch(html, /aria-label="開く（過去の依頼）"/u);
  assert.match(html, /aria-label="今回は扱わない（過去の依頼）"/u);
  assert.match(html, /aria-label="再通知（過去の依頼）"/u);
  // 根拠を見る（ADR 0201）は状態を変えないので、対応済みの行にも出す。
  assert.match(html, /aria-label="根拠を見る（見積の提出）"/u);
  assert.doesNotMatch(
    html,
    /aria-label="(開く|今回は扱わない|再通知)（見積の提出）"/u,
  );
});

test('a row with an unknown outcome shows the hold and no buttons', () => {
  const html = panel({
    view: view([entry(1, { delivery_unknown: true, title: '保留の行' })]),
    seq: 2,
  });
  assert.match(text(html), /結果を確認できませんでした/u);
  assert.doesNotMatch(html, /（保留の行）"/u);
});

test('the evidence of the open row shows the quotes it was given, and an unconfirmed one says so without quotes (ADR 0201)', () => {
  const ref = id(0);
  const shown = (
    evidence: CandidateViewState['evidence'],
  ): { readonly html: string; readonly body: string } => {
    const html = panel({ view: view(ENTRIES), seq: 2, evidence });
    return { html, body: text(html) };
  };
  const confirmed = shown({
    ref,
    loading: false,
    problem: null,
    view: {
      ref,
      status: 'confirmed',
      quotes: ['合成の打ち合わせ', '合成の通院'],
      unread: false,
      excerpt: null,
    },
  });
  assert.match(confirmed.body, /元の情報から取り直した根拠です/u);
  assert.match(confirmed.body, /「合成の打ち合わせ」/u);
  assert.match(confirmed.body, /「合成の通院」/u);
  assert.match(
    confirmed.html,
    /aria-label="根拠を閉じる（予定の重複：定例と面談）"/u,
  );
  assert.match(confirmed.html, /data-evidence="confirmed"/u);
  // 引用を照合できなかった・一部未読・抄録。
  const noQuote = shown({
    ref,
    loading: false,
    problem: null,
    view: {
      ref,
      status: 'confirmed',
      quotes: [],
      unread: true,
      excerpt: '明日までにご返信ください',
    },
  }).body;
  assert.match(noQuote, /引用の位置は示せません/u);
  assert.match(noQuote, /元の情報の一部は未読です/u);
  assert.match(noQuote, /気づきを作ったときの抄録: 明日までにご返信ください/u);
  // 未確認・変わった: 引用を出さない。
  for (const [status, words] of [
    ['unconfirmed', /根拠を確かめられませんでした（未確認）/u],
    ['changed', /根拠の元が変わったか、気づきの状態が変わりました（未確認）/u],
  ] as const) {
    const body = shown({
      ref,
      loading: false,
      problem: null,
      view: { ref, status, quotes: [], unread: null, excerpt: null },
    }).body;
    assert.match(body, words);
    assert.doesNotMatch(body, /根拠の引用|「合成/u);
  }
  // 取り直している間。
  const loading = shown({ ref, loading: true, problem: null, view: null });
  assert.match(loading.body, /元の情報から根拠を取り直しています/u);
  assert.match(loading.html, /data-evidence="loading"/u);
  // ほかの行には出さない。
  assert.doesNotMatch(
    shown({ ref: id(9), loading: true, problem: null, view: null }).body,
    /取り直しています/u,
  );
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

// OS の通知の入・切（ADR 0196）。読めていない間は選択を置かず「切」と言わない。入・切は選択の状態で示し、版は出さない。
test('the OS notification choice shows the setting, says what the notification carries and hides while unread', () => {
  const unread = panel({ view: view(ENTRIES), seq: 2 });
  assert.match(unread, /data-candidate-alert="unavailable"/u);
  assert.match(text(unread), /OS の通知の設定をまだ読めていません/u);
  assert.doesNotMatch(unread, /新しい気づきを OS の通知で知らせる/u);
  // 一覧を読む前（view が null）は何も出さない。
  assert.doesNotMatch(panel({}), /data-candidate-alert/u);
  const off = panel({
    view: view(ENTRIES, {
      alert: {
        ref: '00000000-0000-4000-8000-0000000000a1',
        os_notification: 'off',
      },
    }),
    seq: 2,
  });
  assert.match(off, /data-candidate-alert="off"/u);
  assert.match(text(off), /新しい気づきを OS の通知で知らせる/u);
  assert.match(text(off), /題・差出人・本文は通知に出しません/u);
  assert.doesNotMatch(off, /00000000-0000-4000-8000-0000000000a1/u);
  const on = panel({
    view: view(ENTRIES, {
      alert: {
        ref: '00000000-0000-4000-8000-0000000000a1',
        os_notification: 'on',
      },
    }),
    seq: 2,
    alertBusy: true,
  });
  assert.match(on, /data-candidate-alert="on"/u);
  assert.match(text(on), /設定を送っています…/u);
});

// 候補に結び付いた自動実行の結果と取り消し（ADR 0199）。基準 NOW は 2030-10-09T03:00:00Z。
const auto = (
  n: number,
  overrides: Partial<DesktopAutoActionEntry> = {},
): DesktopAutoActionEntry => ({
  ref: id(0x900 + n),
  position: n,
  kind: 'label_mail',
  completed_at: '2030-10-09T02:00:00Z',
  undo_state: 'available',
  undo_deadline: '2030-10-19T02:00:00Z',
  delivery_unknown: false,
  ...overrides,
});

const linkedRow = (
  autos: DesktopAutoActionEntry[],
  unlisted = 0,
): DesktopCandidateEntry =>
  entry(1, {
    title: '連絡の返信',
    has_operations: true,
    auto_actions: autos,
    auto_actions_unlisted: unlisted,
  });

const undoButton = (html: string, kind: string): string | null =>
  new RegExp(
    `<button[^>]*aria-label="取り消す（${kind}・連絡の返信）"[^>]*>`,
    'u',
  ).exec(html)?.[0] ?? null;

test('a candidate shows its automatic operations: an undoable one can be pressed, an unavailable one cannot', () => {
  const html = panel({
    view: view([
      linkedRow(
        [
          auto(0),
          auto(1, {
            kind: 'draft_reply',
            completed_at: '2030-10-08T03:00:00Z',
            undo_state: 'unavailable',
          }),
          auto(2, { kind: 'create_task', undo_state: 'undone' }),
        ],
        2,
      ),
      entry(2, { title: '結び付きのない気づき' }),
    ]),
    seq: 2,
  });
  const words = text(html);
  // 欄は結び付いた操作のある行だけ。
  assert.equal(words.split('この気づきから自動で行った操作').length - 1, 1);
  assert.match(words, /メールのラベル付け/u);
  assert.match(words, /実行 1\u00a0時間前/u);
  // 期限 10-19T02:00Z まで 9 日 23 時間（日は切り捨て）。
  assert.match(words, /取り消せます（あと\u00a09\u00a0日）/u);
  const available = undoButton(html, 'メールのラベル付け');
  assert(available !== null);
  assert.doesNotMatch(available, /disabled/u);
  // 取り消せない（unavailable）は押せないボタンと理由。
  assert.match(words, /返信の下書きの保存/u);
  assert.match(words, /この操作は今は取り消せません/u);
  const blocked = undoButton(html, '返信の下書きの保存');
  assert(blocked !== null);
  assert.match(blocked, /disabled/u);
  // 削除で戻すことの説明は取り消せる行だけ（下書きは取り消せないので出さない）。
  assert.doesNotMatch(words, /Buddy が作った下書きを削除します/u);
  // 取り消し済みは文言だけで、ボタンを出さない。
  assert.match(words, /取り消しました/u);
  assert.equal(undoButton(html, 'タスクの登録'), null);
  // 一覧に無い操作は件数だけ。
  assert.match(
    words,
    /ほかに 2\u00a0件の操作は、結果をこの欄では確かめられません/u,
  );
  // 操作 ID・自動実行の参照の値・理由のコードは文字として出さない。
  for (const banned of ['operation_id', 'unavailable', 'undo_state', id(0x900)])
    assert(!words.includes(banned), banned);
});

test('an expired, unknown or busy automatic operation cannot be pressed; the list state is told when unread or stale', () => {
  const expired = panel({
    view: view([
      linkedRow([
        auto(0, { undo_deadline: '2030-10-09T02:59:00Z' }),
        auto(1, { kind: 'create_task', delivery_unknown: true }),
      ]),
    ]),
    seq: 2,
  });
  // 中枢が取り消せると返しても、画面の時計で期限を過ぎていれば押させない。
  assert.match(text(expired), /取り消しの期限を過ぎました/u);
  assert.match(undoButton(expired, 'メールのラベル付け') ?? '', /disabled/u);
  // 取り消しの結果が分からない操作はボタンを出さない。
  assert.match(text(expired), /取り消しの結果を確認できませんでした/u);
  assert.equal(undoButton(expired, 'タスクの登録'), null);
  // 取り消しを送っている間は、押した行が「取り消しています…」で、どれも押せない。
  const busy = panel({
    view: view([linkedRow([auto(0), auto(1, { kind: 'create_task' })])]),
    seq: 2,
    busy: id(0x900),
  });
  assert.match(text(busy), /取り消しています…/u);
  assert.match(undoButton(busy, 'タスクの登録') ?? '', /disabled/u);
  assert.match(text(busy), /Buddy が登録したタスクを削除します/u);
  const unread = text(
    panel({
      view: view([linkedRow([], 3)], { auto_action_fetch: 'unavailable' }),
      seq: 2,
    }),
  );
  // 読めていないときは「読めていません」だけで、件数の文言は出さない（ADR 0199）。
  assert.match(unread, /自動実行の結果をまだ読めていません/u);
  assert.doesNotMatch(unread, /ほかに/u);
  const stale = text(
    panel({
      view: view([linkedRow([auto(0)])], { auto_action_fetch: 'stale' }),
      seq: 2,
    }),
  );
  assert.match(stale, /自動実行の最新の取得に失敗しました/u);
});
