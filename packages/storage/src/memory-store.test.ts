// 記憶の命令（保存・見直し・明示継続・期限切れの削除）・本人の指示の取り消し・移せない用事の本人の決着（ADR 0054）。
// 期待値は手で書いた（期限は DAY の掛け算で、domain の関数を呼んでいない）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { executeRetentionOp } from './index.js';
import type {
  ForgetGraphValue,
  MemoryOp,
  RetentionOp,
  RetentionOpResult,
  SqliteDatabase,
} from './index.js';
import {
  DIRECTIVE,
  HMACS,
  M,
  M_OTHER,
  OP_DONE,
  OP_RET,
  S_INST,
  T_INST,
  T_OTHER,
  blob,
  count,
  memoryOp,
  reasons,
  value,
  withWorld,
} from './forget-test-support.js';
import { sealedIntent } from './operation-test-support.js';

const DAY = 86_400_000;
// seedWorld の記憶の見直し日（手で書いた値）。
const REVIEW_AT = 9_000_000_000_000;

function retention(db: SqliteDatabase, op: RetentionOp): RetentionOpResult {
  return executeRetentionOp(db, op, { platform: 'macos', halted: false })
    .result;
}

test('memory: review starts at review_at, explicit continue gives the next 90 days, and the review deadline deletes the row', async () => {
  await withWorld((db) => {
    assert.deepEqual(
      reasons(
        memoryOp(db, {
          kind: 'memory.start_review',
          memory_id: M_OTHER,
          now: REVIEW_AT - 1,
        }),
      ),
      ['not_due'],
    );
    assert.deepEqual(
      value(
        memoryOp(db, {
          kind: 'memory.start_review',
          memory_id: M_OTHER,
          now: REVIEW_AT,
        }),
      ),
      {
        memory_id: M_OTHER,
        status: 'review_pending',
        review_at: REVIEW_AT,
        delete_at: REVIEW_AT + 30 * DAY,
      },
    );
    // 見直し待ちは使わない側の状態。継続は見直し待ちだけ。
    assert.deepEqual(
      reasons(
        memoryOp(db, { kind: 'memory.continue', memory_id: M, now: REVIEW_AT }),
      ),
      ['not_review_pending'],
    );
    const continuedAt = REVIEW_AT + 5 * DAY;
    assert.deepEqual(
      value(
        memoryOp(db, {
          kind: 'memory.continue',
          memory_id: M_OTHER,
          now: continuedAt,
        }),
      ),
      {
        memory_id: M_OTHER,
        status: 'active',
        review_at: continuedAt + 90 * DAY,
        delete_at: null,
      },
    );
    // 2 回目の見直しと、30 日の期限での削除。期限の 1 ms 前は消さない。
    value(
      memoryOp(db, {
        kind: 'memory.start_review',
        memory_id: M_OTHER,
        now: continuedAt + 90 * DAY,
      }),
    );
    const deadline = continuedAt + 90 * DAY + 30 * DAY;
    assert.deepEqual(
      reasons(
        memoryOp(db, {
          kind: 'memory.delete_due',
          memory_id: M_OTHER,
          now: deadline - 1,
        }),
      ),
      ['not_due'],
    );
    // 期限を過ぎた見直し待ちは、継続で生き返らせない。
    assert.deepEqual(
      reasons(
        memoryOp(db, {
          kind: 'memory.continue',
          memory_id: M_OTHER,
          now: deadline,
        }),
      ),
      ['delete_due'],
    );
    db.prepare(
      "INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at) VALUES ('memory', ?, 'turn', ?, 1)",
    ).run(M_OTHER, T_OTHER);
    assert.deepEqual(
      value(
        memoryOp(db, {
          kind: 'memory.delete_due',
          memory_id: M_OTHER,
          now: deadline,
        }),
      ),
      { memory_id: M_OTHER, deleted: true },
    );
    assert.equal(
      count(db, 'SELECT count(*) FROM memories WHERE memory_id = ?', M_OTHER),
      0,
    );
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM memory_sources WHERE memory_id = ?',
        M_OTHER,
      ),
      0,
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'memories' AND owner_id = ?",
        M_OTHER,
      ),
      0,
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM derivations WHERE artifact_kind = 'memory' AND artifact_id = ?",
        M_OTHER,
      ),
      0,
    );
    // 期限切れは忘却ではない（台帳に書かない）。2 回目は何もしない。
    assert.equal(count(db, 'SELECT count(*) FROM forget_ledger'), 0);
    assert.deepEqual(
      value(
        memoryOp(db, {
          kind: 'memory.delete_due',
          memory_id: M_OTHER,
          now: deadline,
        }),
      ),
      { memory_id: M_OTHER, deleted: false },
    );
    // 生きている記憶は期限の削除で消せない。
    assert.deepEqual(
      reasons(
        memoryOp(db, {
          kind: 'memory.delete_due',
          memory_id: M,
          now: deadline,
        }),
      ),
      ['not_review_pending'],
    );
  });
});

