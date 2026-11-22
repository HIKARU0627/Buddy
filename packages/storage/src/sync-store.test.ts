// 同期の走査の保存（B08-05、設計 11 §1A、ADR 0007）。DB は一時ディレクトリに作って消す。
// 期待値は設計 11 §1A と domain の規則（排他・pending・公開 CAS・差分ゼロで世代を進めない）から手で書いた値。
// 接続・取得集合・元情報は合成で、実アカウント・実データは使わない。

import assert from 'node:assert/strict';
import test from 'node:test';
import { DbWorkerClient, executeSyncOp } from './index.js';
import type {
  SyncBatchValue,
  SyncBeginValue,
  SyncOp,
  SyncOpResult,
  SyncPublishValue,
  SyncPublishedItem,
  SyncScopeSnapshot,
} from './index.js';
import type { SqliteDatabase } from './connection.js';
import {
  STORE_GENERATION,
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

const WM = '2025-12-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';
const DONE = '2026-01-02T01:00:00.000Z';
const WIN_START = '2026-01-01T00:00:00.000Z';
const WIN_END = '2026-01-02T00:00:00.000Z';

function run(db: SqliteDatabase, op: SyncOp, halted = false): SyncOpResult {
  return executeSyncOp(db, op, { platform: 'macos', halted }).result;
}

function value<T>(result: SyncOpResult): T {
  assert.equal(result.ok, true, result.ok ? '' : result.reasons.join(','));
  if (!result.ok) throw new Error('unreachable');
  return result.value as T;
}

function reasons(result: SyncOpResult): readonly string[] {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.outcome, 'rejected');
  return result.reasons;
}

function seedScope(
  db: SqliteDatabase,
  over: {
    scope_id?: string;
    connection_id?: string;
    scope_revision?: number;
    active_generation?: number;
    committed_watermark?: number | null;
    provider_cursor?: string | null;
    executor_generation?: number;
  } = {},
) {
  db.prepare(
    `INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_scan_id, active_generation,
       committed_watermark, provider_cursor, executor_generation, last_incremental_completed_at,
       last_full_reconciled_at, pending_incremental, pending_full, analysis_plan_complete_generation)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, 0, 0, NULL)`,
  ).run(
    over.scope_id ?? 's-1',
    over.connection_id ?? 'c-1',
    over.scope_revision ?? 3,
    over.active_generation ?? 5,
    over.committed_watermark === undefined
      ? Date.parse(WM)
      : over.committed_watermark,
    over.provider_cursor === undefined ? 'cur-1' : over.provider_cursor,
    over.executor_generation ?? 2,
  );
}

