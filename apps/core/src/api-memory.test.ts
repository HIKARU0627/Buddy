// 記憶の一覧の経路の処理（UI-10、ADR 0183）。DB worker の口は合成の値を返す模擬で、本文の封筒は試験用のデータ鍵で
// 本当に封じた値（開けることまで確かめる）。期待値は手で書いた。経路の検査（ロック・自宅・画面操作の起源）は
// memory-core.test.ts（製品の Core を HTTPS で起動）で確かめる。

import assert from 'node:assert/strict';
import test from 'node:test';
import { sealBlob } from '@buddy/storage';
import type {
  DataKeyMaterial,
  MemoryBlobOutput,
  MemoryListRow,
  MemoryOp,
} from '@buddy/storage';
import { createMemoryRoutes } from './api-memory.js';
import type { ApiHandlerRequest } from './api-server.js';
import { sharedApiContract } from './api-test-support.js';

const contract = sharedApiContract();
const KEY: DataKeyMaterial = { keyId: 'data-key-v1', key: Buffer.alloc(32, 7) };
const OTHER_KEY: DataKeyMaterial = {
  keyId: 'data-key-v1',
  key: Buffer.alloc(32, 8),
};
const M1 = 'b1000000-0000-4000-8000-000000000001';
const M2 = 'b1000000-0000-4000-8000-000000000002';
const DAY = 86_400_000;

function sealedText(
  memoryId: string,
  text: string,
  key: DataKeyMaterial = KEY,
): MemoryBlobOutput {
  const sealed = sealBlob(key, new TextEncoder().encode(text), {
    ownerTable: 'memories',
    ownerId: memoryId,
    ownerVersion: 0,
    purpose: 'memory_text',
  });
  assert(sealed.ok);
  return {
    blob_id: `blob-${memoryId}`,
    format_version: sealed.envelope.formatVersion,
    key_id: sealed.envelope.keyId,
    nonce: sealed.envelope.nonce,
    ciphertext: sealed.envelope.ciphertext,
    tag: sealed.envelope.tag,
  };
}

function row(
  memoryId: string,
  text: MemoryBlobOutput | null,
  overrides: Partial<MemoryListRow> = {},
): MemoryListRow {
  return {
    memory_id: memoryId,
    origin: 'explicit_request',
    kind: 'preference',
    status: 'active',
    created_at: Date.parse('2030-10-01T00:00:00.000Z'),
    review_at: Date.parse('2030-12-30T00:00:00.000Z'),
    delete_at: null,
    text,
    source_counts: { turn: 1, source_item: 2, memory: 0 },
    ...overrides,
  };
}

interface Fake {
  readonly ops: MemoryOp[];
  store: {
    memory(op: MemoryOp): Promise<unknown>;
  };
}

function fakeStore(
  result:
    | { ok: true; value: { rows: MemoryListRow[]; truncated: boolean } }
    | { ok: false; outcome: 'rejected'; reasons: string[] },
): Fake {
  const ops: MemoryOp[] = [];
  return {
    ops,
    store: {
      memory: (op) => {
        ops.push(op);
        return Promise.resolve(result);
      },
    },
  };
}

const request = {} as ApiHandlerRequest;

test('the list opens each text, adds the gate and keeps IDs of sources out', async () => {
  const fake = fakeStore({
    ok: true,
    value: {
      rows: [
        row(M1, sealedText(M1, '返信は短めが好み')),
        row(M2, sealedText(M2, '毎朝 7 時に散歩する'), {
          kind: 'routine',
          origin: 'auto_extraction',
          status: 'review_pending',
          review_at: 90 * DAY,
          delete_at: 120 * DAY,
          source_counts: { turn: 0, source_item: 0, memory: 1 },
        }),
      ],
      truncated: true,
    },
  });
  const routes = createMemoryRoutes({
    store: fake.store as never,
    dataKey: () => Promise.resolve(KEY),
    gate: () => false,
    now: () => 12345,
  });
  const response = await routes.handlers.listMemories(request);
  assert.equal(response.status, 200);
  assert(contract.valid('MemoryListResponse', response.body));
  assert.deepEqual(fake.ops, [
    { kind: 'memory.list', limit: 1000, now: 12345 },
  ]);
  assert.deepEqual(response.body, {
    schema: 'buddy.memory-list.v1',
    forget_gate: 'closed',
    items: [
      {
        memory_id: M1,
        origin: 'explicit_request',
        kind: 'preference',
        text: '返信は短めが好み',
        status: 'active',
        created_at: '2030-10-01T00:00:00.000Z',
        review_at: '2030-12-30T00:00:00.000Z',
        delete_at: null,
        source_counts: { turn: 1, source_item: 2, memory: 0 },
      },
      {
        memory_id: M2,
        origin: 'auto_extraction',
        kind: 'routine',
        text: '毎朝 7 時に散歩する',
        status: 'review_pending',
        created_at: '2030-10-01T00:00:00.000Z',
        review_at: '1970-04-01T00:00:00.000Z',
        delete_at: '1970-05-01T00:00:00.000Z',
        source_counts: { turn: 0, source_item: 0, memory: 1 },
      },
    ],
    truncated: true,
  });
  // ゲートを開いた組み立て（試験用）では open を返す。
  const open = createMemoryRoutes({
    store: fake.store as never,
    dataKey: () => Promise.resolve(KEY),
    gate: () => true,
    now: () => 1,
  });
  const opened = await open.handlers.listMemories(request);
  assert.equal((opened.body as { forget_gate: string }).forget_gate, 'open');
});

