// 同期の走査の実行器の provider 振り分け（B09-04、ADR 0138）。
//
// 周期起動（sync-scheduler.ts）は provider を持たない対象を受けて 1 つの実行器を呼ぶ。Google 用
// （sync-executor.ts）と Graph 用（graph-sync-executor.ts）の実行器が揃ったため、接続の provider を
// 保存層で確かめてから該当の実行器へ渡す薄い振り分けをここに置く。走査の規則は各実行器が持ち、
// ここは振り分けだけを持つ（接続が読めない・無いときは、どちらの実行器も呼ばず unavailable にする）。

import type { DbWorkerClient } from '@buddy/storage';
import type {
  SyncExecutor,
  SyncScanOutcome,
  SyncScanRequest,
} from './sync-executor.js';

export interface ProviderSyncExecutorOptions {
  readonly store: Pick<DbWorkerClient, 'connectionTargets'>;
  readonly google: SyncExecutor;
  readonly microsoft: SyncExecutor;
}

export function createProviderSyncExecutor(
  options: ProviderSyncExecutorOptions,
): SyncExecutor {
  async function runScan(request: SyncScanRequest): Promise<SyncScanOutcome> {
    const result = await options.store.connectionTargets({
      kind: 'connections.get',
      connection_id: request.connection_id,
    });
    if (!result.ok)
      return { status: 'unavailable', reason: 'store_unavailable' };
    const connection = result.value;
    if (connection === null)
      return { status: 'unavailable', reason: 'connection_not_found' };
    return connection.provider === 'microsoft'
      ? options.microsoft.runScan(request)
      : options.google.runScan(request);
  }
  return { runScan };
}
