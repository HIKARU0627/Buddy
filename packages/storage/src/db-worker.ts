// DB worker（設計 11 §9 P06、08 §3、ADR 0018）。worker_threads の中で実行する。
//
// - better-sqlite3 の書込み接続を所有する単一 writer。openWriteConnection で耐久設定を読み戻し、
//   applyMigrations で版をそろえてから受付を始める。
// - メッセージを一つずつ同期で処理する（transaction の本体に await を挟まない）。外部 HTTP は実行しない。
// - 成否不明・想定外の失敗・耐久設定の不一致の後は書込みを止め（halted）、以後の命令を拒否する。
//   接続の作り直しは Core main が前の世代の終了を確かめてから新しい worker で行う。
//
// このファイルは index.ts から export しない（読み込むと worker として動き始めるため）。

import { writeSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { openWriteConnection } from './connection.js';
import type { SqliteDatabase } from './connection.js';
import { DB_WORKER_STALL_MARKER, timestamp } from './db-protocol.js';
import type {
  DbQueryValue,
  DbWorkerData,
  DbWorkerFaults,
  MainToWorker,
  WorkerToMain,
} from './db-protocol.js';
import { StorageError } from './errors.js';
import { applyMigrations, initStoreGeneration } from './migrations.js';
import type { DbCommand } from './operation-commands.js';
import {
  executeCommand,
  listInterruptedOperations,
  listOutboxEvents,
  readCommandReceipt,
  readOperation,
} from './operation-store.js';
import { bindStore } from './store-binding.js';
import type { StoreBindingResult } from './store-binding.js';

function main(): void {
  const port = parentPort;
  if (port === null)
    throw new Error(
      'db-worker.js は worker_threads の中で読み込んでください。',
    );
  const data = workerData as DbWorkerData;
  const post = (message: WorkerToMain): void => port.postMessage(message);

  let db: SqliteDatabase | null = null;
  let storeGeneration: string;
  let schemaVersion: number;
  let binding: StoreBindingResult | null = null;
  try {
    db = openWriteConnection(data.path, {
      platform: data.platform,
      ...(data.connectionSql === null
        ? {}
        : { connectionSql: data.connectionSql }),
    });
    schemaVersion = applyMigrations(db).to;
    if (data.binding !== null) {
      // Core の起動（ADR 0019）: 健全性・鍵の照合値・store_generation を確かめてから受付を始める。
      binding = bindStore(db, data.binding);
      storeGeneration = binding.storeGeneration;
    } else
      storeGeneration = initStoreGeneration(
        db,
        ...(data.storeGeneration === null ? [] : [data.storeGeneration]),
      ).storeGeneration;
  } catch (error) {
    db?.close();
    const storage = error instanceof StorageError ? error : null;
    post({
      type: 'start_failed',
      reason: storage?.reason ?? 'db_worker_start_failed',
      reasons: storage?.reasons ?? ['db_worker_start_failed'],
    });
    port.close();
    return;
  }
  const connection: SqliteDatabase = db;
  const faults: { -readonly [K in keyof DbWorkerFaults]: DbWorkerFaults[K] } = {
    ...data.faults,
  };
  let halted = false;

  // 指定した種類の命令で一度だけ起こす故障。
  const takeFault = (
    name: keyof DbWorkerFaults,
    command: DbCommand,
  ): boolean => {
    if (faults[name] !== command.kind) return false;
    delete faults[name];
    return true;
  };

  const beforeCommit = (command: DbCommand): void => {
    if (takeFault('throwBeforeCommit', command))
      throw new Error('注入した失敗（COMMIT の前）');
    if (takeFault('exitBeforeCommit', command)) process.exit(70);
    if (takeFault('stallBeforeCommit', command)) {
      // 標準出力へ同期で印を書き、COMMIT せずに止まり続ける。親がプロセスごと強制終了する。
      writeSync(1, `${DB_WORKER_STALL_MARKER}\n`);
      for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    if (takeFault('failCommit', command)) {
      // 遅延の外部キー違反は COMMIT の時に検出される。
      connection.pragma('defer_foreign_keys = ON');
      connection
        .prepare(
          "INSERT INTO operation_steps (attempt_id, step_id, step_kind) VALUES ('fault-missing-attempt', 'fault', 'fault')",
        )
        .run();
    }
  };

  const handleCommand = (
    message: Extract<MainToWorker, { type: 'command' }>,
  ): void => {
    const command = message.command;
    if (takeFault('ignore', command)) return;
    post({ type: 'received', id: message.id });
    const started = timestamp();
    if (takeFault('weakenDurability', command))
      connection.pragma('synchronous = NORMAL');
    if (halted) {
      post({
        type: 'result',
        id: message.id,
        worker_generation: data.workerGeneration,
        outcome: {
          outcome: 'rejected',
          command_id: command.command_id,
          kind: command.kind,
          reasons: ['worker_halted'],
        },
        halted,
        timings: {
          queue_wait_ms: started - message.sent_at,
          transaction_ms: 0,
          commit_ms: null,
        },
      });
      return;
    }
    const result = executeCommand(connection, command, {
      now: Date.now(),
      platform: data.platform,
      storeGeneration,
      beforeCommit,
    });
    if (result.halt) halted = true;
    if (
      result.outcome.outcome !== 'rejected' &&
      result.outcome.outcome !== 'unknown' &&
      takeFault('exitAfterCommit', command)
    )
      process.exit(71);
    post({
      type: 'result',
      id: message.id,
      worker_generation: data.workerGeneration,
      outcome: result.outcome,
      halted,
      timings: { queue_wait_ms: started - message.sent_at, ...result.timings },
    });
  };

  const handleQuery = (
    message: Extract<MainToWorker, { type: 'query' }>,
  ): void => {
    try {
      const query = message.query;
      let value: DbQueryValue;
      if (query.kind === 'operation')
        value = readOperation(connection, query.operation_id);
      else if (query.kind === 'command')
        value = readCommandReceipt(connection, query.command_id);
      else if (query.kind === 'interrupted')
        value = listInterruptedOperations(connection);
      else
        value = listOutboxEvents(
          connection,
          storeGeneration,
          query.after_sequence,
          query.limit,
        );
      post({ type: 'query_result', id: message.id, value });
    } catch {
      post({ type: 'query_failed', id: message.id, reason: 'query_failed' });
    }
  };

  port.on('message', (message: MainToWorker) => {
    if (message.type === 'command') handleCommand(message);
    else if (message.type === 'query') handleQuery(message);
    else if (message.type === 'close') {
      halted = true;
      connection.close();
      post({ type: 'closed', id: message.id });
      port.close();
    }
  });
  post({
    type: 'ready',
    worker_generation: data.workerGeneration,
    store_generation: storeGeneration,
    schema_version: schemaVersion,
    binding,
  });
}

main();
