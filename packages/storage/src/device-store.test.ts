// 端末と接続範囲（command_scope）の保存（ADR 0020）。DB は一時ディレクトリに作って消す。
// 期待値は 0001 の制約（devices・command_scopes）と 07 §2（最長 24 時間・再接続で無効）から手で書いた値。

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  COMMAND_SCOPE_MAX_TTL_MS,
  DbWorkerClient,
  executeDeviceOp,
} from './index.js';
import type { DeviceOp, DeviceOpResult } from './index.js';
import type { SqliteDatabase } from './connection.js';
import {
  STORE_GENERATION,
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2030, 9, 5);
const CORE = '00000000-0000-4000-8000-0000000000c1';
// 合成の照合用の hash（トークンそのものではない）。
const tokenHash = (label: string) =>
  createHash('sha256').update(`synthetic-token:${label}`).digest('hex');

function run(db: SqliteDatabase, op: DeviceOp, halted = false): DeviceOpResult {
  return executeDeviceOp(db, op, { platform: 'macos', halted }).result;
}

function value<T>(result: DeviceOpResult): T {
  assert.equal(result.ok, true, result.ok ? '' : result.reasons.join(','));
  if (!result.ok) throw new Error('unreachable');
  return result.value as T;
}

const insert = (
  device_id: string,
  label: string,
  hub_local = false,
): Extract<DeviceOp, { kind: 'device.insert' }> => ({
  kind: 'device.insert',
  device_id,
  device_name: '合成の端末',
  platform: 'macos',
  hub_local,
  token_hash: tokenHash(label),
  registered_at: T0,
});

const issue = (
  device_id: string,
  issued_at: number,
  expires_at = issued_at + COMMAND_SCOPE_MAX_TTL_MS,
  core_instance_id = CORE,
): Extract<DeviceOp, { kind: 'scope.issue' }> => ({
  kind: 'scope.issue',
  command_scope_id: randomUUID(),
  device_id,
  core_instance_id,
  issued_at,
  expires_at,
});

test(
  'devices are found by token hash and a new scope revokes the previous one',
  { timeout: 30_000 },
  async () => {
    assert.equal(COMMAND_SCOPE_MAX_TTL_MS, 24 * HOUR);
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        const a = randomUUID();
        const device = value<Record<string, unknown>>(
          run(db, insert(a, 'a', true)),
        );
        assert.deepEqual(device, {
          device_id: a,
          device_name: '合成の端末',
          platform: 'macos',
          hub_local: true,
          registered_at: T0,
          last_seen_at: null,
          revoked_at: null,
        });
        // 照合用の hash だけで引く。結果に hash は含めない。
        const found = value<Record<string, unknown> | null>(
          run(db, {
            kind: 'device.find_by_token_hash',
            token_hash: tokenHash('a'),
          }),
        );
        assert.equal(found?.['device_id'], a);
        assert.equal('token_hash' in (found ?? {}), false);
        assert.equal(
          value(
            run(db, {
              kind: 'device.find_by_token_hash',
              token_hash: tokenHash('x'),
            }),
          ),
          null,
        );
        // 同じ端末 ID・同じ hash の二重登録は拒否する。
        assert.deepEqual(run(db, insert(a, 'other')), {
          ok: false,
          outcome: 'rejected',
          reasons: ['device_exists'],
        });
        assert.deepEqual(run(db, insert(randomUUID(), 'a')), {
          ok: false,
          outcome: 'rejected',
          reasons: ['constraint_violation'],
        });

        const firstOp = issue(a, T0 + 1000);
        const first = value<Record<string, unknown>>(run(db, firstOp));
        assert.deepEqual(first, {
          command_scope_id: (firstOp as { command_scope_id: string })
            .command_scope_id,
          device_id: a,
          core_instance_id: CORE,
          issued_at: T0 + 1000,
          expires_at: T0 + 1000 + 24 * HOUR,
          revoked_at: null,
        });
        const second = value<Record<string, unknown>>(
          run(db, issue(a, T0 + 2000)),
        );
        // 新しい接続範囲を発行すると、同じ端末の前の接続範囲は無効（発行の時刻で失効）。
        const old = value<Record<string, unknown>>(
          run(db, {
            kind: 'scope.find',
            command_scope_id: String(first['command_scope_id']),
          }),
        );
        assert.equal(old['revoked_at'], T0 + 2000);
        const current = value<Record<string, unknown>>(
          run(db, {
            kind: 'scope.find',
            command_scope_id: String(second['command_scope_id']),
          }),
        );
        assert.equal(current['revoked_at'], null);
        // 端末の最終接続は発行の時刻。
        const seen = value<Record<string, unknown>>(
          run(db, {
            kind: 'device.find_by_token_hash',
            token_hash: tokenHash('a'),
          }),
        );
        assert.equal(seen['last_seen_at'], T0 + 2000);
        // 他の端末の接続範囲は無効にしない。
        const b = randomUUID();
        value(run(db, insert(b, 'b')));
        value(run(db, issue(b, T0 + 3000)));
        assert.equal(
          value<Record<string, unknown>>(
            run(db, {
              kind: 'scope.find',
              command_scope_id: String(second['command_scope_id']),
            }),
          )['revoked_at'],
          null,
        );
        assert.equal(
          value(
            run(db, { kind: 'scope.find', command_scope_id: randomUUID() }),
          ),
          null,
        );
      } finally {
        db.close();
      }
    });
  },
);

