// 影モードの比較記録の保存（B06-06e、ADR 0092・0110）。
// 期待値は手で書く（実装の同じ関数や定数から作らない）。時刻は UTC の ISO 8601 で手で書く。
// 上限（300 件）・同じ組の再保存（一意）・件数の引き継ぎ・契約に合わない記録の拒否を見る。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  applyMigrations,
  executeIntentShadowOp,
  executeRetentionOp,
  openWriteConnection,
  type IntentShadowOp,
  type IntentShadowOpValue,
  type IntentShadowRecordInput,
  type SqliteDatabase,
} from './index.js';
import {
  ENTRY_1,
  HMACS,
  LEDGER_ID,
  NOW_1,
  memoryOp,
  planFor,
} from './forget-test-support.js';
import {
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

const CAMPAIGN = 'a1000000-0000-4000-8000-000000000001';
const OTHER_CAMPAIGN = 'a1000000-0000-4000-8000-000000000002';
const INPUT_1 = 'b1000000-0000-4000-8000-000000000001';
const INPUT_2 = 'b1000000-0000-4000-8000-000000000002';
const INPUT_3 = 'b1000000-0000-4000-8000-000000000003';
const RECORD_1 = 'c1000000-0000-4000-8000-000000000001';
const RECORD_2 = 'c1000000-0000-4000-8000-000000000002';
const RECORD_3 = 'c1000000-0000-4000-8000-000000000003';
const PRIMARY_DEPLOYMENT = 'd1000000-0000-4000-8000-000000000001';
const SHADOW_DEPLOYMENT = 'd1000000-0000-4000-8000-000000000002';

const RECORDED_AT = '2031-01-01T00:00:00Z';
// 発言の通常の保存期限（7 日）。比較の記録も同じ時刻にする。
const EXPIRES_AT = '2031-01-08T00:00:00Z';
const RECORDED_MS = 1_924_992_000_000;
const EXPIRES_MS = 1_925_596_800_000;
const SESSION = 'e1000000-0000-4000-8000-000000000001';
const TURN_1 = 'f1000000-0000-4000-8000-000000000001';
const TURN_2 = 'f1000000-0000-4000-8000-000000000002';
const TURN_3 = 'f1000000-0000-4000-8000-000000000003';

function judgment(deployment: string, outcome: string) {
  return {
    deployment_id: deployment,
    outcome,
    intent: outcome === 'ok' ? 'create_task' : null,
    args: outcome === 'ok' ? { title: '牛乳を買う' } : null,
    probability: null,
    latency_ms: outcome === 'ok' ? 120 : null,
  };
}

function record(
  overrides: Partial<IntentShadowRecordInput> = {},
): IntentShadowRecordInput {
  return {
    schema: 'buddy.intent-shadow.v1',
    record_id: RECORD_1,
    campaign_id: CAMPAIGN,
    input_id: INPUT_1,
    request_revision: '1',
    primary: judgment(PRIMARY_DEPLOYMENT, 'ok'),
    shadows: [judgment(SHADOW_DEPLOYMENT, 'ok')],
    recorded_at: RECORDED_AT,
    expires_at: EXPIRES_AT,
    used_for_execution: false,
    ...overrides,
  };
}

function run(
  db: SqliteDatabase,
  op: IntentShadowOp,
  halted = false,
): {
  ok: boolean;
  value?: IntentShadowOpValue;
  reasons?: readonly string[];
  halt: boolean;
} {
  const out = executeIntentShadowOp(db, op, { platform: 'macos', halted });
  return out.result.ok
    ? { ok: true, value: out.result.value, halt: out.halt }
    : { ok: false, reasons: out.result.reasons, halt: out.halt };
}

function save(
  db: SqliteDatabase,
  input: IntentShadowRecordInput,
  limit = 300,
  storageMode = 'normal',
): string {
  const out = run(db, {
    kind: 'intent_shadow.save',
    record: input,
    limit,
    storage_mode: storageMode,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  const value = out.value as { record_id: string; result: string };
  assert.equal(value.record_id, input.record_id);
  return value.result;
}

function count(db: SqliteDatabase, campaignId = CAMPAIGN): number {
  const out = run(db, {
    kind: 'intent_shadow.count',
    campaign_id: campaignId,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  return (out.value as { count: number }).count;
}

// 書込みの前提を置いた DB を開く。会話 1 つ・発言 3 つ（期限は記録と同じ）・入力の版 3 つ。
function openDb(dir: string): SqliteDatabase {
  const db = openSeededDatabase(databasePath(dir));
  db.prepare(
    "INSERT INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES (?, 'normal', 'dev-1', 0, NULL, 1000, NULL)",
  ).run(SESSION);
  const turn = db.prepare(
    "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, ?, 'user', 'text', NULL, ?, ?)",
  );
  const snapshot = db.prepare(
    "INSERT INTO input_snapshots (input_id, request_revision, workflow_id, turn_id, origin, state, seal_reason, input_evidence, policy_version, permission_revision, forgetting_generation, audio_epoch) VALUES (?, ?, NULL, ?, 'typed', 'sealed', 'submitted_text', 'submitted_text', NULL, 0, 0, NULL)",
  );
  for (const [input, turnId] of [
    [INPUT_1, TURN_1],
    [INPUT_2, TURN_2],
    [INPUT_3, TURN_3],
  ] as const) {
    turn.run(turnId, SESSION, RECORDED_MS, EXPIRES_MS);
    snapshot.run(input, 1, turnId);
  }
  // INPUT_1 は訂正で版が 2 になったものもある（同じ入力の別の版）。
  snapshot.run(INPUT_1, 2, TURN_1);
  return db;
}

// 直接行を置く（Core の入口を通さずに件数や上限の状態を作る）。記録の列は判定の JSON だけを置く。
function seedRow(
  db: SqliteDatabase,
  campaignId: string,
  inputId: string,
  revision: number,
): void {
  db.prepare(
    'INSERT INTO intent_shadow (record_id, campaign_id, input_id, request_revision, judgments, recorded_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    randomUUID(),
    campaignId,
    inputId,
    revision,
    '{"schema":"buddy.intent-shadow.v1","primary":null,"shadows":[],"used_for_execution":false}',
    RECORDED_MS,
    EXPIRES_MS,
  );
}

test('保存すると件数が 1 増え、campaign ごとに数える', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      assert.equal(count(db), 0);
      assert.equal(count(db, OTHER_CAMPAIGN), 0);
      assert.equal(save(db, record()), 'saved');
      assert.equal(count(db), 1);
      assert.equal(count(db, OTHER_CAMPAIGN), 0);
    } finally {
      db.close();
    }
  });
});

test('同じ組の再保存は duplicate で行が増えない（record_id が違っても）', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      assert.equal(save(db, record()), 'saved');
      // 同じ record_id の再送。
      assert.equal(save(db, record()), 'duplicate');
      // record_id だけが違う同じ組（campaign, input, revision）。表の一意制約の組で判定する。
      assert.equal(save(db, record({ record_id: RECORD_2 })), 'duplicate');
      assert.equal(count(db), 1);
      // 行は最初の 1 件だけ（record_id を書き換えない）。
      assert.equal(
        db
          .prepare('SELECT record_id FROM intent_shadow')
          .pluck()
          .get() as string,
        RECORD_1,
      );
    } finally {
      db.close();
    }
  });
});

