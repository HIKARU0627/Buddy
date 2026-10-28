// Core の起動での忘却台帳のファイルと DB の整合、復元した DB の差し替え（ADR 0054）。
// - 忘却を COMMIT した後にファイルを書けずに止まっても、次の起動で DB に合わせて書き直す。
// - ファイルが DB より進んでいる・壊れているときは起動しない（書き換えない）。
// - 復元の後の保留を書いた作業用の DB は、Core が止まっているときだけ差し替えられ、次の起動はその DB で始まる
//   （メモリーの上の接続・リースは作り直される。ADR 0047 の P3-5）。
// 期待値は手で書いた。鍵は模擬の KeyStore、DB は一時ディレクトリ。HMAC は試験用に決めた 64 桁の値。

import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planForget } from '@buddy/domain';
import type { MemorySource } from '@buddy/domain';
import { createMockKeyStore } from '@buddy/platform';
import {
  applyRestoreAftermath,
  openWriteConnection,
  storagePlatform,
} from '@buddy/storage';
import { onCleanup } from './api-test-support.js';
import { CoreStartError, startCore } from './core.js';
import type { CoreHandle } from './core.js';
import { applyForgetAndSyncLedger } from './forget-ledger.js';
import { LockError } from './lock.js';
import { DB_FILE, FORGET_LEDGER_FILE } from './paths.js';
import { installRestoredDatabase } from './restore-install.js';

const KEY = Buffer.alloc(32, 0x41);
const SOURCE: MemorySource = {
  source_kind: 'source_item',
  source_id: 'mail-001',
};
const SOURCE_HMAC = 'a7'.repeat(32);
const ENTRY = '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a';
const LEDGER = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0';
const NEW_GENERATION = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';

async function tempDataDir(t: test.TestContext): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'buddy-forget-'));
  onCleanup(t, () =>
    rm(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => undefined),
  );
  return join(base, 'data');
}

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

async function refusal(run: Promise<CoreHandle>): Promise<readonly string[]> {
  let handle: CoreHandle;
  try {
    handle = await run;
  } catch (error) {
    assert(error instanceof CoreStartError, String(error));
    assert.equal(error.code, 'store_recovery_failed');
    return error.reasons;
  }
  await handle.stop('test').catch(() => undefined);
  assert.fail('起動が拒否されませんでした');
}

// 元情報（行がなくても台帳に書いて再取り込みを止められる）を忘れる。
async function forgetSource(
  handle: CoreHandle,
  ledgerPath: string,
): Promise<string | null> {
  const read = await handle.store.memory({
    kind: 'forget.graph',
    target: SOURCE,
  });
  assert.equal(read.ok, true);
  if (!read.ok) return null;
  const plan = planForget({
    target: SOURCE,
    instruction_turn_id: null,
    executing_operation_id: null,
    graph: read.value.graph,
    sourceHmac: () => SOURCE_HMAC,
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return null;
  const applied = await applyForgetAndSyncLedger(
    handle.store,
    {
      kind: 'forget.apply',
      target: SOURCE,
      instruction_turn_id: null,
      plan: plan.plan,
      source_hmacs: [{ ...SOURCE, hmac: SOURCE_HMAC }],
      entry_id: ENTRY,
      previous_generation: read.value.forgetting_generation,
      new_ledger_id: LEDGER,
      now: Date.parse('2031-01-01T00:00:00.000Z'),
    },
    ledgerPath,
    new Date('2031-01-01T00:00:01.000Z'),
  );
  assert.equal(applied.result.ok, true, JSON.stringify(applied.result));
  return applied.file;
}

test('Core startup rewrites a ledger file that is behind the DB, and refuses a broken or ahead file', async (t) => {
  const dataDir = await tempDataDir(t);
  const ledgerPath = join(dataDir, FORGET_LEDGER_FILE);
  const first = await start(t, dataDir);
  assert.equal(await forgetSource(first, ledgerPath), 'written');
  const written = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
    ledger_id: string;
    head: { forgetting_generation: string };
    entries: { entry: { forgotten: unknown[] } }[];
  };
  assert.equal(written.ledger_id, LEDGER);
  assert.equal(written.head.forgetting_generation, '1');
  // 元情報は生の ID ではなく HMAC だけが書かれる。
  assert.deepEqual(written.entries[0]?.entry.forgotten, [
    { source_kind: 'source_item', source_id_hmac: SOURCE_HMAC },
  ]);
  assert.equal(
    (await readFile(ledgerPath, 'utf8')).includes('mail-001'),
    false,
  );
  await first.stop('test');
  const text = await readFile(ledgerPath, 'utf8');
  // COMMIT の後・ファイルを書く前に止まった（ファイルがない）: 次の起動で書き直す。
  await rm(ledgerPath);
  const second = await start(t, dataDir);
  assert.equal(
    await readFile(ledgerPath, 'utf8').then(
      (value) => JSON.parse(value).head.forgetting_generation,
    ),
    '1',
  );
  await second.stop('test');
  // 壊れたファイルは書き換えずに起動を止める。
  await writeFile(ledgerPath, '{"schema":');
  assert.deepEqual(await refusal(start(t, dataDir)), [
    'forget_ledger_file',
    'ledger_file_invalid',
  ]);
  assert.equal(await readFile(ledgerPath, 'utf8'), '{"schema":');
  // 台帳のない DB に、項目のあるファイル（DB が古い状態へ戻された疑い）。
  const fresh = await tempDataDir(t);
  const freshCore = await start(t, fresh);
  await freshCore.stop('test');
  await writeFile(join(fresh, FORGET_LEDGER_FILE), text);
  assert.deepEqual(await refusal(start(t, fresh)), [
    'forget_ledger_file',
    'ledger_file_ahead',
  ]);
});

test('a restored working DB is installed only while Core is stopped, and the next start uses it', async (t) => {
  const dataDir = await tempDataDir(t);
  const core = await start(t, dataDir);
  const before = core.storeGeneration;
  const working = join(dataDir, '..', 'restore-working.sqlite');
  // 作業用の DB（復元で取り出した DB の代わりに、今の DB の写し）に、復元の後の保留を書く。
  await core.stop('test');
  await copyFile(join(dataDir, DB_FILE), working);
  const restarted = await start(t, dataDir);
  const db = openWriteConnection(working, { platform: storagePlatform() });
  try {
    const result = applyRestoreAftermath(db, {
      restored_at: Date.parse('2031-03-01T00:00:00.000Z'),
      backup_created_at: Date.parse('2031-02-28T00:00:00.000Z'),
      new_store_generation: NEW_GENERATION,
      pre_restore: null,
    });
    assert.equal(result.safety_revision, '1');
  } finally {
    db.close();
  }
  // Core が動いている間は差し替えない。
  await assert.rejects(
    installRestoredDatabase({
      dataDir,
      workingPath: working,
      endpoint: restarted.endpoint,
      probeTimeoutMs: 300,
    }),
    (error: unknown) =>
      error instanceof LockError && error.reason === 'already_running',
  );
  assert.equal(restarted.storeGeneration, before);
  await restarted.stop('test');
  await installRestoredDatabase({
    dataDir,
    workingPath: working,
    endpoint: restarted.endpoint,
    probeTimeoutMs: 300,
  });
  const after = await start(t, dataDir);
  assert.equal(after.storeGeneration, NEW_GENERATION);
});
