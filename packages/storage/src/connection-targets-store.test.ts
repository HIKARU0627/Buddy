// 連携の接続の取得対象の読み取りと変更の保存（B08-02、ADR 0088）。DB は一時ディレクトリに作って消す。
// 期待値は設計の値（過去 90 日・添付は PDF とテキスト・1 件 10MB）と、本人の決定 D5（広げる既定値を作らない）、
// 設計 11 §1A（範囲の変更は版を上げ、旧走査を abandoned にする）から手で書いた値。実装の表から作らない。
// 接続・取得対象は合成で、実アカウント・実データは使わない。

import assert from 'node:assert/strict';
import test from 'node:test';
import { DbWorkerClient, executeConnectionTargetsOp } from './index.js';
import type {
  ConnectionRecord,
  ConnectionTargetsOp,
  ConnectionTargetsOpResult,
  ConnectionTargetsUpdated,
} from './index.js';
import type { SqliteDatabase } from './connection.js';
import {
  STORE_GENERATION,
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

function run(
  db: SqliteDatabase,
  op: ConnectionTargetsOp,
  halted = false,
): ConnectionTargetsOpResult {
  return executeConnectionTargetsOp(db, op, { platform: 'macos', halted })
    .result;
}

function value<T>(result: ConnectionTargetsOpResult): T {
  assert.equal(result.ok, true, result.ok ? '' : result.reasons.join(','));
  if (!result.ok) throw new Error('unreachable');
  return result.value as T;
}

function reasons(result: ConnectionTargetsOpResult): readonly string[] {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.outcome, 'rejected');
  return result.reasons;
}

const targets = (over: Record<string, unknown> = {}) => ({
  calendar_ids: ['primary'],
  mail_container_ids: ['INBOX', 'Label_1'],
  attachment_kinds: ['pdf'] as ('pdf' | 'text')[],
  mail_lookback_days: 30,
  calendar_past_days: 30,
  calendar_future_days: 90,
  attachment_max_bytes: 5000000,
  ...over,
});

const update = (
  expected: string,
  over: Record<string, unknown> = {},
  connection_id = 'c-1',
): ConnectionTargetsOp => ({
  kind: 'connections.update_targets',
  connection_id,
  expected_permission_revision: expected,
  targets: targets(over) as never,
});

function stored(db: SqliteDatabase, id = 'c-1') {
  return db
    .prepare(
      'SELECT targets, permission_revision, scope_revision FROM connections WHERE connection_id = ?',
    )
    .get(id) as {
    targets: string;
    permission_revision: number;
    scope_revision: number;
  };
}

// 同期の取得集合と走査を置く（connection_id は外部キー）。
function seedScope(
  db: SqliteDatabase,
  connectionId: string,
  scopeId: string,
  revision: number,
  batch: {
    scanId: string;
    kind: 'incremental' | 'full';
    status: string;
  } | null,
) {
  db.prepare(
    `INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_scan_id, active_generation, executor_generation)
     VALUES (?, ?, ?, ?, 0, 0)`,
  ).run(
    scopeId,
    connectionId,
    revision,
    batch?.status === 'fetching' ? batch.scanId : null,
  );
  if (batch === null) return;
  db.prepare(
    `INSERT INTO sync_batches (scan_id, scope_id, scope_revision, kind, base_generation, scan_started_at, window_start, window_end,
       query_fingerprint, executor_generation, status, delete_at)
     VALUES (?, ?, ?, ?, 0, 1000, 0, 1000, 'fp', 0, ?, 99999)`,
  ).run(batch.scanId, scopeId, revision, batch.kind, batch.status);
}

function scopeRow(db: SqliteDatabase, scopeId: string) {
  return db
    .prepare(
      'SELECT scope_revision, active_scan_id, pending_full, pending_incremental FROM sync_scopes WHERE scope_id = ?',
    )
    .get(scopeId) as {
    scope_revision: number;
    active_scan_id: string | null;
    pending_full: number;
    pending_incremental: number;
  };
}

const batchStatus = (db: SqliteDatabase, scanId: string): string =>
  (
    db
      .prepare('SELECT status FROM sync_batches WHERE scan_id = ?')
      .get(scanId) as { status: string }
  ).status;

