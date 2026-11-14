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
  applyMigrations,
  buildLedgerFile,
  encodeBackupFile,
  ledgerEntryHash,
  ledgerFileText,
  openWriteConnection,
  parseLedgerFile,
  readBackupFileHeader,
  readLedgerId,
  storagePlatform,
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
  readonly backupDir: string;
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
  return { dataDir, backupDir, handle };
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

// DB の台帳に 1 世代を足す（hash は読み出し時に計算される。0012 より前の行と同じ形）。
// ledger_id は既にあればそれを返す（schema_meta の ledger_id は変えられない）。
function addDbGeneration(dataDir: string, turnId: string): string {
  const entryId = randomUUID();
  const built = buildLedgerEntry(
    {
      forgotten: [{ source_kind: 'turn', source_id: turnId }],
      blocked_source_hmacs: [],
      blocked_content_keys: [],
    },
    {
      entry_id: entryId,
      previous_generation: '0',
      recorded_at: new Date(T0).toISOString(),
    },
  );
  assert.ok(built.ok);
  const db = openWriteConnection(join(dataDir, DB_FILE), {
    platform: storagePlatform(process.platform),
  });
  try {
    db.prepare(
      'INSERT INTO forget_ledger (forgetting_generation, entry_id, recorded_at, entry_hash, item_count) VALUES (1, ?, ?, ?, 1)',
    ).run(entryId, T0, ledgerEntryHash(built.entry, BACKUP_ZERO_HASH));
    db.prepare(
      "INSERT INTO forget_ledger_items (forgetting_generation, item_kind, item_id) VALUES (1, 'turn', ?)",
    ).run(turnId);
    const existing = readLedgerId(db);
    if (existing !== null) return existing;
    const created = randomUUID();
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('ledger_id', ?)",
    ).run(created);
    return created;
  } finally {
    db.close();
  }
}

test('台帳の復旧: 同じ系譜で履歴が分岐しているファイルは退避も再生成もせず拒否する', async (t) => {
  const r = await rig(t);
  const path = join(r.dataDir, FORGET_LEDGER_FILE);
  // DB は世代 1 に対象 A を持つ。封筒は分岐の前（世代 0）のものだけ。
  const ledgerId = addDbGeneration(r.dataDir, randomUUID());
  // ファイルは同じ系譜・同じ世代数のまま、対象 B を持つ（hash が食い違う）。
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
        ledger_id: ledgerId,
        entries: [entry],
        head: { forgetting_generation: '1', entry_hash: entry.entry_hash },
      },
      new Date(T0 + 1000),
    ),
  );
  const before = await readFile(path, 'utf8');
  const report = await repair(r.dataDir);
  assert.equal(report.outcome, 'refused', JSON.stringify(report));
  assert.equal(report.reason, 'ledger_file_diverged');
  assert.equal(report.aside_kept, false);
  // ファイルは変更せず、退避もしない（どちらの履歴が正しいか決められない）。
  assert.equal(await readFile(path, 'utf8'), before);
  const names = await readdir(r.dataDir);
  assert.equal(
    names.some((name) => name.startsWith(`${FORGET_LEDGER_FILE}.repair-`)),
    false,
  );
});

