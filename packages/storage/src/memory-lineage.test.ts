// 記憶の期限削除の後の系譜・保存の最後の検査の期限・0012 より前の台帳の系譜（ADR 0054 U110・U118・U119）。
// - 派生した記憶を明示継続し、親の記憶を期限で消しても、元の発言を忘れると派生した記憶が閉包に入って消える。
// - 期限で消した記憶に残した辺は、派生物がなくなれば消える。
// - 保存の最後の検査は、由来の発言・記憶・元情報の期限を transaction の中の今の値で判定する（1 ms 前・ちょうど・直後）。
// - 0012 より前の台帳の行がある DB には、系譜を付けてから書き出せる。系譜のないまま忘却で新しい系譜を出さない。
// 期待値は手で書いた（期限は DAY・HOUR の掛け算で、domain の関数を呼んでいない）。HMAC は試験用に決めた 64 桁の値。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { MemorySource } from '@buddy/domain';
import { executeRetentionOp } from './index.js';
import type {
  ForgetGraphValue,
  ForgetLedgerExport,
  MemoryOp,
  SqliteDatabase,
  SourceHmacValue,
} from './index.js';
import {
  ENTRY_1,
  HMACS,
  LEDGER_ID,
  M,
  M2,
  M_OTHER,
  OP_DONE,
  S,
  T_OTHER,
  T_SRC,
  count,
  memoryOp,
  planFor,
  reasons,
  value,
  withWorld,
} from './forget-test-support.js';
import { sealedIntent } from './operation-test-support.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
// seedWorld の記憶の見直し日（手で書いた値）。
const REVIEW_AT = 9_000_000_000_000;

function save(
  db: SqliteDatabase,
  overrides: Partial<Extract<MemoryOp, { kind: 'memory.save' }>>,
) {
  return memoryOp(db, {
    kind: 'memory.save',
    memory_id: randomUUID(),
    origin: 'explicit_request',
    memory_kind: 'goal',
    text: sealedIntent(),
    target_key: sealedIntent(),
    target_key_hash: randomBytes(32).toString('hex'),
    dedupe_key: randomBytes(32).toString('hex'),
    sources: [],
    source_hmacs: HMACS,
    forgetting_generation: '0',
    now: 1_000_000,
    ...overrides,
  });
}

const edgesOf = (db: SqliteDatabase, memoryId: string) =>
  db
    .prepare(
      "SELECT source_kind, source_id FROM derivations WHERE artifact_kind = 'memory' AND artifact_id = ? ORDER BY source_kind, source_id",
    )
    .all(memoryId);

test('lineage: a continued derived memory is still forgotten with the original turn after its parent memory expires', async () => {
  await withWorld((db) => {
    // M（発言 T_SRC から）と M2（M から）を見直し待ちへ。M2 だけを明示継続し、M を期限で消す。
    for (const id of [M, M2])
      value(
        memoryOp(db, {
          kind: 'memory.start_review',
          memory_id: id,
          now: REVIEW_AT,
        }),
      );
    value(
      memoryOp(db, {
        kind: 'memory.continue',
        memory_id: M2,
        now: REVIEW_AT + DAY,
      }),
    );
    assert.deepEqual(
      value(
        memoryOp(db, {
          kind: 'memory.delete_due',
          memory_id: M,
          now: REVIEW_AT + 30 * DAY,
        }),
      ),
      { memory_id: M, deleted: true },
    );
    // 本文・行・由来の行は消え、ID だけの辺（M ← 発言 T_SRC）が残る。M2 ← M の由来の行も残る。
    assert.equal(
      count(db, 'SELECT count(*) FROM memories WHERE memory_id = ?', M),
      0,
    );
    assert.equal(
      count(db, 'SELECT count(*) FROM memory_sources WHERE memory_id = ?', M),
      0,
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'memories' AND owner_id = ?",
        M,
      ),
      0,
    );
    assert.deepEqual(edgesOf(db, M), [
      { source_kind: 'turn', source_id: T_SRC },
    ]);
    assert.deepEqual(
      db
        .prepare(
          'SELECT source_kind, source_id FROM memory_sources WHERE memory_id = ?',
        )
        .all(M2),
      [{ source_kind: 'memory', source_id: M }],
    );
    // 期限切れは忘却ではない（台帳に書かない）。
    assert.equal(count(db, 'SELECT count(*) FROM forget_ledger'), 0);
    // 系譜には M ← T_SRC と M2 ← M の両方が出る。
    const graph = value<ForgetGraphValue>(
      memoryOp(db, {
        kind: 'forget.graph',
        target: { source_kind: 'turn', source_id: T_SRC },
      }),
    ).graph;
    for (const expected of [
      {
        artifact: { kind: 'memory', id: M },
        source: { kind: 'turn', id: T_SRC },
      },
      {
        artifact: { kind: 'memory', id: M2 },
        source: { kind: 'memory', id: M },
      },
    ])
      assert.ok(
        graph.edges.some(
          (edge) => JSON.stringify(edge) === JSON.stringify(expected),
        ),
        JSON.stringify(expected),
      );
    // 元の発言 T_SRC を忘れると、継続した M2 も消える（M の辺がなければ M2 は閉包から漏れて active のまま残る）。
    const target: MemorySource = { source_kind: 'turn', source_id: T_SRC };
    const { plan, generation } = planFor(db, target, null);
    value(
      memoryOp(db, {
        kind: 'forget.apply',
        target,
        instruction_turn_id: null,
        plan: plan as never,
        source_hmacs: HMACS,
        entry_id: ENTRY_1,
        previous_generation: generation,
        new_ledger_id: LEDGER_ID,
        now: REVIEW_AT + 31 * DAY,
      }),
    );
    assert.equal(
      count(db, 'SELECT count(*) FROM memories WHERE memory_id = ?', M2),
      0,
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM forget_ledger_items WHERE item_kind = 'memory' AND item_id = ?",
        M2,
      ),
      1,
    );
    // 消した M・M2 の辺はもう残らない。関係のない M_OTHER は残る。
    assert.deepEqual(edgesOf(db, M), []);
    assert.equal(
      count(db, 'SELECT count(*) FROM memories WHERE memory_id = ?', M_OTHER),
      1,
    );
  });
});

