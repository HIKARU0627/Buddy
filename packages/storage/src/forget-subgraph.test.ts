// 系譜の部分読み（ADR 0061。U156。B06-07 07b-1）。
// - 忘却の起点から閉包に触れる部分だけを読んで計画を作っても、系譜を全件読んで作った計画と一致する（性質試験）。
//   合成の世界を手書きの種で何通りも作り（発言・会話・記憶・元情報・操作・影モード・本人の指示・合流・循環・由来の
//   行がない記憶・由来の辺を持たない要約と影モード）、すべての対象・指示の発言の組で比べる。
// - 部分読みは辺の件数ではなく閉包の大きさだけを読む（無関係な辺が 5 万あっても、触る辺は手で数えた 3 本）。
// - 全件読み（readLineageEdges の `rows.push(...全件)`）は件数が多いと RangeError になった。直した後は 20 万行でも読める。
// 期待値は全件読みの計画（別の読み方）と、手で数えた辺の数。HMAC は試験用の決まった 64 桁の値。

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { planForget } from '@buddy/domain';
import type { ForgetGraph, MemorySource } from '@buddy/domain';
import { readForgetGraph, readForgetSubgraph } from './index.js';
import type { ForgetGraphValue, SqliteDatabase } from './index.js';
import {
  M,
  T_INST,
  T_SRC,
  blob,
  edge,
  insertMemory,
  memoryOp,
  reasons,
  value,
  withWorld,
} from './forget-test-support.js';
import {
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

const sha256hex = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

// 台帳用の HMAC（試験用に決めた値。鍵による計算ではない）。
const hmacOf = (source: MemorySource): string =>
  sha256hex(`subgraph-test:${source.source_kind}:${source.source_id}`);

// 手書きの種から作る疑似乱数（mulberry32）。
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (value: number, width: number): string =>
  value.toString(16).padStart(width, '0');
// UUID v4 の形。先頭 8 桁は種類の符号 2 桁と世界の番号 6 桁。
const uuid = (code: string, world: number, index: number): string =>
  `${code}${hex(world, 6)}-0000-4000-8000-${hex(index, 12)}`;

const ARTIFACT_KINDS = [
  'carried_summary',
  'notification_candidate',
  'request_entity',
  'related_analysis',
  'canvas_item',
  'async_guard',
] as const;
const OPERATION_STATES = [
  'succeeded',
  'cancelled',
  'superseded',
  'approved',
  'dispatching',
  'unknown_held',
] as const;

interface Node {
  readonly kind: string;
  readonly id: string;
}

interface World {
  readonly turns: string[];
  readonly memories: string[];
  readonly ghostMemory: string;
  readonly sourceItems: string[];
}

// 合成の世界を 1 つ足す。世界どうしは ID が重ならない（同じ DB に積むので、部分読みは関係のない世界を読まない）。
function addWorld(
  db: SqliteDatabase,
  world: number,
  seed: number,
  density: number,
): World {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T;
  const chance = (p: number): boolean => random() < p;

  const sessionIds = Array.from({ length: 5 }, (_, i) => uuid('a3', world, i));
  const sessionRows = db.prepare(
    "INSERT INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES (?, 'normal', 'dev-1', 0, NULL, 1000, NULL)",
  );
  for (const id of sessionIds) {
    sessionRows.run(id);
    // 会話の要約は半分にある（由来の辺があるかは下で決める）。
    if (chance(0.6)) {
      const summary = blob(db, 'session_summary', 'sessions', id);
      db.prepare(
        'UPDATE sessions SET summary_blob_id = ? WHERE session_id = ?',
      ).run(summary, id);
    }
  }
  const turns = Array.from({ length: 10 }, (_, i) => uuid('a1', world, i));
  for (const id of turns) {
    const text = blob(db, 'turn_text', 'turns', id);
    db.prepare(
      "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, ?, 'user', 'text', ?, 1000, 9999999999999)",
    ).run(id, pick(sessionIds), text);
  }
  const sourceItems = Array.from({ length: 3 }, (_, i) => `src-${world}-${i}`);
  const memories = Array.from({ length: 7 }, (_, i) => uuid('a2', world, i));
  const ghostMemory = uuid('a2', world, 99);
  // 記憶の由来（memory_sources）。由来は発言・元情報・記憶（行のない記憶を含む）。循環もありうる。
  const memorySourcePool: MemorySource[] = [
    ...turns.map((id) => ({ source_kind: 'turn' as const, source_id: id })),
    ...sourceItems.map((id) => ({
      source_kind: 'source_item' as const,
      source_id: id,
    })),
    ...[...memories, ghostMemory].map((id) => ({
      source_kind: 'memory' as const,
      source_id: id,
    })),
  ];
  memories.forEach((id, index) => {
    const sources = new Map<string, MemorySource>();
    const count = Math.floor(random() * 3);
    for (let n = 0; n < count; n += 1) {
      const source = pick(memorySourcePool);
      if (source.source_id !== id)
        sources.set(`${source.source_kind}\u0000${source.source_id}`, source);
    }
    insertMemory(db, id, sha256hex(`dedupe-${world}-${index}`), [
      ...sources.values(),
    ]);
  });

  // 操作（確定内容を持つ memory の操作）。行のない操作（90 日の削除の後）も混ぜる。
  const operationIds = Array.from({ length: 5 }, (_, i) =>
    uuid('a4', world, i),
  );
  operationIds.forEach((id, index) => {
    if (index === operationIds.length - 1) return; // 行のない操作
    const state = pick(OPERATION_STATES);
    db.prepare(
      "INSERT INTO operations (operation_id, workflow_id, kind, effect_route, current_content_version, state, state_revision, created_at, completed_at) VALUES (?, NULL, 'memory_save', 'local_command', 1, ?, 1, 1000, ?)",
    ).run(
      id,
      state,
      state === 'succeeded' || state === 'cancelled' || state === 'superseded'
        ? 2000
        : null,
    );
  });

  // 影モードの記録（入力の発言から引ける。入力の発言が NULL のものは未帰属の一覧に出ない）。
  const shadowIds = Array.from({ length: 4 }, (_, i) => `shadow-${world}-${i}`);
  shadowIds.forEach((id, index) => {
    const turnId = index === shadowIds.length - 1 ? null : pick(turns);
    db.prepare(
      "INSERT INTO input_snapshots (input_id, request_revision, workflow_id, turn_id, origin, state, seal_reason, input_evidence, policy_version, permission_revision, forgetting_generation, audio_epoch) VALUES (?, 1, NULL, ?, 'typed', 'sealed', 'submitted_text', 'submitted_text', NULL, 0, 0, NULL)",
    ).run(`in-${world}-${index}`, turnId);
    db.prepare(
      "INSERT INTO intent_shadow (record_id, campaign_id, input_id, request_revision, judgments, recorded_at, expires_at) VALUES (?, 'camp', ?, 1, '{}', 1000, 2000)",
    ).run(id, `in-${world}-${index}`);
  });

  // 本人の指示（作った発言が由来の辺になる）。
  const directiveIds = Array.from({ length: 3 }, (_, i) =>
    uuid('a5', world, i),
  );
  for (const id of directiveIds) {
    const text = blob(db, 'directive_text', 'user_directives', id);
    db.prepare(
      "INSERT INTO user_directives (directive_id, text_blob_id, scope, session_id, turn_id, active, created_at) VALUES (?, ?, 'from_now_on', NULL, ?, 1, 1000)",
    ).run(id, text, chance(0.8) ? pick(turns) : null);
  }

  // 派生の辺（derivations）。派生物になれる種類と由来になれる種類の間で、ランダムに結ぶ。
  const others: Node[] = [];
  for (const kind of ARTIFACT_KINDS)
    for (let i = 0; i < 3; i += 1)
      others.push({ kind, id: `${kind}-${world}-${i}` });
  const artifactPool: Node[] = [
    ...others,
    ...turns.map((id) => ({ kind: 'turn', id })),
    ...[...memories, ghostMemory].map((id) => ({ kind: 'memory', id })),
    ...sessionIds.map((id) => ({ kind: 'session_summary', id })),
    ...shadowIds.map((id) => ({ kind: 'intent_shadow', id })),
    ...operationIds.map((id) => ({ kind: 'operation_content', id })),
  ];
  const sourcePool: Node[] = [
    ...artifactPool,
    ...sourceItems.map((id) => ({ kind: 'source_item', id })),
  ];
  const written = new Set<string>();
  for (let n = 0; n < density; n += 1) {
    const artifact = pick(artifactPool);
    const source = pick(sourcePool);
    const key = `${artifact.kind}\u0000${artifact.id}\u0000${source.kind}\u0000${source.id}`;
    if (
      written.has(key) ||
      (artifact.kind === source.kind && artifact.id === source.id)
    )
      continue;
    written.add(key);
    edge(db, artifact.kind, artifact.id, source.kind, source.id);
  }
  return { turns, memories, ghostMemory, sourceItems };
}

function planOf(
  graph: ForgetGraph,
  target: MemorySource,
  instruction: string | null,
): ReturnType<typeof planForget> {
  return planForget({
    target,
    instruction_turn_id: instruction,
    executing_operation_id: null,
    graph,
    sourceHmac: hmacOf,
  });
}

test('partial read: the plan equals the plan from reading the whole lineage, for every target and instruction turn', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      const seen = {
        cases: 0,
        rejected: 0,
        spread: 0,
        origins: 0,
        directives: 0,
        retained: 0,
        purged: 0,
        sharedScope: 0,
      };
      const densities = [12, 24, 40, 70];
      for (let world = 1; world <= 16; world += 1) {
        const built = addWorld(
          db,
          world,
          world * 7919 + 13,
          densities[world % densities.length] as number,
        );
        const full = readForgetGraph(db);
        const fullEdges = new Set(
          full.edges.map(
            (e) =>
              `${e.artifact.kind}\u0000${e.artifact.id}\u0000${e.source.kind}\u0000${e.source.id}`,
          ),
        );
        const targets: MemorySource[] = [
          ...built.turns.map((id) => ({
            source_kind: 'turn' as const,
            source_id: id,
          })),
          ...[...built.memories, built.ghostMemory].map((id) => ({
            source_kind: 'memory' as const,
            source_id: id,
          })),
          ...built.sourceItems.map((id) => ({
            source_kind: 'source_item' as const,
            source_id: id,
          })),
        ];
        const random = rng(world * 104729);
        for (const target of targets) {
          const instructions: (string | null)[] = [
            null,
            built.turns[Math.floor(random() * built.turns.length)] as string,
          ];
          for (const instruction of instructions) {
            const partial = readForgetSubgraph(db, {
              target,
              instruction_turn_id: instruction,
            });
            const expected = planOf(full, target, instruction);
            const actual = planOf(partial, target, instruction);
            assert.deepEqual(
              actual,
              expected,
              `world ${world} target ${target.source_kind}:${target.source_id} instruction ${instruction}`,
            );
            // 部分読みの辺は、全件読みの辺の一部。
            for (const e of partial.edges)
              assert.ok(
                fullEdges.has(
                  `${e.artifact.kind}\u0000${e.artifact.id}\u0000${e.source.kind}\u0000${e.source.id}`,
                ),
              );
            seen.cases += 1;
            if (!expected.ok) {
              seen.rejected += 1;
              continue;
            }
            if (expected.plan.deletions.length > 2) seen.spread += 1;
            if (expected.plan.ledger.blocked_source_hmacs.length > 0)
              seen.origins += 1;
            if (expected.plan.user_directives.length > 0) seen.directives += 1;
            if (expected.plan.operation_contents.retained.length > 0)
              seen.retained += 1;
            if (expected.plan.operation_contents.purge.length > 0)
              seen.purged += 1;
            if (
              expected.plan.deletions.some(
                (node) => node.kind === 'session_summary',
              ) ||
              expected.plan.deletions.some(
                (node) => node.kind === 'intent_shadow',
              )
            )
              seen.sharedScope += 1;
          }
        }
      }
      // 合成の世界が閉包の規則を実際に通っていること（一致が自明な世界だけではない）。
      assert.ok(seen.cases > 600, JSON.stringify(seen));
      assert.ok(seen.rejected > 0, JSON.stringify(seen));
      assert.ok(seen.spread > 100, JSON.stringify(seen));
      assert.ok(seen.origins > 30, JSON.stringify(seen));
      assert.ok(seen.directives > 5, JSON.stringify(seen));
      assert.ok(seen.retained > 5, JSON.stringify(seen));
      assert.ok(seen.purged > 5, JSON.stringify(seen));
      assert.ok(seen.sharedScope > 30, JSON.stringify(seen));
    } finally {
      db.close();
    }
  });
});

