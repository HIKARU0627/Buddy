// バックアップの設定（復旧キーの作成・3 つの鍵の包み・台帳の系譜と鍵の記録。本人の判断 J1、ADR 0040・0047・0055）。
//
// 復旧キー（256 ビット）は CLI のプロセスが OS の乱数で作り、作った直後に 1 度だけ端末の画面へ出す。Core には渡さない
// （制御チャネル・HTTP・イベント・ログ・DB・バックアップに出さない。ADR 0012 は緩めない）。Core が受け取るのは、包んだ鍵
// （backup-keys.json）と台帳の鍵の ID だけ。流れ:
//   1. CLI: 動いている Core に DB の事実を尋ねる（backup_setup_inspect。台帳の鍵の記録・忘却の世代・暗号文の鍵の ID）。
//   2. CLI: domain の backupSetupKeyPlan で、鍵を保つ（作り直さない）か新しく作るかを決める。台帳に項目がある・台帳の鍵を
//      記録したのに KeyStore にない、などは止める（作ると忘れた元情報の再取り込みを止められなくなる）。データ鍵は読むだけ。
//   3. CLI: 鍵を KeyStore に置き、3 つの鍵を新しい復旧キーで包み、backup-keys.json（state: not_shown）を書く。
//   4. CLI: Core に台帳の鍵の ID を知らせる（backup_setup_record）。Core は包みと KeyStore を確かめてから DB に記録し、
//      台帳の系譜がなく台帳が空なら系譜を付ける。
//   5. CLI: 復旧キーを 1 度だけ画面へ出し、backup-keys.json を shown にする。
// 設定をやり直すと復旧キーは新しくなる。古い復旧キーで包んだ古いバックアップは、古い復旧キーで開く（保持の世代が入れ替わる
// まで、古い復旧キーも保管しておく）。

import { randomBytes, randomUUID } from 'node:crypto';
import {
  backupSetupKeyPlan,
  encodeRecoveryCode,
  keyWrapFor,
} from '@buddy/domain';
import type {
  BackupKeyPurpose,
  BackupSetupKeyPlan,
  KeyStoreKeyRef,
} from '@buddy/domain';
import type { BackupKeyStore } from '@buddy/platform';
import {
  newRecoveryKey,
  recoveryCheckValue,
  wrapBackupKey,
} from '@buddy/storage';
import type { BackupKeyWrapValue, DataKeyProvider } from '@buddy/storage';
import type { ApiContract } from './api-contract.js';
import { readBackupKeyFile, writeBackupKeyFile } from './backup-files.js';
import type { BackupKeyFileValue } from './backup-files.js';
import type { BackupStore } from './backup-service.js';

// --- Core の側 ---

export type SetupInspectResult =
  | {
      readonly ok: true;
      readonly recorded_ledger_key_id: string | null;
      readonly forgetting_generation: string;
      readonly db_blob_key_ids: readonly string[];
    }
  | { readonly ok: false; readonly reasons: readonly string[] };

export async function inspectBackupSetup(
  store: BackupStore,
): Promise<SetupInspectResult> {
  const facts = await store.memory({ kind: 'backup.facts' });
  if (!facts.ok) return { ok: false, reasons: facts.reasons };
  return {
    ok: true,
    recorded_ledger_key_id: facts.value.recorded_ledger_key_id,
    forgetting_generation: facts.value.forgetting_generation,
    db_blob_key_ids: facts.value.db_blob_key_ids,
  };
}

export type SetupRecordResult =
  | {
      readonly ok: true;
      readonly ledger_id: string;
      readonly ledger_hmac_key_id: string;
      readonly forgetting_generation: string;
    }
  | { readonly ok: false; readonly reasons: readonly string[] };

