// 記憶の一覧の命令（memory.list。UI-10 の忘却の画面、ADR 0183）。合成の世界（forget-test-support.ts の seedWorld）に、
// 元情報から作った記憶・見直し待ちの記憶・削除の期限を過ぎた記憶・削除済みの記憶を足して確かめる。
// 期待値は手で書いた（並び・件数・期限の境界）。本文の封筒は合成の乱数で、ここでは開かない（開くのは Core）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { MemoryOpValues, SqliteDatabase } from './index.js';
import {
  M,
  M2,
  M_OTHER,
  blob,
  memoryOp,
  reasons,
  value,
  withWorld,
} from './forget-test-support.js';

const DAY = 86_400_000;
type Listed = MemoryOpValues['memory.list'];

const SOURCE_ITEM_MEMORY = 'a1000000-0000-4000-8000-000000000001';
const REVIEW_MEMORY = 'a1000000-0000-4000-8000-000000000002';
const EXPIRED_MEMORY = 'a1000000-0000-4000-8000-000000000003';
const DELETED_MEMORY = 'a1000000-0000-4000-8000-000000000004';
const NO_TEXT_MEMORY = 'a1000000-0000-4000-8000-000000000005';
// 元サービスの生の ID（合成）。一覧の値に出てこないことを確かめる。
const RAW_SOURCE_ID = 'mail-synthetic-raw-0001';

function insert(
  db: SqliteDatabase,
  memoryId: string,
  options: {
    readonly kind: string;
    readonly status: 'active' | 'review_pending' | 'deleted';
    readonly createdAt: number;
    readonly reviewAt: number;
    readonly deleteAt: number | null;
    readonly origin?: 'auto_extraction' | 'explicit_request';
    readonly textOwner?: string;
  },
): void {
  const text = blob(
    db,
    'memory_text',
    'memories',
    options.textOwner ?? memoryId,
  );
  const key = blob(db, 'memory_target_key', 'memories', memoryId);
  db.prepare(
    'INSERT INTO memories (memory_id, origin, kind, text_blob_id, target_key_blob_id, target_key_hash, dedupe_key, status, created_at, review_at, delete_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    memoryId,
    options.origin ?? 'explicit_request',
    options.kind,
    text,
    key,
    memoryId.replaceAll('-', '').padEnd(64, 'e'),
    memoryId.replaceAll('-', '').padEnd(64, 'f'),
    options.status,
    options.createdAt,
    options.reviewAt,
    options.deleteAt,
  );
}

