// 復元の段階 1〜2（台帳の確認・期限切れの削除の前提）と、鍵の取り出し（設計 03 バックアップ・復元、ADR 0040・
// 0047・0054・0055、B06-08 段階 2）。ADR 0056。
//
// このファイルは「復元してよいかを確かめる」ところまでを持つ（CLI の `restore check`）。段階 3〜6 と DB の差し替え・
// 復元の後の保留（J3）は次の PR（同じ ADR）で足す。ここでは次を行う。
// - 封筒ファイルを読み、契約と domain の意味検査に通す（通らなければ何もしない）。
// - 復旧キーは呼び出し側（CLI）が TTY から読んで渡す。このファイルは復旧キーを保存しない・ログに出さない。
// - backup-keys.json の確認値で打ち間違いを先に見つけ、封筒の 3 つの包み（本体・データ鍵・台帳の HMAC）を開く。
// - 本体の大きさと SHA-256 を封筒と照合してから復号する。復号した DB は作業用のディレクトリにだけ書き、終わったら消す。
// - 中枢の DB（正本）と台帳の別ファイルから台帳の候補を作り、段階 1 の restoreLedgerCheck に渡す。最新の台帳を
//   確認できないときは記憶・会話を戻さない（settings_only の候補として報告するだけ）。
// - 段階 2 は作業用の DB に期限切れの削除（保存期限の掃除）を当て、restoreOpenCheck で開けること・時計を信じられる
//   こと・削除を当てたことを確かめる。
//
// 中枢の DB を直接開くので、CLI は Core の排他ロックを取ってから呼ぶ（Core が動いていれば拒否する）。

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BACKUP_KEY_PURPOSES,
  BACKUP_ZERO_HASH,
  backupManifestProblems,
  isBackupGeneration,
  keyInstallPlan,
  keyWrapFor,
  restoreLedgerCheck,
  restoreOpenCheck,
  type BackupKeyPurpose,
  type BackupManifestLike,
  type RestoreLedgerCandidate,
} from '@buddy/domain';
import { DATA_KEY_ID } from '@buddy/platform';
import type { BackupKeyStore, KeyStore } from '@buddy/platform';
import {
  DbWorkerClient,
  decryptBackupPayload,
  exportForgetLedger,
  manifestPayloadKey,
  openWriteConnection,
  parseLedgerFile,
  readBackupFacts,
  readBackupFileHeader,
  readBackupPayload,
  recoveryCheckMatches,
  storagePlatform,
  unwrapBackupKey,
  verifyBackupPayload,
} from '@buddy/storage';
import type {
  BackupKeyWrapValue,
  ForgetLedgerFileContent,
  LedgerChainEntry,
} from '@buddy/storage';
import type { ApiContract } from './api-contract.js';
import { readBackupKeyFile, readBackupState } from './backup-files.js';
import { createClockStateFile } from './clock-state.js';
import { acquireLock, defaultIsPidAlive, releaseLock } from './lock.js';
import { DB_FILE, FORGET_LEDGER_FILE, controlEndpoint } from './paths.js';
import {
  createRetentionSweepPort,
  RetentionSweeper,
} from './retention-sweeper.js';

export const RESTORE_WORK_DIR = 'restore-work';
export const RESTORE_CHECK_SCHEMA = 'buddy.restore-check.v1';

export type RestoreCheckStage = 'ledger_check' | 'expiry_purge';

export interface RestoreCheckStageView {
  readonly stage: RestoreCheckStage;
  readonly status: 'passed' | 'failed' | 'not_run';
  readonly reasons: readonly string[];
}

export interface RestoreCheckReport {
  readonly schema: typeof RESTORE_CHECK_SCHEMA;
  readonly restore_id: string;
  readonly backup_id: string;
  readonly backup_created_at: string | null;
  readonly started_at: string;
  readonly finished_at: string;
  // ready = 段階 1・2 を通り、段階 3〜6 を続けられる。rejected = ここで止まる（記憶と会話は戻さない）。
  readonly outcome: 'ready' | 'rejected';
  readonly stages: readonly RestoreCheckStageView[];
  // 最新の台帳を確認できないときだけ true（非機密の設定だけを戻せる候補。段階 3〜6 の PR で実行する）。
  readonly settings_only_eligible: boolean;
  readonly ledger: {
    readonly holder: string;
    readonly head_generation: string;
  } | null;
  // 封筒の本体を復号して作業用の DB に置けたか（確認の後に消す。パスは返さない）。
  readonly raw_payload_decrypted: boolean;
}

