// 確定 intent の内容 hash（JCS＋SHA-256）と、hash と暗号文を同じ正規形から作る封（設計 08 §2、H01、ADR 0019）。
// 期待値は契約 fixture（h01.json・content-hash-cases.json）の手書きの正規形と、OS の shasum で計算した SHA-256。
// 検査対象の関数（canonicalize と node:crypto）で期待値を作っていない。H01 の値は設計 08 §2 の値を手で写した。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  StorageError,
  canonicalIntentJson,
  executeCommand,
  intentContentHash,
  openOperationIntent,
  sealBlob,
  sealOperationIntent,
} from './index.js';
import type { DataKeyMaterial, SealedEnvelope } from './index.js';
import {
  createCommand,
  databasePath,
  openSeededDatabase,
  storeContext,
  withTempDir,
} from './operation-test-support.js';

function readJson(path: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'),
  );
}

const h01 = readJson('packages/contracts/fixtures/h01.json') as {
  intent: Record<string, unknown>;
  expected_sha256: string;
};
const hashCases = (
  readJson('packages/contracts/fixtures/content-hash-cases.json') as {
    cases: {
      id: string;
      input_json: string;
      expected_canonical: string;
      expected_sha256: string;
    }[];
  }
).cases;
// 設計 08 §2 の H01 の期待値（手で写した値）。
const H01_SHA256 =
  '72c8a8c172bda32f8df7933dca1c490198a0f3670ce03adc40445d55a68b00bf';

const caseOf = (id: string) => {
  const found = hashCases.find((entry) => entry.id === id);
  assert(found, id);
  return found;
};

// 合成の鍵（値に意味はない）。
const dataKey: DataKeyMaterial = {
  keyId: 'data-key-v1',
  key: Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 3) % 256),
};
const otherKey: DataKeyMaterial = {
  keyId: 'data-key-v1',
  key: Uint8Array.from({ length: 32 }, (_, index) => (index * 11 + 5) % 256),
};
const target = {
  operationId: '00000000-0000-4000-8000-000000000001',
  contentVersion: 1,
};

function reasonsOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    assert(error instanceof StorageError, String(error));
    assert.equal(error.reason, 'intent_invalid');
    return error.reasons;
  }
  assert.fail('拒否されませんでした');
}

test('content hashes match the independent expected values of content-hash-cases.json and H01', () => {
  assert.equal(h01.expected_sha256, H01_SHA256);
  assert.equal(intentContentHash(h01.intent), H01_SHA256);
  assert(hashCases.length >= 11);
  for (const entry of hashCases) {
    const intent: unknown = JSON.parse(entry.input_json);
    assert.equal(
      canonicalIntentJson(intent),
      entry.expected_canonical,
      entry.id,
    );
    assert.equal(intentContentHash(intent), entry.expected_sha256, entry.id);
  }
  // 版・対象・配列の順・Unicode の正規化の違いは別の値になる（fixture の注記どおり）。
  const distinct = new Set(hashCases.map((entry) => entry.expected_sha256));
  assert.equal(distinct.size, hashCases.length);
  assert.equal(caseOf('h01').expected_sha256, H01_SHA256);
});

test('values that JSON cannot represent are refused instead of being dropped', () => {
  const base = { schema: 'buddy.operation.v1' };
  const sparse: unknown[] = [];
  sparse[1] = 'x';
  const deep: Record<string, unknown> = {};
  let cursor = deep;
  for (let depth = 0; depth < 65; depth += 1) {
    const next: Record<string, unknown> = {};
    cursor['a'] = next;
    cursor = next;
  }
  class Intent {
    readonly schema = 'buddy.operation.v1';
  }
  const cases: ReadonlyArray<[unknown, string]> = [
    [null, 'intent_not_object'],
    ['text', 'intent_not_object'],
    [[base], 'intent_not_object'],
    [{ ...base, extra: undefined }, 'intent_not_json'],
    [{ ...base, run: () => undefined }, 'intent_not_json'],
    [{ ...base, count: 1n }, 'intent_not_json'],
    [{ ...base, at: new Date(0) }, 'intent_not_json'],
    [{ ...base, labels: new Map() }, 'intent_not_json'],
    [{ ...base, bytes: Buffer.from('a') }, 'intent_not_json'],
    [{ ...base, custom: { toJSON: () => 'x' } }, 'intent_not_json'],
    [{ ...base, [Symbol('s')]: 1 }, 'intent_not_json'],
    [new Intent(), 'intent_not_json'],
    [{ ...base, count: Number.NaN }, 'intent_number_not_finite'],
    [{ ...base, count: Number.POSITIVE_INFINITY }, 'intent_number_not_finite'],
    [{ ...base, label: '\ud800' }, 'intent_lone_surrogate'],
    [{ ...base, ['\udc00']: 'x' }, 'intent_lone_surrogate'],
    [{ ...base, labels: sparse }, 'intent_sparse_array'],
    [deep, 'intent_too_deep'],
  ];
  for (const [intent, reason] of cases)
    assert.deepEqual(
      reasonsOf(() => intentContentHash(intent)),
      [reason],
      reason,
    );
  // 64 段までの入れ子は受け付ける。
  const allowed: Record<string, unknown> = {};
  let inner = allowed;
  for (let depth = 0; depth < 64; depth += 1) {
    const next: Record<string, unknown> = {};
    inner['a'] = next;
    inner = next;
  }
  assert.match(intentContentHash(allowed), /^[0-9a-f]{64}$/u);
});