test('lineage: the ID-only edges of an expired memory are removed once no derivative remains', async () => {
  await withWorld((db) => {
    // M_OTHER（発言 T_OTHER から）から記憶 X を作り、M_OTHER を期限で消すと辺が残る。X も期限で消すと辺は消える。
    const x = randomUUID();
    value(
      save(db, {
        memory_id: x,
        sources: [{ source_kind: 'memory', source_id: M_OTHER }],
        now: REVIEW_AT - 10 * DAY,
      }),
    );
    value(
      memoryOp(db, {
        kind: 'memory.start_review',
        memory_id: M_OTHER,
        now: REVIEW_AT,
      }),
    );
    value(
      memoryOp(db, {
        kind: 'memory.delete_due',
        memory_id: M_OTHER,
        now: REVIEW_AT + 30 * DAY,
      }),
    );
    assert.deepEqual(edgesOf(db, M_OTHER), [
      { source_kind: 'turn', source_id: T_OTHER },
    ]);
    // X の見直し日は M_OTHER の見直し日（REVIEW_AT）。見直しから 30 日で消す。
    value(
      memoryOp(db, {
        kind: 'memory.start_review',
        memory_id: x,
        now: REVIEW_AT,
      }),
    );
    value(
      memoryOp(db, {
        kind: 'memory.delete_due',
        memory_id: x,
        now: REVIEW_AT + 30 * DAY,
      }),
    );
    assert.deepEqual(edgesOf(db, x), []);
    assert.deepEqual(edgesOf(db, M_OTHER), []);
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM memory_sources WHERE source_kind = 'memory' AND source_id = ?",
        M_OTHER,
      ),
      0,
    );
  });
});

const T_EXP = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const T_EXP_EXPIRES = 5_000_000;
const MAIL = 'mail-remote-001';
const MAIL_FETCHED = 2_000_000;
const EXTRA_HMACS: readonly SourceHmacValue[] = [
  ...HMACS,
  { source_kind: 'turn', source_id: T_EXP, hmac: 'b9'.repeat(32) },
  { source_kind: 'source_item', source_id: MAIL, hmac: 'ba'.repeat(32) },
  {
    source_kind: 'source_item',
    source_id: 'mail-missing',
    hmac: 'bb'.repeat(32),
  },
];

