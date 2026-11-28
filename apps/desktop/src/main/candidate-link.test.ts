// 気づきの一覧と状態の変更（B11-05、ADR 0132）を、127.0.0.1 の Core と main の部品（DesktopCoreLink・CandidateBridge・限定 IPC
// の受付）で通す統合の試験（budget-link.test.ts と同じ形）。中枢は同じプロセスの startCore（鍵は模擬）。端末は中枢の DB に
// 直接登録する。候補の作成（candidate-intake）は製品に配線されていないので、一覧は空のまま確かめる（行の扱いは
// candidate-bridge.test.ts の模擬と apps/core の api-candidates.test.ts）。Electron は起動しない。実機・実 API は未実施。
// 確かめること: 一覧の前の保守を挟んでも中枢の一覧が届き、本人のタイムゾーンと並べた時刻が画面の値に載る・空の一覧は「取得
// できた 0 件」で未取得と区別される・受付の規則（ロック中・前面でない・知らない参照）が中枢へ何も送らない。
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

// 中枢の本人のタイムゾーンは OS のタイムゾーン（ADR 0131）。この試験のプロセスだけ合成の値に固定する。
process.env['TZ'] = 'Asia/Tokyo';

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
  // 中枢（知らせの中継を試験から直接使う）。
  readonly hub: Awaited<ReturnType<typeof startHub>>;
  // candidateAlerts を渡したときの OS 通知の数とトレイの更新の回数（ADR 0196）。
  readonly shown: number[];
  readonly changed: { count: number };
  ipc(
    channel: string,
    payload: unknown,
    options?: {
      readonly io?: DesktopIoState;
      readonly sender?: typeof SCREEN;
    },
  ): Promise<DesktopIpcResponse>;
}

async function start(
  t: test.TestContext,
  options: { readonly alerts?: boolean } = {},
): Promise<Rig> {
  const shown: number[] = [];
  const changed = { count: 0 };
  const dir = await tempDir(t, 'bcl-');
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
    ...(options.alerts === true
      ? {
          candidateAlerts: {
            show: (count: number) => {
              shown.push(count);
            },
            changed: () => {
              changed.count += 1;
            },
          },
        }
      : {}),
  });
  onCleanup(t, () => link.stop());
  await link.start('unlocked');
  await waitUntil(() => link.linkState?.phase === 'live', 'live');
  return {
    link,
    requests,
    hub,
    shown,
    changed,
    async ipc(channel, payload, options = {}) {
      const { response } = await link.handleCandidateIpc(
        channel,
        { channel, request_id: randomUUID(), payload },
        options.sender ?? SCREEN,
        options.io ?? UNLOCKED,
      );
      return response;
    },
  };
}

const candidateRequests = (r: Rig) =>
  r.requests.filter((request) => request.includes('/v1/candidates'));

test('the list comes from the hub with the person zone and time; an empty list is a loaded zero', async (t) => {
  const r = await start(t);
  const before = Date.now();
  const response = await r.ipc('desktop.candidates_list', null);
  assert.equal(response.outcome, 'ok');
  assert(response.outcome === 'ok' && 'candidates' in response);
  const view = response.candidates;
  assert.equal(view.fetch, 'loaded');
  assert.equal(view.zone, 'Asia/Tokyo');
  assert.deepEqual(view.entries, []);
  assert.deepEqual(view.counts, {
    new: 0,
    seen: 0,
    acted: 0,
    dismissed: 0,
    snoozed: 0,
    resolved: 0,
  });
  assert.equal(view.truncated, false);
  // 並べた時刻は中枢の時計（この試験の前後の間）。
  const asOf = Date.parse(view.fetched_at ?? '');
  assert(asOf >= before - 1000 && asOf <= Date.now() + 1000, String(asOf));
  assert.deepEqual(candidateRequests(r), [
    'GET /v1/candidates',
    'GET /v1/candidates/alert-settings',
  ]);
  // OS 通知の設定は既定の切（版は画面へ出さない）。
  assert.equal(view.alert?.os_notification, 'off');
});

