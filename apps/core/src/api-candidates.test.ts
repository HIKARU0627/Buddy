// 気づき（候補）の一覧・根拠の再取得・状態の変更の経路（B11-04 P2、ADR 0130）の試験。期待値は手で書く。
// 基準は 2030-10-09T03:00:00Z（日本時間 10 月 9 日 水曜 12:00）。週は月曜始まりなので今週は 10-13（日）まで。
// 実際の DB（マイグレーション済みの SQLite）に P1 の persistCandidateDrafts で種を入れ、経路の処理を直接呼ぶ。
// 経路の検査（端末トークン・自宅判定・接続範囲・ロック・画面操作）は api-route-order.test.ts と契約の api-cases が受け持つ。
// 根拠の取り直しは注入の模擬で、実メール・実 API・実請求は使わない。
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
  CandidateOriginInput,
  CandidateRow,
  DataKeyMaterial,
  SqliteDatabase,
} from '@buddy/storage';
import { createCandidateRoutes } from './api-candidates.js';
import type {
  CandidateEvidenceFetch,
  CandidateRoutesOptions,
} from './api-candidates.js';
import type { ApiRouteHandler } from './api-server.js';
import { persistCandidateDrafts } from './candidate-intake.js';
import type {
  CandidateDraft,
  CandidatePersistPorts,
} from './candidate-intake.js';
import type { JsonObject } from './strict-json.js';

const ZONE = 'Asia/Tokyo';
const NOW = '2030-10-09T03:00:00Z';
const KEY: DataKeyMaterial = { keyId: 'k-test', key: randomBytes(32) };
const ACCOUNT = 'a2000000-0000-4000-8000-000000000001';
const SCOPE = 'c3000000-0000-4000-8000-000000000001';
const MISSING = 'c3000000-0000-4000-8000-0000000000ff';

type Json = Record<string, unknown>;

