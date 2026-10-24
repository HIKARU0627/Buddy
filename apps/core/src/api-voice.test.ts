// 音声の制御の経路（B05-03、ADR 0046）を Core の HTTPS に組み込んだ模擬試験。同じプロセスの startCore・模擬の KeyStore・
// 127.0.0.1。音声所有権は中枢のリース（環境の注入で上書きしない）、ロック状態は Buddy-Lock-State の申告。
// provider・予算の門の境界は渡さない（製品の起動と同じ。Live の接続は開かない）。期待値は手書き。実機・実 API は未実施。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createMockKeyStore, createMockTlsKeyStore } from '@buddy/platform';
import { createApiContract } from './api-contract.js';
import {
  insertDevice,
  onCleanup,
  pinnedRequest,
  tempDir,
} from './api-test-support.js';
import type { TestDevice } from './api-test-support.js';
import { startCore } from './core.js';
import { getJson, openStream, postJson } from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import { TLS_CERTIFICATE_FILE } from './tls-identity.js';

const contract = createApiContract();
const UNLOCKED = { 'buddy-lock-state': 'unlocked' };

async function startVoiceCore(t: test.TestContext): Promise<EventCore> {
  const dataDir = join(await tempDir(t, 'buddy-voice-'), 'data');
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

async function boot(core: EventCore, device: TestDevice) {
  const response = await pinnedRequest(core.target, {
    method: 'GET',
    path: '/v1/bootstrap',
    headers: { authorization: `Bearer ${device.token}`, ...UNLOCKED },
  });
  assert.equal(response.status, 200, response.text);
  return response.json as Record<string, unknown>;
}

const lease = (
  core: EventCore,
  device: TestDevice,
  scope: string,
  leaseId: string,
) => ({
  request_id: randomUUID(),
  lease_id: leaseId,
  kind: 'audio',
  device_id: device.device.device_id,
  core_instance_id: core.handle.coreInstanceId,
  command_scope_id: scope,
  io_epoch: '0',
  nonce: 'synthetic-1',
  previous_nonce: null,
  requested_at_mono_ms: 1000,
  heartbeat_ms: 2000,
  ttl_ms: 6000,
});

test(
  'HTTPS: リースの取得・同時の 2 台目の 409・全体停止の到達と停止のイベント・画面の再開',
  { timeout: 30_000 },
  async (t) => {
    const core = await startVoiceCore(t);
    const a = await insertDevice(core.handle.store);
    const b = await insertDevice(core.handle.store);
    const bootA = await boot(core, a);
    const bootB = await boot(core, b);
    assert(contract.valid('Bootstrap', bootA));
    const ioA = bootA['io_state'] as Record<string, unknown>;
    assert.deepEqual(
      [
        ioA['io_epoch'],
        ioA['stop_scope'],
        ioA['input_permitted'],
        ioA['voice_state'],
        ioA['audio_lease_valid'],
      ],
      ['0', 'none', true, 'waiting_wake_word', false],
    );
    const scopeA = String(bootA['command_scope_id']);
    const scopeB = String(bootB['command_scope_id']);

    // B の購読（停止のイベントを受ける）。
    const snapshot = await getJson(core, b, '/v1/snapshot');
    const stream = openStream(
      t,
      core,
      b,
      String(snapshot.json?.['event_cursor']),
    );
    assert.deepEqual(await stream.opened, { ok: true });

    const renewed = await postJson(
      core,
      b,
      '/v1/leases/renew',
      lease(core, b, scopeB, randomUUID()),
      UNLOCKED,
    );
    assert.equal(renewed.status, 200, renewed.text);
    assert(contract.valid('LeaseRenewalResponse', renewed.json));
    assert.deepEqual(
      [renewed.json?.['result'], renewed.json?.['ttl_ms']],
      ['renewed', 6000],
    );
    const second = await postJson(
      core,
      a,
      '/v1/leases/renew',
      lease(core, a, scopeA, randomUUID()),
      UNLOCKED,
    );
    assert.deepEqual(
      [second.status, second.json?.['code']],
      [409, 'audio_owned_elsewhere'],
    );

    const stopped = await postJson(core, a, '/v1/io/stop', {
      request_id: randomUUID(),
      command_scope_id: scopeA,
      scope: 'global',
    });
    assert.equal(stopped.status, 202, stopped.text);
    assert(contract.valid('IoStopResult', stopped.json));
    const devices = (
      stopped.json?.['devices'] as { device_id: string; stop_state: string }[]
    ).toSorted((x, y) => x.device_id.localeCompare(y.device_id));
    assert.deepEqual(
      devices,
      [
        { device_id: a.device.device_id, stop_state: 'confirmed' },
        { device_id: b.device.device_id, stop_state: 'awaiting_ack' },
      ].toSorted((x, y) => x.device_id.localeCompare(y.device_id)),
    );
    assert.deepEqual(
      [stopped.json?.['io_epoch'], stopped.json?.['all_confirmed']],
      ['1', false],
    );
    await stream.waitFor(
      (messages) => messages.some((message) => message.type === 'voice'),
      'voice event',
    );
    const voice = stream.messages.find((message) => message.type === 'voice');
    assert(contract.valid('EventStreamMessage', voice));
    const control = voice?.event?.['audio_control'] as Record<string, unknown>;
    assert.deepEqual(
      [
        control['action'],
        control['reason'],
        control['scope'],
        control['io_epoch'],
      ],
      ['suspend_io', 'global_stop', 'global', '1'],
    );

    // 再接続（bootstrap し直す）だけでは再開しない。
    const again = await boot(core, b);
    const ioB = again['io_state'] as Record<string, unknown>;
    assert.deepEqual(
      [
        ioB['io_epoch'],
        ioB['stop_scope'],
        ioB['input_permitted'],
        ioB['voice_state'],
      ],
      ['1', 'global', false, 'global_stopped'],
    );
    const scopeB2 = String(again['command_scope_id']);
    const resume = (expected: string, origin: string) =>
      postJson(
        core,
        b,
        '/v1/io/resume',
        {
          request_id: randomUUID(),
          command_scope_id: scopeB2,
          scope: 'global',
          expected_io_epoch: expected,
        },
        { ...UNLOCKED, 'buddy-input-origin': origin },
      );
    const voiceOrigin = await resume('1', 'voice');
    assert.deepEqual(
      [voiceOrigin.status, voiceOrigin.json?.['code']],
      [403, 'screen_operation_required'],
    );
    const stale = await resume('0', 'screen');
    assert.deepEqual([stale.status, stale.json?.['code']], [409, 'conflict']);
    const resumed = await resume('1', 'screen');
    assert.equal(resumed.status, 200, resumed.text);
    assert(contract.valid('DeviceIOState', resumed.json));
    assert.deepEqual(
      [resumed.json?.['stop_scope'], resumed.json?.['input_permitted']],
      ['none', true],
    );

    // リースのない端末は Live を開けない（音声所有権の検査は中枢のリース）。
    const live = await postJson(
      core,
      a,
      '/v1/live/sessions',
      {
        request_id: randomUUID(),
        command_scope_id: scopeA,
        session_id: randomUUID(),
        purpose: 'conversation',
        sdp_offer: 'v=0 synthetic-offer',
      },
      UNLOCKED,
    );
    assert.deepEqual(
      [live.status, live.json?.['code']],
      [403, 'audio_ownership_required'],
    );
  },
);