function seedSources(db: SqliteDatabase): void {
  db.prepare(
    "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, ?, 'user', 'text', NULL, 1000, ?)",
  ).run(T_EXP, S, T_EXP_EXPIRES);
  db.exec(`
    INSERT INTO connections (connection_id, provider, account_blob_id, credential_ref, status, access, granted_scopes, targets, permission_revision, scope_revision)
      VALUES ('c-mail', 'google', NULL, NULL, 'active', 'read', '[]', '[]', 0, 0);
    INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_scan_id, active_generation, committed_watermark, provider_cursor, executor_generation)
      VALUES ('ss-mail', 'c-mail', 0, NULL, 0, NULL, NULL, 0);
  `);
  const body = randomUUID();
  db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'source_body', 'source_items', ?, 0, 1, 'k-test', ?, ?, ?, 1000, NULL)",
  ).run(body, MAIL, randomBytes(12), randomBytes(24), randomBytes(16));
  db.prepare(
    "INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id, published_generation, fetched_at, body_blob_id) VALUES ('google', 'acct-1', ?, 'r1', 'ss-mail', 0, ?, ?)",
  ).run(MAIL, MAIL_FETCHED, body);
  // 同じ元情報の ID の別のアカウントの行（本文なし）。本文のある行があれば保存できる。
  db.prepare(
    "INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id, published_generation, fetched_at, body_blob_id) VALUES ('google', 'acct-2', ?, 'r1', 'ss-mail', 0, ?, NULL)",
  ).run(MAIL, MAIL_FETCHED);
}

test('memory.save: sources are checked against their current deadlines in the save transaction (1 ms before, exactly, after)', async () => {
  await withWorld((db) => {
    seedSources(db);
    const turn = (now: number) =>
      save(db, {
        sources: [{ source_kind: 'turn', source_id: T_EXP }],
        source_hmacs: EXTRA_HMACS,
        now,
      });
    // 発言の期限（expires_at）: 1 ms 前は保存し、ちょうど・直後は掃除がまだでも期限切れ。
    value(turn(T_EXP_EXPIRES - 1));
    assert.deepEqual(reasons(turn(T_EXP_EXPIRES)), ['source_expired']);
    assert.deepEqual(reasons(turn(T_EXP_EXPIRES + 1)), ['source_expired']);
    // 期限の掃除がまだなので、発言の行は残っている。
    assert.equal(
      count(db, 'SELECT count(*) FROM turns WHERE turn_id = ?', T_EXP),
      1,
    );

    // 元情報の本文の期限（取得から 24 時間）。
    const mail = (now: number, id = MAIL) =>
      save(db, {
        sources: [{ source_kind: 'source_item', source_id: id }],
        source_hmacs: EXTRA_HMACS,
        now,
      });
    const mailDeadline = MAIL_FETCHED + 24 * HOUR;
    value(mail(mailDeadline - 1));
    assert.deepEqual(reasons(mail(mailDeadline)), ['source_expired']);
    assert.deepEqual(reasons(mail(mailDeadline + 1)), ['source_expired']);
    // 元情報の行がない。
    assert.deepEqual(reasons(mail(MAIL_FETCHED + 1, 'mail-missing')), [
      'source_expired',
    ]);
    // 本文のある行が消えた（本文のない行だけが残った）元情報。
    db.prepare(
      "UPDATE source_items SET body_blob_id = NULL WHERE account_id = 'acct-1'",
    ).run();
    assert.deepEqual(reasons(mail(MAIL_FETCHED + 1)), ['source_expired']);

    // 由来の記憶の削除の期限（見直し待ちの delete_at）: 1 ms 前は見直し日を過ぎているので見直し日の理由、ちょうど・直後は
    // 削除の掃除がまだでも期限切れ。
    value(
      memoryOp(db, {
        kind: 'memory.start_review',
        memory_id: M_OTHER,
        now: REVIEW_AT,
      }),
    );
    const memoryDeadline = REVIEW_AT + 30 * DAY;
    const fromMemory = (now: number) =>
      save(db, {
        sources: [{ source_kind: 'memory', source_id: M_OTHER }],
        now,
      });
    assert.deepEqual(reasons(fromMemory(memoryDeadline - 1)), [
      'source_review_due',
    ]);
    assert.deepEqual(reasons(fromMemory(memoryDeadline)), ['source_expired']);
    assert.deepEqual(reasons(fromMemory(memoryDeadline + 1)), [
      'source_expired',
    ]);
    // 保存したのは 1 ms 前の 2 件だけ（seedWorld の 3 件と合わせて 5 件）。
    assert.equal(count(db, 'SELECT count(*) FROM memories'), 5);
  });
});

// 0012 より前の台帳の行（hash・項目の数が NULL。0012 の trigger を一時的に外して入れる）。
function legacyLedgerRow(db: SqliteDatabase, memoryId: string): void {
  const triggers = db
    .prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND name IN ('forget_ledger_hash_required', 'forget_ledger_items_bounded', 'forget_ledger_items_shape')",
    )
    .all() as { name: string; sql: string }[];
  assert.equal(triggers.length, 3);
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
  db.prepare(
    "INSERT INTO forget_ledger (forgetting_generation, entry_id, recorded_at, entry_hash, item_count) VALUES (1, '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e', 1700000000000, NULL, NULL)",
  ).run();
  db.prepare(
    "INSERT INTO forget_ledger_items (forgetting_generation, item_kind, item_id) VALUES (1, 'memory', ?)",
  ).run(memoryId);
  for (const trigger of triggers) db.exec(trigger.sql);
}

