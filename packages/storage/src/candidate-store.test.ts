// 気づき（候補）の保存（B11-03、ADR 0073・0118、マイグレーション 0013）。
// 期待値は手で書く（実装の同じ関数や定数から作らない）。時刻は UTC の ISO 8601 とミリ秒を手で数えて書く。
// 作成（重複・由来の最後のガード・形の拒否）、状態の遷移（許す・拒む・古い画面・時計の再確認）、一覧、表の CHECK と
// trigger（閉じた候補・許す遷移・識別の固定）を見る。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { deleteForgetNode, executeCandidateOp } from './index.js';
import type {
  CandidateCreateInput,
  CandidateOp,
  CandidateOpValue,
  CandidateOpValues,
  SqliteDatabase,
} from './index.js';
import { blob, count } from './forget-test-support.js';
import {
  databasePath,
  openSeededDatabase,
  sealedIntent,
  withTempDir,
} from './operation-test-support.js';

// 2031-01-01T00:00:00Z = 1_924_992_000_000 ms。1 日 = 86_400_000 ms、97 日 = 8_380_800_000 ms。
const T0 = '2031-01-01T00:00:00Z';
const T0_MS = 1_924_992_000_000;
const KEY_RETENTION_MS = 8_380_800_000;
const ZONE = 'Asia/Tokyo';

const C1 = 'a1000000-0000-4000-8000-000000000001';
const C2 = 'a1000000-0000-4000-8000-000000000002';
const C3 = 'a1000000-0000-4000-8000-000000000003';
const REQ = 'b1000000-0000-4000-8000-000000000001';
const GROUP = 'b2000000-0000-4000-8000-000000000001';
const TURN = 'c1000000-0000-4000-8000-000000000001';
const SESSION = 'c2000000-0000-4000-8000-000000000001';
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);

function run(
  db: SqliteDatabase,
  op: CandidateOp,
  halted = false,
): {
  ok: boolean;
  value?: CandidateOpValue;
  reasons?: readonly string[];
  halt: boolean;
} {
  const out = executeCandidateOp(db, op, { platform: 'macos', halted });
  return out.result.ok
    ? { ok: true, value: out.result.value, halt: out.halt }
    : { ok: false, reasons: out.result.reasons, halt: out.halt };
}

function insertSourceItem(db: SqliteDatabase, remoteId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO sync_scopes (scope_id, connection_id, scope_revision, active_generation, executor_generation) VALUES ('sc-1', 'c-1', 0, 0, 0)",
  ).run();
  db.prepare(
    "INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id, published_generation, fetched_at, body_blob_id) VALUES ('google', 'acct-1', ?, 'rev-1', 'sc-1', 0, ?, NULL)",
  ).run(remoteId, T0_MS);
}

function insertTurn(db: SqliteDatabase, turnId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES (?, 'normal', 'dev-1', 0, NULL, ?, NULL)",
  ).run(SESSION, T0_MS);
  const text = blob(db, 'turn_text', 'turns', turnId);
  db.prepare(
    "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, ?, 'user', 'text', ?, ?, ?)",
  ).run(turnId, SESSION, text, T0_MS, T0_MS + 7 * 86_400_000);
}

function input(over: Partial<CandidateCreateInput> = {}): CandidateCreateInput {
  return {
    candidate_id: C1,
    candidate_kind: 'mail_reply',
    notification_key: KEY_A,
    request_entity_id: null,
    request_revision: null,
    source_revision: 'rev-1',
    deadline: { kind: 'date', date: '2031-01-10' },
    initial_import: false,
    unread_partial: false,
    related_analysis: null,
    received_at: '2030-12-31T12:00:00Z',
    created_at: T0,
    title: sealedIntent(),
    excerpt: sealedIntent(),
    origins: [{ source_kind: 'source_item', source_id: 'msg-1' }],
    ...over,
  };
}

function create(
  db: SqliteDatabase,
  over: Partial<CandidateCreateInput> = {},
): CandidateOpValues['candidate.create'] {
  const out = run(db, { kind: 'candidate.create', input: input(over) });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.value as CandidateOpValues['candidate.create'];
}

