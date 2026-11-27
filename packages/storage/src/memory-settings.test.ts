// 保存してよい記憶の種類の設定（マイグレーション 0024）と、本人の明示の依頼の記憶を発言と同じ transaction で保存する経路
// （turn.record の memory、ADR 0191）。worker を介さずに同期で確かめる。期待値（種類・版・理由・行数）は ADR 0191 の決めから
// 手で書いた値で、実装の関数から作っていない。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { executeConversationOp } from './index.js';
import type {
  ConversationOp,
  ConversationOpResult,
  MemoryOp,
  SqliteDatabase,
  TurnMemoryInput,
} from './index.js';
import {
  DK_M,
  DK_OTHER,
  M,
  M_OTHER,
  SETTINGS_REVISION,
  T_OTHER,
  forgetM,
  memoryOp,
  reasons,
  value,
  withWorld,
} from './forget-test-support.js';
import {
  STORE_GENERATION,
  databasePath,
  openSeededDatabase,
  sealedIntent,
  withTempDir,
} from './operation-test-support.js';

const DEVICE = '11111111-1111-4111-8111-111111111111';
const SCOPE = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';

async function withStore(run: (db: SqliteDatabase) => void): Promise<void> {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      db.prepare(
        "INSERT INTO devices VALUES (?, '合成の端末', 'macos', 0, X'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 1000, NULL, NULL)",
      ).run(DEVICE);
      run(db);
    } finally {
      db.close();
    }
  });
}

const conversation = (
  db: SqliteDatabase,
  op: ConversationOp,
): ConversationOpResult =>
  executeConversationOp(db, op, {
    platform: 'macos',
    halted: false,
    storeGeneration: STORE_GENERATION,
  }).result;

const conversationOk = (result: ConversationOpResult) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result.ok ? result.value : null) as unknown as Record<
    string,
    unknown
  >;
};

const conversationRejected = (result: ConversationOpResult) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  return result.ok ? [] : result.reasons;
};

const count = (db: SqliteDatabase, sql: string, ...args: unknown[]): number =>
  db
    .prepare(sql)
    .pluck()
    .get(...args) as number;

const request = (requestId = randomUUID()) => ({
  command_scope_id: SCOPE,
  request_id: requestId,
  request_hash: 'a'.repeat(64),
  command_id: randomUUID(),
});

const memoryOf = (
  overrides: Partial<TurnMemoryInput> = {},
): TurnMemoryInput => ({
  memory_id: randomUUID(),
  memory_kind: 'preference',
  text: sealedIntent(),
  target_key: sealedIntent(),
  target_key_hash: '1a'.repeat(32),
  dedupe_key: '2b'.repeat(32),
  source_hmac: '3c'.repeat(32),
  forgetting_generation: '0',
  settings_revision: '0',
  ...overrides,
});

const turnWith = (
  memory: TurnMemoryInput | undefined,
  options: {
    readonly ref?: ReturnType<typeof request>;
    readonly input?: Extract<ConversationOp, { kind: 'turn.record' }>['input'];
  } = {},
): Extract<ConversationOp, { kind: 'turn.record' }> => ({
  kind: 'turn.record',
  session_id: SESSION,
  turn_id: randomUUID(),
  input_id: randomUUID(),
  text: sealedIntent(),
  created_at: 3_000,
  expires_at: 3_000 + 604_800_000,
  workflow: { workflow_id: randomUUID(), state: 'done' },
  permission_revision: '0',
  request: options.ref ?? request(),
  operation: null,
  response_json: JSON.stringify({ synthetic: 'memory' }),
  ...(options.input === undefined ? {} : { input: options.input }),
  ...(memory === undefined ? {} : { memory }),
});

const setSettings = (
  db: SqliteDatabase,
  expected: string,
  allowed: Extract<MemoryOp, { kind: 'memory.settings_set' }>['allowed_kinds'],
) =>
  memoryOp(db, {
    kind: 'memory.settings_set',
    expected_revision: expected,
    allowed_kinds: allowed,
    now: 5_000,
  });

