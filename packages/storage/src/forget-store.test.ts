// 忘却の transaction（ADR 0054、マイグレーション 0012）: 台帳の行と連鎖の hash、派生の閉包による物理削除、「〇〇を忘れて」
// の発言の削除、進行中の操作への送出禁止の印（状態・承認・試行は変えず、再送もしない）、計画が古いときの拒否、遅れて
// 届いた結果の拒否（memory.save の最後の保証）。期待値は手で書いた（連鎖の hash の求め方は forget-test-support.ts）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { MemorySource } from '@buddy/domain';
import type {
  DbCommand,
  ForgetApplyValue,
  ForgetLedgerExport,
  MemoryOp,
} from './index.js';
import {
  DIRECTIVE,
  DK_M,
  DK_M2,
  DK_OTHER,
  ENTRY_1,
  ENTRY_2,
  HASH_1,
  HASH_2,
  HMACS,
  H_T_OTHER,
  H_T_SRC,
  LEDGER_ID,
  M,
  M2,
  M_OTHER,
  NOW_1,
  OP_DISP,
  OP_DONE,
  OP_RET,
  S,
  T_INST,
  T_OTHER,
  T_SRC,
  count,
  edge,
  forgetM,
  forgetOther,
  memoryOp,
  ok,
  planFor,
  reasons,
  run,
  value,
  withWorld,
} from './forget-test-support.js';
import {
  cancelCommand,
  prepareCommand,
  resultCommand,
  sealedIntent,
} from './operation-test-support.js';

test('forget: one transaction writes the ledger row and items, deletes the closure, the instruction turn and marks in-flight operations', async () => {
  await withWorld((db) => {
    const result = value<ForgetApplyValue>(forgetM(db));
    assert.deepEqual(result, {
      forgetting_generation: '1',
      entry_id: ENTRY_1,
      entry_hash: HASH_1,
      ledger_id: LEDGER_ID,
      deleted: {
        intent_shadow: 1,
        notification_candidate: 1,
        session_summary: 1,
        memory: 2,
        turn: 1,
      },
      purged_operations: [OP_DONE],
      send_blocked_operations: [OP_RET, OP_DISP],
      notice: {
        forgotten: [
          { item_kind: 'memory', item_id: M },
          { item_kind: 'turn', item_id: T_INST },
        ],
        derived_from_forgotten: [{ item_kind: 'memory', item_id: M2 }],
      },
    });
    // 台帳の行と項目（本文なし。元の発言は再登録の禁止の HMAC だけ）。
    assert.deepEqual(
      db
        .prepare(
          'SELECT forgetting_generation, entry_id, recorded_at, entry_hash, item_count FROM forget_ledger',
        )
        .all(),
      [
        {
          forgetting_generation: 1,
          entry_id: ENTRY_1,
          recorded_at: NOW_1,
          entry_hash: HASH_1,
          item_count: 6,
        },
      ],
    );
    assert.deepEqual(
      db
        .prepare(
          'SELECT item_kind, item_id FROM forget_ledger_items ORDER BY item_kind, item_id',
        )
        .all(),
      [
        { item_kind: 'blocked_content', item_id: DK_M },
        { item_kind: 'blocked_content', item_id: DK_M2 },
        { item_kind: 'blocked_source', item_id: H_T_SRC },
        { item_kind: 'memory', item_id: M },
        { item_kind: 'memory', item_id: M2 },
        { item_kind: 'turn', item_id: T_INST },
      ],
    );
    assert.equal(
      db
        .prepare("SELECT value FROM schema_meta WHERE key = 'ledger_id'")
        .pluck()
        .get(),
      LEDGER_ID,
    );
    // 消えた物: 記憶 M・M2 とその暗号文・由来、気づき、影モードの記録、会話 S の要約、指示の発言と応答。
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM memories WHERE memory_id IN (?, ?)',
        M,
        M2,
      ),
      0,
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'memories' AND owner_id IN (?, ?)",
        M,
        M2,
      ),
      0,
    );
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM memory_sources WHERE memory_id IN (?, ?)',
        M,
        M2,
      ),
      0,
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM notification_candidates WHERE candidate_id = 'n-1'",
      ),
      0,
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'notification_candidates'",
      ),
      0,
    );
    assert.equal(
      count(db, "SELECT count(*) FROM intent_shadow WHERE record_id = 'r-1'"),
      0,
    );
    assert.equal(
      db
        .prepare('SELECT summary_blob_id FROM sessions WHERE session_id = ?')
        .pluck()
        .get(S),
      null,
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE purpose = 'session_summary'",
      ),
      0,
    );
    assert.equal(
      count(db, 'SELECT count(*) FROM turns WHERE turn_id = ?', T_INST),
      0,
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'turns' AND owner_id = ?",
        T_INST,
      ),
      0,
    );
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM turn_responses WHERE turn_id = ?',
        T_INST,
      ),
      0,
    );
    // 入力の版と本人の指示は残り、発言への結び付けだけが外れる。
    assert.equal(
      db
        .prepare("SELECT turn_id FROM input_snapshots WHERE input_id = 'in-1'")
        .pluck()
        .get(),
      null,
    );
    assert.equal(
      db
        .prepare('SELECT turn_id FROM user_directives WHERE directive_id = ?')
        .pluck()
        .get(DIRECTIVE),
      null,
    );
    // 消した物の系譜の辺は残らない。
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM derivations WHERE artifact_kind = 'notification_candidate'",
      ),
      0,
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM derivations WHERE artifact_kind = 'operation_content' AND artifact_id = ?",
        OP_DONE,
      ),
      0,
    );
    // 残る物: 元の発言 T_SRC（再登録の禁止だけ）と、関係のない記憶・発言。
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM turns WHERE turn_id IN (?, ?)',
        T_SRC,
        T_OTHER,
      ),
      2,
    );
    assert.equal(
      count(db, 'SELECT count(*) FROM memories WHERE memory_id = ?', M_OTHER),
      1,
    );
    // 終わった操作は確定内容（暗号文）だけが消え、hash と行は残る。
    assert.deepEqual(
      db
        .prepare(
          'SELECT intent_blob_id, body_deleted_at FROM operation_versions WHERE operation_id = ?',
        )
        .get(OP_DONE),
      { intent_blob_id: null, body_deleted_at: NOW_1 },
    );
    assert.equal(
      db
        .prepare('SELECT state FROM operations WHERE operation_id = ?')
        .pluck()
        .get(OP_DONE),
      'succeeded',
    );
  });
});