test('legacy ledger rows: lineage is adopted only on request, and forgetting does not mint a lineage on its own', async () => {
  await withWorld((db) => {
    legacyLedgerRow(db, 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc');
    assert.deepEqual(reasons(memoryOp(db, { kind: 'forget.ledger_export' })), [
      'ledger_id_missing',
    ]);
    // 系譜がないまま忘却で新しい系譜を出さない（起動時の確認と付け直しを待つ）。
    const target: MemorySource = { source_kind: 'memory', source_id: M_OTHER };
    const { plan, generation } = planFor(db, target, null);
    assert.equal(generation, '1');
    assert.deepEqual(
      reasons(
        memoryOp(db, {
          kind: 'forget.apply',
          target,
          instruction_turn_id: null,
          plan: plan as never,
          source_hmacs: HMACS,
          entry_id: ENTRY_1,
          previous_generation: generation,
          new_ledger_id: LEDGER_ID,
          now: 1_800_000_000_000,
        }),
      ),
      ['ledger_id_missing'],
    );
    assert.equal(count(db, 'SELECT count(*) FROM forget_ledger'), 1);
    assert.equal(
      count(db, "SELECT count(*) FROM schema_meta WHERE key = 'ledger_id'"),
      0,
    );
    // 系譜を付けると書き出せる（旧い行の hash は書き出しで計算する）。2 回目は付け直さない。
    assert.deepEqual(
      value(
        memoryOp(db, { kind: 'forget.adopt_ledger_id', ledger_id: LEDGER_ID }),
      ),
      { ledger_id: LEDGER_ID, forgetting_generation: '1' },
    );
    assert.deepEqual(
      reasons(
        memoryOp(db, {
          kind: 'forget.adopt_ledger_id',
          ledger_id: randomUUID(),
        }),
      ),
      ['ledger_id_present'],
    );
    const exported = value<ForgetLedgerExport>(
      memoryOp(db, { kind: 'forget.ledger_export' }),
    );
    assert.equal(exported.ledger_id, LEDGER_ID);
    assert.equal(exported.head.forgetting_generation, '1');
    assert.equal(
      exported.entries[0]?.entry.recorded_at,
      '2023-11-14T22:13:20.000Z',
    );
  });
});

test('legacy ledger rows that cannot be written as a ledger file are not adopted', async () => {
  await withWorld((db) => {
    // 0012 の形の検査より前の行に、UUID でない記憶の ID（文が入った疑い）がある。
    legacyLedgerRow(db, 'not-a-uuid');
    assert.deepEqual(
      reasons(
        memoryOp(db, { kind: 'forget.adopt_ledger_id', ledger_id: LEDGER_ID }),
      ),
      ['legacy_ledger_invalid'],
    );
    assert.equal(
      count(db, "SELECT count(*) FROM schema_meta WHERE key = 'ledger_id'"),
      0,
    );
    // 台帳のない DB には付けない。
  });
  await withWorld((db) => {
    assert.deepEqual(
      reasons(
        memoryOp(db, { kind: 'forget.adopt_ledger_id', ledger_id: LEDGER_ID }),
      ),
      ['ledger_empty'],
    );
  });
});

const sourcedEdges = (db: SqliteDatabase, memoryId: string): number =>
  count(
    db,
    "SELECT count(*) FROM derivations WHERE source_kind = 'memory' AND source_id = ?",
    memoryId,
  );

function expire(db: SqliteDatabase, memoryId: string): void {
  value(
    memoryOp(db, {
      kind: 'memory.start_review',
      memory_id: memoryId,
      now: REVIEW_AT,
    }),
  );
  value(
    memoryOp(db, {
      kind: 'memory.delete_due',
      memory_id: memoryId,
      now: REVIEW_AT + 30 * DAY,
    }),
  );
}

test('lineage: merging lineages of expired memories are all removed when the last live derivative goes', async () => {
  await withWorld((db) => {
    // A = M_OTHER（発言 T_OTHER から）、B ← A、Y ← A と B（合流）、Z ← Y。A・B・Y を期限で消すと辺だけが残る。
    // ID は固定（A = 6666… が B = f1f1… より先に評価される順。子がまだある親を飛ばした後で、親を評価し直すこと）。
    const b = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
    const y = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2';
    const z = 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3';
    const at = REVIEW_AT - 10 * DAY;
    const hmacs: readonly SourceHmacValue[] = [
      ...HMACS,
      { source_kind: 'memory', source_id: b, hmac: 'c7'.repeat(32) },
      { source_kind: 'memory', source_id: y, hmac: 'c8'.repeat(32) },
    ];
    value(
      save(db, {
        memory_id: b,
        sources: [{ source_kind: 'memory', source_id: M_OTHER }],
        source_hmacs: hmacs,
        now: at,
      }),
    );
    value(
      save(db, {
        memory_id: y,
        sources: [
          { source_kind: 'memory', source_id: M_OTHER },
          { source_kind: 'memory', source_id: b },
        ],
        source_hmacs: hmacs,
        now: at,
      }),
    );
    value(
      save(db, {
        memory_id: z,
        sources: [{ source_kind: 'memory', source_id: y }],
        source_hmacs: hmacs,
        now: at,
      }),
    );
    for (const id of [M_OTHER, b, y]) expire(db, id);
    assert.deepEqual(edgesOf(db, M_OTHER), [
      { source_kind: 'turn', source_id: T_OTHER },
    ]);
    assert.deepEqual(edgesOf(db, b), [
      { source_kind: 'memory', source_id: M_OTHER },
    ]);
    assert.deepEqual(edgesOf(db, y), [
      { source_kind: 'memory', source_id: M_OTHER },
      { source_kind: 'memory', source_id: b },
    ]);
    // 最後の生きた派生物 Z を消すと、合流した系譜の辺がすべて消える。
    expire(db, z);
    for (const id of [M_OTHER, b, y, z]) {
      assert.deepEqual(edgesOf(db, id), [], id);
      assert.equal(sourcedEdges(db, id), 0, id);
    }
  });
});

test('lineage: the edges of an expired memory go when its operation content is purged after 90 days', async () => {
  await withWorld((db) => {
    // 成功した操作 OP_DONE（seedWorld で完了の時刻 1_000_000）の確定内容が M_OTHER から作られている。
    db.prepare(
      "INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES ('operation_content', ?, 'memory', ?, 1000)",
    ).run(OP_DONE, M_OTHER);
    expire(db, M_OTHER);
    assert.deepEqual(edgesOf(db, M_OTHER), [
      { source_kind: 'turn', source_id: T_OTHER },
    ]);
    const purged = executeRetentionOp(
      db,
      {
        kind: 'retention.purge_operation',
        operation_id: OP_DONE,
        now: 1_000_000 + 90 * DAY,
      },
      { platform: 'macos', halted: false },
    ).result;
    assert.deepEqual(purged, {
      ok: true,
      value: { operation_id: OP_DONE, purged: true },
    });
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM derivations WHERE artifact_kind = 'operation_content' AND artifact_id = ?",
        OP_DONE,
      ),
      0,
    );
    assert.deepEqual(edgesOf(db, M_OTHER), []);
    // 生きている記憶 M の辺には触れない。
    assert.deepEqual(edgesOf(db, M), []);
    assert.equal(
      count(db, 'SELECT count(*) FROM memory_sources WHERE memory_id = ?', M),
      1,
    );
  });
});

