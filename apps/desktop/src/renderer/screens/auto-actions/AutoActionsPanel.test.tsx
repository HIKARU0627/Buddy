// 自動実行の欄（AutoActionsPanel。B13-05、ADR 0154）の試験。サーバー描画（react-dom/server）で、頭の取得状態と最終取得、
// 安全停止の欄（止まっている・動いている・確かめられていない）、解除の確かめ、行（種類・経過・取り消しの状態）と
// 「取り消す」の出し分け、未取得を「自動で行った操作はありません」「動いています」と言わないこと、内部の ID・理由の
// コードを出さないことを確かめる。期待値は手で書く（基準の時刻は 2030-10-09T03:00:00Z）。
// 実際の見た目・クリックは Electron の画面で確かめる（未実施）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DesktopAutoActionEntry,
  DesktopAutoActionView,
} from '@buddy/contracts';
import { AppProviders } from '../../app/AppProviders.js';
import {
  INITIAL_AUTO_ACTION_STATE,
  SAFETY_PLACE,
} from '../../state/auto-action-state.js';
import type {
  AutoActionActions,
  AutoActionViewState,
} from '../../state/auto-action-state.js';
import { AutoActionsPanel } from './AutoActionsPanel.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = Date.parse('2030-10-09T03:00:00.000Z');
const SAFETY_REF = id(0x50);

const entry = (
  n: number,
  overrides: Partial<DesktopAutoActionEntry> = {},
): DesktopAutoActionEntry => ({
  ref: id(n),
  position: n,
  kind: 'label_mail',
  completed_at: '2030-10-08T02:00:00Z',
  undo_state: 'available',
  undo_deadline: '2030-11-07T02:00:00Z',
  delivery_unknown: false,
  ...overrides,
});

const view = (
  entries: DesktopAutoActionEntry[],
  overrides: Partial<DesktopAutoActionView> = {},
): DesktopAutoActionView => ({
  fetch: 'loaded',
  fetched_at: '2030-10-09T02:55:00Z',
  safety: {
    ref: SAFETY_REF,
    state: 'running',
    stop_reason: null,
    stopped_at: null,
  },
  entries,
  list_seq: 2,
  ...overrides,
});

const STOPPED = {
  ref: SAFETY_REF,
  state: 'stopped',
  stop_reason: 'same_target_repeated',
  stopped_at: '2030-10-09T01:00:00Z',
} as const;

const noop = () => undefined;
const ACTIONS: AutoActionActions = {
  refresh: noop,
  reload: noop,
  undo: noop,
  startResume: noop,
  cancelResume: noop,
  resume: noop,
};

const render = (node: ReactNode) =>
  renderToStaticMarkup(<AppProviders>{node}</AppProviders>);

const panel = (state: Partial<AutoActionViewState>) =>
  render(
    <AutoActionsPanel
      state={{ ...INITIAL_AUTO_ACTION_STATE, ...state }}
      actions={ACTIONS}
      now={NOW}
    />,
  );

// 文字だけ（タグを除く）。
const text = (html: string) => html.replace(/<[^>]+>/gu, ' ');
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gu)].map((match) =>
    text(match[1] ?? '').trim(),
  );

test('nothing read yet says so and never says there is nothing or that it is running', () => {
  const html = text(panel({}));
  assert.match(html, /自動実行/u);
  assert.match(html, /まだ取得できていません/u);
  assert.doesNotMatch(html, /自動で行った操作はありません/u);
  assert.doesNotMatch(html, /動いています/u);
  assert.doesNotMatch(html, /最終取得/u);
});

test('a loaded empty list says there is nothing and that auto execution is running', () => {
  const html = text(panel({ view: view([]), seq: 2 }));
  assert.match(html, /取得できています/u);
  assert.match(html, /最終取得 5\u00a0分前/u);
  assert.match(html, /自動実行は動いています。/u);
  assert.match(html, /自動で行った操作はありません。/u);
});

test('rows show the kind, how long ago, the undo state, and the undo button only when it can be undone', () => {
  const html = panel({
    view: view([
      entry(0),
      entry(1, {
        kind: 'create_task',
        completed_at: '2030-10-06T03:00:00Z',
        undo_state: 'unavailable',
      }),
      entry(2, { kind: 'draft_reply', undo_state: 'target_changed' }),
      entry(3, { delivery_unknown: true }),
    ]),
    seq: 2,
  });
  const words = text(html);
  for (const expected of [
    'メールのラベル付け',
    '実行 1\u00a0日前',
    '取り消せます（あと\u00a028\u00a0日）',
    'タスクの登録',
    '実行 3\u00a0日前',
    'この操作は今は取り消せません',
    '返信の下書きの保存',
    'その後に変わったため、自動では元に戻しません',
    '取り消しの結果を確認できませんでした',
  ])
    assert(words.includes(expected), expected);
  assert.deepEqual(
    buttons(html).filter((label) => label === '取り消す'),
    ['取り消す'],
  );
  // 画面の文言に内部のコードは出さず、参照の値は属性にも出さない。
  assert.doesNotMatch(words, /target_changed|unavailable|label_mail/u);
  assert.doesNotMatch(html, new RegExp(SAFETY_REF, 'u'));
  // 取り消せない下書き・タスクの行には、削除の説明を出さない。
  assert.doesNotMatch(words, /下書きを削除します/u);
  assert.doesNotMatch(words, /タスクを削除します/u);
});

