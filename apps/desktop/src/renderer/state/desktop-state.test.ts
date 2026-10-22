// 画面の状態の反映と、操作から送る要求の試験（ADR 0014・0015・0024）。期待値は契約の例を手で書く。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DesktopIpcNotification,
  DesktopIpcRequest,
  DesktopStatusBar,
} from '@buddy/contracts';
import {
  INITIAL_VIEW_STATE,
  POWER_LOG_LIMIT,
  applyIpcFailure,
  applyNotification,
  applyResponse,
  deviceActions,
  shownStatus,
} from './desktop-state.js';
import type { DesktopViewState } from './desktop-state.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const shown = (
  stop_scope: 'none' | 'local' | 'guest' | 'global',
  io_epoch = '7',
): DesktopStatusBar => ({
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope,
  input_permitted: stop_scope === 'none',
  io_epoch,
  voice_state: null,
  hub_connection: 'not_connected',
  hub_last_confirmed_at: null,
  display_target: null,
  storage_mode: null,
  budget_held: null,
  safety_stopped: null,
});

const powerEvent = (
  observed_at: string,
): Extract<DesktopIpcNotification, { channel: 'desktop.power_event' }> => ({
  channel: 'desktop.power_event',
  event: 'lock_screen',
  source: 'os_event',
  observed_at,
});

function capture(status: DesktopStatusBar | null) {
  const sent: DesktopIpcRequest[] = [];
  return { sent, actions: deviceActions(status, (built) => sent.push(built)) };
}

test('the state notification replaces the status bar and keeps the log', () => {
  const before: DesktopViewState = {
    status: { visibility: 'hidden', lock_state: 'unknown' },
    powerLog: [powerEvent('2026-10-21T01:00:00.000Z')],
    message: null,
    connection: null,
  };
  const after = applyNotification(before, {
    channel: 'desktop.state_changed',
    status: shown('local'),
  });
  assert.deepEqual(after.status, shown('local'));
  assert.equal(after.powerLog.length, 1);
});

test('power events are kept newest first and capped at fifty', () => {
  let state = INITIAL_VIEW_STATE;
  for (let minute = 0; minute <= 50; minute += 1)
    state = applyNotification(
      state,
      powerEvent(`2026-10-21T01:${String(minute).padStart(2, '0')}:00.000Z`),
    );
  assert.equal(POWER_LOG_LIMIT, 50);
  assert.equal(state.powerLog.length, 50);
  assert.equal(state.powerLog[0]?.observed_at, '2026-10-21T01:50:00.000Z');
  assert.equal(state.powerLog.at(-1)?.observed_at, '2026-10-21T01:01:00.000Z');
  assert.equal(state.status, null);
});

test('a rejection shows its message and leaves the status bar unchanged', () => {
  const before: DesktopViewState = {
    ...INITIAL_VIEW_STATE,
    status: shown('local', '8'),
  };
  const after = applyResponse(before, {
    request_id: '00000000-0000-4000-8000-000000000001',
    channel: 'desktop.io_resume',
    outcome: 'rejected',
    reason: 'io_epoch_mismatch',
  });
  assert.equal(
    after.message,
    '画面の情報が古いため再開しませんでした。最新の状態を確かめてから、もう一度押してください。',
  );
  assert.deepEqual(after.status, shown('local', '8'));
});

test('an accepted response clears the message and shows the returned status', () => {
  const before: DesktopViewState = {
    ...INITIAL_VIEW_STATE,
    status: shown('local'),
    message: 'この端末の入出力は停止していません。',
  };
  const resumed = applyResponse(before, {
    request_id: '00000000-0000-4000-8000-000000000002',
    channel: 'desktop.io_resume',
    outcome: 'ok',
    status: shown('none', '7'),
  });
  assert.equal(resumed.message, null);
  assert.deepEqual(resumed.status, shown('none', '7'));
  // 状態欄を返さない応答（ウィンドウを閉じる）は状態欄を変えない。
  const hidden = applyResponse(before, {
    request_id: '00000000-0000-4000-8000-000000000003',
    channel: 'desktop.window_hide',
    outcome: 'ok',
  });
  assert.equal(hidden.message, null);
  assert.deepEqual(hidden.status, shown('local'));
});

test('a failed invoke shows the communication failure', () => {
  assert.equal(
    applyIpcFailure(INITIAL_VIEW_STATE).message,
    'main と通信できませんでした。',
  );
});

test('the status content is shown only after the lock is confirmed released', () => {
  assert.equal(shownStatus(null), null);
  assert.equal(
    shownStatus({ visibility: 'hidden', lock_state: 'locked' }),
    null,
  );
  assert.equal(
    shownStatus({ visibility: 'hidden', lock_state: 'unknown' }),
    null,
  );
  assert.deepEqual(shownStatus(shown('none')), shown('none'));
});

test('stop sends desktop.io_stop with a fresh request id', () => {
  const { sent, actions } = capture(shown('none'));
  actions.stop();
  actions.stop();
  assert.equal(sent.length, 2);
  for (const built of sent) {
    assert.equal(built.channel, 'desktop.io_stop');
    assert.equal(built.payload, null);
    assert.match(built.request_id, UUID);
  }
  assert.notEqual(sent[0]?.request_id, sent[1]?.request_id);
});

test('stop is available even while the status is hidden or unknown', () => {
  for (const status of [
    null,
    { visibility: 'hidden', lock_state: 'locked' } as const,
  ]) {
    const { sent, actions } = capture(status);
    actions.stop();
    assert.equal(sent[0]?.channel, 'desktop.io_stop');
  }
});

test('resume sends the shown io_epoch only when this device alone is stopped', () => {
  const { sent, actions } = capture(shown('local', '12'));
  assert.notEqual(actions.resume, null);
  actions.resume?.();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.channel, 'desktop.io_resume');
  assert.deepEqual(sent[0]?.payload, { expected_io_epoch: '12' });
  assert.match(sent[0]?.request_id ?? '', UUID);
});

test('resume is not offered while locked, unknown, accepting, guest or global', () => {
  for (const status of [
    null,
    { visibility: 'hidden', lock_state: 'locked' } as const,
    { visibility: 'hidden', lock_state: 'unknown' } as const,
    shown('none'),
    shown('guest'),
    shown('global'),
  ])
    assert.equal(capture(status).actions.resume, null);
});

test('window hide and client quit send their own channels', () => {
  const { sent, actions } = capture(null);
  actions.hideWindow();
  actions.quit();
  assert.deepEqual(
    sent.map((built) => [built.channel, built.payload]),
    [
      ['desktop.window_hide', null],
      ['desktop.client_quit', null],
    ],
  );
});
