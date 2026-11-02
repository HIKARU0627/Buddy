// 復元の段階 1〜2（台帳の確認・鍵の取り出し・封筒の検証・期限切れの削除の前提）の試験（ADR 0056、U128・U130）。
// 模擬だけ: 実機のキーチェーン・実際の Mac mini・実データは使わない。バックアップはテストの中で Core の本物の
// 設定と作成の流れで作り、復旧キーだけを画面に出した値から独立に戻す（実装と同じ処理で期待値を作らない）。

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
import {
  BACKUP_EXCLUDED_TABLES,
  decodeRecoveryCode,
  encodeRecoveryCode,
} from '@buddy/domain';
import { createMockBackupKeyStore, createMockKeyStore } from '@buddy/platform';
import type { MockBackupKeyStore } from '@buddy/platform';
import {
  decryptBackupPayload,
  encodeBackupFile,
  manifestPayloadKey,
  openWriteConnection,
  readBackupFileHeader,
  readBackupPayload,
  storagePlatform,
  unwrapBackupKey,
} from '@buddy/storage';
import type { BackupKeyWrapValue } from '@buddy/storage';
import { createApiContract } from './api-contract.js';
import { onCleanup } from './api-test-support.js';
import { BACKUP_CONFIG_FILE } from './backup-config.js';
import { BACKUP_KEY_FILE, BACKUP_STATE_FILE } from './backup-files.js';
import { CLOCK_STATE_FILE } from './paths.js';
import {
  inspectBackupSetup,
  recordBackupSetup,
  runBackupSetup,
} from './backup-setup.js';
import { startCore } from './core.js';
import type { CoreHandle } from './core.js';
import { DB_FILE, FORGET_LEDGER_FILE } from './paths.js';
import {
  RESTORE_WORK_DIR,
  ledgerHistoriesDiverge,
  runRestoreCheck,
} from './restore-check.js';
import { readRecoveryKeyFromTty } from './restore-tty.js';
import type { TtyInput } from './restore-tty.js';

const DATA_KEY = Buffer.alloc(32, 0x41);
const contract = createApiContract();
const T0 = Date.parse('2031-03-01T00:00:00.000Z');

interface Rig {
  readonly dataDir: string;
  readonly backupDir: string;
  readonly handle: CoreHandle;
  readonly keys: MockBackupKeyStore;
  readonly backupPath: string;
  readonly recoveryCode: string;
}

async function rig(t: test.TestContext): Promise<Rig> {
  const base = await mkdtemp(join(tmpdir(), 'buddy-restore-check-'));
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
  const displayed: string[] = [];
  const handle = await startCore({
    dataDir,
    keyStore: createMockKeyStore({ stored: DATA_KEY.toString('base64') }),
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
    dataKeys: createMockKeyStore({ stored: DATA_KEY.toString('base64') }),
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
    display: (shown) => displayed.push(shown.recovery_code),
  });
  assert.ok(setup.ok, JSON.stringify(setup));
  const run = await handle.backup.run();
  assert.ok(run.ok, JSON.stringify(run));
  const files = (await readdir(backupDir)).filter((name) =>
    name.endsWith('.buddybackup'),
  );
  assert.equal(files.length, 1);
  const recoveryCode = displayed.at(-1);
  assert.ok(recoveryCode !== undefined);
  return {
    dataDir,
    backupDir,
    handle,
    keys,
    backupPath: join(backupDir, files[0] as string),
    recoveryCode,
  };
}

