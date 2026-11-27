// 上の中央の島の表示を決める純粋な関数の試験（ADR 0181 の段階 2）。期待値の文言・優先の順・時間は手で書く。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopOperationEntry, DesktopStatusBar } from '@buddy/contracts';
import {
  EMPTY_ISLAND_MEMORY,
  ISLAND_ATTENTION_MS,
  ISLAND_RESULT_MS,
  NO_ISLAND_SIGNALS,
  islandView,
  nextIslandMemory,
} from './island-state.js';
import type { IslandResult, IslandSignals } from './island-state.js';
import type { Notice } from './work-state.js';

type Shown = Extract<DesktopStatusBar, { visibility: 'shown' }>;

const NOW = 1_000_000;

const shown = (
  stop_scope: Shown['stop_scope'] = 'none',
  extra: Partial<Shown> = {},
): Shown => ({
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope,
  input_permitted: stop_scope === 'none',
  io_epoch: '7',
  voice_state: null,
  hub_connection: 'not_connected',
  hub_last_confirmed_at: null,
  display_target: null,
  storage_mode: null,
  budget_held: null,
  safety_stopped: null,
  ...extra,
});

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const entry = (
  n: number,
  overrides: Partial<DesktopOperationEntry> = {},
): DesktopOperationEntry => ({
  ref: id(n),
  operation_kind: 'task.create',
  state: 'awaiting_approval',
  approval_state: 'none',
  allowed_actions: ['preview', 'approve', 'cancel'],
  result: null,
  state_revision: '1',
  delivery_unknown: false,
  headline: null,
  detail: null,
  ...overrides,
});

const result = (
  failure: boolean,
  at: number,
  announcedNearby = false,
): IslandResult => ({
  line: failure
    ? {
        tone: 'danger',
        mark: 'warning',
        text: '用事の登録: 結果を確認できませんでした',
      }
    : { tone: 'success', mark: 'dot', text: '用事の登録: 完了しました' },
  failure,
  at,
  announcedNearby,
});

const signals = (extra: Partial<IslandSignals>): IslandSignals => ({
  ...NO_ISLAND_SIGNALS,
  ...extra,
});

const view = (
  status: DesktopStatusBar | null,
  s: IslandSignals | null,
  holdingSince: number | null = null,
  now = NOW,
) => islandView({ status, connection: null, now, signals: s, holdingSince });

test('the island hides content until the status is known and while locked or unknown', () => {
  assert.deepEqual(view(null, null), {
    kind: 'hidden',
    text: '状態を確かめています。',
    icon: 'none',
  });
  assert.deepEqual(view({ visibility: 'hidden', lock_state: 'locked' }, null), {
    kind: 'hidden',
    text: '画面がロックされているため、内容を隠しています。',
    icon: 'info',
  });
  assert.deepEqual(
    view({ visibility: 'hidden', lock_state: 'unknown' }, null),
    {
      kind: 'hidden',
      text: 'ロック状態を確かめられないため、内容を隠しています。',
      icon: 'warning',
    },
  );
  // 結果と確認待ちが届いていても、ロック中は広げない（内容を出さない）。
  const busy = signals({
    attentionCount: 2,
    attentionRaisedAt: NOW,
    attentionRaisedCount: 2,
    result: result(true, NOW),
  });
  assert.equal(
    view({ visibility: 'hidden', lock_state: 'locked' }, busy).kind,
    'hidden',
  );
});

test('the small island always has the io line and the hub line, and stop only while not stopped', () => {
  const accepting = view(shown('none'), null);
  assert.equal(accepting.kind, 'shown');
  if (accepting.kind !== 'shown') return;
  assert.deepEqual(accepting.io, {
    tone: 'success',
    mark: 'dot',
    text: '受付中',
  });
  assert.deepEqual(accepting.hub, {
    tone: 'neutral',
    mark: 'none',
    text: '未接続',
  });
  assert.equal(accepting.stop, true);
  assert.equal(accepting.expanded, null);
  for (const scope of ['local', 'guest', 'global'] as const) {
    const stopped = view(shown(scope), null);
    assert.equal(stopped.kind === 'shown' && stopped.stop, false, scope);
  }
});