test('発言の版が違えば別の行になる', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      assert.equal(save(db, record()), 'saved');
      assert.equal(
        save(db, record({ record_id: RECORD_2, request_revision: '2' })),
        'saved',
      );
      assert.equal(count(db), 2);
    } finally {
      db.close();
    }
  });
});

test('上限に達すると書かない（limit_reached）', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      // limit 2: 2 件目までは書き、3 件目は書かない。
      assert.equal(save(db, record(), 2), 'saved');
      assert.equal(
        save(db, record({ record_id: RECORD_2, input_id: INPUT_2 }), 2),
        'saved',
      );
      assert.equal(
        save(db, record({ record_id: RECORD_3, input_id: INPUT_3 }), 2),
        'limit_reached',
      );
      assert.equal(count(db), 2);
      // 上限で断った入力の行はない。
      assert.equal(
        db
          .prepare('SELECT count(*) FROM intent_shadow WHERE input_id = ?')
          .pluck()
          .get(INPUT_3) as number,
        0,
      );
    } finally {
      db.close();
    }
  });
});

test('299 件から同時に 2 件保存しても 1 件だけ保存する', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      for (let index = 0; index < 299; index += 1)
        seedRow(db, CAMPAIGN, randomUUID(), 1);
      assert.equal(count(db), 299);
      // 2 つの比較が同じ campaign にほぼ同時に着地する。2 件目は上限で断る。
      const first = save(db, record({ record_id: RECORD_1 }), 300);
      const second = save(
        db,
        record({ record_id: RECORD_2, input_id: INPUT_2 }),
        300,
      );
      assert.deepEqual([first, second], ['saved', 'limit_reached']);
      assert.equal(count(db), 300);
      // すでに上限でも、同じ組の再保存は「上限で書けなかった」ではなく duplicate。
      assert.equal(save(db, record({ record_id: RECORD_1 }), 300), 'duplicate');
      assert.equal(count(db), 300);
    } finally {
      db.close();
    }
  });
});