test('memory.save: the review date is not later than a source memory, duplicates and conflicts are not saved', async () => {
  await withWorld((db) => {
    const save = (
      overrides: Partial<Extract<MemoryOp, { kind: 'memory.save' }>>,
    ) =>
      memoryOp(db, {
        kind: 'memory.save',
        memory_id: randomUUID(),
        origin: 'explicit_request',
        memory_kind: 'goal',
        text: sealedIntent(),
        target_key: sealedIntent(),
        target_key_hash: 'ab'.repeat(32),
        dedupe_key: 'ee'.repeat(32),
        sources: [{ source_kind: 'memory', source_id: M }],
        source_hmacs: HMACS,
        forgetting_generation: '0',
        now: 1_000_000,
        ...overrides,
      });
    const derived = randomUUID();
    // 別の記憶から作った記憶は、由来の見直し日（REVIEW_AT）より後にしない（保存から 90 日のほうが先なら 90 日）。
    assert.deepEqual(
      value(save({ memory_id: derived, now: REVIEW_AT - 10 * DAY })),
      {
        memory_id: derived,
        status: 'active',
        review_at: REVIEW_AT,
        delete_at: null,
      },
    );
    assert.deepEqual(
      db
        .prepare(
          'SELECT source_kind, source_id FROM memory_sources WHERE memory_id = ?',
        )
        .all(derived),
      [{ source_kind: 'memory', source_id: M }],
    );
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'memories' AND owner_id = ?",
        derived,
      ),
      2,
    );
    assert.deepEqual(reasons(save({})), ['memory_duplicate']);
    assert.deepEqual(reasons(save({ dedupe_key: 'ef'.repeat(32) })), [
      'memory_conflict_review_required',
    ]);
    // 期限で消えた発言を由来にする結果は保存しない。
    assert.deepEqual(
      reasons(
        save({
          dedupe_key: 'f0'.repeat(32),
          target_key_hash: 'f1'.repeat(32),
          sources: [{ source_kind: 'turn', source_id: randomUUID() }],
        }),
      ),
      ['source_hmac_malformed', 'source_expired'],
    );
  });
});

test('directive.revoke deletes the directive and its sealed text once', async () => {
  await withWorld((db) => {
    assert.deepEqual(
      value(
        memoryOp(db, { kind: 'directive.revoke', directive_id: DIRECTIVE }),
      ),
      {
        directive_id: DIRECTIVE,
        revoked: true,
      },
    );
    assert.equal(count(db, 'SELECT count(*) FROM user_directives'), 0);
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE purpose = 'directive_text'",
      ),
      0,
    );
    assert.deepEqual(
      value(
        memoryOp(db, { kind: 'directive.revoke', directive_id: DIRECTIVE }),
      ),
      {
        directive_id: DIRECTIVE,
        revoked: false,
      },
    );
  });
});

// 忘却の計画に出す「消える指示」の本文の封筒（U433、ADR 0185）。系譜と同じ読み取りで、系譜の辺にある指示の封筒を返す。
test('forget.graph returns the envelope of each directive in the lineage, and null when the envelope belongs to another owner', async () => {
  await withWorld((db) => {
    const D2 = 'f0000000-0000-4000-8000-000000000002';
    const D3 = 'f0000000-0000-4000-8000-000000000003';
    // D2 は忘却の指示の発言 T_INST から作った「今回は」の指示で、封筒の行の所有者が別の ID（この指示の封筒として読めない）。
    db.prepare(
      "INSERT INTO user_directives (directive_id, text_blob_id, scope, session_id, turn_id, active, created_at) VALUES (?, ?, 'this_time', ?, ?, 1, 1000)",
    ).run(
      D2,
      blob(db, 'directive_text', 'user_directives', randomUUID()),
      S_INST,
      T_INST,
    );
    // D3 は発言に結び付かない指示（系譜にない）。
    db.prepare(
      "INSERT INTO user_directives (directive_id, text_blob_id, scope, session_id, turn_id, active, created_at) VALUES (?, ?, 'from_now_on', NULL, NULL, 1, 1000)",
    ).run(D3, blob(db, 'directive_text', 'user_directives', D3));
    const stored = db
      .prepare(
        'SELECT b.blob_id, b.format_version, b.key_id, b.nonce, b.ciphertext, b.tag FROM user_directives d JOIN sealed_blobs b ON b.blob_id = d.text_blob_id WHERE d.directive_id = ?',
      )
      .get(DIRECTIVE) as {
      blob_id: string;
      format_version: number;
      key_id: string;
      nonce: Buffer;
      ciphertext: Buffer;
      tag: Buffer;
    };
    const read = value<ForgetGraphValue>(
      memoryOp(db, {
        kind: 'forget.graph',
        target: { source_kind: 'memory', source_id: M },
        instruction_turn_id: T_INST,
      }),
    );
    assert.deepEqual(read.directives, [
      {
        directive_id: DIRECTIVE,
        scope: 'from_now_on',
        text: {
          blob_id: stored.blob_id,
          format_version: stored.format_version,
          key_id: stored.key_id,
          nonce: new Uint8Array(stored.nonce),
          ciphertext: new Uint8Array(stored.ciphertext),
          tag: new Uint8Array(stored.tag),
        },
      },
      { directive_id: D2, scope: 'this_time', text: null },
    ]);
    // 忘却の指示の発言を含めない計画では、T_INST から作った指示は系譜にない。
    const withoutInstruction = value<ForgetGraphValue>(
      memoryOp(db, {
        kind: 'forget.graph',
        target: { source_kind: 'memory', source_id: M },
      }),
    );
    assert.deepEqual(withoutInstruction.directives, []);
  });
});

