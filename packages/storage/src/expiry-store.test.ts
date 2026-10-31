// 発言・元情報・派生物の期限削除（ADR 0058、B06-07a-1）。
// 期限は手で数えた UTC の Unix ミリ秒で書く（B = 2031-01-01T00:00:00Z = 1_924_992_000_000。domain の関数で求めない）。
// 1 ms 前は残し、ちょうどで消え、系譜の辺は生きた下流がなくなるまで残る。期限切れは忘却ではないので台帳に書かない。

import assert from 'node:assert/strict';
import test from 'node:test';
import { executeRetentionOp } from './index.js';
import type { RetentionOp, RetentionOpValue, SqliteDatabase } from './index.js';
import { blob, count, edge, insertMemory } from './forget-test-support.js';
import {
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

const B = 1_924_992_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const S1 = 'a1000000-0000-4000-8000-000000000001';
const T_N = 'b1000000-0000-4000-8000-000000000001';
const T_X = 'b1000000-0000-4000-8000-000000000002';
const T_LONG = 'b1000000-0000-4000-8000-000000000003';
const M_LIVE = 'c1000000-0000-4000-8000-000000000001';

function run(
  db: SqliteDatabase,
  op: RetentionOp,
  beforeCommit?: () => void,
): {
  ok: boolean;
  value?: RetentionOpValue;
  reasons?: readonly string[];
  halt: boolean;
} {
  const out = executeRetentionOp(db, op, {
    platform: 'macos',
    halted: false,
    ...(beforeCommit === undefined ? {} : { beforeCommit }),
  });
  return out.result.ok
    ? { ok: true, value: out.result.value, halt: out.halt }
    : { ok: false, reasons: out.result.reasons, halt: out.halt };
}

function deleteExpired(
  db: SqliteDatabase,
  family: 'turn' | 'source_item' | 'derived',
  ids: string[],
  now: number,
): { deleted: string[]; skipped: { id: string; reasons: string[] }[] } {
  const result = run(db, {
    kind: 'retention.delete_expired',
    family,
    ids,
    now,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value as never;
}

function insertTurn(
  db: SqliteDatabase,
  turnId: string,
  createdAt: number,
  expiresAt: number,
): void {
  const text = blob(db, 'turn_text', 'turns', turnId);
  db.prepare(
    "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, ?, 'user', 'text', ?, ?, ?)",
  ).run(turnId, S1, text, createdAt, expiresAt);
}

function insertSourceItem(
  db: SqliteDatabase,
  accountId: string,
  remoteId: string,
  fetchedAt: number,
  withBody = true,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO sync_scopes (scope_id, connection_id, scope_revision, active_generation, executor_generation) VALUES ('sc-1', 'c-1', 0, 0, 0)",
  ).run();
  const body = withBody
    ? blob(db, 'source_body', 'source_items', `${accountId}/${remoteId}`)
    : null;
  db.prepare(
    "INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id, published_generation, fetched_at, body_blob_id) VALUES ('google', ?, ?, 'rev-1', 'sc-1', 0, ?, ?)",
  ).run(accountId, remoteId, fetchedAt, body);
}

function insertCandidate(db: SqliteDatabase, id: string): void {
  const title = blob(db, 'candidate_title', 'notification_candidates', id);
  db.prepare(
    "INSERT INTO notification_candidates (candidate_id, request_entity_id, request_revision, source_revision, kind, notification_key, title_blob_id, excerpt_blob_id, state, closed_at, key_delete_at) VALUES (?, NULL, NULL, NULL, 'mail_reply', ?, ?, NULL, 'new', NULL, NULL)",
  ).run(id, `nk-${id}`, title);
}

async function withDb(
  body: (db: SqliteDatabase) => Promise<void> | void,
): Promise<void> {
  await withTempDir(async (dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      db.prepare(
        "INSERT INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES (?, 'normal', 'dev-1', 0, NULL, ?, NULL)",
      ).run(S1, B);
      await body(db);
    } finally {
      db.close();
    }
  });
}

test('turns: a normal turn stays one ms before 7 days and is deleted exactly at 7 days with its response and links', async () => {
  await withDb((db) => {
    insertTurn(db, T_N, B, B + 7 * DAY);
    db.prepare(
      "INSERT INTO turn_responses (turn_id, response_json, created_at, delete_at) VALUES (?, '{}', ?, ?)",
    ).run(T_N, B, B + 7 * DAY);
    db.prepare(
      "INSERT INTO input_snapshots (input_id, request_revision, workflow_id, turn_id, origin, state, seal_reason, input_evidence, policy_version, permission_revision, forgetting_generation, audio_epoch) VALUES ('in-n', 1, NULL, ?, 'typed', 'sealed', 'submitted_text', 'submitted_text', NULL, 0, 0, NULL)",
    ).run(T_N);
    const before = deleteExpired(db, 'turn', [T_N], B + 7 * DAY - 1);
    assert.deepEqual(before, {
      deleted: [],
      skipped: [{ id: T_N, reasons: ['not_due'] }],
    });
    assert.equal(count(db, 'SELECT count(*) FROM turns'), 1);
    const at = deleteExpired(db, 'turn', [T_N], B + 7 * DAY);
    assert.deepEqual(at, { deleted: [T_N], skipped: [] });
    assert.equal(count(db, 'SELECT count(*) FROM turns'), 0);
    assert.equal(count(db, 'SELECT count(*) FROM turn_responses'), 0);
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'turns' AND owner_id = ?",
        T_N,
      ),
      0,
    );
    // 入力の版は残り、発言への結び付けだけが外れる。
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM input_snapshots WHERE input_id = 'in-n' AND turn_id IS NULL",
      ),
      1,
    );
    // 期限切れは忘却ではない。台帳に書かない。
    assert.equal(count(db, 'SELECT count(*) FROM forget_ledger'), 0);
    assert.equal((db.pragma('foreign_key_check') as unknown[]).length, 0);
  });
});

