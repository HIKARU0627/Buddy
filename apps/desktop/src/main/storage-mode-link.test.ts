// 保存モードの切り替えと記録しない間の表示の値（UI-05 の段階 6、ADR 0189）を、127.0.0.1 の Core と main の部品
// （DesktopCoreLink・StorageModeBridge・OperationBridge・限定 IPC の受付・状態欄）で通す統合の試験（candidate-link.test.ts と
// 同じ形）。中枢は同じプロセスの startCore（鍵は模擬）。端末は中枢の DB に直接登録する。従来の窓（配布版の既定の組み立て）。
// Electron は起動しない。実機・実 API は未実施。期待値は手で書いた。
// 確かめること: 接続したら中枢の保存モードを読んで状態欄に載せる、画面操作の切り替えが中枢の保存境界を動かして状態欄が
// 記録しないになる、前面でない窓・ロック中は中枢へ何も送らない、記録しない間の従来の窓の発言は会話を作らずに流れの経路へ送る
// （B06-07a-2 の 2c までは中枢が断り、何も保存しない）、出たら次の発言で出た先の保存モードの会話を作る、ロックで値を捨てる。
import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDeviceToken, deviceTokenHash } from '@buddy/core';
import type { DesktopIpcResponse } from '@buddy/contracts';
import type { DesktopIoState } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopCoreLink } from './core-link.js';
import { SecretText, saveCredential } from './credential-store.js';
import {
  freePort,
  mockProtector,
  onCleanup,
  startHub,
  tempDir,
  waitUntil,
} from './hub-test-support.js';
import type { TestHub } from './hub-test-support.js';
import { createHubTransport } from './hub-transport.js';
import type { PinnedHub } from './hub-transport.js';
import { buildStatusBar } from './status-bar.js';
import { systemClock } from './system-clock.js';

const contract = createDesktopContract(loadContractSchema());
const UNLOCKED: DesktopIoState = {
  lockState: 'unlocked',
  stopScope: 'none',
  ioEpoch: '0',
};
const SCREEN = { trustedSender: true, windowFocused: true };

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly storageMode: unknown;
  readonly origin: unknown;
}

interface Rig {
  readonly hub: TestHub;
  readonly link: DesktopCoreLink;
  readonly sent: Sent[];
  change(
    mode: string,
    options?: {
      readonly io?: DesktopIoState;
      readonly sender?: typeof SCREEN;
    },
  ): Promise<DesktopIpcResponse>;
  turn(text: string): Promise<DesktopIpcResponse>;
}

async function start(t: test.TestContext): Promise<Rig> {
  const dir = await tempDir(t, 'bsm-');
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
  const pem = await readFile(join(hub.dataDir, 'tls-certificate.pem'), 'utf8');
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
  const sent: Sent[] = [];
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
    log: () => undefined,
    budgetAuto: false,
    backoff: { baseMs: 50, maxMs: 200, jitterRatio: 0 },
    confirmAdmin: () => Promise.resolve(false),
    ioState: () => UNLOCKED,
    transportFor: (target, bearer) => {
      const transport = createHubTransport({ hub: target, token: bearer });
      return {
        request: (request) => {
          const body = (request.body ?? {}) as Record<string, unknown>;
          sent.push({
            method: request.method,
            path: request.path,
            storageMode: body['storage_mode'] ?? null,
            origin: request.screenOperation === true ? 'screen' : null,
          });
          return transport.request(request);
        },
        openStream: (cursor, lockState, listener) =>
          transport.openStream(cursor, lockState, listener),
      };
    },
  });
  onCleanup(t, () => link.stop());
  await link.start('unlocked');
  await waitUntil(() => link.linkState?.phase === 'live', 'live');
  return {
    hub,
    link,
    sent,
    async change(mode, options = {}) {
      const channel = 'desktop.storage_mode_change';
      const { response } = await link.handleStorageModeIpc(
        channel,
        { channel, request_id: randomUUID(), payload: { storage_mode: mode } },
        options.sender ?? SCREEN,
        options.io ?? UNLOCKED,
      );
      return response;
    },
    async turn(text) {
      const channel = 'desktop.turn_submit';
      const { response } = await link.handleOperationIpc(
        channel,
        { channel, request_id: randomUUID(), payload: { text } },
        SCREEN,
        UNLOCKED,
      );
      return response;
    },
  };
}

