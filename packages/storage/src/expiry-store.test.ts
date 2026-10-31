// 発言・元情報・派生物の期限削除（ADR 0058、B06-07a-1）。
// 期限は手で数えた UTC の Unix ミリ秒で書く（B = 2031-01-01T00:00:00Z = 1_924_992_000_000。domain の関数で求めない）。
// 1 ms 前は残し、ちょうどで消え、系譜の辺は生きた下流がなくなるまで残る。期限切れは忘却ではないので台帳に書かない。

import assert from 'node:assert/strict';
import test from 'node:test';
import { executeRetentionOp } from './index.js';
import type { RetentionOp, RetentionOpValue, SqliteDatabase } from './index.js';
import {
  OP_DONE,
  OP_RET,
  blob,
  completeOperation,
  count,
  edge,
  insertMemory,
  ok,
} from './forget-test-support.js';
import {
  createCommand,
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

test('a derived row from a finished operation body expires with the 7-day body, not the 90-day receipt, and goes in the same sweep as the body', async () => {
  await withDb((db) => {
    completeOperation(db, OP_DONE);
    const completedAt = db
      .prepare('SELECT completed_at FROM operations WHERE operation_id = ?')
      .pluck()
      .get(OP_DONE) as number;
    // 手で書いた期待値: 完了の時刻は completeOperation が使う 1_000_000。
    assert.equal(completedAt, 1_000_000);
    insertCandidate(db, 'n-op');
    edge(db, 'notification_candidate', 'n-op', 'operation_content', OP_DONE);
    const id = 'notification_candidate:n-op';
    // 本文の期限（完了から 7 日）の 1 ms 前は、本文も派生物も残る。
    const before = completedAt + 7 * DAY - 1;
    assert.deepEqual(deleteExpired(db, 'derived', [id], before).deleted, []);
    // 7 日ちょうど: 派生物の期限が来ている（レシートの 90 日ではない）。
    const rows = run(db, {
      kind: 'retention.sweep_rows',
      now: completedAt + 7 * DAY,
    }).value as unknown as {
      rows: {
        family: string;
        id: string;
        origins?: { expires_at: string | null }[];
      }[];
    };
    const derived = rows.rows.find((row) => row.family === 'derived');
    assert.equal(derived?.origins?.[0]?.expires_at, '1970-01-08T00:16:40Z');
    // 本文を消す掃除（retention.erase_due_bodies）の後に派生物を消しても、由来が無いので期限切れとして消える。
    const bodies = run(db, {
      kind: 'retention.erase_due_bodies',
      now: completedAt + 7 * DAY,
      limit: 50,
      after: null,
    });
    assert.equal(bodies.ok, true, JSON.stringify(bodies));
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM operation_versions WHERE operation_id = ? AND intent_blob_id IS NOT NULL',
        OP_DONE,
      ),
      0,
    );
    // 操作の行（レシート）は 90 日まで残るが、派生物はこの掃除で消える。
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM operations WHERE operation_id = ?',
        OP_DONE,
      ),
      1,
    );
    assert.deepEqual(
      deleteExpired(db, 'derived', [id], completedAt + 7 * DAY).deleted,
      [id],
    );
    assert.equal(count(db, 'SELECT count(*) FROM notification_candidates'), 0);
  });
});

test('a derived row from an operation body that was already erased is gone at once, even before the 7 days of another operation would pass', async () => {
  await withDb((db) => {
    completeOperation(db, OP_DONE);
    run(db, {
      kind: 'retention.erase_body',
      operation_id: OP_DONE,
      now: 1_000_000 + 7 * DAY,
    });
    insertCandidate(db, 'n-op');
    edge(db, 'notification_candidate', 'n-op', 'operation_content', OP_DONE);
    assert.deepEqual(
      deleteExpired(db, 'derived', ['notification_candidate:n-op'], 2_000_000)
        .deleted,
      ['notification_candidate:n-op'],
    );
  });
});

test('a derived row from the body of an unfinished operation has no deadline of its own', async () => {
  await withDb((db) => {
    ok(db, createCommand(OP_RET));
    insertCandidate(db, 'n-run');
    edge(db, 'notification_candidate', 'n-run', 'operation_content', OP_RET);
    assert.deepEqual(
      deleteExpired(
        db,
        'derived',
        ['notification_candidate:n-run'],
        B + 400 * DAY,
      ).deleted,
      [],
    );
  });
});

