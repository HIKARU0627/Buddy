// 影モードの比較記録の保存（B06-06e、ADR 0092・0110）。
// 期待値は手で書く（実装の同じ関数や定数から作らない）。時刻は UTC の ISO 8601 で手で書く。
// 上限（300 件）・同じ組の再保存（一意）・件数の引き継ぎ・契約に合わない記録の拒否を見る。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  applyMigrations,
  executeIntentShadowOp,
  openWriteConnection,
  type IntentShadowOp,
  type IntentShadowOpValue,
  type IntentShadowRecordInput,
  type SqliteDatabase,
} from './index.js';
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
): string {
  const out = run(db, { kind: 'intent_shadow.save', record: input, limit });
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
    const db = openSeededDatabase(databasePath(dir));
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
    const db = openSeededDatabase(databasePath(dir));
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
    const db = openSeededDatabase(databasePath(dir));
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
    const db = openSeededDatabase(databasePath(dir));
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
    const db = openSeededDatabase(databasePath(dir));
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
    const db = openSeededDatabase(databasePath(dir));
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
    const db = openSeededDatabase(databasePath(dir));
    try {
      for (const limit of [0, 301, 1.5]) {
        const out = run(db, {
          kind: 'intent_shadow.save',
          record: record(),
          limit,
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
    const db = openSeededDatabase(databasePath(dir));
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
    const db = openSeededDatabase(databasePath(dir));
    try {
      assert.equal(save(db, record()), 'saved');
      const blocked = run(
        db,
        {
          kind: 'intent_shadow.save',
          record: record({ record_id: RECORD_2, input_id: INPUT_2 }),
          limit: 300,
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
    const db = openSeededDatabase(databasePath(dir));
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
    const first = openSeededDatabase(path);
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