async function check(
  r: Rig,
  overrides: {
    readonly recoveryKey?: Uint8Array;
    readonly backupPath?: string;
    readonly dataKeys?: ReturnType<typeof createMockKeyStore>;
    readonly backupKeys?: MockBackupKeyStore;
    readonly writeWorkingDatabase?: (
      workDir: string,
      bytes: Uint8Array,
    ) => Promise<string>;
    readonly removeWorkDir?: (workDir: string) => Promise<void>;
  } = {},
) {
  const recoveryKey =
    overrides.recoveryKey ??
    Buffer.from(decodeRecoveryCode(r.recoveryCode) as Uint8Array);
  return runRestoreCheck({
    dataDir: r.dataDir,
    contract,
    backupPath: overrides.backupPath ?? r.backupPath,
    recoveryKey,
    dataKeys:
      overrides.dataKeys ??
      createMockKeyStore({ stored: DATA_KEY.toString('base64') }),
    backupKeys: overrides.backupKeys ?? r.keys,
    now: () => new Date(T0 + 1000),
    lock: true,
    log: () => undefined,
    ...(overrides.writeWorkingDatabase === undefined
      ? {}
      : { writeWorkingDatabase: overrides.writeWorkingDatabase }),
    ...(overrides.removeWorkDir === undefined
      ? {}
      : { removeWorkDir: overrides.removeWorkDir }),
  });
}

const workDirEntries = async (dataDir: string): Promise<string[]> =>
  readdir(join(dataDir, RESTORE_WORK_DIR)).catch(() => []);

test('復元の確認: 封筒・鍵・本体・台帳を確かめ、作業用の DB に期限の掃除を当てて ready になる（写しは残らない）', async (t) => {
  const r = await rig(t);
  await r.handle.stop('test');

  const report = await check(r);
  assert.equal(report.schema, 'buddy.restore-check.v1');
  assert.equal(report.outcome, 'ready', JSON.stringify(report));
  assert.equal(report.stages.length, 2);
  assert.deepEqual(
    report.stages.map((stage) => [stage.stage, stage.status]),
    [
      ['ledger_check', 'passed'],
      ['expiry_purge', 'passed'],
    ],
  );
  assert.equal(report.ledger?.holder, 'hub');
  assert.equal(report.settings_only_eligible, false);
  // 復号した本文は作業用のディレクトリに残さない。
  assert.deepEqual(await workDirEntries(r.dataDir), []);

  // 封筒は生音声・記録しない会話・OAuth トークン・API キーを含めないと記録している。
  const header = await readBackupFileHeader(r.backupPath);
  assert.ok(header.ok);
  const manifest = header.manifest as Record<string, unknown>;
  assert.deepEqual(manifest['excluded_data'], [
    'raw_audio',
    'private_conversation',
    'oauth_tokens',
    'api_keys',
  ]);
  assert.deepEqual(manifest['included_storage_modes'], ['normal', 'extended']);

  // 本体（復号した DB）には、含めない表がない（含めない表とその暗号文は写しから消えている）。
  const wrap = (manifest['key_wraps'] as BackupKeyWrapValue[]).find(
    (entry) => entry.purpose === 'backup_file',
  );
  assert.ok(wrap !== undefined);
  const backupKey = unwrapBackupKey(
    Buffer.from(decodeRecoveryCode(r.recoveryCode) as Uint8Array),
    wrap,
  );
  assert.ok(backupKey !== null);
  const payload = manifest['payload'] as { bytes: number; sha256: string };
  const encrypted = await readBackupPayload(
    r.backupPath,
    header.payload_offset,
    payload.bytes,
  );
  assert.ok(encrypted !== null);
  // 復号の鍵の導き方は storage の実装を使う（暗号の検証は backup-crypto の試験が持つ）。
  const keyInfo = manifestPayloadKey(manifest);
  assert.ok(keyInfo !== null);
  const database = decryptBackupPayload(
    { key: backupKey, keyId: keyInfo.keyId, fields: keyInfo.fields },
    encrypted,
  );
  assert.ok(database !== null);
  const copy = join(r.dataDir, 'payload-copy.sqlite');
  await writeFile(copy, database);
  const db = openWriteConnection(copy, {
    platform: storagePlatform(process.platform),
  });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .pluck()
      .all() as string[];
    // 含めない表は行を消してある（表の形は残る。ADR 0047 の U73）。
    for (const excluded of Object.keys(BACKUP_EXCLUDED_TABLES)) {
      assert.equal(tables.includes(excluded), true, excluded);
      const count = db
        .prepare(`SELECT COUNT(*) FROM "${excluded}"`)
        .pluck()
        .get() as number;
      assert.equal(count, 0, excluded);
    }
    // 含めない表が持つ暗号文（sealed_blobs）も写しから消えている。
    const blobs = db
      .prepare(
        `SELECT COUNT(*) FROM sealed_blobs WHERE owner_table IN (${Object.keys(
          BACKUP_EXCLUDED_TABLES,
        )
          .map(() => '?')
          .join(',')})`,
      )
      .pluck()
      .get(...Object.keys(BACKUP_EXCLUDED_TABLES)) as number;
    assert.equal(blobs, 0);
  } finally {
    db.close();
  }
  await rm(copy, { force: true });
});

