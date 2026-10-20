// X60 相当の故障注入（ADR 0019）。書込み transaction の途中で、DB を書いているプロセスを強制終了し
// （POSIX は SIGKILL、Windows は TerminateProcess。後始末の処理は動かない）、開き直した DB を確かめる。
// - PRAGMA integrity_check が ok、外部キーの違反がない
// - 途中の transaction の変更は残っていない、コミット済みの変更は残っている
// これは電源断・OS の停止・ストレージの書込みキャッシュの喪失の試験ではない（X60 の電源断と T07 は未実施）。
// プロセスの強制終了では OS のページキャッシュは失われないため、fsync の効き目は確かめていない。
// 期待値（行数・状態・state_revision）は手で書いた値。DB は一時ディレクトリに作って消す。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DB_WORKER_STALL_MARKER,
  openWriteConnection,
  storagePlatform,
} from './index.js';
import type { SqliteDatabase } from './index.js';
import {
  databasePath,
  eventRows,
  openSeededDatabase,
  operationState,
  receiptRows,
  withTempDir,
} from './operation-test-support.js';

const CHILD = fileURLToPath(new URL('./crash-child.js', import.meta.url));
const TIMEOUT_MS = 30_000;

interface CrashRun {
  readonly lines: readonly Record<string, unknown>[];
  readonly signal: NodeJS.Signals | null;
  readonly code: number | null;
}

// 子プロセスを動かし、止まった印を受け取ったら強制終了して、終了を待つ。
function crashChild(mode: 'worker' | 'bulk', path: string): Promise<CrashRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, mode, path], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: Record<string, unknown>[] = [];
    let stderr = '';
    let stalled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`止まった印を受け取れませんでした: ${stderr}`));
    }, TIMEOUT_MS);
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text;
    });
    createInterface({ input: child.stdout }).on('line', (text) => {
      if (text === DB_WORKER_STALL_MARKER) {
        stalled = true;
        // 後始末をさせない強制終了。
        child.kill('SIGKILL');
        return;
      }
      lines.push(JSON.parse(text) as Record<string, unknown>);
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (!stalled) {
        reject(new Error(`止まる前に終了しました（${code}）: ${stderr}`));
        return;
      }
      resolve({ lines, signal, code });
    });
  });
}

function assertHealthy(db: SqliteDatabase): void {
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

function assertKilled(run: CrashRun): void {
  // POSIX はシグナルで、Windows は終了コードで終わる（どちらも正常終了ではない）。
  if (process.platform === 'win32') assert.notEqual(run.code, 0);
  else assert.equal(run.signal, 'SIGKILL');
}

test(
  'a DB worker process killed before the dispatch intent COMMIT leaves a healthy DB without the partial change',
  { timeout: 60_000 },
  async () => {
    await withTempDir(async (dir) => {
      const path = databasePath(dir);
      openSeededDatabase(path).close();
      const run = await crashChild('worker', path);
      assertKilled(run);
      const committed = run.lines.find(
        (entry) => entry['event'] === 'committed',
      );
      assert(committed);
      const db = openWriteConnection(path, { platform: storagePlatform() });
      try {
        assertHealthy(db);
        // 作成・承認・準備（state_revision 1〜3）は残り、途中の送出意図（4）は残っていない。
        assert.deepEqual(operationState(db, 'op-crash'), {
          state: 'preparing',
          state_revision: 3,
        });
        const attempts = db
          .prepare(
            'SELECT attempt_id, status, dispatch_intent_at FROM operation_attempts',
          )
          .all();
        assert.deepEqual(attempts, [
          {
            attempt_id: committed['attempt_id'],
            status: 'preparing',
            dispatch_intent_at: null,
          },
        ]);
        assert.deepEqual(
          eventRows(db).map((event) => event.state_revision),
          [1, 2, 3],
        );
        assert.deepEqual(
          receiptRows(db).map((receipt) => receipt.committed_state_revision),
          [1, 2, 3],
        );
      } finally {
        db.close();
      }
    });
  },
);

test(
  'a process killed in the middle of a large transaction whose pages reached the WAL keeps only committed rows',
  { timeout: 60_000 },
  async () => {
    await withTempDir(async (dir) => {
      const path = databasePath(dir);
      openSeededDatabase(path).close();
      const run = await crashChild('bulk', path);
      assertKilled(run);
      const committed = run.lines.find(
        (entry) => entry['event'] === 'committed',
      );
      const stalled = run.lines.find((entry) => entry['event'] === 'stalled');
      assert(committed && stalled);
      // 途中の transaction のページの一部が WAL へ書き出されていた（キャッシュからのあふれ）。
      // コミットの印のないフレームとして、開き直しのときに読み飛ばされることを確かめる。
      assert(
        Number(stalled['wal_bytes']) > Number(committed['wal_bytes']),
        JSON.stringify(run.lines),
      );
      const db = openWriteConnection(path, { platform: storagePlatform() });
      try {
        assertHealthy(db);
        const counts = db
          .prepare(
            "SELECT sum(blob_id GLOB 'committed-*') AS committed, sum(blob_id GLOB 'pending-*') AS pending FROM sealed_blobs",
          )
          .get();
        assert.deepEqual(counts, { committed: 20, pending: 0 });
        // 開き直した DB に続けて書ける。
        db.prepare(
          "DELETE FROM sealed_blobs WHERE blob_id = 'committed-0'",
        ).run();
        assertHealthy(db);
      } finally {
        db.close();
      }
    });
  },
);