test('partial read: only the edges the closure touches are read, however many unrelated edges the table holds', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      // 関係のない辺 5 万（記憶 2,000 件分の形。行は要らない）。
      db.exec(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000)
        INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at)
        SELECT 'notification_candidate', 'noise-' || i, 'memory', 'noise-memory-' || (i % 2000), 1000 FROM n;
      `);
      // 手で組んだ系譜: 元情報 S → 記憶 A（memory_sources）→ 気づき c1（derivations）→ つないだ要約 c2。
      const a = randomUUID();
      insertMemory(db, a, sha256hex('subgraph-a'), [
        { source_kind: 'source_item', source_id: 'src-small' },
      ]);
      edge(db, 'notification_candidate', 'cand-small-1', 'memory', a);
      edge(
        db,
        'carried_summary',
        'carried-small-2',
        'notification_candidate',
        'cand-small-1',
      );
      const graph = readForgetSubgraph(db, {
        target: { source_kind: 'memory', source_id: a },
        instruction_turn_id: null,
      });
      // A ← S、c1 ← A、c2 ← c1 の 3 本だけ（5 万の辺には触れない）。
      assert.equal(graph.edges.length, 3, JSON.stringify(graph.edges));
      const planned = planOf(
        graph,
        { source_kind: 'memory', source_id: a },
        null,
      );
      assert.equal(planned.ok, true);
      if (planned.ok) {
        // 消す順は FORGET_DELETE_ORDER（気づき → つないだ要約 → 記憶）。
        assert.deepEqual(
          planned.plan.deletions.map((node) => `${node.kind}:${node.id}`),
          [
            'notification_candidate:cand-small-1',
            'carried_summary:carried-small-2',
            `memory:${a}`,
          ],
        );
        assert.deepEqual(planned.plan.ledger.blocked_source_hmacs, [
          hmacOf({ source_kind: 'source_item', source_id: 'src-small' }),
        ]);
      }
    } finally {
      db.close();
    }
  });
});

test('closure rule D depends on edge order (U157): the partial read keeps the whole read order and gives the same plan', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      const u = (n: number): string => `c0000000-0000-4000-8000-${hex(n, 12)}`;
      const [A, B, C, T1, S, S2, X] = [
        u(1),
        u(2),
        u(3),
        u(4),
        u(5),
        u(6),
        u(9),
      ];
      for (const id of [S, S2])
        db.prepare(
          "INSERT INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES (?, 'normal', 'dev-1', 0, NULL, 1000, NULL)",
        ).run(id);
      // 会話 S は要約があり、由来の辺がない（未帰属）。発言 A・B・C が属する。T1 は要約のない会話 S2。
      db.prepare(
        'UPDATE sessions SET summary_blob_id = ? WHERE session_id = ?',
      ).run(blob(db, 'session_summary', 'sessions', S), S);
      for (const [id, session] of [
        [A, S],
        [B, S],
        [C, S],
        [T1, S2],
      ] as const)
        db.prepare(
          "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, ?, 'user', 'text', ?, 1000, 9999999999999)",
        ).run(id, session, blob(db, 'turn_text', 'turns', id));
      // 忘れる記憶 X は発言 B から。X から発言 T1 を作り、T1 から発言 C を作る。
      // 辺の並びは（派生物の種類・ID の順）で C ← T1 が T1 ← X より前になるので、C が core になるのは閉包の 2 巡目。
      // 1 巡目の規則 D は、B が除外する由来なので要約 S を「触れるだけ」で消す（core に上げず、範囲を広げない）。
      // 2 巡目で C が core になっても、S はもう消える物なので範囲の発言 A は除外する由来にならない。
      insertMemory(db, X, sha256hex('order-x'), [
        { source_kind: 'turn', source_id: B },
      ]);
      edge(db, 'turn', T1, 'memory', X);
      edge(db, 'turn', C, 'turn', T1);
      const target: MemorySource = { source_kind: 'memory', source_id: X };
      const full = planOf(readForgetGraph(db), target, null);
      const partial = planOf(
        readForgetSubgraph(db, { target, instruction_turn_id: null }),
        target,
        null,
      );
      assert.deepEqual(partial, full);
      assert.equal(full.ok, true);
      if (!full.ok) return;
      // 手で導いた期待値: 消える物は要約 S・記憶 X・発言 C・T1。除外する由来は B だけ（A は除外されない）。
      assert.deepEqual(
        full.plan.deletions.map((node) => `${node.kind}:${node.id}`),
        [`session_summary:${S}`, `memory:${X}`, `turn:${C}`, `turn:${T1}`],
      );
      assert.deepEqual(full.plan.ledger.blocked_source_hmacs, [
        hmacOf({ source_kind: 'turn', source_id: B }),
      ]);
    } finally {
      db.close();
    }
  });
});

test('whole-lineage read no longer overflows the argument limit (RangeError) with 200,000 rows in one table', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      // 1 つの表が引数の数の上限（約 12 万）を超える行数。旧い読み方は `rows.push(...全件)` で RangeError になった。
      db.exec(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200000)
        INSERT INTO derivations (artifact_kind, artifact_id, source_kind, source_id, created_at)
        SELECT 'notification_candidate', 'big-' || i, 'memory', 'big-memory-' || (i % 5000), 1000 FROM n;
      `);
      const graph = readForgetGraph(db);
      assert.equal(graph.edges.length, 200_000);
    } finally {
      db.close();
    }
  });
});