test('復元の確認: 作業用の DB の書き込みが途中で失敗しても平文を残さない', async (t) => {
  const r = await rig(t);
  await r.handle.stop('test');
  const report = await check(r, {
    writeWorkingDatabase: async (workDir) => {
      await mkdir(workDir, { recursive: true });
      await writeFile(join(workDir, 'buddy.sqlite'), 'plaintext-partial');
      throw new Error('injected_write_failure');
    },
  });
  assert.equal(report.outcome, 'rejected');
  assert.equal(report.raw_payload_decrypted, false);
  assert.deepEqual(await workDirEntries(r.dataDir), []);
});

test('復元の確認: backup-keys.json を失っても、KeyStore に同じ ID で違う素材の鍵があれば止まる', async (t) => {
  const r = await rig(t);
  await r.handle.stop('test');
  const header = await readBackupFileHeader(r.backupPath);
  assert.ok(header.ok);
  const manifest = header.manifest as Record<string, unknown>;
  const wrap = (manifest['key_wraps'] as BackupKeyWrapValue[]).find(
    (entry) => entry.purpose === 'backup_file',
  );
  assert.ok(wrap !== undefined);
  await rm(join(r.dataDir, BACKUP_KEY_FILE), { force: true });
  // 同じ ID で違う素材の鍵を KeyStore に置く（取り違え）。
  r.keys.overwrite(
    'backup_file',
    wrap.key_id,
    Buffer.alloc(32, 0x7f).toString('base64'),
  );
  const report = await check(r);
  assert.equal(report.outcome, 'rejected');
  assert.ok(report.stages[1]?.reasons.includes('backup_unreadable'));
});

test('復元の確認: 中枢の DB が読めないときは、別ファイルだけで最新の台帳を確定しない', async (t) => {
  const r = await rig(t);
  await r.handle.stop('test');
  // DB はあるが、台帳の表を持たない（読めない）。別ファイルには古い世代の連鎖が残っている。
  const dbPath = join(r.dataDir, DB_FILE);
  for (const suffix of ['-wal', '-shm'])
    await rm(`${dbPath}${suffix}`, { force: true });
  await writeFile(dbPath, Buffer.alloc(0));
  const report = await check(r);
  assert.equal(report.outcome, 'rejected', JSON.stringify(report));
  assert.equal(report.stages[0]?.status, 'failed');
  assert.ok(
    report.stages[0]?.reasons.includes('latest_ledger_unconfirmed'),
    JSON.stringify(report.stages),
  );
  assert.equal(report.settings_only_eligible, true);
});

test('復元の確認: 中枢の DB の台帳の連鎖が壊れているときは設定だけの候補にもしない', async (t) => {
  const r = await rig(t);
  await r.handle.stop('test');
  const db = openWriteConnection(join(r.dataDir, DB_FILE), {
    platform: storagePlatform(process.platform),
  });
  try {
    // 正しい形で 1 件入れるが、保存する hash を計算値と違う値にする（読むときに食い違う）。
    db.prepare(
      'INSERT INTO forget_ledger (forgetting_generation, entry_id, recorded_at, entry_hash, item_count) VALUES (1, ?, ?, ?, 1)',
    ).run(randomUUID(), T0, '1'.repeat(64));
    db.prepare(
      "INSERT INTO forget_ledger_items (forgetting_generation, item_kind, item_id) VALUES (1, 'turn', ?)",
    ).run(randomUUID());
  } finally {
    db.close();
  }
  const report = await check(r);
  assert.equal(report.outcome, 'rejected', JSON.stringify(report));
  assert.equal(report.stages[0]?.status, 'failed');
  assert.ok(
    report.stages[0]?.reasons.includes('ledger_chain_invalid'),
    JSON.stringify(report.stages),
  );
  assert.equal(report.settings_only_eligible, false);
});