test('a new attention count opens the island with the count read politely for 8 seconds', () => {
  const s = signals({
    attentionCount: 2,
    attentionRaisedAt: NOW,
    attentionRaisedCount: 2,
  });
  const open = view(shown(), s, null, NOW + 7_999);
  assert.equal(open.kind, 'shown');
  if (open.kind !== 'shown') return;
  assert.deepEqual(open.expanded, {
    reason: 'attention',
    line: {
      tone: 'warning',
      mark: 'circle',
      text: '確認が必要な操作が2 件あります。',
    },
    live: 'status',
    openAttention: true,
  });
  const closed = view(shown(), s, null, NOW + 8_000);
  assert.equal(closed.kind === 'shown' && closed.expanded, null);
  assert.equal(ISLAND_ATTENTION_MS, 8_000);
});

test('a lower attention count than the raised one does not open the island', () => {
  const s = signals({
    attentionCount: 1,
    attentionRaisedAt: NOW,
    attentionRaisedCount: 2,
  });
  const v = view(shown(), s);
  assert.equal(v.kind === 'shown' && v.expanded, null);
});

test('results stay for 6 seconds; failures are alerts, others are status, nearby ones are not read', () => {
  assert.equal(ISLAND_RESULT_MS, 6_000);
  const failure = view(
    shown(),
    signals({ result: result(true, NOW) }),
    null,
    NOW + 5_999,
  );
  assert.equal(failure.kind === 'shown' && failure.expanded?.live, 'alert');
  const success = view(shown(), signals({ result: result(false, NOW) }));
  assert.equal(success.kind === 'shown' && success.expanded?.live, 'status');
  assert.equal(
    success.kind === 'shown' && success.expanded?.openAttention,
    false,
  );
  const nearby = view(shown(), signals({ result: result(false, NOW, true) }));
  assert.equal(nearby.kind === 'shown' && nearby.expanded?.reason, 'result');
  assert.equal(nearby.kind === 'shown' && nearby.expanded?.live, null);
  const old = view(
    shown(),
    signals({ result: result(true, NOW) }),
    null,
    NOW + 6_000,
  );
  assert.equal(old.kind === 'shown' && old.expanded, null);
});

test('the order is failure, then a new attention count, then other results', () => {
  const attention = {
    attentionCount: 1,
    attentionRaisedAt: NOW,
    attentionRaisedCount: 1,
  };
  const withFailure = view(
    shown(),
    signals({ ...attention, result: result(true, NOW) }),
  );
  assert.equal(
    withFailure.kind === 'shown' && withFailure.expanded?.reason,
    'result',
  );
  const withSuccess = view(
    shown(),
    signals({ ...attention, result: result(false, NOW) }),
  );
  assert.equal(
    withSuccess.kind === 'shown' && withSuccess.expanded?.reason,
    'attention',
  );
  // 確認待ちの時間が過ぎたら、まだ時間内の成功の結果を出す。
  const later = view(
    shown(),
    signals({
      ...attention,
      attentionRaisedAt: NOW - 8_000,
      result: result(false, NOW - 1_000),
    }),
  );
  assert.equal(later.kind === 'shown' && later.expanded?.reason, 'result');
});

test('touching the island keeps what was open, but does not reopen what had closed', () => {
  const s = signals({ result: result(false, NOW) });
  // 3 秒後に触れ、20 秒後も触れたまま。
  const held = view(shown(), s, NOW + 3_000, NOW + 20_000);
  assert.equal(held.kind === 'shown' && held.expanded?.reason, 'result');
  // 閉じた後（7 秒後）に触れても開き直さない。
  const late = view(shown(), s, NOW + 7_000, NOW + 8_000);
  assert.equal(late.kind === 'shown' && late.expanded, null);
});

// --- きっかけの作り方 ---

const step = (
  previous: typeof EMPTY_ISLAND_MEMORY,
  operations: readonly DesktopOperationEntry[],
  notices: Readonly<Record<string, Notice>> = {},
  at = NOW,
  isShown = true,
) => nextIslandMemory(previous, { shown: isShown, operations, notices }, at);

