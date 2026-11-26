// 家計の記録の CSV を本人が選んだ場所へ書く処理（ADR 0172）の試験。前半はファイルシステムを模擬にして、開き方・権限・
// 失敗したときの後始末（何を消し、何を消さないか）を手で確かめる。後半は実際のファイルシステムで確かめる。
// 実機の保存先の選択・Windows と macOS での実際の権限は未実施。
import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CREATE_FLAGS,
  OVERWRITE_FLAGS,
  writeHouseholdExportFile,
} from './household-export-file.js';
import type {
  HouseholdExportFileHandle,
  HouseholdExportFileSystem,
} from './household-export-file.js';

const realFileSystem: HouseholdExportFileSystem = {
  lstat: (path) => lstat(path),
  open: (path, flags, mode) => open(path, flags, mode),
  rm: (path, options) => rm(path, options),
};

// Windows のファイルの権限は ACL で決まり、chmod では読み取り専用の印しか変わらない。シンボリックリンクの作成も、管理者の
// 権限か開発者モードがないと失敗する。そのため、権限とシンボリックリンクの実ファイルの試験は Windows では行わない
// （模擬の試験で同じ分岐を確かめる）。
const posix = process.platform !== 'win32';
// root（試験環境のコンテナなど）は、読み取り専用のファイルにも書けてしまうので、読み取り専用の実ファイルの試験が成り立たない。
const readOnlyEffective = posix && process.getuid?.() !== 0;

interface Script {
  readonly calls: string[];
  readonly fileSystem: HouseholdExportFileSystem;
}

// 呼び出しを記録する模擬。existing が true ならパスはすでにある（新規の open は EEXIST）。
function fake(options: {
  readonly existing?: boolean;
  readonly link?: boolean;
  readonly lstatError?: string;
  readonly createError?: string;
  readonly overwriteError?: string;
  readonly chmodError?: boolean;
  readonly truncateError?: boolean;
  readonly writeError?: boolean;
  readonly closeError?: boolean;
  readonly rmError?: boolean;
}): Script {
  const calls: string[] = [];
  const handle: HouseholdExportFileHandle = {
    chmod: (mode) => {
      calls.push(`chmod ${mode.toString(8)}`);
      return options.chmodError === true
        ? Promise.reject(new Error('EPERM'))
        : Promise.resolve();
    },
    truncate: (length) => {
      calls.push(`truncate ${String(length)}`);
      return options.truncateError === true
        ? Promise.reject(new Error('EIO'))
        : Promise.resolve();
    },
    writeFile: (text, writeOptions) => {
      calls.push(`write ${text} ${writeOptions.encoding}`);
      return options.writeError === true
        ? Promise.reject(new Error('ENOSPC'))
        : Promise.resolve();
    },
    close: () => {
      calls.push('close');
      return options.closeError === true
        ? Promise.reject(new Error('EIO'))
        : Promise.resolve();
    },
  };
  const coded = (code: string): Error =>
    Object.assign(new Error(code), { code });
  return {
    calls,
    fileSystem: {
      lstat: (path) => {
        calls.push(`lstat ${path}`);
        if (options.lstatError !== undefined)
          return Promise.reject(coded(options.lstatError));
        if (options.existing !== true && options.link !== true)
          return Promise.reject(coded('ENOENT'));
        return Promise.resolve({ isSymbolicLink: () => options.link === true });
      },
      open: (path, flags, mode) => {
        const kind =
          flags === CREATE_FLAGS
            ? 'create'
            : flags === OVERWRITE_FLAGS
              ? 'overwrite'
              : 'other';
        calls.push(`open ${kind} ${path} ${mode.toString(8)}`);
        if (kind === 'create') {
          if (options.createError !== undefined)
            return Promise.reject(coded(options.createError));
          if (options.existing === true) return Promise.reject(coded('EEXIST'));
        }
        if (kind === 'overwrite' && options.overwriteError !== undefined)
          return Promise.reject(coded(options.overwriteError));
        return Promise.resolve(handle);
      },
      rm: (path, rmOptions) => {
        calls.push(`rm ${path} force=${String(rmOptions.force)}`);
        return options.rmError === true
          ? Promise.reject(new Error('EBUSY'))
          : Promise.resolve();
      },
    },
  };
}

test('a new file is created exclusively with owner-only mode, then written as UTF-8 and closed; nothing is removed', async () => {
  const s = fake({});
  assert.equal(
    await writeHouseholdExportFile(
      '/chosen/家計.csv',
      '﻿a,b\r\n',
      s.fileSystem,
    ),
    'saved',
  );
  assert.deepEqual(s.calls, [
    'lstat /chosen/家計.csv',
    'open create /chosen/家計.csv 600',
    'chmod 600',
    'write ﻿a,b\r\n utf8',
    'close',
  ]);
});