const dateOnly = (date: string, original = '期限'): Deadline => ({
  kind: 'date',
  date,
  original_text: original,
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
  readonly client: CandidatePersistPorts['client'];
  readonly ports: CandidatePersistPorts;
  readonly routes: (
    over?: Partial<CandidateRoutesOptions>,
  ) => ReturnType<typeof createCandidateRoutes>['handlers'];
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-api-candidates-'));
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
      now: () => '2030-10-01T00:00:00Z',
    };
    await body({
      db,
      client,
      ports,
      routes: (over = {}) =>
        createCandidateRoutes({
          store: client,
          dataKey: async () => KEY,
          zone: () => ZONE,
          now: () => NOW,
          ...over,
        }).handlers,
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function create(world: World, d: CandidateDraft): Promise<string> {
  if (d.request_entity_id !== null)
    world.db
      .prepare(
        "INSERT OR IGNORE INTO request_entities (request_entity_id, source_account_id, thread_id, origin_message_id, request_revision, state, recreation_suppressed, summary_blob_id, created_at, delete_at) VALUES (?, ?, 'thread-1', 'msg-1', 1, 'active', 0, NULL, 1000, NULL)",
      )
      .run(d.request_entity_id, ACCOUNT);
  const [saved] = await persistCandidateDrafts(world.ports, [d]);
  assert.equal(saved?.outcome, 'created', JSON.stringify(saved));
  return saved?.outcome === 'created' ? saved.candidate_id : '';
}

const make = (world: World, over: Partial<CandidateDraft> = {}) => {
  const entity = nextEntity();
  return create(world, draft(entity, over));
};

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

const call = async (
  handler: ApiRouteHandler,
  params: Readonly<Record<string, string>> = {},
  body: JsonObject | null = null,
): Promise<{ status: number; body: Json }> => {
  const response = await handler({
    route: undefined as never,
    device: null,
    body,
    params,
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
  });
  return { status: response.status, body: response.body as Json };
};

const ids = (body: Json): string[] =>
  (body['candidates'] as Json[]).map((item) => item['candidate_id'] as string);

const command = (
  event: string,
  expected: string,
  snoozeUntil: string | null = null,
  requestId = 'd4000000-0000-4000-8000-000000000001',
): JsonObject => ({
  request_id: requestId,
  command_scope_id: SCOPE,
  event,
  expected_state: expected,
  snooze_until: snoozeUntil,
});

test('the list follows the display order: overlaps first today, then nearest deadline, newest received, unknown, initial-import past', async () => {
  await withWorld(async (world) => {
    // 今日の予定の重複（23:00 JST）は、今日のメールの期限（13:00 JST）より遅いが先頭に来る。
    const overlap = await create(world, {
      ...draft(nextEntity(), {
        deadline: {
          kind: 'instant',
          local_datetime: '2030-10-09T23:00',
          zone: ZONE,
          original_text: '23:00',
        },
      }),
      candidate_kind: 'schedule_overlap',
      request_entity_id: null,
      request_revision: null,
      source_revision: null,
      excerpt: null,
    });
    const todayMail = await make(world, {
      deadline: {
        kind: 'instant',
        local_datetime: '2030-10-09T13:00',
        zone: ZONE,
        original_text: '今日の13時まで',
      },
    });
    const tomorrow = await make(world, {
      deadline: dateOnly('2030-10-10'),
    });
    const thisWeek = await make(world, {
      deadline: dateOnly('2030-10-12'),
    });
    const later = await make(world, { deadline: dateOnly('2030-10-20') });
    // 同じ期限（10-25）の 2 件は受信の新しい順。
    const olderReceived = await make(world, {
      deadline: dateOnly('2030-10-25'),
      received_at: '2030-10-03T00:00:00Z',
    });
    const newerReceived = await make(world, {
      deadline: dateOnly('2030-10-25'),
      received_at: '2030-10-05T00:00:00Z',
    });
    const unknown = await make(world, { deadline: { kind: 'none' } });
    const initialPast = await make(world, {
      deadline: dateOnly('2030-09-01'),
      initial_import: true,
    });

    const response = await call(world.routes().listCandidates);
    assert.equal(response.status, 200);
    assert.deepEqual(ids(response.body), [
      overlap,
      todayMail,
      tomorrow,
      thisWeek,
      later,
      newerReceived,
      olderReceived,
      unknown,
      initialPast,
    ]);
    assert.equal(response.body['next_cursor'], null);
    // 並べたときの本人のタイムゾーンと時刻（画面が見出しを分ける。ADR 0132）。
    assert.equal(response.body['zone'], 'Asia/Tokyo');
    assert.equal(response.body['as_of'], '2030-10-09T03:00:00Z');
    assert.deepEqual(response.body['counts'], {
      new: 9,
      seen: 0,
      acted: 0,
      dismissed: 0,
      snoozed: 0,
      resolved: 0,
    });
    // 1 件の形を全部見る。題と期限の原文は封筒から開いて返し、識別子は DB の値のまま。
    const key = (
      world.db
        .prepare(
          'SELECT notification_key FROM notification_candidates WHERE candidate_id = ?',
        )
        .get(todayMail) as { notification_key: string }
    ).notification_key;
    const listed = response.body['candidates'] as Json[];
    const entity = listed[1]?.['request_entity_id'];
    assert.deepEqual(listed[1], {
      candidate_id: todayMail,
      kind: 'mail_reply',
      state: 'new',
      request_entity_id: entity,
      request_revision: '1',
      source_revision: 'rev-1',
      notification_key: key,
      title: '返信の依頼',
      deadline: {
        kind: 'instant',
        local_datetime: '2030-10-09T13:00',
        zone: ZONE,
        original_text: '今日の13時まで',
      },
      initial_import: false,
      unread_partial: false,
      related_analysis: null,
      operation_ids: [],
    });
    assert.match(String(entity), /^b1000000-/u);
    // 期限なしの候補は原文を持たない。
    assert.deepEqual(listed[7]?.['deadline'], { kind: 'none' });
  });
});

test('the list shows only new, seen and acted; snoozed, dismissed and resolved are counted only', async () => {
  await withWorld(async (world) => {
    const fresh = await make(world);
    const seen = await make(world, { received_at: '2030-10-02T00:00:00Z' });
    await move(world, seen, 'open', 'new', '2030-10-02T01:00:00Z');
    const acted = await make(world, { received_at: '2030-10-03T00:00:00Z' });
    await move(world, acted, 'act', 'new', '2030-10-03T01:00:00Z');
    const snoozed = await make(world);
    await move(
      world,
      snoozed,
      'snooze',
      'new',
      '2030-10-02T00:00:00Z',
      '2030-10-20T00:00:00Z',
    );
    const dismissed = await make(world);
    await move(world, dismissed, 'dismiss', 'new', '2030-10-02T00:00:00Z');
    const resolved = await make(world);
    await move(world, resolved, 'resolve', 'new', '2030-10-02T00:00:00Z');

    const response = await call(world.routes().listCandidates);
    assert.equal(response.status, 200);
    // 3 件とも期限 10-20（それ以降）。受信の新しい順。
    assert.deepEqual(ids(response.body), [acted, seen, fresh]);
    assert.deepEqual(response.body['counts'], {
      new: 1,
      seen: 1,
      acted: 1,
      dismissed: 1,
      snoozed: 1,
      resolved: 1,
    });
  });
});

test('the list stops at the page cap with an opaque cursor, and fails closed on an unreadable row, a missing key or a missing zone', async () => {
  await withWorld(async (world) => {
    const first = await make(world, { received_at: '2030-10-05T00:00:00Z' });
    const second = await make(world, { received_at: '2030-10-04T00:00:00Z' });
    await make(world, { received_at: '2030-10-03T00:00:00Z' });
    // 1 頁 1 件・2 頁まで: 新しい 2 件を返し、続きの位置は 2 件目（受信 10-04）。
    const capped = await call(
      world.routes({ pageLimit: 1, maxPages: 2 }).listCandidates,
    );
    assert.equal(capped.status, 200);
    assert.deepEqual(ids(capped.body), [first, second]);
    const cursor = String(capped.body['next_cursor']);
    assert.deepEqual(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
      { received_at: Date.UTC(2030, 9, 4), candidate_id: second },
    );
    assert.equal(
      (capped.body['counts'] as Json)['new'],
      3,
      'counts cover every row, not only the returned page',
    );

    // タイムゾーンが決まっていない・鍵が読めない・違う鍵は、一覧全体を 503。
    for (const over of [
      { zone: () => null },
      { dataKey: async () => null },
      {
        dataKey: async () => {
          throw new Error('keychain');
        },
      },
      { dataKey: async () => ({ keyId: 'k-test', key: randomBytes(32) }) },
    ] as Partial<CandidateRoutesOptions>[]) {
      const failed = await call(world.routes(over).listCandidates);
      assert.equal(failed.status, 503);
      assert.equal(failed.body['code'], 'dependency_unavailable');
    }
    // 1 行の題の封筒が開けなければ、その行を黙って落とさず一覧全体を 503。
    // 封筒は不変（sealed_blob_immutable のトリガー）なので、違う鍵で封をした候補で確かめる。
    const wrongEntity = nextEntity();
    world.db
      .prepare(
        "INSERT OR IGNORE INTO request_entities (request_entity_id, source_account_id, thread_id, origin_message_id, request_revision, state, recreation_suppressed, summary_blob_id, created_at, delete_at) VALUES (?, ?, 'thread-1', 'msg-1', 1, 'active', 0, NULL, 1000, NULL)",
      )
      .run(wrongEntity, ACCOUNT);
    const [sealedWrong] = await persistCandidateDrafts(
      {
        ...world.ports,
        dataKey: { keyId: 'k-test', key: randomBytes(32) },
      },
      [draft(wrongEntity)],
    );
    assert.equal(sealedWrong?.outcome, 'created');
    const broken = await call(world.routes().listCandidates);
    assert.equal(broken.status, 503);
    // 候補が無ければ鍵を読まずに空の一覧。
    await withWorld(async (empty) => {
      const none = await call(
        empty.routes({ dataKey: async () => null }).listCandidates,
      );
      assert.equal(none.status, 200);
      assert.deepEqual(none.body, {
        candidates: [],
        counts: {
          new: 0,
          seen: 0,
          acted: 0,
          dismissed: 0,
          snoozed: 0,
          resolved: 0,
        },
        next_cursor: null,
        zone: 'Asia/Tokyo',
        as_of: '2030-10-09T03:00:00Z',
      });
    });
  });
});

// 候補を起点にした方針による自動承認の承認の行（ADR 0148 の 7 列）を直接置く。操作の行の作り方は保存層の試験
// （candidate-operation-link.test.ts）が受け持つので、ここは外部キーを外して承認の行だけを置き、経路の写し方を見る。
function linkApproval(
  db: SqliteDatabase,
  candidateId: string,
  operationId: string,
  approvedAt: number,
): void {
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare(
      "INSERT INTO approvals (approval_id, operation_id, content_version, content_hash, route, device_id, preview_id, policy_version, status, approved_at, candidate_id, request_entity_id, request_revision, related_group_id, analysis_revision, source_set_hash, published_generation) VALUES (?, ?, 1, ?, 'policy_auto', NULL, NULL, 1, 'consumed', ?, ?, ?, 1, 'group-1', 1, ?, 0)",
    ).run(
      randomUUID(),
      operationId,
      'a'.repeat(64),
      approvedAt,
      candidateId,
      nextEntity(),
      'b'.repeat(64),
    );
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

test('operation_ids carry the automatic operations approved from each candidate, in the list and in the re-read snapshot', async () => {
  await withWorld(async (world) => {
    const linked = await make(world, { received_at: '2030-10-02T00:00:00Z' });
    const plain = await make(world);
    const OP_1 = 'e5000000-0000-4000-8000-000000000002';
    const OP_2 = 'e5000000-0000-4000-8000-000000000001';
    // 承認の古い順（OP_1 が先）。ID の順と逆にして、並びが承認の時刻で決まることを見る。
    linkApproval(world.db, linked, OP_1, 1000);
    linkApproval(world.db, linked, OP_2, 2000);
    const routes = world.routes();
    const listed = await call(routes.listCandidates);
    assert.equal(listed.status, 200);
    assert.deepEqual(
      (listed.body['candidates'] as Json[]).map((item) => [
        item['candidate_id'],
        item['operation_ids'],
      ]),
      [
        [linked, [OP_1, OP_2]],
        [plain, []],
      ],
    );
    const opened = await call(
      routes.changeCandidateState,
      { candidate_id: linked },
      command('open', 'new'),
    );
    assert.equal(opened.status, 200);
    assert.deepEqual(opened.body['operation_ids'], [OP_1, OP_2]);
  });
});

test('state changes by the person move one step and return the re-read snapshot', async () => {
  await withWorld(async (world) => {
    const routes = world.routes();
    const id = await make(world);
    const opened = await call(
      routes.changeCandidateState,
      { candidate_id: id },
      command('open', 'new'),
    );
    assert.equal(opened.status, 200);
    assert.equal(opened.body['state'], 'seen');
    assert.equal(opened.body['candidate_id'], id);
    assert.equal(opened.body['title'], '返信の依頼');
    assert.equal(stateOf(world.db, id), 'seen');
    const dismissed = await call(
      routes.changeCandidateState,
      { candidate_id: id },
      command('dismiss', 'seen'),
    );
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.body['state'], 'dismissed');
    assert.equal(stateOf(world.db, id), 'dismissed');

    const sleepy = await make(world);
    const snoozed = await call(
      routes.changeCandidateState,
      { candidate_id: sleepy },
      command('snooze', 'new', '2030-10-10T00:00:00Z'),
    );
    assert.equal(snoozed.status, 200);
    assert.equal(snoozed.body['state'], 'snoozed');
    const row = world.db
      .prepare(
        'SELECT state, snooze_until FROM notification_candidates WHERE candidate_id = ?',
      )
      .get(sleepy) as { state: string; snooze_until: number };
    assert.deepEqual(row, {
      state: 'snoozed',
      snooze_until: Date.UTC(2030, 9, 10),
    });
    const resolved = await call(
      routes.changeCandidateState,
      { candidate_id: sleepy },
      command('resolve', 'snoozed'),
    );
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body['state'], 'resolved');
    assert.equal(stateOf(world.db, sleepy), 'resolved');
  });
});

test('state changes that conflict are 409, bad input is 422, and an unknown zone or outcome is 503', async () => {
  await withWorld(async (world) => {
    const routes = world.routes();
    const requestId = 'd4000000-0000-4000-8000-0000000000aa';
    const expectError = async (
      id: string,
      body: JsonObject,
      status: number,
      code: string,
      handlers = routes,
    ): Promise<void> => {
      const response = await call(
        handlers.changeCandidateState,
        { candidate_id: id },
        body,
      );
      assert.deepEqual(
        [response.status, response.body['code'], response.body['request_id']],
        [status, code, body['request_id']],
        JSON.stringify(body),
      );
    };
    // 終端（dismissed）への dismiss。
    const closed = await make(world);
    await move(world, closed, 'dismiss', 'new', '2030-10-02T00:00:00Z');
    await expectError(
      closed,
      command('dismiss', 'dismissed', null, requestId),
      409,
      'conflict',
    );
    // acted への act。
    const acted = await make(world);
    await move(world, acted, 'act', 'new', '2030-10-02T00:00:00Z');
    await expectError(
      acted,
      command('act', 'acted', null, requestId),
      409,
      'conflict',
    );
    // 古い画面（expected_state が今と違う）。
    const fresh = await make(world);
    await expectError(
      fresh,
      command('open', 'seen', null, requestId),
      409,
      'conflict',
    );
    assert.equal(stateOf(world.db, fresh), 'new');
    // スヌーズの時刻が過去・いまちょうど。
    await expectError(
      fresh,
      command('snooze', 'new', '2030-10-09T02:00:00Z', requestId),
      422,
      'invalid_input',
    );
    await expectError(
      fresh,
      command('snooze', 'new', NOW, requestId),
      422,
      'invalid_input',
    );
    // snooze の時刻が無い・snooze 以外に時刻がある。
    await expectError(
      fresh,
      command('snooze', 'new', null, requestId),
      422,
      'invalid_input',
    );
    await expectError(
      fresh,
      command('dismiss', 'new', '2030-10-10T00:00:00Z', requestId),
      422,
      'invalid_input',
    );
    // 時計・観測の遷移は本人の操作として受け付けない。
    await expectError(
      fresh,
      command('deadline_passed', 'new', null, requestId),
      422,
      'invalid_input',
    );
    assert.equal(stateOf(world.db, fresh), 'new');
    // 無い候補。
    await expectError(
      MISSING,
      command('open', 'new', null, requestId),
      422,
      'invalid_input',
    );
    // 本人のタイムゾーンが決まっていない。
    await expectError(
      fresh,
      command('open', 'new', null, requestId),
      503,
      'dependency_unavailable',
      world.routes({ zone: () => null }),
    );
    // 書込みの成否不明は、成功にも競合にも見せない。
    const uncertain = world.routes({
      store: {
        candidate: (async (op: CandidateOp) =>
          op.kind === 'candidate.transition'
            ? { ok: false, outcome: 'unknown', reasons: ['commit_failed'] }
            : executeCandidateOp(world.db, op, {
                platform: 'macos',
                halted: false,
              }).result) as never,
      },
    });
    await expectError(
      fresh,
      command('open', 'new', null, requestId),
      503,
      'dependency_unavailable',
      uncertain,
    );
    assert.equal(stateOf(world.db, fresh), 'new');
  });
});

test('evidence is returned only while valid; other observations change or keep the state and answer 409 or 503', async () => {
  await withWorld(async (world) => {
    const LONG_BODY = '本文の全体'.repeat(200);
    const answers = new Map<string, CandidateEvidenceFetch | 'throw'>();
    const seenOrigins: (readonly CandidateOriginInput[])[] = [];
    const routes = world.routes({
      fetchEvidence: async (
        row: CandidateRow,
        origins: readonly CandidateOriginInput[],
      ) => {
        seenOrigins.push(origins);
        const answer = answers.get(row.candidate_id);
        if (answer === undefined || answer === 'throw')
          throw new Error('network');
        return answer;
      },
    });
    const evidence = (id: string) =>
      call(
        routes.getCandidateEvidence,
        { candidate_id: id },
        {
          request_id: 'd4000000-0000-4000-8000-0000000000bb',
          command_scope_id: SCOPE,
        },
      );
    const valid = await make(world);
    // 取り直した元情報は本文全体を持つが、応答は根拠の位置と保存済みの抄録だけ。
    answers.set(valid, {
      observation: 'available',
      sources: [
        {
          source_id: 'msg-1',
          source_revision: 'rev-1',
          quote: '引用',
          start: 0,
          end: 2,
        },
      ],
      unread: false,
    });
    const ok = await evidence(valid);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, {
      candidate_id: valid,
      request_entity_id: ok.body['request_entity_id'],
      request_revision: '1',
      sources: [
        {
          source_id: 'msg-1',
          source_revision: 'rev-1',
          quote: '引用',
          start: 0,
          end: 2,
        },
      ],
      unread: false,
      excerpt: '引用',
    });
    assert.ok(!JSON.stringify(ok.body).includes(LONG_BODY.slice(0, 10)));
    assert.deepEqual(seenOrigins[0], [
      { source_kind: 'source_item', source_id: 'msg-1' },
    ]);
    assert.equal(stateOf(world.db, valid), 'new');

    const cases: readonly {
      readonly answer: CandidateEvidenceFetch | 'throw';
      readonly status: number;
      readonly code: string;
      readonly state: string;
    }[] = [
      // 新しい版: 状態は変えず、読み直させる。
      {
        answer: { observation: 'revised' },
        status: 409,
        code: 'conflict',
        state: 'new',
      },
      // 取り直せない・読み取りの失敗: 保留。状態を変えない。
      {
        answer: { observation: 'temporarily_unavailable' },
        status: 503,
        code: 'dependency_unavailable',
        state: 'new',
      },
      {
        answer: 'throw',
        status: 503,
        code: 'dependency_unavailable',
        state: 'new',
      },
      // 取得範囲外・削除・重複の解消: resolved にして読み直させる。
      {
        answer: { observation: 'out_of_scope' },
        status: 409,
        code: 'conflict',
        state: 'resolved',
      },
      {
        answer: { observation: 'removed' },
        status: 409,
        code: 'conflict',
        state: 'resolved',
      },
      {
        answer: { observation: 'overlap_resolved' },
        status: 409,
        code: 'conflict',
        state: 'resolved',
      },
      // 忘却: 物理削除は忘却の計画の仕事。ここでは状態を変えず、行も消さない。
      {
        answer: { observation: 'forgotten' },
        status: 409,
        code: 'conflict',
        state: 'new',
      },
      // 有効と言いながら根拠の位置の一覧が無い・上限（8）を超えるポートの答えは使わない。
      {
        answer: { observation: 'available', unread: false },
        status: 503,
        code: 'dependency_unavailable',
        state: 'new',
      },
      {
        answer: {
          observation: 'available',
          unread: false,
          sources: Array.from({ length: 9 }, (_, index) => ({
            source_id: `msg-${String(index)}`,
            source_revision: 'rev-1',
            quote: '引用',
            start: 0,
            end: 2,
          })),
        },
        status: 503,
        code: 'dependency_unavailable',
        state: 'new',
      },
    ];
    for (const entry of cases) {
      const id = await make(world);
      answers.set(id, entry.answer);
      const response = await evidence(id);
      assert.deepEqual(
        [
          response.status,
          response.body['code'],
          response.body['request_id'],
          stateOf(world.db, id),
        ],
        [
          entry.status,
          entry.code,
          'd4000000-0000-4000-8000-0000000000bb',
          entry.state,
        ],
        JSON.stringify(entry.answer),
      );
    }
    // 無い候補は 422。取り直しの口が無ければ 503。
    assert.equal((await evidence(MISSING)).status, 422);
    const unwired = await call(
      world.routes().getCandidateEvidence,
      { candidate_id: valid },
      {
        request_id: 'd4000000-0000-4000-8000-0000000000bb',
        command_scope_id: SCOPE,
      },
    );
    assert.deepEqual(
      [unwired.status, unwired.body['code']],
      [503, 'dependency_unavailable'],
    );
  });
});