test('forget.graph takes the instruction turn: a plan with an instruction turn made from a graph read without it is stale', async () => {
  await withWorld((db) => {
    const target: MemorySource = { source_kind: 'memory', source_id: M };
    const hmacs = [
      {
        source_kind: 'turn' as const,
        source_id: T_SRC,
        hmac: hmacOf({ source_kind: 'turn', source_id: T_SRC }),
      },
      {
        source_kind: 'turn' as const,
        source_id: T_INST,
        hmac: hmacOf({ source_kind: 'turn', source_id: T_INST }),
      },
      { source_kind: 'memory' as const, source_id: M, hmac: hmacOf(target) },
    ];
    const lookup = (source: MemorySource): string =>
      hmacs.find(
        (item) =>
          item.source_kind === source.source_kind &&
          item.source_id === source.source_id,
      )?.hmac ?? '';
    // 指示の発言を渡さずに読んだ系譜は、指示の発言の下流（影モードの記録・本人の指示）を含まない。
    const without = value<ForgetGraphValue>(
      memoryOp(db, { kind: 'forget.graph', target }),
    );
    const withInstruction = value<ForgetGraphValue>(
      memoryOp(db, {
        kind: 'forget.graph',
        target,
        instruction_turn_id: T_INST,
      }),
    );
    const staleGraph = planForget({
      target,
      instruction_turn_id: T_INST,
      executing_operation_id: null,
      graph: without.graph,
      sourceHmac: lookup,
    });
    const goodGraph = planForget({
      target,
      instruction_turn_id: T_INST,
      executing_operation_id: null,
      graph: withInstruction.graph,
      sourceHmac: lookup,
    });
    assert.equal(staleGraph.ok && goodGraph.ok, true);
    if (!staleGraph.ok || !goodGraph.ok) return;
    assert.notDeepEqual(staleGraph.plan, goodGraph.plan);
    const result = memoryOp(db, {
      kind: 'forget.apply',
      target,
      instruction_turn_id: T_INST,
      plan: staleGraph.plan,
      source_hmacs: hmacs,
      entry_id: randomUUID(),
      previous_generation: without.forgetting_generation,
      new_ledger_id: randomUUID(),
      now: Date.parse('2031-01-02T03:04:05.678Z'),
    });
    assert.deepEqual(reasons(result), ['forget_plan_stale']);
    // 全件読みでも同じ計画になる（指示の発言の下流を含めた計画）。
    seedCheck(db, target, goodGraph.plan);
  });
});