const modeRequests = (r: Rig) =>
  r.sent.filter((entry) => entry.path === '/v1/stream/storage-mode');

const statusMode = (r: Rig) => {
  const status = buildStatusBar(UNLOCKED, r.link.hubStatus());
  return status.visibility === 'shown' ? status.storage_mode : 'hidden';
};

test(
  'the legacy window reads the mode on connect, enters private by a screen operation, and the status bar shows it',
  { timeout: 60_000 },
  async (t) => {
    const r = await start(t);
    // 接続したら中枢の流れの今の保存モードを読む（まだ区切りがないので通常）。
    await waitUntil(() => statusMode(r) === 'normal', 'read on connect');
    assert.deepEqual(modeRequests(r), [
      {
        method: 'GET',
        path: '/v1/stream/storage-mode',
        storageMode: null,
        origin: null,
      },
    ]);

    // 前面でない窓・ロック中・信頼しない送信元は、中枢へ何も送らない。
    for (const [options, reason] of [
      [
        { sender: { trustedSender: true, windowFocused: false } },
        'screen_operation_required',
      ],
      [{ io: { ...UNLOCKED, lockState: 'locked' as const } }, 'device_locked'],
      [
        { sender: { trustedSender: false, windowFocused: true } },
        'untrusted_sender',
      ],
    ] as const) {
      const refused = await r.change('private', options);
      assert.equal(refused.outcome, 'rejected');
      assert.equal((refused as { reason?: string }).reason, reason);
    }
    assert.equal(modeRequests(r).length, 1);
    assert.equal(statusMode(r), 'normal');

    // 画面操作で記録しないへ入る。中枢へは画面操作として 1 回だけ送り、保存境界が private になる。
    const entered = await r.change('private');
    assert.equal(entered.outcome, 'ok');
    assert.equal(
      (entered as { storage_mode?: string }).storage_mode,
      'private',
    );
    assert.deepEqual(modeRequests(r).at(-1), {
      method: 'POST',
      path: '/v1/stream/storage-mode',
      storageMode: 'private',
      origin: 'screen',
    });
    assert.equal(r.hub.handle.storage.privateConversation(), true);
    assert.equal(statusMode(r), 'private');

    // 記録しない間の従来の窓の発言は会話を作らず、流れの経路へ送る。2c までは中枢が断り、何も保存しない。
    const before = r.sent.length;
    const privateTurn = await r.turn('今日の用事を見せて');
    assert.equal(privateTurn.outcome, 'rejected');
    const during = r.sent.slice(before).map((entry) => entry.path);
    assert(during.includes('/v1/stream/turns'), JSON.stringify(during));
    assert(!during.includes('/v1/sessions'), JSON.stringify(during));
    // 断られた後に保存モードを読み直す（記録しないのまま）。
    await waitUntil(
      () =>
        r.sent
          .slice(before)
          .some(
            (entry) =>
              entry.method === 'GET' &&
              entry.path === '/v1/stream/storage-mode',
          ),
      'read after the refused turn',
    );
    assert.equal(statusMode(r), 'private');

    // 継続相談へ出る。状態欄は継続相談になり、次の従来の窓の発言は継続相談の会話を作る。
    const exited = await r.change('extended');
    assert.equal(exited.outcome, 'ok');
    assert.equal(r.hub.handle.storage.privateConversation(), false);
    assert.equal(statusMode(r), 'extended');
    const mark = r.sent.length;
    await r.turn('今日の用事を見せて');
    const created = r.sent
      .slice(mark)
      .find((entry) => entry.path === '/v1/sessions');
    assert.deepEqual(created, {
      method: 'POST',
      path: '/v1/sessions',
      storageMode: 'extended',
      origin: null,
    });

    // ロックで値を捨てる（状態欄は隠す。解除したら読み直す）。
    r.link.setLockState('locked');
    assert.equal(r.link.hubStatus().storageMode, null);
    r.link.setLockState('unlocked');
    await waitUntil(
      () => r.link.hubStatus().storageMode === 'extended',
      'read after unlock',
    );
  },
);