test('sealOperationIntent makes the hash and the ciphertext from the same canonical bytes', () => {
  const sealed = sealOperationIntent(dataKey, target, h01.intent, 'blob-1');
  assert(sealed.ok);
  assert.equal(sealed.content_hash, H01_SHA256);
  assert.equal(sealed.intent.blob_id, 'blob-1');
  assert.equal(sealed.intent.format_version, 1);
  assert.equal(sealed.intent.key_id, 'data-key-v1');
  assert.equal(sealed.intent.nonce.length, 12);
  assert.equal(sealed.intent.tag.length, 16);
  const envelope: SealedEnvelope = {
    formatVersion: sealed.intent.format_version,
    keyId: sealed.intent.key_id,
    nonce: sealed.intent.nonce,
    ciphertext: sealed.intent.ciphertext,
    tag: sealed.intent.tag,
  };
  const opened = openOperationIntent(dataKey, target, envelope, H01_SHA256);
  assert.deepEqual(opened, {
    ok: true,
    canonical: caseOf('h01').expected_canonical,
    content_hash: H01_SHA256,
  });
  // 別の hash・別の操作・別の内容版・別の鍵では平文を返さない。
  assert.deepEqual(
    openOperationIntent(
      dataKey,
      target,
      envelope,
      caseOf('permission-revision-2').expected_sha256,
    ),
    { ok: false, reason: 'content_hash_mismatch' },
  );
  assert.deepEqual(
    openOperationIntent(
      dataKey,
      { ...target, operationId: '00000000-0000-4000-8000-000000000009' },
      envelope,
      H01_SHA256,
    ),
    { ok: false, reason: 'authentication_failed' },
  );
  assert.deepEqual(
    openOperationIntent(
      dataKey,
      { ...target, contentVersion: 2 },
      envelope,
      H01_SHA256,
    ),
    { ok: false, reason: 'authentication_failed' },
  );
  assert.deepEqual(
    openOperationIntent(otherKey, target, envelope, H01_SHA256),
    { ok: false, reason: 'authentication_failed' },
  );
  assert.deepEqual(openOperationIntent(dataKey, target, envelope, 'H01'), {
    ok: false,
    reason: 'content_hash_invalid',
  });
  // 正規形でない平文（空白入りの JSON）を封じた行は、hash が合っても受け付けない。
  const loose = sealBlob(
    dataKey,
    Buffer.from(caseOf('h01').input_json, 'utf8'),
    {
      ownerTable: 'operation_versions',
      ownerId: target.operationId,
      ownerVersion: 1,
      purpose: 'operation_intent',
    },
  );
  assert(loose.ok);
  assert.deepEqual(
    openOperationIntent(dataKey, target, loose.envelope, H01_SHA256),
    { ok: false, reason: 'intent_not_canonical' },
  );
  // 表せない intent・内容版 0 は封じない。
  assert.deepEqual(
    sealOperationIntent(dataKey, target, { schema: 'x', at: new Date(0) }),
    { ok: false, reason: 'intent_invalid', detail: ['intent_not_json'] },
  );
  assert.deepEqual(
    sealOperationIntent(dataKey, { ...target, contentVersion: 0 }, h01.intent),
    { ok: false, reason: 'owner_invalid', detail: ['owner_invalid'] },
  );
  assert.deepEqual(
    sealOperationIntent(
      { keyId: 'data-key-v1', key: new Uint8Array(16) },
      target,
      h01.intent,
    ),
    { ok: false, reason: 'key_invalid', detail: ['key_invalid'] },
  );
});

test('operation.create stores the content hash made by sealOperationIntent and the row opens again', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      const sealed = sealOperationIntent(dataKey, target, h01.intent);
      assert(sealed.ok);
      const command = {
        ...createCommand(target.operationId, { intent: sealed.intent }),
        content_hash: sealed.content_hash,
      };
      const result = executeCommand(db, command, storeContext());
      assert.equal(result.outcome.outcome, 'durable');
      const version = db
        .prepare(
          'SELECT content_hash, intent_blob_id FROM operation_versions WHERE operation_id = ? AND content_version = 1',
        )
        .get(target.operationId) as {
        content_hash: string;
        intent_blob_id: string;
      };
      assert.equal(version.content_hash, H01_SHA256);
      const row = db
        .prepare(
          'SELECT format_version, key_id, nonce, ciphertext, tag, owner_table, owner_id, owner_version, purpose FROM sealed_blobs WHERE blob_id = ?',
        )
        .get(version.intent_blob_id) as {
        format_version: number;
        key_id: string;
        nonce: Buffer;
        ciphertext: Buffer;
        tag: Buffer;
        owner_table: string;
        owner_id: string;
        owner_version: number;
        purpose: string;
      };
      assert.deepEqual(
        [row.owner_table, row.owner_id, row.owner_version, row.purpose],
        ['operation_versions', target.operationId, 1, 'operation_intent'],
      );
      const opened = openOperationIntent(
        dataKey,
        target,
        {
          formatVersion: row.format_version,
          keyId: row.key_id,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          tag: row.tag,
        },
        version.content_hash,
      );
      assert(opened.ok);
      assert.equal(opened.canonical, caseOf('h01').expected_canonical);
    } finally {
      db.close();
    }
  });
});
