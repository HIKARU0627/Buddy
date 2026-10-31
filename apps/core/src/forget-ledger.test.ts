// Core の起動での忘却台帳のファイルと DB の整合、復元した DB の差し替え（ADR 0054）。
// - 忘却を COMMIT した後にファイルを書けずに止まっても、次の起動で DB に合わせて書き直す。
// - ファイルが DB より進んでいる・壊れているときは起動しない（書き換えない）。
// - 0012 より前の台帳の行がある版 11 の DB は、台帳のファイルがなければ系譜を付けて起動し、あれば起動しない（U119）。
// - 復元の後の保留を書いた作業用の DB は、Core が止まっているときだけ差し替えられ、次の起動はその DB で始まる
//   （メモリーの上の接続・リースは作り直される。ADR 0047 の P3-5）。
// 期待値は手で書いた。鍵は模擬の KeyStore、DB は一時ディレクトリ。HMAC は試験用に決めた 64 桁の値。

import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planForget } from '@buddy/domain';
import type { MemorySource } from '@buddy/domain';
import { createMockKeyStore } from '@buddy/platform';
import {
  applyMigrations,
  applyRestoreAftermath,
  loadMigrations,
  openWriteConnection,
  parseLedgerFile,
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

// 版 11 の DB（0012 より前）に、台帳の行（hash・項目の数の列がまだない）を書く。
const LEGACY_ENTRY = '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e';
const LEGACY_MEMORY = 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc';
// {entry, previous_hash} を Python の json.dumps（キーの整列・区切りなし）で書き出し、hashlib の SHA-256 で求めた値。
const LEGACY_HASH =
  '49f69bcd4587f014995cafa0dd021574b8fcac85d44b89b021e508384a47933c';

async function legacyDataDir(t: test.TestContext): Promise<string> {
  const dataDir = await tempDataDir(t);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const db = openWriteConnection(join(dataDir, DB_FILE), {
    platform: storagePlatform(),
  });
  try {
    applyMigrations(db, loadMigrations().slice(0, 11));
    db.prepare(
      'INSERT INTO forget_ledger (forgetting_generation, entry_id, recorded_at) VALUES (1, ?, 1700000000000)',
    ).run(LEGACY_ENTRY);
    db.prepare(
      "INSERT INTO forget_ledger_items (forgetting_generation, item_kind, item_id) VALUES (1, 'memory', ?)",
    ).run(LEGACY_MEMORY);
  } finally {
    db.close();
  }
  return dataDir;
}

function storedLedgerId(dataDir: string): string | null {
  const db = openWriteConnection(join(dataDir, DB_FILE), {
    platform: storagePlatform(),
  });
  try {
    return (
      (db
        .prepare("SELECT value FROM schema_meta WHERE key = 'ledger_id'")
        .pluck()
        .get() as string | undefined) ?? null
    );
  } finally {
    db.close();
  }
}

test('a version-11 DB with ledger rows starts after 0012 by adopting a lineage when no ledger file exists', async (t) => {
  const dataDir = await legacyDataDir(t);
  const ledgerPath = join(dataDir, FORGET_LEDGER_FILE);
  const first = await start(t, dataDir);
  assert.equal(first.store.schemaVersion, 12);
  const exported = await first.store.memory({ kind: 'forget.ledger_export' });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  const ledgerId = exported.ok ? exported.value.ledger_id : null;
  assert.match(
    String(ledgerId),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  await first.stop('test');
  // ファイルは DB と同じ系譜で、旧い行の hash は書き出しで計算した値。
  const file = parseLedgerFile(await readFile(ledgerPath, 'utf8'));
  assert.equal(file?.ledger_id, ledgerId);
  assert.deepEqual(file?.head, {
    forgetting_generation: '1',
    entry_hash: LEGACY_HASH,
  });
  // 次の起動は同じ系譜のまま（付け直さない）。
  const second = await start(t, dataDir);
  await second.stop('test');
  assert.equal(storedLedgerId(dataDir), ledgerId);
});

test('a version-11 DB with ledger rows does not start when a ledger file or a half-written one exists', async (t) => {
  for (const name of [FORGET_LEDGER_FILE, '.forget-ledger-x.tmp']) {
    const dataDir = await legacyDataDir(t);
    // 系譜を確かめられないファイル（中身によらない）。新しい系譜を出さずに起動を止め、ファイルも書き換えない。
    await writeFile(join(dataDir, name), 'unverified');
    assert.deepEqual(await refusal(start(t, dataDir)), [
      'forget_ledger_file',
      'ledger_lineage_unconfirmed',
    ]);
    assert.equal(await readFile(join(dataDir, name), 'utf8'), 'unverified');
    assert.equal(storedLedgerId(dataDir), null);
  }
});