test('forget: in-flight operations are not deleted, not changed and not resent; only new sends are refused', async () => {
  await withWorld((db) => {
    const before = db
      .prepare(
        'SELECT operation_id, state, state_revision FROM operations WHERE operation_id IN (?, ?) ORDER BY operation_id',
      )
      .all(OP_RET, OP_DISP);
    const approvalsBefore = db
      .prepare(
        'SELECT approval_id, status FROM approvals WHERE operation_id IN (?, ?) ORDER BY approval_id',
      )
      .all(OP_RET, OP_DISP);
    const attemptsBefore = db
      .prepare(
        'SELECT attempt_id, status FROM operation_attempts WHERE operation_id IN (?, ?) ORDER BY attempt_id',
      )
      .all(OP_RET, OP_DISP);
    value(forgetM(db));
    assert.deepEqual(
      db
        .prepare(
          'SELECT operation_id, state, state_revision FROM operations WHERE operation_id IN (?, ?) ORDER BY operation_id',
        )
        .all(OP_RET, OP_DISP),
      before,
    );
    assert.deepEqual(
      db
        .prepare(
          'SELECT approval_id, status FROM approvals WHERE operation_id IN (?, ?) ORDER BY approval_id',
        )
        .all(OP_RET, OP_DISP),
      approvalsBefore,
    );
    assert.deepEqual(
      db
        .prepare(
          'SELECT attempt_id, status FROM operation_attempts WHERE operation_id IN (?, ?) ORDER BY attempt_id',
        )
        .all(OP_RET, OP_DISP),
      attemptsBefore,
    );
    // 確定内容（暗号文）は残す（終わってから J5 の削除に任せる）。
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM operation_versions WHERE operation_id IN (?, ?) AND intent_blob_id IS NOT NULL',
        OP_RET,
        OP_DISP,
      ),
      2,
    );
    assert.deepEqual(
      db
        .prepare(
          'SELECT operation_id, send_blocked_generation FROM operations WHERE send_blocked_generation IS NOT NULL ORDER BY operation_id',
        )
        .all(),
      [
        { operation_id: OP_RET, send_blocked_generation: 1 },
        { operation_id: OP_DISP, send_blocked_generation: 1 },
      ],
    );
    // 承認済みの操作は準備（送出の手前）へ進めない。命令の世代を今の値にしても、DB の印が拒否する。
    const prepare = run(
      db,
      prepareCommand(OP_RET, '2', { forgetting_generation: '1' }),
      NOW_1 + 1,
    );
    assert.equal(prepare.outcome, 'rejected');
    assert.deepEqual(prepare.outcome === 'rejected' ? prepare.reasons : [], [
      'operation_send_blocked',
    ]);
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO approvals (approval_id, operation_id, content_version, content_hash, route, device_id, preview_id, policy_version, status, approved_at) VALUES ('ap-x', ?, 1, ?, 'screen', 'dev-1', 'pv', NULL, 'valid', 1)",
          )
          .run(OP_RET, 'a'.repeat(64)),
      /operation_send_blocked/u,
    );
    // 送出の境界を越えた操作は、結果の記録を続けられる（照合で成功を取り込む。もう一度は送らない）。
    ok(
      db,
      resultCommand(OP_DISP, '4', 'att-disp', 'reconciling', {
        forgetting_generation: '1',
      }),
      NOW_1 + 2,
    );
    ok(
      db,
      resultCommand(OP_DISP, '5', 'att-disp', 'succeeded', {
        forgetting_generation: '1',
      }),
      NOW_1 + 3,
    );
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM operation_attempts WHERE operation_id = ?',
        OP_DISP,
      ),
      1,
    );
    // 印は外せない。
    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE operations SET send_blocked_generation = NULL WHERE operation_id = ?',
          )
          .run(OP_RET),
      /operation_send_blocked_fixed/u,
    );
    // 本人の取消は止めない（勝手には取り消さない）。
    ok(
      db,
      cancelCommand(OP_RET, '2', { forgetting_generation: '1' }) as DbCommand,
      NOW_1 + 4,
    );
    assert.equal(
      db
        .prepare('SELECT state FROM operations WHERE operation_id = ?')
        .pluck()
        .get(OP_RET),
      'cancelled',
    );
  });
});