function seedItem(
  db: SqliteDatabase,
  remoteId: string,
  revision: string,
  over: {
    provider?: string;
    account_id?: string;
    scope_id?: string;
    published_generation?: number;
    fetched_at?: number;
    body_blob_id?: string | null;
  } = {},
) {
  db.prepare(
    `INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id,
       published_generation, fetched_at, body_blob_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    over.provider ?? 'google',
    over.account_id ?? 'acct-1',
    remoteId,
    revision,
    over.scope_id ?? 's-1',
    over.published_generation ?? 5,
    over.fetched_at ?? 1000,
    over.body_blob_id ?? null,
  );
}

const begin = (
  scanId: string,
  kind: 'incremental' | 'full' = 'incremental',
  now: string = T1,
  scopeId = 's-1',
): Extract<SyncOp, { kind: 'sync.begin' }> => ({
  kind: 'sync.begin',
  scope_id: scopeId,
  scan_id: scanId,
  scan_kind: kind,
  now,
  window_start: WIN_START,
  window_end: WIN_END,
  query_fingerprint: 'fp-1',
});

const publish = (
  scanId: string,
  completedAt: string = DONE,
): Extract<SyncOp, { kind: 'sync.publish' }> => ({
  kind: 'sync.publish',
  scan_id: scanId,
  provider: 'google',
  account_id: 'acct-1',
  provider_cursor: 'cur-2',
  completed_at: completedAt,
});

function itemRow(db: SqliteDatabase, remoteId: string, accountId = 'acct-1') {
  return db
    .prepare(
      `SELECT source_revision, scope_id, published_generation, fetched_at, body_blob_id
       FROM source_items WHERE provider = 'google' AND account_id = ? AND remote_id = ?`,
    )
    .get(accountId, remoteId) as
    | {
        source_revision: string;
        scope_id: string;
        published_generation: number;
        fetched_at: number;
        body_blob_id: string | null;
      }
    | undefined;
}

const stagingCount = (db: SqliteDatabase, scanId: string): number =>
  (
    db
      .prepare('SELECT count(*) AS n FROM sync_staging WHERE scan_id = ?')
      .get(scanId) as { n: number }
  ).n;

const batchStatus = (db: SqliteDatabase, scanId: string): string | undefined =>
  (
    db
      .prepare('SELECT status FROM sync_batches WHERE scan_id = ?')
      .get(scanId) as { status: string } | undefined
  )?.status;

test('begin starts one scan exclusively; further requests are queued and set pending', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      const started = value<SyncBeginValue>(run(db, begin('scan-1')));
      assert.equal(started.outcome, 'started');
      assert.equal(started.scope.active_scan_id, 'scan-1');
      assert.equal(started.scope.scope_revision, '3');
      assert.equal(started.scope.active_generation, '5');
      assert.equal(started.scope.committed_watermark, WM);
      assert.equal(started.scope.pending_incremental, false);
      assert.equal(started.batch?.status, 'fetching');
      assert.equal(started.batch?.kind, 'incremental');
      assert.equal(started.batch?.scan_started_at, T1);
      assert.equal(started.batch?.window_start, WIN_START);
      assert.equal(started.batch?.window_end, WIN_END);
      assert.equal(started.batch?.base_generation, '5');
      assert.equal(started.batch?.base_watermark, WM);
      assert.equal(started.batch?.base_provider_cursor, 'cur-1');
      assert.equal(started.batch?.executor_generation, '2');
      assert.equal(started.batch?.page_cursor, null);
      assert.equal(started.batch?.diff_count, null);
      // 走査の保存期限は開始から 24 時間（domain の sync_batch の規則）。
      const row = db
        .prepare('SELECT delete_at FROM sync_batches WHERE scan_id = ?')
        .get('scan-1') as { delete_at: number };
      assert.equal(row.delete_at, Date.parse(T1) + 86_400_000);

      const queuedFull = value<SyncBeginValue>(
        run(db, begin('scan-2', 'full')),
      );
      assert.equal(queuedFull.outcome, 'queued');
      assert.equal(queuedFull.batch, null);
      assert.equal(queuedFull.scope.active_scan_id, 'scan-1');
      assert.equal(queuedFull.scope.pending_full, true);
      assert.equal(queuedFull.scope.pending_incremental, false);
      assert.equal(batchStatus(db, 'scan-2'), undefined);
      const queuedInc = value<SyncBeginValue>(run(db, begin('scan-3')));
      assert.equal(queuedInc.outcome, 'queued');
      assert.equal(queuedInc.scope.pending_full, true);
      assert.equal(queuedInc.scope.pending_incremental, true);
      assert.deepEqual(
        reasons(run(db, begin('scan-4', 'incremental', T1, 'nope'))),
        ['scope_not_found'],
      );
    } finally {
      db.close();
    }
  });
});

test('begin is held when the clock moved backwards past the watermark, and writes nothing', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db, {
        committed_watermark: Date.parse('2026-01-10T00:00:00.000Z'),
      });
      const held = value<SyncBeginValue>(run(db, begin('scan-1')));
      assert.equal(held.outcome, 'held');
      assert.equal(held.batch, null);
      assert.equal(held.scope.active_scan_id, null);
      assert.equal(batchStatus(db, 'scan-1'), undefined);
    } finally {
      db.close();
    }
  });
});

test('stage_page stores the page cursor, moves to staged and replaces a repeated remote id', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      value(run(db, begin('scan-1')));
      const staged = value<SyncBatchValue>(
        run(db, {
          kind: 'sync.stage_page',
          scan_id: 'scan-1',
          page_no: 0,
          items: [
            { remote_id: 'r-a', source_revision: 'v1', change: 'upsert' },
            { remote_id: 'r-b', source_revision: 'v1', change: 'upsert' },
          ],
          next_page_cursor: 'page-2',
        }),
      );
      assert.equal(staged.batch.status, 'staged');
      assert.equal(staged.batch.page_cursor, 'page-2');
      const again = value<SyncBatchValue>(
        run(db, {
          kind: 'sync.stage_page',
          scan_id: 'scan-1',
          page_no: 1,
          items: [
            { remote_id: 'r-a', source_revision: 'v2', change: 'upsert' },
          ],
          next_page_cursor: null,
        }),
      );
      assert.equal(again.batch.page_cursor, null);
      assert.equal(stagingCount(db, 'scan-1'), 2);
      const row = db
        .prepare(
          'SELECT source_revision, page_no FROM sync_staging WHERE scan_id = ? AND remote_id = ?',
        )
        .get('scan-1', 'r-a') as { source_revision: string; page_no: number };
      assert.deepEqual(row, { source_revision: 'v2', page_no: 1 });
      assert.deepEqual(
        reasons(
          run(db, {
            kind: 'sync.stage_page',
            scan_id: 'missing',
            page_no: 0,
            items: [],
            next_page_cursor: null,
          }),
        ),
        ['scan_not_found'],
      );
    } finally {
      db.close();
    }
  });
});

test('staging into a scan that is no longer current is rejected as stale_scan', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      value(run(db, begin('scan-1')));
      // 別の走査が現在の走査になった（旧走査の遅着ページ）。
      db.prepare(
        "UPDATE sync_scopes SET active_scan_id = 'scan-other' WHERE scope_id = 's-1'",
      ).run();
      assert.deepEqual(
        reasons(
          run(db, {
            kind: 'sync.stage_page',
            scan_id: 'scan-1',
            page_no: 0,
            items: [
              { remote_id: 'r-a', source_revision: 'v1', change: 'upsert' },
            ],
            next_page_cursor: null,
          }),
        ),
        ['stale_scan'],
      );
      assert.equal(stagingCount(db, 'scan-1'), 0);
      assert.equal(batchStatus(db, 'scan-1'), 'fetching');
    } finally {
      db.close();
    }
  });
});

test('validate then publish applies only the diff to source_items (incremental keeps absent rows)', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      // 版が変わる行の本文は公開で NULL に戻ること。
      db.prepare(
        `INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version,
           key_id, nonce, ciphertext, tag, created_at, delete_at)
         VALUES ('blob-1', 'source_body', 'source_items', 'r-change', 0, 1, 'k-test',
           X'000102030405060708090a0b', X'00', X'000102030405060708090a0b0c0d0e0f', 1000, NULL)`,
      ).run();
      seedItem(db, 'r-same', 'v1');
      seedItem(db, 'r-change', 'v1', { body_blob_id: 'blob-1' });
      seedItem(db, 'r-delete', 'v1');
      seedItem(db, 'r-absent', 'v1');
      value(run(db, begin('scan-1')));
      value(
        run(db, {
          kind: 'sync.stage_page',
          scan_id: 'scan-1',
          page_no: 0,
          items: [
            { remote_id: 'r-new', source_revision: 'v1', change: 'upsert' },
            { remote_id: 'r-change', source_revision: 'v2', change: 'upsert' },
            { remote_id: 'r-same', source_revision: 'v1', change: 'upsert' },
            { remote_id: 'r-delete', source_revision: 'v1', change: 'delete' },
            { remote_id: 'r-gone', source_revision: 'v1', change: 'delete' },
          ],
          next_page_cursor: null,
        }),
      );
      // validated でなければ公開しない。
      assert.deepEqual(reasons(run(db, publish('scan-1'))), ['not_validated']);
      const validated = value<SyncBatchValue>(
        run(db, { kind: 'sync.validate', scan_id: 'scan-1' }),
      );
      assert.equal(validated.batch.status, 'validated');
      const done = value<SyncPublishValue>(run(db, publish('scan-1')));
      // 差分は新規・版変更・削除の 3 件。同版と、公開済みに無い削除は数えない。
      assert.equal(done.diff_count, 3);
      assert.equal(done.batch.status, 'published');
      assert.equal(done.batch.diff_count, 3);
      assert.equal(done.scope.active_scan_id, null);
      assert.equal(done.scope.active_generation, '6');
      assert.equal(done.scope.committed_watermark, T1);
      assert.equal(done.scope.provider_cursor, 'cur-2');
      assert.equal(done.scope.last_incremental_completed_at, DONE);
      assert.equal(done.scope.last_full_reconciled_at, null);
      assert.deepEqual(itemRow(db, 'r-new'), {
        source_revision: 'v1',
        scope_id: 's-1',
        published_generation: 6,
        fetched_at: Date.parse(DONE),
        body_blob_id: null,
      });
      assert.deepEqual(itemRow(db, 'r-change'), {
        source_revision: 'v2',
        scope_id: 's-1',
        published_generation: 6,
        fetched_at: Date.parse(DONE),
        body_blob_id: null,
      });
      // 同版の行は世代も取得時刻もそのまま。
      assert.deepEqual(itemRow(db, 'r-same'), {
        source_revision: 'v1',
        scope_id: 's-1',
        published_generation: 5,
        fetched_at: 1000,
        body_blob_id: null,
      });
      assert.equal(itemRow(db, 'r-delete'), undefined);
      // 増分では staging に無い公開済み行を消さない。
      assert.deepEqual(itemRow(db, 'r-absent'), {
        source_revision: 'v1',
        scope_id: 's-1',
        published_generation: 5,
        fetched_at: 1000,
        body_blob_id: null,
      });
      assert.equal(stagingCount(db, 'scan-1'), 0);
    } finally {
      db.close();
    }
  });
});

test('a full publish deletes published rows that are absent from staging', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      seedItem(db, 'r-same', 'v1');
      seedItem(db, 'r-absent', 'v1');
      value(run(db, begin('scan-1', 'full')));
      value(
        run(db, {
          kind: 'sync.stage_page',
          scan_id: 'scan-1',
          page_no: 0,
          items: [
            { remote_id: 'r-same', source_revision: 'v1', change: 'upsert' },
          ],
          next_page_cursor: null,
        }),
      );
      value(run(db, { kind: 'sync.validate', scan_id: 'scan-1' }));
      const done = value<SyncPublishValue>(run(db, publish('scan-1')));
      assert.equal(done.diff_count, 1);
      assert.equal(done.scope.active_generation, '6');
      assert.equal(done.scope.last_full_reconciled_at, DONE);
      assert.equal(done.scope.last_incremental_completed_at, null);
      assert.equal(itemRow(db, 'r-absent'), undefined);
      assert.equal(itemRow(db, 'r-same')?.published_generation, 5);
    } finally {
      db.close();
    }
  });
});

test('a publish with no diff does not advance the generation, only the watermark and completion time', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      seedItem(db, 'r-same', 'v1');
      value(run(db, begin('scan-1')));
      value(
        run(db, {
          kind: 'sync.stage_page',
          scan_id: 'scan-1',
          page_no: 0,
          items: [
            { remote_id: 'r-same', source_revision: 'v1', change: 'upsert' },
          ],
          next_page_cursor: null,
        }),
      );
      value(run(db, { kind: 'sync.validate', scan_id: 'scan-1' }));
      const done = value<SyncPublishValue>(run(db, publish('scan-1')));
      assert.equal(done.diff_count, 0);
      assert.equal(done.batch.diff_count, 0);
      assert.equal(done.scope.active_generation, '5');
      assert.equal(done.scope.committed_watermark, T1);
      assert.equal(done.scope.provider_cursor, 'cur-2');
      assert.equal(done.scope.last_incremental_completed_at, DONE);
      assert.equal(itemRow(db, 'r-same')?.published_generation, 5);
      assert.equal(itemRow(db, 'r-same')?.fetched_at, 1000);
    } finally {
      db.close();
    }
  });
});

test('a publish after the scope changed is rejected and the batch is abandoned', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      seedItem(db, 'r-same', 'v1');
      value(run(db, begin('scan-1')));
      value(
        run(db, {
          kind: 'sync.stage_page',
          scan_id: 'scan-1',
          page_no: 0,
          items: [
            { remote_id: 'r-new', source_revision: 'v1', change: 'upsert' },
          ],
          next_page_cursor: null,
        }),
      );
      value(run(db, { kind: 'sync.validate', scan_id: 'scan-1' }));
      // 取得範囲の変更（保存済みの版が進んだ）。
      db.prepare(
        'UPDATE sync_scopes SET scope_revision = 4 WHERE scope_id = ?',
      ).run('s-1');
      assert.deepEqual(reasons(run(db, publish('scan-1'))), ['scope_changed']);
      assert.equal(batchStatus(db, 'scan-1'), 'abandoned');
      const snap = value<SyncScopeSnapshot>(
        run(db, { kind: 'sync.get_scope', scope_id: 's-1' }),
      );
      assert.equal(snap.scope.active_scan_id, null);
      assert.equal(snap.scope.active_generation, '5');
      assert.equal(stagingCount(db, 'scan-1'), 0);
      assert.equal(itemRow(db, 'r-new'), undefined);
    } finally {
      db.close();
    }
  });
});

test('abandon releases the active scan and raises pending for its kind', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      value(run(db, begin('scan-1')));
      value(
        run(db, {
          kind: 'sync.stage_page',
          scan_id: 'scan-1',
          page_no: 0,
          items: [
            { remote_id: 'r-a', source_revision: 'v1', change: 'upsert' },
          ],
          next_page_cursor: null,
        }),
      );
      const done = value<SyncBatchValue>(
        run(db, { kind: 'sync.abandon', scan_id: 'scan-1' }),
      );
      assert.equal(done.batch.status, 'abandoned');
      assert.equal(done.scope.active_scan_id, null);
      assert.equal(done.scope.pending_incremental, true);
      assert.equal(done.scope.pending_full, false);
      assert.equal(stagingCount(db, 'scan-1'), 0);
      assert.deepEqual(
        reasons(run(db, { kind: 'sync.abandon', scan_id: 'scan-1' })),
        ['batch_not_active'],
      );
      // 解放されたので次の走査を始められる。
      assert.equal(
        value<SyncBeginValue>(run(db, begin('scan-2', 'incremental', T2)))
          .outcome,
        'started',
      );
    } finally {
      db.close();
    }
  });
});

test('get_scope reports last_attempt_at as the latest scan start, and list_scopes is ordered', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      seedScope(db, { scope_id: 's-0' });
      const empty = value<SyncScopeSnapshot>(
        run(db, { kind: 'sync.get_scope', scope_id: 's-1' }),
      );
      assert.equal(empty.last_attempt_at, null);
      assert.equal(empty.active_batch, null);
      value(run(db, begin('scan-1')));
      value(run(db, { kind: 'sync.abandon', scan_id: 'scan-1' }));
      value(run(db, begin('scan-2', 'incremental', T2)));
      const snap = value<SyncScopeSnapshot>(
        run(db, { kind: 'sync.get_scope', scope_id: 's-1' }),
      );
      assert.equal(snap.last_attempt_at, T2);
      assert.equal(snap.active_batch?.scan_id, 'scan-2');
      assert.equal(
        value(run(db, { kind: 'sync.get_scope', scope_id: 'nope' })),
        null,
      );
      const list = value<SyncScopeSnapshot[]>(
        run(db, { kind: 'sync.list_scopes', connection_id: 'c-1' }),
      );
      assert.deepEqual(
        list.map((entry) => entry.scope.scope_id),
        ['s-0', 's-1'],
      );
    } finally {
      db.close();
    }
  });
});

test('list_published returns only the rows of that provider, account and scope, ordered by remote_id', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      seedScope(db, { scope_id: 's-2' });
      seedItem(db, 'r-b', 'v2');
      seedItem(db, 'r-a', 'v1');
      seedItem(db, 'r-other-scope', 'v1', { scope_id: 's-2' });
      seedItem(db, 'r-other-account', 'v1', { account_id: 'acct-2' });
      seedItem(db, 'r-other-provider', 'v1', { provider: 'microsoft' });
      // staging の行は公開済みではないので返らない。
      value(run(db, begin('scan-1')));
      value(
        run(db, {
          kind: 'sync.stage_page',
          scan_id: 'scan-1',
          page_no: 0,
          items: [
            { remote_id: 'r-staged', source_revision: 'v9', change: 'upsert' },
          ],
          next_page_cursor: null,
        }),
      );
      const rows = value<readonly SyncPublishedItem[]>(
        run(db, {
          kind: 'sync.list_published',
          scope_id: 's-1',
          provider: 'google',
          account_id: 'acct-1',
        }),
      );
      assert.deepEqual(rows, [
        { remote_id: 'r-a', source_revision: 'v1' },
        { remote_id: 'r-b', source_revision: 'v2' },
      ]);
    } finally {
      db.close();
    }
  });
});

test('a halted worker still reads but does not write, and bad shapes are rejected', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      assert.deepEqual(reasons(run(db, begin('scan-1'), true)), [
        'worker_halted',
      ]);
      assert.equal(batchStatus(db, 'scan-1'), undefined);
      assert.equal(
        value<SyncScopeSnapshot | null>(
          run(db, { kind: 'sync.get_scope', scope_id: 's-1' }, true),
        )?.scope.scope_id,
        's-1',
      );
      assert.deepEqual(
        reasons(
          run(db, {
            ...begin('scan-1'),
            window_end: WIN_START,
          } as SyncOp),
        ),
        ['window_invalid'],
      );
      assert.deepEqual(
        reasons(
          run(db, { ...begin('scan-1'), query_fingerprint: '' } as SyncOp),
        ),
        ['query_fingerprint_invalid'],
      );
      assert.equal(batchStatus(db, 'scan-1'), undefined);
    } finally {
      db.close();
    }
  });
});

test(
  'the DB worker serves the begin, stage, validate and publish round trip',
  { timeout: 30_000 },
  async () => {
    await withTempDir(async (dir) => {
      const path = databasePath(dir);
      const seed = openSeededDatabase(path);
      seedScope(seed);
      seedItem(seed, 'r-same', 'v1');
      seed.close();
      const client = await DbWorkerClient.start({
        path,
        storeGeneration: STORE_GENERATION,
        responseTimeoutMs: 10_000,
      });
      try {
        const started = await client.sync(begin('scan-1'));
        assert(started.ok);
        assert.equal(started.value.outcome, 'started');
        const staged = await client.sync({
          kind: 'sync.stage_page',
          scan_id: 'scan-1',
          page_no: 0,
          items: [
            { remote_id: 'r-same', source_revision: 'v1', change: 'upsert' },
            { remote_id: 'r-new', source_revision: 'v1', change: 'upsert' },
          ],
          next_page_cursor: null,
        });
        assert(staged.ok);
        assert.equal(staged.value.batch.status, 'staged');
        const validated = await client.sync({
          kind: 'sync.validate',
          scan_id: 'scan-1',
        });
        assert(validated.ok);
        const done = await client.sync(publish('scan-1'));
        assert(done.ok);
        assert.equal(done.value.diff_count, 1);
        assert.equal(done.value.scope.active_generation, '6');
        const publishedRows = await client.sync({
          kind: 'sync.list_published',
          scope_id: 's-1',
          provider: 'google',
          account_id: 'acct-1',
        });
        assert(publishedRows.ok);
        assert.deepEqual(publishedRows.value, [
          { remote_id: 'r-new', source_revision: 'v1' },
          { remote_id: 'r-same', source_revision: 'v1' },
        ]);
        const snap = await client.sync({
          kind: 'sync.get_scope',
          scope_id: 's-1',
        });
        assert(snap.ok);
        assert.equal(snap.value?.last_attempt_at, T1);
        assert.equal(snap.value?.active_batch, null);
      } finally {
        await client.close();
      }
    });
  },
);

test('recover with no active scan only advances the executor generation', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      const snap = value<SyncScopeSnapshot>(
        run(db, { kind: 'sync.recover', scope_id: 's-1' }),
      );
      assert.equal(snap.scope.executor_generation, '3');
      assert.equal(snap.scope.active_scan_id, null);
      assert.equal(snap.scope.active_generation, '5');
      assert.equal(snap.scope.committed_watermark, WM);
      assert.equal(snap.scope.provider_cursor, 'cur-1');
      assert.equal(snap.scope.pending_incremental, false);
      assert.equal(snap.scope.pending_full, false);
      assert.equal(snap.active_batch, null);
      // もう一度回復すると、さらに 1 つ進む。
      const again = value<SyncScopeSnapshot>(
        run(db, { kind: 'sync.recover', scope_id: 's-1' }),
      );
      assert.equal(again.scope.executor_generation, '4');
      assert.deepEqual(
        reasons(run(db, { kind: 'sync.recover', scope_id: 'nope' })),
        ['scope_not_found'],
      );
    } finally {
      db.close();
    }
  });
});

test('recover abandons the scan left by the old executor and rejects its late pages', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      value<SyncBeginValue>(run(db, begin('scan-1')));
      const staged = run(db, {
        kind: 'sync.stage_page',
        scan_id: 'scan-1',
        page_no: 0,
        items: [{ remote_id: 'r-1', source_revision: 'v1', change: 'upsert' }],
        next_page_cursor: 'tok-1',
      });
      assert.equal(staged.ok, true);
      assert.equal(stagingCount(db, 'scan-1'), 1);

      const snap = value<SyncScopeSnapshot>(
        run(db, { kind: 'sync.recover', scope_id: 's-1' }),
      );
      assert.equal(snap.scope.executor_generation, '3');
      assert.equal(snap.scope.active_scan_id, null);
      assert.equal(snap.scope.pending_incremental, true);
      assert.equal(snap.scope.pending_full, false);
      assert.equal(snap.active_batch, null);
      assert.equal(batchStatus(db, 'scan-1'), 'abandoned');
      assert.equal(stagingCount(db, 'scan-1'), 0);

      // 旧担当の遅着は保存も公開もしない（有効な走査でない・担当世代が違う）。
      assert.deepEqual(
        reasons(
          run(db, {
            kind: 'sync.stage_page',
            scan_id: 'scan-1',
            page_no: 1,
            items: [],
            next_page_cursor: null,
          }),
        ),
        ['batch_not_active'],
      );
      const publishReasons = reasons(run(db, publish('scan-1')));
      assert.ok(publishReasons.includes('executor_changed'));
      assert.ok(publishReasons.includes('stale_scan'));

      // 回復の後は、新しい担当世代で新しい走査を始められる。
      const restarted = value<SyncBeginValue>(
        run(db, begin('scan-2', 'incremental', T2)),
      );
      assert.equal(restarted.outcome, 'started');
      assert.equal(restarted.batch?.executor_generation, '3');
    } finally {
      db.close();
    }
  });
});

test('recover of a full scan re-queues a full reconciliation', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      value<SyncBeginValue>(run(db, begin('scan-1', 'full')));
      const snap = value<SyncScopeSnapshot>(
        run(db, { kind: 'sync.recover', scope_id: 's-1' }),
      );
      assert.equal(snap.scope.pending_full, true);
      assert.equal(snap.scope.pending_incremental, false);
      assert.equal(batchStatus(db, 'scan-1'), 'abandoned');
    } finally {
      db.close();
    }
  });
});

test('recover writes nothing when the worker is halted', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedScope(db);
      value<SyncBeginValue>(run(db, begin('scan-1')));
      assert.deepEqual(
        reasons(run(db, { kind: 'sync.recover', scope_id: 's-1' }, true)),
        ['worker_halted'],
      );
      const snap = value<SyncScopeSnapshot>(
        run(db, { kind: 'sync.get_scope', scope_id: 's-1' }),
      );
      assert.equal(snap.scope.executor_generation, '2');
      assert.equal(snap.scope.active_scan_id, 'scan-1');
      assert.equal(batchStatus(db, 'scan-1'), 'fetching');
    } finally {
      db.close();
    }
  });
});