test('memory.list: newest first, live and review-pending only, source counts without IDs', async () => {
  await withWorld((db) => {
    // 元情報 2 件と発言 1 件から作った記憶（新しい）。
    insert(db, SOURCE_ITEM_MEMORY, {
      kind: 'routine',
      status: 'active',
      createdAt: 5000,
      reviewAt: 9_000_000_000_000,
      deleteAt: null,
      origin: 'auto_extraction',
    });
    for (const [kind, id] of [
      ['source_item', RAW_SOURCE_ID],
      ['source_item', 'mail-synthetic-raw-0002'],
      ['turn', '33333333-3333-4333-8333-333333333333'],
    ] as const)
      db.prepare(
        'INSERT INTO memory_sources (memory_id, source_kind, source_id) VALUES (?, ?, ?)',
      ).run(SOURCE_ITEM_MEMORY, kind, id);
    // 見直し待ち（削除の期限は見直しから 30 日）。
    insert(db, REVIEW_MEMORY, {
      kind: 'goal',
      status: 'review_pending',
      createdAt: 4000,
      reviewAt: 10 * DAY,
      deleteAt: 40 * DAY,
    });
    // 見直し待ちのまま削除の期限を過ぎた記憶（掃除の前）と、削除済みの記憶は出さない。
    insert(db, EXPIRED_MEMORY, {
      kind: 'goal',
      status: 'review_pending',
      createdAt: 3000,
      reviewAt: 5 * DAY,
      deleteAt: 35 * DAY,
    });
    insert(db, DELETED_MEMORY, {
      kind: 'person',
      status: 'deleted',
      createdAt: 6000,
      reviewAt: 9_000_000_000_000,
      deleteAt: 9_000_000_000_001,
    });
    const now = 35 * DAY;
    const listed = value<Listed>(
      memoryOp(db, { kind: 'memory.list', limit: 1000, now }),
    );
    // 新しい順。同じ時刻（seedWorld の 3 件は 1000）は ID の順。
    assert.deepEqual(
      listed.rows.map((row) => row.memory_id),
      [SOURCE_ITEM_MEMORY, REVIEW_MEMORY, M, M2, M_OTHER],
    );
    assert.equal(listed.truncated, false);
    const first = listed.rows[0];
    assert(first !== undefined);
    assert.equal(first.kind, 'routine');
    assert.equal(first.origin, 'auto_extraction');
    assert.equal(first.status, 'active');
    assert.equal(first.delete_at, null);
    assert.deepEqual(first.source_counts, {
      turn: 1,
      source_item: 2,
      memory: 0,
    });
    assert(first.text !== null);
    assert.equal(first.text.nonce.length, 12);
    assert.equal(first.text.tag.length, 16);
    const review = listed.rows[1];
    assert(review !== undefined);
    assert.equal(review.status, 'review_pending');
    assert.equal(review.review_at, 10 * DAY);
    assert.equal(review.delete_at, 40 * DAY);
    // M2 は M から作った記憶（由来は記憶 1 件）。
    assert.deepEqual(listed.rows[3]?.source_counts, {
      turn: 0,
      source_item: 0,
      memory: 1,
    });
    // 由来の ID・元サービスの生の ID・対象キーの hash・内容の HMAC は値に入らない。
    const text = JSON.stringify(listed, (_key, item: unknown) =>
      item instanceof Uint8Array ? null : item,
    );
    assert(!text.includes(RAW_SOURCE_ID));
    assert(!text.includes('33333333-3333-4333-8333-333333333333'));
    assert(!text.includes('dedupe'));
    assert(!text.includes('target_key'));

    // 削除の期限の 1 ms 前は出す（期限ちょうどは出さない）。
    const before = value<Listed>(
      memoryOp(db, { kind: 'memory.list', limit: 1000, now: now - 1 }),
    );
    assert(before.rows.some((row) => row.memory_id === EXPIRED_MEMORY));
  });
});

test('memory.list: the limit cuts the list and says so; a text envelope of another owner is not returned', async () => {
  await withWorld((db) => {
    const cut = value<Listed>(
      memoryOp(db, { kind: 'memory.list', limit: 2, now: 2000 }),
    );
    assert.deepEqual(
      cut.rows.map((row) => row.memory_id),
      [M, M2],
    );
    assert.equal(cut.truncated, true);
    const exact = value<Listed>(
      memoryOp(db, { kind: 'memory.list', limit: 3, now: 2000 }),
    );
    assert.equal(exact.rows.length, 3);
    assert.equal(exact.truncated, false);
    // 本文の封筒の持ち主が別の行（差し替え）なら、封筒を返さない（Core は一覧全体を 503 にする）。
    insert(db, NO_TEXT_MEMORY, {
      kind: 'lexicon',
      status: 'active',
      createdAt: 7000,
      reviewAt: 9_000_000_000_000,
      deleteAt: null,
      textOwner: randomUUID(),
    });
    const listed = value<Listed>(
      memoryOp(db, { kind: 'memory.list', limit: 1000, now: 8000 }),
    );
    assert.equal(listed.rows[0]?.memory_id, NO_TEXT_MEMORY);
    assert.equal(listed.rows[0]?.text, null);
  });
});

test('memory.list: rejects a limit outside 1..1000 and a bad clock', async () => {
  await withWorld((db) => {
    for (const limit of [0, 1001, 1.5, -1])
      assert.deepEqual(
        reasons(memoryOp(db, { kind: 'memory.list', limit, now: 1 })),
        ['limit_invalid'],
        String(limit),
      );
    assert.deepEqual(
      reasons(memoryOp(db, { kind: 'memory.list', limit: 10, now: -1 })),
      ['now_invalid'],
    );
  });
});
