// 壊れた・DB より進んだ忘却台帳のファイルを、本人が手で復旧する（設計 03、ADR 0054 の U109・U129、ADR 0057）。
//
// DB の台帳（forget_ledger）が正本。別ファイル（forget-ledger.json）は DB から作り直せる写しだが、ファイルが
// 壊れている・DB より進んでいる・食い違っているときは、Core は起動しない（安全側）。この CLI は、中枢・端末の
// 複製・バックアップの封筒の台帳を材料に、DB が「知っている最新」であることを確かめてから、ファイルを退避して
// DB から作り直す。DB が古い（封筒の台帳が進んでいる）ときは復元（restore run）に進ませる。
//
// 復旧キーは使わない（DB の台帳は鍵なしで読める。封筒の台帳の hash は封筒に書かれている）。本文・HMAC・パスを
// 出力しない。Core は止めておく（動いていると拒否する）。

import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_ZERO_HASH, type BackupManifestLike } from '@buddy/domain';
import {
  buildLedgerFile,
  exportForgetLedger,
  openWriteConnection,
  parseLedgerFile,
  readBackupFileHeader,
  storagePlatform,
  writeLedgerFileAtomic,
} from '@buddy/storage';
import type { ForgetLedgerExport } from '@buddy/storage';
import type { ApiContract } from './api-contract.js';
import { BACKUP_CONFIG_FILE, loadBackupConfig } from './backup-config.js';
import { prepareDataDir } from './data-dir.js';
import { acquireLock, defaultIsPidAlive, releaseLock } from './lock.js';
import { DB_FILE, FORGET_LEDGER_FILE, controlEndpoint } from './paths.js';

export const RESTORE_REPAIR_SCHEMA = 'buddy.restore-ledger-repair.v1';

export interface RestoreRepairOptions {
  readonly dataDir: string;
  readonly contract: ApiContract;
  readonly now: () => Date;
  readonly log?: (message: string) => void;
  readonly lock?: boolean;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly probeTimeoutMs?: number;
}

export interface RestoreRepairReport {
  readonly schema: typeof RESTORE_REPAIR_SCHEMA;
  readonly outcome: 'rebuilt' | 'no_change' | 'refused';
  readonly reason: string | null;
  readonly ledger: { readonly head_generation: string } | null;
  readonly aside_kept: boolean;
}

const iso = (date: Date): string => date.toISOString().replace(/[:.]/gu, '-');

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readDbLedger(
  dataDir: string,
): Promise<
  | { readonly ok: true; readonly value: ForgetLedgerExport }
  | { readonly ok: false; readonly reason: string }
> {
  const dbPath = join(dataDir, DB_FILE);
  if (!(await exists(dbPath))) return { ok: false, reason: 'hub_db_missing' };
  try {
    const db = openWriteConnection(dbPath, {
      platform: storagePlatform(process.platform),
    });
    try {
      return { ok: true, value: exportForgetLedger(db) };
    } finally {
      db.close();
    }
  } catch {
    return { ok: false, reason: 'hub_ledger_invalid' };
  }
}

// 封筒の台帳が DB の台帳と矛盾しないこと（同じ系譜・DB より先でない・同じ世代の hash が同じ）。
// 読めない封筒があると、それが新しい世代を持ち得るので確かめられないものとして扱う。
async function checkEnvelopes(
  dataDir: string,
  contract: ApiContract,
  exported: ForgetLedgerExport,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly reason: string }
> {
  const config = await loadBackupConfig({
    path: join(dataDir, BACKUP_CONFIG_FILE),
    contract,
  });
  if (!config.ok) return { ok: false, reason: 'backup_config_invalid' };
  let names: string[];
  try {
    names = await readdir(config.config.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true };
    return { ok: false, reason: 'backup_directory_unreadable' };
  }
  const head = BigInt(exported.head.forgetting_generation);
  for (const name of names.filter((value) => value.endsWith('.buddybackup'))) {
    const header = await readBackupFileHeader(
      join(config.config.directory, name),
    );
    if (!header.ok) return { ok: false, reason: 'backup_unreadable' };
    const manifest = header.manifest as unknown as BackupManifestLike;
    if (
      exported.ledger_id !== null &&
      manifest.ledger_id !== exported.ledger_id
    )
      continue;
    const generation = BigInt(manifest.forgetting_generation);
    if (generation > head)
      return { ok: false, reason: 'backup_newer_than_ledger' };
    const expected =
      generation === 0n
        ? BACKUP_ZERO_HASH
        : exported.entries[Number(generation) - 1]?.entry_hash;
    if (expected === undefined || expected !== manifest.ledger_head_hash)
      return { ok: false, reason: 'backup_ledger_hash_mismatch' };
  }
  return { ok: true };
}