test('an existing file is opened for overwriting, set to owner-only before the plaintext is written, and never removed on success', async () => {
  const s = fake({ existing: true });
  assert.equal(
    await writeHouseholdExportFile('/chosen/a.csv', 'x', s.fileSystem),
    'saved',
  );
  assert.deepEqual(s.calls, [
    'lstat /chosen/a.csv',
    'open create /chosen/a.csv 600',
    'open overwrite /chosen/a.csv 600',
    'chmod 600',
    'truncate 0',
    'write x utf8',
    'close',
  ]);
});

test('a symbolic link, or a link swapped in before the open, is refused and nothing is opened or removed', async () => {
  const link = fake({ link: true });
  assert.equal(
    await writeHouseholdExportFile('/chosen/l.csv', 'x', link.fileSystem),
    'link_refused',
  );
  assert.deepEqual(link.calls, ['lstat /chosen/l.csv']);
  // lstat の後にリンクへ差し替えられた（O_NOFOLLOW で開けず ELOOP）。
  const swapped = fake({ existing: true, overwriteError: 'ELOOP' });
  assert.equal(
    await writeHouseholdExportFile('/chosen/l.csv', 'x', swapped.fileSystem),
    'link_refused',
  );
  assert.equal(
    swapped.calls.some((call) => call.startsWith('rm ')),
    false,
  );
});

test('when the file cannot be opened nothing is created and nothing is removed, so the user keeps the original', async () => {
  for (const [name, script] of [
    // 読み取り専用の既存のファイル（EACCES）。以前はここで rm が本人のファイルを消した。
    ['read-only existing', fake({ existing: true, overwriteError: 'EACCES' })],
    ['busy existing', fake({ existing: true, overwriteError: 'EBUSY' })],
    ['missing folder', fake({ createError: 'ENOENT' })],
    ['no permission in folder', fake({ createError: 'EACCES' })],
    ['unreadable path', fake({ lstatError: 'EACCES' })],
  ] as const) {
    assert.equal(
      await writeHouseholdExportFile('/chosen/r.csv', 'x', script.fileSystem),
      'failed_unchanged',
      name,
    );
    assert.equal(
      script.calls.some((call) => call.startsWith('rm ')),
      false,
      name,
    );
    assert.equal(
      script.calls.some((call) => call.startsWith('write ')),
      false,
      name,
    );
  }
});

test('a failure after creating a new file removes it (all of write, chmod and close), and reports whether the removal worked', async () => {
  for (const [name, options] of [
    ['write', { writeError: true }],
    ['chmod', { chmodError: true }],
    ['close', { closeError: true }],
  ] as const) {
    const s = fake(options);
    assert.equal(
      await writeHouseholdExportFile('/chosen/n.csv', 'x', s.fileSystem),
      'failed_removed',
      name,
    );
    assert.equal(s.calls.at(-1), 'rm /chosen/n.csv force=true', name);
    assert.equal(
      s.calls.indexOf('close') < s.calls.indexOf('rm /chosen/n.csv force=true'),
      true,
      name,
    );
  }
  // 消せなかったときは、消したとは言わない。
  assert.equal(
    await writeHouseholdExportFile(
      '/chosen/n.csv',
      'x',
      fake({ writeError: true, rmError: true }).fileSystem,
    ),
    'failed_left',
  );
});

test('a failure after truncating an existing file leaves it in place (it is the user file; the old content is already gone) and reports that', async () => {
  for (const [name, options] of [
    ['truncate', { truncateError: true }],
    ['write', { writeError: true }],
    ['close', { closeError: true }],
  ] as const) {
    const s = fake({ existing: true, ...options });
    assert.equal(
      await writeHouseholdExportFile('/chosen/e.csv', 'x', s.fileSystem),
      'failed_left',
      name,
    );
    assert.equal(
      s.calls.some((call) => call.startsWith('rm ')),
      false,
      name,
    );
    assert.equal(s.calls.at(-1), 'close', name);
  }
  // 権限を変えられず、切り詰める前に止まったときは、元の中身はそのまま残っている。
  const s = fake({ existing: true, chmodError: true });
  assert.equal(
    await writeHouseholdExportFile('/chosen/e.csv', 'x', s.fileSystem),
    'failed_unchanged',
  );
  assert.deepEqual(s.calls, [
    'lstat /chosen/e.csv',
    'open create /chosen/e.csv 600',
    'open overwrite /chosen/e.csv 600',
    'chmod 600',
    'close',
  ]);
});

