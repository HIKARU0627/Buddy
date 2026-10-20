// 起動時の回復（設計 08 §4、ADR 0019）。DB worker の準備の後、制御チャネルを開く前に一度だけ行う。
//
// - dispatching（送出意図の COMMIT の後に中枢が止まった）: 送ったかどうか記録上分からないので、
//   DB worker の命令（operation.recover_after_restart）で unknown_held へ回す。自動では再送しない。
//   回復はイベント・内部の受付と同じ transaction で記録される。
// - preparing（送出意図の前）: 変更要求をまだ送っていないことが記録上確かなので、そのまま残す。
//   最新状態の確認（参照確認）からの再開は B04 の担当。耐久設定の読み戻し・DB の健全性の確認に
//   通らない DB では Core 自体が起動しない（preparing を未送出と判断する前提が崩れているため）。
// - reconciling・unknown_held はそのまま（照合と本人の判断は B04 以降）。

import { randomUUID } from 'node:crypto';
import type { DbWorkerClient } from '@buddy/storage';

export interface RecoveryReport {
  // unknown_held へ回した操作の ID。
  readonly held: readonly string[];
  // preparing のまま残した操作の ID（参照確認から再開できる。再開は B04）。
  readonly resumable: readonly string[];
}

export class RecoveryError extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`起動時の回復に失敗しました: ${reasons.join(', ')}`);
    this.name = 'RecoveryError';
    this.reasons = reasons;
  }
}

export async function recoverInterruptedOperations(
  store: DbWorkerClient,
): Promise<RecoveryReport> {
  const interrupted = await store.query({ kind: 'interrupted' });
  const held: string[] = [];
  const resumable: string[] = [];
  for (const entry of interrupted) {
    if (entry.state === 'preparing') {
      resumable.push(entry.operation_id);
      continue;
    }
    if (entry.attempt_id === null)
      throw new RecoveryError(['dispatching_attempt_missing']);
    const outcome = await store.submit({
      command_id: randomUUID(),
      kind: 'operation.recover_after_restart',
      operation_id: entry.operation_id,
      expected_state_revision: entry.state_revision,
      // 回復は依頼・許可・忘却の版で拒否しない（store の recoverAfterRestart は照合しない）。
      request_revision: null,
      permission_revision: '0',
      forgetting_generation: '0',
      connection_id: null,
      request: null,
      attempt_id: entry.attempt_id,
    }).result;
    if (outcome.outcome !== 'durable')
      throw new RecoveryError(
        outcome.outcome === 'rejected' ? outcome.reasons : [outcome.reason],
      );
    held.push(entry.operation_id);
  }
  return { held, resumable };
}