test('一意制約が表にある（保存側の判定が破れても 2 行にならない）', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      assert.equal(save(db, record()), 'saved');
      assert.throws(
        () => seedRow(db, CAMPAIGN, INPUT_1, 1),
        (error: unknown) =>
          error instanceof Error && error.message.includes('UNIQUE'),
      );
      assert.equal(count(db), 1);
    } finally {
      db.close();
    }
  });
});

test('limit は 1〜300 の外を受けない', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      for (const limit of [0, 301, 1.5]) {
        const out = run(db, {
          kind: 'intent_shadow.save',
          record: record(),
          limit,
          storage_mode: 'normal',
        });
        assert.equal(out.ok, false, `limit=${String(limit)}`);
        assert.deepEqual(out.reasons, ['limit_invalid']);
      }
      assert.equal(count(db), 0);
    } finally {
      db.close();
    }
  });
});

test('契約に合わない記録は書かない', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      const cases: [string, IntentShadowRecordInput][] = [
        // 影の判定を実行に使う記録は作らない（契約の const false）。
        ['used_for_execution', record({ used_for_execution: true })],
        // 期限は記録の時刻より後。
        [
          'expires_at',
          record({ recorded_at: EXPIRES_AT, expires_at: EXPIRES_AT }),
        ],
        ['request_revision', record({ request_revision: '0' })],
        ['request_revision', record({ request_revision: '-1' })],
        ['shadows', record({ shadows: [] })],
        ['input_id', record({ input_id: 'not-a-uuid' })],
        ['record_id', record({ record_id: 'x' })],
        [
          'primary',
          record({
            primary: { ...judgment(PRIMARY_DEPLOYMENT, 'ok'), outcome: 'fine' },
          }),
        ],
        [
          'shadows',
          record({
            shadows: [
              { ...judgment(SHADOW_DEPLOYMENT, 'ok'), deployment_id: 's' },
            ],
          }),
        ],
        ['schema', { ...record(), schema: 'buddy.intent-shadow.v0' as never }],
      ];
      for (const [key, input] of cases) {
        const out = run(db, {
          kind: 'intent_shadow.save',
          record: input,
          limit: 300,
          storage_mode: 'normal',
        });
        assert.equal(out.ok, false, key);
        assert.ok(
          (out.reasons ?? []).some((reason) => reason.startsWith(key)),
          `${key}: ${JSON.stringify(out.reasons)}`,
        );
      }
      assert.equal(count(db), 0);
    } finally {
      db.close();
    }
  });
});

test('書込みを止めた worker は書かないが、件数は読める', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      assert.equal(save(db, record()), 'saved');
      const blocked = run(
        db,
        {
          kind: 'intent_shadow.save',
          record: record({ record_id: RECORD_2, input_id: INPUT_2 }),
          limit: 300,
          storage_mode: 'normal',
        },
        true,
      );
      assert.equal(blocked.ok, false);
      assert.deepEqual(blocked.reasons, ['worker_halted']);
      assert.equal(count(db), 1);
    } finally {
      db.close();
    }
  });
});

