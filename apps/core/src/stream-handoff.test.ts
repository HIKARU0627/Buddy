// 流れの表示先の移動（POST・GET /v1/stream/handoff。UI-05 の段階 5、ADR 0193）を Core の HTTPS に組み込んだ模擬試験。
// 同じプロセスの startCore・模擬の KeyStore・127.0.0.1。経路の検査（本人の画面操作・接続範囲・ロック解除・端末の認証）と、
// 中枢の判断（表示先の版・移す先・表示のリースの拒否）を、契約の応答の形と合わせて確かめる。期待値は手書き。
// 実機・実 API・実請求は使わない（未実施）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createMockKeyStore, createMockTlsKeyStore } from '@buddy/platform';
import {
  insertDevice,
  onCleanup,
  pinnedRequest,
  sharedApiContract,
  tempDir,
} from './api-test-support.js';
import type { TestDevice } from './api-test-support.js';
import { startCore } from './core.js';
import { postJson } from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import { TLS_CERTIFICATE_FILE } from './tls-identity.js';

const contract = sharedApiContract();
const UNLOCKED = { 'buddy-lock-state': 'unlocked' };
const SCREEN = { ...UNLOCKED, 'buddy-input-origin': 'screen' };
const NIL = '00000000-0000-4000-8000-000000000000';

async function startHandoffCore(t: test.TestContext): Promise<EventCore> {
  const dataDir = join(await tempDir(t, 'buddy-handoff-'), 'data');
  const tlsKeyStore = createMockTlsKeyStore();
  const handle = await startCore({
    dataDir,
    keyStore: createMockKeyStore({
      stored: Buffer.alloc(32, 0x5c).toString('base64'),
    }),
    shutdownGraceMs: 200,
    probeTimeoutMs: 300,
    https: {
      host: '127.0.0.1',
      port: 0,
      tlsKeyStore,
      environment: {
        homeNetwork: () => true,
        hubLocal: () => true,
        claimSecretMatches: () => false,
      },
    },
  });
  onCleanup(t, () => handle.stop('test').catch(() => undefined));
  assert(handle.https !== null);
  const certificatePem = await readFile(
    join(dataDir, TLS_CERTIFICATE_FILE),
    'utf8',
  );
  return {
    handle,
    env: { home: true, lock: 'unlocked' },
    dataDir,
    tlsKeyStore,
    target: {
      host: handle.https.host,
      port: handle.https.port,
      certificatePem,
      fingerprint: handle.https.certificateFingerprint,
    },
  };
}

async function scopeOf(core: EventCore, device: TestDevice): Promise<string> {
  const response = await pinnedRequest(core.target, {
    method: 'GET',
    path: '/v1/bootstrap',
    headers: { authorization: `Bearer ${device.token}`, ...UNLOCKED },
  });
  assert.equal(response.status, 200, response.text);
  return String((response.json as Record<string, unknown>)['command_scope_id']);
}

const displayLease = (
  core: EventCore,
  device: TestDevice,
  scope: string,
  leaseId: string,
  nonce: string,
  previous: string | null,
  at: number,
) => ({
  request_id: randomUUID(),
  lease_id: leaseId,
  kind: 'display',
  device_id: device.device.device_id,
  core_instance_id: core.handle.coreInstanceId,
  command_scope_id: scope,
  io_epoch: '0',
  nonce,
  previous_nonce: previous,
  requested_at_mono_ms: at,
  heartbeat_ms: 2000,
  ttl_ms: 6000,
});

const getJson = (
  core: EventCore,
  device: TestDevice,
  path: string,
  headers: Record<string, string> = {},
) =>
  pinnedRequest(core.target, {
    method: 'GET',
    path,
    headers: { authorization: `Bearer ${device.token}`, ...headers },
  });

const handoff = (
  scope: string,
  target: string,
  expected: string,
): Record<string, unknown> => ({
  request_id: randomUUID(),
  command_scope_id: scope,
  target_device_id: target,
  expected_route_revision: expected,
});

