// 実体を消した中間の派生物の系譜（ADR 0054 U110。PR #168 の 3 回目・4 回目のレビューの P1）。
// - 記憶に限らず、どの種類の中間の節点も、実体（行・本文・暗号文）を消した後に生きた下流があれば ID だけの辺を残し、
//   後で元情報を忘れたときに下流の派生物が閉包に入って消える（元情報 S → 記憶 A → 操作の確定内容 O → 気づき B など）。
// - 下流がなくなったら、残した辺はすべて回収される。
// - 発言を由来にする記憶（memory_sources の由来が発言）も下流として辿る（元情報 S → 操作の確定内容 O → 発言 T → 記憶 M）。
// - 系譜をいくつか合成し、中間の節点を消す順・消す物を変えても、元情報を忘れた後にその系譜の派生物の行・辺・暗号文が
//   1 つも残らない。
// 期待値は手で書いた（残る辺の一覧・残る件数 0）。HMAC は試験用に決めた 64 桁の値。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { MemorySource } from '@buddy/domain';
import { executeRetentionOp } from './index.js';
import type { SqliteDatabase, SourceHmacValue } from './index.js';
import {
  HMACS,
  LEDGER_ID,
  M_OTHER,
  blob,
  completeOperation,
  count,
  edge,
  insertMemory,
  memoryOp,
  planFor,
  value,
  withWorld,
} from './forget-test-support.js';

const DAY = 86_400_000;
// insertMemory の見直し日と、completeOperation の完了の時刻（手で書いた値）。
const REVIEW_AT = 9_000_000_000_000;
const COMPLETED_AT = 1_000_000;

type Kind = 'memory' | 'operation_content' | 'notification_candidate' | 'turn';
interface Node {
  readonly kind: Kind;
  readonly id: string;
}

function insertCandidate(db: SqliteDatabase, candidateId: string): void {
  const title = blob(
    db,
    'candidate_title',
    'notification_candidates',
    candidateId,
  );
  db.prepare(
    "INSERT INTO notification_candidates (candidate_id, request_entity_id, request_revision, source_revision, kind, notification_key, title_blob_id, excerpt_blob_id, state, closed_at, key_delete_at) VALUES (?, NULL, NULL, NULL, 'mail_reply', ?, ?, NULL, 'new', NULL, NULL)",
  ).run(candidateId, `nk-${candidateId}`, title);
}

function insertTurn(db: SqliteDatabase, turnId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES ('s-lineage', 'normal', 'dev-1', 0, NULL, 1000, NULL)",
  ).run();
  const text = blob(db, 'turn_text', 'turns', turnId);
  db.prepare(
    "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, 's-lineage', 'user', 'text', ?, 1000, 9999999999999)",
  ).run(turnId, text);
}

// 元情報 root から nodes を順に派生させる（先頭が root から、各節点が 1 つ前から）。記憶の由来が元情報・記憶・発言の
// ときは memory_sources、それ以外は derivations に書く。
function seedChain(
  db: SqliteDatabase,
  root: string,
  nodes: readonly Node[],
): void {
  let previous: { kind: string; id: string } = {
    kind: 'source_item',
    id: root,
  };
  for (const node of nodes) {
    const sourcedByRow =
      node.kind === 'memory' &&
      (previous.kind === 'source_item' ||
        previous.kind === 'memory' ||
        previous.kind === 'turn');
    if (node.kind === 'memory')
      insertMemory(
        db,
        node.id,
        randomBytes(32).toString('hex'),
        sourcedByRow
          ? [
              {
                source_kind: previous.kind as MemorySource['source_kind'],
                source_id: previous.id,
              },
            ]
          : [],
      );
    else if (node.kind === 'operation_content') completeOperation(db, node.id);
    else if (node.kind === 'turn') insertTurn(db, node.id);
    else insertCandidate(db, node.id);
    if (!sourcedByRow) edge(db, node.kind, node.id, previous.kind, previous.id);
    previous = node;
  }
}