test('an incomplete stored selection is read as nothing selected, never as a wider default', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      // 種の接続 c-1 は targets が '{}'（4 項目も選択も無い古い形）。
      const got = value<ConnectionRecord>(
        run(db, { kind: 'connections.get', connection_id: 'c-1' }),
      );
      assert.equal(got.targets_state, 'incomplete');
      assert.deepEqual(got.targets, {
        calendar_ids: [],
        mail_container_ids: [],
        attachment_kinds: [],
        mail_lookback_days: 90,
        calendar_past_days: 30,
        calendar_future_days: 90,
        attachment_max_bytes: 10000000,
      });
      assert.equal(got.permission_revision, '1');
      assert.equal(got.scope_revision, '1');
      assert.equal(got.provider, 'google');
      assert.equal(got.status, 'active');
      // 読んだだけでは書かない。
      assert.equal(stored(db).targets, '{}');
      assert.equal(
        value(run(db, { kind: 'connections.get', connection_id: 'nope' })),
        null,
      );
      const list = value<ConnectionRecord[]>(
        run(db, { kind: 'connections.list' }),
      );
      assert.deepEqual(
        list.map((c) => c.connection_id),
        ['c-1'],
      );
    } finally {
      db.close();
    }
  });
});

test('the first save rewrites an incomplete row even with the same content, and raises both revisions', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      // 空の選択を保存し直しても、保存済みの値が不完全なので書き直す。
      const empty = update('1', {
        calendar_ids: [],
        mail_container_ids: [],
        attachment_kinds: [],
        mail_lookback_days: 90,
        calendar_past_days: 30,
        calendar_future_days: 90,
        attachment_max_bytes: 10000000,
      });
      const first = value<ConnectionTargetsUpdated>(run(db, empty));
      assert.equal(first.changed, true);
      assert.equal(first.connection.targets_state, 'complete');
      assert.equal(first.connection.permission_revision, '2');
      assert.equal(first.connection.scope_revision, '2');
      assert.deepEqual(JSON.parse(stored(db).targets), {
        calendar_ids: [],
        mail_container_ids: [],
        attachment_kinds: [],
        mail_lookback_days: 90,
        calendar_past_days: 30,
        calendar_future_days: 90,
        attachment_max_bytes: 10000000,
      });
    } finally {
      db.close();
    }
  });
});

test('a changed selection is stored sorted and raises the permission and scope revisions by one', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      const result = value<ConnectionTargetsUpdated>(
        run(
          db,
          update('1', {
            calendar_ids: ['work', 'primary'],
            mail_container_ids: ['Label_1', 'INBOX'],
            attachment_kinds: ['text', 'pdf'],
          }),
        ),
      );
      assert.equal(result.changed, true);
      assert.equal(result.abandoned_scans, 0);
      assert.deepEqual(result.connection.targets, {
        calendar_ids: ['primary', 'work'],
        mail_container_ids: ['INBOX', 'Label_1'],
        attachment_kinds: ['pdf', 'text'],
        mail_lookback_days: 30,
        calendar_past_days: 30,
        calendar_future_days: 90,
        attachment_max_bytes: 5000000,
      });
      assert.equal(result.connection.permission_revision, '2');
      assert.equal(result.connection.scope_revision, '2');
      const row = stored(db);
      assert.equal(row.permission_revision, 2);
      assert.equal(row.scope_revision, 2);
      // 次の変更では、新しい許可版でなければ受け付けない（古い版は拒否）。
      assert.deepEqual(reasons(run(db, update('1', { calendar_ids: [] }))), [
        'permission_revision_mismatch',
      ]);
      assert.equal(stored(db).permission_revision, 2);
      const second = value<ConnectionTargetsUpdated>(
        run(db, update('2', { calendar_ids: ['primary'] })),
      );
      assert.equal(second.connection.permission_revision, '3');
      assert.equal(second.connection.scope_revision, '3');
    } finally {
      db.close();
    }
  });
});

test('the same selection again changes nothing, whatever the order of the lists', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      value(run(db, update('1')));
      const before = stored(db);
      const again = value<ConnectionTargetsUpdated>(
        run(db, update('2', { mail_container_ids: ['Label_1', 'INBOX'] })),
      );
      assert.equal(again.changed, false);
      assert.equal(again.abandoned_scans, 0);
      assert.equal(again.connection.permission_revision, '2');
      assert.deepEqual(stored(db), before);
    } finally {
      db.close();
    }
  });
});