// CLI が書いた包み（backup-keys.json）と KeyStore の鍵を確かめてから、台帳の鍵の ID と系譜を DB に記録する。
export async function recordBackupSetup(options: {
  readonly dataDir: string;
  readonly contract: ApiContract;
  readonly store: BackupStore;
  readonly backupKeys: BackupKeyStore;
  readonly ledgerHmacKeyId: string;
}): Promise<SetupRecordResult> {
  const keyFile = await readBackupKeyFile(options.dataDir, options.contract);
  if (!keyFile.ok)
    return {
      ok: false,
      reasons: [
        keyFile.reason === 'missing'
          ? 'backup_keys_missing'
          : 'backup_keys_invalid',
      ],
    };
  const ledger = keyWrapFor(keyFile.value.key_wraps, 'ledger_hmac_key');
  const file = keyWrapFor(keyFile.value.key_wraps, 'backup_file');
  if (ledger === null || file === null)
    return { ok: false, reasons: ['backup_keys_invalid'] };
  // 包んだ鍵の ID が、知らされた台帳の鍵の ID と同じこと（取り違えて記録しない）。
  if (ledger.key_id !== options.ledgerHmacKeyId)
    return { ok: false, reasons: ['ledger_key_id_mismatch'] };
  // KeyStore に実際に鍵があること（包みだけがあって鍵がない状態を記録しない）。
  const [ledgerKey, fileKey] = await Promise.all([
    options.backupKeys.read('ledger_hmac_key', ledger.key_id),
    options.backupKeys.read('backup_file', file.key_id),
  ]);
  if (!ledgerKey.ok)
    return { ok: false, reasons: [`ledger_key_${ledgerKey.reason}`] };
  if (!fileKey.ok)
    return { ok: false, reasons: [`backup_key_${fileKey.reason}`] };
  const recorded = await options.store.memory({
    kind: 'backup.record_setup',
    ledger_id: randomUUID(),
    ledger_hmac_key_id: ledger.key_id,
  });
  if (!recorded.ok) return { ok: false, reasons: recorded.reasons };
  return { ok: true, ...recorded.value };
}

// --- CLI の側 ---

export interface SetupRefusal {
  readonly ok: false;
  readonly stage: 'inspect' | 'plan' | 'keystore' | 'write' | 'record';
  readonly reasons: readonly string[];
}

export interface SetupSuccess {
  readonly ok: true;
  readonly recovery_key_id: string;
  readonly ledger_id: string;
  readonly actions: Readonly<Record<BackupKeyPurpose, 'reuse' | 'generate'>>;
  readonly forgetting_generation: string;
  // 復旧キーを画面へ出し終えて、記録を shown にしたか。false なら記録は not_shown のまま（もう一度設定する）。
  readonly shown: boolean;
}

export interface BackupSetupDeps {
  readonly dataDir: string;
  readonly contract: ApiContract;
  readonly dataKeys: DataKeyProvider;
  readonly backupKeys: BackupKeyStore;
  readonly now: () => Date;
  // Core に尋ねる・知らせる（制御チャネル）。
  readonly inspect: () => Promise<SetupInspectResult>;
  readonly record: (ledgerHmacKeyId: string) => Promise<SetupRecordResult>;
  // 復旧キーを端末の画面へ出す。出せなければ例外を投げる（shown にしない）。
  readonly display: (display: {
    readonly recovery_key_id: string;
    readonly created_at: string;
    readonly recovery_code: string;
  }) => void;
}

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