test('forget: a derivation written after the plan was read makes the plan stale; the new plan covers it (no closure leak)', async () => {
  await withWorld((db) => {
    const target: MemorySource = { source_kind: 'memory', source_id: M };
    const { plan, generation } = planFor(db, target, T_INST);
    // 計画を読んだ後に、M から作った派生物が増えた。
    edge(db, 'async_guard', 'g-late', 'memory', M);
    db.prepare(
      "INSERT INTO async_context_guards (guard_id, job_id, source_refs, input_id, request_revision, permission_revision, forgetting_generation, query_scopes, output_mode, output_device_id, session_epoch, related_group_id, analysis_revision, source_set_hash, published_generation, expires_at) VALUES ('g-late', 'job', '[]', NULL, NULL, 0, 0, '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 2000)",
    ).run();
    const stale = memoryOp(db, {
      kind: 'forget.apply',
      target,
      instruction_turn_id: T_INST,
      plan: plan as never,
      source_hmacs: HMACS,
      entry_id: ENTRY_1,
      previous_generation: generation,
      new_ledger_id: LEDGER_ID,
      now: NOW_1,
    });
    assert.deepEqual(reasons(stale), ['forget_plan_stale']);
    assert.equal(count(db, 'SELECT count(*) FROM forget_ledger'), 0);
    assert.equal(
      count(db, 'SELECT count(*) FROM memories WHERE memory_id = ?', M),
      1,
    );
    // 計画を作り直せば、増えた派生物も消える。
    value(forgetM(db));
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM async_context_guards WHERE guard_id = 'g-late'",
      ),
      0,
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM derivations WHERE artifact_id = 'g-late'",
      ),
      0,
    );
  });
});