function transition(
  db: SqliteDatabase,
  id: string,
  event: string,
  expected: string,
  now = T0,
  snoozeUntil: string | null = null,
): { ok: boolean; value?: CandidateOpValue; reasons?: readonly string[] } {
  return run(db, {
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
}

function rowOf(db: SqliteDatabase, id: string): Record<string, unknown> {
  return db
    .prepare('SELECT * FROM notification_candidates WHERE candidate_id = ?')
    .get(id) as Record<string, unknown>;
}

async function withDb(
  body: (db: SqliteDatabase) => Promise<void> | void,
): Promise<void> {
  await withTempDir(async (dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      insertSourceItem(db, 'msg-1');
      insertSourceItem(db, 'msg-2');
      insertTurn(db, TURN);
      // 依頼エンティティ（候補の request_entity_id が参照する）。
      db.prepare(
        "INSERT INTO request_entities (request_entity_id, source_account_id, thread_id, origin_message_id, request_revision, state, recreation_suppressed, summary_blob_id, created_at, delete_at) VALUES (?, 'acct-1', 'thread-1', 'msg-1', 3, 'active', 0, NULL, ?, NULL)",
      ).run(REQ, T0_MS);
      await body(db);
    } finally {
      db.close();
    }
  });
}

test('create writes the row, the sealed title and excerpt and one lineage edge per origin', async () => {
  await withDb((db) => {
    const title = sealedIntent();
    const excerpt = sealedIntent();
    const result = create(db, {
      title,
      excerpt,
      candidate_kind: 'mail_deadline',
      request_entity_id: REQ,
      request_revision: '3',
      deadline: {
        kind: 'instant',
        local_datetime: '2031-01-10T17:00',
        zone: ZONE,
      },
      unread_partial: true,
      related_analysis: {
        group_id: GROUP,
        analysis_revision: 2,
        source_set_hash: 'd'.repeat(64),
        published_generation: 5,
      },
      origins: [
        { source_kind: 'source_item', source_id: 'msg-1' },
        { source_kind: 'turn', source_id: TURN },
      ],
    });
    assert.deepEqual(result, { result: 'created', candidate_id: C1 });
    const got = run(db, { kind: 'candidate.get', candidate_id: C1 });
    assert.equal(got.ok, true);
    const row = (got.value as CandidateOpValues['candidate.get']).candidate;
    assert.ok(row !== null);
    assert.equal(row.candidate_kind, 'mail_deadline');
    assert.equal(row.state, 'new');
    assert.equal(row.notification_key, KEY_A);
    assert.equal(row.request_entity_id, REQ);
    assert.equal(row.request_revision, 3);
    assert.equal(row.source_revision, 'rev-1');
    assert.deepEqual(row.deadline, {
      kind: 'instant',
      local_datetime: '2031-01-10T17:00',
      zone: ZONE,
    });
    assert.equal(row.initial_import, false);
    assert.equal(row.unread_partial, true);
    assert.deepEqual(row.related_analysis, {
      group_id: GROUP,
      analysis_revision: 2,
      source_set_hash: 'd'.repeat(64),
      published_generation: 5,
    });
    // 受信は 2030-12-31T12:00Z（作成の 12 時間前）。
    assert.equal(row.received_at, T0_MS - 12 * 3_600_000);
    assert.equal(row.created_at, T0_MS);
    assert.equal(row.state_changed_at, T0_MS);
    assert.equal(row.snooze_until, null);
    assert.equal(row.closed_at, null);
    assert.equal(row.key_delete_at, null);
    assert.equal(row.content_deleted_at, null);
    // 題と抄録は封筒のまま戻る（復号は Core）。
    assert.equal(
      Buffer.from(row.title?.ciphertext ?? []).toString('hex'),
      Buffer.from(title.ciphertext).toString('hex'),
    );
    assert.equal(
      Buffer.from(row.excerpt?.nonce ?? []).toString('hex'),
      Buffer.from(excerpt.nonce).toString('hex'),
    );
    assert.equal(row.title?.key_id, 'k-test');
    // 封筒の所有者・用途。
    const blobs = db
      .prepare(
        "SELECT purpose, owner_table, owner_id, owner_version FROM sealed_blobs WHERE owner_table = 'notification_candidates' ORDER BY purpose",
      )
      .all();
    assert.deepEqual(blobs, [
      {
        purpose: 'candidate_excerpt',
        owner_table: 'notification_candidates',
        owner_id: C1,
        owner_version: 0,
      },
      {
        purpose: 'candidate_title',
        owner_table: 'notification_candidates',
        owner_id: C1,
        owner_version: 0,
      },
    ]);
    // 由来ごとの辺（忘却の閉包・期限の掃除が使う）。
    const edges = db
      .prepare(
        "SELECT source_kind, source_id FROM derivations WHERE artifact_kind = 'notification_candidate' AND artifact_id = ? ORDER BY source_kind",
      )
      .all(C1);
    assert.deepEqual(edges, [
      { source_kind: 'source_item', source_id: 'msg-1' },
      { source_kind: 'turn', source_id: TURN },
    ]);
  });
});

test('each deadline kind is stored in its own columns and read back unchanged', async () => {
  await withDb((db) => {
    const cases: [string, CandidateCreateInput['deadline'], string][] = [
      ['a', { kind: 'date', date: '2031-02-03' }, KEY_A],
      ['b', { kind: 'unresolved', reason: 'relative' }, KEY_B],
      ['c', { kind: 'none' }, KEY_C],
    ];
    const ids = [C1, C2, C3];
    cases.forEach(([, deadline, key], index) => {
      create(db, {
        candidate_id: ids[index] as string,
        notification_key: key,
        deadline,
      });
    });
    ids.forEach((id, index) => {
      const row = (
        run(db, { kind: 'candidate.get', candidate_id: id })
          .value as CandidateOpValues['candidate.get']
      ).candidate;
      assert.deepEqual(row?.deadline, cases[index]?.[1]);
    });
    assert.deepEqual(
      db
        .prepare(
          'SELECT deadline_kind, deadline_local, deadline_zone, deadline_reason FROM notification_candidates ORDER BY candidate_id',
        )
        .all(),
      [
        {
          deadline_kind: 'date',
          deadline_local: '2031-02-03',
          deadline_zone: null,
          deadline_reason: null,
        },
        {
          deadline_kind: 'unresolved',
          deadline_local: null,
          deadline_zone: null,
          deadline_reason: 'relative',
        },
        {
          deadline_kind: 'none',
          deadline_local: null,
          deadline_zone: null,
          deadline_reason: null,
        },
      ],
    );
  });
});

test('the same notification key is never created twice, whatever state the first one is in', async () => {
  await withDb((db) => {
    create(db);
    const blobsBefore = count(db, 'SELECT count(*) FROM sealed_blobs');
    const edgesBefore = count(db, 'SELECT count(*) FROM derivations');
    // new
    assert.deepEqual(create(db, { candidate_id: C2 }), {
      result: 'duplicate',
      candidate_id: C1,
      state: 'new',
    });
    // dismissed（終端でも、識別子が残る間は作らない）
    assert.equal(transition(db, C1, 'dismiss', 'new').ok, true);
    assert.deepEqual(create(db, { candidate_id: C2 }), {
      result: 'duplicate',
      candidate_id: C1,
      state: 'dismissed',
    });
    // 何も書いていない（封筒・辺・行）。
    assert.equal(count(db, 'SELECT count(*) FROM notification_candidates'), 1);
    assert.equal(count(db, 'SELECT count(*) FROM sealed_blobs'), blobsBefore);
    assert.equal(count(db, 'SELECT count(*) FROM derivations'), edgesBefore);
    // 別の識別子なら作れる。
    assert.deepEqual(
      create(db, { candidate_id: C2, notification_key: KEY_B }),
      {
        result: 'created',
        candidate_id: C2,
      },
    );
  });
});

test('a reused candidate id with another key is refused and nothing is written', async () => {
  await withDb((db) => {
    create(db);
    const blobs = count(db, 'SELECT count(*) FROM sealed_blobs');
    const out = run(db, {
      kind: 'candidate.create',
      input: input({ notification_key: KEY_B }),
    });
    assert.deepEqual(out, {
      ok: false,
      reasons: ['candidate_id_exists'],
      halt: false,
    });
    assert.equal(count(db, 'SELECT count(*) FROM sealed_blobs'), blobs);
  });
});

test('a candidate is not created from an origin that is gone, and nothing is written', async () => {
  await withDb((db) => {
    const blobs = count(db, 'SELECT count(*) FROM sealed_blobs');
    for (const origins of [
      [{ source_kind: 'source_item' as const, source_id: 'forgotten-msg' }],
      [{ source_kind: 'turn' as const, source_id: C3 }],
      // 1 つでも無ければ作らない。
      [
        { source_kind: 'source_item' as const, source_id: 'msg-1' },
        { source_kind: 'source_item' as const, source_id: 'forgotten-msg' },
      ],
    ]) {
      const out = run(db, {
        kind: 'candidate.create',
        input: input({ origins }),
      });
      assert.deepEqual(out, {
        ok: false,
        reasons: ['origin_not_found'],
        halt: false,
      });
    }
    assert.equal(count(db, 'SELECT count(*) FROM notification_candidates'), 0);
    assert.equal(count(db, 'SELECT count(*) FROM sealed_blobs'), blobs);
    assert.equal(count(db, 'SELECT count(*) FROM derivations'), 0);
    // 忘れて消えた元情報から、あとで作ろうとしても作れない。
    create(db);
    db.prepare("DELETE FROM source_items WHERE remote_id = 'msg-2'").run();
    const gone = run(db, {
      kind: 'candidate.create',
      input: input({
        candidate_id: C2,
        notification_key: KEY_B,
        origins: [{ source_kind: 'source_item', source_id: 'msg-2' }],
      }),
    });
    assert.deepEqual(gone.reasons, ['origin_not_found']);
  });
});

test('a malformed create is refused before anything is written', async () => {
  await withDb((db) => {
    const bad: [string, Partial<CandidateCreateInput>, string][] = [
      ['candidate id', { candidate_id: 'x' }, 'candidate_id_invalid'],
      ['kind', { candidate_kind: 'other' as never }, 'candidate_kind_invalid'],
      [
        'key too short',
        { notification_key: 'a'.repeat(63) },
        'notification_key_invalid',
      ],
      [
        'key uppercase',
        { notification_key: 'A'.repeat(64) },
        'notification_key_invalid',
      ],
      [
        'request without revision',
        { request_entity_id: REQ },
        'request_revision_invalid',
      ],
      [
        'revision without request',
        { request_revision: '2' },
        'request_revision_invalid',
      ],
      [
        'revision zero',
        { request_entity_id: REQ, request_revision: '0' },
        'request_revision_invalid',
      ],
      [
        'revision leading zero',
        { request_entity_id: REQ, request_revision: '01' },
        'request_revision_invalid',
      ],
      [
        'empty source revision',
        { source_revision: '' },
        'source_revision_invalid',
      ],
      [
        'deadline kind',
        { deadline: { kind: 'x' } as never },
        'deadline_invalid',
      ],
      [
        'instant without zone',
        {
          deadline: {
            kind: 'instant',
            local_datetime: '2031-01-10T17:00',
            zone: 'Not/AZone',
          },
        },
        'deadline_invalid',
      ],
      [
        'instant with offset',
        {
          deadline: {
            kind: 'instant',
            local_datetime: '2031-01-10T17:00+09:00',
            zone: ZONE,
          },
        },
        'deadline_invalid',
      ],
      [
        'date format',
        { deadline: { kind: 'date', date: '2031-1-10' } },
        'deadline_invalid',
      ],
      [
        'unresolved reason',
        { deadline: { kind: 'unresolved', reason: 'guess' } },
        'deadline_invalid',
      ],
      [
        'received not UTC',
        { received_at: '2030-12-31T12:00:00+09:00' },
        'received_at_invalid',
      ],
      [
        'created impossible date',
        { created_at: '2031-02-30T00:00:00Z' },
        'created_at_invalid',
      ],
      ['title missing', { title: null as never }, 'title_invalid'],
      [
        'title nonce short',
        { title: { ...sealedIntent(), nonce: randomBytes(11) } },
        'title_invalid',
      ],
      [
        'excerpt malformed',
        { excerpt: { blob_id: 'x' } as never },
        'excerpt_invalid',
      ],
      [
        'related hash',
        {
          related_analysis: {
            group_id: GROUP,
            analysis_revision: 1,
            source_set_hash: 'x',
            published_generation: 0,
          },
        },
        'related_analysis_invalid',
      ],
      [
        'related revision zero',
        {
          related_analysis: {
            group_id: GROUP,
            analysis_revision: 0,
            source_set_hash: 'd'.repeat(64),
            published_generation: 0,
          },
        },
        'related_analysis_invalid',
      ],
      ['no origins', { origins: [] }, 'origins_invalid'],
      [
        'duplicate origins',
        {
          origins: [
            { source_kind: 'source_item', source_id: 'msg-1' },
            { source_kind: 'source_item', source_id: 'msg-1' },
          ],
        },
        'origins_invalid',
      ],
      [
        'origin kind',
        { origins: [{ source_kind: 'memory' as never, source_id: 'm-1' }] },
        'origins_invalid',
      ],
      [
        'origin id empty',
        { origins: [{ source_kind: 'turn', source_id: '' }] },
        'origins_invalid',
      ],
    ];
    for (const [name, over, reason] of bad) {
      const out = run(db, { kind: 'candidate.create', input: input(over) });
      assert.equal(out.ok, false, name);
      assert.ok(
        out.reasons?.includes(reason),
        `${name}: ${JSON.stringify(out.reasons)}`,
      );
      assert.equal(out.halt, false, name);
    }
    assert.equal(count(db, 'SELECT count(*) FROM notification_candidates'), 0);
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'notification_candidates'",
      ),
      0,
    );
    // 命令の種類の取り違えと null。
    assert.deepEqual(run(db, { kind: 'candidate.x' } as never).reasons, [
      'kind_invalid',
    ]);
    assert.deepEqual(run(db, null as never).reasons, ['kind_invalid']);
  });
});

