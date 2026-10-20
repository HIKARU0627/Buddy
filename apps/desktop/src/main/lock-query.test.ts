// OS へのロック状態の問い合わせ結果の読み替えと、端末状態から作る状態欄（ADR 0014・0015）。期待値は手で書く。
import assert from 'node:assert/strict';
import test from 'node:test';
import { lockQueryEvent } from './lock-query.js';
import { buildStatusBar } from './status-bar.js';

test('only macOS and Windows answers are used; unknown keeps the lock state unknown', () => {
  const table: [
    string,
    'active' | 'idle' | 'locked' | 'unknown',
    string | null,
  ][] = [
    ['darwin', 'locked', 'lock_screen'],
    ['darwin', 'active', 'unlock_screen'],
    ['darwin', 'idle', 'unlock_screen'],
    ['darwin', 'unknown', null],
    ['win32', 'locked', 'lock_screen'],
    ['win32', 'active', 'unlock_screen'],
    ['win32', 'unknown', null],
    // Linux などは locked を返せないので、active でも解除済みと扱わない。
    ['linux', 'active', null],
    ['linux', 'locked', null],
    ['freebsd', 'idle', null],
  ];
  for (const [platform, idle, expected] of table)
    assert.equal(
      lockQueryEvent(platform, idle),
      expected,
      `${platform}/${idle}`,
    );
  assert.equal(
    lockQueryEvent('darwin', 'sleeping' as unknown as 'unknown'),
    null,
  );
});

test('the status bar hides content unless unlocked and is not connected to the hub in B01', () => {
  assert.deepEqual(
    buildStatusBar({ lockState: 'locked', stopScope: 'local', ioEpoch: '4' }),
    { visibility: 'hidden', lock_state: 'locked' },
  );
  assert.deepEqual(
    buildStatusBar({ lockState: 'unknown', stopScope: 'none', ioEpoch: '0' }),
    { visibility: 'hidden', lock_state: 'unknown' },
  );
  assert.deepEqual(
    buildStatusBar({ lockState: 'unlocked', stopScope: 'local', ioEpoch: '4' }),
    {
      visibility: 'shown',
      lock_state: 'unlocked',
      stop_scope: 'local',
      input_permitted: false,
      io_epoch: '4',
      voice_state: null,
      hub_connection: 'not_connected',
      hub_last_confirmed_at: null,
      display_target: null,
      storage_mode: null,
      budget_held: null,
      safety_stopped: null,
    },
  );
  assert.deepEqual(
    buildStatusBar({ lockState: 'unlocked', stopScope: 'none', ioEpoch: '0' }),
    {
      visibility: 'shown',
      lock_state: 'unlocked',
      stop_scope: 'none',
      input_permitted: true,
      io_epoch: '0',
      voice_state: null,
      hub_connection: 'not_connected',
      hub_last_confirmed_at: null,
      display_target: null,
      storage_mode: null,
      budget_held: null,
      safety_stopped: null,
    },
  );
});
