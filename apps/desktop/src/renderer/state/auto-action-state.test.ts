// 自動実行の画面の状態（auto-action-state.ts。B13-05、ADR 0154）の試験。期待値は手で書く（基準の時刻は
// 2030-10-09T03:00:00Z）。経過と残りを OS のタイムゾーンに依らずに書くこと、取り消せる行の出し分け、未取得を
// 「自動実行なし」「動いている」にしないこと、解除は確かめてから表示中の停止の参照で送ること、拒否で読み直すこと、世代を
// またいだ応答を捨てることを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DesktopAutoActionEntry,
  DesktopAutoActionView,
  DesktopIpcRequest,
  DesktopIpcResponse,
} from '@buddy/contracts';
import {
  AutoActionStore,
  INITIAL_AUTO_ACTION_STATE,
  SAFETY_PLACE,
  applyListResponse,
  canUndo,
  elapsedText,
  remainingText,
  safetyShown,
  undoStateText,
} from './auto-action-state.js';

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
  fetched_at: '2030-10-09T03:00:00Z',
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
  stop_reason: 'rate_exceeded',
  stopped_at: '2030-10-09T02:30:00Z',
} as const;

test('elapsed and remaining times are written without a time zone', () => {
  assert.equal(elapsedText('2030-10-09T02:59:30Z', NOW), 'たった今');
  assert.equal(elapsedText('2030-10-09T02:35:00Z', NOW), '25\u00a0分前');
  assert.equal(elapsedText('2030-10-08T22:00:00Z', NOW), '5\u00a0時間前');
  assert.equal(elapsedText('2030-10-06T02:00:00Z', NOW), '3\u00a0日前');
  // 時計が戻っていて先の時刻でも、先の時刻を「〜前」と書かない。
  assert.equal(elapsedText('2030-10-09T04:00:00Z', NOW), 'たった今');
  assert.equal(elapsedText(null, NOW), null);
  assert.equal(elapsedText('not a time', NOW), null);
  assert.equal(
    remainingText('2030-10-21T04:00:00Z', NOW),
    'あと\u00a012\u00a0日',
  );
  assert.equal(
    remainingText('2030-10-09T08:30:00Z', NOW),
    'あと\u00a05\u00a0時間',
  );
  assert.equal(
    remainingText('2030-10-09T03:20:00Z', NOW),
    'あと\u00a01\u00a0時間未満',
  );
  assert.equal(remainingText('2030-10-09T03:00:00Z', NOW), null);
});

test('each undo state has its own words and only an available row in time can be undone', () => {
  assert.equal(
    undoStateText(entry(1), NOW),
    '取り消せます（あと\u00a028\u00a0日）',
  );
  assert.equal(canUndo(entry(1), NOW), true);
  // 中枢が取り消せると返しても、画面の時計で期限を過ぎていればボタンを出さない。
  const late = entry(1, { undo_deadline: '2030-10-09T02:00:00Z' });
  assert.equal(undoStateText(late, NOW), '取り消しの期限を過ぎました');
  assert.equal(canUndo(late, NOW), false);
  assert.equal(canUndo(entry(1, { delivery_unknown: true }), NOW), false);
  const words: Record<DesktopAutoActionEntry['undo_state'], string> = {
    available: '取り消せます（あと\u00a028\u00a0日）',
    target_changed: 'その後に変わったため、自動では元に戻しません',
    expired: '取り消しの期限を過ぎました',
    in_progress: '取り消しています',
    undone: '取り消しました',
    unavailable: 'この操作は今は取り消せません',
  };
  for (const [state, text] of Object.entries(words)) {
    const row = entry(1, {
      undo_state: state as DesktopAutoActionEntry['undo_state'],
    });
    assert.equal(undoStateText(row, NOW), text, state);
    assert.equal(canUndo(row, NOW), state === 'available', state);
  }
});