test('a halted worker writes nothing but still answers reads', async () => {
  await withDb((db) => {
    create(db);
    const halted = run(
      db,
      {
        kind: 'candidate.create',
        input: input({ candidate_id: C2, notification_key: KEY_B }),
      },
      true,
    );
    assert.deepEqual(halted.reasons, ['worker_halted']);
    assert.equal(count(db, 'SELECT count(*) FROM notification_candidates'), 1);
    assert.equal(run(db, { kind: 'candidate.counts' }, true).ok, true);
  });
});

test('the legal transitions are written with their times, and closing sets the 97 day key deadline', async () => {
  await withDb((db) => {
    create(db);
    // new → seen → acted → resolved。時刻は 1 日ずつ進める。
    const day = (n: number): string =>
      new Date(T0_MS + n * 86_400_000).toISOString().replace('.000Z', 'Z');
    assert.deepEqual(transition(db, C1, 'open', 'new', day(1)).value, {
      candidate_id: C1,
      from: 'new',
      to: 'seen',
      state_changed_at: T0_MS + 86_400_000,
    });
    assert.equal(transition(db, C1, 'act', 'seen', day(2)).ok, true);
    // acted は resolve だけを受ける。
    for (const event of ['open', 'dismiss', 'snooze', 'act']) {
      const out = transition(
        db,
        C1,
        event,
        'acted',
        day(3),
        event === 'snooze' ? day(9) : null,
      );
      assert.deepEqual(out.reasons, ['transition_not_allowed'], event);
    }
    assert.equal(transition(db, C1, 'resolve', 'acted', day(3)).ok, true);
    const row = rowOf(db, C1);
    assert.equal(row['state'], 'resolved');
    assert.equal(row['state_changed_at'], T0_MS + 3 * 86_400_000);
    assert.equal(row['closed_at'], T0_MS + 3 * 86_400_000);
    assert.equal(
      row['key_delete_at'],
      T0_MS + 3 * 86_400_000 + KEY_RETENTION_MS,
    );
    assert.equal(row['snooze_until'], null);
  });
});