test('the attention count rises, keeps its time when unchanged, and closes when it drops', () => {
  const one = step(EMPTY_ISLAND_MEMORY, [entry(1)], {}, NOW);
  assert.deepEqual(
    [
      one.signals.attentionCount,
      one.signals.attentionRaisedAt,
      one.signals.attentionRaisedCount,
    ],
    [1, NOW, 1],
  );
  // 同じ件数（取り直し）では時刻を変えない。
  const same = step(one, [entry(1)], {}, NOW + 1_000);
  assert.equal(same.signals.attentionRaisedAt, NOW);
  // 結果不明・届いたか分からない保留も数える（「確認が必要な操作」と同じ）。
  const three = step(
    same,
    [
      entry(1),
      entry(2, { state: 'unknown_held' }),
      entry(3, { state: 'dispatching', delivery_unknown: true }),
    ],
    {},
    NOW + 2_000,
  );
  assert.deepEqual(
    [
      three.signals.attentionCount,
      three.signals.attentionRaisedAt,
      three.signals.attentionRaisedCount,
    ],
    [3, NOW + 2_000, 3],
  );
  // 処理中は数えない。減ったら畳む。
  const fewer = step(
    three,
    [entry(1, { state: 'dispatching' })],
    {},
    NOW + 3_000,
  );
  assert.deepEqual(
    [fewer.signals.attentionCount, fewer.signals.attentionRaisedAt],
    [0, null],
  );
});

test('nothing is remembered while the operations cannot be shown', () => {
  const one = step(EMPTY_ISLAND_MEMORY, [entry(1)]);
  assert.equal(step(one, [entry(1)], {}, NOW, false), EMPTY_ISLAND_MEMORY);
});

test('a waiting operation that reaches a result is read on the island', () => {
  const waiting = step(EMPTY_ISLAND_MEMORY, [
    entry(1, { state: 'dispatching' }),
  ]);
  // 初めて見た操作は、すでに結果の状態でも結果にしない（前を知らない）。
  const first = step(EMPTY_ISLAND_MEMORY, [entry(1, { state: 'succeeded' })]);
  assert.equal(first.signals.result, null);
  const done = step(waiting, [entry(1, { state: 'succeeded' })], {}, NOW + 500);
  assert.deepEqual(done.signals.result, {
    line: { tone: 'success', mark: 'dot', text: '用事の登録: 完了しました' },
    failure: false,
    at: NOW + 500,
    announcedNearby: false,
  });
  const held = step(
    waiting,
    [entry(1, { state: 'unknown_held' })],
    {},
    NOW + 500,
  );
  assert.deepEqual(held.signals.result?.line, {
    tone: 'danger',
    mark: 'warning',
    text: '用事の登録: 結果を確認できませんでした',
  });
  assert.equal(held.signals.result?.failure, true);
  // 結果の状態から結果の状態（照合を待たない書き換え）・内容の更新で使われなくなったは結果にしない。
  const again = step(done, [entry(1, { state: 'cancelled' })], {}, NOW + 900);
  assert.equal(again.signals.result, done.signals.result);
  const superseded = step(step(EMPTY_ISLAND_MEMORY, [entry(2)]), [
    entry(2, { state: 'superseded' }),
  ]);
  assert.equal(superseded.signals.result, null);
});

test('a new row notice is shown on the island without being read again', () => {
  const base = step(EMPTY_ISLAND_MEMORY, [entry(1)]);
  const notice: Notice = {
    tone: 'success',
    text: '承認を送りました。実行の状況は、この行で確かめられます。',
  };
  const sent = step(
    base,
    [entry(1, { state: 'approved' })],
    { [id(1)]: notice },
    NOW + 100,
  );
  assert.deepEqual(sent.signals.result, {
    line: {
      tone: 'success',
      mark: 'dot',
      text: '用事の登録: 承認を送りました。実行の状況は、この行で確かめられます。',
    },
    failure: false,
    at: NOW + 100,
    announcedNearby: true,
  });
  // 同じ知らせ（同じ物）は新しい結果にしない。
  const same = step(
    sent,
    [entry(1, { state: 'approved' })],
    { [id(1)]: notice },
    NOW + 200,
  );
  assert.equal(same.signals.result?.at, NOW + 100);
  // 拒否の知らせは失敗。
  const refused: Notice = { tone: 'warning', text: '承認できませんでした。' };
  const failed = step(base, [entry(1)], { [id(1)]: refused }, NOW + 300);
  assert.equal(failed.signals.result?.failure, true);
  assert.equal(failed.signals.result?.line.mark, 'warning');
});