test('復元の確認: 封筒の鍵 ID が別の用途の KeyStore 項目にある衝突も見つける', async (t) => {
  const r = await rig(t);
  await r.handle.stop('test');
  const header = await readBackupFileHeader(r.backupPath);
  assert.ok(header.ok);
  const manifest = header.manifest as Record<string, unknown>;
  const wrap = (manifest['key_wraps'] as BackupKeyWrapValue[]).find(
    (entry) => entry.purpose === 'backup_file',
  );
  assert.ok(wrap !== undefined);
  // 鍵の記録ファイルを失い、封筒の backup_file の ID を ledger_hmac_key の項目にも置く（別用途の衝突）。
  await rm(join(r.dataDir, BACKUP_KEY_FILE), { force: true });
  const placed = await r.keys.put(
    'ledger_hmac_key',
    wrap.key_id,
    Buffer.alloc(32, 0x6a),
  );
  assert.equal(placed.ok, true, JSON.stringify(placed));
  const report = await check(r);
  assert.equal(report.outcome, 'rejected', JSON.stringify(report));
  assert.equal(report.stages[0]?.status, 'passed');
  assert.ok(report.stages[1]?.reasons.includes('backup_unreadable'));
});

test('復元の確認: KeyStore の読み取り障害・不正な保存値を鍵の欠落として扱わない', async (t) => {
  const r = await rig(t);
  await r.handle.stop('test');

  await t.test('バックアップの鍵が読めない', async () => {
    const report = await check(r, {
      backupKeys: createMockBackupKeyStore({ available: false }),
    });
    assert.equal(report.outcome, 'rejected', JSON.stringify(report));
    assert.equal(report.stages[0]?.status, 'passed');
    assert.ok(report.stages[1]?.reasons.includes('backup_unreadable'));
  });

  await t.test('データ鍵が読めない', async () => {
    const report = await check(r, {
      dataKeys: createMockKeyStore({ available: false }),
    });
    assert.equal(report.outcome, 'rejected', JSON.stringify(report));
    assert.equal(report.stages[0]?.status, 'passed');
    assert.ok(report.stages[1]?.reasons.includes('backup_unreadable'));
  });
});

test('復元の確認: バックアップの状態ファイルが壊れているときは、正常な時計の記録だけを信じない', async (t) => {
  const r = await rig(t);
  await r.handle.stop('test');
  // 保存期限の時計の記録は正常（復元の「今」より前）。
  const at = '2031-02-01T00:00:00.000Z';
  await writeFile(
    join(r.dataDir, CLOCK_STATE_FILE),
    JSON.stringify({
      schema: 'buddy.clock-state.v1',
      revision: 0,
      last_checked_at: at,
      epoch: randomUUID(),
      epoch_started_at: at,
      written_at: at,
      rechecks: [],
      storage_boundary: null,
    }),
  );
  // より新しい最終確認時刻を持ち得るバックアップの状態ファイルを壊す。
  await writeFile(join(r.dataDir, BACKUP_STATE_FILE), '{broken');
  const report = await check(r);
  assert.equal(report.outcome, 'rejected', JSON.stringify(report));
  assert.equal(report.stages[0]?.status, 'passed');
  assert.ok(report.stages[1]?.reasons.includes('clock_regression'));
});

test('復元の確認: 既存の中枢 DB があるのに時計の記録がないときは、期限を判定せず止める', async (t) => {
  const r = await rig(t);
  await r.handle.stop('test');
  await rm(join(r.dataDir, CLOCK_STATE_FILE), { force: true });
  const report = await check(r);
  assert.equal(report.outcome, 'rejected', JSON.stringify(report));
  assert.equal(report.stages[0]?.status, 'passed');
  assert.ok(report.stages[1]?.reasons.includes('clock_regression'));
});