test('judgments の列に判定と実行に使わない印を置く', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      assert.equal(
        save(
          db,
          record({
            shadows: [
              judgment(SHADOW_DEPLOYMENT, 'ok'),
              judgment(SHADOW_DEPLOYMENT, 'timeout'),
            ],
          }),
        ),
        'saved',
      );
      const raw = db
        .prepare('SELECT judgments FROM intent_shadow WHERE record_id = ?')
        .pluck()
        .get(RECORD_1) as string;
      const stored = JSON.parse(raw) as {
        schema: string;
        primary: { deployment_id: string; outcome: string };
        shadows: { outcome: string }[];
        used_for_execution: boolean;
      };
      assert.equal(stored.schema, 'buddy.intent-shadow.v1');
      assert.equal(stored.primary.deployment_id, PRIMARY_DEPLOYMENT);
      assert.equal(stored.primary.outcome, 'ok');
      assert.deepEqual(
        stored.shadows.map((item) => item.outcome),
        ['ok', 'timeout'],
      );
      assert.equal(stored.used_for_execution, false);
      // 列は記録の時刻をミリ秒で持つ（発言の期限と同じ時刻）。
      const times = db
        .prepare(
          'SELECT recorded_at, expires_at FROM intent_shadow WHERE record_id = ?',
        )
        .get(RECORD_1) as { recorded_at: number; expires_at: number };
      assert.equal(times.recorded_at, RECORDED_MS);
      assert.equal(times.expires_at, EXPIRES_MS);
    } finally {
      db.close();
    }
  });
});

test('DB を開き直しても件数が引き継がれ、再保存で二重にならない', async () => {
  await withTempDir((dir) => {
    const path = databasePath(dir);
    const first = openDb(dir);
    try {
      assert.equal(save(first, record()), 'saved');
      assert.equal(
        save(first, record({ record_id: RECORD_2, input_id: INPUT_2 })),
        'saved',
      );
    } finally {
      first.close();
    }
    // 同じファイルを開き直す（再起動）。
    const second = openWriteConnection(path, { platform: 'macos' });
    try {
      applyMigrations(second);
      assert.equal(count(second), 2);
      assert.equal(save(second, record()), 'duplicate');
      assert.equal(
        save(second, record({ record_id: RECORD_3, input_id: INPUT_3 })),
        'saved',
      );
      assert.equal(count(second), 3);
    } finally {
      second.close();
    }
  });
});

// --- 書込みの前提（保存側でも Core の判断を信じ切らない） ---

function saveReasons(
  db: SqliteDatabase,
  input: IntentShadowRecordInput,
  storageMode = 'normal',
  limit = 300,
): readonly string[] | null {
  const out = run(db, {
    kind: 'intent_shadow.save',
    record: input,
    limit,
    storage_mode: storageMode,
  });
  return out.ok ? null : (out.reasons ?? []);
}

test('記録しない会話では保存しない', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      assert.deepEqual(saveReasons(db, record(), 'private'), [
        'shadow_not_permitted',
      ]);
      assert.equal(count(db), 0);
      // 知らない保存モードは形の不正として受けない。
      assert.deepEqual(saveReasons(db, record(), 'secret'), [
        'storage_mode_invalid',
      ]);
      assert.equal(count(db), 0);
    } finally {
      db.close();
    }
  });
});

test('入力の版が input_snapshots にないと保存しない', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      // 行のある入力と同じ発言でも、版が違えば別の入力（input_snapshots の主キーは input_id と版）。
      assert.deepEqual(saveReasons(db, record({ request_revision: '9' })), [
        'input_not_found',
      ]);
      assert.deepEqual(saveReasons(db, record({ input_id: randomUUID() })), [
        'input_not_found',
      ]);
      assert.equal(count(db), 0);
    } finally {
      db.close();
    }
  });
});

test('発言に結び付いていない入力は保存しない（忘却の閉包の結合条件）', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      db.prepare(
        'UPDATE input_snapshots SET turn_id = NULL WHERE input_id = ?',
      ).run(INPUT_1);
      assert.deepEqual(saveReasons(db, record()), ['input_not_found']);
      assert.equal(count(db), 0);
    } finally {
      db.close();
    }
  });
});

