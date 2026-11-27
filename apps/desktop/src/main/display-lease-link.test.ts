// 表示のリース（UI-05 の段階 4、ADR 0188）を、127.0.0.1 の製品の Core（startCore、鍵は模擬）と main の部品（DesktopCoreLink・
// DisplayLeaseKeeper・CanvasBridge・@buddy/client）で通す統合の試験（notice-link.test.ts と同じ形）。Electron は起動しない。
// リースの時計とタイマーは手で進める（実時間を待たない）。接続の時計は実時間のまま（再接続の間隔は 50 ms）。
// 確かめること: 接続したらリースを取ってからキャンバスを読む・2 秒ごとに更新する・更新が届かないと期限で失い、物を描かない理由を
// 窓へ渡す・取り直せたらキャンバスを読み直す・中枢が拒否したら（入出力の世代が進んだ）失ったままで取り直しを続ける・接続し直して
// 中枢の世代を受け取ったら取り直す・ロック中は更新しない。期待値は手で書いた。実機・実データは未実施。
import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDeviceToken, deviceTokenHash } from '@buddy/core';
import type { ClientStreamEvent } from '@buddy/client';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopCoreLink } from './core-link.js';
import type { CanvasChangedNotification } from './core-link.js';
import { SecretText, saveCredential } from './credential-store.js';
import {
  freePort,
  mockProtector,
  onCleanup,
  startHub,
  tempDir,
  waitUntil,
} from './hub-test-support.js';
import { createHubTransport } from './hub-transport.js';
import type { PinnedHub } from './hub-transport.js';
import { systemClock } from './system-clock.js';
import { ManualVoiceClock } from './voice-test-support.js';

const contract = createDesktopContract(loadContractSchema());

interface RenewAnswer {
  readonly result: string;
  readonly reasons: readonly string[];
}

