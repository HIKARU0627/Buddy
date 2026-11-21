// 気づき（候補）の保守（B11-04 P3、ADR 0120）。期待値は手で書く。基準は 2030-10-09T03:00:00Z（日本時間 12:00）。
// 期限切れ・スヌーズの終わり・根拠の再確認・保持の掃除を、実際の DB の候補の保存と結んで確かめる。
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Deadline } from '@buddy/contracts';
import {
  applyMigrations,
  executeCandidateOp,
  openWriteConnection,
} from '@buddy/storage';
import type {
  CandidateOp,
  CandidateOpValues,
  DataKeyMaterial,
  SqliteDatabase,
} from '@buddy/storage';
import { persistCandidateDrafts } from './candidate-intake.js';
import type {
  CandidateDraft,
  CandidatePersistPorts,
} from './candidate-intake.js';
import { runCandidateMaintenance } from './candidate-maintenance.js';
import type { CandidateCheck } from './candidate-maintenance.js';

const ZONE = 'Asia/Tokyo';
const NOW = '2030-10-09T03:00:00Z';
const KEY: DataKeyMaterial = { keyId: 'k-test', key: randomBytes(32) };
const ACCOUNT = 'a2000000-0000-4000-8000-000000000001';

const dateOnly = (date: string): Deadline => ({
  kind: 'date',
  date,
  original_text: '期限',
});