test('a missing, disconnected or stale connection is rejected and nothing is written', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      db.exec(
        "INSERT INTO connections VALUES ('c-off', 'google', NULL, NULL, 'disconnected', 'read', '[]', '{}', 4, 4)",
      );
      assert.deepEqual(reasons(run(db, update('1', {}, 'nope'))), [
        'connection_not_found',
      ]);
      assert.deepEqual(reasons(run(db, update('4', {}, 'c-off'))), [
        'connection_disconnected',
      ]);
      assert.deepEqual(reasons(run(db, update('0'))), [
        'permission_revision_mismatch',
      ]);
      assert.deepEqual(reasons(run(db, update('2'))), [
        'permission_revision_mismatch',
      ]);
      assert.equal(stored(db).targets, '{}');
      assert.equal(stored(db, 'c-off').permission_revision, 4);
    } finally {
      db.close();
    }
  });
});

test('selections wider than the design limits, wrong shapes and extra keys are rejected without writing', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      const cases: [Record<string, unknown>, string][] = [
        [{ mail_lookback_days: 91 }, 'mail_lookback_out_of_range'],
        [{ mail_lookback_days: 0 }, 'mail_lookback_out_of_range'],
        [{ calendar_past_days: 31 }, 'calendar_past_out_of_range'],
        [{ calendar_future_days: 91 }, 'calendar_future_out_of_range'],
        [
          { attachment_max_bytes: 10000001 },
          'attachment_max_bytes_out_of_range',
        ],
        [{ attachment_max_bytes: 1.5 }, 'attachment_max_bytes_out_of_range'],
        [{ attachment_kinds: ['pdf', 'docx'] }, 'attachment_kind_unknown'],
        [{ attachment_kinds: ['pdf', 'pdf'] }, 'duplicate_attachment_kind'],
        [{ calendar_ids: [''] }, 'calendar_id_invalid'],
        [{ mail_container_ids: ['a', 'a'] }, 'duplicate_mail_container_id'],
      ];
      for (const [over, issue] of cases)
        assert.deepEqual(
          reasons(run(db, update('1', over))),
          ['targets_invalid', issue],
          issue,
        );
      assert.deepEqual(
        reasons(run(db, update('1', { calendar_ids: 'primary' }))),
        ['targets_invalid', 'targets_lists_invalid'],
      );
      assert.deepEqual(reasons(run(db, update('1', { unlimited: true }))), [
        'targets_invalid',
        'targets_keys_invalid',
      ]);
      const missing = update('1') as unknown as {
        targets: Record<string, unknown>;
      };
      delete missing.targets['mail_lookback_days'];
      assert.deepEqual(reasons(run(db, missing as never)), [
        'targets_invalid',
        'targets_keys_invalid',
      ]);
      assert.deepEqual(
        reasons(
          run(db, {
            ...(update('1') as object),
            expected_permission_revision: '01',
          } as never),
        ),
        ['expected_permission_revision_invalid'],
      );
      assert.deepEqual(
        reasons(run(db, { kind: 'connections.get', connection_id: '' })),
        ['connection_id_invalid'],
      );
      assert.equal(stored(db).targets, '{}');
      assert.equal(stored(db).permission_revision, 1);
    } finally {
      db.close();
    }
  });
});