test('memory settings: empty by default, the revision steps by one, a stale revision is a conflict and unknown kinds are rejected', async () => {
  await withStore((db) => {
    assert.deepEqual(value(memoryOp(db, { kind: 'memory.settings_get' })), {
      allowed_kinds: [],
      settings_revision: '0',
    });
    // 並びは設定の列の順（好み・目標・人・習慣・言葉の使い方・進み具合）。
    assert.deepEqual(value(setSettings(db, '0', ['routine', 'preference'])), {
      allowed_kinds: ['preference', 'routine'],
      settings_revision: '1',
    });
    // 同じ版からの 2 回目（別の画面・再送）は版の食い違い。
    assert.deepEqual(reasons(setSettings(db, '0', ['goal'])), [
      'settings_revision_conflict',
    ]);
    // 同じ値でも版は進む。
    assert.deepEqual(value(setSettings(db, '1', ['preference', 'routine'])), {
      allowed_kinds: ['preference', 'routine'],
      settings_revision: '2',
    });
    assert.deepEqual(value(setSettings(db, '2', [])), {
      allowed_kinds: [],
      settings_revision: '3',
    });
    assert.deepEqual(reasons(setSettings(db, '3', ['secret' as never])), [
      'allowed_kinds_invalid',
    ]);
    assert.deepEqual(reasons(setSettings(db, '3', ['goal', 'goal'])), [
      'allowed_kinds_invalid',
    ]);
    assert.deepEqual(
      reasons(
        memoryOp(db, {
          kind: 'memory.settings_set',
          expected_revision: '3.0',
          allowed_kinds: [],
          now: 5_000,
        }),
      ),
      ['settings_revision_invalid'],
    );
    // 版を飛ばす・戻す書き換えは DB の trigger が拒否する。
    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE memory_settings SET settings_revision = 7 WHERE setting_id = 1',
          )
          .run(),
      /memory_settings_revision_step/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE memory_settings SET goal = 'maybe', settings_revision = 4 WHERE setting_id = 1",
          )
          .run(),
      /CHECK constraint failed/u,
    );
    // 行は作り直さず消さない（版が 0・1 に戻らない。ADR 0191 の見直し）。INSERT OR REPLACE も作る前に拒む。
    for (const sql of [
      "INSERT INTO memory_settings (setting_id, preference, goal, person, routine, lexicon, progress, settings_revision, updated_at) VALUES (1, 'on', 'on', 'on', 'on', 'on', 'on', 1, 9)",
      "INSERT OR REPLACE INTO memory_settings (setting_id, preference, goal, person, routine, lexicon, progress, settings_revision, updated_at) VALUES (1, 'on', 'on', 'on', 'on', 'on', 'on', 1, 9)",
    ])
      assert.throws(() => db.prepare(sql).run(), /memory_settings_no_replace/u);
    assert.throws(
      () => db.prepare('DELETE FROM memory_settings').run(),
      /memory_settings_no_delete/u,
    );
    assert.deepEqual(value(memoryOp(db, { kind: 'memory.settings_get' })), {
      allowed_kinds: [],
      settings_revision: '3',
    });
  });
});

test('memory settings: the first row starts at revision 1 (a direct insert with another revision is refused)', async () => {
  await withStore((db) => {
    for (const revision of [2, 7])
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO memory_settings (setting_id, preference, goal, person, routine, lexicon, progress, settings_revision, updated_at) VALUES (1, 'on', 'off', 'off', 'off', 'off', 'off', ?, 9)",
            )
            .run(revision),
        /memory_settings_insert_first/u,
      );
    assert.deepEqual(value(memoryOp(db, { kind: 'memory.settings_get' })), {
      allowed_kinds: [],
      settings_revision: '0',
    });
  });
});