test('the safety block reads unknown until a read, then running or the stop with its reason', () => {
  assert.deepEqual(safetyShown(null, NOW), { kind: 'unknown' });
  assert.deepEqual(safetyShown(view([], { safety: null }), NOW), {
    kind: 'unknown',
  });
  assert.deepEqual(safetyShown(view([]), NOW), { kind: 'running' });
  assert.deepEqual(safetyShown(view([], { safety: STOPPED }), NOW), {
    kind: 'stopped',
    ref: SAFETY_REF,
    reason: '短い間に自動で行った操作が上限を超えたため、止めました。',
    stoppedText: '30\u00a0分前',
  });
  assert.deepEqual(
    safetyShown(
      view([], {
        safety: {
          ...STOPPED,
          stop_reason: 'restored_from_backup',
          stopped_at: null,
        },
      }),
      NOW,
    ),
    {
      kind: 'stopped',
      ref: SAFETY_REF,
      reason:
        'バックアップから戻したため、再開するまで自動実行を止めています。',
      stoppedText: null,
    },
  );
});

test('an older list is not applied over a newer one', () => {
  const state = applyListResponse(
    { ...INITIAL_AUTO_ACTION_STATE, view: view([entry(1)]), seq: 5 },
    {
      request_id: id(1),
      channel: 'desktop.auto_actions_list',
      outcome: 'ok',
      auto_actions: view([], { list_seq: 4 }),
    },
  );
  assert.equal(state.seq, 5);
  assert.equal(state.view?.entries.length, 1);
});

interface Pending {
  readonly request: DesktopIpcRequest;
  readonly resolve: (response: DesktopIpcResponse) => void;
  readonly reject: (error: Error) => void;
}

function harness() {
  const pending: Pending[] = [];
  // 気づきの欄へ知らせた回数（ADR 0199）。
  const changes: number[] = [];
  const store = new AutoActionStore(
    {
      invoke: (request) =>
        new Promise<DesktopIpcResponse>((resolve, reject) => {
          pending.push({ request, resolve, reject });
        }),
    },
    () => changes.push(1),
  );
  const answer = async (response: Partial<DesktopIpcResponse>) => {
    const next = pending.shift();
    assert(next !== undefined, 'no pending request');
    next.resolve({
      request_id: next.request.request_id,
      channel: next.request.channel,
      ...response,
    } as DesktopIpcResponse);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { store, pending, answer, changes };
}

const listed = (v: DesktopAutoActionView) => ({
  outcome: 'ok' as const,
  auto_actions: v,
});

test('refresh asks main for the list and shows it; a rejection says why without emptying the list', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  assert.equal(store.snapshot().reading, true);
  assert.equal(pending[0]?.request.channel, 'desktop.auto_actions_list');
  assert.equal(pending[0]?.request.payload, null);
  await answer(listed(view([entry(1)])));
  assert.equal(store.snapshot().reading, false);
  assert.equal(store.snapshot().view?.entries.length, 1);
  store.actions.refresh();
  await answer({ outcome: 'rejected', reason: 'not_connected' });
  assert.equal(store.snapshot().view?.entries.length, 1);
  assert.deepEqual(store.snapshot().notice, {
    tone: 'warning',
    text: '中枢に接続していないため、自動実行の一覧を読めません。接続してから「読み直す」を押してください。',
    place: null,
  });
});

test('undo sends only the ref, shows the accepted notice on the row and blocks a second press', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(listed(view([entry(1), entry(2)])));
  store.actions.undo(id(1));
  assert.equal(store.snapshot().busy, id(1));
  assert.deepEqual(pending[0]?.request.payload, { ref: id(1) });
  assert.equal(pending[0]?.request.channel, 'desktop.auto_action_undo');
  store.actions.undo(id(2));
  assert.equal(pending.length, 1);
  await answer(
    listed(
      view([entry(1, { undo_state: 'in_progress' }), entry(2)], {
        list_seq: 3,
      }),
    ),
  );
  const state = store.snapshot();
  assert.equal(state.busy, null);
  assert.equal(state.view?.entries[0]?.undo_state, 'in_progress');
  assert.deepEqual(state.notice, {
    tone: 'success',
    text: '取り消しを受け付けました。元に戻ったかは、この一覧で確かめられます。',
    place: id(1),
  });
});

test('a changed target keeps its own words on the row and the list is read again', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(listed(view([entry(1)])));
  store.actions.undo(id(1));
  await answer({ outcome: 'rejected', reason: 'undo_target_changed' });
  assert.deepEqual(store.snapshot().notice, {
    tone: 'warning',
    text: '対象がその後に変わっていたため、自動では元に戻しませんでした。必要なら、元のアプリで直してください。',
    place: id(1),
  });
  assert.equal(pending[0]?.request.channel, 'desktop.auto_actions_list');
  await answer(listed(view([entry(1)], { list_seq: 4 })));
  // 読み直しても行の文言は残る。
  assert.equal(store.snapshot().notice?.place, id(1));
  assert.equal(store.snapshot().seq, 4);
});