test('with the real file system: a new file is owner-only (0600) and starts with the BOM; no temporary file is left', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-export-'));
  try {
    const target = join(dir, 'buddy-household-2030-11.csv');
    const text = '﻿計算対象,日付\r\n1,2030/11/03\r\n';
    assert.equal(
      await writeHouseholdExportFile(target, text, realFileSystem),
      'saved',
    );
    const bytes = await readFile(target);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bytes.toString('utf8'), text);
    assert.deepEqual(await readdir(dir), ['buddy-household-2030-11.csv']);
    if (posix) assert.equal((await stat(target)).mode & 0o777, 0o600);
    else t.diagnostic('Windows: 権限（0600）の確認は行わない');
    // 存在しないフォルダは書けない（失敗）。何も作らない。
    assert.equal(
      await writeHouseholdExportFile(
        join(dir, 'missing', 'a.csv'),
        'x',
        realFileSystem,
      ),
      'failed_unchanged',
    );
    assert.deepEqual(await readdir(dir), ['buddy-household-2030-11.csv']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'with the real file system: overwriting an existing 0644 file replaces the content and makes it 0600',
  { skip: !posix && 'Windows: 権限はモードで表せない' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'buddy-export-'));
    try {
      const target = join(dir, 'old.csv');
      await writeFile(target, 'old content that is longer than the new one');
      await chmod(target, 0o644);
      assert.equal((await stat(target)).mode & 0o777, 0o644);
      assert.equal(
        await writeHouseholdExportFile(target, 'new', realFileSystem),
        'saved',
      );
      assert.equal(await readFile(target, 'utf8'), 'new');
      assert.equal((await stat(target)).mode & 0o777, 0o600);
      assert.deepEqual(await readdir(dir), ['old.csv']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'with the real file system: a read-only existing file is neither removed nor changed',
  {
    skip:
      !readOnlyEffective &&
      'Windows では chmod の読み取り専用の効き方が異なり、root（試験環境のコンテナなど）は読み取り専用にも書けるため、実ファイルでは確かめない。模擬の試験（開けなかったとき何も消さない）で確かめている',
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'buddy-export-'));
    const target = join(dir, 'mine.csv');
    try {
      await writeFile(target, 'original');
      await chmod(target, 0o444);
      assert.equal(
        await writeHouseholdExportFile(target, 'new', realFileSystem),
        'failed_unchanged',
      );
      assert.equal(await readFile(target, 'utf8'), 'original');
      assert.equal((await stat(target)).mode & 0o777, 0o444);
      assert.deepEqual(await readdir(dir), ['mine.csv']);
    } finally {
      await chmod(target, 0o644).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'with the real file system: a symbolic link is refused and its target is unchanged',
  { skip: !posix && 'Windows: シンボリックリンクの作成に特別な権限が要る' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'buddy-export-'));
    try {
      const real = join(dir, 'real.csv');
      const link = join(dir, 'link.csv');
      await writeFile(real, 'precious');
      await symlink(real, link);
      assert.equal(
        await writeHouseholdExportFile(link, 'new', realFileSystem),
        'link_refused',
      );
      assert.equal(await readFile(real, 'utf8'), 'precious');
      assert.equal((await lstat(link)).isSymbolicLink(), true);
      // リンク先がないリンク（切れたリンク）も、リンク先を作らずに拒否する。
      const dangling = join(dir, 'dangling.csv');
      await symlink(join(dir, 'nothing.csv'), dangling);
      assert.equal(
        await writeHouseholdExportFile(dangling, 'new', realFileSystem),
        'link_refused',
      );
      assert.deepEqual((await readdir(dir)).sort(), [
        'dangling.csv',
        'link.csv',
        'real.csv',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('with the real file system: a write failure on a newly created file removes it, and a failing write leaves another existing file alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-export-'));
  try {
    // 書き込みだけを失敗させる（開く・消すは実物）。
    const failingWrite: HouseholdExportFileSystem = {
      ...realFileSystem,
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        return {
          chmod: (m) => handle.chmod(m),
          truncate: (length) => handle.truncate(length),
          writeFile: () => Promise.reject(new Error('ENOSPC')),
          close: () => handle.close(),
        };
      },
    };
    const created = join(dir, 'created.csv');
    assert.equal(
      await writeHouseholdExportFile(created, 'x', failingWrite),
      'failed_removed',
    );
    assert.deepEqual(await readdir(dir), []);
    // すでにあるファイルは、切り詰められた後に書けなくても消えない。
    const existing = join(dir, 'existing.csv');
    await writeFile(existing, 'old');
    assert.equal(
      await writeHouseholdExportFile(existing, 'x', failingWrite),
      'failed_left',
    );
    assert.deepEqual(await readdir(dir), ['existing.csv']);
    assert.equal(await readFile(existing, 'utf8'), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