test('a closed candidate cannot move again, and the key stays the same', async () => {
  await withDb((db) => {
    create(db);
    assert.equal(transition(db, C1, 'dismiss', 'new').ok, true);
    const before = rowOf(db, C1);
    for (const event of [
      'open',
      'act',
      'dismiss',
      'snooze',
      'resolve',
      'snooze_elapsed',
      'deadline_passed',
      'source_out_of_scope',
      'overlap_resolved',
    ]) {
      const out = transition(
        db,
        C1,
        event,
        'dismissed',
        '2031-01-02T00:00:00Z',
        event === 'snooze' ? '2031-02-01T00:00:00Z' : null,
      );
      assert.equal(out.ok, false, event);
      assert.deepEqual(out.reasons, ['transition_not_allowed'], event);
    }
    assert.deepEqual(rowOf(db, C1), before);
  });
});

test('a stale screen cannot overwrite a newer transition', async () => {
  await withDb((db) => {
    create(db);
    assert.equal(
      transition(db, C1, 'open', 'new', '2031-01-01T01:00:00Z').ok,
      true,
    );
    // 画面は new のまま dismiss を送った。今は seen。
    const out = transition(db, C1, 'dismiss', 'new', '2031-01-01T02:00:00Z');
    assert.deepEqual(out.reasons, ['state_mismatch']);
    assert.equal(rowOf(db, C1)['state'], 'seen');
    // 期待の状態が正しければ通る。
    assert.equal(
      transition(db, C1, 'dismiss', 'seen', '2031-01-01T02:00:00Z').ok,
      true,
    );
  });
});

test('unknown candidates, time going backwards and malformed transitions are refused', async () => {
  await withDb((db) => {
    create(db);
    assert.deepEqual(transition(db, C2, 'open', 'new').reasons, [
      'candidate_not_found',
    ]);
    assert.equal(
      transition(db, C1, 'open', 'new', '2031-01-01T05:00:00Z').ok,
      true,
    );
    // 状態を変えた時刻より前の時計は拒む。
    assert.deepEqual(
      transition(db, C1, 'act', 'seen', '2031-01-01T04:59:59Z').reasons,
      ['time_backwards'],
    );
    const malformed: [Record<string, unknown>, string][] = [
      [{ event: 'launch' }, 'event_invalid'],
      [{ expected_state: 'gone' }, 'expected_state_invalid'],
      [{ zone: 'Not/AZone' }, 'zone_invalid'],
      [{ now: 'now' }, 'now_invalid'],
      [{ candidate_id: 'x' }, 'candidate_id_invalid'],
      // snooze 以外に再通知の時刻は付けられない。
      [
        { event: 'act', snooze_until: '2031-02-01T00:00:00Z' },
        'snooze_until_unexpected',
      ],
      [{ event: 'snooze', snooze_until: null }, 'snooze_until_invalid'],
    ];
    for (const [over, reason] of malformed) {
      const out = run(db, {
        kind: 'candidate.transition',
        input: {
          candidate_id: C1,
          event: 'act',
          expected_state: 'seen',
          zone: ZONE,
          snooze_until: null,
          now: '2031-01-01T06:00:00Z',
          ...over,
        } as never,
      });
      assert.ok(
        out.reasons?.includes(reason),
        `${reason}: ${JSON.stringify(out.reasons)}`,
      );
    }
    assert.equal(rowOf(db, C1)['state'], 'seen');
  });
});