test(
  'HTTPS: 流れの表示先の移動は本人の画面操作だけで、他の端末の表示のリースを取り消し、版の違いと他の端末への移動を拒む',
  { timeout: 30_000 },
  async (t) => {
    const core = await startHandoffCore(t);
    const a = await insertDevice(core.handle.store);
    const b = await insertDevice(core.handle.store);
    const scopeA = await scopeOf(core, a);
    const scopeB = await scopeOf(core, b);
    const idA = a.device.device_id;
    const idB = b.device.device_id;

    // 最初は未決定（会話の ID も端末の ID も返さない）。
    const first = await getJson(core, b, '/v1/stream/handoff', UNLOCKED);
    assert.equal(first.status, 200, first.text);
    assert(contract.valid('HandoffState', first.json));
    assert.deepEqual(first.json, {
      session_id: NIL,
      route_revision: '0',
      display_device_id: NIL,
      state: 'completed',
    });
    // ロック中・ロック状態を申告しない端末には出さない。
    const locked = await getJson(core, b, '/v1/stream/handoff', {
      'buddy-lock-state': 'locked',
    });
    assert.deepEqual(
      [locked.status, locked.json?.['code']],
      [403, 'device_locked'],
    );
    const unknown = await getJson(core, b, '/v1/stream/handoff');
    assert.deepEqual(
      [unknown.status, unknown.json?.['code']],
      [403, 'device_locked'],
    );

    // A は表示のリースを持つ。
    const leaseA = randomUUID();
    const held = await postJson(
      core,
      a,
      '/v1/leases/renew',
      displayLease(core, a, scopeA, leaseA, 'a-1', null, 1000),
      UNLOCKED,
    );
    assert.equal(held.json?.['result'], 'renewed', held.text);

    // 画面操作でない起点（音声・チャット・システム）は 403。何も移らない。
    for (const origin of ['voice', 'chat', 'system']) {
      const refused = await postJson(
        core,
        b,
        '/v1/stream/handoff',
        handoff(scopeB, idB, '0'),
        { ...UNLOCKED, 'buddy-input-origin': origin },
      );
      assert.deepEqual(
        [refused.status, refused.json?.['code']],
        [403, 'screen_operation_required'],
        origin,
      );
    }
    // ロック中は 403、古い・知らない接続範囲は 410、本文の形が違えば 422。
    const lockedPost = await postJson(
      core,
      b,
      '/v1/stream/handoff',
      handoff(scopeB, idB, '0'),
      { 'buddy-lock-state': 'locked', 'buddy-input-origin': 'screen' },
    );
    assert.deepEqual(
      [lockedPost.status, lockedPost.json?.['code']],
      [403, 'device_locked'],
    );
    const staleScope = await postJson(
      core,
      b,
      '/v1/stream/handoff',
      handoff(randomUUID(), idB, '0'),
      SCREEN,
    );
    assert.deepEqual(
      [staleScope.status, staleScope.json?.['code']],
      [410, 'expired_scope'],
    );
    const malformed = await postJson(
      core,
      b,
      '/v1/stream/handoff',
      { ...handoff(scopeB, idB, '0'), session_id: randomUUID() },
      SCREEN,
    );
    assert.deepEqual(
      [malformed.status, malformed.json?.['code']],
      [422, 'invalid_input'],
    );
    // ここまでは何も移っていない。
    assert.equal(
      (await getJson(core, b, '/v1/stream/handoff', UNLOCKED)).json?.[
        'route_revision'
      ],
      '0',
    );

    // 他の端末を移す先にはできない。
    const other = await postJson(
      core,
      b,
      '/v1/stream/handoff',
      handoff(scopeB, idA, '0'),
      SCREEN,
    );
    assert.deepEqual([other.status, other.json?.['code']], [403, 'forbidden']);

    // B が移す。A は表示のリースを持っていたので moving。
    const moved = await postJson(
      core,
      b,
      '/v1/stream/handoff',
      handoff(scopeB, idB, '0'),
      SCREEN,
    );
    assert.equal(moved.status, 202, moved.text);
    assert(contract.valid('HandoffState', moved.json));
    assert.deepEqual(moved.json, {
      session_id: NIL,
      route_revision: '1',
      display_device_id: idB,
      state: 'moving',
    });
    // 古い版（他の端末が先に移した後）は 409。
    const stale = await postJson(
      core,
      a,
      '/v1/stream/handoff',
      handoff(scopeA, idA, '0'),
      SCREEN,
    );
    assert.deepEqual([stale.status, stale.json?.['code']], [409, 'conflict']);

    // A の表示のリースの更新は拒否され、A が止まったので completed に変わる。
    const renewal = await postJson(
      core,
      a,
      '/v1/leases/renew',
      displayLease(core, a, scopeA, leaseA, 'a-2', 'a-1', 3000),
      UNLOCKED,
    );
    assert(contract.valid('LeaseRenewalResponse', renewal.json));
    assert.deepEqual(
      [renewal.json?.['result'], renewal.json?.['reasons']],
      ['rejected', ['display_owned_elsewhere']],
    );
    const after = await getJson(core, a, '/v1/stream/handoff', UNLOCKED);
    assert.deepEqual(after.json, {
      session_id: NIL,
      route_revision: '1',
      display_device_id: idB,
      state: 'completed',
    });
    // B は取れる。
    const heldB = await postJson(
      core,
      b,
      '/v1/leases/renew',
      displayLease(core, b, scopeB, randomUUID(), 'b-1', null, 1000),
      UNLOCKED,
    );
    assert.equal(heldB.json?.['result'], 'renewed', heldB.text);
  },
);

test(
  'HTTPS: 端末トークンのない要求は 401。会話ごとの移動（handoffSession）の経路とは別に動く',
  { timeout: 30_000 },
  async (t) => {
    const core = await startHandoffCore(t);
    for (const [method, body] of [
      ['GET', undefined],
      ['POST', JSON.stringify(handoff(randomUUID(), randomUUID(), '0'))],
    ] as const) {
      const response = await pinnedRequest(core.target, {
        method,
        path: '/v1/stream/handoff',
        headers: { ...SCREEN, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body }),
      });
      assert.equal(response.status, 401, `${method} ${response.text}`);
    }
  },
);
