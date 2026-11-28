// 自動実行の一覧・取り消し・安全停止の解除（B13-05、ADR 0154）を、127.0.0.1 の Core と main の部品（DesktopCoreLink・
// AutoActionBridge・限定 IPC の受付）で通す統合の試験（candidate-link.test.ts と同じ形）。中枢は同じプロセスの startCore
// （鍵は模擬）。端末は中枢の DB に直接登録する。自動実行は製品の方針で無効のまま（ADR 0074）なので、一覧は空・安全停止は
// 動いているで確かめる（行の扱い・取り消し・解除の送り方は auto-action-bridge.test.ts の模擬と apps/core の
// api-auto-actions.test.ts・api-auto-actions-undo.test.ts）。Electron は起動しない。実機・実 API は未実施。
// 確かめること: 中枢の一覧と安全停止の状態が画面の値に載る・空の一覧は「取得できた 0 件」で未取得と区別される・受付の規則
// （ロック中・前面でない・知らない参照・動いているときの解除）が中枢へ何も送らない。状態欄の安全停止（U315、ADR 0198）は
// 接続したときに読み、中枢の安全停止の知らせで読み直し、ロック中は読まずに解除したときに読む。
import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDeviceToken, deviceTokenHash } from '@buddy/core';
import type { CreateOperationCommand } from '@buddy/storage';
import type { DesktopIpcResponse } from '@buddy/contracts';
import type { DesktopIoState } from '@buddy/domain';
import { createDesktopContract, loadContractSchema } from './contract.js';
import { DesktopCoreLink } from './core-link.js';
import { SecretText, saveCredential } from './credential-store.js';
import { buildStatusBar } from './status-bar.js';
import {
  createCommand,
  freePort,
  mockProtector,
  onCleanup,
  startHub,
  submitDurable,
  tempDir,
  waitUntil,
} from './hub-test-support.js';
import type { TestHub } from './hub-test-support.js';
import { createHubTransport } from './hub-transport.js';
import type { PinnedHub } from './hub-transport.js';
import { systemClock } from './system-clock.js';

const contract = createDesktopContract(loadContractSchema());
const UNLOCKED: DesktopIoState = {
  lockState: 'unlocked',
  stopScope: 'none',
  ioEpoch: '0',
};
const SCREEN = { trustedSender: true, windowFocused: true };

interface Rig {
  readonly link: DesktopCoreLink;
  readonly hub: TestHub;
  readonly deviceId: string;
  readonly requests: string[];
  readonly logs: string[];
  // 状態欄を作り直す知らせ（onChange）の回数。
  readonly changes: { count: number };
  ipc(
    channel: string,
    payload: unknown,
    options?: {
      readonly io?: DesktopIoState;
      readonly sender?: typeof SCREEN;
    },
  ): Promise<DesktopIpcResponse>;
}

