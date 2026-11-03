// 復元の段階 3〜6 と差し替え（設計 03 バックアップ・復元、ADR 0040・0047・0054・0056）。
//
// `restore check` が確かめた作業用の DB に、次の順で当てる。
// - 段階 3: 段階 1 で選んだ台帳の head まで、バックアップの後に進んだ忘却を当てる（applyRestoreLedger）。
// - 段階 4: 整合性・外部キー・版・表・世代・系譜・忘却の世代を確かめる（restoreDbVerifyCheck）。
// - 段階 5: VACUUM で空き領域を戻し、索引を作り直す（rebuild_views。失敗は rebuild_failed）。
// - 段階 6: 外部の照合は再認証まで pending（OAuth トークンは封筒にない）。
// - 鍵: 足す → 確かめる（U134。データ鍵は KeyStore にないときだけ data-key-v1 へ）。
// - J3: applyRestoreAftermath で承認をすべて失効させ、操作を隔離し、store_generation を新しくする。
// - 差し替え: installRestoredDatabase。差し替えた後、台帳の別ファイルを復元した DB から作り直す。
//
// 復旧キーは CLI が TTY から読んで渡す。このファイルはログ・出力・DB に残さない。失敗したときは作業用の平文を
// 消し、復元していないことを返す。

import { randomUUID } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BACKUP_KEY_PURPOSES,
  buildRestoreResult,
  keyInstallPlan,
  keyWrapFor,
  quarantineRestoredOperations,
  restoreDbVerifyCheck,
  restoreForgetCheck,
  restoreRebuildCheck,
  restoreReconcileCheck,
  type BackupKeyPurpose,
  type BackupManifestLike,
  type KeyInstallPlan,
  type RestoreRejection,
  type RestoreResultLike,
  type RestoreStageDecision,
} from '@buddy/domain';
import { DATA_KEY_ID } from '@buddy/platform';
import type { BackupKeyStore, KeyStore } from '@buddy/platform';
import {
  applyRestoreAftermath,
  applyRestoreLedger,
  buildLedgerFile,
  currentForgettingGeneration,
  exportForgetLedger,
  openWriteConnection,
  parseLedgerFile,
  readBackupFileHeader,
  readPreRestoreState,
  readRestoreFacts,
  readRestoreOperationsForPlan,
  storagePlatform,
  unwrapBackupKey,
  writeLedgerFileAtomic,
} from '@buddy/storage';
import type {
  BackupKeyWrapValue,
  LedgerChainEntry,
  SqliteDatabase,
} from '@buddy/storage';
import type { ApiContract } from './api-contract.js';
import { prepareDataDir } from './data-dir.js';
import { acquireLock, defaultIsPidAlive, releaseLock } from './lock.js';
import { DB_FILE, FORGET_LEDGER_FILE, controlEndpoint } from './paths.js';
import { RESTORE_WORK_DIR, runRestoreCheck } from './restore-check.js';
import type { RestoreCheckReport } from './restore-check.js';
import {
  installRestoredDatabase,
  recoverRestoreInstall,
  RESTORE_INSTALL_JOURNAL,
} from './restore-install.js';

export const RESTORE_RUN_SCHEMA = 'buddy.restore-run.v1';

export interface RestoreRunOptions {
  readonly dataDir: string;
  readonly contract: ApiContract;
  readonly backupPath: string;
  readonly recoveryKey: Uint8Array;
  readonly dataKeys: KeyStore;
  readonly backupKeys: BackupKeyStore;
  readonly now: () => Date;
  readonly log?: (message: string) => void;
  readonly lock?: boolean;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly probeTimeoutMs?: number;
  // 試験で差し替える差し替え（ファイルの操作）。
  readonly install?: typeof installRestoredDatabase;
}