test('復元の確認: 作業用の DB を開けないときも、拒否レポートを返して平文を残さない', async (t) => {
  const r = await rig(t);
  await r.handle.stop('test');
  const report = await check(r, {
    writeWorkingDatabase: async (workDir) => {
      await mkdir(workDir, { recursive: true });
      const path = join(workDir, DB_FILE);
      await writeFile(path, 'this is not a sqlite database');
      return path;
    },
  });
  assert.equal(report.outcome, 'rejected', JSON.stringify(report));
  assert.equal(report.stages[0]?.status, 'passed');
  assert.ok(
    report.stages[1]?.reasons.includes('backup_unreadable'),
    JSON.stringify(report.stages),
  );
  assert.deepEqual(await workDirEntries(r.dataDir), []);
});

test('復元の確認: 作業用の平文の DB を消せないときは成功を返さず、明示的に失敗を報告する', async (t) => {
  const r = await rig(t);
  await r.handle.stop('test');
  const report = await check(r, {
    removeWorkDir: async () => {
      throw new Error('injected_delete_failure');
    },
  });
  assert.equal(report.outcome, 'rejected');
  assert.equal(report.stages[0]?.status, 'passed');
  assert.ok(report.stages.at(-1)?.reasons.includes('plaintext_delete_failed'));
});

test('台帳の履歴が共通の世代で食い違う（分岐）ことを検出する', () => {
  const entry = (hash: string) => ({ entry_hash: hash });
  assert.equal(ledgerHistoriesDiverge([], []), false);
  assert.equal(ledgerHistoriesDiverge([entry('a')], [entry('a')]), false);
  // 片方だけが進んでいるのは分岐ではない。
  assert.equal(
    ledgerHistoriesDiverge([entry('a')], [entry('a'), entry('b')]),
    false,
  );
  assert.equal(
    ledgerHistoriesDiverge([entry('a'), entry('b')], [entry('a'), entry('c')]),
    true,
  );
});

