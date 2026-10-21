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
  applySending,
  deviceActions,
  messageFor,
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
    ...INITIAL_VIEW_STATE,
    status: { visibility: 'hidden', lock_state: 'unknown' },
    powerLog: [powerEvent('2026-10-21T01:00:00.000Z')],
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
  assert.deepEqual(after.message, {
    channel: 'desktop.io_resume',
    text: '画面の状態が古いため再開しませんでした。表示が更新されたら、もう一度押してください。',
  });
  assert.deepEqual(after.status, shown('local', '8'));
});

test('an accepted response clears the message and shows the returned status', () => {
  const before: DesktopViewState = {
    ...INITIAL_VIEW_STATE,
    status: shown('local'),
    message: {
      channel: 'desktop.io_resume',
      text: 'この端末の入出力は止まっていません。',
    },
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
  assert.deepEqual(
    applyIpcFailure(INITIAL_VIEW_STATE, 'desktop.io_stop').message,
    { channel: 'desktop.io_stop', text: 'main と通信できませんでした。' },
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

test('a message is shown only under the operation that caused it', () => {
  const state: DesktopViewState = {
    ...INITIAL_VIEW_STATE,
    message: { channel: 'desktop.io_resume', text: '再開の拒否' },
  };
  assert.equal(messageFor(state, ['desktop.io_resume']), '再開の拒否');
  assert.equal(messageFor(state, ['desktop.pairing_begin']), null);
  // どの操作か分からない文言（channel が null）はどこにでも出す。
  const unknown: DesktopViewState = {
    ...INITIAL_VIEW_STATE,
    message: { channel: null, text: '通信の失敗' },
  };
  assert.equal(messageFor(unknown, ['desktop.pairing_begin']), '通信の失敗');
  assert.equal(messageFor(INITIAL_VIEW_STATE, ['desktop.io_resume']), null);
});

test('pressing stop while accepting records the button as the stop cause', () => {
  const stop: DesktopIpcRequest = {
    request_id: '00000000-0000-4000-8000-000000000010',
    channel: 'desktop.io_stop',
    payload: null,
  };
  const accepting: DesktopViewState = {
    ...INITIAL_VIEW_STATE,
    status: shown('none'),
    message: { channel: 'desktop.io_resume', text: '前の拒否' },
  };
  const sent = applySending(accepting, stop, () => '2026-10-21T02:00:00.000Z');
  assert.deepEqual(sent.stopCause, {
    kind: 'button',
    at: '2026-10-21T02:00:00.000Z',
  });
  assert.equal(sent.message, null);
  // 既に止まっているときは、止まった理由を上書きしない。
  const already: DesktopViewState = {
    ...INITIAL_VIEW_STATE,
    status: shown('local'),
    stopCause: {
      kind: 'power',
      event: 'suspend',
      at: '2026-10-21T01:00:00.000Z',
    },
  };
  assert.deepEqual(
    applySending(already, stop, () => '2026-10-21T02:00:00.000Z').stopCause,
    already.stopCause,
  );
});

test('a stopping power event becomes the stop cause and resuming clears it', () => {
  const stopped = applyNotification(
    { ...INITIAL_VIEW_STATE, status: shown('none') },
    {
      channel: 'desktop.power_event',
      event: 'suspend',
      source: 'os_event',
      observed_at: '2026-10-21T01:30:00.000Z',
    },
  );
  assert.deepEqual(stopped.stopCause, {
    kind: 'power',
    event: 'suspend',
    at: '2026-10-21T01:30:00.000Z',
  });
  // ロックの解除は止まった理由を変えない。
  const unlocked = applyNotification(stopped, {
    channel: 'desktop.power_event',
    event: 'unlock_screen',
    source: 'os_event',
    observed_at: '2026-10-21T01:31:00.000Z',
  });
  assert.deepEqual(unlocked.stopCause, stopped.stopCause);
  const resumed = applyNotification(unlocked, {
    channel: 'desktop.state_changed',
    status: shown('none'),
  });
  assert.equal(resumed.stopCause, null);
});

test('a change of the io state clears an io rejection but keeps other messages', () => {
  const rejected: DesktopViewState = {
    ...INITIAL_VIEW_STATE,
    status: shown('local'),
    message: { channel: 'desktop.io_resume', text: '再開の拒否' },
  };
  const same = applyNotification(rejected, {
    channel: 'desktop.state_changed',
    status: shown('local', '8'),
  });
  assert.deepEqual(same.message, rejected.message);
  const changed = applyNotification(rejected, {
    channel: 'desktop.state_changed',
    status: shown('none'),
  });
  assert.equal(changed.message, null);
  const pairing: DesktopViewState = {
    ...rejected,
    message: { channel: 'desktop.pairing_begin', text: '登録の拒否' },
  };
  assert.deepEqual(
    applyNotification(pairing, {
      channel: 'desktop.state_changed',
      status: shown('none'),
    }).message,
    pairing.message,
  );
});

const connectionView = (
  registration: 'unregistered' | 'registered',
): NonNullable<DesktopViewState['connection']> => ({
  visibility: 'shown',
  registration,
  link: 'not_connected',
  link_reason: null,
  last_confirmed_at: null,
  retry_at: null,
  pairing: null,
  hub_screen: false,
  hub_target: null,
  home_network: null,
  operations: [],
});

test('the one-time success notice appears only on the change to registered', () => {
  const first = applyNotification(INITIAL_VIEW_STATE, {
    channel: 'desktop.connection_changed',
    connection: connectionView('registered'),
  });
  // 起動して最初に受け取った状態が登録済みなら、知らせは出さない。
  assert.equal(first.justRegistered, false);
  const unregistered = applyNotification(INITIAL_VIEW_STATE, {
    channel: 'desktop.connection_changed',
    connection: connectionView('unregistered'),
  });
  const registered = applyNotification(unregistered, {
    channel: 'desktop.connection_changed',
    connection: connectionView('registered'),
  });
  assert.equal(registered.justRegistered, true);
  // 次の操作を始めたら消す。
  const next = applySending(registered, {
    request_id: '00000000-0000-4000-8000-000000000011',
    channel: 'desktop.window_hide',
    payload: null,
  });
  assert.equal(next.justRegistered, false);
});

test('the typed address and device name are kept for the form', () => {
  const begun = applySending(INITIAL_VIEW_STATE, {
    request_id: '00000000-0000-4000-8000-000000000012',
    channel: 'desktop.pairing_begin',
    payload: { host: '100.64.0.10', port: 47823 },
  });
  assert.deepEqual(begun.lastTarget, { host: '100.64.0.10', port: 47823 });
  const submitted = applySending(begun, {
    request_id: '00000000-0000-4000-8000-000000000013',
    channel: 'desktop.pairing_submit',
    payload: { pairing_code: '12345678', device_name: '合成の端末' },
  });
  assert.equal(submitted.submittedName, '合成の端末');
  assert.deepEqual(submitted.lastTarget, begun.lastTarget);
});