export type RestoreRunReport =
  | {
      readonly schema: typeof RESTORE_RUN_SCHEMA;
      readonly outcome: 'restored';
      readonly result: RestoreResultLike;
      readonly installed: true;
      readonly plaintext_deleted: boolean;
    }
  | {
      readonly schema: typeof RESTORE_RUN_SCHEMA;
      readonly outcome: 'refused';
      readonly reason: string;
      // 段階 1〜6 のどこかで止まったときの結果（契約の RestoreResult）。差し替えの前に止まったとき。
      readonly result: RestoreResultLike | null;
      // DB を差し替えたか（台帳の別ファイルの作り直しだけ失敗したときは true）。
      readonly installed: boolean;
      // 作業用の平文を消せたか（差し替えの記録が残って保持したときは false）。
      readonly plaintext_deleted: boolean;
    };

const iso = (date: Date): string => date.toISOString().replace('.000Z', 'Z');
const nowMs = (date: Date): number => date.getTime();

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function checkDecisions(report: RestoreCheckReport): RestoreStageDecision[] {
  return report.stages.map((stage) => ({
    stage: stage.stage,
    status: stage.status === 'passed' ? 'passed' : 'failed',
    reasons: stage.reasons as readonly RestoreRejection[],
  }));
}

function asManifest(value: unknown): BackupManifestLike {
  return value as BackupManifestLike;
}

async function unwrapPurpose(
  manifest: BackupManifestLike,
  purpose: BackupKeyPurpose,
  recoveryKey: Uint8Array,
): Promise<Buffer | null> {
  const wrap = keyWrapFor(
    manifest.key_wraps as readonly BackupKeyWrapValue[],
    purpose,
  );
  return wrap === null
    ? null
    : unwrapBackupKey(recoveryKey, wrap as BackupKeyWrapValue);
}

// 段階 1 で選んだ台帳の連鎖（中枢の DB か、中枢の台帳の別ファイル）。
async function readChosenLedger(
  report: RestoreCheckReport,
  dataDir: string,
): Promise<readonly LedgerChainEntry[]> {
  if (report.ledger === null) return [];
  if (report.ledger.holder === 'hub') {
    const livePath = join(dataDir, DB_FILE);
    const db = openWriteConnection(livePath, {
      platform: storagePlatform(process.platform),
    });
    try {
      return exportForgetLedger(db).entries;
    } finally {
      db.close();
    }
  }
  if (report.ledger.holder === 'hub_file') {
    const file = parseLedgerFile(
      await readFile(join(dataDir, FORGET_LEDGER_FILE), 'utf8'),
    );
    return file?.entries ?? [];
  }
  throw new Error('restore_ledger_source_unsupported');
}

// KeyStore の既存の鍵を、用途をまたいで読む（check と同じ規則。U130・ADR 0047）。
async function keyStoreEntries(
  wraps: readonly BackupKeyWrapValue[],
  unwrapped: Readonly<Partial<Record<BackupKeyPurpose, Buffer>>>,
  backupKeys: BackupKeyStore,
  dataKeys: KeyStore,
): Promise<{
  readonly entries: {
    purpose: BackupKeyPurpose;
    key_id: string;
    material_matches_restored: boolean | null;
  }[];
  readonly failed: boolean;
}> {
  const ids = new Set<string>();
  for (const purpose of BACKUP_KEY_PURPOSES) {
    const wrap = keyWrapFor(wraps, purpose);
    if (wrap !== null) ids.add(wrap.key_id);
  }
  const entries: {
    purpose: BackupKeyPurpose;
    key_id: string;
    material_matches_restored: boolean | null;
  }[] = [];
  let failed = false;
  for (const keyId of ids)
    for (const purpose of ['backup_file', 'ledger_hmac_key'] as const) {
      const current = await backupKeys.read(purpose, keyId);
      if (!current.ok) {
        if (current.reason !== 'backup_key_missing') failed = true;
        continue;
      }
      const restored =
        keyWrapFor(wraps, purpose)?.key_id === keyId
          ? unwrapped[purpose]
          : undefined;
      entries.push({
        purpose,
        key_id: keyId,
        material_matches_restored:
          restored === undefined
            ? null
            : current.key.key.length === restored.length &&
              current.key.key.equals(restored),
      });
    }
  const data = await dataKeys.loadDataKey();
  if (data.ok) {
    const restored = unwrapped.data_key;
    entries.push({
      purpose: 'data_key',
      key_id: DATA_KEY_ID,
      material_matches_restored:
        restored === undefined
          ? null
          : data.dataKey.key.length === restored.length &&
            data.dataKey.key.equals(restored),
    });
  } else if (data.reason !== 'data_key_missing') failed = true;
  return { entries, failed };
}