// 中間の節点の実体を期限で消す（記憶は見直し待ちの 30 日、操作は完了から 90 日）。発言の期限削除はまだ storage の
// 命令がないので、行と本文の暗号文を消した状態を作る（系譜の辺には触れない。期限削除は忘却ではない）。
function retire(db: SqliteDatabase, node: Node): void {
  if (node.kind === 'turn') {
    const text = db
      .prepare('SELECT text_blob_id FROM turns WHERE turn_id = ?')
      .pluck()
      .get(node.id) as string;
    db.prepare('DELETE FROM turns WHERE turn_id = ?').run(node.id);
    db.prepare('DELETE FROM sealed_blobs WHERE blob_id = ?').run(text);
    return;
  }
  if (node.kind === 'memory') {
    value(
      memoryOp(db, {
        kind: 'memory.start_review',
        memory_id: node.id,
        now: REVIEW_AT,
      }),
    );
    assert.deepEqual(
      value(
        memoryOp(db, {
          kind: 'memory.delete_due',
          memory_id: node.id,
          now: REVIEW_AT + 30 * DAY,
        }),
      ),
      { memory_id: node.id, deleted: true },
    );
    return;
  }
  assert.equal(node.kind, 'operation_content');
  assert.deepEqual(
    executeRetentionOp(
      db,
      {
        kind: 'retention.purge_operation',
        operation_id: node.id,
        now: COMPLETED_AT + 90 * DAY,
      },
      { platform: 'macos', halted: false },
    ).result,
    { ok: true, value: { operation_id: node.id, purged: true } },
  );
}

function forgetSource(
  db: SqliteDatabase,
  target: MemorySource,
  hmacs: readonly SourceHmacValue[],
): void {
  const { plan, generation } = planFor(db, target, null, hmacs);
  value(
    memoryOp(db, {
      kind: 'forget.apply',
      target,
      instruction_turn_id: null,
      plan: plan as never,
      source_hmacs: hmacs,
      entry_id: randomUUID(),
      previous_generation: generation,
      new_ledger_id: LEDGER_ID,
      now: Date.parse('2031-01-02T03:04:05.678Z'),
    }),
  );
}

// 節点の辺（派生物としての辺と、由来としての辺）を、決まった順で読む。
const edgesOf = (db: SqliteDatabase, kind: string, id: string) =>
  db
    .prepare(
      'SELECT artifact_kind, artifact_id, source_kind, source_id FROM derivations WHERE (artifact_kind = ? AND artifact_id = ?) OR (source_kind = ? AND source_id = ?) ORDER BY artifact_kind, artifact_id, source_kind, source_id',
    )
    .all(kind, id, kind, id);

// ids のどれかを持ち主にする暗号文の数と、ids のどれかに触れる辺（derivations・memory_sources）の数。
const blobsOwnedBy = (db: SqliteDatabase, ids: readonly string[]): number =>
  count(
    db,
    `SELECT count(*) FROM sealed_blobs WHERE owner_id IN (${ids.map(() => '?').join(', ')})`,
    ...ids,
  );
const edgesTouching = (db: SqliteDatabase, ids: readonly string[]): number =>
  count(
    db,
    `SELECT (SELECT count(*) FROM derivations WHERE artifact_id IN (${ids.map(() => '?').join(', ')}) OR source_id IN (${ids.map(() => '?').join(', ')})) + (SELECT count(*) FROM memory_sources WHERE memory_id IN (${ids.map(() => '?').join(', ')}) OR source_id IN (${ids.map(() => '?').join(', ')}))`,
    ...ids,
    ...ids,
    ...ids,
    ...ids,
  );

const SRC = 'remote-src-review-p1';
const A = 'a0000000-0000-4000-8000-00000000000a';
const O = 'e0000000-0000-4000-8000-0000000000a1';
const B = 'n-b-review-p1';
const SRC_HMACS: readonly SourceHmacValue[] = [
  ...HMACS,
  { source_kind: 'source_item', source_id: SRC, hmac: 'a1'.repeat(32) },
];