export interface RestoreCheckOptions {
  readonly dataDir: string;
  readonly contract: ApiContract;
  // 復元する封筒ファイル（絶対パス）。
  readonly backupPath: string;
  // TTY から読んだ復旧キー（32 バイト）。保存しない。
  readonly recoveryKey: Uint8Array;
  readonly dataKeys: KeyStore;
  readonly backupKeys: BackupKeyStore;
  readonly now: () => Date;
  readonly log?: (message: string) => void;
  // Core の排他ロックを取る（既定 true）。試験では省く。
  readonly lock?: boolean;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly probeTimeoutMs?: number;
  // 試験で差し替える期限切れの削除。既定は実際に作業用の DB を掃除する。
  readonly purge?: (
    workingPath: string,
    workDir: string,
  ) => Promise<{ readonly ok: boolean; readonly reasons: readonly string[] }>;
  // 試験で差し替える作業用の DB の書き込み（途中で失敗したときの後始末を確かめる）。
  readonly writeWorkingDatabase?: (
    workDir: string,
    bytes: Uint8Array,
  ) => Promise<string>;
  // 試験で差し替える作業用の DB の削除（失敗したときの扱いを確かめる）。失敗は例外で知らせる。
  readonly removeWorkDir?: (workDir: string) => Promise<void>;
}

const iso = (date: Date): string => date.toISOString().replace('.000Z', 'Z');

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// 作業用のディレクトリを消す。EBUSY・EACCES などは数回まで試す。消せたかを返す（消せなければ呼び出し側が成功を返さない）。
async function deleteWorkDir(workDir: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(workDir, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt < 2) await delay(50 * (attempt + 1));
    }
  }
  return false;
}