test(
  'revoking a device revokes its scopes and blocks new scopes',
  { timeout: 30_000 },
  async () => {
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        const a = randomUUID();
        value(run(db, insert(a, 'a')));
        const scope = value<Record<string, unknown>>(run(db, issue(a, T0)));
        assert.deepEqual(
          value(
            run(db, {
              kind: 'device.revoke',
              device_id: a,
              revoked_at: T0 + 10,
            }),
          ),
          { revoked_scopes: 1 },
        );
        assert.equal(
          value<Record<string, unknown>>(
            run(db, {
              kind: 'scope.find',
              command_scope_id: String(scope['command_scope_id']),
            }),
          )['revoked_at'],
          T0 + 10,
        );
        const found = value<Record<string, unknown>>(
          run(db, {
            kind: 'device.find_by_token_hash',
            token_hash: tokenHash('a'),
          }),
        );
        assert.equal(found['revoked_at'], T0 + 10);
        // 失効済みの端末には発行しない。失効の時刻は変えない。
        assert.deepEqual(run(db, issue(a, T0 + 20)), {
          ok: false,
          outcome: 'rejected',
          reasons: ['device_revoked'],
        });
        value(
          run(db, { kind: 'device.revoke', device_id: a, revoked_at: T0 + 30 }),
        );
        assert.equal(
          value<Record<string, unknown>>(
            run(db, {
              kind: 'device.find_by_token_hash',
              token_hash: tokenHash('a'),
            }),
          )['revoked_at'],
          T0 + 10,
        );
        assert.deepEqual(run(db, issue(randomUUID(), T0)), {
          ok: false,
          outcome: 'rejected',
          reasons: ['device_not_found'],
        });
        assert.deepEqual(
          run(db, {
            kind: 'device.revoke',
            device_id: randomUUID(),
            revoked_at: T0,
          }),
          { ok: false, outcome: 'rejected', reasons: ['device_not_found'] },
        );
      } finally {
        db.close();
      }
    });
  },
);

test(
  'malformed operations, scopes longer than 24 hours and halted writers are refused',
  { timeout: 30_000 },
  async () => {
    await withTempDir((dir) => {
      const db = openSeededDatabase(databasePath(dir));
      try {
        const a = randomUUID();
        value(run(db, insert(a, 'a')));
        const refused = (op: DeviceOp, reason: string) => {
          const result = run(db, op);
          assert.equal(result.ok, false, reason);
          if (!result.ok)
            assert(result.reasons.includes(reason), result.reasons.join(','));
        };
        refused(issue(a, T0, T0 + 24 * HOUR + 1), 'expires_at_invalid');
        refused(issue(a, T0, T0), 'expires_at_invalid');
        refused(
          { ...insert(randomUUID(), 'c'), device_name: '' },
          'device_name_invalid',
        );
        refused(
          { ...insert(randomUUID(), 'c'), device_name: 'x'.repeat(41) },
          'device_name_invalid',
        );
        refused({ ...insert('not-a-uuid', 'c') }, 'device_id_invalid');
        refused(
          { ...insert(randomUUID(), 'c'), token_hash: 'AB'.repeat(32) },
          'token_hash_invalid',
        );
        refused(
          { ...insert(randomUUID(), 'c'), platform: 'ios' as 'macos' },
          'platform_invalid',
        );
        refused(
          { kind: 'device.find_by_token_hash', token_hash: '00' },
          'token_hash_invalid',
        );
        refused(
          { kind: 'scope.find', command_scope_id: 'x' },
          'command_scope_id_invalid',
        );
        // ちょうど 24 時間は受け付ける。
        value(run(db, issue(a, T0, T0 + 24 * HOUR)));
        // 書込みを止めた worker は書かない（照会は続ける）。
        assert.deepEqual(run(db, issue(a, T0 + 1), true), {
          ok: false,
          outcome: 'rejected',
          reasons: ['worker_halted'],
        });
        assert.equal(
          run(
            db,
            { kind: 'device.find_by_token_hash', token_hash: tokenHash('a') },
            true,
          ).ok,
          true,
        );
        // 耐久設定が弱められた接続では書かず、以後の書込みを止める。
        db.pragma('synchronous = NORMAL');
        const weak = executeDeviceOp(db, issue(a, T0 + 2), {
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
  'the DB worker client carries device and scope operations',
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
          device_name: '合成の端末',
          platform: 'windows',
          hub_local: false,
          token_hash: tokenHash('worker'),
          registered_at: T0,
        });
        assert(inserted.ok);
        assert.equal(inserted.value.platform, 'windows');
        const found = await client.device({
          kind: 'device.find_by_token_hash',
          token_hash: tokenHash('worker'),
        });
        assert(found.ok);
        assert.equal(found.value?.device_id, a);
        const issued = await client.device({
          kind: 'scope.issue',
          command_scope_id: randomUUID(),
          device_id: a,
          core_instance_id: CORE,
          issued_at: T0,
          expires_at: T0 + HOUR,
        });
        assert(issued.ok);
        const scope = await client.device({
          kind: 'scope.find',
          command_scope_id: issued.value.command_scope_id,
        });
        assert(scope.ok);
        assert.equal(scope.value?.expires_at, T0 + HOUR);
      } finally {
        await client.close();
      }
      // 閉じたクライアントは送らずに拒否する。
      assert.deepEqual(
        await client.device({
          kind: 'scope.find',
          command_scope_id: randomUUID(),
        }),
        { ok: false, outcome: 'rejected', reasons: ['worker_closed'] },
      );
    });
  },
);