test('turns: an extended turn (30 days) stays at 7 days and is deleted exactly at 30 days; a longer stored deadline is clamped to 7 days', async () => {
  await withDb((db) => {
    insertTurn(db, T_X, B, B + 30 * DAY);
    insertTurn(db, T_LONG, B, B + 40 * DAY);
    assert.deepEqual(deleteExpired(db, 'turn', [T_X, T_LONG], B + 7 * DAY), {
      deleted: [T_LONG],
      skipped: [{ id: T_X, reasons: ['not_due'] }],
    });
    assert.deepEqual(
      deleteExpired(db, 'turn', [T_X], B + 30 * DAY - 1).deleted,
      [],
    );
    assert.deepEqual(deleteExpired(db, 'turn', [T_X], B + 30 * DAY).deleted, [
      T_X,
    ]);
  });
});

test('turns: an unknown id is row_not_found and a failed transaction leaves the row (nothing half deleted)', async () => {
  await withDb((db) => {
    insertTurn(db, T_N, B, B + 7 * DAY);
    assert.deepEqual(
      deleteExpired(
        db,
        'turn',
        ['b1000000-0000-4000-8000-0000000000ff'],
        B + 8 * DAY,
      ),
      {
        deleted: [],
        skipped: [
          {
            id: 'b1000000-0000-4000-8000-0000000000ff',
            reasons: ['row_not_found'],
          },
        ],
      },
    );
    const failed = run(
      db,
      {
        kind: 'retention.delete_expired',
        family: 'turn',
        ids: [T_N],
        now: B + 8 * DAY,
      },
      () => {
        throw new Error('injected');
      },
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.halt, true);
    assert.equal(count(db, 'SELECT count(*) FROM turns'), 1);
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'turns'",
      ),
      1,
    );
  });
});

test('source items: the body is deleted exactly at 24 hours, only the due account row goes, and the plan row id carries the original id for notices', async () => {
  await withDb((db) => {
    insertSourceItem(db, 'acct-a', 'msg-1', B);
    insertSourceItem(db, 'acct-b', 'msg-1', B + HOUR);
    const rows = run(db, { kind: 'retention.sweep_rows', now: B })
      .value as unknown as {
      rows: {
        family: string;
        id: string;
        rule?: string;
        notice_item_id?: string;
      }[];
    };
    const sources = rows.rows.filter((row) => row.rule === 'source_body');
    assert.deepEqual(
      sources.map((row) => [row.id, row.notice_item_id]),
      [
        ['google/acct-a/msg-1', 'msg-1'],
        ['google/acct-b/msg-1', 'msg-1'],
      ],
    );
    assert.deepEqual(
      deleteExpired(
        db,
        'source_item',
        ['google/acct-a/msg-1'],
        B + 24 * HOUR - 1,
      ).deleted,
      [],
    );
    const at = deleteExpired(
      db,
      'source_item',
      ['google/acct-a/msg-1', 'google/acct-b/msg-1'],
      B + 24 * HOUR,
    );
    assert.deepEqual(at.deleted, ['google/acct-a/msg-1']);
    assert.deepEqual(at.skipped, [
      { id: 'google/acct-b/msg-1', reasons: ['not_due'] },
    ]);
    assert.equal(count(db, 'SELECT count(*) FROM source_items'), 1);
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'source_items'",
      ),
      1,
    );
  });
});