test(
  'the canvas is read only while the display lease is held; an expiry or a core rejection withholds it with the reason, and taking the lease again reads it again',
  { timeout: 60_000 },
  async (t) => {
    const dir = await tempDir(t, 'bdl-');
    const dataDir = join(dir, 'data');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const hub = await startHub(t, { dataDir, port: await freePort() });
    const protector = mockProtector();
    const token = createDeviceToken();
    const deviceId = randomUUID();
    const inserted = await hub.handle.store.device({
      kind: 'device.insert',
      device_id: deviceId,
      device_name: '合成の端末',
      platform: 'macos',
      hub_local: true,
      token_hash: deviceTokenHash(token),
      registered_at: Date.now(),
    });
    assert(inserted.ok, 'device insert failed');
    const pem = await readFile(
      join(hub.dataDir, 'tls-certificate.pem'),
      'utf8',
    );
    const pinned: PinnedHub = {
      host: '127.0.0.1',
      port: hub.port,
      certificatePem: pem,
      fingerprint: new X509Certificate(pem).fingerprint256
        .replaceAll(':', '')
        .toLowerCase(),
    };
    const credentialPath = join(dir, 'device-credential.bin');
    await saveCredential(credentialPath, protector, {
      deviceId,
      token: new SecretText(token),
      issuedAt: '2030-10-05T00:00:00Z',
      hub: pinned,
    });

    const lease = new ManualVoiceClock();
    // 中枢へ送った更新の本文と答え・キャンバスの読み取りの数・窓へ渡した通知。
    const renewBodies: Record<string, unknown>[] = [];
    const answers: RenewAnswer[] = [];
    let canvasReads = 0;
    const notices: CanvasChangedNotification[] = [];
    const logs: string[] = [];
    // true の間、更新を中枢へ届けない（結果が分からない）。
    let dropRenewals = false;
    let streamListener: ((event: ClientStreamEvent) => void) | null = null;
    const link = new DesktopCoreLink({
      contract,
      credentialPath,
      protector,
      clock: systemClock(),
      platform: 'macos',
      collectHome: () =>
        Promise.resolve({ gateway_mac: null, subnet: null, ssid: null }),
      networkSignature: () => 'fixed',
      onChange: () => undefined,
      log: (code) => logs.push(code),
      budgetAuto: false,
      backoff: { baseMs: 50, maxMs: 200, jitterRatio: 0 },
      confirmAdmin: () => Promise.resolve(false),
      canvasMode: true,
      onCanvas: (notification) => notices.push(notification),
      displayLease: {
        clock: {
          mono: () => lease.mono,
          wall: () => lease.wall,
          setTimer: lease.setTimer,
          newId: () => randomUUID(),
        },
      },
      transportFor: (target, bearer) => {
        const transport = createHubTransport({ hub: target, token: bearer });
        return {
          request: async (request) => {
            if (request.method === 'GET' && request.path === '/v1/canvas')
              canvasReads += 1;
            if (request.path !== '/v1/leases/renew')
              return transport.request(request);
            renewBodies.push({ ...request.body });
            if (dropRenewals)
              return { kind: 'unreachable', reason: 'test_drop' } as const;
            const outcome = await transport.request(request);
            if (outcome.kind === 'response' && outcome.status === 200) {
              const body = outcome.body as RenewAnswer;
              answers.push({ result: body.result, reasons: body.reasons });
            }
            return outcome;
          },
          openStream: (cursor, lockState, listener) => {
            streamListener = listener;
            return transport.openStream(cursor, lockState, listener);
          },
        };
      },
    });
    onCleanup(t, () => link.stop());
    const latest = () => notices.at(-1);
    const withheldNow = () => {
      const last = latest();
      return (
        last !== undefined &&
        last.canvas === null &&
        'withheld_reason' in last &&
        last.withheld_reason === 'display_lease_lost'
      );
    };

    // 1. 接続したら表示のリースを取り、取れてからキャンバスを読む。
    await link.start('unlocked');
    await waitUntil(() => link.displayLeaseState === 'held', 'first lease');
    await waitUntil(() => latest()?.canvas != null, 'first canvas');
    await link.canvasIdle();
    assert.equal(canvasReads, 1);
    assert.equal(renewBodies.length, 1);
    const first = renewBodies[0] as Record<string, unknown>;
    assert.equal(first['kind'], 'display');
    assert.equal(first['device_id'], deviceId);
    assert.equal(first['previous_nonce'], null);
    assert.equal(first['io_epoch'], '0');
    assert.equal(first['heartbeat_ms'], 2000);
    assert.equal(first['ttl_ms'], 6000);
    assert.equal(answers.length, 1);
    assert.deepEqual(answers[0], { result: 'renewed', reasons: [] });

    // 2. 2 秒ごとに同じリースを更新する（中枢が受け付ける）。読み取りは増えない。
    await lease.advance(2000);
    await waitUntil(() => answers.length === 2, 'second renewal');
    assert.equal(renewBodies[1]?.['lease_id'], first['lease_id']);
    assert.equal(renewBodies[1]?.['previous_nonce'], first['nonce']);
    assert.deepEqual(answers[1], { result: 'renewed', reasons: [] });
    assert.equal(link.displayLeaseState, 'held');
    assert.equal(canvasReads, 1);

    // 3. 更新が届かない: 期限（最後に受け付けた更新を送った時点 3000 + 6 秒 = 9000）で失い、物を描かない理由を窓へ渡す。
    dropRenewals = true;
    assert.equal(lease.mono, 3000);
    await lease.advance(5999);
    assert.equal(link.displayLeaseState, 'held');
    await lease.advance(1);
    assert.equal(link.displayLeaseState, 'lost');
    assert(withheldNow(), 'withheld after expiry');
    assert.equal(link.canvasView(), null);
    assert.deepEqual(link.canvasNotification(), {
      channel: 'desktop.canvas_changed',
      canvas: null,
      withheld_reason: 'display_lease_lost',
    });
    // 失っている間は、キャンバスの知らせ・取り直しの失敗があっても読まない。
    await lease.advance(2000);
    await link.canvasIdle();
    assert.equal(canvasReads, 1);
    assert.equal(link.displayLeaseState, 'lost');

    // 4. 届くようになった: 次の取り直し（4 秒後）で新しい lease_id を取り、キャンバスを読み直す。
    dropRenewals = false;
    const beforeRetry = renewBodies.length;
    await lease.advance(4000);
    await waitUntil(() => link.displayLeaseState === 'held', 'lease again');
    await waitUntil(() => latest()?.canvas != null, 'canvas again');
    await link.canvasIdle();
    assert.equal(canvasReads, 2);
    const retried = renewBodies[beforeRetry] as Record<string, unknown>;
    assert.notEqual(retried['lease_id'], first['lease_id']);
    assert.equal(retried['previous_nonce'], null);

    // 5. 中枢がこの端末の入出力を止めて世代を進めた: 次の更新を中枢が拒否し、失う。端末は bootstrap の世代しか知らないので、
    //    再開しても取り直しは拒否され続ける（U470）。
    const connection = link.connection;
    assert(connection !== null);
    const stopped = await connection.request({
      method: 'POST',
      path: '/v1/io/stop',
      body: { scope: 'local' },
      scoped: true,
    });
    // 中枢の停止の応答は 202（停止の到達の状態を返す。ADR 0046）。
    assert.equal(stopped.kind === 'response' && stopped.status, 202);
    const answered = answers.length;
    await lease.advance(2000);
    await waitUntil(() => answers.length === answered + 1, 'rejected renewal');
    assert.equal(answers.at(-1)?.result, 'rejected');
    assert(answers.at(-1)?.reasons.includes('stale_io_epoch'));
    await waitUntil(() => link.displayLeaseState === 'lost', 'lost by core');
    assert(withheldNow(), 'withheld after rejection');
    const resumed = await connection.request({
      method: 'POST',
      path: '/v1/io/resume',
      body: { scope: 'local', expected_io_epoch: '1' },
      scoped: true,
      screenOperation: true,
    });
    assert.equal(resumed.kind === 'response' && resumed.status, 200);
    await lease.advance(2000);
    await waitUntil(() => answers.length === answered + 2, 'retry rejected');
    assert.deepEqual(answers.at(-1)?.reasons, ['stale_io_epoch']);
    assert.equal(link.displayLeaseState, 'lost');
    assert.equal(canvasReads, 2);

    // 6. 接続し直して中枢の世代（1）を受け取った: 取り直してキャンバスを読み直す。切れている間は理由を出さない。
    const listener = streamListener as
      ((event: ClientStreamEvent) => void) | null;
    assert(listener !== null);
    listener({ type: 'closed', code: 1006, reason: '' });
    await waitUntil(
      () => link.linkState?.phase === 'live' && link.linkState.ioEpoch === '1',
      'reconnected',
    );
    await waitUntil(
      () => link.displayLeaseState === 'held',
      'lease after reconnect',
    );
    await waitUntil(() => latest()?.canvas != null, 'canvas after reconnect');
    await link.canvasIdle();
    assert.equal(canvasReads, 3);
    assert.equal(renewBodies.at(-1)?.['io_epoch'], '1');
    assert.equal(renewBodies.at(-1)?.['previous_nonce'], null);
    assert.equal(answers.at(-1)?.result, 'renewed');

    // 7. ロック中は更新しない（理由も出さない）。解除したら新しいリースを取ってから読む。
    link.setLockState('locked');
    assert.equal(link.displayLeaseState, 'idle');
    const lockedCount = renewBodies.length;
    await lease.advance(20_000);
    assert.equal(renewBodies.length, lockedCount);
    assert(!withheldNow());
    link.setLockState('unlocked');
    await waitUntil(
      () => link.displayLeaseState === 'held',
      'lease after unlock',
    );
    await waitUntil(() => canvasReads >= 4, 'canvas after unlock');
    await link.canvasIdle();
    assert.equal(renewBodies[lockedCount]?.['previous_nonce'], null);

    // ログにリースの ID・nonce を出さない（状態と理由のコードだけ）。
    for (const code of logs)
      assert(!/[0-9a-f]{8}-[0-9a-f]{4}-/u.test(code), code);
  },
);