test('lineage: an operation content purged after 90 days keeps the path from its source to a live notice, and forgetting the source removes the notice', async () => {
  await withWorld((db) => {
    // 元情報 S → 記憶 A → 操作の確定内容 O → 気づき B。
    seedChain(db, SRC, [
      { kind: 'memory', id: A },
      { kind: 'operation_content', id: O },
      { kind: 'notification_candidate', id: B },
    ]);
    // A を期限で消す: O が生きているので A ← S を ID だけで残す。
    retire(db, { kind: 'memory', id: A });
    assert.deepEqual(edgesOf(db, 'memory', A), [
      {
        artifact_kind: 'memory',
        artifact_id: A,
        source_kind: 'source_item',
        source_id: SRC,
      },
      {
        artifact_kind: 'operation_content',
        artifact_id: O,
        source_kind: 'memory',
        source_id: A,
      },
    ]);
    // O を 90 日で消す: O の行は消えるが、B が生きているので O ← A と A ← S を残す。
    retire(db, { kind: 'operation_content', id: O });
    assert.equal(
      count(db, 'SELECT count(*) FROM operations WHERE operation_id = ?', O),
      0,
    );
    assert.deepEqual(edgesOf(db, 'operation_content', O), [
      {
        artifact_kind: 'notification_candidate',
        artifact_id: B,
        source_kind: 'operation_content',
        source_id: O,
      },
      {
        artifact_kind: 'operation_content',
        artifact_id: O,
        source_kind: 'memory',
        source_id: A,
      },
    ]);
    assert.deepEqual(edgesOf(db, 'source_item', SRC), [
      {
        artifact_kind: 'memory',
        artifact_id: A,
        source_kind: 'source_item',
        source_id: SRC,
      },
    ]);
    // S を忘れると B の行・辺・題名の暗号文が消え、残した辺もすべて回収される。
    forgetSource(db, { source_kind: 'source_item', source_id: SRC }, SRC_HMACS);
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM notification_candidates WHERE candidate_id = ?',
        B,
      ),
      0,
    );
    assert.equal(blobsOwnedBy(db, [A, O, B]), 0);
    assert.equal(edgesTouching(db, [SRC, A, O, B]), 0);
    // 関係のない記憶 M_OTHER は残る（行と本文・対象キーの暗号文）。
    assert.equal(
      count(db, 'SELECT count(*) FROM memories WHERE memory_id = ?', M_OTHER),
      1,
    );
    assert.equal(blobsOwnedBy(db, [M_OTHER]), 2);
  });
});

test('lineage: the ID-only edges kept for a live notice are all collected once the notice goes', async () => {
  await withWorld((db) => {
    // 同じ系譜で、B はもう 1 つの由来（発言 T_B）も持つ。A・O を消した後、T_B を忘れて B だけを消す。
    const tB = 'b0000000-0000-4000-8000-00000000000b';
    db.prepare(
      "INSERT INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES ('s-tb', 'normal', 'dev-1', 0, NULL, 1000, NULL)",
    ).run();
    const text = blob(db, 'turn_text', 'turns', tB);
    db.prepare(
      "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, 's-tb', 'user', 'text', ?, 1000, 9999999999999)",
    ).run(tB, text);
    seedChain(db, SRC, [
      { kind: 'memory', id: A },
      { kind: 'operation_content', id: O },
      { kind: 'notification_candidate', id: B },
    ]);
    edge(db, 'notification_candidate', B, 'turn', tB);
    retire(db, { kind: 'memory', id: A });
    retire(db, { kind: 'operation_content', id: O });
    assert.equal(edgesTouching(db, [SRC, A, O, B]), 4);
    forgetSource(db, { source_kind: 'turn', source_id: tB }, SRC_HMACS);
    // B が消えたので、O ← A と A ← S（生きた下流への道として残した辺）も回収される。
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM notification_candidates WHERE candidate_id = ?',
        B,
      ),
      0,
    );
    assert.equal(blobsOwnedBy(db, [tB, A, O, B]), 0);
    assert.equal(edgesTouching(db, [SRC, tB, A, O, B]), 0);
  });
});

