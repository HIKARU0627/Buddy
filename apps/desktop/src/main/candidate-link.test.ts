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
  });
  onCleanup(t, () => link.stop());
  await link.start('unlocked');
  await waitUntil(() => link.linkState?.phase === 'live', 'live');
  return {
    link,
    requests,
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
  assert.deepEqual(candidateRequests(r), ['GET /v1/candidates']);
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