test('when several results arrive together, a failure wins, then the one read on the island', () => {
  const base = step(EMPTY_ISLAND_MEMORY, [
    entry(1, { state: 'dispatching' }),
    entry(2, { state: 'dispatching' }),
  ]);
  const notice: Notice = { tone: 'success', text: '取消を依頼しました。' };
  const both = step(
    base,
    [entry(1, { state: 'succeeded' }), entry(2, { state: 'dispatching' })],
    { [id(2)]: notice },
  );
  assert.equal(both.signals.result?.announcedNearby, false);
  const withFailure = step(
    base,
    [entry(1, { state: 'succeeded' }), entry(2, { state: 'not_executed' })],
    { [id(2)]: { tone: 'warning', text: '取消できませんでした。' } },
  );
  assert.equal(withFailure.signals.result?.failure, true);
  assert.equal(withFailure.signals.result?.announcedNearby, true);
});

// UI-05 の段階 6（ADR 0189）: 保存モードが変わった区切りで島を広げる。期待値の文言・記号・時間は手で書いた。
test('a storage mode change opens the island with the boundary line for 6 seconds, read politely', () => {
  const at = (
    previous: typeof EMPTY_ISLAND_MEMORY,
    storageMode: 'normal' | 'extended' | 'private' | null,
    time: number,
    shownNow = true,
  ) =>
    nextIslandMemory(
      previous,
      { shown: shownNow, operations: [], notices: {}, storageMode },
      time,
    );
  // 接続・ロック解除の直後の最初の値（前の値が分からない）は区切りにしない。
  const first = at(EMPTY_ISLAND_MEMORY, 'normal', NOW);
  assert.equal(first.signals.result, null);
  assert.equal(first.storageMode, 'normal');
  // 記録しないへ入った。
  const entered = at(first, 'private', NOW + 10);
  assert.deepEqual(entered.signals.result, {
    line: {
      tone: 'neutral',
      mark: 'square',
      text: 'ここから記録しない会話です。',
    },
    failure: false,
    at: NOW + 10,
    announcedNearby: false,
  });
  const view = (signals: IslandSignals, now: number) =>
    islandView({
      status: shown('none', {
        hub_connection: 'connected',
        storage_mode: 'private',
      }),
      connection: null,
      now,
      signals,
      holdingSince: null,
    });
  const open = view(entered.signals, NOW + 10 + 5_999);
  assert.equal(open.kind, 'shown');
  assert.deepEqual(open.kind === 'shown' ? open.expanded : null, {
    reason: 'result',
    line: {
      tone: 'neutral',
      mark: 'square',
      text: 'ここから記録しない会話です。',
    },
    live: 'status',
    openAttention: false,
  });
  const closed = view(entered.signals, NOW + 10 + 6_000);
  assert.equal(closed.kind === 'shown' ? closed.expanded : 'x', null);
  // 同じ値のままなら新しい区切りではない（前の知らせの時刻のまま）。
  const same = at(entered, 'private', NOW + 20);
  assert.equal(same.signals.result?.at, NOW + 10);
  // 記録しないから継続相談へ出た。
  const exited = at(same, 'extended', NOW + 30);
  assert.deepEqual(exited.signals.result?.line, {
    tone: 'neutral',
    mark: 'dot',
    text: '記録しない会話を終えました。ここから保存モードは「継続相談（30\u00a0日）」です。',
  });
  // 継続相談から通常へ。
  const changed = at(exited, 'normal', NOW + 40);
  assert.equal(
    changed.signals.result?.line.text,
    'ここから保存モードは「通常（7\u00a0日）」です。',
  );
  // 値を受け取れなくなった（null）・見せられない間は区切りにせず、戻った後の最初の値も区切りにしない。
  const lost = at(changed, null, NOW + 50);
  assert.equal(lost.signals.result?.at, NOW + 40);
  const back = at(lost, 'private', NOW + 60);
  assert.equal(back.signals.result?.at, NOW + 40);
  const hidden = at(back, 'normal', NOW + 70, false);
  assert.deepEqual(hidden, EMPTY_ISLAND_MEMORY);
  const again = at(hidden, 'private', NOW + 80);
  assert.equal(again.signals.result, null);
});