// 0010 までの用事（暗号文なし）を作る。0011 の trigger は新しい用事に暗号文を求めるので、trigger を一時的に外して入れる。
function legacyTask(
  db: SqliteDatabase,
  taskId: string,
  operationId: string,
): void {
  const sql = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'tasks_content_required'",
    )
    .pluck()
    .get() as string;
  db.exec('DROP TRIGGER tasks_content_required');
  db.prepare(
    "INSERT INTO tasks (task_id, operation_id, content_version, list_id, status, created_at, content_blob_id) VALUES (?, ?, 1, 'inbox', 'open', 1000, NULL)",
  ).run(taskId, operationId);
  db.exec(sql);
}

test('task.resolve_unmigrated: the owner discards or re-enters a task whose content could not be moved', async () => {
  await withWorld((db) => {
    const opA = OP_DONE;
    legacyTask(db, 'task-a', opA);
    const listed = retention(db, {
      kind: 'task.unmigrated_list',
      limit: 10,
      after: null,
    });
    assert.deepEqual(listed, {
      ok: true,
      value: {
        items: [
          {
            task_id: 'task-a',
            operation_id: opA,
            list_id: 'inbox',
            status: 'open',
            created_at: 1000,
          },
        ],
        next: null,
      },
    });
    // 移せない用事の操作は本文を消せない（0011）。本人が入れ直すと、結び付けて削除の対象に戻る。
    const eraseAt = 1_000_000 + 7 * DAY;
    assert.deepEqual(
      retention(db, {
        kind: 'retention.erase_body',
        operation_id: opA,
        now: eraseAt,
      }),
      {
        ok: false,
        outcome: 'rejected',
        reasons: ['task_content_not_migrated'],
      },
    );
    const content = sealedIntent();
    assert.deepEqual(
      retention(db, {
        kind: 'task.resolve_unmigrated',
        task_id: 'task-a',
        resolution: 'replace',
        content,
        now: 2000,
      }),
      {
        ok: true,
        value: {
          task_id: 'task-a',
          resolution: 'replace',
          blob_id: content.blob_id,
        },
      },
    );
    assert.equal(
      db
        .prepare("SELECT content_blob_id FROM tasks WHERE task_id = 'task-a'")
        .pluck()
        .get(),
      content.blob_id,
    );
    assert.deepEqual(
      db
        .prepare(
          'SELECT purpose, owner_table, owner_id, owner_version FROM sealed_blobs WHERE blob_id = ?',
        )
        .get(content.blob_id),
      {
        purpose: 'task_content',
        owner_table: 'tasks',
        owner_id: 'task-a',
        owner_version: 0,
      },
    );
    assert.deepEqual(
      retention(db, {
        kind: 'retention.erase_body',
        operation_id: opA,
        now: eraseAt,
      }),
      { ok: true, value: { operation_id: opA, erased_versions: 1 } },
    );
    // 2 回目・移せた用事への決着は拒否。
    const again = retention(db, {
      kind: 'task.resolve_unmigrated',
      task_id: 'task-a',
      resolution: 'discard',
      content: null,
      now: 3000,
    });
    assert.deepEqual(again, {
      ok: false,
      outcome: 'rejected',
      reasons: ['task_content_already_linked'],
    });
    // 手放す決着: 用事を消す（書き込み済みで結び付けていない暗号文も消す）。
    legacyTask(db, 'task-b', OP_RET);
    const staged = sealedIntent();
    assert.equal(
      retention(db, {
        kind: 'task.stage_content',
        task_id: 'task-b',
        content: staged,
        now: 2500,
      }).ok,
      true,
    );
    assert.deepEqual(
      retention(db, {
        kind: 'task.resolve_unmigrated',
        task_id: 'task-b',
        resolution: 'discard',
        content: null,
        now: 3000,
      }),
      {
        ok: true,
        value: { task_id: 'task-b', resolution: 'discard', blob_id: null },
      },
    );
    assert.equal(
      count(db, "SELECT count(*) FROM tasks WHERE task_id = 'task-b'"),
      0,
    );
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM sealed_blobs WHERE blob_id = ?',
        staged.blob_id,
      ),
      0,
    );
    assert.deepEqual(
      retention(db, { kind: 'task.unmigrated_list', limit: 10, after: null }),
      {
        ok: true,
        value: { items: [], next: null },
      },
    );
    // 形の検査: 入れ直しに中身がない・手放すのに中身がある。
    assert.deepEqual(
      retention(db, {
        kind: 'task.resolve_unmigrated',
        task_id: 'task-a',
        resolution: 'replace',
        content: null,
        now: 1,
      }),
      { ok: false, outcome: 'rejected', reasons: ['content_invalid'] },
    );
  });
});