test('a draft that can be undone says the undo deletes the draft Buddy made; a label row does not (ADR 0156)', () => {
  const words = text(
    panel({
      view: view([entry(0, { kind: 'draft_reply' }), entry(1)]),
      seq: 2,
    }),
  );
  const effect = '取り消すと、Buddy が作った下書きを削除します。';
  assert.equal(words.split(effect).length - 1, 1);
  assert(
    buttons(
      panel({ view: view([entry(0, { kind: 'draft_reply' })]), seq: 2 }),
    ).includes('取り消す'),
  );
});

test('a task that can be undone says the undo deletes the task Buddy registered (ADR 0157)', () => {
  const html = panel({
    view: view([entry(0, { kind: 'create_task' }), entry(1)]),
    seq: 2,
  });
  const words = text(html);
  const effect = '取り消すと、Buddy が登録したタスクを削除します。';
  assert.equal(words.split(effect).length - 1, 1);
  assert.deepEqual(
    buttons(html).filter((label) => label === '取り消す'),
    ['取り消す', '取り消す'],
  );
});

test('an event row says the undo deletes the event Buddy made only when the hub offers the undo (ADR 0198)', () => {
  const effect = '取り消すと、Buddy が作った予定を削除します。';
  // 中枢が取り消しを開いたとき（製品では閉じている）。
  const open = text(
    panel({ view: view([entry(0, { kind: 'create_event' })]), seq: 2 }),
  );
  assert.match(open, /予定の作成/u);
  assert.equal(open.split(effect).length - 1, 1);
  // 製品の既定（取り消せない）では、削除の説明もボタンも出さない。
  const closed = panel({
    view: view([entry(0, { kind: 'create_event', undo_state: 'unavailable' })]),
    seq: 2,
  });
  assert.doesNotMatch(text(closed), /予定を削除します/u);
  assert.deepEqual(
    buttons(closed).filter((label) => label === '取り消す'),
    [],
  );
});

test('a stop shows its reason, when it stopped and the resume button; confirming asks first', () => {
  const stopped = panel({ view: view([], { safety: STOPPED }), seq: 2 });
  const words = text(stopped);
  assert.match(words, /自動実行を止めています（安全停止）/u);
  assert.match(words, /同じ対象への自動実行が続いたため、止めました。/u);
  assert.match(words, /停止 2\u00a0時間前/u);
  assert.doesNotMatch(words, /動いています/u);
  assert.deepEqual(
    buttons(stopped).filter((label) => label !== '読み直す'),
    ['自動実行を再開する'],
  );
  const confirming = panel({
    view: view([], { safety: STOPPED }),
    seq: 2,
    confirming: SAFETY_REF,
  });
  assert.match(
    text(confirming),
    /再開すると、方針で許した操作を、また自動で行うようになります。再開しますか。/u,
  );
  assert.deepEqual(
    buttons(confirming).filter((label) => label !== '読み直す'),
    ['やめる', '再開する'],
  );
  const busy = panel({
    view: view([], { safety: STOPPED }),
    seq: 2,
    confirming: SAFETY_REF,
    busy: SAFETY_PLACE,
    notice: null,
  });
  assert(buttons(busy).includes('再開しています…'));
});

test('a stale read keeps the last values and says the read failed; an unread safety is not shown as running', () => {
  const html = text(
    panel({ view: view([entry(0)], { fetch: 'stale', safety: null }), seq: 2 }),
  );
  assert.match(html, /最新の取得に失敗しました。前回の内容を表示しています/u);
  assert.match(html, /安全停止の状態を確かめられていません。/u);
  assert.doesNotMatch(html, /動いています/u);
  assert.match(html, /メールのラベル付け/u);
});

test('notices appear where they belong: the head, the safety block or the row', () => {
  const html = text(
    panel({
      view: view([entry(0)], { safety: STOPPED }),
      seq: 2,
      notice: { tone: 'warning', text: '行の知らせ', place: id(0) },
    }),
  );
  assert.match(html, /行の知らせ/u);
  const safety = panel({
    view: view([], { safety: STOPPED }),
    seq: 2,
    notice: { tone: 'warning', text: '停止の知らせ', place: SAFETY_PLACE },
  });
  assert.match(safety, /role="alert"[^>]*>[\s\S]*停止の知らせ/u);
});