test('forget: refusals write nothing (old generation, missing HMAC, unknown target, fault before COMMIT)', async () => {
  await withWorld((db) => {
    const target: MemorySource = { source_kind: 'memory', source_id: M };
    const { plan } = planFor(db, target, T_INST);
    const base = {
      kind: 'forget.apply' as const,
      target,
      instruction_turn_id: T_INST,
      plan: plan as never,
      source_hmacs: HMACS,
      entry_id: ENTRY_1,
      previous_generation: '0',
      new_ledger_id: LEDGER_ID,
      now: NOW_1,
    };
    assert.deepEqual(
      reasons(memoryOp(db, { ...base, previous_generation: '1' })),
      ['forgetting_generation_changed'],
    );
    assert.deepEqual(reasons(memoryOp(db, { ...base, source_hmacs: [] })), [
      'source_hmac_missing',
    ]);
    // 生の ID を返す（HMAC の形でない）値は台帳に書かない。
    assert.deepEqual(
      reasons(
        memoryOp(db, {
          ...base,
          source_hmacs: HMACS.map((item) => ({
            ...item,
            hmac: item.source_id,
          })),
        }),
      ),
      ['source_hmac_malformed'],
    );
    assert.deepEqual(
      reasons(
        memoryOp(db, {
          ...base,
          target: { source_kind: 'memory', source_id: randomUUID() },
        }),
      ),
      ['target_not_found'],
    );
    const faulted = forgetM(db, () => {
      throw new Error('注入した失敗（COMMIT の前）');
    });
    assert.equal(faulted.ok, false);
    assert.equal(count(db, 'SELECT count(*) FROM forget_ledger'), 0);
    assert.equal(count(db, 'SELECT count(*) FROM forget_ledger_items'), 0);
    assert.equal(count(db, 'SELECT count(*) FROM memories'), 3);
    assert.equal(count(db, 'SELECT count(*) FROM turns'), 3);
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM operations WHERE send_blocked_generation IS NOT NULL',
      ),
      0,
    );
    assert.equal(
      db
        .prepare("SELECT value FROM schema_meta WHERE key = 'ledger_id'")
        .pluck()
        .get(),
      undefined,
    );
  });
});

test('forget: the second generation chains to the first, and the export recomputes both hashes', async () => {
  await withWorld((db) => {
    value(forgetM(db));
    const second = value<ForgetApplyValue>(forgetOther(db));
    assert.equal(second.forgetting_generation, '2');
    assert.equal(second.entry_hash, HASH_2);
    // 系譜は 1 回目の値のまま（2 回目に渡した値は使わない）。
    assert.equal(second.ledger_id, LEDGER_ID);
    const exported = value<ForgetLedgerExport>(
      memoryOp(db, { kind: 'forget.ledger_export' }),
    );
    assert.deepEqual(
      exported.entries.map((item) => [
        item.entry.forgetting_generation,
        item.previous_hash,
        item.entry_hash,
      ]),
      [
        ['1', '0'.repeat(64), HASH_1],
        ['2', HASH_1, HASH_2],
      ],
    );
    assert.deepEqual(exported.head, {
      forgetting_generation: '2',
      entry_hash: HASH_2,
    });
    assert.deepEqual(exported.entries[1]?.entry, {
      schema: 'buddy.forget-ledger.v1',
      entry_id: ENTRY_2,
      forgetting_generation: '2',
      recorded_at: '2031-01-03T00:00:00.000Z',
      forgotten: [{ source_kind: 'memory', source_id: M_OTHER }],
      blocked_source_hmacs: [H_T_OTHER],
      blocked_content_keys: [DK_OTHER],
    });
  });
});

