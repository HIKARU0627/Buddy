// バックアップのスナップショット（設計 03「DB を稼働中にファイル 1 つだけコピーせず、SQLite の整合したスナップショットを
// 取得」、ADR 0047・0055）。
// 稼働中の DB を読み取り専用の別接続で開き、SQLite の backup API で整合した写しを作業用のファイルに取る。写しから、
// 含めない表（BACKUP_EXCLUDED_TABLES。短命の運用データ）とその表が持つ暗号文（sealed_blobs の owner_table）を消し、
// VACUUM で空き領域の古い内容も消してから、1 つのファイル（journal なし）にする。封筒の値は写しから読む（取った時点の値）。
// 表の一覧が含める・含めないのどちらにもない（未知の表）ときは、何が入っているか分からないので取らない。
// 生音声・記録しない会話・OAuth トークン・API キーは DB の表ではない（保存しない・KeyStore）ので、ここには現れない。

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { backupTablePlan } from '@buddy/domain';
import { readBackupFacts } from './backup-facts.js';
import type { BackupFacts } from './backup-facts.js';
import { ForgetRejection } from './forget-store.js';

export type BackupSnapshotResult =
  | {
      readonly ok: true;
      // 作業用の写しのファイル（呼び出し側が読んだ後に消す）。
      readonly path: string;
      readonly bytes: number;
      // 取った時点の値（含めない表を消す前後で同じ）。
      readonly facts: BackupFacts;
      // 封筒の excluded_tables（辞書順）。
      readonly excluded_tables: readonly string[];
      // 写しから消した暗号文（除外した表が持つもの）の数。
      readonly excluded_blobs_removed: number;
    }
  | {
      readonly ok: false;
      readonly reasons: readonly string[];
    };

export interface BackupSnapshotOptions {
  // 稼働中の DB のパス（読み取り専用で開く）。
  readonly sourcePath: string;
  // 作業用のディレクトリ（なければ作る）。写しはここに置き、呼び出し側が消す。
  readonly workDir: string;
  // 試験用: 写しを取った後・含めない表を消す前に呼ぶ（取った後に稼働中の DB が書かれても写しは変わらない確認）。
  readonly afterCopy?: () => void;
}

const BACKUP_PAGES_PER_STEP = 1000;

async function discard(path: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    await rm(`${path}${suffix}`, { force: true });
}

export async function takeBackupSnapshot(
  options: BackupSnapshotOptions,
): Promise<BackupSnapshotResult> {
  await mkdir(options.workDir, { recursive: true, mode: 0o700 });
  const path = join(options.workDir, `snapshot-${randomUUID()}.sqlite`);
  let source: Database.Database | null = null;
  let copy: Database.Database | null = null;
  try {
    source = new Database(options.sourcePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 5000,
    });
    await source.backup(path, {
      progress: () => BACKUP_PAGES_PER_STEP,
    });
    source.close();
    source = null;
    options.afterCopy?.();

    copy = new Database(path, { fileMustExist: true, timeout: 5000 });
    // 消した内容を空き領域に残さない（VACUUM でも作り直す）。
    copy.pragma('secure_delete = ON');
    const facts = readBackupFacts(copy);
    const plan = backupTablePlan(facts.tables);
    if (!plan.ok) {
      copy.close();
      copy = null;
      await discard(path);
      return { ok: false, reasons: plan.reasons };
    }
    // 除外した表の行は、他の表の参照の順序に依らず消す（検査は消した後にまとめて行う）。
    copy.pragma('foreign_keys = OFF');
    let blobsRemoved = 0;
    copy.transaction(() => {
      for (const table of plan.excluded_tables) {
        blobsRemoved += copy!
          .prepare('DELETE FROM sealed_blobs WHERE owner_table = ?')
          .run(table).changes;
      }
      for (const table of plan.excluded_tables)
        copy!.exec(`DELETE FROM "${table.replace(/"/gu, '""')}"`);
    })();
    const violations = copy.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      copy.close();
      copy = null;
      await discard(path);
      return { ok: false, reasons: ['snapshot_foreign_key_violation'] };
    }
    copy.exec('VACUUM');
    copy.pragma('wal_checkpoint(TRUNCATE)');
    copy.pragma('journal_mode = DELETE');
    const integrity = copy.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      copy.close();
      copy = null;
      await discard(path);
      return { ok: false, reasons: ['snapshot_integrity_failed'] };
    }
    // 除外の前後で、封筒に書く値が変わっていないこと（除外した表が台帳・鍵の記録に触れていない）。
    const after = readBackupFacts(copy);
    copy.close();
    copy = null;
    if (
      after.store_generation !== facts.store_generation ||
      after.forgetting_generation !== facts.forgetting_generation ||
      after.ledger_head_hash !== facts.ledger_head_hash
    ) {
      await discard(path);
      return { ok: false, reasons: ['snapshot_facts_changed'] };
    }
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
    return {
      ok: true,
      path,
      bytes: (await stat(path)).size,
      facts: after,
      excluded_tables: plan.excluded_tables,
      excluded_blobs_removed: blobsRemoved,
    };
  } catch (error) {
    source?.close();
    copy?.close();
    await discard(path);
    if (error instanceof ForgetRejection)
      return { ok: false, reasons: error.reasons };
    const code =
      error instanceof Database.SqliteError ? error.code : 'snapshot_failed';
    return { ok: false, reasons: [`snapshot_failed:${code}`] };
  }
}

export { discard as discardSnapshotFiles };
