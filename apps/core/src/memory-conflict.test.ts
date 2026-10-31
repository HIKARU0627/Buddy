// 同じ種類・同じ対象キーで内容が違う記憶（J15）の保存の拒否が、DB worker を通って呼び出し元まで理由つきで届くこと
// （ADR 0054 U111。拒否を「失敗」や別の理由に丸めない）。記憶を保存する API の経路はまだない（B06-07）ので、Core が
// 持つ DB worker の口（CoreHandle.store）で確かめる。期待値は手で書いた。鍵は模擬の KeyStore、DB は一時ディレクトリ。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMockKeyStore } from '@buddy/platform';
import { openWriteConnection, storagePlatform } from '@buddy/storage';
import type { MemoryOp, SealedBlobInput } from '@buddy/storage';
import { onCleanup } from './api-test-support.js';
import { startCore } from './core.js';
import type { CoreHandle } from './core.js';
import { DB_FILE } from './paths.js';

const KEY = Buffer.alloc(32, 0x41);
const SESSION = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
const TURN = '7e7e7e7e-7e7e-4e7e-8e7e-7e7e7e7e7e7e';
const TURN_HMAC = 'e7'.repeat(32);
const TARGET_KEY_HASH = 'ab'.repeat(32);

async function start(
  t: test.TestContext,
  dataDir: string,
): Promise<CoreHandle> {
  const handle = await startCore({
    dataDir,
    keyStore: createMockKeyStore({ stored: KEY.toString('base64') }),
    shutdownGraceMs: 200,
    probeTimeoutMs: 300,
  });
  onCleanup(t, async () => {
    await handle.stop('test').catch(() => undefined);
  });
  return handle;
}

function sealed(): SealedBlobInput {
  return {
    blob_id: randomUUID(),
    format_version: 1,
    key_id: 'k-test',
    nonce: randomBytes(12),
    ciphertext: randomBytes(24),
    tag: randomBytes(16),
  };
}

function save(dedupeKey: string): Extract<MemoryOp, { kind: 'memory.save' }> {
  return {
    kind: 'memory.save',
    memory_id: randomUUID(),
    origin: 'explicit_request',
    memory_kind: 'preference',
    text: sealed(),
    target_key: sealed(),
    target_key_hash: TARGET_KEY_HASH,
    dedupe_key: dedupeKey,
    sources: [{ source_kind: 'turn', source_id: TURN }],
    source_hmacs: [{ source_kind: 'turn', source_id: TURN, hmac: TURN_HMAC }],
    forgetting_generation: '0',
    now: 1_000_000,
  };
}

test('a conflicting memory save reaches the caller as memory_conflict_review_required and saves nothing', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'buddy-conflict-'));
  onCleanup(t, () =>
    rm(base, { recursive: true, force: true, maxRetries: 5 }).catch(
      () => undefined,
    ),
  );
  const dataDir = join(base, 'data');
  // 由来の発言（合成）を DB に置く。
  const first = await start(t, dataDir);
  await first.stop('test');
  const db = openWriteConnection(join(dataDir, DB_FILE), {
    platform: storagePlatform(),
  });
  try {
    db.prepare(
      "INSERT INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES (?, 'normal', NULL, 0, NULL, 1000, NULL)",
    ).run(SESSION);
    db.prepare(
      "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, ?, 'user', 'text', NULL, 1000, 9999999999999)",
    ).run(TURN, SESSION);
  } finally {
    db.close();
  }
  const core = await start(t, dataDir);
  const saved = await core.store.memory(save('d1'.repeat(32)));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  // 同じ種類・同じ対象キーで内容が違う。保存せず、理由を丸めずに返す（本人に聞き返す材料）。
  const conflict = await core.store.memory(save('d2'.repeat(32)));
  assert.deepEqual(conflict, {
    ok: false,
    outcome: 'rejected',
    reasons: ['memory_conflict_review_required'],
  });
  await core.stop('test');
  const check = openWriteConnection(join(dataDir, DB_FILE), {
    platform: storagePlatform(),
  });
  try {
    assert.equal(
      check.prepare('SELECT count(*) FROM memories').pluck().get(),
      1,
    );
  } finally {
    check.close();
  }
});