async function start(t: test.TestContext): Promise<Rig> {
  const dir = await tempDir(t, 'bal-');
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
  const requests: string[] = [];
  const logs: string[] = [];
  const changes = { count: 0 };
  const link = new DesktopCoreLink({
    contract,
    credentialPath,
    protector,
    clock: systemClock(),
    platform: 'macos',
    collectHome: () =>
      Promise.resolve({ gateway_mac: null, subnet: null, ssid: null }),
    networkSignature: () => 'fixed',
    onChange: () => {
      changes.count += 1;
    },
    log: (code) => logs.push(code),
    budgetAuto: false,
    backoff: { baseMs: 50, maxMs: 200, jitterRatio: 0 },
    confirmAdmin: () => Promise.resolve(false),
    transportFor: (target, bearer) => {
      const transport = createHubTransport({ hub: target, token: bearer });
      return {
        request: (request) => {
          requests.push(`${request.method} ${request.path}`);
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
  // 接続したときの安全停止の読み取り（状態欄。ADR 0198）が済むのを待ち、以後の要求だけを数える。
  await waitUntil(
    () => link.hubStatus().safetyStopped !== null,
    'safety read on connect',
  );
  requests.length = 0;
  return {
    link,
    hub,
    deviceId,
    requests,
    logs,
    changes,
    async ipc(channel, payload, options = {}) {
      const { response } = await link.handleAutoActionIpc(
        channel,
        { channel, request_id: randomUUID(), payload },
        options.sender ?? SCREEN,
        options.io ?? UNLOCKED,
      );
      return response;
    },
  };
}

const autoActionRequests = (r: Rig) =>
  r.requests.filter(
    (request) =>
      request.includes('/v1/auto-actions') || request.includes('/v1/safety/'),
  );

test('the list and the safety state come from the hub; an empty list is a loaded zero', async (t) => {
  const r = await start(t);
  const response = await r.ipc('desktop.auto_actions_list', null);
  assert(response.outcome === 'ok' && 'auto_actions' in response);
  const view = response.auto_actions;
  assert.equal(view.fetch, 'loaded');
  assert.deepEqual(view.entries, []);
  assert.equal(view.safety?.state, 'running');
  assert.equal(view.safety?.stop_reason, null);
  assert.equal(view.safety?.stopped_at, null);
  assert.notEqual(view.fetched_at, null);
  // 画面の値に版・操作 ID の項目がない。
  assert.equal(JSON.stringify(view).includes('revision'), false);
  assert.deepEqual(autoActionRequests(r), ['GET /v1/auto-actions']);
  // 動いているときの解除は送らない（画面の表示が古い）。
  const resume = await r.ipc('desktop.safety_resume', {
    ref: view.safety?.ref,
  });
  assert.equal(
    resume.outcome === 'rejected' ? resume.reason : null,
    'preview_stale',
  );
  assert.deepEqual(autoActionRequests(r), ['GET /v1/auto-actions']);
});

test('admission: locked, unfocused, malformed and unknown refs send nothing to the hub', async (t) => {
  const r = await start(t);
  const locked = await r.ipc('desktop.auto_actions_list', null, {
    io: { ...UNLOCKED, lockState: 'locked' },
  });
  assert.equal(
    locked.outcome === 'rejected' ? locked.reason : null,
    'device_locked',
  );
  const hidden = await r.ipc(
    'desktop.auto_action_undo',
    { ref: randomUUID() },
    { sender: { trustedSender: true, windowFocused: false } },
  );
  assert.equal(
    hidden.outcome === 'rejected' ? hidden.reason : null,
    'screen_operation_required',
  );
  const untrusted = await r.ipc(
    'desktop.safety_resume',
    { ref: randomUUID() },
    { sender: { trustedSender: false, windowFocused: true } },
  );
  assert.equal(
    untrusted.outcome === 'rejected' ? untrusted.reason : null,
    'untrusted_sender',
  );
  const malformed = await r.ipc('desktop.auto_action_undo', {
    ref: randomUUID(),
    operation_id: randomUUID(),
  });
  assert.equal(
    malformed.outcome === 'rejected' ? malformed.reason : null,
    'invalid_request',
  );
  const unknown = await r.ipc('desktop.auto_action_undo', {
    ref: randomUUID(),
  });
  assert.equal(
    unknown.outcome === 'rejected' ? unknown.reason : null,
    'entry_not_found',
  );
  // 画面が見ていない停止の参照（接続のときに読んだ参照と違う）での解除は送らない。
  const resume = await r.ipc('desktop.safety_resume', { ref: randomUUID() });
  assert.equal(
    resume.outcome === 'rejected' ? resume.reason : null,
    'preview_stale',
  );
  // この端末の入出力の停止中でも受付の規則では拒否しない（参照がないので entry_not_found まで進む）。
  const stopped = await r.ipc(
    'desktop.auto_action_undo',
    { ref: randomUUID() },
    { io: { ...UNLOCKED, stopScope: 'local' } },
  );
  assert.equal(
    stopped.outcome === 'rejected' ? stopped.reason : null,
    'entry_not_found',
  );
  assert.deepEqual(autoActionRequests(r), []);
});

// 方針で自動承認したラベルの変更を、同じ対象の鍵で作る（3 回目は記録せずに安全停止になる。ADR 0147）。
const sameTarget = (key: string): CreateOperationCommand => {
  const command = createCommand(randomUUID(), { auto: true });
  assert(command.auto_approval !== null && command.auto_approval !== undefined);
  return {
    ...command,
    auto_approval: { ...command.auto_approval, safety_target_key: key },
  };
};

test('the status bar safety value is read on connect, follows the hub notice, and is not read while locked', async (t) => {
  const r = await start(t);
  assert.equal(r.link.hubStatus().safetyStopped, false);
  // 中枢が安全停止にする（同じ対象への 3 回目）。知らせを受けて一覧を読み直し、状態欄の値が変わる。
  const key = `target:${randomUUID()}`;
  await submitDurable(r.hub, sameTarget(key));
  await submitDurable(r.hub, sameTarget(key));
  const before = r.changes.count;
  const third = await r.hub.handle.store.submit(sameTarget(key)).result;
  assert.equal(third.outcome, 'rejected');
  await waitUntil(
    () => r.link.hubStatus().safetyStopped === true,
    'stopped after the notice',
  );
  assert.deepEqual(autoActionRequests(r), ['GET /v1/auto-actions']);
  assert(r.changes.count > before);
  const bar = buildStatusBar(UNLOCKED, r.link.hubStatus());
  assert(contract.valid('DesktopStatusBar', bar));
  assert.equal(bar.visibility === 'shown' ? bar.safety_stopped : null, true);

  // ロック中は値を捨て、知らせが届いても読まない。
  r.link.setLockState('locked');
  assert.equal(r.link.hubStatus().safetyStopped, null);
  const state = await r.hub.handle.store.safety({ kind: 'safety.state' });
  assert(state.ok);
  const resumed = await r.hub.handle.store.safety({
    kind: 'safety.resume',
    device_id: r.deviceId,
    expected_safety_revision: state.value.safety_revision,
    now: Date.now(),
  });
  assert(resumed.ok);
  await waitUntil(
    () => r.logs.includes('safety_notice_deferred_locked'),
    'notice deferred while locked',
  );
  assert.deepEqual(autoActionRequests(r), ['GET /v1/auto-actions']);
  assert.equal(r.link.hubStatus().safetyStopped, null);

  // 解除したら読み直して、再開した値を出す。
  r.link.setLockState('unlocked');
  await waitUntil(
    () => r.link.hubStatus().safetyStopped === false,
    'running after unlock',
  );
  assert.deepEqual(autoActionRequests(r), [
    'GET /v1/auto-actions',
    'GET /v1/auto-actions',
  ]);
});