let counter = 0;
const nextEntity = (): string => {
  counter += 1;
  return `b1000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};

function draft(
  entity: string,
  over: Partial<CandidateDraft> & { deadline?: Deadline } = {},
): CandidateDraft {
  const deadline = over.deadline ?? dateOnly('2030-10-20');
  return {
    candidate_kind: 'mail_reply',
    key_parts: {
      kind: 'mail_reply',
      source_account_id: ACCOUNT,
      request_entity_id: entity,
      request_revision: '1',
      due: deadline,
    },
    title: '返信の依頼',
    deadline,
    excerpt: '引用',
    request_entity_id: entity,
    request_revision: '1',
    source_revision: 'rev-1',
    initial_import: false,
    unread_partial: false,
    related_analysis: null,
    received_at: '2030-10-01T00:00:00Z',
    origins: [{ source_kind: 'source_item', source_id: 'msg-1' }],
    ...over,
  };
}

interface World {
  readonly db: SqliteDatabase;
  readonly ports: CandidatePersistPorts;
  readonly setClock: (iso: string) => void;
  readonly client: CandidatePersistPorts['client'];
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-candidate-maintenance-'));
  const db = openWriteConnection(join(dir, 'buddy.sqlite'), {
    platform: 'macos',
  });
  try {
    applyMigrations(db);
    db.exec(
      "INSERT INTO connections VALUES ('c-1', 'google', NULL, 'keystore:c-1', 'active', 'read_write', '[]', '{}', 1, 1)",
    );
    db.prepare(
      "INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_generation, executor_generation) VALUES ('sc-1', 'c-1', 0, 0, 0)",
    ).run();
    db.prepare(
      "INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id, published_generation, fetched_at, body_blob_id) VALUES ('google', 'acct-1', 'msg-1', 'rev-1', 'sc-1', 0, 1000, NULL)",
    ).run();
    let clock = '2030-10-01T00:00:00Z';
    const client = {
      candidate: (async (op: CandidateOp) =>
        executeCandidateOp(db, op, { platform: 'macos', halted: false })
          .result) as never,
    } as CandidatePersistPorts['client'];
    const ports: CandidatePersistPorts = {
      client,
      dataKey: KEY,
      sha256Hex: (material) =>
        createHash('sha256').update(material).digest('hex'),
      newId: randomUUID,
      now: () => clock,
    };
    await body({
      db,
      ports,
      client,
      setClock: (iso) => {
        clock = iso;
      },
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function create(
  world: World,
  entity: string,
  d: CandidateDraft,
): Promise<string> {
  world.db
    .prepare(
      "INSERT OR IGNORE INTO request_entities (request_entity_id, source_account_id, thread_id, origin_message_id, request_revision, state, recreation_suppressed, summary_blob_id, created_at, delete_at) VALUES (?, ?, 'thread-1', 'msg-1', 1, 'active', 0, NULL, 1000, NULL)",
    )
    .run(entity, ACCOUNT);
  const [saved] = await persistCandidateDrafts(world.ports, [d]);
  assert.equal(saved?.outcome, 'created');
  return saved?.outcome === 'created' ? saved.candidate_id : '';
}

async function move(
  world: World,
  id: string,
  event: string,
  expected: string,
  now: string,
  snoozeUntil: string | null = null,
): Promise<void> {
  const out = await world.client.candidate({
    kind: 'candidate.transition',
    input: {
      candidate_id: id,
      event: event as never,
      expected_state: expected as never,
      zone: ZONE,
      snooze_until: snoozeUntil,
      now,
    },
  });
  assert.equal(out.ok, true, JSON.stringify(out));
}

const stateOf = (db: SqliteDatabase, id: string): string | undefined =>
  (
    db
      .prepare(
        'SELECT state FROM notification_candidates WHERE candidate_id = ?',
      )
      .get(id) as { state: string } | undefined
  )?.state;

test('a run resolves passed deadlines, wakes finished snoozes and leaves everything else alone', async () => {
  await withWorld(async (world) => {
    const entities = Array.from({ length: 4 }, nextEntity);
    const passed = await create(
      world,
      entities[0] as string,
      draft(entities[0] as string, { deadline: dateOnly('2030-10-08') }),
    );
    const future = await create(
      world,
      entities[1] as string,
      draft(entities[1] as string, { deadline: dateOnly('2030-10-20') }),
    );
    const today = await create(
      world,
      entities[2] as string,
      draft(entities[2] as string, { deadline: dateOnly('2030-10-09') }),
    );
    // 初回取り込みで、作った時にすでに過ぎていた期限は、時計では解決しない。
    const stale = await create(
      world,
      entities[3] as string,
      draft(entities[3] as string, {
        deadline: dateOnly('2030-09-01'),
        initial_import: true,
      }),
    );
    const snoozedEntity = nextEntity();
    const woken = await create(
      world,
      snoozedEntity,
      draft(snoozedEntity, { deadline: dateOnly('2030-10-20') }),
    );
    await move(
      world,
      woken,
      'snooze',
      'new',
      '2030-10-02T00:00:00Z',
      '2030-10-09T02:00:00Z',
    );
    const sleepingEntity = nextEntity();
    const sleeping = await create(
      world,
      sleepingEntity,
      draft(sleepingEntity, { deadline: dateOnly('2030-10-20') }),
    );
    await move(
      world,
      sleeping,
      'snooze',
      'new',
      '2030-10-02T00:00:00Z',
      '2030-10-09T03:00:01Z',
    );

    const report = await runCandidateMaintenance({
      client: world.client,
      zone: ZONE,
      now: () => NOW,
    });
    assert.deepEqual(report.deadline_passed, [passed]);
    assert.deepEqual(report.snooze_elapsed, [woken]);
    assert.deepEqual(report.evidence_resolved, []);
    assert.deepEqual(report.skipped, []);
    assert.equal(report.truncated, false);
    assert.equal(stateOf(world.db, passed), 'resolved');
    assert.equal(stateOf(world.db, woken), 'new');
    assert.equal(stateOf(world.db, sleeping), 'snoozed');
    for (const id of [future, today, stale])
      assert.equal(stateOf(world.db, id), 'new');
    // 同じ時刻でもう一度回しても、何も変わらない。
    const again = await runCandidateMaintenance({
      client: world.client,
      zone: ZONE,
      now: () => NOW,
    });
    assert.deepEqual(
      [
        again.deadline_passed,
        again.snooze_elapsed,
        again.evidence_resolved,
        again.skipped,
      ],
      [[], [], [], []],
    );
    // 日付だけの期限 2030-10-09 は、日本時間の 10-10 0 時（= 15:00:00Z）で過ぎる。
    const evening = await runCandidateMaintenance({
      client: world.client,
      zone: ZONE,
      now: () => '2030-10-09T15:00:00Z',
    });
    assert.deepEqual(evening.deadline_passed, [today]);
    // スヌーズの時刻が来たものも、その後の回で new に戻る。
    assert.deepEqual(evening.snooze_elapsed, [sleeping]);
  });
});

test('the evidence check resolves what left scope or no longer overlaps, and only reports what it cannot confirm', async () => {
  await withWorld(async (world) => {
    const make = async (
      over: Partial<CandidateDraft> = {},
    ): Promise<string> => {
      const entity = nextEntity();
      return create(world, entity, draft(entity, over));
    };
    const outOfScope = await make();
    const removed = await make();
    const valid = await make();
    const revised = await make();
    const unavailable = await make();
    const forgotten = await make();
    const throws = await make();
    const passedFirst = await make({ deadline: dateOnly('2030-10-08') });
    const overlapEntity = nextEntity();
    const overlap = await create(
      world,
      overlapEntity,
      draft(overlapEntity, {
        candidate_kind: 'mail_deadline',
      }),
    );
    const dismissed = await make();
    await move(world, dismissed, 'dismiss', 'new', '2030-10-02T00:00:00Z');
    const checked: string[] = [];
    const answers = new Map<string, CandidateCheck | 'throw'>([
      [outOfScope, 'out_of_scope'],
      [removed, 'removed'],
      [valid, 'available'],
      [revised, 'revised'],
      [unavailable, 'temporarily_unavailable'],
      [forgotten, 'forgotten'],
      [throws, 'throw'],
      [overlap, 'overlap_resolved'],
    ]);
    const report = await runCandidateMaintenance({
      client: world.client,
      zone: ZONE,
      now: () => NOW,
      checkEvidence: async (row) => {
        checked.push(row.candidate_id);
        const answer = answers.get(row.candidate_id);
        if (answer === 'throw') throw new Error('network');
        return answer ?? 'available';
      },
    });
    assert.deepEqual(
      [...report.evidence_resolved].sort(),
      [outOfScope, overlap, removed].sort(),
    );
    assert.deepEqual(
      [...report.evidence_standing].sort((a, b) =>
        a.candidate_id.localeCompare(b.candidate_id),
      ),
      [
        { candidate_id: revised, evidence: 'refresh_required' as const },
        { candidate_id: unavailable, evidence: 'unconfirmed' as const },
        { candidate_id: forgotten, evidence: 'gone' as const },
        { candidate_id: throws, evidence: 'unconfirmed' as const },
      ].sort((a, b) => a.candidate_id.localeCompare(b.candidate_id)),
    );
    assert.deepEqual(report.purge_requested, [forgotten]);
    for (const id of [outOfScope, removed, overlap])
      assert.equal(stateOf(world.db, id), 'resolved');
    // 状態を変えないもの: 有効・新しい版・取り直せない・忘却（物理削除は忘却の計画）・読み取りの失敗。
    for (const id of [valid, revised, unavailable, forgotten, throws])
      assert.equal(stateOf(world.db, id), 'new');
    // 期限切れで先に解決した候補と、閉じた候補は、根拠を取り直さない。
    assert.equal(stateOf(world.db, passedFirst), 'resolved');
    assert.ok(!checked.includes(passedFirst));
    assert.ok(!checked.includes(dismissed));
    assert.deepEqual(report.deadline_passed, [passedFirst]);
  });
});

test('closed candidates lose their sealed content at 7 days and their row at 97 days', async () => {
  await withWorld(async (world) => {
    const eight = nextEntity();
    const young = nextEntity();
    const old = nextEntity();
    // 閉じた時刻: 8 日前（内容を消す）、1 日前（残す）、130 日前（行ごと消す）。
    world.setClock('2030-06-01T00:00:00Z');
    const oldId = await create(world, old, draft(old));
    await move(world, oldId, 'dismiss', 'new', '2030-06-01T01:00:00Z');
    world.setClock('2030-10-01T00:00:00Z');
    const eightId = await create(world, eight, draft(eight));
    await move(world, eightId, 'resolve', 'new', '2030-10-01T01:00:00Z');
    world.setClock('2030-10-08T00:00:00Z');
    const youngId = await create(world, young, draft(young));
    await move(world, youngId, 'dismiss', 'new', '2030-10-08T01:00:00Z');
    const report = await runCandidateMaintenance({
      client: world.client,
      zone: ZONE,
      now: () => NOW,
    });
    assert.deepEqual(report.swept, {
      content_deleted: [eightId],
      deleted: [oldId],
    });
    assert.equal(stateOf(world.db, oldId), undefined);
    assert.equal(stateOf(world.db, eightId), 'resolved');
    const row = world.db
      .prepare(
        'SELECT title_blob_id, excerpt_blob_id, content_deleted_at FROM notification_candidates WHERE candidate_id = ?',
      )
      .get(eightId) as Record<string, unknown>;
    assert.equal(row['title_blob_id'], null);
    assert.equal(row['excerpt_blob_id'], null);
    assert.equal(row['content_deleted_at'], Date.parse(NOW));
    assert.notEqual(
      (
        world.db
          .prepare(
            'SELECT title_blob_id FROM notification_candidates WHERE candidate_id = ?',
          )
          .get(youngId) as Record<string, unknown>
      )['title_blob_id'],
      null,
    );
  });
});

test('a failed list is reported and the sweep still runs; a failed write is reported without stopping the others', async () => {
  await withWorld(async (world) => {
    const entity = nextEntity();
    const id = await create(
      world,
      entity,
      draft(entity, { deadline: dateOnly('2030-10-08') }),
    );
    const other = nextEntity();
    const second = await create(
      world,
      other,
      draft(other, { deadline: dateOnly('2030-10-08') }),
    );
    // 一覧だけ失敗する DB worker。
    const failingList = {
      candidate: (async (op: CandidateOp) =>
        op.kind === 'candidate.list'
          ? { ok: false, outcome: 'rejected', reasons: ['database_busy'] }
          : executeCandidateOp(world.db, op, {
              platform: 'macos',
              halted: false,
            }).result) as never,
    } as CandidatePersistPorts['client'];
    const down = await runCandidateMaintenance({
      client: failingList,
      zone: ZONE,
      now: () => NOW,
    });
    assert.deepEqual(down.skipped, [
      { candidate_id: null, step: 'list', reasons: ['database_busy'] },
    ]);
    assert.deepEqual(down.deadline_passed, []);
    assert.equal(stateOf(world.db, id), 'new');
    // 最初の遷移だけ「別の経路が先に動かした」状態にして、残りは進める。
    let first = true;
    const racing = {
      candidate: (async (op: CandidateOp) => {
        if (op.kind === 'candidate.transition' && first) {
          first = false;
          // 先に別の経路が却下してしまう。
          executeCandidateOp(
            world.db,
            { ...op, input: { ...op.input, event: 'dismiss', now: NOW } },
            { platform: 'macos', halted: false },
          );
        }
        return executeCandidateOp(world.db, op, {
          platform: 'macos',
          halted: false,
        }).result;
      }) as never,
    } as CandidatePersistPorts['client'];
    const report = await runCandidateMaintenance({
      client: racing,
      zone: ZONE,
      now: () => NOW,
    });
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0]?.step, 'due');
    assert.deepEqual(report.skipped[0]?.reasons, ['state_mismatch']);
    assert.equal(report.deadline_passed.length, 1);
    const states = [id, second].map((x) => stateOf(world.db, x)).sort();
    assert.deepEqual(states, ['dismissed', 'resolved']);
  });
});

test('a clock that cannot be read changes nothing', async () => {
  await withWorld(async (world) => {
    const entity = nextEntity();
    const id = await create(
      world,
      entity,
      draft(entity, { deadline: dateOnly('2030-10-08') }),
    );
    const report = await runCandidateMaintenance({
      client: world.client,
      zone: ZONE,
      now: () => 'soon',
    });
    assert.equal(stateOf(world.db, id), 'new');
    assert.deepEqual(report.deadline_passed, []);
    assert.ok(report.skipped.length >= 1);
    for (const skip of report.skipped) assert.ok(skip.reasons.length > 0);
    const badZone = await runCandidateMaintenance({
      client: world.client,
      zone: 'Not/AZone',
      now: () => NOW,
    });
    assert.equal(stateOf(world.db, id), 'new');
    assert.deepEqual(badZone.deadline_passed, []);
    assert.deepEqual(
      (
        (await world.client.candidate({
          kind: 'candidate.counts',
        })) as unknown as { value: CandidateOpValues['candidate.counts'] }
      ).value.new,
      1,
    );
  });
});

test('a page size of one still reaches an older passed candidate behind a newer live one', async () => {
  await withWorld(async (world) => {
    // 受信が新しい・期限なしの活動中の候補が先頭に残り、古い期限切れの候補が頁の外にある。
    const newer = nextEntity();
    const newerId = await create(
      world,
      newer,
      draft(newer, {
        deadline: { kind: 'none' },
        received_at: '2030-10-05T00:00:00Z',
      }),
    );
    const older = nextEntity();
    const olderId = await create(
      world,
      older,
      draft(older, {
        deadline: dateOnly('2030-10-08'),
        received_at: '2030-10-01T00:00:00Z',
      }),
    );
    const sleepy = nextEntity();
    const sleepyId = await create(
      world,
      sleepy,
      draft(sleepy, { received_at: '2030-09-01T00:00:00Z' }),
    );
    await move(
      world,
      sleepyId,
      'snooze',
      'new',
      '2030-10-02T00:00:00Z',
      '2030-10-09T02:00:00Z',
    );
    const report = await runCandidateMaintenance(
      { client: world.client, zone: ZONE, now: () => NOW },
      { limit: 1 },
    );
    assert.deepEqual(report.deadline_passed, [olderId]);
    assert.deepEqual(report.snooze_elapsed, [sleepyId]);
    assert.equal(report.truncated, false);
    assert.equal(stateOf(world.db, newerId), 'new');
    // 頁数の上限で止まったときは truncated と続きの位置で知らせ、同じ上限の反復でも後方へ進む。
    // 先頭の 2 件は期限なしで活動中のまま（上限の 2 頁を使い切る）、3 件目が期限切れ。
    const late = nextEntity();
    const lateId = await create(
      world,
      late,
      draft(late, {
        deadline: dateOnly('2030-10-07'),
        received_at: '2030-08-01T00:00:00Z',
      }),
    );
    const options = { limit: 1, maxPages: 2 } as const;
    // 先頭 2 件（newer と older は前の回で older が解決済みなので、新しい順の先頭は newer と、受信が次に新しい候補）。
    const filler = nextEntity();
    await create(
      world,
      filler,
      draft(filler, {
        deadline: { kind: 'none' },
        received_at: '2030-09-20T00:00:00Z',
      }),
    );
    const first = await runCandidateMaintenance(
      { client: world.client, zone: ZONE, now: () => NOW },
      options,
    );
    assert.equal(first.truncated, true);
    assert.ok(first.resume_after !== null);
    assert.equal(stateOf(world.db, lateId), 'new');
    const second = await runCandidateMaintenance(
      { client: world.client, zone: ZONE, now: () => NOW },
      { ...options, after: first.resume_after ?? undefined },
    );
    // 続きの位置から読むので、同じ上限でも後方の期限切れの候補に届く。
    assert.deepEqual(second.deadline_passed, [lateId]);
    assert.equal(second.truncated, false);
    assert.equal(second.resume_after, null);
  });
});
