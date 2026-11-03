// 忘却台帳の手での復旧（ADR 0054 の U109・U129、ADR 0057）の模擬の試験。
// 本物の Core の設定とバックアップで封筒を作り、台帳のファイルを壊す・進める・DB を壊す場合を確かめる。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKUP_ZERO_HASH, buildLedgerEntry } from '@buddy/domain';
import { createMockBackupKeyStore, createMockKeyStore } from '@buddy/platform';
import {
  buildLedgerFile,
  ledgerEntryHash,
  parseLedgerFile,
  writeLedgerFileAtomic,
} from '@buddy/storage';
import type { LedgerChainEntry } from '@buddy/storage';
import { createApiContract } from './api-contract.js';
import { onCleanup } from './api-test-support.js';
import { BACKUP_CONFIG_FILE } from './backup-config.js';
import {
  inspectBackupSetup,
  recordBackupSetup,
  runBackupSetup,
} from './backup-setup.js';
import { startCore } from './core.js';
import type { CoreHandle } from './core.js';
import { DB_FILE, FORGET_LEDGER_FILE } from './paths.js';
import { runRestoreLedgerRepair } from './restore-repair.js';

const DATA_KEY = Buffer.alloc(32, 0x41);
const contract = createApiContract();
const T0 = Date.parse('2031-03-01T00:00:00.000Z');

interface Rig {
  readonly dataDir: string;
  readonly handle: CoreHandle;
}

async function rig(t: test.TestContext): Promise<Rig> {
  const base = await mkdtemp(join(tmpdir(), 'buddy-restore-repair-'));
  onCleanup(t, () =>
    rm(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => undefined),
  );
  const dataDir = join(base, 'data');
  const backupDir = join(base, 'backups');
  await mkdir(backupDir, { recursive: true });
  const keys = createMockBackupKeyStore();
  const dataKeys = createMockKeyStore({ stored: DATA_KEY.toString('base64') });
  const handle = await startCore({
    dataDir,
    keyStore: dataKeys,
    shutdownGraceMs: 200,
    probeTimeoutMs: 300,
    now: () => new Date(T0),
    log: () => undefined,
    backup: { keyStore: keys, scheduler: {} },
  });
  onCleanup(t, async () => {
    await handle.stop('test').catch(() => undefined);
  });
  await writeFile(
    join(dataDir, BACKUP_CONFIG_FILE),
    JSON.stringify({
      schema: 'buddy.backup-config.v1',
      directory: backupDir,
      keep_generations: 7,
    }),
    { mode: 0o600 },
  );
  const setup = await runBackupSetup({
    dataDir,
    contract,
    dataKeys,
    backupKeys: keys,
    now: () => new Date(T0),
    inspect: () => inspectBackupSetup(handle.store),
    record: (ledgerHmacKeyId) =>
      recordBackupSetup({
        dataDir,
        contract,
        store: handle.store,
        backupKeys: keys,
        ledgerHmacKeyId,
      }),
    display: () => undefined,
  });
  assert.ok(setup.ok, JSON.stringify(setup));
  const run = await handle.backup.run();
  assert.ok(run.ok, JSON.stringify(run));
  await handle.stop('test');
  return { dataDir, handle };
}

async function repair(dataDir: string) {
  return runRestoreLedgerRepair({
    dataDir,
    contract,
    now: () => new Date(T0 + 1000),
    lock: true,
    log: () => undefined,
  });
}

test('台帳の復旧: 壊れたファイルを退避し、DB の台帳から作り直す', async (t) => {
  const r = await rig(t);
  const path = join(r.dataDir, FORGET_LEDGER_FILE);
  await repair(r.dataDir);
  const before = JSON.parse(await readFile(path, 'utf8')) as {
    ledger_id: string;
  };
  await writeFile(path, '{broken');
  const report = await repair(r.dataDir);
  assert.equal(report.outcome, 'rebuilt', JSON.stringify(report));
  assert.equal(report.aside_kept, true);
  const after = parseLedgerFile(await readFile(path, 'utf8'));
  assert.ok(after !== null);
  assert.equal(after.ledger_id, before.ledger_id);
  assert.equal(after.entries.length, 0);
  const names = await readdir(r.dataDir);
  assert.equal(
    names.some((name) => name.startsWith(`${FORGET_LEDGER_FILE}.repair-`)),
    true,
  );
});

test('台帳の復旧: DB と一致するファイルは触らない', async (t) => {
  const r = await rig(t);
  const first = await repair(r.dataDir);
  assert.equal(first.outcome, 'rebuilt', JSON.stringify(first));
  const report = await repair(r.dataDir);
  assert.equal(report.outcome, 'no_change', JSON.stringify(report));
  assert.equal(report.aside_kept, false);
});

test('台帳の復旧: ファイルが DB より進んでいるときは作り直さず、復元に進ませる', async (t) => {
  const r = await rig(t);
  const path = join(r.dataDir, FORGET_LEDGER_FILE);
  await repair(r.dataDir);
  const current = parseLedgerFile(await readFile(path, 'utf8'));
  assert.ok(current !== null);
  const built = buildLedgerEntry(
    {
      forgotten: [{ source_kind: 'turn', source_id: randomUUID() }],
      blocked_source_hmacs: [],
      blocked_content_keys: [],
    },
    {
      entry_id: randomUUID(),
      previous_generation: '0',
      recorded_at: new Date(T0).toISOString(),
    },
  );
  assert.ok(built.ok);
  const entry: LedgerChainEntry = {
    entry: built.entry,
    previous_hash: BACKUP_ZERO_HASH,
    entry_hash: ledgerEntryHash(built.entry, BACKUP_ZERO_HASH),
  };
  await writeLedgerFileAtomic(
    path,
    buildLedgerFile(
      {
        ledger_id: current.ledger_id,
        entries: [entry],
        head: {
          forgetting_generation: '1',
          entry_hash: entry.entry_hash,
        },
      },
      new Date(T0 + 1000),
    ),
  );
  const report = await repair(r.dataDir);
  assert.equal(report.outcome, 'refused', JSON.stringify(report));
  assert.equal(report.reason, 'ledger_file_ahead');
  // ファイルはそのまま（進んだ知識を捨てない）。
  const after = parseLedgerFile(await readFile(path, 'utf8'));
  assert.ok(after !== null);
  assert.equal(after.entries.length, 1);
});

test('台帳の復旧: DB の台帳が読めないときは何もしない', async (t) => {
  const r = await rig(t);
  const dbPath = join(r.dataDir, DB_FILE);
  for (const suffix of ['-wal', '-shm'])
    await rm(`${dbPath}${suffix}`, { force: true });
  await writeFile(dbPath, Buffer.alloc(0));
  const report = await repair(r.dataDir);
  assert.equal(report.outcome, 'refused', JSON.stringify(report));
  assert.equal(report.reason, 'hub_ledger_invalid');
});
