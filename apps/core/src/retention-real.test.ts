// B06-07a-1: 実 SQLite（DB worker）と実ファイルを通した、期限処理の完成の統合の試験（模擬。実機・実 API は使わない）。
// 期限は手で数えた UTC の Unix ミリ秒（B = 2031-01-01T00:00:00Z = 1_924_992_000_000）。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { SqliteDatabase } from '@buddy/storage';
import { RecordingNoticeSink } from './notice-sink.js';
import { createClockStateFile, parseClockState } from './clock-state.js';
import {
  RetentionSweeper,
  createRetentionSweepPort,
} from './retention-sweeper.js';
import { CLOCK_STATE_FILE } from './paths.js';
import { ManualClock, withBudgetStore } from './budget-test-support.js';

const B = 1_924_992_000_000;
const DAY = 86_400_000;
const S = 'a1000000-0000-4000-8000-000000000001';
const T_DUE = 'b1000000-0000-4000-8000-000000000001';
const T_LIVE = 'b1000000-0000-4000-8000-000000000002';
const M_REVIEW = 'c1000000-0000-4000-8000-000000000001';
const M_DUE = 'c1000000-0000-4000-8000-000000000002';
const M_ACTIVE = 'c1000000-0000-4000-8000-000000000003';
const E1 = 'e1111111-1111-4111-8111-111111111111';
const E2 = 'e2222222-2222-4222-8222-222222222222';
const R1 = 'f1111111-1111-4111-8111-111111111111';

function blob(db: SqliteDatabase, purpose: string, table: string, id: string) {
  const blobId = randomUUID();
  db.prepare(
    'INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?, 1000, NULL)',
  ).run(
    blobId,
    purpose,
    table,
    id,
    'k-test',
    randomBytes(12),
    randomBytes(24),
    randomBytes(16),
  );
  return blobId;
}

function seed(db: SqliteDatabase): void {
  db.prepare(
    "INSERT INTO devices (device_id, device_name, platform, hub_local, token_hash, registered_at) VALUES ('dev-1', 'd', 'macos', 0, X'0000000000000000000000000000000000000000000000000000000000000000', 1000)",
  ).run();
  db.prepare(
    "INSERT INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES (?, 'normal', 'dev-1', 0, NULL, ?, NULL)",
  ).run(S, B);
  // 発言: 期限ちょうど（B + 7 日）と、期限の 1 日前。
  for (const [id, createdAt] of [
    [T_DUE, B],
    [T_LIVE, B + 2 * DAY],
  ] as const)
    db.prepare(
      "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, ?, 'user', 'text', ?, ?, ?)",
    ).run(
      id,
      S,
      blob(db, 'turn_text', 'turns', id),
      createdAt,
      createdAt + 7 * DAY,
    );
  // 元情報: 取得から 24 時間ちょうどと、1 ミリ秒前。
  db.prepare(
    "INSERT INTO connections VALUES ('c-1', 'google', NULL, 'keystore:c-1', 'active', 'read_write', '[]', '{}', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_generation, executor_generation) VALUES ('sc-1', 'c-1', 0, 0, 0)",
  ).run();
  for (const [remote, fetchedAt] of [
    ['msg-due', B + 7 * DAY],
    ['msg-live', B + 7 * DAY + 1],
  ] as const)
    db.prepare(
      "INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id, published_generation, fetched_at, body_blob_id) VALUES ('google', 'acct', ?, 'rev', 'sc-1', 0, ?, ?)",
    ).run(remote, fetchedAt, blob(db, 'source_body', 'source_items', remote));
  // 記憶: 見直し日だけ過ぎた有効な記憶・見直し待ちの 30 日がちょうど来た記憶・まだ先の記憶。
  const memory = (
    id: string,
    status: string,
    createdAt: number,
    reviewAt: number,
    deleteAt: number | null,
    n: number,
  ) =>
    db
      .prepare(
        "INSERT INTO memories (memory_id, origin, kind, text_blob_id, target_key_blob_id, target_key_hash, dedupe_key, status, created_at, review_at, delete_at) VALUES (?, 'explicit_request', 'preference', ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        blob(db, 'memory_text', 'memories', id),
        blob(db, 'memory_target_key', 'memories', id),
        `${String(n).repeat(64)}`,
        `${String(n + 3).repeat(64)}`,
        status,
        createdAt,
        reviewAt,
        deleteAt,
      );
  memory(M_REVIEW, 'active', B - 90 * DAY, B + 7 * DAY, null, 1);
  memory(M_DUE, 'review_pending', B - 100 * DAY, B - 22 * DAY, B + 8 * DAY, 2);
  memory(M_ACTIVE, 'active', B, B + 90 * DAY, null, 3);
  // 派生物: 発言 T_DUE（B + 7 日に切れる）から作った気づき。由来が切れた日に消える。
  const title = blob(db, 'candidate_title', 'notification_candidates', 'n-1');
  db.prepare(
    "INSERT INTO notification_candidates (candidate_id, request_entity_id, request_revision, source_revision, kind, notification_key, title_blob_id, excerpt_blob_id, state, closed_at, key_delete_at) VALUES ('n-1', NULL, NULL, NULL, 'mail_reply', 'nk-1', ?, NULL, 'new', NULL, NULL)",
  ).run(title);
  db.prepare(
    "INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES ('notification_candidate', 'n-1', 'turn', ?, 1000)",
  ).run(T_DUE);
}