test('snooze keeps a future wake time, and the wake time is checked again when it comes', async () => {
  await withDb((db) => {
    create(db, { deadline: { kind: 'none' } });
    // 過去・現在の再通知の時刻は拒む。
    assert.deepEqual(transition(db, C1, 'snooze', 'new', T0, T0).reasons, [
      'snooze_not_in_future',
    ]);
    assert.equal(
      transition(db, C1, 'snooze', 'new', T0, '2031-01-02T00:00:00Z').ok,
      true,
    );
    const row = rowOf(db, C1);
    assert.equal(row['state'], 'snoozed');
    assert.equal(row['snooze_until'], T0_MS + 86_400_000);
    // 時刻の前の snooze_elapsed は、行を読み直して「まだ」なので書かない。
    assert.deepEqual(
      transition(db, C1, 'snooze_elapsed', 'snoozed', '2031-01-01T23:59:59Z')
        .reasons,
      ['event_not_due'],
    );
    assert.equal(rowOf(db, C1)['state'], 'snoozed');
    // ちょうどで new に戻り、再通知の時刻は消える。
    assert.deepEqual(
      transition(db, C1, 'snooze_elapsed', 'snoozed', '2031-01-02T00:00:00Z')
        .value,
      {
        candidate_id: C1,
        from: 'snoozed',
        to: 'new',
        state_changed_at: T0_MS + 86_400_000,
      },
    );
    assert.equal(rowOf(db, C1)['snooze_until'], null);
  });
});

test('a passed deadline is checked again from the stored row before it resolves the candidate', async () => {
  await withDb((db) => {
    // 日付だけの期限 2031-01-10 は、日本時間の 2031-01-11 0 時（= 2031-01-10T15:00:00Z）に過ぎる。
    create(db, { deadline: { kind: 'date', date: '2031-01-10' } });
    const early = transition(
      db,
      C1,
      'deadline_passed',
      'new',
      '2031-01-10T14:59:59Z',
    );
    assert.deepEqual(early.reasons, ['event_not_due']);
    assert.equal(rowOf(db, C1)['state'], 'new');
    const due = transition(
      db,
      C1,
      'deadline_passed',
      'new',
      '2031-01-10T15:00:00Z',
    );
    assert.deepEqual(due.value, {
      candidate_id: C1,
      from: 'new',
      to: 'resolved',
      state_changed_at: Date.parse('2031-01-10T15:00:00Z'),
    });
    // 期限の無い候補は、時計では解決しない。
    create(db, {
      candidate_id: C2,
      notification_key: KEY_B,
      deadline: { kind: 'none' },
    });
    assert.deepEqual(
      transition(db, C2, 'deadline_passed', 'new', '2040-01-01T00:00:00Z')
        .reasons,
      ['event_not_due'],
    );
  });
});

test('a first-import candidate whose deadline had already passed is never resolved by the clock', async () => {
  await withDb((db) => {
    create(db, {
      initial_import: true,
      deadline: { kind: 'date', date: '2030-12-01' },
      created_at: T0,
    });
    assert.deepEqual(
      transition(db, C1, 'deadline_passed', 'new', '2035-01-01T00:00:00Z')
        .reasons,
      ['event_not_due'],
    );
    // 本人の操作では解決できる。
    assert.equal(
      transition(db, C1, 'resolve', 'new', '2035-01-01T00:00:00Z').ok,
      true,
    );
  });
});

test('events decided outside the store are accepted for live candidates and write the closing times', async () => {
  await withDb((db) => {
    create(db);
    create(db, { candidate_id: C2, notification_key: KEY_B });
    assert.equal(
      transition(db, C1, 'source_out_of_scope', 'new', '2031-01-03T00:00:00Z')
        .ok,
      true,
    );
    assert.equal(
      transition(db, C2, 'overlap_resolved', 'new', '2031-01-03T00:00:00Z').ok,
      true,
    );
    for (const id of [C1, C2]) {
      const row = rowOf(db, id);
      assert.equal(row['state'], 'resolved');
      assert.equal(row['closed_at'], T0_MS + 2 * 86_400_000);
      assert.equal(
        row['key_delete_at'],
        T0_MS + 2 * 86_400_000 + KEY_RETENTION_MS,
      );
    }
  });
});

test('list returns the sealed titles in receipt order, honours the states and the limit, and get adds the excerpt', async () => {
  await withDb((db) => {
    create(db, {
      candidate_id: C1,
      notification_key: KEY_A,
      received_at: '2031-01-01T00:00:00Z',
    });
    create(db, {
      candidate_id: C2,
      notification_key: KEY_B,
      received_at: '2031-01-01T02:00:00Z',
    });
    create(db, {
      candidate_id: C3,
      notification_key: KEY_C,
      received_at: '2031-01-01T01:00:00Z',
    });
    assert.equal(transition(db, C3, 'dismiss', 'new').ok, true);
    const all = run(db, { kind: 'candidate.list', limit: 10 })
      .value as CandidateOpValues['candidate.list'];
    assert.deepEqual(
      all.candidates.map((c) => c.candidate_id),
      [C2, C3, C1],
    );
    assert.equal(all.truncated, false);
    // 一覧は抄録を返さない（根拠を見るときだけ get で読む）。
    assert.ok(
      all.candidates.every((c) => c.title !== null && c.excerpt === null),
    );
    const live = run(db, {
      kind: 'candidate.list',
      states: ['new', 'seen'],
      limit: 10,
    }).value as CandidateOpValues['candidate.list'];
    assert.deepEqual(
      live.candidates.map((c) => c.candidate_id),
      [C2, C1],
    );
    const cut = run(db, { kind: 'candidate.list', limit: 2 })
      .value as CandidateOpValues['candidate.list'];
    assert.deepEqual(
      cut.candidates.map((c) => c.candidate_id),
      [C2, C3],
    );
    assert.equal(cut.truncated, true);
    const got = run(db, { kind: 'candidate.get', candidate_id: C1 })
      .value as CandidateOpValues['candidate.get'];
    assert.ok(got.candidate?.excerpt !== null);
    assert.deepEqual(
      run(db, { kind: 'candidate.get', candidate_id: randomUUID() }).value,
      { candidate: null },
    );
    for (const bad of [0, 1001, 1.5]) {
      assert.deepEqual(
        run(db, { kind: 'candidate.list', limit: bad }).reasons,
        ['limit_invalid'],
      );
    }
    assert.deepEqual(
      run(db, { kind: 'candidate.list', limit: 5, states: [] }).reasons,
      ['states_invalid'],
    );
    assert.deepEqual(
      run(db, { kind: 'candidate.list', limit: 5, states: ['x' as never] })
        .reasons,
      ['states_invalid'],
    );
  });
});