test('derived rows expire with the earliest origin; an origin that is gone expires it at once; lineage edges stay while a live downstream exists', async () => {
  await withDb((db) => {
    insertTurn(db, T_N, B, B + 7 * DAY);
    insertSourceItem(db, 'acct-a', 'msg-1', B);
    insertCandidate(db, 'n-1');
    edge(db, 'notification_candidate', 'n-1', 'turn', T_N);
    edge(db, 'notification_candidate', 'n-1', 'source_item', 'msg-1');
    insertCandidate(db, 'n-gone');
    edge(
      db,
      'notification_candidate',
      'n-gone',
      'turn',
      'b1000000-0000-4000-8000-0000000000ee',
    );
    // 元情報の由来は 24 時間で切れる（n-1 の期限は最も早い 24 時間）。1 ms 前は残る。
    assert.deepEqual(
      deleteExpired(
        db,
        'derived',
        ['notification_candidate:n-1'],
        B + 24 * HOUR - 1,
      ).deleted,
      [],
    );
    // 由来の発言がもうない派生物は、期限を待たず消える（存在しない由来は期限切れ。ADR 0040）。
    assert.deepEqual(
      deleteExpired(db, 'derived', ['notification_candidate:n-gone'], B + 1)
        .deleted,
      ['notification_candidate:n-gone'],
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM derivations WHERE artifact_id = 'n-gone'",
      ),
      0,
    );
    assert.deepEqual(
      deleteExpired(
        db,
        'derived',
        ['notification_candidate:n-1'],
        B + 24 * HOUR,
      ).deleted,
      ['notification_candidate:n-1'],
    );
    assert.equal(count(db, 'SELECT count(*) FROM notification_candidates'), 0);
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'notification_candidates'",
      ),
      0,
    );
    assert.equal(count(db, 'SELECT count(*) FROM derivations'), 0);
    // 発言は 7 日まで残る（派生物の期限切れで由来は消えない）。
    assert.equal(count(db, 'SELECT count(*) FROM turns'), 1);
  });
});

test('a carried summary (edges only) expires with its origin and removes only its edges', async () => {
  await withDb((db) => {
    insertTurn(db, T_N, B, B + 7 * DAY);
    edge(db, 'carried_summary', 'cs-1', 'turn', T_N);
    const rows = run(db, { kind: 'retention.sweep_rows', now: B })
      .value as unknown as {
      rows: { family: string; id: string; notice_item_id?: string }[];
    };
    assert.deepEqual(
      rows.rows
        .filter((row) => row.family === 'derived')
        .map((row) => [row.id, row.notice_item_id]),
      [['carried_summary:cs-1', 'cs-1']],
    );
    assert.deepEqual(
      deleteExpired(db, 'derived', ['carried_summary:cs-1'], B + 7 * DAY - 1)
        .deleted,
      [],
    );
    assert.deepEqual(
      deleteExpired(db, 'derived', ['carried_summary:cs-1'], B + 7 * DAY)
        .deleted,
      ['carried_summary:cs-1'],
    );
    assert.equal(count(db, 'SELECT count(*) FROM derivations'), 0);
  });
});

test('deleting an expired turn keeps the edge to a live memory derived from it, and the memory row is untouched', async () => {
  await withDb((db) => {
    insertTurn(db, T_N, B, B + 7 * DAY);
    insertMemory(db, M_LIVE, 'e1'.repeat(32), [
      { source_kind: 'turn', source_id: T_N },
    ]);
    edge(db, 'memory', M_LIVE, 'turn', T_N);
    deleteExpired(db, 'turn', [T_N], B + 7 * DAY);
    // 生きた下流（記憶）がある間は、ID だけの辺を残す（後で元を忘れたときに閉包から漏れない。ADR 0054 U110）。
    assert.deepEqual(
      db
        .prepare(
          'SELECT artifact_kind, artifact_id, source_kind, source_id FROM derivations',
        )
        .all(),
      [
        {
          artifact_kind: 'memory',
          artifact_id: M_LIVE,
          source_kind: 'turn',
          source_id: T_N,
        },
      ],
    );
    assert.equal(count(db, 'SELECT count(*) FROM memories'), 1);
  });
});

test('delete_expired rejects malformed commands before touching rows', async () => {
  await withDb((db) => {
    insertTurn(db, T_N, B, B + 7 * DAY);
    const cases: { op: unknown; reasons: string[] }[] = [
      {
        op: {
          kind: 'retention.delete_expired',
          family: 'memory',
          ids: [T_N],
          now: B,
        },
        reasons: ['family_invalid'],
      },
      {
        op: {
          kind: 'retention.delete_expired',
          family: 'turn',
          ids: [],
          now: B,
        },
        reasons: ['ids_invalid'],
      },
      {
        op: {
          kind: 'retention.delete_expired',
          family: 'turn',
          ids: Array.from({ length: 51 }, (_, i) => `id-${i}`),
          now: B,
        },
        reasons: ['ids_invalid'],
      },
      {
        op: {
          kind: 'retention.delete_expired',
          family: 'turn',
          ids: [T_N],
          now: -1,
        },
        reasons: ['now_invalid'],
      },
    ];
    for (const item of cases) {
      const result = run(db, item.op as RetentionOp);
      assert.equal(result.ok, false);
      assert.deepEqual(result.reasons, item.reasons);
    }
    assert.equal(count(db, 'SELECT count(*) FROM turns'), 1);
  });
});