const count = (db: SqliteDatabase, sql: string, ...args: unknown[]): number =>
  db
    .prepare(sql)
    .pluck()
    .get(...args) as number;

test('real store: one ms before the deadlines nothing is deleted and no notice is sent', async () => {
  await withBudgetStore(async (harness) => {
    harness.sql(seed);
    // 発言 T_DUE の期限（B + 7 日）の 1 ミリ秒前は何も消えない。
    const clock = new ManualClock(B + 7 * DAY - 1);
    const sink = new RecordingNoticeSink();
    const job = new RetentionSweeper({
      port: createRetentionSweepPort(harness.store),
      epoch: E1,
      now: clock.now,
      notices: sink,
      newNoticeId: () => R1,
    });
    const before = await job.runOnce(true);
    await job.drain();
    assert.equal(before.status, 'completed');
    assert.deepEqual(
      harness.sql((db) => [
        count(db, 'SELECT count(*) FROM turns'),
        count(db, 'SELECT count(*) FROM source_items'),
        count(db, 'SELECT count(*) FROM memories'),
        count(db, 'SELECT count(*) FROM notification_candidates'),
        count(db, "SELECT count(*) FROM memories WHERE status = 'active'"),
      ]),
      // 発言 T_DUE の期限・見直し日（B + 7 日）に 1 ミリ秒届かないので、何も動かない（元情報は取得から 24 時間前）。
      [2, 2, 3, 1, 2],
    );
    assert.equal(sink.notices.length, 0);
  });
});

test('real store: at B + 8 days the sweep removes what is due, starts the review, keeps the rest, and the second sweep changes nothing', async () => {
  await withBudgetStore(async (harness) => {
    harness.sql(seed);
    const clock = new ManualClock(B + 8 * DAY);
    const sink = new RecordingNoticeSink();
    const job = new RetentionSweeper({
      port: createRetentionSweepPort(harness.store),
      epoch: E1,
      now: clock.now,
      notices: sink,
      newNoticeId: () => R1,
      vacuumIntervalMs: 0,
    });
    const record = await job.runOnce(true);
    await job.drain();
    assert.equal(record.status, 'completed');
    assert.equal(record.failed_actions, 0);
    const state = harness.sql((db) => ({
      turns: db
        .prepare('SELECT turn_id FROM turns ORDER BY turn_id')
        .pluck()
        .all(),
      turnBlobs: count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'turns'",
      ),
      sources: db
        .prepare('SELECT remote_id FROM source_items ORDER BY remote_id')
        .pluck()
        .all(),
      sourceBlobs: count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'source_items'",
      ),
      memories: db
        .prepare(
          'SELECT memory_id, status, delete_at FROM memories ORDER BY memory_id',
        )
        .all(),
      candidates: count(db, 'SELECT count(*) FROM notification_candidates'),
      candidateBlobs: count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'notification_candidates'",
      ),
      edges: count(db, 'SELECT count(*) FROM derivations'),
      ledger: count(db, 'SELECT count(*) FROM forget_ledger'),
      fk: (db.pragma('foreign_key_check') as unknown[]).length,
    }));
    assert.deepEqual(state, {
      turns: [T_LIVE],
      turnBlobs: 1,
      // msg-due（24 時間ちょうど）は消え、msg-live（1 ミリ秒後）は残る。
      sources: ['msg-live'],
      sourceBlobs: 1,
      memories: [
        // 見直し日（B + 7 日）を過ぎた有効な記憶は見直し待ちへ。削除は見直し日の 30 日後。
        {
          memory_id: M_REVIEW,
          status: 'review_pending',
          delete_at: B + 37 * DAY,
        },
        // M_DUE は見直し待ちの 30 日がちょうど来て消えた。M_ACTIVE はまだ先。
        { memory_id: M_ACTIVE, status: 'active', delete_at: null },
      ],
      candidates: 0,
      candidateBlobs: 0,
      edges: 0,
      // 期限切れは忘却ではない。台帳に書かず、再登録も禁じない。
      ledger: 0,
      fk: 0,
    });
    // 知らせ: 期限の来た発言と元情報（元サービスの ID）が 1 つ、見直し待ちを過ぎた記憶が 1 つ。
    assert.deepEqual(
      sink.notices.map((notice) => [notice.reason, notice.items]),
      [
        [
          'retention_due',
          [
            { item_kind: 'turn', item_id: T_DUE },
            { item_kind: 'source_item', item_id: 'msg-due' },
          ],
        ],
        ['review_unanswered', [{ item_kind: 'memory', item_id: M_DUE }]],
      ],
    );
    // 同じ時刻の 2 回目の掃除は何も消さず、知らせも出さない（再実行で二重に消さない）。
    await job.runOnce(true);
    await job.drain();
    assert.equal(sink.notices.length, 2);
    assert.equal(
      harness.sql((db) => count(db, 'SELECT count(*) FROM turns')),
      1,
    );
  });
});