test('復元の確認: 保存期限の時計の記録が読めない・巻き戻っているときは段階2で止める', async (t) => {
  const r = await rig(t);
  await r.handle.stop('test');
  const clockPath = join(r.dataDir, CLOCK_STATE_FILE);
  let clock: Record<string, unknown>;
  try {
    clock = JSON.parse(await readFile(clockPath, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    const at = '2031-02-01T00:00:00.000Z';
    clock = {
      schema: 'buddy.clock-state.v1',
      revision: 0,
      last_checked_at: at,
      epoch: randomUUID(),
      epoch_started_at: at,
      written_at: at,
      rechecks: [],
      storage_boundary: null,
    };
  }
  // 保存期限の時計の最終確認時刻を、復元の「今」（T0 + 1 秒）より先にする（巻き戻り）。
  await writeFile(
    clockPath,
    JSON.stringify({
      ...clock,
      last_checked_at: '2032-01-01T00:00:00.000Z',
    }),
  );
  const regressed = await check(r);
  assert.equal(regressed.outcome, 'rejected');
  assert.equal(regressed.stages[0]?.status, 'passed');
  assert.ok(regressed.stages[1]?.reasons.includes('clock_regression'));

  // 時計の記録が読めないときも、期限を判定できない。
  await writeFile(clockPath, '{not json');
  const invalid = await check(r);
  assert.equal(invalid.outcome, 'rejected');
  assert.ok(invalid.stages[1]?.reasons.includes('clock_regression'));
});

test('復元の確認: 復旧キーが違う・本体が壊れている・封筒が private を含むときは止まる', async (t) => {
  const r = await rig(t);
  await r.handle.stop('test');
  const header = await readBackupFileHeader(r.backupPath);
  assert.ok(header.ok);
  const manifest = header.manifest as Record<string, unknown>;
  const payload = manifest['payload'] as { bytes: number; sha256: string };
  const encrypted = await readBackupPayload(
    r.backupPath,
    header.payload_offset,
    payload.bytes,
  );
  assert.ok(encrypted !== null);

  await t.test('復旧キーが違う', async () => {
    const other = Buffer.alloc(32, 0x42);
    const report = await check(r, {
      recoveryKey: Buffer.from(
        decodeRecoveryCode(encodeRecoveryCode(other)) as Uint8Array,
      ),
    });
    assert.equal(report.outcome, 'rejected');
    assert.equal(report.stages[0]?.status, 'passed');
    assert.equal(report.stages[1]?.status, 'failed');
    assert.ok(report.stages[1]?.reasons.includes('backup_unreadable'));
  });

  await t.test('本体を 1 バイト書き換えた', async () => {
    const tampered = join(r.backupDir, 'tampered.buddybackup');
    const bytes = Buffer.from(await readFile(r.backupPath));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
    await writeFile(tampered, bytes);
    const report = await check(r, { backupPath: tampered });
    assert.equal(report.outcome, 'rejected');
    assert.equal(report.stages[0]?.status, 'passed');
    assert.ok(report.stages[1]?.reasons.includes('backup_unreadable'));
  });

  await t.test('封筒が private を含む', async () => {
    const privatePath = join(r.backupDir, 'private.buddybackup');
    await writeFile(
      privatePath,
      encodeBackupFile(
        {
          ...manifest,
          included_storage_modes: ['normal', 'extended', 'private'],
        },
        encrypted,
      ),
    );
    const report = await check(r, { backupPath: privatePath });
    assert.equal(report.outcome, 'rejected');
    assert.equal(report.stages[0]?.status, 'failed');
    assert.ok(report.stages[0]?.reasons.includes('manifest_invalid'));
  });
});

test('復元の確認: 台帳の系譜が違えば止め、台帳をすべて失っていれば設定だけの候補として報告する', async (t) => {
  const r = await rig(t);
  await r.handle.stop('test');

  // 封筒の系譜を、中枢の台帳と違う値にする（別の系譜のバックアップを戻さない）。
  const header = await readBackupFileHeader(r.backupPath);
  assert.ok(header.ok);
  const manifest = header.manifest as Record<string, unknown>;
  const payload = manifest['payload'] as { bytes: number; sha256: string };
  const encrypted = await readBackupPayload(
    r.backupPath,
    header.payload_offset,
    payload.bytes,
  );
  assert.ok(encrypted !== null);
  const otherLineage = join(r.backupDir, 'other-lineage.buddybackup');
  await writeFile(
    otherLineage,
    encodeBackupFile(
      {
        ...manifest,
        ledger_id: '11111111-1111-4111-8111-111111111111',
      },
      encrypted,
    ),
  );
  const mismatch = await check(r, { backupPath: otherLineage });
  assert.equal(mismatch.outcome, 'rejected');
  assert.equal(mismatch.stages[0]?.status, 'failed');
  assert.ok(mismatch.stages[0]?.reasons.includes('ledger_lineage_mismatch'));
  assert.equal(mismatch.settings_only_eligible, false);

  // 書きかけの台帳の一時ファイルがあると、確定していないより新しい世代を持ち得るので合格にしない。
  const tempPath = join(r.dataDir, '.forget-ledger-test.tmp');
  await writeFile(tempPath, '{}');
  const temp = await check(r);
  assert.equal(temp.outcome, 'rejected');
  assert.ok(temp.stages[0]?.reasons.includes('latest_ledger_unconfirmed'));
  assert.equal(temp.settings_only_eligible, true);
  await rm(tempPath, { force: true });

  // 台帳の別ファイルが壊れているときは、DB だけを最新として合格にしない（より新しい世代を落とし得る）。
  await writeFile(join(r.dataDir, FORGET_LEDGER_FILE), '{broken');
  const corrupt = await check(r);
  assert.equal(corrupt.outcome, 'rejected');
  assert.equal(corrupt.stages[0]?.status, 'failed');
  assert.ok(corrupt.stages[0]?.reasons.includes('ledger_chain_invalid'));
  assert.equal(corrupt.settings_only_eligible, false);

  // 中枢の DB と台帳の別ファイルをどちらも失う（中枢を失って複製もない）。
  const dbPath = join(r.dataDir, DB_FILE);
  for (const suffix of ['', '-wal', '-shm'])
    await rm(`${dbPath}${suffix}`, { force: true });
  await rm(join(r.dataDir, FORGET_LEDGER_FILE), { force: true });
  const lost = await check(r);
  assert.equal(lost.outcome, 'rejected');
  assert.equal(lost.stages[0]?.status, 'failed');
  assert.ok(lost.stages[0]?.reasons.includes('latest_ledger_unconfirmed'));
  assert.equal(lost.settings_only_eligible, true);
});

test('復元の確認: Core が動いているときは台帳も封筒も読まずに拒否する', async (t) => {
  const r = await rig(t);
  const report = await check(r);
  assert.equal(report.outcome, 'rejected');
  assert.deepEqual(
    report.stages.map((stage) => [stage.stage, 'core_running']),
    [['ledger_check', 'core_running']],
  );
  assert.equal(report.raw_payload_decrypted, false);
});

// --- 復旧キーの入力（U128） ---

interface FakeTty extends TtyInput {
  emitData(chunk: string): void;
  readonly rawModes: boolean[];
}

function fakeTty(options: { readonly isTTY?: boolean } = {}): FakeTty {
  const listeners = new Set<(chunk: string) => void>();
  const rawModes: boolean[] = [];
  return {
    isTTY: options.isTTY ?? true,
    isRaw: false,
    rawModes,
    setRawMode(mode) {
      rawModes.push(mode);
    },
    setEncoding() {},
    resume() {},
    pause() {},
    on(event: 'data' | 'end', listener: (value: string) => void) {
      if (event === 'data') listeners.add(listener);
      return this;
    },
    removeListener(event: 'data' | 'end', listener: (value: string) => void) {
      if (event === 'data') listeners.delete(listener);
      return this;
    },
    emitData(chunk) {
      for (const listener of [...listeners]) listener(chunk);
    },
  } as FakeTty;
}

test('復旧キーの入力: TTY の標準入力からだけ読み、画面に出さず、区切りと小文字を受け付ける', async () => {
  const key = Buffer.alloc(32, 0x5a);
  const code = encodeRecoveryCode(key);
  const tty = fakeTty();
  const lines: string[] = [];
  const pending = readRecoveryKeyFromTty(tty, {
    write: (text) => lines.push(text),
  });
  // 4 文字ずつの区切りを外し、小文字にして 1 文字ずつ流す。
  setTimeout(() => {
    for (const char of code.replace(/-/gu, '').toLowerCase())
      tty.emitData(char);
    tty.emitData('\r');
  }, 0);
  const got = await pending;
  assert.equal(got.ok, true);
  assert.deepEqual(got.ok ? [...got.key] : [], [...key]);
  assert.equal(lines.join('').includes(code), false);
});

test('復旧キーの入力: TTY でない・空・形が違う・Ctrl-C は読まずに理由を返す', async (t) => {
  const piped = await readRecoveryKeyFromTty(fakeTty({ isTTY: false }), {
    write: () => undefined,
  });
  assert.deepEqual(piped, { ok: false, reason: 'not_a_tty' });

  await t.test('空', async () => {
    const tty = fakeTty();
    const pending = readRecoveryKeyFromTty(tty, { write: () => undefined });
    setTimeout(() => tty.emitData('\n'), 0);
    assert.deepEqual(await pending, { ok: false, reason: 'input_empty' });
  });

  await t.test('形が違う', async () => {
    const tty = fakeTty();
    const pending = readRecoveryKeyFromTty(tty, { write: () => undefined });
    setTimeout(() => {
      tty.emitData('not-a-key');
      tty.emitData('\n');
    }, 0);
    assert.deepEqual(await pending, { ok: false, reason: 'invalid_code' });
  });

  await t.test('Ctrl-C', async () => {
    const tty = fakeTty();
    const pending = readRecoveryKeyFromTty(tty, { write: () => undefined });
    setTimeout(() => tty.emitData('\u0003'), 0);
    assert.deepEqual(await pending, { ok: false, reason: 'interrupted' });
  });
});