// 世界（seedWorld）の対象・指示の組で、部分読みの計画と全件読みの計画が一致する。
function seedCheck(
  db: SqliteDatabase,
  target: MemorySource,
  expected: unknown,
): void {
  const planned = planOf(readForgetGraph(db), target, T_INST);
  assert.equal(planned.ok, true);
  if (planned.ok) assert.deepEqual(planned.plan, expected);
}

test('partial read on the shared world: every node of seedWorld gives the same plan as the whole read', async () => {
  await withWorld((db) => {
    // withWorld は他の試験が使う手書きの世界（seedWorld）。ここでは部分読みと全件読みの一致だけを確かめる。
    const full = readForgetGraph(db);
    const rows = db
      .prepare(
        "SELECT 'turn' AS source_kind, turn_id AS source_id FROM turns UNION ALL SELECT 'memory', memory_id FROM memories",
      )
      .all() as MemorySource[];
    assert.ok(rows.length >= 6);
    for (const target of rows)
      for (const instruction of [null, T_INST]) {
        const partial = readForgetSubgraph(db, {
          target,
          instruction_turn_id: instruction,
        });
        assert.deepEqual(
          planOf(partial, target, instruction),
          planOf(full, target, instruction),
          `${target.source_kind}:${target.source_id} ${instruction}`,
        );
      }
  });
});
