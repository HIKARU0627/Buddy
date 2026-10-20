// Core main と DB worker の間のメッセージ（ADR 0018）。structured clone で渡せる値だけを使う。
// 本文の平文・SQL・パスをメッセージの理由に入れない。

import type { StoragePlatform } from './connection.js';
import type {
  DbCommand,
  DbCommandKind,
  StoreOutcome,
} from './operation-commands.js';
import type {
  CommandReceiptRecord,
  OperationRecord,
  OutboxEventRecord,
  StoreTimings,
} from './operation-store.js';

// 故障注入の試験用。製品の起動では渡さない。指定した種類の命令で一度だけ起こす。
export interface DbWorkerFaults {
  // transaction の本体の後・COMMIT の前に例外を投げる（巻き戻し）。
  readonly throwBeforeCommit?: DbCommandKind;
  // 遅延の外部キー違反を足し、COMMIT を失敗させる（成否不明の扱い）。
  readonly failCommit?: DbCommandKind;
  // COMMIT の前に worker を終了する（未 commit のまま接続が閉じる）。
  readonly exitBeforeCommit?: DbCommandKind;
  // COMMIT の後・応答の前に worker を終了する（durable ACK の喪失）。
  readonly exitAfterCommit?: DbCommandKind;
  // 命令を受け取っても処理も応答もしない（応答なし）。
  readonly ignore?: DbCommandKind;
  // 命令の前に synchronous を NORMAL へ下げる（耐久設定の不一致）。
  readonly weakenDurability?: DbCommandKind;
}

export interface DbWorkerData {
  readonly path: string;
  readonly platform: StoragePlatform;
  readonly workerGeneration: string;
  readonly storeGeneration: string | null;
  readonly connectionSql: string | null;
  readonly faults: DbWorkerFaults;
}

export type DbQuery =
  | { readonly kind: 'operation'; readonly operation_id: string }
  | { readonly kind: 'command'; readonly command_id: string }
  | {
      readonly kind: 'events';
      readonly after_sequence: number;
      readonly limit: number;
    };

export type DbQueryValue =
  OperationRecord | CommandReceiptRecord | readonly OutboxEventRecord[] | null;

export type MainToWorker =
  | {
      readonly type: 'command';
      readonly id: number;
      // performance.timeOrigin + performance.now()（スレッド間で比べられる時刻）。
      readonly sent_at: number;
      readonly command: DbCommand;
    }
  | { readonly type: 'query'; readonly id: number; readonly query: DbQuery }
  | { readonly type: 'close'; readonly id: number };

export interface WorkerTimings extends StoreTimings {
  // Core main が送ってから worker が処理を始めるまで（IPC と待ち行列の待ち）。
  readonly queue_wait_ms: number;
}

export type WorkerToMain =
  | {
      readonly type: 'ready';
      readonly worker_generation: string;
      readonly store_generation: string;
      readonly schema_version: number;
    }
  | {
      readonly type: 'start_failed';
      readonly reason: string;
      readonly reasons: readonly string[];
    }
  // 受付 ACK。worker が命令を受け取っただけで、保存済みでも送出の許可でもない。
  | { readonly type: 'received'; readonly id: number }
  | {
      readonly type: 'result';
      readonly id: number;
      readonly worker_generation: string;
      readonly outcome: StoreOutcome;
      readonly halted: boolean;
      readonly timings: WorkerTimings;
    }
  | {
      readonly type: 'query_result';
      readonly id: number;
      readonly value: DbQueryValue;
    }
  | {
      readonly type: 'query_failed';
      readonly id: number;
      readonly reason: string;
    }
  | { readonly type: 'closed'; readonly id: number };

export function timestamp(): number {
  return performance.timeOrigin + performance.now();
}