test('0012: ledger rows and items are append-only and sealed by item_count', async () => {
  await withWorld((db) => {
    value(forgetM(db));
    assert.throws(
      () => db.prepare('DELETE FROM forget_ledger_items').run(),
      /forget_ledger_append_only/u,
    );
    assert.throws(
      () => db.prepare("UPDATE forget_ledger_items SET item_id = 'x'").run(),
      /forget_ledger_append_only/u,
    );
    // 書いた後に項目を足して、連鎖の hash と食い違わせない。
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO forget_ledger_items VALUES (1, 'blocked_content', ?)",
          )
          .run('e1'.repeat(32)),
      /forget_ledger_items_sealed/u,
    );
    // 台帳の欄に文を入れない。
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO forget_ledger VALUES (2, ?, 1, ?, 1)')
          .run(randomUUID(), 'a'.repeat(64)) &&
        db
          .prepare(
            "INSERT INTO forget_ledger_items VALUES (2, 'turn', 'Forget.')",
          )
          .run(),
      /forget_ledger_item_shape/u,
    );
  });
  await withWorld((db) => {
    // hash と項目の数のない行は書けない・同じ entry_id で置き換えない・系譜は変えない。
    assert.throws(
      () =>
        db
          .prepare(
            'INSERT INTO forget_ledger (forgetting_generation, entry_id, recorded_at) VALUES (1, ?, 1)',
          )
          .run(randomUUID()),
      /forget_ledger_hash_required/u,
    );
    value(forgetM(db));
    assert.throws(
      () =>
        db
          .prepare(
            'INSERT OR REPLACE INTO forget_ledger VALUES (2, ?, 1, ?, 1)',
          )
          .run(ENTRY_1, 'a'.repeat(64)),
      /forget_ledger_append_only/u,
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE schema_meta SET value = ? WHERE key = 'ledger_id'")
          .run(randomUUID()),
      /ledger_id_fixed/u,
    );
    assert.throws(
      () => db.prepare("DELETE FROM schema_meta WHERE key = 'ledger_id'").run(),
      /ledger_id_fixed/u,
    );
  });
});

test('late results: memory.save re-checks the whole ledger in the transaction (forgotten source, blocked content, generation ahead)', async () => {
  await withWorld((db) => {
    value(forgetM(db));
    const save = (
      overrides: Partial<Extract<MemoryOp, { kind: 'memory.save' }>>,
    ) =>
      memoryOp(db, {
        kind: 'memory.save',
        memory_id: randomUUID(),
        origin: 'auto_extraction',
        memory_kind: 'goal',
        text: sealedIntent(),
        target_key: sealedIntent(),
        target_key_hash: 'ab'.repeat(32),
        dedupe_key: 'ee'.repeat(32),
        sources: [{ source_kind: 'turn', source_id: T_OTHER }],
        source_hmacs: HMACS,
        forgetting_generation: '0',
        now: NOW_1 + 10,
        ...overrides,
      });
    // 忘却より前に始めた抽出が、忘れた記憶の元の発言から届いた（再登録の禁止）。
    assert.deepEqual(
      reasons(save({ sources: [{ source_kind: 'turn', source_id: T_SRC }] })),
      ['source_forgotten'],
    );
    // 忘れた記憶そのものを由来にする結果（台帳の forgotten、行もない）。
    assert.deepEqual(
      reasons(save({ sources: [{ source_kind: 'memory', source_id: M }] })),
      ['source_forgotten', 'source_expired'],
    );
    // 同じ内容の自動抽出は止める（明示の保存は内容の禁止では止めない）。
    assert.deepEqual(
      reasons(save({ dedupe_key: DK_M, forgetting_generation: '1' })),
      ['content_forgotten'],
    );
    // 開始の世代が今より先（台帳の巻き戻りの疑い）。
    assert.deepEqual(reasons(save({ forgetting_generation: '2' })), [
      'generation_ahead',
    ]);
    // 由来がない・HMAC が渡されない。
    assert.deepEqual(reasons(save({ sources: [] })), ['provenance_unknown']);
    assert.deepEqual(reasons(save({ source_hmacs: [] })), [
      'source_hmac_malformed',
    ]);
    assert.equal(count(db, 'SELECT count(*) FROM memories'), 1);
    // 関係のない忘却で世代が進んだだけでは止めない（開始の世代 0 のまま保存できる）。
    const memoryId = randomUUID();
    assert.deepEqual(value(save({ memory_id: memoryId })), {
      memory_id: memoryId,
      status: 'active',
      review_at: NOW_1 + 10 + 90 * 86_400_000,
      delete_at: null,
    });
    // 明示の保存は、同じ内容の HMAC でも保存できる（ADR 0008）。
    const explicit = save({
      origin: 'explicit_request',
      dedupe_key: DK_M,
      target_key_hash: 'ac'.repeat(32),
      forgetting_generation: '1',
    });
    assert.equal(explicit.ok, true, JSON.stringify(explicit));
  });
});
