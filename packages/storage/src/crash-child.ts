// X60 相当の故障注入の子プロセス（試験専用。index.ts から export しない。ADR 0019）。
// 親（crash-recovery.test.ts）が DB を用意してから起動し、書込み transaction の途中で止まったところを
// プロセスごと強制終了（POSIX は SIGKILL、Windows は TerminateProcess）する。電源断そのものではない。
//
// 使い方: node crash-child.js <worker|bulk> <DB の絶対パス>
// - worker: DB worker で作成・承認・準備をコミットし、送出意図の transaction の COMMIT の前で止まる。
// - bulk: 書込み接続で 20 行をコミットし、続く transaction で 64 KiB の行を 60 行書いて（キャッシュを小さくし、
//   ページの一部を WAL へあふれさせる）COMMIT の前で止まる。
// 標準出力に 1 行ずつ JSON（committed・stalled）を書く。止まったことは DB_WORKER_STALL_MARKER の行で知らせる。

import { statSync, writeSync } from 'node:fs';
import { DB_WORKER_STALL_MARKER } from './db-protocol.js';
import { DbWorkerClient } from './db-client.js';
import { openWriteConnection, storagePlatform } from './connection.js';
import { runImmediate } from './operation-store.js';
import {
  STORE_GENERATION,
  approveCommand,
  createCommand,
  dispatchCommand,
  prepareCommand,
  sealedIntent,
} from './operation-test-support.js';

// 親の試験は期待値をこの値から読まずに手で書く（このファイルは読み込むと動き始めるため import しない）。
const CRASH_COMMITTED_ROWS = 20;
const CRASH_PENDING_ROWS = 60;
const CRASH_ROW_BYTES = 64 * 1024;

const line = (value: object): void => {
  writeSync(1, `${JSON.stringify(value)}\n`);
};

function walBytes(path: string): number {
  try {
    return statSync(`${path}-wal`).size;
  } catch {
    return 0;
  }
}

function stallForever(): never {
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

async function runWorker(path: string): Promise<void> {
  const client = await DbWorkerClient.start({
    path,
    storeGeneration: STORE_GENERATION,
    faults: { stallBeforeCommit: 'operation.dispatch_intent' },
  });
  const outcome = async (command: Parameters<DbWorkerClient['submit']>[0]) => {
    const result = await client.submit(command).result;
    if (result.outcome !== 'durable')
      throw new Error(`durable になりませんでした: ${JSON.stringify(result)}`);
    return result.committed_state_revision;
  };
  await outcome(createCommand('op-crash'));
  await outcome(approveCommand('op-crash', '1'));
  const prepare = prepareCommand('op-crash', '2');
  await outcome(prepare);
  line({ event: 'committed', attempt_id: prepare.attempt_id });
  // worker が COMMIT の前で止まり、標準出力に印を書く。親がプロセスを強制終了する。
  void client.submit(dispatchCommand('op-crash', '3', prepare.attempt_id));
}

function runBulk(path: string): void {
  const db = openWriteConnection(path, { platform: storagePlatform() });
  // この SQLite の既定のページキャッシュは 16 MB。途中の transaction のページが WAL へあふれるように、
  // 試験の子プロセスだけキャッシュを 64 ページに小さくする（耐久設定ではない。読み戻しの対象外）。
  db.pragma('cache_size = 64');
  const insert = db.prepare(
    "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'turn_text', 'turns', ?, 0, 1, 'k-test', ?, ?, ?, 1, NULL)",
  );
  const write = (prefix: string, index: number, bytes: number) => {
    const intent = sealedIntent();
    insert.run(
      `${prefix}-${index}`,
      `${prefix}-${index}`,
      intent.nonce,
      Buffer.alloc(bytes, index % 251),
      intent.tag,
    );
  };
  runImmediate(db, () => {
    for (let index = 0; index < CRASH_COMMITTED_ROWS; index += 1)
      write('committed', index, 128);
  });
  line({ event: 'committed', wal_bytes: walBytes(path) });
  runImmediate(
    db,
    () => {
      for (let index = 0; index < CRASH_PENDING_ROWS; index += 1)
        write('pending', index, CRASH_ROW_BYTES);
    },
    () => {
      line({ event: 'stalled', wal_bytes: walBytes(path) });
      writeSync(1, `${DB_WORKER_STALL_MARKER}\n`);
      stallForever();
    },
  );
}

const [mode, path] = process.argv.slice(2);
if (path === undefined || (mode !== 'worker' && mode !== 'bulk')) {
  process.stderr.write('使い方: crash-child.js <worker|bulk> <path>\n');
  process.exit(2);
}
if (mode === 'worker') await runWorker(path);
else runBulk(path);
