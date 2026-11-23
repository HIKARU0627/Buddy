// 連携の接続の一覧と取得範囲の変更（B08-02 P3・B09-05、ADR 0142）を、127.0.0.1 の Core と main の部品
// （DesktopCoreLink・ConnectionsBridge・限定 IPC の受付）で通す統合の試験（candidate-link.test.ts と同じ形）。
// 中枢は同じプロセスの startCore（鍵は模擬）。端末は中枢の DB に直接登録し（中枢と同じマシンの端末）、接続は
// 中枢の DB に直接置く合成の Google 接続（接続の作成・OAuth は B03-04 で、この試験では作らない）。
// Electron は起動しない。実機・実 API は未実施。
// 確かめること: 一覧が中枢から届き、画面の値に接続 ID・版が載らない・取得範囲の変更が中枢に保存され、許可版と
// 取得範囲の版が上がる・受付の規則（ロック中・前面でない・知らない参照・今の保存値にない対象の追加）が
// 中枢へ何も送らない。
import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDeviceToken, deviceTokenHash } from '@buddy/core';
import type {
  ConnectionTargets,
  DesktopIpcResponse,
  DesktopProviderConnectionsView,
} from '@buddy/contracts';
import type { DesktopIoState } from '@buddy/domain';
import { openWriteConnection, storagePlatform } from '@buddy/storage';
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
const CONNECTION = '00000000-0000-4000-8000-000000000014';

const SAVED_TARGETS: ConnectionTargets = {
  calendar_ids: ['primary'],
  mail_container_ids: ['INBOX'],
  attachment_kinds: ['pdf', 'text'],
  mail_lookback_days: 90,
  calendar_past_days: 30,
  calendar_future_days: 90,
  attachment_max_bytes: 10000000,
};

const NARROWER: ConnectionTargets = {
  calendar_ids: [],
  mail_container_ids: ['INBOX'],
  attachment_kinds: ['pdf'],
  mail_lookback_days: 30,
  calendar_past_days: 7,
  calendar_future_days: 30,
  attachment_max_bytes: 1000000,
};

interface StoredRow {
  readonly targets: string;
  readonly permission_revision: number;
  readonly scope_revision: number;
}

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
  stored(): StoredRow;
}