test('changing the selection abandons the old scans, follows the new scope revision and leaves other connections alone', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      db.exec(
        "INSERT INTO connections VALUES ('c-2', 'google', NULL, 'keystore:c-2', 'active', 'read', '[]', '{}', 7, 7)",
      );
      seedScope(db, 'c-1', 's-mail', 1, {
        scanId: 'scan-full',
        kind: 'full',
        status: 'fetching',
      });
      seedScope(db, 'c-1', 's-cal', 1, {
        scanId: 'scan-inc',
        kind: 'incremental',
        status: 'fetching',
      });
      seedScope(db, 'c-1', 's-idle', 1, null);
      seedScope(db, 'c-2', 's-other', 7, {
        scanId: 'scan-other',
        kind: 'full',
        status: 'fetching',
      });
      const changed = value<ConnectionTargetsUpdated>(run(db, update('1')));
      assert.equal(changed.abandoned_scans, 2);
      assert.equal(batchStatus(db, 'scan-full'), 'abandoned');
      assert.equal(batchStatus(db, 'scan-inc'), 'abandoned');
      assert.deepEqual(scopeRow(db, 's-mail'), {
        scope_revision: 2,
        active_scan_id: null,
        pending_full: 1,
        pending_incremental: 0,
      });
      assert.deepEqual(scopeRow(db, 's-cal'), {
        scope_revision: 2,
        active_scan_id: null,
        // 変更のたびに全量照合を必ず要求する（U207 の決定 (b)、B08-05、ADR 0136）。
        pending_full: 1,
        pending_incremental: 1,
      });
      assert.deepEqual(scopeRow(db, 's-idle'), {
        scope_revision: 2,
        active_scan_id: null,
        pending_full: 1,
        pending_incremental: 0,
      });
      // 別の接続の取得集合と走査は変えない。
      assert.equal(batchStatus(db, 'scan-other'), 'fetching');
      assert.deepEqual(scopeRow(db, 's-other'), {
        scope_revision: 7,
        active_scan_id: 'scan-other',
        pending_full: 0,
        pending_incremental: 0,
      });
      assert.equal(stored(db, 'c-2').targets, '{}');
    } finally {
      db.close();
    }
  });
});

test('an unchanged selection or a rejected update leaves the running scan alone', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      value(run(db, update('1')));
      seedScope(db, 'c-1', 's-mail', 2, {
        scanId: 'scan-1',
        kind: 'full',
        status: 'fetching',
      });
      assert.equal(
        value<ConnectionTargetsUpdated>(run(db, update('2'))).changed,
        false,
      );
      reasons(run(db, update('1', { calendar_ids: [] })));
      reasons(run(db, update('2', { mail_lookback_days: 91 })));
      assert.equal(batchStatus(db, 'scan-1'), 'fetching');
      assert.deepEqual(scopeRow(db, 's-mail'), {
        scope_revision: 2,
        active_scan_id: 'scan-1',
        pending_full: 0,
        pending_incremental: 0,
      });
    } finally {
      db.close();
    }
  });
});

test('a halted worker still reads but does not write', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      assert.deepEqual(reasons(run(db, update('1'), true)), ['worker_halted']);
      assert.equal(stored(db).permission_revision, 1);
      assert.equal(
        value<ConnectionRecord | null>(
          run(db, { kind: 'connections.get', connection_id: 'c-1' }, true),
        )?.connection_id,
        'c-1',
      );
    } finally {
      db.close();
    }
  });
});

test(
  'the DB worker serves reads and the compare-and-swap update',
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
        const list = await client.connectionTargets({
          kind: 'connections.list',
        });
        assert(list.ok);
        assert.deepEqual(
          list.value.map((c) => c.connection_id),
          ['c-1'],
        );
        const saved = await client.connectionTargets({
          kind: 'connections.update_targets',
          connection_id: 'c-1',
          expected_permission_revision: '1',
          targets: targets() as never,
        });
        assert(saved.ok);
        assert.equal(saved.value.changed, true);
        assert.equal(saved.value.connection.permission_revision, '2');
        const stale = await client.connectionTargets({
          kind: 'connections.update_targets',
          connection_id: 'c-1',
          expected_permission_revision: '1',
          targets: targets({ calendar_ids: [] }) as never,
        });
        assert(!stale.ok);
        assert.equal(stale.outcome, 'rejected');
        assert.deepEqual(stale.reasons, ['permission_revision_mismatch']);
        const got = await client.connectionTargets({
          kind: 'connections.get',
          connection_id: 'c-1',
        });
        assert(got.ok);
        assert.equal(got.value?.targets_state, 'complete');
        assert.equal(got.value?.targets.mail_lookback_days, 30);
      } finally {
        await client.close();
      }
    });
  },
);

// --- B03-04: 接続の作成・切断・再認可（ADR 0144）。期待値は手書き。封筒の中身は合成。 ---

const accountBlob = (over: Record<string, unknown> = {}) => ({
  blob_id: 'blob-conn-2',
  format_version: 1,
  key_id: 'data-key-1',
  nonce: new Uint8Array(12).fill(7),
  ciphertext: new Uint8Array([1, 2, 3, 4]),
  tag: new Uint8Array(16).fill(9),
  ...over,
});