test('an empty list is an empty list (not an error)', async () => {
  const routes = createMemoryRoutes({
    store: fakeStore({ ok: true, value: { rows: [], truncated: false } })
      .store as never,
    dataKey: () => Promise.resolve(KEY),
    gate: () => false,
    now: () => 1,
  });
  const response = await routes.handlers.listMemories(request);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    schema: 'buddy.memory-list.v1',
    forget_gate: 'closed',
    items: [],
    truncated: false,
  });
});

test('any row that cannot be opened closes the whole list with 503 (no silent drop)', async () => {
  const cases: [string, MemoryListRow][] = [
    ['no envelope', row(M1, null)],
    ['other key', row(M1, sealedText(M1, '別の鍵', OTHER_KEY))],
    // 別の記憶の封筒を差し替えた（AAD の持ち主が違う）。
    ['other owner', row(M1, sealedText(M2, '差し替え'))],
    ['too long', row(M1, sealedText(M1, 'あ'.repeat(81)))],
    ['empty', row(M1, sealedText(M1, ''))],
  ];
  for (const [label, bad] of cases) {
    const routes = createMemoryRoutes({
      store: fakeStore({
        ok: true,
        value: {
          rows: [row(M2, sealedText(M2, '残る行')), bad],
          truncated: false,
        },
      }).store as never,
      dataKey: () => Promise.resolve(KEY),
      gate: () => false,
      now: () => 1,
    });
    const response = await routes.handlers.listMemories(request);
    assert.equal(response.status, 503, label);
    assert.equal(
      (response.body as { code: string }).code,
      'dependency_unavailable',
      label,
    );
    assert(!JSON.stringify(response.body).includes('残る行'), label);
  }
  // ちょうど 80 文字は返す。
  const edge = createMemoryRoutes({
    store: fakeStore({
      ok: true,
      value: {
        rows: [row(M1, sealedText(M1, 'い'.repeat(80)))],
        truncated: false,
      },
    }).store as never,
    dataKey: () => Promise.resolve(KEY),
    gate: () => false,
    now: () => 1,
  });
  assert.equal((await edge.handlers.listMemories(request)).status, 200);
});

test('no data key or a store failure is 503 and the store is not read without a key', async () => {
  const fake = fakeStore({ ok: true, value: { rows: [], truncated: false } });
  const keyless = createMemoryRoutes({
    store: fake.store as never,
    dataKey: () => Promise.resolve(null),
    gate: () => false,
    now: () => 1,
  });
  assert.equal((await keyless.handlers.listMemories(request)).status, 503);
  const throwing = createMemoryRoutes({
    store: fake.store as never,
    dataKey: () => Promise.reject(new Error('keychain locked')),
    gate: () => false,
    now: () => 1,
  });
  assert.equal((await throwing.handlers.listMemories(request)).status, 503);
  assert.equal(fake.ops.length, 0);
  const failing = createMemoryRoutes({
    store: fakeStore({ ok: false, outcome: 'rejected', reasons: ['x'] })
      .store as never,
    dataKey: () => Promise.resolve(KEY),
    gate: () => false,
    now: () => 1,
  });
  assert.equal((await failing.handlers.listMemories(request)).status, 503);
});