test('lineage: an operation content derived from another purged operation content keeps the path to a live notice', async () => {
  await withWorld((db) => {
    // 元情報 S2 → 操作の確定内容 O1 → 操作の確定内容 O2 → 気づき B2。O1・O2 を 90 日で消す。
    const src = 'remote-src-op-op';
    const o1 = 'e0000000-0000-4000-8000-0000000000b1';
    const o2 = 'e0000000-0000-4000-8000-0000000000b2';
    const b2 = 'n-b2-op-op';
    seedChain(db, src, [
      { kind: 'operation_content', id: o1 },
      { kind: 'operation_content', id: o2 },
      { kind: 'notification_candidate', id: b2 },
    ]);
    retire(db, { kind: 'operation_content', id: o1 });
    retire(db, { kind: 'operation_content', id: o2 });
    assert.deepEqual(edgesOf(db, 'source_item', src), [
      {
        artifact_kind: 'operation_content',
        artifact_id: o1,
        source_kind: 'source_item',
        source_id: src,
      },
    ]);
    assert.deepEqual(edgesOf(db, 'operation_content', o2), [
      {
        artifact_kind: 'notification_candidate',
        artifact_id: b2,
        source_kind: 'operation_content',
        source_id: o2,
      },
      {
        artifact_kind: 'operation_content',
        artifact_id: o2,
        source_kind: 'operation_content',
        source_id: o1,
      },
    ]);
    forgetSource(db, { source_kind: 'source_item', source_id: src }, [
      ...HMACS,
      { source_kind: 'source_item', source_id: src, hmac: 'a2'.repeat(32) },
    ]);
    assert.equal(
      count(
        db,
        'SELECT count(*) FROM notification_candidates WHERE candidate_id = ?',
        b2,
      ),
      0,
    );
    assert.equal(blobsOwnedBy(db, [o1, o2, b2]), 0);
    assert.equal(edgesTouching(db, [src, o1, o2, b2]), 0);
  });
});

test('lineage: a memory saved from a turn that was made from a purged operation content is forgotten with the source', async () => {
  await withWorld((db) => {
    // 元情報 S3 → 操作の確定内容 O3 → 発言 T3 → 記憶 M3（M3 は T3 を由来に保存し、明示継続した）。T3 を期限で消し、
    // O3 を 90 日で消す。M3 が生きているので O3 ← S3・T3 ← O3 は ID だけで残り、M3 ← T3 も残る。
    const src = 'remote-src-turn-memory';
    const o3 = 'e0000000-0000-4000-8000-0000000000c3';
    const t3 = 'c3000000-0000-4000-8000-0000000000c3';
    const m3 = 'c3000000-0000-4000-8000-00000000003a';
    seedChain(db, src, [
      { kind: 'operation_content', id: o3 },
      { kind: 'turn', id: t3 },
      { kind: 'memory', id: m3 },
    ]);
    value(
      memoryOp(db, {
        kind: 'memory.start_review',
        memory_id: m3,
        now: REVIEW_AT,
      }),
    );
    value(
      memoryOp(db, {
        kind: 'memory.continue',
        memory_id: m3,
        now: REVIEW_AT + DAY,
      }),
    );
    retire(db, { kind: 'turn', id: t3 });
    retire(db, { kind: 'operation_content', id: o3 });
    assert.deepEqual(edgesOf(db, 'operation_content', o3), [
      {
        artifact_kind: 'operation_content',
        artifact_id: o3,
        source_kind: 'source_item',
        source_id: src,
      },
      {
        artifact_kind: 'turn',
        artifact_id: t3,
        source_kind: 'operation_content',
        source_id: o3,
      },
    ]);
    assert.deepEqual(
      db
        .prepare(
          'SELECT source_kind, source_id FROM memory_sources WHERE memory_id = ?',
        )
        .all(m3),
      [{ source_kind: 'turn', source_id: t3 }],
    );
    forgetSource(db, { source_kind: 'source_item', source_id: src }, [
      ...HMACS,
      { source_kind: 'source_item', source_id: src, hmac: 'a3'.repeat(32) },
    ]);
    // 継続していた M3 の行と本文・対象キーの暗号文が消え、系譜の辺も残らない。
    assert.equal(
      count(db, 'SELECT count(*) FROM memories WHERE memory_id = ?', m3),
      0,
    );
    assert.equal(blobsOwnedBy(db, [o3, t3, m3]), 0);
    assert.equal(edgesTouching(db, [src, o3, t3, m3]), 0);
  });
});