test('lineage: a derivative whose row is already gone does not keep the edges of an expired memory', async () => {
  await withWorld((db) => {
    // M_OTHER から記憶 X と気づき n-2 を作る。n-2 の行は（辺を消さない経路で）先に消えた。
    const x = randomUUID();
    value(
      save(db, {
        memory_id: x,
        sources: [{ source_kind: 'memory', source_id: M_OTHER }],
        now: REVIEW_AT - 10 * DAY,
      }),
    );
    db.prepare(
      "INSERT INTO notification_candidates (candidate_id, request_entity_id, request_revision, source_revision, kind, notification_key, title_blob_id, excerpt_blob_id, state, closed_at, key_delete_at) VALUES ('n-2', NULL, NULL, NULL, 'mail_reply', 'nk-2', NULL, NULL, 'new', NULL, NULL)",
    ).run();
    db.prepare(
      "INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES ('notification_candidate', 'n-2', 'memory', ?, 1000)",
    ).run(M_OTHER);
    expire(db, M_OTHER);
    db.prepare(
      "DELETE FROM notification_candidates WHERE candidate_id = 'n-2'",
    ).run();
    assert.deepEqual(edgesOf(db, M_OTHER), [
      { source_kind: 'turn', source_id: T_OTHER },
    ]);
    // 最後の生きた派生物 X を消すと、行のない n-2 の辺は道を残さない。
    expire(db, x);
    assert.deepEqual(edgesOf(db, M_OTHER), []);
    assert.equal(sourcedEdges(db, M_OTHER), 0);
  });
});
