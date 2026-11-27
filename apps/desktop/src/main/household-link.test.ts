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
import type {
  ClientAbortSignal,
  ClientApiOutcome,
  ClientApiRequest,
} from '@buddy/client';
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
import type { ReceiptImageCodec } from './household-bridge.js';
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

// 追加の口（レシートの写真の読み取りの試験）。intercept が null 以外を返した要求は中枢へ送らず、その結果にする。
interface RigExtra {
  readonly intercept?: (
    request: ClientApiRequest,
    forward: () => Promise<ClientApiOutcome>,
  ) => Promise<ClientApiOutcome> | null;
  readonly ioState?: () => DesktopIoState;
  readonly pickReceiptImage?: () => Promise<Uint8Array | null>;
  readonly receiptImageCodec?: ReceiptImageCodec;
}

async function start(t: test.TestContext, extra: RigExtra = {}): Promise<Rig> {
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
    ...(extra.ioState === undefined ? {} : { ioState: extra.ioState }),
    ...(extra.pickReceiptImage === undefined
      ? {}
      : { pickReceiptImage: extra.pickReceiptImage }),
    ...(extra.receiptImageCodec === undefined
      ? {}
      : { receiptImageCodec: extra.receiptImageCodec }),
    transportFor: (target, bearer) => {
      const transport = createHubTransport({ hub: target, token: bearer });
      return {
        request: (request) => {
          requests.push(`${request.method} ${request.path}`);
          const intercepted = extra.intercept?.(request, () =>
            transport.request(request),
          );
          return intercepted ?? transport.request(request);
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
  // 請求予定を消す（ADR 0179）: 前面でない・ロック中・ロックの状態が分からないときは拒否し、形の誤りと読んでいない
  // 参照は中枢へ何も送らない。入出力の停止中は受付の規則では拒否しない（参照がないので entry_not_found まで進む）。
  const billHidden = await r.ipc(
    'desktop.household_bill_delete',
    { ref: randomUUID() },
    { sender: { trustedSender: true, windowFocused: false } },
  );
  assert.equal(reason(billHidden), 'screen_operation_required');
  for (const lockState of ['locked', 'unknown'] as const) {
    const billLocked = await r.ipc(
      'desktop.household_bill_delete',
      { ref: randomUUID() },
      { io: { ...UNLOCKED, lockState } },
    );
    assert.equal(reason(billLocked), 'device_locked');
  }
  for (const payload of [
    null,
    {},
    { ref: randomUUID(), bill_id: randomUUID() },
    { ref: randomUUID(), expected_content_revision: '1' },
  ]) {
    const malformed = await r.ipc('desktop.household_bill_delete', payload);
    assert.equal(reason(malformed), 'invalid_request');
  }
  const billStopped = await r.ipc(
    'desktop.household_bill_delete',
    { ref: randomUUID() },
    { io: { ...UNLOCKED, stopScope: 'local' } },
  );
  assert.equal(reason(billStopped), 'entry_not_found');
  // CSV の書き出し（ADR 0172）: 前面でない・ロック中は拒否し、形の誤りと範囲の誤り（逆順・121 か月・2000 年より前・
  // 2099 年より後）は中枢へ何も送らずに拒否する。保存先を選ぶ口がないとき（この組み立て）は、選ばずにやめたのと同じ。
  const range = { from: '2030-01', to: '2030-12' };
  const exportHidden = await r.ipc('desktop.household_export', range, {
    sender: { trustedSender: true, windowFocused: false },
  });
  assert.equal(reason(exportHidden), 'screen_operation_required');
  const exportLocked = await r.ipc('desktop.household_export', range, {
    io: { ...UNLOCKED, lockState: 'locked' },
  });
  assert.equal(reason(exportLocked), 'device_locked');
  for (const payload of [
    null,
    { from: '2030-01' },
    { ...range, path: '/tmp/x.csv' },
    { from: '2030-13', to: '2030-12' },
    { from: '2030-1', to: '2030-12' },
  ]) {
    const malformed = await r.ipc('desktop.household_export', payload);
    assert.equal(reason(malformed), 'invalid_request');
  }
  for (const wrong of [
    { from: '2030-12', to: '2030-01' },
    { from: '2020-01', to: '2030-01' },
    { from: '1999-12', to: '2000-01' },
    { from: '2099-12', to: '2100-01' },
  ]) {
    const outOfRange = await r.ipc('desktop.household_export', wrong);
    assert.equal(reason(outOfRange), 'invalid_request');
  }
  assert.deepEqual(householdRequests(r), []);
});

// 合成の JPEG（SOI・SOF0・SOS・EOI だけ。本物の写真ではない）。
const be16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const syntheticJpeg = (width: number, height: number): Uint8Array =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xda,
    ...be16(8),
    1,
    1,
    0,
    0,
    0x3f,
    0,
    0xff,
    0xd9,
  ]);

test('stopping input while a receipt reading is being sent cuts the request through ioStateChanged', async (t) => {
  let io: DesktopIoState = UNLOCKED;
  const signals: ClientAbortSignal[] = [];
  let reached: () => void = () => undefined;
  const sending = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const r = await start(t, {
    ioState: () => io,
    pickReceiptImage: () => Promise.resolve(syntheticJpeg(3024, 4032)),
    receiptImageCodec: {
      open: () => ({
        width: 3024,
        height: 4032,
        jpeg: () => syntheticJpeg(960, 1280),
      }),
    },
    intercept: (request, forward) => {
      // 中枢は読み取りの口を持たない（unavailable）ので、月ごとの合計の設定だけ入として渡す。
      if (request.method === 'GET' && request.path === '/v1/household/months')
        return forward().then((outcome) =>
          outcome.kind === 'response' &&
          outcome.body !== null &&
          typeof outcome.body === 'object'
            ? { ...outcome, body: { ...outcome.body, receipt_reading: 'on' } }
            : outcome,
        );
      // 読み取りの要求は中枢へ送らず、中断されるまで応答しない（送っている途中の状態を作る）。
      if (request.path === '/v1/household/receipt-readings') {
        const signal = request.signal;
        assert.ok(signal !== undefined);
        signals.push(signal);
        reached();
        return new Promise<ClientApiOutcome>((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ kind: 'unreachable', reason: 'request_aborted' }),
            { once: true },
          );
        });
      }
      return null;
    },
  });
  const view = await r.ipc('desktop.household_view', { month: null });
  assert(view.outcome === 'ok' && 'household' in view);
  assert.equal(view.household.receipt_reading, 'on');
  const pending = r.ipc('desktop.household_receipt_read', null);
  await sending;
  // 入出力が許されている間の通知では切らない。
  r.link.ioStateChanged();
  assert.equal(signals[0]?.aborted, false);
  // 入出力を止めた通知で、送っている途中の読み取りの接続を切る。
  io = { ...UNLOCKED, stopScope: 'local' };
  r.link.ioStateChanged();
  assert.equal(signals[0]?.aborted, true);
  // 中枢が送ったかどうか分からないので結果不明にし、送り直さない。
  assert.equal(reason(await pending), 'outcome_unknown');
  assert.equal(signals.length, 1);
  assert.equal(
    householdRequests(r).filter((request) =>
      request.includes('receipt-readings'),
    ).length,
    1,
  );
});