interface InstalledKeys {
  readonly ledger_hmac_key_id: string;
}

// 鍵を足し、読み戻して確かめる（足すだけで上書き・削除をしない。U134）。
async function installKeys(input: {
  readonly wraps: readonly BackupKeyWrapValue[];
  readonly unwrapped: Readonly<Partial<Record<BackupKeyPurpose, Buffer>>>;
  readonly backupKeys: BackupKeyStore;
  readonly dataKeys: KeyStore;
}): Promise<InstalledKeys | null> {
  const ledgerWrap = keyWrapFor(input.wraps, 'ledger_hmac_key');
  if (ledgerWrap === null) return null;
  const dataWrap = keyWrapFor(input.wraps, 'data_key');
  if (dataWrap?.key_id !== DATA_KEY_ID) return null;
  const keystore = await keyStoreEntries(
    input.wraps,
    input.unwrapped,
    input.backupKeys,
    input.dataKeys,
  );
  if (keystore.failed) return null;
  const plan = keyInstallPlan({
    key_wraps: input.wraps,
    keystore: keystore.entries,
  });
  if (!plan.ok) return null;
  if (!(await runKeySteps(plan, input))) return null;
  return { ledger_hmac_key_id: ledgerWrap.key_id };
}

async function runKeySteps(
  plan: Extract<KeyInstallPlan, { ok: true }>,
  input: {
    readonly unwrapped: Readonly<Partial<Record<BackupKeyPurpose, Buffer>>>;
    readonly backupKeys: BackupKeyStore;
    readonly dataKeys: KeyStore;
  },
): Promise<boolean> {
  for (const step of plan.steps) {
    if (step.step === 'stage_key') {
      const material = input.unwrapped[step.purpose];
      if (material === undefined) return false;
      if (step.purpose === 'data_key') {
        const imported = await input.dataKeys.importDataKey(material);
        if (!imported.ok) return false;
      } else {
        const placed = await input.backupKeys.put(
          step.purpose,
          step.key_id,
          material,
        );
        if (!placed.ok) return false;
      }
    } else if (step.step === 'verify_staged_keys') {
      for (const purpose of ['backup_file', 'ledger_hmac_key'] as const) {
        const wrap = plan.steps.find(
          (item) => item.step === 'stage_key' && item.purpose === purpose,
        );
        if (wrap === undefined || wrap.step !== 'stage_key') continue;
        const material = input.unwrapped[purpose];
        const read = await input.backupKeys.read(purpose, wrap.key_id);
        if (
          material === undefined ||
          !read.ok ||
          read.key.key.length !== material.length ||
          !read.key.key.equals(material)
        )
          return false;
      }
      // データ鍵: KeyStore になければ封筒の鍵を data-key-v1 に置き、あれば同じ素材であること。
      const material = input.unwrapped.data_key;
      if (material === undefined) return false;
      const current = await input.dataKeys.loadDataKey();
      if (current.ok) {
        if (
          current.dataKey.key.length !== material.length ||
          !current.dataKey.key.equals(material)
        )
          return false;
      } else if (current.reason === 'data_key_missing') {
        const imported = await input.dataKeys.importDataKey(material);
        if (!imported.ok) return false;
      } else return false;
    }
  }
  return true;
}

