// 復元の段階 3〜6 と差し替え（ADR 0047・0054・0056）の模擬の試験。
// Core の本物の設定・バックアップで封筒を作り、復元した後に別の DB を直接開いて、承認の失効（J3）・
// store_generation の更新・台帳の別ファイル・作業用の平文の後始末を確かめる。実機・実 API は使わない。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
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
  createMockBackupKeyStore,
  createMockKeyStore,
  DATA_KEY_ID,
} from '@buddy/platform';
import { decodeRecoveryCode, keyWrapFor } from '@buddy/domain';
import {
  openWriteConnection,
  readBackupFileHeader,
  readStoreGeneration,
  storagePlatform,
} from '@buddy/storage';
import type { BackupKeyWrapValue } from '@buddy/storage';
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
import { RESTORE_WORK_DIR } from './restore-check.js';
import { runRestoreRun } from './restore-run.js';

const DATA_KEY = Buffer.alloc(32, 0x41);
const contract = createApiContract();
const T0 = Date.parse('2031-03-01T00:00:00.000Z');

interface Rig {
  readonly dataDir: string;
  readonly backupDir: string;
  readonly handle: CoreHandle;
  readonly keys: ReturnType<typeof createMockBackupKeyStore>;
  readonly dataKeys: ReturnType<typeof createMockKeyStore>;
  readonly backupPath: string;
  readonly recoveryCode: string;
  readonly operationId: string;
}

// 承認付きの LocalCommand を 1 つ、DB に直接入れる（backup に含めて J3 を確かめる。合成の値だけ）。
function seedApprovedOperation(dataDir: string): string {
  const db = openWriteConnection(join(dataDir, DB_FILE), {
    platform: storagePlatform(process.platform),
  });
  try {
    const operationId = randomUUID();
    const version = 1;
    const blobId = randomUUID();
    const hash = 'a'.repeat(64);
    db.prepare(
      `INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at)
       VALUES (?, 'operation_intent', 'operations', ?, 0, 1, ?, ?, ?, ?, ?)`,
    ).run(
      blobId,
      operationId,
      DATA_KEY_ID,
      randomBytes(12),
      randomBytes(16),
      randomBytes(16),
      T0,
    );
    db.prepare(
      `INSERT INTO operations (operation_id, workflow_id, kind, effect_route, current_content_version, state, state_revision, created_at)
       VALUES (?, NULL, 'send_message', 'local_command', ?, 'awaiting_approval', 0, ?)`,
    ).run(operationId, version, T0);
    db.prepare(
      `INSERT INTO operation_versions (operation_id, content_version, content_hash, intent_blob_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(operationId, version, hash, blobId, T0);
    db.prepare(
      `INSERT INTO approvals (approval_id, operation_id, content_version, content_hash, route, device_id, preview_id, policy_version, status, approved_at)
       VALUES (?, ?, ?, ?, 'policy_auto', NULL, NULL, 0, 'valid', ?)`,
    ).run(randomUUID(), operationId, version, hash, T0);
    return operationId;
  } finally {
    db.close();
  }
}

async function rig(t: test.TestContext): Promise<Rig> {
  const base = await mkdtemp(join(tmpdir(), 'buddy-restore-run-'));
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
  const displayed: string[] = [];
  let handle = await startCore({
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
  await handle.stop('test');
  const operationId = seedApprovedOperation(dataDir);
  handle = await startCore({
    dataDir,
    keyStore: dataKeys,
    shutdownGraceMs: 200,
    probeTimeoutMs: 300,
    now: () => new Date(T0 + 1000),
    log: () => undefined,
    backup: { keyStore: keys, scheduler: {} },
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
    now: () => new Date(T0 + 1000),
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
  await handle.stop('test');
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
    dataKeys,
    backupPath: join(backupDir, files[0] as string),
    recoveryCode,
    operationId,
  };
}

test('復元の実行: 段階 1〜6 を通り、承認をすべて失効させ、store_generation を新しくして差し替える', async (t) => {
  const r = await rig(t);
  const header = await readBackupFileHeader(r.backupPath);
  assert.ok(header.ok);
  const manifest = header.manifest as Record<string, unknown>;
  const backupGeneration = String(manifest['store_generation']);
  const report = await runRestoreRun({
    dataDir: r.dataDir,
    contract,
    backupPath: r.backupPath,
    recoveryKey: Buffer.from(decodeRecoveryCode(r.recoveryCode) as Uint8Array),
    dataKeys: r.dataKeys,
    backupKeys: r.keys,
    now: () => new Date(T0 + 2000),
    lock: true,
    log: () => undefined,
  });
  assert.equal(report.outcome, 'restored', JSON.stringify(report));
  if (report.outcome !== 'restored') return;
  assert.equal(report.result.outcome, 'restored');
  assert.equal(contract.valid('RestoreResult', report.result), true);
  assert.equal(report.result.failed_stage, null);
  assert.equal(report.result.after_restore?.approvals_revoked_count, 1);
  assert.equal(report.result.after_restore?.forgotten_applied_count, 0);
  assert.notEqual(
    report.result.after_restore?.new_store_generation,
    backupGeneration,
  );

  // 差し替えた DB: 承認は有効 0、世代は新しい、差し替えの時刻が入っている。
  const db = openWriteConnection(join(r.dataDir, DB_FILE), {
    platform: storagePlatform(process.platform),
  });
  try {
    assert.equal(
      db
        .prepare(
          "SELECT count(*) FROM approvals WHERE operation_id = ? AND status = 'valid'",
        )
        .pluck()
        .get(r.operationId),
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) FROM approvals WHERE operation_id = ? AND status = 'revoked'",
        )
        .pluck()
        .get(r.operationId),
      1,
    );
    assert.notEqual(readStoreGeneration(db), backupGeneration);
    assert.equal(
      db
        .prepare(
          "SELECT value FROM schema_meta WHERE key = 'restore_restored_at'",
        )
        .pluck()
        .get(),
      String(T0 + 2000),
    );
  } finally {
    db.close();
  }
  // 台帳の別ファイルは復元した DB から作り直し、作業用の平文は残らない。
  const ledger = JSON.parse(
    await readFile(join(r.dataDir, FORGET_LEDGER_FILE), 'utf8'),
  ) as { schema: string };
  assert.equal(ledger.schema, 'buddy.forget-ledger-file.v1');
  assert.deepEqual(
    await readdir(join(r.dataDir, RESTORE_WORK_DIR)).catch(() => []),
    [],
  );
  // 鍵は KeyStore にあり、データ鍵は data-key-v1 のまま。
  const keyWraps = manifest['key_wraps'] as BackupKeyWrapValue[];
  const wrap = keyWrapFor(keyWraps, 'backup_file');
  assert.ok(wrap !== null);
  assert.equal((await r.keys.read('backup_file', wrap.key_id)).ok, true);
  const dataKey = await r.dataKeys.loadDataKey();
  assert.equal(dataKey.ok, true);
  assert.equal(
    dataKey.ok ? keyWrapFor(keyWraps, 'data_key')?.key_id : null,
    DATA_KEY_ID,
  );
});
