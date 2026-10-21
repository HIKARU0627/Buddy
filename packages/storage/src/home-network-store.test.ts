// 自宅の登録値と端末ごとの最新の報告の保存（ADR 0022）。DB は一時ディレクトリに作って消す。
// 期待値は 0003 の制約と本人の判断（家ごとに 1 つ・報告は最新だけ・MAC と SSID は HMAC）から手で書いた値。
// HMAC の値は合成の 16 進 64 桁で、実際の MAC・SSID から作っていない。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  DbWorkerClient,
  executeDeviceOp,
  executeHomeNetworkOp,
} from './index.js';
import type { HomeNetworkOp, HomeNetworkOpResult } from './index.js';
import type { SqliteDatabase } from './connection.js';
import {
  STORE_GENERATION,
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

const T0 = Date.UTC(2030, 9, 5);
const CORE = '00000000-0000-4000-8000-0000000000c1';
const MAC_A = 'a1'.repeat(32);
const MAC_B = 'b2'.repeat(32);
const SSID_A = 'c3'.repeat(32);

function run(
  db: SqliteDatabase,
  op: HomeNetworkOp,
  halted = false,
): HomeNetworkOpResult {
  return executeHomeNetworkOp(db, op, { platform: 'macos', halted }).result;
}

function value<T>(result: HomeNetworkOpResult): T {
  assert.equal(result.ok, true, result.ok ? '' : result.reasons.join(','));
  if (!result.ok) throw new Error('unreachable');
  return result.value as T;
}

function insertDevice(db: SqliteDatabase, deviceId: string, hubLocal = false) {
  const result = executeDeviceOp(
    db,
    {
      kind: 'device.insert',
      device_id: deviceId,
      device_name: '合成の端末',
      platform: 'macos',
      hub_local: hubLocal,
      token_hash: deviceId.replaceAll('-', '').padEnd(64, '0'),
      registered_at: T0,
    },
    { platform: 'macos', halted: false },
  ).result;
  assert.equal(result.ok, true);
}

function issueScope(db: SqliteDatabase, deviceId: string, at: number): string {
  const id = randomUUID();
  const result = executeDeviceOp(
    db,
    {
      kind: 'scope.issue',
      command_scope_id: id,
      device_id: deviceId,
      core_instance_id: CORE,
      issued_at: at,
      expires_at: at + 3_600_000,
    },
    { platform: 'macos', halted: false },
  ).result;
  assert.equal(result.ok, true);
  return id;
}

const register = (
  device_id: string,
  overrides: Partial<Extract<HomeNetworkOp, { kind: 'home.register' }>> = {},
): Extract<HomeNetworkOp, { kind: 'home.register' }> => ({
  kind: 'home.register',
  gateway_mac_hmac: MAC_A,
  subnet: '192.0.2.0/24',
  ssid_hmac: SSID_A,
  registered_at: T0,
  device_id,
  ...overrides,
});

const report = (
  device_id: string,
  overrides: Partial<Extract<HomeNetworkOp, { kind: 'home.report' }>> = {},
): Extract<HomeNetworkOp, { kind: 'home.report' }> => ({
  kind: 'home.report',
  device_id,
  gateway_mac_hmac: MAC_A,
  subnet: '192.0.2.0/24',
  ssid_hmac: null,
  received_at: T0,
  ...overrides,
});

test(
  'one home per household is registered and replaced, and the latest report per device is kept',
  { timeout: 30_000 },
  async () => {
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        const hub = randomUUID();
        const remote = randomUUID();
        insertDevice(db, hub, true);
        insertDevice(db, remote);
        assert.equal(value(run(db, { kind: 'home.get' })), null);
        assert.deepEqual(value(run(db, register(hub))), {
          gateway_mac_hmac: MAC_A,
          subnet: '192.0.2.0/24',
          ssid_hmac: SSID_A,
          registered_at: T0,
          registered_by_device_id: hub,
        });
        // 登録し直すと置き換える（2 件目を作らない）。
        value(
          run(
            db,
            register(hub, {
              gateway_mac_hmac: MAC_B,
              subnet: '198.51.100.0/24',
              ssid_hmac: null,
              registered_at: T0 + 1,
            }),
          ),
        );
        assert.deepEqual(value(run(db, { kind: 'home.get' })), {
          gateway_mac_hmac: MAC_B,
          subnet: '198.51.100.0/24',
          ssid_hmac: null,
          registered_at: T0 + 1,
          registered_by_device_id: hub,
        });
        assert.equal(
          db.prepare('SELECT count(*) FROM home_networks').pluck().get(),
          1,
        );
        // 報告は端末ごとに最新の 1 件。取れない要素は NULL のまま置く。
        assert.equal(
          value(run(db, { kind: 'home.find_report', device_id: remote })),
          null,
        );
        value(
          run(
            db,
            report(remote, {
              gateway_mac_hmac: null,
              subnet: null,
              ssid_hmac: null,
            }),
          ),
        );
        value(
          run(db, report(remote, { received_at: T0 + 5, ssid_hmac: SSID_A })),
        );
        assert.deepEqual(
          value(run(db, { kind: 'home.find_report', device_id: remote })),
          {
            device_id: remote,
            gateway_mac_hmac: MAC_A,
            subnet: '192.0.2.0/24',
            ssid_hmac: SSID_A,
            received_at: T0 + 5,
          },
        );
        assert.equal(
          db.prepare('SELECT count(*) FROM home_network_reports').pluck().get(),
          1,
        );
        // 列は BLOB（32 バイト）で、16 進の文字列や平文を置いていない。
        const stored = db
          .prepare(
            'SELECT typeof(gateway_mac_hmac) AS t, length(gateway_mac_hmac) AS n FROM home_network_reports',
          )
          .get() as { t: string; n: number };
        assert.deepEqual(stored, { t: 'blob', n: 32 });
      } finally {
        db.close();
      }
    });
  },
);