test('turn.record with a memory: nothing is written while the kind is not allowed, the turn is the only source, and a re-send does not save twice', async () => {
  await withStore((db) => {
    conversationOk(
      conversation(db, {
        kind: 'session.create',
        session_id: SESSION,
        storage_mode: 'normal',
        display_device_id: DEVICE,
        created_at: 2_000,
        request: request(),
      }),
    );
    const turns = () => count(db, 'SELECT count(*) FROM turns');
    const memories = () => count(db, 'SELECT count(*) FROM memories');
    const memoryBlobs = () =>
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'memories'",
      );
    // 既定（何も許可していない）: 発言も記憶も書かない。
    assert.deepEqual(
      conversationRejected(conversation(db, turnWith(memoryOf()))),
      ['memory_rejected', 'kind_not_allowed'],
    );
    assert.deepEqual([turns(), memories(), memoryBlobs()], [0, 0, 0]);
    value(setSettings(db, '0', ['preference']));
    // 処理を始めた後に設定が変わった（始めた時点の版 0、今の版 1）。
    assert.deepEqual(
      conversationRejected(conversation(db, turnWith(memoryOf()))),
      ['memory_rejected', 'permission_changed'],
    );
    // 許可していない種類。
    assert.deepEqual(
      conversationRejected(
        conversation(
          db,
          turnWith(memoryOf({ memory_kind: 'person', settings_revision: '1' })),
        ),
      ),
      ['memory_rejected', 'kind_not_allowed'],
    );
    assert.deepEqual([turns(), memories(), memoryBlobs()], [0, 0, 0]);

    // 許可した種類・今の版: 発言と記憶を同じ transaction で書き、由来はこの発言だけ。
    const ref = request();
    const memoryId = randomUUID();
    const saved = turnWith(
      memoryOf({ memory_id: memoryId, settings_revision: '1' }),
      { ref },
    );
    const first = conversationOk(conversation(db, saved));
    assert.equal(first['replayed'], false);
    assert.deepEqual(
      db
        .prepare(
          'SELECT origin, kind, status, created_at, review_at, delete_at FROM memories WHERE memory_id = ?',
        )
        .get(memoryId),
      {
        origin: 'explicit_request',
        kind: 'preference',
        status: 'active',
        created_at: 3_000,
        // 保存から 90 日（手で計算: 3,000 + 90 × 86,400,000）。
        review_at: 7_776_003_000,
        delete_at: null,
      },
    );
    assert.deepEqual(
      db
        .prepare(
          'SELECT source_kind, source_id FROM memory_sources WHERE memory_id = ?',
        )
        .all(memoryId),
      [{ source_kind: 'turn', source_id: saved.turn_id }],
    );
    assert.deepEqual([turns(), memories(), memoryBlobs()], [1, 1, 2]);

    // 同じ要求の再送（別の記憶 ID を作り直していても）は保存済みの応答を返し、二度保存しない。
    const again = conversationOk(
      conversation(db, turnWith(memoryOf({ settings_revision: '1' }), { ref })),
    );
    assert.equal(again['replayed'], true);
    assert.equal(again['turn_id'], saved.turn_id);
    assert.deepEqual([turns(), memories(), memoryBlobs()], [1, 1, 2]);

    // 別の要求で同じ内容（内容の HMAC が同じ）は二重に保存しない。同じ対象キーで内容が違えば保存しない（U111）。
    assert.deepEqual(
      conversationRejected(
        conversation(db, turnWith(memoryOf({ settings_revision: '1' }))),
      ),
      ['memory_rejected', 'memory_duplicate'],
    );
    assert.deepEqual(
      conversationRejected(
        conversation(
          db,
          turnWith(
            memoryOf({ settings_revision: '1', dedupe_key: '4d'.repeat(32) }),
          ),
        ),
      ),
      ['memory_rejected', 'memory_conflict_review_required'],
    );
    assert.deepEqual([turns(), memories(), memoryBlobs()], [1, 1, 2]);

    // 記憶は文字入力の発言からだけ。Live の文字起こしの暫定入力・操作と一緒には作らない。
    assert.deepEqual(
      conversationRejected(
        conversation(
          db,
          turnWith(
            memoryOf({ settings_revision: '1', dedupe_key: '5e'.repeat(32) }),
            {
              input: {
                kind: 'voice_live',
                audio_epoch: '1',
                outcome: { state: 'sealed', policy_version: '1' },
              },
            },
          ),
        ),
      ),
      ['memory_invalid'],
    );
    assert.deepEqual(
      conversationRejected(
        conversation(db, {
          ...turnWith(memoryOf({ settings_revision: '1' })),
          memory: {
            ...memoryOf({ settings_revision: '1' }),
            dedupe_key: 'not-a-hash',
          },
        }),
      ),
      ['memory_invalid'],
    );
    assert.deepEqual([turns(), memories(), memoryBlobs()], [1, 1, 2]);
  });
});

