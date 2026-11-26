// 家計簿の月ごとの合計と 1 か月の記録・分類の変更・削除（ADR 0162）を、127.0.0.1 の Core と main の部品（DesktopCoreLink・
// HouseholdBridge・限定 IPC の受付）で通す統合の試験（auto-action-link.test.ts と同じ形）。中枢は同じプロセスの startCore
// （鍵は模擬）。端末は中枢の DB に直接登録する。記録のない家計簿で、今月と 12 か月の合計が画面の値に載ることと、受付の
// 規則を確かめる（行の扱い・変更と削除の送り方は household-bridge.test.ts の模擬と apps/core の api-household.test.ts）。
// Electron は起動しない。実機・実データは未実施。
// 確かめること: 中枢の今月と 12 か月の合計が画面の値に載る・記録のない月は「取得できた 0 件」で未取得と区別される・
// 受付の規則（ロック中・前面でない・形の誤り・知らない参照）が中枢へ何も送らない。
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
  readonly requests: string[];
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
  const dir = await tempDir(t, 'bhl-');
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
  return {
    link,
    requests,
    async ipc(channel, payload, options = {}) {
      const { response } = await link.handleHouseholdIpc(
        channel,
        { channel, request_id: randomUUID(), payload },
        options.sender ?? SCREEN,
        options.io ?? UNLOCKED,
      );
      return response;
    },
  };
}

const householdRequests = (r: Rig) =>
  r.requests.filter((request) => request.includes('/v1/household'));

const reason = (response: DesktopIpcResponse) =>
  response.outcome === 'rejected' ? response.reason : null;

test('the current month and the twelve monthly totals come from the hub; an empty month is a loaded zero', async (t) => {
  const r = await start(t);
  const response = await r.ipc('desktop.household_view', { month: null });
  assert(response.outcome === 'ok' && 'household' in response);
  const view = response.household;
  assert.equal(view.fetch, 'loaded');
  assert.match(view.current_month ?? '', /^20[0-9]{2}-[01][0-9]$/u);
  assert.equal(view.month, view.current_month);
  assert.equal(view.months.length, 12);
  assert.equal(view.months[0]?.month, view.current_month);
  assert.deepEqual(view.entries, []);
  assert.deepEqual(view.summary, {
    expense_yen: 0,
    income_yen: 0,
    balance_yen: 0,
    entry_count: 0,
    expense_by_category: [],
    transfer_yen: 0,
  });
  assert.notEqual(view.fetched_at, null);
  assert.equal(JSON.stringify(view).includes('revision'), false);
  assert.deepEqual(householdRequests(r), [
    'GET /v1/household/months',
    `GET /v1/household/months/${String(view.current_month)}`,
  ]);
  // 別の月を選ぶとその月を読む。
  const other = await r.ipc('desktop.household_view', { month: '2031-02' });
  assert(other.outcome === 'ok' && 'household' in other);
  assert.equal(other.household.month, '2031-02');
  assert.equal(householdRequests(r).at(-1), 'GET /v1/household/months/2031-02');
});

test('admission: locked, unfocused, malformed and unknown refs send nothing to the hub', async (t) => {
  const r = await start(t);
  const locked = await r.ipc(
    'desktop.household_view',
    { month: null },
    { io: { ...UNLOCKED, lockState: 'locked' } },
  );
  assert.equal(reason(locked), 'device_locked');
  const hidden = await r.ipc(
    'desktop.household_delete',
    { ref: randomUUID() },
    { sender: { trustedSender: true, windowFocused: false } },
  );
  assert.equal(reason(hidden), 'screen_operation_required');
  const untrusted = await r.ipc(
    'desktop.household_category',
    { ref: randomUUID(), category: 'food' },
    { sender: { trustedSender: false, windowFocused: true } },
  );
  assert.equal(reason(untrusted), 'untrusted_sender');
  for (const payload of [
    { ref: randomUUID(), category: 'groceries' },
    { ref: randomUUID(), category: 'food', entry_id: randomUUID() },
  ]) {
    const malformed = await r.ipc('desktop.household_category', payload);
    assert.equal(reason(malformed), 'invalid_request');
  }
  const badMonth = await r.ipc('desktop.household_view', { month: '2030-13' });
  assert.equal(reason(badMonth), 'invalid_request');
  const unknown = await r.ipc('desktop.household_delete', {
    ref: randomUUID(),
  });
  assert.equal(reason(unknown), 'entry_not_found');
  // この端末の入出力の停止中でも受付の規則では拒否しない（参照がないので entry_not_found まで進む）。
  const stopped = await r.ipc(
    'desktop.household_category',
    { ref: randomUUID(), category: 'food' },
    { io: { ...UNLOCKED, stopScope: 'local' } },
  );
  assert.equal(reason(stopped), 'entry_not_found');
  // 中身の変更（ADR 0169）: 同じ受付。向きの変更は IPC の形では変えられない（項目は契約の形だけ）。
  const entry = {
    direction: 'expense',
    amount_yen: 700,
    occurred_on: '2030-11-04',
    occurred_time: null,
    category: 'food',
    merchant: null,
    memo: null,
    payment: null,
  };
  const editHidden = await r.ipc(
    'desktop.household_edit',
    { ref: randomUUID(), entry },
    { sender: { trustedSender: true, windowFocused: false } },
  );
  assert.equal(reason(editHidden), 'screen_operation_required');
  const editLocked = await r.ipc(
    'desktop.household_edit',
    { ref: randomUUID(), entry },
    { io: { ...UNLOCKED, lockState: 'locked' } },
  );
  assert.equal(reason(editLocked), 'device_locked');
  for (const payload of [
    { ref: randomUUID(), entry: { ...entry, amount_yen: 0 } },
    { ref: randomUUID(), entry, entry_id: randomUUID() },
    { entry },
  ]) {
    const malformed = await r.ipc('desktop.household_edit', payload);
    assert.equal(reason(malformed), 'invalid_request');
  }
  const editUnknown = await r.ipc('desktop.household_edit', {
    ref: randomUUID(),
    entry,
  });
  assert.equal(reason(editUnknown), 'entry_not_found');
  assert.deepEqual(householdRequests(r), []);
});