// 中枢の知らせの中継へ、気づきの増減の知らせを直接入れる（候補の作成は中枢の試験 candidate-alert-core.test.ts）。
const publishCandidate = (r: Rig, count: number): number =>
  (
    r.hub.handle.notices as unknown as {
      publishCandidate(message: unknown): number;
    }
  ).publishCandidate({
    type: 'notice',
    notice: {
      schema: 'buddy.candidate-notice.v1',
      notice_id: randomUUID(),
      occurred_at: '2030-10-09T03:00:00Z',
      alert_count: count,
    },
  });

const streamOpen = async (r: Rig) => {
  const relay = r.hub.handle.notices as unknown as { listenerCount: number };
  await waitUntil(() => relay.listenerCount === 1, 'stream subscribed');
};

test('the OS notification setting goes through the screen IPC; a candidate notice shows an alert only while on and unlocked', async (t) => {
  const r = await start(t, { alerts: true });
  await streamOpen(r);
  // 接続の後、設定だけを後ろで読む（切なので一覧は読まない）。
  await waitUntil(
    () => candidateRequests(r).length === 1 && r.changed.count >= 1,
    'background read',
  );
  assert.deepEqual(candidateRequests(r), ['GET /v1/candidates/alert-settings']);
  assert.equal(r.link.candidateTray(), null);

  // 切の間の知らせ（設定を変えた直後の 1 通など）では OS 通知を出さない。
  assert.equal(publishCandidate(r, 1), 1);
  await waitUntil(() => candidateRequests(r).length === 2, 'notice read');
  assert.deepEqual(r.shown, []);

  const listed = await r.ipc('desktop.candidates_list', null);
  assert(listed.outcome === 'ok' && 'candidates' in listed);
  const ref = listed.candidates.alert?.ref;
  assert(ref !== undefined);
  // 前面でない画面からは変えない。
  const hidden = await r.ipc(
    'desktop.candidate_alert_setting',
    { settings_ref: ref, os_notification: 'on' },
    { sender: { trustedSender: true, windowFocused: false } },
  );
  assert.equal(
    hidden.outcome === 'rejected' ? hidden.reason : null,
    'screen_operation_required',
  );
  const on = await r.ipc('desktop.candidate_alert_setting', {
    settings_ref: ref,
    os_notification: 'on',
  });
  assert(on.outcome === 'ok' && 'candidates' in on, JSON.stringify(on));
  assert.equal(on.candidates.alert?.os_notification, 'on');
  // 入にしたので一覧を読み、トレイの件数（0 件）が出る。
  assert.equal(r.link.candidateTray(), 0);
  // 古い参照からの変更は中枢へ送らない。
  const before = candidateRequests(r).length;
  const stale = await r.ipc('desktop.candidate_alert_setting', {
    settings_ref: ref,
    os_notification: 'off',
  });
  assert.equal(
    stale.outcome === 'rejected' ? stale.reason : null,
    'preview_stale',
  );
  assert.equal(candidateRequests(r).length, before);

  // 入の間の知らせ: 設定と一覧を読み直してから、中枢の決めた数で OS 通知を出させる。
  publishCandidate(r, 2);
  await waitUntil(() => r.shown.length === 1, 'alert shown');
  assert.deepEqual(r.shown, [2]);
  // 数 0 の知らせ（件数の変化だけ）は OS 通知を出さない。
  const changes = r.changed.count;
  publishCandidate(r, 0);
  await waitUntil(() => r.changed.count > changes, 'count refreshed');
  assert.deepEqual(r.shown, [2]);

  // ロック中は読まず、出さない。トレイの件数も消す。
  r.link.setLockState('locked');
  assert.equal(r.link.candidateTray(), null);
  const locked = candidateRequests(r).length;
  publishCandidate(r, 3);
  // ロックを解くと件数だけ読み直す（ロック中の知らせの OS 通知は出し直さない）。
  r.link.setLockState('unlocked');
  await waitUntil(() => r.link.candidateTray() === 0, 'tray after unlock');
  assert.deepEqual(r.shown, [2]);
  assert(candidateRequests(r).length > locked);
});