test('期限が元の発言と違えば保存しない', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      // 保存した発言の期限は 2031-01-08T00:00:00Z。1 ミリ秒でも違えば書かない。
      const oneMsLater = new Date(EXPIRES_MS + 1).toISOString();
      assert.deepEqual(saveReasons(db, record({ expires_at: oneMsLater })), [
        'expiry_mismatch',
      ]);
      const oneDayLater = new Date(EXPIRES_MS + 86_400_000).toISOString();
      assert.deepEqual(saveReasons(db, record({ expires_at: oneDayLater })), [
        'expiry_mismatch',
      ]);
      assert.equal(count(db), 0);
      // 発言の期限と同じなら書ける。
      assert.equal(save(db, record()), 'saved');
    } finally {
      db.close();
    }
  });
});

test('発言を忘れて結び付けが外れた後は、同じ組でも書かない', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      assert.equal(save(db, record()), 'saved');
      // 忘却の適用（forget-store）は発言の行を消し、input_snapshots の turn_id を NULL にする。比較の記録の行も
      // 閉包で消える（forget-subgraph の試験）。ここでは結び付けが外れた後の再保存が通らないことを見る。
      db.prepare(
        'UPDATE input_snapshots SET turn_id = NULL WHERE input_id = ?',
      ).run(INPUT_1);
      db.prepare('DELETE FROM intent_shadow WHERE input_id = ?').run(INPUT_1);
      assert.deepEqual(saveReasons(db, record({ record_id: RECORD_2 })), [
        'input_not_found',
      ]);
      assert.equal(count(db), 0);
    } finally {
      db.close();
    }
  });
});

// --- 期限の掃除と忘却の閉包（既存の経路。書いた行がそのまま消える） ---

function deleteDerived(
  db: SqliteDatabase,
  ids: string[],
  now: number,
): { deleted: string[]; skipped: { id: string; reasons: string[] }[] } {
  const out = executeRetentionOp(
    db,
    { kind: 'retention.delete_expired', family: 'derived', ids, now },
    { platform: 'macos', halted: false },
  );
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  return out.result.value as {
    deleted: string[];
    skipped: { id: string; reasons: string[] }[];
  };
}

test('期限の掃除は expires_at で比較の記録を消す（1 ミリ秒前は残す）', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      assert.equal(save(db, record()), 'saved');
      const row = `intent_shadow:${RECORD_1}`;
      // 期限の 1 ミリ秒前は残す。
      assert.deepEqual(deleteDerived(db, [row], EXPIRES_MS - 1), {
        deleted: [],
        skipped: [{ id: row, reasons: ['not_due'] }],
      });
      assert.equal(count(db), 1);
      // ちょうどで消える。
      assert.deepEqual(deleteDerived(db, [row], EXPIRES_MS), {
        deleted: [row],
        skipped: [],
      });
      assert.equal(count(db), 0);
    } finally {
      db.close();
    }
  });
});

test('発言の忘却で、その発言を入力にした比較の記録も閉包で消える', async () => {
  await withTempDir((dir) => {
    const db = openDb(dir);
    try {
      assert.equal(save(db, record()), 'saved');
      const target = { source_kind: 'turn' as const, source_id: TURN_1 };
      // Core がする手順（系譜を読み、鍵の HMAC で計画を作る）を試験の中で行う。
      const { plan, generation: previous } = planFor(db, target, null);
      const applied = memoryOp(db, {
        kind: 'forget.apply',
        target,
        instruction_turn_id: null,
        plan: plan as never,
        source_hmacs: HMACS,
        entry_id: ENTRY_1,
        previous_generation: previous,
        new_ledger_id: LEDGER_ID,
        now: NOW_1,
      });
      assert.equal(applied.ok, true, JSON.stringify(applied));
      const deleted = (
        applied as { value: { deleted: Record<string, number> } }
      ).value.deleted;
      assert.equal(deleted['intent_shadow'], 1);
      assert.equal(count(db), 0);
      // 発言の行は消え、入力の版は残る（結び付けだけ外れる。忘却の deleteNode と同じ）。
      assert.equal(
        db
          .prepare('SELECT count(*) FROM turns WHERE turn_id = ?')
          .pluck()
          .get(TURN_1) as number,
        0,
      );
      assert.equal(
        db
          .prepare('SELECT turn_id FROM input_snapshots WHERE input_id = ?')
          .pluck()
          .get(INPUT_1),
        null,
      );
    } finally {
      db.close();
    }
  });
});
