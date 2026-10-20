// 限定 IPC の形式検査と意味検査（ADR 0014・0015）。期待値は手で書き、実装から生成しない。
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DesktopIpcNotification,
  DesktopIpcResponse,
  DesktopStatusBar,
} from '@buddy/contracts';
import {
  contractSchemaUrl,
  createDesktopContract,
  loadContractSchema,
} from './contract.js';

const contract = createDesktopContract(loadContractSchema());
const ID = '0b9a0c56-2f4e-4c1a-9d3b-6f1e2a7c8d90';

const shown = (
  overrides: Partial<Extract<DesktopStatusBar, { visibility: 'shown' }>> = {},
): DesktopStatusBar => ({
  visibility: 'shown',
  lock_state: 'unlocked',
  stop_scope: 'none',
  input_permitted: true,
  io_epoch: '3',
  voice_state: null,
  hub_connection: 'not_connected',
  hub_last_confirmed_at: null,
  display_target: null,
  storage_mode: null,
  budget_held: null,
  safety_stopped: null,
  ...overrides,
});

test('the schema is read from the contracts package, not from its src', () => {
  const url = contractSchemaUrl();
  assert.equal(url.protocol, 'file:');
  assert.match(url.pathname, /\/contracts\/schemas\/buddy\.schema\.json$/u);
  assert.doesNotMatch(url.pathname, /\/src\//u);
});

test('a broken schema is refused', () => {
  assert.throws(() => createDesktopContract(null), /schema_invalid/u);
  assert.throws(() => createDesktopContract({ $defs: {} }), /schema_invalid/u);
});

test('valid requests pass the DesktopIpcRequest schema', () => {
  for (const request of [
    { channel: 'desktop.get_state', request_id: ID, payload: null },
    { channel: 'desktop.io_stop', request_id: ID, payload: null },
    {
      channel: 'desktop.io_resume',
      request_id: ID,
      payload: { expected_io_epoch: '0' },
    },
    { channel: 'desktop.window_hide', request_id: ID, payload: null },
    { channel: 'desktop.client_quit', request_id: ID, payload: null },
  ])
    assert.equal(contract.isRequest(request), true, request.channel);
});

test('malformed requests, unknown channels and extra fields are refused', () => {
  const refused: [string, unknown][] = [
    ['not an object', 'desktop.get_state'],
    ['null', null],
    ['array', [{ channel: 'desktop.get_state' }]],
    [
      'hub stop channel',
      { channel: 'desktop.hub_stop', request_id: ID, payload: null },
    ],
    [
      'device id claimed',
      {
        channel: 'desktop.get_state',
        request_id: ID,
        payload: null,
        device_id: 'pc-1',
      },
    ],
    [
      'empty object payload',
      { channel: 'desktop.get_state', request_id: ID, payload: {} },
    ],
    [
      'stop scope given',
      {
        channel: 'desktop.io_stop',
        request_id: ID,
        payload: { scope: 'global' },
      },
    ],
    [
      'resume without epoch',
      { channel: 'desktop.io_resume', request_id: ID, payload: {} },
    ],
    [
      'resume with leading zero epoch',
      {
        channel: 'desktop.io_resume',
        request_id: ID,
        payload: { expected_io_epoch: '01' },
      },
    ],
    [
      'resume with numeric epoch',
      {
        channel: 'desktop.io_resume',
        request_id: ID,
        payload: { expected_io_epoch: 1 },
      },
    ],
    [
      'request id is not a UUID v4',
      { channel: 'desktop.get_state', request_id: 'x', payload: null },
    ],
    ['missing payload', { channel: 'desktop.get_state', request_id: ID }],
  ];
  for (const [name, value] of refused)
    assert.equal(contract.isRequest(value), false, name);
});

test('status bar meaning checks match ADR 0014', () => {
  assert.deepEqual(contract.statusBarErrors(shown()), []);
  assert.deepEqual(
    contract.statusBarErrors({ visibility: 'hidden', lock_state: 'unknown' }),
    [],
  );
  assert.deepEqual(contract.statusBarErrors(shown({ stop_scope: 'local' })), [
    'input_permitted_while_stopped',
  ]);
  assert.deepEqual(
    contract.statusBarErrors(
      shown({ stop_scope: 'none', voice_state: 'device_stopped' }),
    ),
    ['voice_state_conflicts_with_stop'],
  );
  assert.deepEqual(
    contract.statusBarErrors(
      shown({
        stop_scope: 'guest',
        input_permitted: false,
        voice_state: 'global_stopped',
      }),
    ),
    [],
  );
  assert.deepEqual(
    contract.statusBarErrors(shown({ storage_mode: 'normal' })),
    ['hub_values_without_connection'],
  );
  assert.deepEqual(
    contract.statusBarErrors(shown({ hub_connection: 'connected' })),
    ['connected_without_values'],
  );
  // ロック中の状態欄は内容の項目を持てない（schema で拒否）。
  assert.deepEqual(
    contract.statusBarErrors({
      visibility: 'hidden',
      lock_state: 'locked',
      stop_scope: 'none',
    } as unknown as DesktopStatusBar),
    ['schema'],
  );
});

test('responses must reflect stop and resume', () => {
  const stopped = shown({ stop_scope: 'local', input_permitted: false });
  const ok = (
    channel: 'desktop.io_stop' | 'desktop.io_resume',
    status: DesktopStatusBar,
  ): DesktopIpcResponse => ({
    request_id: ID,
    channel,
    outcome: 'ok',
    status,
  });
  assert.deepEqual(contract.responseErrors(ok('desktop.io_stop', stopped)), []);
  assert.deepEqual(contract.responseErrors(ok('desktop.io_stop', shown())), [
    'stop_not_reflected',
  ]);
  assert.deepEqual(
    contract.responseErrors(ok('desktop.io_resume', shown())),
    [],
  );
  assert.deepEqual(contract.responseErrors(ok('desktop.io_resume', stopped)), [
    'resume_not_reflected',
  ]);
  assert.deepEqual(
    contract.responseErrors(
      ok('desktop.io_resume', { visibility: 'hidden', lock_state: 'locked' }),
    ),
    ['resume_not_reflected'],
  );
  assert.deepEqual(
    contract.responseErrors({
      request_id: null,
      channel: null,
      outcome: 'rejected',
      reason: 'invalid_request',
    }),
    [],
  );
  // 拒否に本文を足せない。
  assert.deepEqual(
    contract.responseErrors({
      request_id: ID,
      channel: 'desktop.io_resume',
      outcome: 'rejected',
      reason: 'device_locked',
      message: 'locked',
    } as unknown as DesktopIpcResponse),
    ['schema'],
  );
});

test('an OS query record must report a lock state', () => {
  const record = (
    event: 'unlock_screen' | 'suspend',
    source: 'os_event' | 'os_query',
  ): DesktopIpcNotification => ({
    channel: 'desktop.power_event',
    event,
    source,
    observed_at: '2026-10-20T00:00:00.000Z',
  });
  assert.deepEqual(
    contract.notificationErrors(record('unlock_screen', 'os_query')),
    [],
  );
  assert.deepEqual(
    contract.notificationErrors(record('suspend', 'os_event')),
    [],
  );
  assert.deepEqual(contract.notificationErrors(record('suspend', 'os_query')), [
    'query_without_lock_state',
  ]);
  assert.deepEqual(
    contract.notificationErrors({
      channel: 'desktop.power_event',
      event: 'suspend',
      source: 'os_event',
      observed_at: '2026-10-20 00:00:00',
    }),
    ['schema'],
  );
});
