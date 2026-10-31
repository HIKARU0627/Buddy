// 制御チャネルのバックアップの操作（ADR 0055）。中枢のローカルの CLI（OS の本人の利用者だけが使える制御チャネル）から。
// running のときだけ。応答は ID・件数・理由コードだけで、鍵・復旧キー・置き場所のパス・本文を載せない。

import type { BackupKeyStore } from '@buddy/platform';
import type { ApiContract } from './api-contract.js';
import type { ControlRequest, ControlResponse } from './control-protocol.js';
import type { BackupService, BackupStore } from './backup-service.js';
import { inspectBackupSetup, recordBackupSetup } from './backup-setup.js';
import type { LifecycleState } from './lifecycle.js';

export interface BackupControlContext {
  readonly dataDir: string;
  readonly contract: ApiContract;
  readonly service: BackupService;
  readonly store: BackupStore;
  readonly backupKeys: BackupKeyStore;
}

export type BackupControlRequest = Extract<
  ControlRequest,
  {
    op:
      | 'backup_status'
      | 'backup_run'
      | 'backup_setup_inspect'
      | 'backup_setup_record';
  }
>;

export function isBackupControlRequest(
  request: ControlRequest,
): request is BackupControlRequest {
  return (
    request.op === 'backup_status' ||
    request.op === 'backup_run' ||
    request.op === 'backup_setup_inspect' ||
    request.op === 'backup_setup_record'
  );
}

const refused = (reasons: readonly string[]): ControlResponse => ({
  ok: false,
  error: 'refused',
  reason: reasons.join(','),
});

export async function backupControl(
  request: BackupControlRequest,
  state: LifecycleState,
  context: BackupControlContext | null,
): Promise<{ readonly response: ControlResponse }> {
  if (state !== 'running' || context === null)
    return { response: { ok: false, error: 'unavailable' } };
  const reply = (
    backup: Readonly<Record<string, unknown>>,
  ): ControlResponse => ({
    ok: true,
    request_id: request.request_id,
    backup,
  });
  switch (request.op) {
    case 'backup_status': {
      const status = await context.service.status();
      return {
        response: reply({
          kind: 'status',
          ...status,
          // 置き場所のパスは出さない（検査の結果だけ）。
          location:
            status.location === null
              ? null
              : {
                  usable: status.location.usable,
                  problems: status.location.problems,
                  warnings: status.location.warnings,
                  sync_provider_hint: status.location.sync_provider_hint,
                },
        }),
      };
    }
    case 'backup_run': {
      const result = await context.service.run();
      return { response: reply({ kind: 'run', ...result }) };
    }
    case 'backup_setup_inspect': {
      const inspected = await inspectBackupSetup(context.store);
      return {
        response: inspected.ok
          ? reply({ kind: 'setup_inspect', ...inspected })
          : refused(inspected.reasons),
      };
    }
    case 'backup_setup_record': {
      const recorded = await recordBackupSetup({
        dataDir: context.dataDir,
        contract: context.contract,
        store: context.store,
        backupKeys: context.backupKeys,
        ledgerHmacKeyId: request.ledger_hmac_key_id,
      });
      return {
        response: recorded.ok
          ? reply({ kind: 'setup_record', ...recorded })
          : refused(recorded.reasons),
      };
    }
  }
}