// 合成する系譜の中間の節点の並び（手で並べた）。末尾には、いつも気づき（題名の暗号文を持つ）を付ける。
const CHAIN_SHAPES: readonly (readonly Kind[])[] = [
  ['memory', 'operation_content'],
  ['operation_content', 'operation_content'],
  ['memory', 'memory'],
  ['operation_content', 'memory'],
  ['memory', 'operation_content', 'memory'],
  ['operation_content', 'memory', 'operation_content'],
  // 発言を中間に含む系譜（発言から作った記憶は memory_sources の由来が発言。発言は操作・記憶・元情報から作られる）。
  ['turn', 'memory'],
  ['turn', 'operation_content'],
  ['operation_content', 'turn', 'memory'],
  ['memory', 'turn', 'memory'],
];

// 中間の節点の添字の並べ方すべて（消す順）と、1 つだけ消す場合。
function retireOrders(length: number): number[][] {
  const permutations = (items: number[]): number[][] =>
    items.length <= 1
      ? [items]
      : items.flatMap((item, index) =>
          permutations(items.filter((_, other) => other !== index)).map(
            (rest) => [item, ...rest],
          ),
        );
  const all = Array.from({ length }, (_, index) => index);
  return [...permutations(all), ...all.map((index) => [index])];
}

test('lineage: after forgetting a source, no row, edge or sealed blob of its lineage remains, whichever intermediates expired first', async () => {
  await withWorld((db) => {
    const chains: {
      root: string;
      hmac: SourceHmacValue;
      nodes: Node[];
      order: number[];
    }[] = [];
    let serial = 0;
    for (const shape of CHAIN_SHAPES)
      for (const order of retireOrders(shape.length)) {
        serial += 1;
        const root = `remote-src-general-${serial}`;
        const nodes: Node[] = [
          ...shape.map((kind) => ({ kind, id: randomUUID() })),
          { kind: 'notification_candidate', id: `n-general-${serial}` },
        ];
        chains.push({
          root,
          hmac: {
            source_kind: 'source_item',
            source_id: root,
            hmac: serial.toString(16).padStart(64, '0'),
          },
          nodes,
          order,
        });
        seedChain(db, root, nodes);
      }
    // 中間が 2 つの並び 6 通り × (2! + 2) と、3 つの並び 4 通り × (3! + 3)。
    assert.equal(chains.length, 6 * 4 + 4 * 9);
    for (const chain of chains)
      for (const index of chain.order) retire(db, chain.nodes[index] as Node);
    const hmacs = [...HMACS, ...chains.map((chain) => chain.hmac)];
    for (const chain of chains) {
      const ids = chain.nodes.map((node) => node.id);
      const notice = chain.nodes.at(-1) as Node;
      // 忘れる前は、末尾の気づきの行と題名の暗号文が残っている。
      assert.equal(blobsOwnedBy(db, [notice.id]), 1, chain.root);
      forgetSource(
        db,
        { source_kind: 'source_item', source_id: chain.root },
        hmacs,
      );
      const label = `${chain.nodes.map((node) => node.kind).join('>')} ${chain.order.join(',')}`;
      assert.equal(blobsOwnedBy(db, ids), 0, label);
      assert.equal(edgesTouching(db, [chain.root, ...ids]), 0, label);
      assert.equal(
        count(
          db,
          `SELECT count(*) FROM memories WHERE memory_id IN (${ids.map(() => '?').join(', ')})`,
          ...ids,
        ),
        0,
        label,
      );
      assert.equal(
        count(
          db,
          'SELECT count(*) FROM notification_candidates WHERE candidate_id = ?',
          notice.id,
        ),
        0,
        label,
      );
    }
    // 関係のない記憶 M_OTHER は残る。
    assert.equal(blobsOwnedBy(db, [M_OTHER]), 2);
  });
});