test(
  'reports and registrations need an active device, and revoking scopes leaves other devices alone',
  { timeout: 30_000 },
  async () => {
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        const a = randomUUID();
        const b = randomUUID();
        insertDevice(db, a);
        insertDevice(db, b);
        const refused = (op: HomeNetworkOp, reason: string) => {
          const result = run(db, op);
          assert.equal(result.ok, false, reason);
          if (!result.ok) {
            assert.equal(result.outcome, 'rejected');
            assert(result.reasons.includes(reason), result.reasons.join(','));
          }
        };
        refused(report(randomUUID()), 'device_not_found');
        refused(register(randomUUID()), 'device_not_found');
        const scopeA1 = issueScope(db, a, T0);
        const scopeB = issueScope(db, b, T0);
        assert.deepEqual(
          value(
            run(db, {
              kind: 'home.revoke_scopes',
              device_id: a,
              revoked_at: T0 + 10,
            }),
          ),
          { revoked_scopes: 1 },
        );
        // 失効済みの接続範囲の時刻は変えない。2 回目は 0 件。
        assert.deepEqual(
          value(
            run(db, {
              kind: 'home.revoke_scopes',
              device_id: a,
              revoked_at: T0 + 20,
            }),
          ),
          { revoked_scopes: 0 },
        );
        const revokedAt = (scope: string) =>
          db
            .prepare(
              'SELECT revoked_at FROM command_scopes WHERE command_scope_id = ?',
            )
            .pluck()
            .get(scope);
        assert.equal(revokedAt(scopeA1), T0 + 10);
        assert.equal(revokedAt(scopeB), null);
        // 失効した端末の報告は書かない。
        executeDeviceOp(
          db,
          { kind: 'device.revoke', device_id: a, revoked_at: T0 + 30 },
          { platform: 'macos', halted: false },
        );
        refused(report(a), 'device_revoked');
        refused(register(a), 'device_revoked');
      } finally {
        db.close();
      }
    });
  },
);