async function start(t: test.TestContext): Promise<Rig> {
  const dir = await tempDir(t, 'bxl-');
  const dataDir = join(dir, 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const hub = await startHub(t, { dataDir, port: await freePort() });
  const sql = <T>(
    body: (db: ReturnType<typeof openWriteConnection>) => T,
  ): T => {
    const db = openWriteConnection(join(dataDir, 'buddy.sqlite'), {
      platform: storagePlatform(),
    });
    try {
      return body(db);
    } finally {
      db.close();
    }
  };
  // 合成の Google 接続（許可版 3・取得範囲の版 5）。接続の作成そのものは B03-04。
  sql((db) => {
    db.exec(
      `INSERT INTO connections VALUES ('${CONNECTION}', 'google', NULL, 'keystore:synthetic-1', 'active', 'read', '["https://www.googleapis.com/auth/gmail.readonly"]', '${JSON.stringify(SAVED_TARGETS)}', 3, 5)`,
    );
  });
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
  const secret = new SecretText(token);
  await saveCredential(credentialPath, protector, {
    deviceId,
    token: secret,
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
      const { response } = await link.handleConnectionsIpc(
        channel,
        { channel, request_id: randomUUID(), payload },
        options.sender ?? SCREEN,
        options.io ?? UNLOCKED,
      );
      return response;
    },
    stored: () =>
      sql(
        (db) =>
          db
            .prepare(
              'SELECT targets, permission_revision, scope_revision FROM connections WHERE connection_id = ?',
            )
            .get(CONNECTION) as StoredRow,
      ),
  };
}

const connectionRequests = (r: Rig) =>
  r.requests.filter((request) => request.includes('/v1/connections'));

const viewOf = (
  response: DesktopIpcResponse,
): DesktopProviderConnectionsView => {
  assert.equal(response.outcome, 'ok');
  if (response.outcome !== 'ok' || !('connections' in response))
    throw new Error('unreachable');
  return response.connections;
};

const reasonOf = (response: DesktopIpcResponse): string | null =>
  response.outcome === 'rejected' ? response.reason : null;

const refOf = async (r: Rig): Promise<string> => {
  const listed = await r.ipc('desktop.connections_list', null);
  const ref = viewOf(listed).entries[0]?.ref;
  assert(ref !== undefined);
  return ref;
};

test('the list comes from the hub; the screen value has no connection id and no revisions', async (t) => {
  const r = await start(t);
  const view = viewOf(await r.ipc('desktop.connections_list', null));
  assert.equal(view.fetch, 'loaded');
  assert.equal(view.entries.length, 1);
  const entry = view.entries[0];
  assert(entry !== undefined);
  assert.deepEqual(
    { ...entry, ref: 'r' },
    {
      ref: 'r',
      provider: 'google',
      status: 'active',
      access: 'read',
      granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      targets: SAVED_TARGETS,
      graph_account: null,
      delivery_unknown: false,
    },
  );
  assert(!JSON.stringify(view).includes(CONNECTION));
  assert(!JSON.stringify(view).includes('permission_revision'));
  assert.deepEqual(connectionRequests(r), ['GET /v1/connections']);
});

test('an update is saved by the hub and bumps both revisions', async (t) => {
  const r = await start(t);
  const ref = await refOf(r);
  const updated = viewOf(
    await r.ipc('desktop.connection_targets_update', {
      ref,
      targets: NARROWER,
    }),
  );
  const stored = r.stored();
  assert.deepEqual(JSON.parse(stored.targets), NARROWER);
  assert.equal(stored.permission_revision, 4);
  assert.equal(stored.scope_revision, 6);
  assert.deepEqual(updated.entries[0]?.targets, NARROWER);
  assert.deepEqual(connectionRequests(r), [
    'GET /v1/connections',
    `PUT /v1/connections/${CONNECTION}/targets`,
    'GET /v1/connections',
  ]);
});

test('admission: locked, unfocused update and unknown ref send nothing to the hub', async (t) => {
  const r = await start(t);
  const locked = await r.ipc('desktop.connections_list', null, {
    io: { lockState: 'locked', stopScope: 'none', ioEpoch: '0' },
  });
  assert.equal(reasonOf(locked), 'device_locked');
  // 一覧は前面でなくても読める。
  const listed = await r.ipc('desktop.connections_list', null, {
    sender: { trustedSender: true, windowFocused: false },
  });
  const ref = viewOf(listed).entries[0]?.ref;
  assert(ref !== undefined);
  const before = connectionRequests(r).length;
  const unfocused = await r.ipc(
    'desktop.connection_targets_update',
    { ref, targets: NARROWER },
    { sender: { trustedSender: true, windowFocused: false } },
  );
  assert.equal(reasonOf(unfocused), 'screen_operation_required');
  const unknownRef = await r.ipc('desktop.connection_targets_update', {
    ref: randomUUID(),
    targets: NARROWER,
  });
  assert.equal(reasonOf(unknownRef), 'entry_not_found');
  assert.equal(connectionRequests(r).length, before);
  assert.equal(r.stored().permission_revision, 3);
});

test('adding a target that is not saved is refused and sends nothing', async (t) => {
  const r = await start(t);
  const ref = await refOf(r);
  const added = await r.ipc('desktop.connection_targets_update', {
    ref,
    targets: {
      ...NARROWER,
      calendar_ids: ['primary', 'brand-new-calendar'],
    },
  });
  assert.equal(reasonOf(added), 'invalid_request');
  assert.deepEqual(connectionRequests(r), ['GET /v1/connections']);
  assert.equal(r.stored().permission_revision, 3);
});