test('resume asks first, sends the shown stop ref, and a newer stop closes the question', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(listed(view([], { safety: STOPPED })));
  // 確かめを出す前は送らない。
  store.actions.resume();
  assert.equal(pending.length, 0);
  store.actions.startResume();
  assert.equal(store.snapshot().confirming, SAFETY_REF);
  store.actions.cancelResume();
  assert.equal(store.snapshot().confirming, null);
  store.actions.startResume();
  // 確かめている間に読み直して、停止の版が変わった（参照が変わった）: 確かめをしまう。
  store.actions.refresh();
  await answer(
    listed(view([], { safety: { ...STOPPED, ref: id(0x51) }, list_seq: 3 })),
  );
  assert.equal(store.snapshot().confirming, null);
  store.actions.startResume();
  store.actions.resume();
  assert.deepEqual(pending[0]?.request.payload, { ref: id(0x51) });
  assert.equal(pending[0]?.request.channel, 'desktop.safety_resume');
  assert.equal(store.snapshot().busy, SAFETY_PLACE);
  await answer(listed(view([], { list_seq: 4 })));
  const state = store.snapshot();
  assert.equal(state.confirming, null);
  assert.equal(state.view?.safety?.state, 'running');
  assert.deepEqual(state.notice, {
    tone: 'success',
    text: '自動実行を再開しました。',
    place: SAFETY_PLACE,
  });
});

test('a stale resume says the stop changed and reads again', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(listed(view([], { safety: STOPPED })));
  store.actions.startResume();
  store.actions.resume();
  await answer({ outcome: 'rejected', reason: 'preview_stale' });
  assert.deepEqual(store.snapshot().notice, {
    tone: 'warning',
    text: '安全停止の状態が変わっていました。一覧を読み直したので、今の状態を確かめてください。',
    place: SAFETY_PLACE,
  });
  assert.equal(store.snapshot().confirming, null);
  assert.equal(pending[0]?.request.channel, 'desktop.auto_actions_list');
});

test('a failed IPC call says so in place, and hide drops content and late answers', async () => {
  const { store, pending, answer } = harness();
  store.actions.refresh();
  await answer(listed(view([entry(1)])));
  store.actions.undo(id(1));
  pending.shift()?.reject(new Error('ipc'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.snapshot().busy, null);
  assert.equal(store.snapshot().notice?.place, id(1));
  store.actions.refresh();
  store.hide();
  await answer(listed(view([entry(1)], { list_seq: 9 })));
  assert.deepEqual(store.snapshot(), INITIAL_AUTO_ACTION_STATE);
});

// 気づきの行の自動実行の写しを古いままにしない（ADR 0199）。
test('an undo and the person refresh tell the candidate panel; opening and its own re-read do not', async () => {
  const { store, pending, answer, changes } = harness();
  // 開いたとき・気づきの欄から頼まれた読み直し（reload）は知らせない（知らせ合いを繰り返さない）。
  store.actions.reload();
  await answer(listed(view([entry(1)])));
  assert.deepEqual(changes, []);
  // 本人の「読み直す」は、読めたら知らせる。
  store.actions.refresh();
  await answer(listed(view([entry(1)], { list_seq: 3 })));
  assert.deepEqual(changes, [1]);
  // 取り消しは、断られても知らせる。
  store.actions.undo(id(1));
  await answer({ outcome: 'rejected', reason: 'confirmation_pending' });
  assert.deepEqual(changes, [1, 1]);
  assert.equal(
    store.snapshot().notice?.text,
    'この操作の取り消しは送っている途中です。結果が出るまで待ってください。',
  );
  // ロック（hide）の後に届いた答えでは知らせない。
  store.actions.undo(id(1));
  store.hide();
  await answer({ outcome: 'rejected', reason: 'outcome_unknown' });
  assert.deepEqual(changes, [1, 1]);
  assert.equal(pending.length, 0);
});