test('a derived row from a derived row with its own stored deadline expires when the upstream one does, in the same sweep', async () => {
  await withDb((db) => {
    // 発言（7 日）→ 影モードの記録 r-1（自身の期限は 1 日後）→ 気づき n-2。下流の期限は上流の保存した期限で 1 日になる。
    insertTurn(db, T_N, B, B + 7 * DAY);
    db.prepare(
      "INSERT INTO intent_shadow (record_id, campaign_id, input_id, request_revision, judgments, recorded_at, expires_at) VALUES ('r-1', 'camp', 'in-1', 1, '{}', ?, ?)",
    ).run(B, B + DAY);
    edge(db, 'intent_shadow', 'r-1', 'turn', T_N);
    insertCandidate(db, 'n-2');
    edge(db, 'notification_candidate', 'n-2', 'intent_shadow', 'r-1');
    const shadow = 'intent_shadow:r-1';
    const downstream = 'notification_candidate:n-2';
    const rows = run(db, { kind: 'retention.sweep_rows', now: B })
      .value as unknown as {
      rows: {
        family: string;
        id: string;
        origins?: { expires_at: string | null }[];
      }[];
    };
    assert.equal(
      rows.rows.find((row) => row.id === downstream)?.origins?.[0]?.expires_at,
      '2031-01-02T00:00:00Z',
    );
    // 1 日の 1 ms 前はどちらも残る。
    assert.deepEqual(
      deleteExpired(db, 'derived', [shadow, downstream], B + DAY - 1).deleted,
      [],
    );
    // 1 日ちょうど: 上流が消える同じ掃除で、下流も消える（下流が先でも、上流が先でも）。
    assert.deepEqual(
      deleteExpired(db, 'derived', [downstream, shadow], B + DAY).deleted,
      [downstream, shadow],
    );
    assert.equal(count(db, 'SELECT count(*) FROM intent_shadow'), 0);
    assert.equal(count(db, 'SELECT count(*) FROM notification_candidates'), 0);
    // 発言（7 日）は残る。
    assert.equal(count(db, 'SELECT count(*) FROM turns'), 1);
    assert.equal(count(db, 'SELECT count(*) FROM derivations'), 0);
  });
});

test('a derived row follows the corrected deadline of its origin: a turn stored with 40 days is pulled back to 7 days, and the turn and the derived row go in the same sweep', async () => {
  await withDb((db) => {
    insertTurn(db, T_LONG, B, B + 40 * DAY);
    insertCandidate(db, 'n-turn');
    edge(db, 'notification_candidate', 'n-turn', 'turn', T_LONG);
    const derived = 'notification_candidate:n-turn';
    assert.deepEqual(
      deleteExpired(db, 'derived', [derived], B + 7 * DAY - 1).deleted,
      [],
    );
    assert.deepEqual(
      deleteExpired(db, 'turn', [T_LONG], B + 7 * DAY - 1).deleted,
      [],
    );
    // 7 日ちょうど: 発言がまだ残っている状態で、気づきがもう期限になっている（発言と同じ日）。先に気づきを消し、
    // そのあと発言を消す（発言を先に消すと由来が無くなって消えるだけで、由来の期限の補正を確かめられない）。
    assert.deepEqual(
      deleteExpired(db, 'derived', [derived], B + 7 * DAY).deleted,
      [derived],
    );
    assert.equal(count(db, 'SELECT count(*) FROM turns'), 1);
    assert.deepEqual(deleteExpired(db, 'turn', [T_LONG], B + 7 * DAY).deleted, [
      T_LONG,
    ]);
    assert.equal(count(db, 'SELECT count(*) FROM derivations'), 0);
  });
});

test('a derived row follows the corrected deadline of its origin memory: review + 90 days stored is pulled back to review + 30 days, and the memory and the derived row go in the same sweep', async () => {
  await withDb((db) => {
    const REVIEW = B + 10 * DAY;
    insertMemory(db, M_LIVE, 'e2'.repeat(32), []);
    // 見直し待ちで、見直し日 + 90 日に延ばされた削除日を保存している（補正前の値）。
    db.prepare(
      "UPDATE memories SET status = 'review_pending', review_at = ?, delete_at = ?, created_at = ? WHERE memory_id = ?",
    ).run(REVIEW, REVIEW + 90 * DAY, B, M_LIVE);
    insertCandidate(db, 'n-mem');
    edge(db, 'notification_candidate', 'n-mem', 'memory', M_LIVE);
    const derived = 'notification_candidate:n-mem';
    assert.deepEqual(
      deleteExpired(db, 'derived', [derived], REVIEW + 30 * DAY - 1).deleted,
      [],
    );
    // 30 日ちょうど: 記憶の削除（memory.delete_due）と同じ日に、気づきも期限になる。
    const rows = run(db, {
      kind: 'retention.sweep_rows',
      now: REVIEW + 30 * DAY,
    }).value as unknown as {
      rows: { id: string; origins?: { expires_at: string | null }[] }[];
    };
    assert.equal(
      rows.rows.find((row) => row.id === derived)?.origins?.[0]?.expires_at,
      new Date(REVIEW + 30 * DAY).toISOString().replace('.000Z', 'Z'),
    );
    assert.deepEqual(
      deleteExpired(db, 'derived', [derived], REVIEW + 30 * DAY).deleted,
      [derived],
    );
  });
});