test('counts give every state, including the empty ones', async () => {
  await withDb((db) => {
    assert.deepEqual(run(db, { kind: 'candidate.counts' }).value, {
      new: 0,
      seen: 0,
      acted: 0,
      dismissed: 0,
      snoozed: 0,
      resolved: 0,
    });
    create(db, { candidate_id: C1, notification_key: KEY_A });
    create(db, { candidate_id: C2, notification_key: KEY_B });
    create(db, { candidate_id: C3, notification_key: KEY_C });
    transition(db, C2, 'open', 'new');
    transition(db, C3, 'dismiss', 'new');
    assert.deepEqual(run(db, { kind: 'candidate.counts' }).value, {
      new: 1,
      seen: 1,
      acted: 0,
      dismissed: 1,
      snoozed: 0,
      resolved: 0,
    });
  });
});

// --- 表の CHECK と trigger（ストアを通さない直接の書込みも守る） ---

function insertRow(
  db: SqliteDatabase,
  state: string,
  over: Record<string, unknown> = {},
): void {
  const closed = state === 'dismissed' || state === 'resolved';
  const values: Record<string, unknown> = {
    candidate_id: randomUUID(),
    kind: 'mail_reply',
    notification_key: randomUUID().replaceAll('-', '').repeat(2),
    state,
    closed_at: closed ? 1000 : null,
    key_delete_at: closed ? 1000 + KEY_RETENTION_MS : null,
    snooze_until: state === 'snoozed' ? 5000 : null,
    ...over,
  };
  const columns = Object.keys(values);
  db.prepare(
    `INSERT INTO notification_candidates (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...Object.values(values));
}

test('the table refuses impossible combinations written around the store', async () => {
  await withDb((db) => {
    const refused: [string, string, Record<string, unknown>][] = [
      [
        'instant without a zone',
        'new',
        { deadline_kind: 'instant', deadline_local: '2031-01-10T17:00' },
      ],
      [
        'date with a zone',
        'new',
        {
          deadline_kind: 'date',
          deadline_local: '2031-01-10',
          deadline_zone: ZONE,
        },
      ],
      ['unresolved without a reason', 'new', { deadline_kind: 'unresolved' }],
      [
        'none with a value',
        'new',
        { deadline_kind: 'none', deadline_local: '2031-01-10' },
      ],
      ['unknown deadline kind', 'new', { deadline_kind: 'soon' }],
      [
        'unknown unresolved reason',
        'new',
        { deadline_kind: 'unresolved', deadline_reason: 'guess' },
      ],
      ['snoozed without a wake time', 'snoozed', { snooze_until: null }],
      ['wake time on a live candidate', 'seen', { snooze_until: 5000 }],
      ['partial related analysis', 'new', { related_group_id: 'g-1' }],
      [
        'related hash length',
        'new',
        {
          related_group_id: 'g-1',
          related_analysis_revision: 1,
          related_source_set_hash: 'x',
          related_published_generation: 0,
        },
      ],
      [
        'content deleted on a live candidate',
        'new',
        { content_deleted_at: 10 },
      ],
      [
        'content deleted with a title left',
        'resolved',
        {
          content_deleted_at: 10,
          title_blob_id: blob(
            db,
            'candidate_title',
            'notification_candidates',
            'x',
          ),
        },
      ],
      ['flag out of range', 'new', { initial_import: 2 }],
    ];
    for (const [name, state, over] of refused)
      assert.throws(
        () => insertRow(db, state, over),
        /CHECK constraint failed/u,
        name,
      );
    // 正しい組み合わせは通る。
    insertRow(db, 'new', {
      deadline_kind: 'instant',
      deadline_local: '2031-01-10T17:00',
      deadline_zone: ZONE,
    });
    insertRow(db, 'snoozed');
    insertRow(db, 'resolved', { content_deleted_at: 10 });
    insertRow(db, 'new', {
      related_group_id: 'g-1',
      related_analysis_revision: 1,
      related_source_set_hash: 'e'.repeat(64),
      related_published_generation: 0,
    });
  });
});

test('the transition trigger allows exactly the transitions of the domain state machine', async () => {
  await withDb((db) => {
    // 手で書いた許す遷移（new → seen/acted/dismissed/snoozed/resolved、seen → acted/dismissed/snoozed/resolved、
    // acted → resolved、snoozed → new/seen/acted/dismissed/resolved。dismissed・resolved からは動かせない）。
    const allowed: Record<string, string[]> = {
      new: ['seen', 'acted', 'dismissed', 'snoozed', 'resolved'],
      seen: ['acted', 'dismissed', 'snoozed', 'resolved'],
      acted: ['resolved'],
      snoozed: ['new', 'seen', 'acted', 'dismissed', 'resolved'],
      dismissed: [],
      resolved: [],
    };
    const states = ['new', 'seen', 'acted', 'dismissed', 'snoozed', 'resolved'];
    for (const from of states) {
      for (const to of states) {
        if (from === to) continue;
        const id = randomUUID();
        insertRow(db, from, { candidate_id: id });
        const closing = to === 'dismissed' || to === 'resolved';
        const move = (): void => {
          db.prepare(
            'UPDATE notification_candidates SET state = ?, closed_at = ?, key_delete_at = ?, snooze_until = ? WHERE candidate_id = ?',
          ).run(
            to,
            closing ? 2000 : null,
            closing ? 2000 + KEY_RETENTION_MS : null,
            to === 'snoozed' ? 9000 : null,
            id,
          );
        };
        if (allowed[from]?.includes(to)) move();
        else
          assert.throws(
            move,
            /candidate_(transition_not_allowed|closed_is_final)/u,
            `${from} → ${to}`,
          );
        const now = rowOf(db, id)['state'];
        assert.equal(
          now,
          allowed[from]?.includes(to) ? to : from,
          `${from} → ${to}`,
        );
      }
    }
  });
});

test('identity and time cannot be rewritten, and a closed row only loses its content', async () => {
  await withDb((db) => {
    const id = randomUUID();
    insertRow(db, 'new', {
      candidate_id: id,
      state_changed_at: 100,
      created_at: 100,
    });
    for (const [column, value] of [
      ['notification_key', 'f'.repeat(64)],
      ['kind', 'research_done'],
      ['created_at', 5],
    ] as const)
      assert.throws(
        () =>
          db
            .prepare(
              `UPDATE notification_candidates SET ${column} = ? WHERE candidate_id = ?`,
            )
            .run(value, id),
        /candidate_identity_fixed/u,
        column,
      );
    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE notification_candidates SET candidate_id = ? WHERE candidate_id = ?',
          )
          .run(randomUUID(), id),
      /candidate_identity_fixed/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE notification_candidates SET state_changed_at = 50 WHERE candidate_id = ?',
          )
          .run(id),
      /candidate_time_backwards/u,
    );
    // 閉じた候補は、閉じた時刻・識別子の削除日を動かせない。内容を消す更新だけが通る。
    const closed = randomUUID();
    const title = blob(
      db,
      'candidate_title',
      'notification_candidates',
      closed,
    );
    insertRow(db, 'resolved', { candidate_id: closed, title_blob_id: title });
    for (const sql of [
      'UPDATE notification_candidates SET closed_at = 3000 WHERE candidate_id = ?',
      'UPDATE notification_candidates SET key_delete_at = key_delete_at + 1 WHERE candidate_id = ?',
      'UPDATE notification_candidates SET state_changed_at = 7 WHERE candidate_id = ?',
    ])
      assert.throws(
        () => db.prepare(sql).run(closed),
        /candidate_closed_is_final|CHECK constraint failed/u,
        sql,
      );
    db.prepare(
      'UPDATE notification_candidates SET title_blob_id = NULL, content_deleted_at = 4000 WHERE candidate_id = ?',
    ).run(closed);
    assert.equal(rowOf(db, closed)['content_deleted_at'], 4000);
  });
});

test('the key is unique in the table itself and a row without the new columns still reads', async () => {
  await withDb((db) => {
    const key = '1'.repeat(64);
    insertRow(db, 'new', { notification_key: key });
    assert.throws(
      () => insertRow(db, 'new', { notification_key: key }),
      /UNIQUE constraint failed/u,
    );
    // 0001 の列だけで書いた行（試験用の古い書き方）は、既定値で読める。
    db.prepare(
      "INSERT INTO notification_candidates (candidate_id, request_entity_id, request_revision, source_revision, kind, notification_key, title_blob_id, excerpt_blob_id, state, closed_at, key_delete_at) VALUES (?, NULL, NULL, NULL, 'research_done', ?, NULL, NULL, 'new', NULL, NULL)",
    ).run(C3, '2'.repeat(64));
    const row = (
      run(db, { kind: 'candidate.get', candidate_id: C3 })
        .value as CandidateOpValues['candidate.get']
    ).candidate;
    assert.deepEqual(row?.deadline, { kind: 'none' });
    assert.equal(row?.initial_import, false);
    assert.equal(row?.title, null);
  });
});

// --- 保持の掃除 ---

const DAY = 86_400_000;
const at = (ms: number): string =>
  new Date(ms).toISOString().replace('.000Z', 'Z');

function sweep(
  db: SqliteDatabase,
  now: string,
): CandidateOpValues['candidate.sweep'] {
  const out = run(db, { kind: 'candidate.sweep', now });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.value as CandidateOpValues['candidate.sweep'];
}

test('a closed candidate loses its sealed title and excerpt at 7 days and its row at 97 days, exactly', async () => {
  await withDb((db) => {
    create(db);
    // 閉じた時刻 = T0 + 1 日。7 日の境目は T0 + 8 日、97 日の境目は T0 + 98 日。
    const closedAt = T0_MS + DAY;
    assert.equal(transition(db, C1, 'resolve', 'new', at(closedAt)).ok, true);
    const sealed = (): number =>
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'notification_candidates'",
      );
    assert.equal(sealed(), 2);
    // 7 日の 1 ms 前までは何も消さない。
    assert.deepEqual(sweep(db, at(closedAt + 7 * DAY - 1000)), {
      content_deleted: [],
      deleted: [],
    });
    assert.equal(sealed(), 2);
    // ちょうど 7 日で題・抄録を消す。識別子・状態・由来の辺は残る。
    assert.deepEqual(sweep(db, at(closedAt + 7 * DAY)), {
      content_deleted: [C1],
      deleted: [],
    });
    assert.equal(sealed(), 0);
    const row = rowOf(db, C1);
    assert.equal(row['title_blob_id'], null);
    assert.equal(row['excerpt_blob_id'], null);
    assert.equal(row['content_deleted_at'], closedAt + 7 * DAY);
    assert.equal(row['state'], 'resolved');
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM derivations WHERE artifact_id = '" + C1 + "'",
      ),
      1,
    );
    // 内容の無くなった候補を読んでも、題・抄録は空で返る。
    const got = run(db, { kind: 'candidate.get', candidate_id: C1 })
      .value as CandidateOpValues['candidate.get'];
    assert.equal(got.candidate?.title, null);
    assert.equal(got.candidate?.excerpt, null);
    // 掃除を繰り返しても変わらない。
    assert.deepEqual(sweep(db, at(closedAt + 7 * DAY + 1000)), {
      content_deleted: [],
      deleted: [],
    });
    // 識別子が残る間は、同じ識別子の候補を作り直さない。
    assert.equal(create(db, { candidate_id: C2 }).result, 'duplicate');
    assert.deepEqual(sweep(db, at(closedAt + 97 * DAY - 1000)), {
      content_deleted: [],
      deleted: [],
    });
    assert.equal(count(db, 'SELECT count(*) FROM notification_candidates'), 1);
    // ちょうど 97 日で行と由来の辺が消え、同じ識別子をここで初めて作り直せる。
    assert.deepEqual(sweep(db, at(closedAt + 97 * DAY)), {
      content_deleted: [],
      deleted: [C1],
    });
    assert.equal(count(db, 'SELECT count(*) FROM notification_candidates'), 0);
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM derivations WHERE artifact_kind = 'notification_candidate'",
      ),
      0,
    );
    assert.equal(create(db, { candidate_id: C2 }).result, 'created');
  });
});

test('the sweep removes the title and the row in one step when the clock is already past 97 days', async () => {
  await withDb((db) => {
    create(db);
    assert.equal(transition(db, C1, 'dismiss', 'new', T0).ok, true);
    assert.deepEqual(sweep(db, at(T0_MS + 200 * DAY)), {
      content_deleted: [],
      deleted: [C1],
    });
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'notification_candidates'",
      ),
      0,
    );
    assert.equal(count(db, 'SELECT count(*) FROM notification_candidates'), 0);
  });
});

test('live candidates are never swept, however old', async () => {
  await withDb((db) => {
    create(db, { candidate_id: C1, notification_key: KEY_A });
    create(db, { candidate_id: C2, notification_key: KEY_B });
    create(db, { candidate_id: C3, notification_key: KEY_C });
    assert.equal(transition(db, C2, 'open', 'new').ok, true);
    assert.equal(
      transition(db, C3, 'snooze', 'new', T0, '2031-01-02T00:00:00Z').ok,
      true,
    );
    assert.deepEqual(sweep(db, at(T0_MS + 3650 * DAY)), {
      content_deleted: [],
      deleted: [],
    });
    assert.equal(count(db, 'SELECT count(*) FROM notification_candidates'), 3);
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'notification_candidates'",
      ),
      6,
    );
  });
});

test('the sweep only touches the candidates that are due, and a bad clock is refused', async () => {
  await withDb((db) => {
    create(db, { candidate_id: C1, notification_key: KEY_A });
    create(db, { candidate_id: C2, notification_key: KEY_B });
    assert.equal(transition(db, C1, 'dismiss', 'new', at(T0_MS)).ok, true);
    assert.equal(
      transition(db, C2, 'dismiss', 'new', at(T0_MS + 3 * DAY)).ok,
      true,
    );
    // C1 は閉じて 7 日、C2 は 4 日。
    assert.deepEqual(sweep(db, at(T0_MS + 7 * DAY)), {
      content_deleted: [C1],
      deleted: [],
    });
    assert.notEqual(rowOf(db, C2)['title_blob_id'], null);
    assert.deepEqual(
      run(db, { kind: 'candidate.sweep', now: 'soon' }).reasons,
      ['now_invalid'],
    );
    assert.deepEqual(
      run(db, { kind: 'candidate.sweep', now: '2031-02-30T00:00:00Z' }).reasons,
      ['now_invalid'],
    );
    assert.equal(
      run(db, { kind: 'candidate.sweep', now: at(T0_MS) }, true).ok,
      false,
    );
  });
});

test('forgetting removes a candidate whose sealed content was already swept, and one that still has it', async () => {
  await withDb((db) => {
    create(db, { candidate_id: C1, notification_key: KEY_A });
    create(db, { candidate_id: C2, notification_key: KEY_B });
    assert.equal(transition(db, C1, 'resolve', 'new', T0).ok, true);
    // C1 は題・抄録を掃除で消した後、C2 は内容が残ったまま。どちらも忘却の削除で行・封筒・由来の辺が残らない。
    assert.deepEqual(sweep(db, at(T0_MS + 7 * DAY)), {
      content_deleted: [C1],
      deleted: [],
    });
    for (const id of [C1, C2])
      assert.equal(
        deleteForgetNode(db, { kind: 'notification_candidate', id }),
        1,
        id,
      );
    assert.equal(count(db, 'SELECT count(*) FROM notification_candidates'), 0);
    assert.equal(
      count(
        db,
        "SELECT count(*) FROM sealed_blobs WHERE owner_table = 'notification_candidates'",
      ),
      0,
    );
  });
});

test('list pages with a keyset cursor and reaches every row exactly once, even when rows change between pages', async () => {
  await withDb((db) => {
    // 受信: C1 が最も古く、C2・C3 は同じ受信時刻（同じ受信は ID の昇順）。
    create(db, {
      candidate_id: C1,
      notification_key: KEY_A,
      received_at: '2031-01-01T00:00:00Z',
    });
    create(db, {
      candidate_id: C2,
      notification_key: KEY_B,
      received_at: '2031-01-01T02:00:00Z',
    });
    create(db, {
      candidate_id: C3,
      notification_key: KEY_C,
      received_at: '2031-01-01T02:00:00Z',
    });
    const page = (after?: { received_at: number; candidate_id: string }) =>
      run(db, {
        kind: 'candidate.list',
        limit: 1,
        ...(after === undefined ? {} : { after }),
      }).value as CandidateOpValues['candidate.list'];
    const first = page();
    assert.deepEqual(
      first.candidates.map((c) => c.candidate_id),
      [C2],
    );
    assert.equal(first.truncated, true);
    assert.deepEqual(first.next_after, {
      received_at: T0_MS + 2 * 3_600_000,
      candidate_id: C2,
    });
    // 1 ページ目の候補が閉じても、続きの位置は動かない。
    assert.equal(transition(db, C2, 'dismiss', 'new').ok, true);
    const second = page(first.next_after ?? undefined);
    assert.deepEqual(
      second.candidates.map((c) => c.candidate_id),
      [C3],
    );
    const third = page(second.next_after ?? undefined);
    assert.deepEqual(
      third.candidates.map((c) => c.candidate_id),
      [C1],
    );
    assert.equal(third.truncated, false);
    assert.equal(third.next_after, null);
    // 位置の形が不正なら拒む。
    for (const after of [
      { received_at: 1.5, candidate_id: C1 },
      { received_at: 1, candidate_id: 'x' },
    ])
      assert.deepEqual(
        run(db, { kind: 'candidate.list', limit: 1, after } as never).reasons,
        ['after_invalid'],
      );
  });
});
