// 書込み接続の PRAGMA の設定・読み戻し・不一致の注入（ADR 0016）。DB は一時ディレクトリに作って消す。
// 期待値は手で書いた値。読み戻しの一致は電源断の耐久性の証明ではない（X60 は未実施）。

import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  StorageError,
  applyConnectionPragmas,
  openWriteConnection,
  readConnectionPragmas,
  readConnectionSql,
  storagePlatform,
  writeConnectionReasons,
} from './index.js';
import type { SqliteDatabase, StoragePlatform } from './index.js';

const posix = process.platform !== 'win32';
const PLATFORMS: readonly StoragePlatform[] = ['macos', 'windows', 'linux'];

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-storage-'));
  try {
    run(dir);
  } finally {
    // 接続を閉じ忘れると Windows では消せずにここで失敗する。
    rmSync(dir, { recursive: true, force: true });
  }
}

function withConnection(run: (db: SqliteDatabase, dir: string) => void): void {
  withTempDir((dir) => {
    const db = openWriteConnection(join(dir, 'data', 'buddy.sqlite'), {
      platform: 'macos',
    });
    try {
      run(db, dir);
    } finally {
      db.close();
    }
  });
}

function rejection(run: () => unknown): StorageError {
  try {
    run();
  } catch (error) {
    assert(error instanceof StorageError, String(error));
    return error;
  }
  assert.fail('拒否されませんでした');
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

test('a write connection on a temporary file reads back WAL / FULL / fullfsync / foreign keys / busy_timeout 0', () => {
  withConnection((db) => {
    assert.deepEqual(readConnectionPragmas(db), {
      journal_mode: 'wal',
      synchronous: 2,
      fullfsync: 1,
      foreign_keys: 1,
      busy_timeout: 0,
    });
    for (const platform of PLATFORMS)
      assert.deepEqual(writeConnectionReasons(db, platform), [], platform);
  });
});

test('a pragma changed after configuration is detected on read-back', () => {
  const cases: readonly {
    readonly sql: string;
    readonly macos: readonly string[];
    readonly other: readonly string[];
  }[] = [
    {
      sql: 'PRAGMA synchronous = NORMAL',
      macos: ['synchronous_not_full'],
      other: ['synchronous_not_full'],
    },
    {
      sql: 'PRAGMA synchronous = OFF',
      macos: ['synchronous_not_full'],
      other: ['synchronous_not_full'],
    },
    {
      sql: 'PRAGMA fullfsync = OFF',
      macos: ['fullfsync_off'],
      other: [],
    },
    {
      sql: 'PRAGMA foreign_keys = OFF',
      macos: ['foreign_keys_off'],
      other: ['foreign_keys_off'],
    },
    {
      sql: 'PRAGMA busy_timeout = 5000',
      macos: ['busy_timeout_not_zero'],
      other: ['busy_timeout_not_zero'],
    },
    {
      sql: 'PRAGMA journal_mode = DELETE',
      macos: ['journal_mode_not_wal'],
      other: ['journal_mode_not_wal'],
    },
  ];
  for (const { sql, macos, other } of cases)
    withConnection((db) => {
      db.exec(sql);
      assert.deepEqual(writeConnectionReasons(db, 'macos'), macos, sql);
      assert.deepEqual(writeConnectionReasons(db, 'windows'), other, sql);
      assert.deepEqual(writeConnectionReasons(db, 'linux'), other, sql);
    });
});

test('an in-memory database cannot use WAL and is rejected as a write connection', () => {
  const error = rejection(() =>
    openWriteConnection(':memory:', { platform: 'linux' }),
  );
  assert.equal(error.reason, 'write_connection_rejected');
  assert.deepEqual(error.reasons, ['journal_mode_not_wal']);

  const memory = new Database(':memory:', { timeout: 0 });
  try {
    applyConnectionPragmas(memory);
    assert.equal(readConnectionPragmas(memory).journal_mode, 'memory');
    assert.deepEqual(writeConnectionReasons(memory, 'macos'), [
      'journal_mode_not_wal',
    ]);
  } finally {
    memory.close();
  }
});

const WAL_ONLY =
  'PRAGMA journal_mode = WAL;\nPRAGMA foreign_keys = ON;\nPRAGMA busy_timeout = 0;\n';

function assertEmpty(path: string): void {
  const check = new Database(path, { readonly: true, timeout: 0 });
  try {
    assert.equal(
      check.prepare('SELECT count(*) FROM sqlite_schema').pluck().get(),
      0,
    );
  } finally {
    check.close();
  }
}

test('a weakened connection script is rejected, the connection is closed and nothing is written', () => {
  const scripts: readonly {
    readonly sql: string;
    readonly macos: readonly string[];
  }[] = [
    {
      // 設定の後に NORMAL へ戻した接続。
      sql: `${readConnectionSql()}\nPRAGMA synchronous = NORMAL;\n`,
      macos: ['synchronous_not_full'],
    },
    {
      // 新しい DB で WAL だけを設定した接続（synchronous は既定の FULL のまま、fullfsync は OFF）。
      sql: WAL_ONLY,
      macos: ['fullfsync_off'],
    },
    {
      sql: `${readConnectionSql()}\nPRAGMA foreign_keys = OFF;\n`,
      macos: ['foreign_keys_off'],
    },
  ];
  for (const { sql, macos } of scripts)
    withTempDir((dir) => {
      const path = join(dir, 'buddy.sqlite');
      const error = rejection(() =>
        openWriteConnection(path, { platform: 'macos', connectionSql: sql }),
      );
      assert.equal(error.reason, 'write_connection_rejected');
      assert.deepEqual(error.reasons, macos);
      assertEmpty(path);
    });
});

test('reopening a WAL database without setting synchronous falls back to NORMAL and is rejected', () => {
  // この SQLite は SQLITE_DEFAULT_WAL_SYNCHRONOUS=1 で、WAL のファイルを開き直すと
  // synchronous を明示しない限り NORMAL になる。毎回の設定と読み戻しが要る理由。
  withTempDir((dir) => {
    const path = join(dir, 'buddy.sqlite');
    openWriteConnection(path, { platform: 'macos' }).close();
    const error = rejection(() =>
      openWriteConnection(path, { platform: 'macos', connectionSql: WAL_ONLY }),
    );
    assert.deepEqual(error.reasons, ['synchronous_not_full', 'fullfsync_off']);
    const windows = rejection(() =>
      openWriteConnection(path, {
        platform: 'windows',
        connectionSql: WAL_ONLY,
      }),
    );
    assert.deepEqual(windows.reasons, ['synchronous_not_full']);
    assertEmpty(path);
    // 既定の connection.sql なら開き直しても FULL。
    const db = openWriteConnection(path, { platform: 'macos' });
    try {
      assert.equal(readConnectionPragmas(db).synchronous, 2);
    } finally {
      db.close();
    }
  });
});

test('database paths must be absolute plain files', () => {
  assert.equal(
    rejection(() =>
      openWriteConnection('relative.sqlite', { platform: 'linux' }),
    ).reason,
    'database_path_not_absolute',
  );
  for (const path of ['', 'file:buddy.sqlite', ' /tmp/buddy.sqlite'])
    assert.equal(
      rejection(() => openWriteConnection(path, { platform: 'linux' })).reason,
      'database_path_invalid',
      path,
    );
  withTempDir((dir) => {
    mkdirSync(join(dir, 'folder.sqlite'));
    assert.equal(
      rejection(() =>
        openWriteConnection(join(dir, 'folder.sqlite'), { platform: 'linux' }),
      ).reason,
      'database_path_not_file',
    );
  });
});

test(
  'POSIX: the database directory is 0700 and the database, WAL and SHM files are 0600',
  {
    skip: !posix,
  },
  () => {
    withConnection((db, dir) => {
      db.exec(
        'CREATE TABLE probe (x INTEGER) STRICT; INSERT INTO probe VALUES (1);',
      );
      const base = join(dir, 'data', 'buddy.sqlite');
      assert.equal(mode(join(dir, 'data')), 0o700);
      assert.equal(mode(base), 0o600);
      assert.equal(mode(`${base}-wal`), 0o600);
      assert.equal(mode(`${base}-shm`), 0o600);
    });
    withTempDir((dir) => {
      const data = join(dir, 'data');
      mkdirSync(data, { mode: 0o755 });
      chmodSync(data, 0o755);
      const path = join(data, 'buddy.sqlite');
      writeFileSync(path, '');
      chmodSync(path, 0o644);
      openWriteConnection(path, { platform: 'linux' }).close();
      assert.equal(mode(data), 0o700);
      assert.equal(mode(path), 0o600);
    });
  },
);

test(
  'POSIX: a symbolic link is not accepted as the database file',
  {
    skip: !posix,
  },
  () => {
    withTempDir((dir) => {
      const target = join(dir, 'target.sqlite');
      writeFileSync(target, '');
      symlinkSync(target, join(dir, 'link.sqlite'));
      assert.equal(
        rejection(() =>
          openWriteConnection(join(dir, 'link.sqlite'), { platform: 'linux' }),
        ).reason,
        'database_path_symlink',
      );
    });
  },
);

test('platform names map to the storage platforms', () => {
  assert.equal(storagePlatform('darwin'), 'macos');
  assert.equal(storagePlatform('win32'), 'windows');
  assert.equal(storagePlatform('linux'), 'linux');
  assert.equal(
    rejection(() => storagePlatform('freebsd')).reason,
    'platform_unsupported',
  );
});