export async function runRestoreLedgerRepair(
  options: RestoreRepairOptions,
): Promise<RestoreRepairReport> {
  const log = options.log ?? (() => undefined);
  const refuse = (reason: string): RestoreRepairReport => ({
    schema: RESTORE_REPAIR_SCHEMA,
    outcome: 'refused',
    reason,
    ledger: null,
    aside_kept: false,
  });
  try {
    await prepareDataDir(options.dataDir);
  } catch {
    return refuse('data_dir_unavailable');
  }
  const endpoint = controlEndpoint(options.dataDir, process.platform);
  const lockId = randomUUID();
  let locked = false;
  if (options.lock !== false) {
    try {
      await acquireLock({
        dataDir: options.dataDir,
        endpoint,
        record: {
          pid: process.pid,
          core_instance_id: lockId,
          started_at: options.now().toISOString(),
        },
        isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
        probeTimeoutMs: options.probeTimeoutMs ?? 1000,
        removeStaleEndpoint: async () => {
          if (process.platform !== 'win32') await rm(endpoint, { force: true });
        },
      });
      locked = true;
    } catch {
      log('Core が動いているため、台帳を復旧しません。');
      return refuse('core_running');
    }
  }
  try {
    return await repair(options, log);
  } catch {
    return refuse('internal_error');
  } finally {
    if (locked)
      await releaseLock(options.dataDir, lockId).catch(() => undefined);
  }
}

async function repair(
  options: RestoreRepairOptions,
  log: (message: string) => void,
): Promise<RestoreRepairReport> {
  const refuse = (reason: string): RestoreRepairReport => {
    log(`台帳を復旧できません（${reason}）。`);
    return {
      schema: RESTORE_REPAIR_SCHEMA,
      outcome: 'refused',
      reason,
      ledger: null,
      aside_kept: false,
    };
  };
  const db = await readDbLedger(options.dataDir);
  if (!db.ok) return refuse(db.reason);
  const exported = db.value;
  if (exported.ledger_id === null) {
    // 台帳に系譜がない（まだ 1 件も忘れていない）。ファイルに項目があれば DB が古い疑い。
    let text: string | null = null;
    try {
      text = await readFile(join(options.dataDir, FORGET_LEDGER_FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return refuse('ledger_file_unreadable');
    }
    if (text !== null) {
      const file = parseLedgerFile(text);
      if (file === null) return refuse('ledger_file_invalid');
      if (file.entries.length > 0) return refuse('ledger_file_ahead');
    }
    return {
      schema: RESTORE_REPAIR_SCHEMA,
      outcome: 'no_change',
      reason: null,
      ledger: { head_generation: exported.head.forgetting_generation },
      aside_kept: false,
    };
  }
  const envelopes = await checkEnvelopes(
    options.dataDir,
    options.contract,
    exported,
  );
  if (!envelopes.ok) return refuse(envelopes.reason);

  const path = join(options.dataDir, FORGET_LEDGER_FILE);
  let text: string | null = null;
  let fileProblem: string | null = null;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      fileProblem = 'ledger_file_unreadable';
  }
  const file = text === null ? null : parseLedgerFile(text);
  if (text !== null && file === null) fileProblem = 'ledger_file_invalid';
  if (file !== null) {
    if (file.ledger_id !== exported.ledger_id)
      return refuse('ledger_lineage_mismatch');
    if (file.entries.length > exported.entries.length)
      return refuse('ledger_file_ahead');
    const common = Math.min(file.entries.length, exported.entries.length);
    for (let index = 0; index < common; index += 1)
      if (
        file.entries[index]?.entry_hash !== exported.entries[index]?.entry_hash
      ) {
        fileProblem = 'ledger_file_diverged';
        break;
      }
    if (
      fileProblem === null &&
      file.head.entry_hash === exported.head.entry_hash &&
      file.entries.length === exported.entries.length
    )
      return {
        schema: RESTORE_REPAIR_SCHEMA,
        outcome: 'no_change',
        reason: null,
        ledger: { head_generation: exported.head.forgetting_generation },
        aside_kept: false,
      };
  }

  // ここまでで DB が封筒と矛盾せず、ファイルは欠落・壊れ・遅れ・食い違い（DB が正しいと確認できた）。
  // ファイルを退避してから、DB の台帳から作り直す。
  let asideKept = false;
  if (await exists(path)) {
    const aside = `${path}.repair-${iso(options.now())}-${randomUUID()}`;
    try {
      await rename(path, aside);
      asideKept = true;
    } catch {
      return refuse('ledger_file_aside_failed');
    }
  }
  try {
    await writeLedgerFileAtomic(path, buildLedgerFile(exported, options.now()));
  } catch {
    return refuse('ledger_file_rebuild_failed');
  }
  log('台帳の別ファイルを DB から作り直しました。');
  return {
    schema: RESTORE_REPAIR_SCHEMA,
    outcome: 'rebuilt',
    reason: null,
    ledger: { head_generation: exported.head.forgetting_generation },
    aside_kept: asideKept,
  };
}