test('台帳の復旧: 契約検査に通らない封筒は、系譜が違っても読み飛ばさず拒否する', async (t) => {
  const r = await rig(t);
  const path = join(r.dataDir, FORGET_LEDGER_FILE);
  // 先に DB と一致するファイルを作る（拒否のときに変更しないことを比べる）。
  const first = await repair(r.dataDir);
  assert.equal(first.outcome, 'rebuilt', JSON.stringify(first));
  const before = await readFile(path, 'utf8');
  // ledger_id が数値の壊れた封筒（マジック・長さ・JSON としては読める）。
  await writeFile(
    join(r.backupDir, 'broken.buddybackup'),
    encodeBackupFile({ ledger_id: 5 }, Buffer.alloc(16)),
  );
  const report = await repair(r.dataDir);
  assert.equal(report.outcome, 'refused', JSON.stringify(report));
  assert.equal(report.reason, 'backup_manifest_invalid');
  assert.equal(report.aside_kept, false);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('台帳の復旧: 系譜のない DB でも封筒が新しい世代なら拒否する', async (t) => {
  const r = await rig(t);
  // 系譜のない DB（まだ忘れていない・忘却の前へ戻された）のデータディレクトリ。
  const dir = await mkdtemp(join(tmpdir(), 'buddy-restore-repair-empty-'));
  onCleanup(t, () =>
    rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(
      () => undefined,
    ),
  );
  const fresh = openWriteConnection(join(dir, DB_FILE), {
    platform: storagePlatform(process.platform),
  });
  try {
    applyMigrations(fresh);
  } finally {
    fresh.close();
  }
  // 新しい世代の封筒を別の置き場所に作り、そこを設定にする。
  const envelopeDir = join(dir, 'backups');
  await mkdir(envelopeDir, { recursive: true });
  const original = (await readdir(r.backupDir)).find((name) =>
    name.endsWith('.buddybackup'),
  );
  assert.ok(original !== undefined);
  const header = await readBackupFileHeader(join(r.backupDir, original));
  assert.ok(header.ok);
  await writeFile(
    join(envelopeDir, 'ahead.buddybackup'),
    encodeBackupFile(
      {
        ...(header.manifest as Record<string, unknown>),
        forgetting_generation: '1',
        ledger_head_hash: 'ab'.repeat(32),
      },
      Buffer.alloc(16),
    ),
  );
  await writeFile(
    join(dir, BACKUP_CONFIG_FILE),
    JSON.stringify({
      schema: 'buddy.backup-config.v1',
      directory: envelopeDir,
      keep_generations: 7,
    }),
    { mode: 0o600 },
  );
  const report = await repair(dir);
  assert.equal(report.outcome, 'refused', JSON.stringify(report));
  assert.equal(report.reason, 'backup_newer_than_ledger');
  // 台帳のファイルは作らない（知らない新しい忘却を安全と報告しない）。
  assert.equal((await readdir(dir)).includes(FORGET_LEDGER_FILE), false);
});

test('台帳の復旧: 書きかけの一時ファイルが DB より進んでいるときは本体を退避せず拒否する', async (t) => {
  const r = await rig(t);
  const path = join(r.dataDir, FORGET_LEDGER_FILE);
  const first = await repair(r.dataDir);
  assert.equal(first.outcome, 'rebuilt', JSON.stringify(first));
  const current = parseLedgerFile(await readFile(path, 'utf8'));
  assert.ok(current !== null);
  // 一時ファイルだけが世代 1 を持つ（本体は壊れている）。
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
  await writeFile(
    join(r.dataDir, `.forget-ledger-${randomUUID()}.tmp`),
    ledgerFileText(
      buildLedgerFile(
        {
          ledger_id: current.ledger_id,
          entries: [entry],
          head: { forgetting_generation: '1', entry_hash: entry.entry_hash },
        },
        new Date(T0 + 1000),
      ),
    ),
  );
  await writeFile(path, '{broken');
  const report = await repair(r.dataDir);
  assert.equal(report.outcome, 'refused', JSON.stringify(report));
  assert.equal(report.reason, 'ledger_file_ahead');
  // 本体は壊れたまま、退避も作らない（Core の起動時の同期も拒否し続けるため）。
  assert.equal(await readFile(path, 'utf8'), '{broken');
  const names = await readdir(r.dataDir);
  assert.equal(
    names.some((name) => name.startsWith(`${FORGET_LEDGER_FILE}.repair-`)),
    false,
  );
});

test('台帳の復旧: 退避の後に書き込めなくても、退避した事実を返す', async (t) => {
  const r = await rig(t);
  const path = join(r.dataDir, FORGET_LEDGER_FILE);
  const first = await repair(r.dataDir);
  assert.equal(first.outcome, 'rebuilt', JSON.stringify(first));
  await writeFile(path, '{broken');
  const report = await runRestoreLedgerRepair({
    dataDir: r.dataDir,
    contract,
    now: () => new Date(T0 + 1000),
    lock: true,
    log: () => undefined,
    writeLedgerFile: async () => {
      throw new Error('injected_write_failure');
    },
  });
  assert.equal(report.outcome, 'refused', JSON.stringify(report));
  assert.equal(report.reason, 'ledger_file_rebuild_failed');
  // 本体は退避名に移っている（壊れたまま。消してはいない）。
  assert.equal(report.aside_kept, true);
  const names = await readdir(r.dataDir);
  const aside = names.find((name) =>
    name.startsWith(`${FORGET_LEDGER_FILE}.repair-`),
  );
  assert.ok(aside !== undefined);
  assert.equal(await readFile(join(r.dataDir, aside), 'utf8'), '{broken');
  assert.equal(names.includes(FORGET_LEDGER_FILE), false);
});