test(
  'malformed operations, plaintext-looking values and halted writers are refused',
  { timeout: 30_000 },
  async () => {
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        const a = randomUUID();
        insertDevice(db, a);
        const refused = (op: HomeNetworkOp, reason: string) => {
          const result = run(db, op);
          assert.equal(result.ok, false, reason);
          if (!result.ok)
            assert(result.reasons.includes(reason), result.reasons.join(','));
        };
        // 平文の MAC・SSID を受け取らない（HMAC の 16 進 64 桁だけ）。
        refused(
          register(a, { gateway_mac_hmac: '00:00:5e:00:53:01' }),
          'gateway_mac_hmac_invalid',
        );
        refused(
          register(a, { gateway_mac_hmac: MAC_A.toUpperCase() }),
          'gateway_mac_hmac_invalid',
        );
        refused(register(a, { ssid_hmac: '合成の自宅' }), 'ssid_hmac_invalid');
        refused(
          register(a, { gateway_mac_hmac: null as unknown as string }),
          'gateway_mac_hmac_invalid',
        );
        refused(
          register(a, { subnet: null as unknown as string }),
          'subnet_invalid',
        );
        refused(register(a, { subnet: '192.0.2.0' }), 'subnet_invalid');
        refused(register(a, { registered_at: -1 }), 'registered_at_invalid');
        refused(report('not-a-uuid'), 'device_id_invalid');
        refused(report(a, { ssid_hmac: 'zz'.repeat(32) }), 'ssid_hmac_invalid');
        refused(report(a, { received_at: 1.5 }), 'received_at_invalid');
        refused(
          { kind: 'home.revoke_scopes', device_id: a, revoked_at: Number.NaN },
          'revoked_at_invalid',
        );
        refused(
          { kind: 'home.unknown' } as unknown as HomeNetworkOp,
          'kind_invalid',
        );
        // 書込みを止めた worker は書かない（照会は続ける）。
        assert.deepEqual(run(db, report(a), true), {
          ok: false,
          outcome: 'rejected',
          reasons: ['worker_halted'],
        });
        assert.equal(run(db, { kind: 'home.get' }, true).ok, true);
        // 耐久設定が弱められた接続では書かず、以後の書込みを止める。
        db.pragma('synchronous = NORMAL');
        const weak = executeHomeNetworkOp(db, report(a), {
          platform: 'macos',
          halted: false,
        });
        assert.equal(weak.halt, true);
        assert.equal(weak.result.ok, false);
        if (!weak.result.ok)
          assert.equal(weak.result.reasons[0], 'durability_mismatch');
      } finally {
        db.close();
      }
    });
  },
);

test(
  'the DB worker client carries home network operations',
  { timeout: 30_000 },
  async () => {
    await withTempDir(async (dir) => {
      const path = databasePath(dir);
      openSeededDatabase(path).close();
      const client = await DbWorkerClient.start({
        path,
        storeGeneration: STORE_GENERATION,
        responseTimeoutMs: 10_000,
      });
      try {
        const a = randomUUID();
        const inserted = await client.device({
          kind: 'device.insert',
          device_id: a,
          device_name: '合成の中枢',
          platform: 'macos',
          hub_local: true,
          token_hash: 'd4'.repeat(32),
          registered_at: T0,
        });
        assert(inserted.ok);
        const registered = await client.home(register(a));
        assert(registered.ok);
        assert.equal(registered.value.subnet, '192.0.2.0/24');
        const got = await client.home({ kind: 'home.get' });
        assert(got.ok);
        assert.equal(got.value?.gateway_mac_hmac, MAC_A);
        const reported = await client.home(report(a));
        assert(reported.ok);
        const found = await client.home({
          kind: 'home.find_report',
          device_id: a,
        });
        assert(found.ok);
        assert.equal(found.value?.received_at, T0);
        const revoked = await client.home({
          kind: 'home.revoke_scopes',
          device_id: a,
          revoked_at: T0,
        });
        assert(revoked.ok);
        assert.equal(revoked.value.revoked_scopes, 0);
      } finally {
        await client.close();
      }
      // 閉じたクライアントは送らずに拒否する。
      assert.deepEqual(await client.home({ kind: 'home.get' }), {
        ok: false,
        outcome: 'rejected',
        reasons: ['worker_closed'],
      });
    });
  },
);