export async function runBackupSetup(
  deps: BackupSetupDeps,
): Promise<SetupSuccess | SetupRefusal> {
  const inspected = await deps.inspect();
  if (!inspected.ok)
    return { ok: false, stage: 'inspect', reasons: inspected.reasons };
  const existing = await readBackupKeyFile(deps.dataDir, deps.contract);
  const existingWraps = existing.ok ? existing.value.key_wraps : [];
  // 今 KeyStore にある鍵（ID で引く）。
  const refFor = async (
    purpose: 'backup_file' | 'ledger_hmac_key',
    keyId: string | null,
  ): Promise<KeyStoreKeyRef | null> => {
    if (keyId === null) return null;
    const read = await deps.backupKeys.read(purpose, keyId);
    return read.ok ? { key_id: keyId } : null;
  };
  const fileWrap = keyWrapFor(existingWraps, 'backup_file');
  const ledgerWrap = keyWrapFor(existingWraps, 'ledger_hmac_key');
  const dataKey = await deps.dataKeys.loadDataKey();
  const plan: BackupSetupKeyPlan = backupSetupKeyPlan({
    keystore: {
      backup_file: await refFor('backup_file', fileWrap?.key_id ?? null),
      data_key: dataKey.ok ? { key_id: dataKey.dataKey.keyId } : null,
      // 台帳の鍵は DB に記録した ID を優先する（記録があるのに KeyStore になければ止める）。
      ledger_hmac_key: await refFor(
        'ledger_hmac_key',
        inspected.recorded_ledger_key_id ?? ledgerWrap?.key_id ?? null,
      ),
    },
    recorded_ledger_key_id: inspected.recorded_ledger_key_id,
    forgetting_generation: inspected.forgetting_generation,
    db_blob_key_ids: inspected.db_blob_key_ids,
  });
  if (!plan.ok || !dataKey.ok)
    return {
      ok: false,
      stage: 'plan',
      reasons: plan.ok
        ? [dataKey.ok ? 'plan_failed' : dataKey.reason]
        : plan.reasons,
    };
  // 3 つの鍵の素材と ID。reuse は KeyStore から読み、generate は新しく作って置く。
  const materials = {} as Record<
    BackupKeyPurpose,
    { key_id: string; material: Buffer }
  >;
  materials.data_key = {
    key_id: dataKey.dataKey.keyId,
    material: Buffer.from(dataKey.dataKey.key),
  };
  for (const [purpose, prefix, existingId] of [
    ['backup_file', 'backup-file', fileWrap?.key_id ?? null],
    [
      'ledger_hmac_key',
      'ledger-hmac',
      inspected.recorded_ledger_key_id ?? ledgerWrap?.key_id ?? null,
    ],
  ] as const) {
    if (plan.actions[purpose] === 'reuse' && existingId !== null) {
      const read = await deps.backupKeys.read(purpose, existingId);
      if (!read.ok)
        return { ok: false, stage: 'keystore', reasons: [read.reason] };
      materials[purpose] = { key_id: existingId, material: read.key.key };
    } else {
      const keyId = `${prefix}-${hex(8)}`;
      const material = randomBytes(32);
      const put = await deps.backupKeys.put(purpose, keyId, material);
      if (!put.ok)
        return { ok: false, stage: 'keystore', reasons: [put.reason] };
      materials[purpose] = { key_id: keyId, material };
    }
  }
  const createdAt = deps.now().toISOString();
  const recoveryKey = newRecoveryKey();
  const recoveryKeyId = randomUUID();
  const wraps: BackupKeyWrapValue[] = (
    ['backup_file', 'data_key', 'ledger_hmac_key'] as const
  ).map((purpose) =>
    wrapBackupKey({
      recoveryKey,
      recoveryKeyId,
      purpose,
      keyId: materials[purpose].key_id,
      material: materials[purpose].material,
    }),
  );
  const file: BackupKeyFileValue = {
    schema: 'buddy.backup-keys.v1',
    recovery_key: {
      schema: 'buddy.recovery-key-record.v1',
      recovery_key_id: recoveryKeyId,
      created_at: createdAt,
      check_value: recoveryCheckValue(recoveryKey),
      state: 'not_shown',
      shown_at: null,
    },
    key_wraps: wraps,
  };
  if (
    !deps.contract.valid('RecoveryKeyRecord', file.recovery_key) ||
    !wraps.every((wrap) => deps.contract.valid('BackupKeyWrap', wrap))
  )
    return { ok: false, stage: 'write', reasons: ['key_file_schema_invalid'] };
  try {
    await writeBackupKeyFile(deps.dataDir, file);
  } catch {
    return { ok: false, stage: 'write', reasons: ['key_file_write_failed'] };
  }
  const recorded = await deps.record(materials.ledger_hmac_key.key_id);
  if (!recorded.ok)
    return { ok: false, stage: 'record', reasons: recorded.reasons };
  let shown: boolean;
  try {
    deps.display({
      recovery_key_id: recoveryKeyId,
      created_at: createdAt,
      recovery_code: encodeRecoveryCode(recoveryKey),
    });
    await writeBackupKeyFile(deps.dataDir, {
      ...file,
      recovery_key: {
        ...file.recovery_key,
        state: 'shown',
        shown_at: deps.now().toISOString(),
      },
    });
    shown = true;
  } catch {
    shown = false;
  }
  // 復旧キーのバイト列を消す（JavaScript ではメモリ上の消去を保証できない。ADR 0017）。
  recoveryKey.fill(0);
  return {
    ok: true,
    recovery_key_id: recoveryKeyId,
    ledger_id: recorded.ledger_id,
    actions: plan.actions,
    forgetting_generation: recorded.forgetting_generation,
    shown,
  };
}