const create = (over: Record<string, unknown> = {}): ConnectionTargetsOp =>
  ({
    kind: 'connections.create',
    connection_id: 'c-2',
    provider: 'microsoft',
    created_at: 1763856000000,
    account: accountBlob(),
    credential_ref: 'oauth-v1:c-2',
    access: 'read',
    granted_scopes: ['Mail.Read', 'offline_access'],
    targets: targets({
      calendar_ids: [],
      mail_container_ids: ['inbox'],
    }),
    scopes: [
      { scope_id: 'scope:c-2:mail', resource: 'mail' },
      { scope_id: 'scope:c-2:calendar', resource: 'calendar' },
    ],
    ...over,
  }) as ConnectionTargetsOp;

test('create stores the connection, the account envelope, and pending-full scopes in one go', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      const created = value<ConnectionRecord>(run(db, create()));
      assert.equal(created.connection_id, 'c-2');
      assert.equal(created.provider, 'microsoft');
      assert.equal(created.status, 'active');
      assert.equal(created.access, 'read');
      assert.deepEqual(created.granted_scopes, ['Mail.Read', 'offline_access']);
      assert.equal(created.permission_revision, '1');
      assert.equal(created.scope_revision, '1');
      assert.equal(created.targets_state, 'complete');
      assert.deepEqual(created.targets.mail_container_ids, ['inbox']);
      // 封筒は所有者 connections・内容版 0・用途 connection_account で入る。
      const blobRow = db
        .prepare(
          'SELECT owner_table, owner_id, owner_version, purpose FROM sealed_blobs WHERE blob_id = ?',
        )
        .get('blob-conn-2') as {
        owner_table: string;
        owner_id: string;
        owner_version: number;
        purpose: string;
      };
      assert.deepEqual(blobRow, {
        owner_table: 'connections',
        owner_id: 'c-2',
        owner_version: 0,
        purpose: 'connection_account',
      });
      // 取得集合は 2 つとも scope_revision 1・pending_full 1（最初の走査は全量）。
      for (const scopeId of ['scope:c-2:mail', 'scope:c-2:calendar']) {
        const row = scopeRow(db, scopeId);
        assert.equal(row.scope_revision, 1);
        assert.equal(row.pending_full, 1);
        assert.equal(row.pending_incremental, 0);
        assert.equal(row.active_scan_id, null);
      }
      // 封筒はそのまま読み戻せる（Core が開ける形）。
      const blob = value<ReturnType<typeof accountBlob>>(
        run(db, { kind: 'connections.account_blob', connection_id: 'c-2' }),
      );
      assert.equal(blob.blob_id, 'blob-conn-2');
      assert.equal(blob.key_id, 'data-key-1');
      assert.deepEqual([...blob.nonce], new Array(12).fill(7));
      assert.deepEqual([...blob.ciphertext], [1, 2, 3, 4]);
      // 無い接続の封筒は null。
      assert.equal(
        value(
          run(db, { kind: 'connections.account_blob', connection_id: 'nope' }),
        ),
        null,
      );
    } finally {
      db.close();
    }
  });
});

test('create refuses a duplicate connection id and malformed inputs', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      assert.deepEqual(reasons(run(db, create({ connection_id: 'c-1' }))), [
        'connection_exists',
      ]);
      assert.ok(
        reasons(run(db, create({ provider: 'other' as never }))).includes(
          'provider_invalid',
        ),
      );
      assert.ok(
        reasons(
          run(
            db,
            create({ account: accountBlob({ nonce: new Uint8Array(3) }) }),
          ),
        ).includes('account_blob_invalid'),
      );
      assert.ok(
        reasons(run(db, create({ scopes: [] }))).includes('scopes_invalid'),
      );
      assert.ok(
        reasons(
          run(
            db,
            create({
              scopes: [
                { scope_id: 's-1', resource: 'mail' },
                { scope_id: 's-1', resource: 'calendar' },
              ],
            }),
          ),
        ).includes('scopes_invalid'),
      );
      // 失敗した作成は接続を残さない。
      assert.equal(
        value(run(db, { kind: 'connections.get', connection_id: 'c-2' })),
        null,
      );
    } finally {
      db.close();
    }
  });
});

