// 端末のロック状態の申告（要求ヘッダー Buddy-Lock-State、B03-05、ADR 0025）の試験。
// Core は同じプロセスの startCore（HTTPS は 127.0.0.1、鍵は模擬の KeyStore）で、lockState を注入せずに
// Core の既定（認証した端末の申告だけを使い、ない・不正は解除済みと扱わない）を確かめる。
// 期待値（状態・コード・表示の範囲）は試験に手で書いた値。

import assert from 'node:assert/strict';
import test from 'node:test';
import { pinnedRequest } from './api-test-support.js';
import {
  H01_OPERATION,
  bearer,
  createCommand,
  insertDevice,
  startEventCore,
  submitDurable,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';

const get = (core: EventCore, path: string, headers: Record<string, string>) =>
  pinnedRequest(core.target, { method: 'GET', path, headers });

test(
  'routes that need an unlocked device use the declared lock state and treat a missing declaration as unknown',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t, { lockFromHeader: true });
    const device = await insertDevice(core.handle.store, { hubLocal: true });
    const auth = bearer(device.token);

    const none = await get(core, '/v1/devices', auth);
    assert.equal(none.status, 403, none.text);
    assert.equal(none.json?.['code'], 'device_locked');
    const locked = await get(core, '/v1/devices', {
      ...auth,
      'buddy-lock-state': 'locked',
    });
    assert.equal(locked.status, 403, locked.text);
    assert.equal(locked.json?.['code'], 'device_locked');
    const unlocked = await get(core, '/v1/devices', {
      ...auth,
      'buddy-lock-state': 'unlocked',
    });
    assert.equal(unlocked.status, 200, unlocked.text);

    // 列挙にない値・大文字・unknown（申告しない値）・複数の値はどの経路でも 422。
    for (const value of ['unknown', 'UNLOCKED', 'unlocked, locked', ''])
      for (const path of ['/v1/devices', '/v1/bootstrap']) {
        const bad = await get(core, path, {
          ...auth,
          'buddy-lock-state': value,
        });
        assert.equal(bad.status, 422, `${path} ${JSON.stringify(value)}`);
        assert.equal(bad.json?.['code'], 'invalid_input');
      }

    // 申告は端末トークンの照合の代わりにならない（未認証は 401）。
    const anonymous = await get(core, '/v1/devices', {
      'buddy-lock-state': 'unlocked',
    });
    assert.equal(anonymous.status, 401, anonymous.text);
  },
);

test(
  'the snapshot view follows the declared lock state',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t, { lockFromHeader: true });
    const device = await insertDevice(core.handle.store, { hubLocal: true });
    await submitDurable(core, createCommand(H01_OPERATION));
    const auth = bearer(device.token);
    const cases: [Record<string, string>, string, string, number][] = [
      [{}, 'management_only', 'unknown', 0],
      [{ 'buddy-lock-state': 'locked' }, 'management_only', 'locked', 0],
      [{ 'buddy-lock-state': 'unlocked' }, 'full', 'unlocked', 1],
    ];
    for (const [headers, view, lockState, count] of cases) {
      const snapshot = await get(core, '/v1/snapshot', {
        ...auth,
        ...headers,
      });
      assert.equal(snapshot.status, 200, snapshot.text);
      assert.equal(snapshot.json?.['view'], view);
      assert.equal(
        (snapshot.json?.['io_state'] as Record<string, unknown>)['lock_state'],
        lockState,
      );
      assert.equal((snapshot.json?.['operations'] as unknown[]).length, count);
    }
  },
);