test('admission: locked, unfocused state changes and unknown refs send nothing to the hub', async (t) => {
  const r = await start(t);
  const locked = await r.ipc('desktop.candidates_list', null, {
    io: { ...UNLOCKED, lockState: 'locked' },
  });
  assert.deepEqual(
    locked.outcome === 'rejected' ? locked.reason : null,
    'device_locked',
  );
  const hidden = await r.ipc(
    'desktop.candidate_state',
    { ref: randomUUID(), event: 'open', snooze_until: null },
    { sender: { trustedSender: true, windowFocused: false } },
  );
  assert.deepEqual(
    hidden.outcome === 'rejected' ? hidden.reason : null,
    'screen_operation_required',
  );
  const unknown = await r.ipc('desktop.candidate_state', {
    ref: randomUUID(),
    event: 'dismiss',
    snooze_until: null,
  });
  assert.deepEqual(
    unknown.outcome === 'rejected' ? unknown.reason : null,
    'entry_not_found',
  );
  // 形の違う要求（扱わない操作）は受け付けない。
  const resolve = await r.ipc('desktop.candidate_state', {
    ref: randomUUID(),
    event: 'resolve',
    snooze_until: null,
  });
  assert.deepEqual(
    resolve.outcome === 'rejected' ? resolve.reason : null,
    'invalid_request',
  );
  assert.deepEqual(candidateRequests(r), []);
});

test('a state change is accepted while this device is stopped (it is a record, not an output)', async (t) => {
  const r = await start(t);
  // 停止中でも受付の規則では拒否しない（参照がないので entry_not_found まで進む）。
  const stopped = await r.ipc(
    'desktop.candidate_state',
    { ref: randomUUID(), event: 'open', snooze_until: null },
    { io: { ...UNLOCKED, stopScope: 'local' } },
  );
  assert.deepEqual(
    stopped.outcome === 'rejected' ? stopped.reason : null,
    'entry_not_found',
  );
});

// 見直しの指摘 8: 忘却の知らせ（候補の削除は気づきの知らせを出さない）でも、件数を読み直す。期限切れの知らせでは読まない。
test('a forgotten notice makes main re-read the candidate count; an expiry notice does not', async (t) => {
  const r = await start(t, { alerts: true });
  await streamOpen(r);
  await waitUntil(() => r.changed.count >= 1, 'background read');
  const notice = (kind: 'expired' | 'forgotten') => ({
    schema: 'buddy.retention-notice.v1' as const,
    notice_id: randomUUID(),
    occurred_at: '2030-10-09T03:00:00Z',
    kind,
    reason:
      kind === 'expired' ? ('retention_due' as const) : ('forgotten' as const),
    forgetting_generation: kind === 'expired' ? null : '1',
    items: [{ item_kind: 'turn' as const, item_id: randomUUID() }],
  });
  const publish = (value: unknown) =>
    (
      r.hub.handle.notices as unknown as {
        publish(notice: unknown): void | Promise<void>;
      }
    ).publish(value);
  const reads = candidateRequests(r).length;
  await publish(notice('expired'));
  await publish(notice('forgotten'));
  await waitUntil(
    () => candidateRequests(r).length === reads + 1,
    'one re-read after the forgotten notice',
  );
  // 次の既知の知らせ（数 0 の気づきの知らせ）が読まれた時点で、期限切れの知らせで読んでいないことを確かめる。
  publishCandidate(r, 0);
  await waitUntil(
    () => candidateRequests(r).length === reads + 2,
    'the candidate notice re-read',
  );
  assert.deepEqual(r.shown, []);
});