test('disconnect requires the revision, clears the credential reference and pending flags, and is idempotent', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db, 'c-1', 'scope-1', 1, {
        scanId: 'scan-1',
        kind: 'incremental',
        status: 'fetching',
      });
      db.prepare(
        'UPDATE sync_scopes SET pending_full = 1 WHERE scope_id = ?',
      ).run('scope-1');
      assert.deepEqual(
        reasons(
          run(db, {
            kind: 'connections.disconnect',
            connection_id: 'c-1',
            expected_permission_revision: '9',
          }),
        ),
        ['permission_revision_mismatch'],
      );
      const done = value<ConnectionTargetsUpdated>(
        run(db, {
          kind: 'connections.disconnect',
          connection_id: 'c-1',
          expected_permission_revision: '1',
        }),
      );
      assert.equal(done.changed, true);
      assert.equal(done.abandoned_scans, 1);
      assert.equal(done.connection.status, 'disconnected');
      assert.equal(done.connection.permission_revision, '2');
      assert.equal(batchStatus(db, 'scan-1'), 'abandoned');
      const row = scopeRow(db, 'scope-1');
      assert.equal(row.pending_full, 0);
      assert.equal(row.pending_incremental, 0);
      assert.equal(row.active_scan_id, null);
      const credential = db
        .prepare(
          'SELECT credential_ref FROM connections WHERE connection_id = ?',
        )
        .get('c-1') as { credential_ref: string | null };
      assert.equal(credential.credential_ref, null);
      // 冪等: 版が合えば 2 回目は成功で何も変わらない。
      const again = value<ConnectionTargetsUpdated>(
        run(db, {
          kind: 'connections.disconnect',
          connection_id: 'c-1',
          expected_permission_revision: '2',
        }),
      );
      assert.equal(again.changed, false);
      assert.equal(again.connection.permission_revision, '2');
      // 切断済みの取得対象は変えられない。
      assert.deepEqual(reasons(run(db, update('2'))), [
        'connection_disconnected',
      ]);
    } finally {
      db.close();
    }
  });
});

test('reactivate restores an active connection without touching targets, and refuses a disconnected one', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      value(
        run(db, {
          kind: 'connections.mark_needs_reauth',
          connection_id: 'c-1',
        }),
      );
      const before = stored(db);
      const restored = value<ConnectionRecord>(
        run(db, {
          kind: 'connections.reactivate',
          connection_id: 'c-1',
          credential_ref: 'oauth-v1:c-1',
          access: 'read_write',
          granted_scopes: ['gmail.modify'],
        }),
      );
      assert.equal(restored.status, 'active');
      assert.equal(restored.access, 'read_write');
      assert.deepEqual(restored.granted_scopes, ['gmail.modify']);
      assert.equal(restored.permission_revision, '2');
      // 取得対象と取得範囲の版は触らない。
      const after = stored(db);
      assert.equal(after.targets, before.targets);
      assert.equal(after.scope_revision, before.scope_revision);
      // 切断した接続は再認可では戻らない（作り直す）。
      value(
        run(db, {
          kind: 'connections.disconnect',
          connection_id: 'c-1',
          expected_permission_revision: '2',
        }),
      );
      assert.deepEqual(
        reasons(
          run(db, {
            kind: 'connections.reactivate',
            connection_id: 'c-1',
            credential_ref: 'oauth-v1:c-1',
            access: 'read',
            granted_scopes: [],
          }),
        ),
        ['connection_disconnected'],
      );
    } finally {
      db.close();
    }
  });
});

test('mark_needs_reauth only moves an active connection and keeps the revision', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      const marked = value<ConnectionRecord>(
        run(db, {
          kind: 'connections.mark_needs_reauth',
          connection_id: 'c-1',
        }),
      );
      assert.equal(marked.status, 'needs_reauth');
      assert.equal(marked.permission_revision, '1');
      // 2 回目はそのまま（active でないので動かさない）。
      const again = value<ConnectionRecord>(
        run(db, {
          kind: 'connections.mark_needs_reauth',
          connection_id: 'c-1',
        }),
      );
      assert.equal(again.status, 'needs_reauth');
      assert.equal(
        value(
          run(db, {
            kind: 'connections.mark_needs_reauth',
            connection_id: 'nope',
          }),
        ),
        null,
      );
    } finally {
      db.close();
    }
  });
});