async function writeWorkingDatabase(
  workDir: string,
  bytes: Uint8Array,
): Promise<string> {
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const path = join(workDir, DB_FILE);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Windows はディレクトリを開いて fsync できない（ADR 0054 と同じ）。
  if (process.platform !== 'win32') {
    const dir = await open(workDir, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  return path;
}

// 作業用の DB に期限切れの削除を当てる。保存期限の掃除（ADR 0053・0058）を、作業用の DB に対して 1 回だけ動かす。
// 時計の最終確認時刻は作業用のディレクトリに新しく作る（中枢の記録は変えない）。
async function purgeWorkingDatabase(
  workingPath: string,
  workDir: string,
  now: () => Date,
): Promise<{ readonly ok: boolean; readonly reasons: readonly string[] }> {
  const store = await DbWorkerClient.start({ path: workingPath });
  try {
    const sweeper = new RetentionSweeper({
      port: createRetentionSweepPort(store),
      epoch: randomUUID(),
      now: () => now().getTime(),
      clock: createClockStateFile(workDir),
      freshClockState: true,
    });
    try {
      const record = await sweeper.runOnce(true);
      await sweeper.drain();
      return record.status === 'completed' && record.failed_actions === 0
        ? { ok: true, reasons: [] }
        : { ok: false, reasons: ['expiry_purge_failed'] };
    } finally {
      sweeper.close();
    }
  } finally {
    await store.close().catch(() => undefined);
  }
}

// 封筒の forgetting_generation の世代の entry_hash。世代 0 は 64 個の 0、head より先なら null。
function hashAtBackupGeneration(
  entries: readonly LedgerChainEntry[],
  headGeneration: string,
  backupGeneration: string,
): string | null {
  if (
    !isBackupGeneration(headGeneration) ||
    !isBackupGeneration(backupGeneration)
  )
    return null;
  if (BigInt(backupGeneration) > BigInt(headGeneration)) return null;
  if (BigInt(backupGeneration) === 0n) return BACKUP_ZERO_HASH;
  const entry = entries[Number(backupGeneration) - 1];
  return entry === undefined ? null : entry.entry_hash;
}

// 2 つの台帳の履歴が、共通する世代のどこかで食い違うか（同じ系譜の DB と別ファイルの分岐）。
// 短い方の末尾までは同じで、長い方だけが先へ進んでいるのは正常（ファイルが DB より進んでいる場合など）。
export function ledgerHistoriesDiverge(
  a: readonly Pick<LedgerChainEntry, 'entry_hash'>[],
  b: readonly Pick<LedgerChainEntry, 'entry_hash'>[],
): boolean {
  const common = Math.min(a.length, b.length);
  for (let index = 0; index < common; index += 1)
    if (a[index]?.entry_hash !== b[index]?.entry_hash) return true;
  return false;
}

interface HubLedgerRead {
  readonly candidates: readonly RestoreLedgerCandidate[];
  // 中枢と台帳のファイルが知っている最新の世代（読めない・一時ファイルがある・破損があるときは null）。
  readonly known_generation: string | null;
  // 中枢の DB に記録した台帳の鍵の ID。
  readonly recorded_key_id: string | null;
  // 同じ系譜の DB と別ファイルの共通の世代で、entry_hash が食い違った（分岐）。
  readonly diverged: boolean;
}

// 中枢の DB（正本）と台帳の別ファイルから、段階 1 の候補を作る。ファイルが DB より進んでいれば、その世代も
// 「知っている最新」に含める（復元した後に Core がその台帳を当てられるように）。
// 書きかけの一時ファイル（.forget-ledger-*.tmp）・読めないファイル・壊れたファイルがあるときは、確定していない
// より新しい世代を持ち得るので、「知っている最新」を確認できないものとして扱う（Core の起動時の同期と同じ側に倒す。
// ADR 0054 の U109・U119）。
// 同じ系譜の DB と別ファイルは、共通の世代の entry_hash が一致しなければならない（片方だけが進んでいるのはよいが、
// 分岐は別の歴史。共通部分を確かめ、食い違えば段階 1 で止める）。
async function readHubLedger(
  dataDir: string,
  ledgerFile: ForgetLedgerFileContent | null,
  manifest: BackupManifestLike,
  ledgerUnconfirmed: boolean,
  log: (message: string) => void,
): Promise<HubLedgerRead> {
  const candidates: RestoreLedgerCandidate[] = [];
  let known: string | null = null;
  let recorded: string | null = null;
  let dbEntries: readonly LedgerChainEntry[] | null = null;
  let dbLedgerId: string | null = null;
  let diverged = false;
  const dbPath = join(dataDir, DB_FILE);
  if (await exists(dbPath)) {
    try {
      const db = openWriteConnection(dbPath, {
        platform: storagePlatform(process.platform),
      });
      try {
        const facts = readBackupFacts(db);
        const exported = exportForgetLedger(db);
        recorded = facts.recorded_ledger_key_id;
        known = facts.forgetting_generation;
        dbEntries = exported.entries;
        dbLedgerId = exported.ledger_id;
        if (exported.ledger_id !== null) {
          candidates.push({
            holder: 'hub',
            ledger_id: exported.ledger_id,
            chain_valid: true,
            complete: true,
            head_generation: exported.head.forgetting_generation,
            hash_at_backup_generation: hashAtBackupGeneration(
              exported.entries,
              exported.head.forgetting_generation,
              manifest.forgetting_generation,
            ),
          });
        }
      } finally {
        try {
          db.close();
        } catch {
          // 読み取りの接続は閉じられなくても、プロセスの終了で解放される。
        }
      }
    } catch (error) {
      // DB がない・開けない・台帳の連鎖が壊れている。候補にしない（段階 1 で止まる）。
      log(`中枢の DB を読めませんでした（${(error as Error).name}）。`);
    }
  }
  if (ledgerFile !== null) {
    candidates.push({
      holder: 'hub_file',
      ledger_id: ledgerFile.ledger_id,
      chain_valid: true,
      complete: true,
      head_generation: ledgerFile.head.forgetting_generation,
      hash_at_backup_generation: hashAtBackupGeneration(
        ledgerFile.entries,
        ledgerFile.head.forgetting_generation,
        manifest.forgetting_generation,
      ),
    });
    if (
      isBackupGeneration(ledgerFile.head.forgetting_generation) &&
      (known === null ||
        BigInt(ledgerFile.head.forgetting_generation) > BigInt(known))
    )
      known = ledgerFile.head.forgetting_generation;
    // 同じ系譜なら、共通の世代の entry_hash が一致すること（分岐は別の歴史。片方だけが進んでいるのはよい）。
    if (dbEntries !== null && dbLedgerId === ledgerFile.ledger_id) {
      const common = Math.min(dbEntries.length, ledgerFile.entries.length);
      for (let index = 0; index < common; index += 1) {
        if (
          dbEntries[index]?.entry_hash !== ledgerFile.entries[index]?.entry_hash
        ) {
          diverged = true;
          break;
        }
      }
    }
  }
  return {
    candidates,
    known_generation: ledgerUnconfirmed ? null : known,
    recorded_key_id: recorded,
    diverged,
  };
}

export async function runRestoreCheck(
  options: RestoreCheckOptions,
): Promise<RestoreCheckReport> {
  const log = options.log ?? (() => undefined);
  const started = options.now();
  const restoreId = randomUUID();
  const workDir = join(
    options.dataDir,
    RESTORE_WORK_DIR,
    `restore-${restoreId}`,
  );
  let workingPath: string | null = null;
  let rawPayloadDecrypted = false;
  let locked = false;
  const lockId = randomUUID();
  const stages: RestoreCheckStageView[] = [];
  let settingsOnlyEligible = false;
  let ledger: { holder: string; head_generation: string } | null = null;
  let backupId = '';
  let backupCreatedAt: string | null = null;
  // 封筒から開いた鍵。確認が終わったらメモリー上の値を消す（保存しない）。
  const unwrapped: Partial<Record<BackupKeyPurpose, Buffer>> = {};

  const report = (outcome: 'ready' | 'rejected'): RestoreCheckReport => ({
    schema: RESTORE_CHECK_SCHEMA,
    restore_id: restoreId,
    backup_id: backupId,
    backup_created_at: backupCreatedAt,
    started_at: iso(started),
    finished_at: iso(options.now()),
    outcome,
    stages,
    settings_only_eligible: settingsOnlyEligible,
    ledger,
    raw_payload_decrypted: rawPayloadDecrypted,
  });

  try {
    if (options.lock !== false) {
      try {
        await acquireLock({
          dataDir: options.dataDir,
          endpoint: controlEndpoint(options.dataDir, process.platform),
          record: {
            pid: process.pid,
            core_instance_id: lockId,
            started_at: iso(started),
          },
          isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
          probeTimeoutMs: options.probeTimeoutMs ?? 1000,
          removeStaleEndpoint: async () => {
            if (process.platform !== 'win32')
              await rm(controlEndpoint(options.dataDir, process.platform), {
                force: true,
              });
          },
        });
        locked = true;
      } catch (error) {
        log(
          `Core が動いているため復元の確認を始めません（${(error as Error).message}）。`,
        );
        stages.push({
          stage: 'ledger_check',
          status: 'failed',
          reasons: ['core_running'],
        });
        return report('rejected');
      }
    }

    const header = await readBackupFileHeader(options.backupPath);
    if (!header.ok) {
      log(`バックアップの封筒を読めません（${header.reason}）。`);
      stages.push({
        stage: 'ledger_check',
        status: 'failed',
        reasons: ['manifest_invalid'],
      });
      return report('rejected');
    }
    const manifestRaw = header.manifest;
    const manifest = manifestRaw as BackupManifestLike;
    if (
      manifestRaw === null ||
      typeof manifestRaw !== 'object' ||
      Array.isArray(manifestRaw) ||
      !options.contract.valid('BackupManifest', manifestRaw) ||
      backupManifestProblems(manifest).length > 0
    ) {
      log('バックアップの封筒が契約・意味検査に通りません。');
      stages.push({
        stage: 'ledger_check',
        status: 'failed',
        reasons: ['manifest_invalid'],
      });
      return report('rejected');
    }
    backupId = manifest.backup_id;
    backupCreatedAt = manifest.created_at;
    const wraps = manifest.key_wraps as readonly BackupKeyWrapValue[];

    // 復旧キーの確認値（記録がなければ unavailable）と、3 つの包みを開く。
    const keyFile = await readBackupKeyFile(options.dataDir, options.contract);
    const wrapRecoveryIds = new Set(wraps.map((wrap) => wrap.recovery_key_id));
    const recoveryCheck =
      keyFile.ok &&
      wrapRecoveryIds.size === 1 &&
      wrapRecoveryIds.has(keyFile.value.recovery_key.recovery_key_id)
        ? recoveryCheckMatches(
            options.recoveryKey,
            keyFile.value.recovery_key.check_value,
          )
          ? ('match' as const)
          : ('mismatch' as const)
        : ('unavailable' as const);
    if (recoveryCheck === 'mismatch')
      log('復旧キーがこの中枢の記録と違います。');

    const unwrap = {} as Record<BackupKeyPurpose, 'ok' | 'failed'>;
    for (const purpose of BACKUP_KEY_PURPOSES) {
      const wrap = keyWrapFor(wraps, purpose);
      const material =
        wrap === null
          ? null
          : unwrapBackupKey(options.recoveryKey, wrap as BackupKeyWrapValue);
      if (material === null) {
        unwrap[purpose] = 'failed';
        log(`${purpose} の鍵を開けませんでした。`);
      } else {
        unwrap[purpose] = 'ok';
        unwrapped[purpose] = material;
      }
    }

    // 鍵の導入の計画（足すだけで上書きしない）。データ鍵は KeyStore にないときだけ data-key-v1 に置く（U130）。
    // backup-keys.json がなくても、封筒の鍵の ID は KeyStore から直接読む（同じ ID で素材が違う・別用途の衝突を見逃さない）。
    const keyStoreEntries: {
      purpose: BackupKeyPurpose;
      key_id: string;
      material_matches_restored: boolean | null;
    }[] = [];
    const referenced = new Map<
      string,
      { purpose: 'backup_file' | 'ledger_hmac_key'; key_id: string }
    >();
    for (const source of [
      ...(keyFile.ok ? [keyFile.value.key_wraps] : []),
      wraps,
    ]) {
      for (const purpose of ['backup_file', 'ledger_hmac_key'] as const) {
        const wrap = keyWrapFor(source, purpose);
        if (wrap === null) continue;
        referenced.set(`${purpose}:${wrap.key_id}`, {
          purpose,
          key_id: wrap.key_id,
        });
      }
    }
    for (const entry of referenced.values()) {
      const current = await options.backupKeys.read(
        entry.purpose,
        entry.key_id,
      );
      if (!current.ok) continue;
      const restored = unwrapped[entry.purpose];
      keyStoreEntries.push({
        purpose: entry.purpose,
        key_id: entry.key_id,
        material_matches_restored:
          restored === undefined
            ? null
            : current.key.key.length === restored.length &&
              current.key.key.equals(restored),
      });
    }
    const currentDataKey = await options.dataKeys.loadDataKey();
    if (currentDataKey.ok) {
      const restored = unwrapped.data_key;
      keyStoreEntries.push({
        purpose: 'data_key',
        key_id: DATA_KEY_ID,
        material_matches_restored:
          restored === undefined
            ? null
            : currentDataKey.dataKey.key.length === restored.length &&
              currentDataKey.dataKey.key.equals(restored),
      });
    }
    const dataKeyWrap = keyWrapFor(wraps, 'data_key');
    const dataKeyIdOk = dataKeyWrap?.key_id === DATA_KEY_ID;
    const keyInstall = keyInstallPlan({
      key_wraps: wraps,
      keystore: keyStoreEntries,
    });
    const keyInstallOk = dataKeyIdOk && keyInstall.ok;
    if (!keyInstallOk) log('鍵を安全に導入できないため復元を続けません。');

    // 本体の長さと SHA-256 を封筒と照合する。
    const payload = manifest.payload;
    const payloadMatches = await verifyBackupPayload(
      options.backupPath,
      header.payload_offset,
      payload.bytes,
      payload.sha256,
    );
    if (!payloadMatches) log('バックアップの本体が封筒と一致しません。');
    // 本体を復号して作業用の DB に置けたか。復号・書き込みの失敗は backup_unreadable として扱う（鍵は開けても、
    // 封筒の欄の書き換えなどで本体を開けないことがある）。
    let payloadUsable = payloadMatches;

    // 封筒を開け、鍵を導入できるときだけ、作業用の DB に復号する（復旧キーの確認値は打ち間違いの検出だけ）。
    const openable =
      recoveryCheck !== 'mismatch' &&
      BACKUP_KEY_PURPOSES.every((purpose) => unwrap[purpose] === 'ok') &&
      keyInstallOk &&
      payloadMatches;
    if (openable) {
      const backupKey = unwrapped.backup_file as Buffer;
      const keyInfo = manifestPayloadKey(
        manifest as unknown as Record<string, unknown>,
      );
      const encrypted = await readBackupPayload(
        options.backupPath,
        header.payload_offset,
        payload.bytes,
      );
      const plaintext =
        encrypted === null || keyInfo === null
          ? null
          : decryptBackupPayload(
              { key: backupKey, keyId: keyInfo.keyId, fields: keyInfo.fields },
              encrypted,
            );
      if (plaintext === null) {
        log('バックアップの本体を復号できませんでした。');
        payloadUsable = false;
      } else {
        try {
          workingPath = await (
            options.writeWorkingDatabase ?? writeWorkingDatabase
          )(workDir, plaintext);
          rawPayloadDecrypted = true;
        } catch (error) {
          log(`作業用の DB を書けませんでした（${(error as Error).name}）。`);
          payloadUsable = false;
        } finally {
          plaintext.fill(0);
        }
      }
    }

    // --- 段階 1: 台帳の確認 ---
    let ledgerFile: ForgetLedgerFileContent | null = null;
    // ファイルがない（正本は DB）のと、あるのに読めない・壊れているのは違う。後者は最新の忘却を確認できないので止める。
    let ledgerFileProblem: 'none' | 'missing' | 'unreadable' | 'corrupt' =
      'none';
    try {
      const text = await readFile(
        join(options.dataDir, FORGET_LEDGER_FILE),
        'utf8',
      );
      ledgerFile = parseLedgerFile(text);
      if (ledgerFile === null) {
        ledgerFileProblem = 'corrupt';
        log('台帳の別ファイルが意味検査に通りません。');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        ledgerFileProblem = 'missing';
      } else {
        ledgerFileProblem = 'unreadable';
        log(`台帳の別ファイルを読めませんでした（${(error as Error).name}）。`);
      }
    }
    // 書きかけの台帳の一時ファイルが残っていると、確定していないより新しい世代を持つことがある。
    let hasLedgerTemp = false;
    try {
      hasLedgerTemp = (await readdir(options.dataDir)).some(
        (name) => name.startsWith('.forget-ledger-') && name.endsWith('.tmp'),
      );
    } catch {
      hasLedgerTemp = true;
    }
    const ledgerUnconfirmed =
      hasLedgerTemp ||
      (ledgerFileProblem !== 'none' && ledgerFileProblem !== 'missing');
    const hub = await readHubLedger(
      options.dataDir,
      ledgerFile,
      manifest,
      ledgerUnconfirmed,
      log,
    );
    // 期限の判定に使う「最終確認時刻」は、保存期限の掃除の時計の記録（ADR 0058 の U136）と、バックアップの
    // 掃除の記録のうち、より新しい方（どちらも無ければ null）。時計の記録が読めないときは期限を判定できない。
    const state = await readBackupState(options.dataDir);
    const clockState = await createClockStateFile(options.dataDir).load();
    let lastCheckedAt: string | null = null;
    if (clockState.status === 'verified')
      lastCheckedAt = clockState.content.last_checked_at;
    if (
      state.ok &&
      state.value.last_checked_at !== null &&
      (lastCheckedAt === null ||
        Date.parse(state.value.last_checked_at) > Date.parse(lastCheckedAt))
    )
      lastCheckedAt = state.value.last_checked_at;
    const clockUnreadable = clockState.status === 'invalid';
    // 台帳の鍵の KeyStore の ID。backup-keys.json がなくても、封筒の台帳の鍵が KeyStore にあればそれを渡す。
    let ledgerKeyId = keyFile.ok
      ? (keyWrapFor(keyFile.value.key_wraps, 'ledger_hmac_key')?.key_id ?? null)
      : null;
    const envelopeLedgerWrap = keyWrapFor(wraps, 'ledger_hmac_key');
    if (envelopeLedgerWrap !== null) {
      const current = await options.backupKeys.read(
        'ledger_hmac_key',
        envelopeLedgerWrap.key_id,
      );
      if (current.ok) ledgerKeyId = envelopeLedgerWrap.key_id;
    }
    const ledgerCheck = restoreLedgerCheck({
      manifest,
      ledgers: hub.candidates,
      latest_known_generation: hub.known_generation,
      hub_ledger_key: {
        recorded_key_id: hub.recorded_key_id,
        keystore_key_id: ledgerKeyId,
      },
    });
    // 同じ系譜の DB と別ファイルの履歴が食い違う（分岐）ときは、どちらが正しいかを決められない。最新の忘却を
    // 落とし得るので段階 1 で止める（設定も戻さない）。
    const diverged = hub.diverged || ledgerFileProblem === 'corrupt';
    if (diverged)
      log(
        '中枢の DB と台帳の別ファイルの履歴が食い違うか、ファイルが壊れています。',
      );
    const ledgerDecision = diverged
      ? {
          stage: 'ledger_check' as const,
          status: 'failed' as const,
          reasons: ['ledger_chain_invalid' as const],
        }
      : ledgerCheck.decision;
    stages.push({
      stage: 'ledger_check',
      status: ledgerDecision.status === 'failed' ? 'failed' : 'passed',
      reasons: ledgerDecision.reasons,
    });
    settingsOnlyEligible = diverged
      ? false
      : ledgerCheck.settings_only_eligible;
    ledger = diverged ? null : ledgerCheck.ledger;
    if (ledgerDecision.status === 'failed') {
      log(
        `最新の台帳を確認できないため、記憶と会話は戻しません（${ledgerDecision.reasons.join(', ')}）。`,
      );
      return report('rejected');
    }

    // --- 段階 2: 期限切れの削除の前提 ---
    let purgeAppliedAt: string | null = null;
    if (workingPath !== null) {
      const purged = await (
        options.purge ??
        ((path: string, dir: string) =>
          purgeWorkingDatabase(path, dir, options.now))
      )(workingPath, workDir);
      if (purged.ok) purgeAppliedAt = iso(options.now());
      else
        log(
          `期限切れの削除を当てられませんでした（${purged.reasons.join(', ')}）。`,
        );
    }
    const openCheck = restoreOpenCheck({
      manifest_created_at: manifest.created_at,
      started_at: iso(started),
      now: iso(options.now()),
      last_checked_at: lastCheckedAt,
      recovery_check: recoveryCheck,
      unwrap,
      key_install_ok: keyInstallOk,
      payload_matches: payloadUsable,
      purge_applied_at: purgeAppliedAt,
    });
    // 保存期限の時計の記録が読めないときは、期限を判定できない（ADR 0047 の clock_regression）。
    const expiryDecision = clockUnreadable
      ? {
          stage: 'expiry_purge' as const,
          status: 'failed' as const,
          reasons: ['clock_regression' as const],
        }
      : openCheck.decision;
    stages.push({
      stage: 'expiry_purge',
      status: expiryDecision.status === 'failed' ? 'failed' : 'passed',
      reasons: expiryDecision.reasons,
    });
    if (expiryDecision.status === 'failed') {
      log(
        `期限切れの削除の前提を満たさないため、復元を続けません（${expiryDecision.reasons.join(', ')}）。`,
      );
      return report('rejected');
    }
    // 平文の DB を消せないまま成功（終了コード 0）を返さない。消せなければ段階 2 の失敗として報告する。
    let removed = true;
    try {
      await (
        options.removeWorkDir ??
        (async (dir: string) => {
          if (!(await deleteWorkDir(dir))) throw new Error('delete_failed');
        })
      )(workDir);
    } catch {
      removed = false;
    }
    if (!removed) {
      log('作業用の平文の DB を消せませんでした。復元は成功として扱いません。');
      const last = stages.at(-1);
      if (last?.stage === 'expiry_purge')
        stages[stages.length - 1] = {
          stage: 'expiry_purge',
          status: 'failed',
          reasons: ['plaintext_delete_failed'],
        };
      return report('rejected');
    }
    return report('ready');
  } finally {
    for (const material of Object.values(unwrapped)) material.fill(0);
    // 書く途中で例外になった・上の削除に失敗したときも、もう一度だけ消す（成功を返すかは上の判定が決める）。
    await deleteWorkDir(workDir);
    if (locked)
      await releaseLock(options.dataDir, lockId).catch(() => undefined);
  }
}