test('real store and file: a restart with the clock behind the file keeps the file time, a recheck by the person reopens the gate, and the file keeps a record', async () => {
  await withBudgetStore(async (harness) => {
    harness.sql(seed);
    const file = createClockStateFile(harness.dir);
    const clock = new ManualClock(B + 8 * DAY);
    const first = new RetentionSweeper({
      port: createRetentionSweepPort(harness.store),
      epoch: E1,
      now: clock.now,
      clock: file,
      freshClockState: true,
    });
    await first.runOnce(true);
    await first.drain();
    first.close();
    assert.deepEqual(first.gate().reasons, []);
    const written = parseClockState(
      await readFile(join(harness.dir, CLOCK_STATE_FILE), 'utf8'),
    );
    assert.equal(written?.last_checked_at, '2031-01-09T00:00:00Z');
    assert.equal(written?.epoch, E1);

    // 再起動したが、時計が 2 日戻っている（再起動の直後でも巻き戻りを判定できる）。
    clock.set(B + 6 * DAY);
    const second = new RetentionSweeper({
      port: createRetentionSweepPort(harness.store),
      epoch: E2,
      now: clock.now,
      clock: createClockStateFile(harness.dir),
    });
    await second.runOnce(true);
    await second.drain();
    assert.deepEqual(second.gate().reasons, ['clock_regression']);
    // 本人が見た値で採り直す。
    const view = await second.clockStatus();
    assert.equal(view.needs_recheck, true);
    const result = await second.recheckClock({
      request_id: R1,
      revision: view.revision,
      observed_last_checked_at: view.last_checked_at,
      observed_now: view.now,
    });
    assert.equal(result.ok, true);
    await second.drain();
    assert.deepEqual(second.gate().reasons, []);
    const after = parseClockState(
      await readFile(join(harness.dir, CLOCK_STATE_FILE), 'utf8'),
    );
    assert.equal(after?.last_checked_at, '2031-01-07T00:00:00Z');
    assert.equal(after?.rechecks.length, 1);
    assert.equal(
      after?.rechecks[0]?.from_last_checked_at,
      '2031-01-09T00:00:00Z',
    );
    second.close();
  });
});

test('real file: a deleted or damaged file on an existing store stops auto use until the person re-takes it', async () => {
  await withBudgetStore(async (harness) => {
    const path = join(harness.dir, CLOCK_STATE_FILE);
    const clock = new ManualClock(B + 8 * DAY);
    const first = new RetentionSweeper({
      port: createRetentionSweepPort(harness.store),
      epoch: E1,
      now: clock.now,
      clock: createClockStateFile(harness.dir),
      freshClockState: true,
    });
    await first.runOnce(true);
    await first.drain();
    first.close();
    await rm(path);
    const missing = new RetentionSweeper({
      port: createRetentionSweepPort(harness.store),
      epoch: E2,
      now: clock.now,
      clock: createClockStateFile(harness.dir),
    });
    await missing.runOnce(true);
    await missing.drain();
    assert.deepEqual(missing.gate().reasons, ['clock_state_missing']);
    missing.close();
    await writeFile(path, '{"schema":"x"}');
    const invalid = new RetentionSweeper({
      port: createRetentionSweepPort(harness.store),
      epoch: E2,
      now: clock.now,
      clock: createClockStateFile(harness.dir),
    });
    await invalid.runOnce(true);
    await invalid.drain();
    assert.deepEqual(invalid.gate().reasons, ['clock_state_invalid']);
    // 壊れたファイルは黙って作り直されない。
    assert.equal(await readFile(path, 'utf8'), '{"schema":"x"}');
    invalid.close();
  });
});