test('memory.save: the last guard reads the settings in the same transaction (kind not allowed, revision changed)', async () => {
  await withWorld((db) => {
    // 試験の世界は 6 種類とも許可・版 1。目標だけに変える（版 2）。
    assert.deepEqual(value(setSettings(db, SETTINGS_REVISION, ['goal'])), {
      allowed_kinds: ['goal'],
      settings_revision: '2',
    });
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
        target_key_hash: '6f'.repeat(32),
        dedupe_key: '7a'.repeat(32),
        sources: [{ source_kind: 'turn', source_id: T_OTHER }],
        source_hmacs: [
          { source_kind: 'turn', source_id: T_OTHER, hmac: 'b2'.repeat(32) },
        ],
        forgetting_generation: '0',
        settings_revision: '2',
        now: 1_000_000,
        ...overrides,
      });
    assert.deepEqual(reasons(save({ memory_kind: 'preference' })), [
      'kind_not_allowed',
    ]);
    // 自動の抽出も同じ設定を通る。
    assert.deepEqual(
      reasons(save({ origin: 'auto_extraction', memory_kind: 'person' })),
      ['kind_not_allowed'],
    );
    assert.deepEqual(reasons(save({ settings_revision: '1' })), [
      'permission_changed',
    ]);
    const before = count(db, 'SELECT count(*) FROM memories');
    const saved = value<{ readonly status: string }>(save({}));
    assert.equal(saved.status, 'active');
    assert.equal(count(db, 'SELECT count(*) FROM memories'), before + 1);
  });
});

test('memory.admission_facts: the settings, the ledger generation and the live memories are read together', async () => {
  await withWorld((db) => {
    const facts = value<{
      readonly settings: unknown;
      readonly forgetting_generation: string;
      readonly ledger: readonly unknown[];
      readonly existing: readonly {
        readonly memory_id: string;
        readonly kind: string;
        readonly dedupe_key: string;
      }[];
    }>(memoryOp(db, { kind: 'memory.admission_facts' }));
    assert.deepEqual(facts.settings, {
      allowed_kinds: [
        'preference',
        'goal',
        'person',
        'routine',
        'lexicon',
        'progress',
      ],
      settings_revision: '1',
    });
    assert.equal(facts.forgetting_generation, '0');
    assert.deepEqual(facts.ledger, []);
    assert.deepEqual(
      facts.existing
        .map((row) => [row.memory_id, row.kind, row.dedupe_key])
        .filter(([id]) => id === M || id === M_OTHER),
      [
        [M, 'preference', DK_M],
        [M_OTHER, 'preference', DK_OTHER],
      ],
    );
    value(forgetM(db));
    const after = value<{
      readonly forgetting_generation: string;
      readonly ledger: readonly unknown[];
      readonly existing: readonly { readonly memory_id: string }[];
    }>(memoryOp(db, { kind: 'memory.admission_facts' }));
    assert.equal(after.forgetting_generation, '1');
    assert.equal(after.ledger.length, 1);
    assert.deepEqual(
      after.existing.map((row) => row.memory_id),
      [M_OTHER],
    );
  });
});