export async function runRestoreRun(
  options: RestoreRunOptions,
): Promise<RestoreRunReport> {
  const log = options.log ?? (() => undefined);
  const endpoint = controlEndpoint(options.dataDir, process.platform);
  const lockId = randomUUID();
  let locked = false;
  try {
    await prepareDataDir(options.dataDir);
    if (options.lock !== false) {
      await acquireLock({
        dataDir: options.dataDir,
        endpoint,
        record: {
          pid: process.pid,
          core_instance_id: lockId,
          started_at: iso(options.now()),
        },
        isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
        probeTimeoutMs: options.probeTimeoutMs ?? 1000,
        removeStaleEndpoint: async () => {
          if (process.platform !== 'win32') await rm(endpoint, { force: true });
        },
      });
      locked = true;
    }
  } catch (error) {
    log(`Core のロックを取れませんでした（${(error as Error).name}）。`);
    return refused('core_running', null, false, true);
  }
  let workDir: string | null = null;
  let workingPath: string | null;
  let working: SqliteDatabase | null = null;
  let preRestore: ReturnType<typeof readPreRestoreState> | null = null;
  let newGeneration: string;
  let result: RestoreResultLike | null;
  const closeWorking = (): void => {
    if (working === null) return;
    try {
      working.close();
    } catch {
      // 閉じられなくても、プロセスの終了で解放される。
    }
    working = null;
  };
  const removeWorkDir = async (): Promise<boolean> => {
    if (workDir === null) return true;
    try {
      await rm(workDir, { recursive: true, force: true });
      return true;
    } catch (error) {
      // データディレクトリの下に何も作れていない（ENOTDIR）なら平文はない。
      return (error as NodeJS.ErrnoException).code === 'ENOTDIR';
    }
  };
  const refuse = async (
    reason: string,
    value: RestoreResultLike | null = null,
    installed = false,
  ): Promise<RestoreRunReport> => {
    closeWorking();
    const removed = await removeWorkDir();
    return refused(reason, value, installed, removed);
  };
  try {
    await recoverRestoreInstall(options.dataDir);
    const check = await runRestoreCheck({
      ...options,
      retainWorkDir: true,
      lock: false,
      log,
    });
    workDir = join(
      options.dataDir,
      RESTORE_WORK_DIR,
      `restore-${check.restore_id}`,
    );
    workingPath = join(workDir, DB_FILE);
    if (check.outcome !== 'ready') return await refuse('check_refused');
    const workingDbPath = join(workDir, DB_FILE);
    const livePath = join(options.dataDir, DB_FILE);
    if (await exists(livePath)) {
      const live = openWriteConnection(livePath, {
        platform: storagePlatform(process.platform),
      });
      try {
        preRestore = readPreRestoreState(live);
      } finally {
        live.close();
      }
    }
    const header = await readBackupFileHeader(options.backupPath);
    if (!header.ok) return await refuse('manifest_invalid');
    const manifest = asManifest(header.manifest);
    const buildOutcome = (
      decisions: readonly RestoreStageDecision[],
      after: null,
    ): RestoreResultLike | null => {
      const built = buildRestoreResult({
        restore_id: check.restore_id,
        backup_id: manifest.backup_id,
        backup_store_generation: manifest.store_generation,
        started_at: check.started_at,
        finished_at: iso(options.now()),
        decisions,
        settings_only: { eligible: false, settings_readable: true },
        after_restore: after,
      });
      return built.ok ? built.result : null;
    };
    const wraps = manifest.key_wraps as readonly BackupKeyWrapValue[];
    const ledgerKey = await unwrapPurpose(
      manifest,
      'ledger_hmac_key',
      options.recoveryKey,
    );
    if (ledgerKey === null) return await refuse('backup_unreadable');
    const dataKey = await unwrapPurpose(
      manifest,
      'data_key',
      options.recoveryKey,
    );
    const backupKey = await unwrapPurpose(
      manifest,
      'backup_file',
      options.recoveryKey,
    );
    if (dataKey === null || backupKey === null)
      return await refuse('backup_unreadable');
    const unwrapped: Partial<Record<BackupKeyPurpose, Buffer>> = {
      ledger_hmac_key: ledgerKey,
      data_key: dataKey,
      backup_file: backupKey,
    };

    working = openWriteConnection(workingDbPath, {
      platform: storagePlatform(process.platform),
    });
    const decisions = checkDecisions(check);

    // --- 段階 3: 忘却の適用 ---
    let applied: ReturnType<typeof applyRestoreLedger> | null = null;
    try {
      const entries = await readChosenLedger(check, options.dataDir);
      const current = currentForgettingGeneration(working);
      const later = entries.filter(
        (entry) => Number(entry.entry.forgetting_generation) > current,
      );
      applied = applyRestoreLedger(working, {
        entries: later,
        ledger_hmac_key: ledgerKey,
        ledger_id: check.ledger?.ledger_id ?? manifest.ledger_id,
        now: nowMs(options.now()),
      });
    } catch (error) {
      log(`忘却を当てられませんでした（${(error as Error).name}）。`);
    }
    const appliedGeneration =
      applied === null ? null : String(currentForgettingGeneration(working));
    const forgetStage = restoreForgetCheck({
      applied_generation: appliedGeneration,
      required_generation: check.ledger?.head_generation ?? '0',
    });
    decisions.push(forgetStage);
    if (forgetStage.status !== 'passed') {
      result = buildOutcome(decisions, null);
      return await refuse('forget_apply_failed', result);
    }

    // --- 段階 4: DB の検証 ---
    const facts = readRestoreFacts(working);
    const operations = readRestoreOperationsForPlan(working);
    const plan = quarantineRestoredOperations(operations, iso(options.now()));
    const verifyStage = restoreDbVerifyCheck({
      integrity_ok: facts.integrity_ok,
      foreign_keys_ok: facts.foreign_keys_ok,
      restored_schema_version:
        check.working_schema_version ?? facts.schema_version,
      manifest_schema_version: manifest.db_schema_version,
      code_schema_version: facts.schema_version,
      operations_plan_ok: plan.ok,
      restored_tables: facts.tables,
      restored_store_generation: facts.store_generation ?? '',
      restored_ledger_id: facts.ledger_id ?? '',
      restored_forgetting_generation: facts.forgetting_generation ?? '',
      expected: {
        store_generation: manifest.store_generation,
        ledger_id: manifest.ledger_id,
        forgetting_generation: check.ledger?.head_generation ?? '0',
        excluded_tables: manifest.excluded_tables,
      },
    });
    decisions.push(verifyStage);
    if (verifyStage.status !== 'passed') {
      result = buildOutcome(decisions, null);
      return await refuse('db_integrity_failed', result);
    }

    // --- 段階 5: 空き領域を戻し、索引を作り直す ---
    let rebuildOk = true;
    try {
      working.exec('VACUUM');
      working.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
      rebuildOk = false;
      log(`DB を作り直せませんでした（${(error as Error).name}）。`);
    }
    const rebuildStage = restoreRebuildCheck({ ok: rebuildOk });
    decisions.push(rebuildStage);
    if (rebuildStage.status !== 'passed') {
      result = buildOutcome(decisions, null);
      return await refuse('rebuild_failed', result);
    }

    // --- 段階 6: 外部の照合（OAuth トークンは封筒にないので、再認証まで pending） ---
    decisions.push(restoreReconcileCheck({ reauth_complete: false }));

    // --- 鍵の導入（足す → 確かめる） ---
    const keys = await installKeys({
      wraps,
      unwrapped,
      backupKeys: options.backupKeys,
      dataKeys: options.dataKeys,
    });
    if (keys === null) return await refuse('key_install_failed');

    // --- J3: 差し替える前の作業用の DB に、取り直しを 1 つの transaction で書く ---
    newGeneration = randomUUID();
    let aftermath: ReturnType<typeof applyRestoreAftermath>;
    try {
      aftermath = applyRestoreAftermath(working, {
        restored_at: nowMs(options.now()),
        backup_created_at: Date.parse(manifest.created_at),
        new_store_generation: newGeneration,
        pre_restore: preRestore,
        ledger_hmac_key_id: keys.ledger_hmac_key_id,
      });
    } catch (error) {
      log(`復元の後の保留を書けませんでした（${(error as Error).name}）。`);
      return await refuse('aftermath_failed');
    }
    const finished = iso(options.now());
    const built = buildRestoreResult({
      restore_id: check.restore_id,
      backup_id: manifest.backup_id,
      backup_store_generation: manifest.store_generation,
      started_at: check.started_at,
      finished_at: finished,
      decisions,
      settings_only: { eligible: false, settings_readable: true },
      after_restore: {
        new_store_generation: newGeneration,
        applied_forgetting_generation: check.ledger?.head_generation ?? '0',
        expired_deleted_count: check.expired_deleted_count,
        forgotten_applied_count: applied?.forgotten_applied ?? 0,
        approvals_revoked_count: aftermath.approvals_revoked_count,
        operations_held_count: aftermath.operations_held_count,
        operations_unverified_count: aftermath.operations_unverified_count,
        consents_reset: true,
        connections_reauth_required: true,
      },
    });
    if (!built.ok) {
      log(`復元の結果を組み立てられません（${built.reasons.join(', ')}）。`);
      return await refuse('result_invalid');
    }
    result = built.result;
    closeWorking();

    // 差し替え。ロックは check の前からこの後まで連続して持っている（Core が途中で起動して忘却を進めない）。
    if (workingPath === null) return await refuse('internal_error');
    try {
      await (options.install ?? installRestoredDatabase)({
        dataDir: options.dataDir,
        workingPath,
        endpoint,
        alreadyLocked: true,
        ...(options.isPidAlive === undefined
          ? {}
          : { isPidAlive: options.isPidAlive }),
        ...(options.probeTimeoutMs === undefined
          ? {}
          : { probeTimeoutMs: options.probeTimeoutMs }),
      });
    } catch (error) {
      log(
        `復元した DB を差し替えられませんでした（${(error as Error).name}）。`,
      );
      // 差し替えの記録が残っているときは、作業用の DB を消さない（次の起動・差し替えの復旧が参照する）。
      const journal = await exists(
        join(options.dataDir, RESTORE_INSTALL_JOURNAL),
      );
      if (journal) {
        log(
          '差し替えの記録が残っているため、作業用の DB を復旧のために残します。',
        );
        return refused('install_failed', null, false, false);
      }
      return await refuse('install_failed', null, false);
    }
    // 差し替えた DB の台帳から、台帳の別ファイルを作り直す（Core の起動時の照合で止まらないように）。
    try {
      const live = openWriteConnection(join(options.dataDir, DB_FILE), {
        platform: storagePlatform(process.platform),
      });
      try {
        const exported = exportForgetLedger(live);
        await writeLedgerFileAtomic(
          join(options.dataDir, FORGET_LEDGER_FILE),
          buildLedgerFile(exported, options.now()),
        );
      } finally {
        live.close();
      }
    } catch (error) {
      log(
        `台帳の別ファイルを作り直せませんでした（${(error as Error).name}）。`,
      );
      return await refuse('ledger_file_failed', null, true);
    }
    const removed = await removeWorkDir();
    return {
      schema: RESTORE_RUN_SCHEMA,
      outcome: 'restored',
      result: result as RestoreResultLike,
      installed: true,
      plaintext_deleted: removed,
    };
  } catch (error) {
    log(`復元の実行中に失敗しました（${(error as Error).name}）。`);
    return await refuse('internal_error');
  } finally {
    closeWorking();
    if (locked)
      await releaseLock(options.dataDir, lockId).catch(() => undefined);
  }
}

function refused(
  reason: string,
  result: RestoreResultLike | null = null,
  installed = false,
  plaintextDeleted = true,
): RestoreRunReport {
  return {
    schema: RESTORE_RUN_SCHEMA,
    outcome: 'refused',
    reason,
    result,
    installed,
    plaintext_deleted: plaintextDeleted,
  };
}
