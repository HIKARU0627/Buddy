// Windows の DPAPI の鍵の保護（ADR 0202）の試験。
// 模擬の試験は模擬の PowerShell（runner）と一時ディレクトリだけを使い、どの OS でも動く。実機の DPAPI には触れない。
// 末尾の「Windows の実機の DPAPI」の試験だけは Windows（CI の windows-latest）で本物の PowerShell と DPAPI を使い、
// 一時ディレクトリに保護した blob を作る（本人の %LOCALAPPDATA% には触れない）。
// 期待値は手書き。ファイル名の SHA-256 は sha256sum で、base64 は base64 コマンドで別に求めた値。
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
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
import type { CommandResult } from './runner.js';
import {
  DPAPI_POWERSHELL_ARGS,
  KeyStoreUnavailableError,
  createBackupKeyStore,
  createKeyProtectionProbe,
  createKeyStore,
  createMockStdinCommandRunner,
  createNodeStdinCommandRunner,
  createOAuthTokenStore,
  createTlsKeyStore,
  createWindowsDpapiBackupKeyStore,
  createWindowsDpapiKeyStore,
  createWindowsDpapiOAuthTokenStore,
  createWindowsDpapiTlsKeyStore,
  defaultWindowsKeyStoreDir,
  dpapiFileName,
  keyProtectionPreflight,
  OAuthTokens,
  windowsDpapiSlotOpener,
  windowsPowerShellPath,
} from './index.js';
import type {
  SecretSlot,
  StdinCommandRunner,
  WindowsDpapiOptions,
} from './index.js';

const POWERSHELL =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PLAIN_VALUE = 'synthetic value';
const PLAIN_VALUE_B64 = 'c3ludGhldGljIHZhbHVl';
const DATA_ITEM_FILE =
  'f3f713e821f8b661a04d5d41a8774dc017d611c80512b87e4e996c66fa8e854a.dpapi';
const DATA_ITEM_ENTROPY_B64 = 'ZGV2LmJ1ZGR5LmNvcmUvZGF0YS1rZXktdjE=';
// 模擬の DPAPI が 'synthetic value' を項目 data-key-v1 で保護した値（entropy ‖ 0x00 ‖ 各バイトを 0x5a と XOR）。
const FAKE_BLOB_B64 =
  'ZGV2LmJ1ZGR5LmNvcmUvZGF0YS1rZXktdjEAKSM0LjI/LjM5eiw7Ni8/';

interface FakeDpapiOptions {
  /** 次の呼び出しから返す終了コード（undefined なら正常に動く）。 */
  exitCode?: number | null;
  /** 正常に動くときの標準出力を差し替える。 */
  stdout?: string;
}

/**
 * 模擬の DPAPI。本物の暗号ではなく、entropy の結び付けと往復の形だけを再現する。
 * protect: entropy ‖ 0x00 ‖ (データの各バイト XOR 0x5a) の base64。unprotect: entropy が違えば終了コード 13。
 */
function fakeDpapi(state: FakeDpapiOptions = {}) {
  const runner = createMockStdinCommandRunner(
    (_command, _args, stdin): CommandResult => {
      if (state.exitCode !== undefined)
        return {
          exitCode: state.exitCode,
          stdout: '',
          // 実機の PowerShell の出力は利用者のパスを含み得る。例外の文に写らないことを確かめる。
          stderr: 'C:\\Users\\synthetic-person\\AppData\\Local failure',
        };
      const [op = '', entropyB64 = '', dataB64 = ''] = stdin.split('\n');
      const entropy = Buffer.from(entropyB64, 'base64');
      const data = Buffer.from(dataB64, 'base64');
      if (op === 'protect') {
        const out = Buffer.concat([
          entropy,
          Buffer.from([0]),
          data.map((byte) => byte ^ 0x5a),
        ]);
        return {
          exitCode: 0,
          stdout: state.stdout ?? `${out.toString('base64')}\r\n`,
          stderr: '',
        };
      }
      if (op === 'unprotect') {
        const split = data.indexOf(0);
        if (split < 0 || !data.subarray(0, split).equals(entropy))
          return { exitCode: 13, stdout: '', stderr: '' };
        const out = Buffer.from(
          data.subarray(split + 1).map((byte) => byte ^ 0x5a),
        );
        return {
          exitCode: 0,
          stdout: state.stdout ?? out.toString('base64'),
          stderr: '',
        };
      }
      return { exitCode: 11, stdout: '', stderr: '' };
    },
  );
  return runner;
}

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-dpapi-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function options(
  directory: string,
  runner: StdinCommandRunner,
): WindowsDpapiOptions {
  return { directory, runner, powershellPath: POWERSHELL };
}

async function rejectsWith(
  promise: Promise<unknown>,
  unavailable: boolean,
): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error instanceof KeyStoreUnavailableError, unavailable);
    // 例外の文に秘密・利用者のパス・コマンドの出力を入れない。
    assert.ok(!error.message.includes(PLAIN_VALUE));
    assert.ok(!error.message.includes(PLAIN_VALUE_B64));
    assert.ok(!error.message.includes('synthetic-person'));
    return error;
  }
  assert.fail('rejection expected');
}

test('PowerShell と置き場所の既定の場所: 絶対パスのドライブ文字のときだけ決まる', () => {
  assert.equal(
    windowsPowerShellPath({ SystemRoot: 'C:\\Windows' }),
    POWERSHELL,
  );
  assert.equal(
    windowsPowerShellPath({ SYSTEMROOT: 'D:\\WINDOWS' }),
    'D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  for (const env of [
    {},
    { SystemRoot: 'Windows' },
    { SystemRoot: '\\\\server\\share\\Windows' },
  ])
    assert.equal(windowsPowerShellPath(env), null);
  assert.equal(
    defaultWindowsKeyStoreDir({
      LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
    }),
    'C:\\Users\\example\\AppData\\Local\\Buddy\\key-store',
  );
  for (const env of [
    {},
    { LOCALAPPDATA: 'relative\\Local' },
    { LOCALAPPDATA: '\\\\server\\share\\Local' },
    // 移動プロファイルの %APPDATA% には切り替えない。
    { APPDATA: 'C:\\Users\\example\\AppData\\Roaming' },
  ])
    assert.equal(defaultWindowsKeyStoreDir(env), null);
});

test('PowerShell の引数は固定で、CurrentUser の ProtectedData を標準入力から呼ぶスクリプトだけを持つ', () => {
  assert.deepEqual(DPAPI_POWERSHELL_ARGS.slice(0, 4), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
  ]);
  assert.equal(DPAPI_POWERSHELL_ARGS.length, 5);
  const script = Buffer.from(DPAPI_POWERSHELL_ARGS[4] ?? '', 'base64').toString(
    'utf16le',
  );
  assert.match(script, /\[Console\]::In\.ReadToEnd\(\)/u);
  assert.match(script, /DataProtectionScope\]::CurrentUser/u);
  assert.match(script, /ProtectedData\]::Protect\(/u);
  assert.match(script, /ProtectedData\]::Unprotect\(/u);
  assert.doesNotMatch(script, /LocalMachine/u);
});

test('ファイル名は項目名の SHA-256。大文字・小文字だけが違う項目名も別のファイルになる', () => {
  assert.equal(dpapiFileName('data-key-v1'), DATA_ITEM_FILE);
  assert.equal(
    dpapiFileName('oauth-v1:conn-1'),
    'abcb3e646fb405d13857755bf8dfe19bb1de12a17fcfe8087765f556e6cc15c0.dpapi',
  );
  assert.equal(
    dpapiFileName('oauth-v1:Conn-1'),
    'ccda99cc2958d93876be8fb5a871a1402e5d0a4b019d6e16da1c4fae7e83fdbb.dpapi',
  );
});

test('保存・読み出し: 秘密は標準入力だけで渡し、ファイルには保護した blob だけを置く', async (t) => {
  const dir = await tempDir(t);
  const runner = fakeDpapi();
  const slot = await windowsDpapiSlotOpener(
    'data-key-v1',
    options(dir, runner),
  )();
  // 項目がなければ null（子プロセスを呼ばない）。
  assert.equal(await slot.read(), null);
  assert.equal(runner.calls.length, 0);

  await slot.write(PLAIN_VALUE);
  assert.equal(runner.calls.length, 1);
  const [protect] = runner.calls;
  assert.equal(protect?.command, POWERSHELL);
  assert.deepEqual(protect?.args, DPAPI_POWERSHELL_ARGS);
  assert.equal(
    protect?.stdin,
    `protect\n${DATA_ITEM_ENTROPY_B64}\n${PLAIN_VALUE_B64}\n`,
  );
  // 秘密はコマンドラインの引数に載らない。
  for (const arg of protect?.args ?? []) {
    assert.ok(!arg.includes(PLAIN_VALUE_B64));
    assert.ok(
      !Buffer.from(arg, 'base64').toString('utf16le').includes(PLAIN_VALUE),
    );
  }
  assert.deepEqual(await readdir(dir), [DATA_ITEM_FILE]);
  const stored = await readFile(join(dir, DATA_ITEM_FILE), 'utf8');
  assert.equal(
    stored,
    `{"v":1,"scope":"current_user","account":"data-key-v1","blob":"${FAKE_BLOB_B64}"}\n`,
  );
  assert.ok(!stored.includes(PLAIN_VALUE));
  assert.ok(!stored.includes(PLAIN_VALUE_B64));
  if (process.platform !== 'win32') {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, DATA_ITEM_FILE))).mode & 0o777, 0o600);
  }

  assert.equal(await slot.read(), PLAIN_VALUE);
  assert.equal(
    runner.calls[1]?.stdin,
    `unprotect\n${DATA_ITEM_ENTROPY_B64}\n${FAKE_BLOB_B64}\n`,
  );
});

test('差し替え・削除: 上書きして読み直せ、削除は項目が無くても成功し、一時ファイルを残さない', async (t) => {
  const dir = await tempDir(t);
  const slot = await windowsDpapiSlotOpener(
    'oauth-v1:conn-1',
    options(dir, fakeDpapi()),
  )();
  await slot.write('first synthetic token');
  await slot.write('second synthetic token');
  assert.equal(await slot.read(), 'second synthetic token');
  assert.deepEqual(await readdir(dir), [
    'abcb3e646fb405d13857755bf8dfe19bb1de12a17fcfe8087765f556e6cc15c0.dpapi',
  ]);
  assert.ok(slot.remove !== undefined);
  await slot.remove();
  assert.equal(await slot.read(), null);
  await slot.remove();
  assert.deepEqual(await readdir(dir), []);
});

test('別の項目のファイルへ差し替えても読めない（項目名の照合と entropy）', async (t) => {
  const dir = await tempDir(t);
  const runner = fakeDpapi();
  const opts = options(dir, runner);
  await (
    await windowsDpapiSlotOpener('data-key-v1', opts)()
  ).write(PLAIN_VALUE);
  const stolen = await readFile(join(dir, DATA_ITEM_FILE), 'utf8');
  const target = join(dir, dpapiFileName('tls-key-v1'));
  const tls = await windowsDpapiSlotOpener('tls-key-v1', opts)();
  // ファイルをそのまま移す: 項目名が違うので、子プロセスを呼ばずに読み出しの失敗。
  await writeFile(target, stolen);
  const before = runner.calls.length;
  await rejectsWith(tls.read(), false);
  assert.equal(runner.calls.length, before);
  // 項目名まで書き換える: entropy が違うので DPAPI の復号に失敗する（終了コード 13）。
  await writeFile(
    target,
    stolen.replace('"account":"data-key-v1"', '"account":"tls-key-v1"'),
  );
  await rejectsWith(tls.read(), false);
  assert.equal(runner.calls.length, before + 1);
});

test('保存ファイルの形が違えば読み出しの失敗（子プロセスを呼ばない・上書きしない）', async (t) => {
  const dir = await tempDir(t);
  const runner = fakeDpapi();
  const slot = await windowsDpapiSlotOpener(
    'data-key-v1',
    options(dir, runner),
  )();
  const path = join(dir, DATA_ITEM_FILE);
  for (const content of [
    'not json',
    '[]',
    '{"v":1,"scope":"current_user","account":"data-key-v1"}',
    `{"v":2,"scope":"current_user","account":"data-key-v1","blob":"${FAKE_BLOB_B64}"}`,
    `{"v":1,"scope":"local_machine","account":"data-key-v1","blob":"${FAKE_BLOB_B64}"}`,
    `{"v":1,"scope":"current_user","account":"data-key-v1","blob":" ${FAKE_BLOB_B64}"}`,
    `{"v":1,"scope":"current_user","account":"data-key-v1","blob":"${FAKE_BLOB_B64}","extra":1}`,
  ]) {
    await writeFile(path, content);
    await rejectsWith(slot.read(), false);
    assert.equal(await readFile(path, 'utf8'), content);
  }
  assert.equal(runner.calls.length, 0);
});

test('失敗の区別: 起動できない・DPAPI の型がないは「使えない」、復号・保護の失敗・不正な出力は操作の失敗', async (t) => {
  const dir = await tempDir(t);
  const state: FakeDpapiOptions = {};
  const slot = await windowsDpapiSlotOpener(
    'data-key-v1',
    options(dir, fakeDpapi(state)),
  )();
  await slot.write(PLAIN_VALUE);
  for (const [exitCode, unavailable] of [
    [null, true],
    [10, true],
    [11, false],
    [13, false],
    [1, false],
  ] as const) {
    state.exitCode = exitCode;
    await rejectsWith(slot.read(), unavailable);
  }
  for (const [exitCode, unavailable] of [
    [null, true],
    [10, true],
    [12, false],
  ] as const) {
    state.exitCode = exitCode;
    await rejectsWith(slot.write(PLAIN_VALUE), unavailable);
  }
  // 書けなかったときは前の値が残る。
  delete state.exitCode;
  assert.equal(await slot.read(), PLAIN_VALUE);
  for (const stdout of ['', 'not base64!', `${PLAIN_VALUE_B64} extra`]) {
    state.stdout = stdout;
    await rejectsWith(slot.read(), false);
  }
  // 空・上限を超える値は保護しない。
  delete state.stdout;
  await rejectsWith(slot.write(''), false);
  await rejectsWith(slot.write('x'.repeat(64 * 1024 + 1)), false);
  assert.deepEqual(await readdir(dir), [DATA_ITEM_FILE]);
});

test('置き場所: 決まらない・ディレクトリでない・リンクなら使えない', async (t) => {
  const dir = await tempDir(t);
  const runner = fakeDpapi();
  // LOCALAPPDATA・SystemRoot がなければ開けない。
  await rejectsWith(
    windowsDpapiSlotOpener('data-key-v1', { env: {}, runner })(),
    true,
  );
  await rejectsWith(
    windowsDpapiSlotOpener('data-key-v1', {
      env: { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' },
      runner,
    })(),
    true,
  );
  const file = join(dir, 'file');
  await writeFile(file, 'x');
  await rejectsWith(
    windowsDpapiSlotOpener('data-key-v1', options(file, runner))(),
    true,
  );
  // 入れ子の置き場所は作る。
  const nested = join(dir, 'Buddy', 'key-store');
  const slot = await windowsDpapiSlotOpener(
    'data-key-v1',
    options(nested, runner),
  )();
  await slot.write(PLAIN_VALUE);
  assert.deepEqual(await readdir(nested), [DATA_ITEM_FILE]);
  assert.equal(runner.calls.length, 1);
});

test(
  '置き場所がシンボリックリンクなら使えない',
  // Windows でシンボリックリンクを作るには権限が要るので、POSIX だけで確かめる（ジャンクションも lstat でリンクになる）。
  { skip: process.platform === 'win32' },
  async (t) => {
    const dir = await tempDir(t);
    const real = join(dir, 'real');
    await mkdir(real);
    const link = join(dir, 'link');
    await symlink(real, link);
    await rejectsWith(
      windowsDpapiSlotOpener('data-key-v1', options(link, fakeDpapi()))(),
      true,
    );
  },
);

test(
  '保存ファイルを置き換えられないとき（置き場所が書込み不可）は書込みの失敗',
  // root は権限に関係なく書けるので、権限の試験にならない。Windows は ACL の試験を別にする（U700）。
  {
    skip:
      process.platform === 'win32' ||
      (typeof process.getuid === 'function' && process.getuid() === 0),
  },
  async (t) => {
    const dir = await tempDir(t);
    const runner = fakeDpapi();
    const slot = await windowsDpapiSlotOpener(
      'data-key-v1',
      options(dir, runner),
    )();
    await chmod(dir, 0o500);
    t.after(() => chmod(dir, 0o700).catch(() => undefined));
    await rejectsWith(slot.write(PLAIN_VALUE), false);
  },
);

test('データ鍵の KeyStore: 作成・読み戻し・復元の導入が DPAPI の項目 data-key-v1 で動く', async (t) => {
  const dir = await tempDir(t);
  const runner = fakeDpapi();
  const store = createWindowsDpapiKeyStore(options(dir, runner));
  assert.equal(store.kind, 'os');
  assert.equal(store.backend, 'windows_dpapi');
  assert.deepEqual(await store.loadDataKey(), {
    ok: false,
    backend: 'windows_dpapi',
    reason: 'data_key_missing',
  });
  const created = await store.loadOrCreateDataKey();
  assert.ok(created.ok);
  assert.equal(created.created, true);
  assert.equal(created.backend, 'windows_dpapi');
  const loaded = await store.loadDataKey();
  assert.ok(loaded.ok);
  assert.ok(loaded.dataKey.key.equals(created.dataKey.key));
  assert.deepEqual(await readdir(dir), [DATA_ITEM_FILE]);
  // 鍵の値はファイルにも結果の JSON にも出ない。
  const stored = await readFile(join(dir, DATA_ITEM_FILE), 'utf8');
  assert.ok(!stored.includes(created.dataKey.key.toString('base64')));
  assert.ok(
    !JSON.stringify(created).includes(created.dataKey.key.toString('base64')),
  );
  // 違う素材は上書きしない。
  assert.deepEqual(await store.importDataKey(Buffer.alloc(32, 7)), {
    ok: false,
    backend: 'windows_dpapi',
    reason: 'data_key_exists',
  });

  const empty = createWindowsDpapiKeyStore(
    options(await tempDir(t), fakeDpapi()),
  );
  const imported = await empty.importDataKey(Buffer.alloc(32, 7));
  assert.ok(imported.ok);
  assert.ok(imported.dataKey.key.equals(Buffer.alloc(32, 7)));
});

test('データ鍵の KeyStore: 使えない・書けない・読めないを区別し、平文へ切り替えない', async (t) => {
  const cases: [number | null, string][] = [
    [null, 'dpapi_unavailable'],
    [10, 'dpapi_unavailable'],
    [12, 'keystore_write_failed'],
  ];
  for (const [exitCode, reason] of cases) {
    const dir = await tempDir(t);
    const store = createWindowsDpapiKeyStore(
      options(dir, fakeDpapi({ exitCode })),
    );
    assert.deepEqual(await store.loadOrCreateDataKey(), {
      ok: false,
      backend: 'windows_dpapi',
      reason,
    });
    assert.deepEqual(await readdir(dir), []);
  }
  const dir = await tempDir(t);
  const state: FakeDpapiOptions = {};
  const store = createWindowsDpapiKeyStore(options(dir, fakeDpapi(state)));
  assert.ok((await store.loadOrCreateDataKey()).ok);
  state.exitCode = 13;
  assert.deepEqual(await store.loadOrCreateDataKey(), {
    ok: false,
    backend: 'windows_dpapi',
    reason: 'keystore_read_failed',
  });
  // 読めない鍵を新しい鍵で上書きしない。
  assert.deepEqual(await readdir(dir), [DATA_ITEM_FILE]);
  delete state.exitCode;
  assert.ok((await store.loadDataKey()).ok);
});

test('TLS・バックアップ・OAuth の KeyStore も DPAPI の項目で動き、項目ごとに別のファイルになる', async (t) => {
  const dir = await tempDir(t);
  const opts = options(dir, fakeDpapi());

  const tls = createWindowsDpapiTlsKeyStore(opts);
  assert.equal(tls.backend, 'windows_dpapi');
  const tlsCreated = await tls.loadOrCreateTlsKey();
  assert.ok(tlsCreated.ok && tlsCreated.created);
  const tlsLoaded = await tls.loadTlsKey();
  assert.ok(tlsLoaded.ok);
  assert.ok(
    tlsLoaded.privateKey.publicKey().equals(tlsCreated.privateKey.publicKey()),
  );

  const backup = createWindowsDpapiBackupKeyStore(opts);
  assert.equal(backup.backend, 'windows_dpapi');
  const material = Buffer.alloc(32, 0x31);
  assert.ok((await backup.put('backup_file', 'k1', material)).ok);
  assert.ok((await backup.put('ledger_hmac_key', 'k1', material)).ok);
  const read = await backup.read('backup_file', 'k1');
  assert.ok(read.ok && read.key.key.equals(material));
  assert.deepEqual(await backup.put('backup_file', 'k1', Buffer.alloc(32)), {
    ok: false,
    backend: 'windows_dpapi',
    reason: 'backup_key_exists',
  });

  const oauth = createWindowsDpapiOAuthTokenStore(opts);
  assert.equal(oauth.backend, 'windows_dpapi');
  // Microsoft のアクセストークンは数 KB になり得る（資格情報マネージャーの 1 項目の上限を超える長さでも置ける）。
  const tokens = new OAuthTokens({
    accessToken: 'a'.repeat(4096),
    refreshToken: 'synthetic-refresh',
    expiresAt: null,
    grantedScopes: ['scope-a'],
  });
  assert.deepEqual(await oauth.write('conn-1', tokens), { ok: true });
  assert.deepEqual(await oauth.read('Conn-1'), {
    ok: false,
    backend: 'windows_dpapi',
    reason: 'oauth_token_missing',
  });
  const got = await oauth.read('conn-1');
  assert.ok(got.ok && got.tokens.accessToken === 'a'.repeat(4096));

  assert.deepEqual((await readdir(dir)).sort(), [
    'abcb3e646fb405d13857755bf8dfe19bb1de12a17fcfe8087765f556e6cc15c0.dpapi',
    'ce371980b516f64daf2f9489923530510ae0bd63c35204c61ab559c1e50485c2.dpapi',
    'e7787536a65def4df512f97ce78227fab43cd19de8619a59d97dca3ca230b676.dpapi',
    'f87b8ab4b3f04d8b9266a6ff77ea77cd241959fa9d705c64f73c043a670230f6.dpapi',
  ]);
  assert.deepEqual(await oauth.remove('conn-1'), { ok: true });
  assert.deepEqual(await oauth.remove('conn-1'), { ok: true });
  assert.equal((await readdir(dir)).length, 3);

  // 使えないときの理由は各 KeyStore で dpapi_unavailable。
  const unavailable = options(await tempDir(t), fakeDpapi({ exitCode: null }));
  const tlsFailed =
    await createWindowsDpapiTlsKeyStore(unavailable).loadOrCreateTlsKey();
  assert.equal(tlsFailed.ok ? '' : tlsFailed.reason, 'dpapi_unavailable');
  const backupFailed = await createWindowsDpapiBackupKeyStore(unavailable).put(
    'backup_file',
    'k1',
    material,
  );
  assert.equal(backupFailed.ok ? '' : backupFailed.reason, 'dpapi_unavailable');
  assert.deepEqual(
    await createWindowsDpapiOAuthTokenStore(unavailable).write(
      'conn-1',
      tokens,
    ),
    { ok: false, backend: 'windows_dpapi', reason: 'dpapi_unavailable' },
  );
});

test('OS の選択: win32 は DPAPI の KeyStore・probe になり、起動前検査に通る', async (t) => {
  const dir = await tempDir(t);
  const opts = options(dir, fakeDpapi());
  assert.equal(createKeyStore('win32', opts).backend, 'windows_dpapi');
  assert.equal(createTlsKeyStore('win32', opts).backend, 'windows_dpapi');
  assert.equal(createBackupKeyStore('win32', opts).backend, 'windows_dpapi');
  assert.equal(createOAuthTokenStore('win32', opts).backend, 'windows_dpapi');
  const probe = createKeyProtectionProbe('win32', opts);
  assert.equal(probe.kind, 'os');
  assert.deepEqual(await probe.check(), {
    available: true,
    backend: 'windows_dpapi',
    reason: null,
  });
  assert.deepEqual(await keyProtectionPreflight(probe), []);
  // 使えなければ起動を断る。
  const refused = createKeyProtectionProbe(
    'win32',
    options(await tempDir(t), fakeDpapi({ exitCode: 10 })),
  );
  assert.deepEqual(await keyProtectionPreflight(refused), [
    'key_protection_unavailable:dpapi_unavailable',
  ]);
});

test('標準入力つきの runner: 値を標準入力で渡し、起動できなければ exitCode: null', async () => {
  const runner = createNodeStdinCommandRunner();
  const echoed = await runner.run(
    process.execPath,
    [
      '-e',
      "let s='';process.stdin.on('data',(c)=>{s+=c});process.stdin.on('end',()=>{process.stdout.write(Buffer.from(s).toString('hex'));process.exit(s.length===16?0:3)})",
    ],
    PLAIN_VALUE.slice(0, 15) + '\n',
  );
  assert.deepEqual(echoed, {
    exitCode: 0,
    stdout: '73796e7468657469632076616c75650a',
    stderr: '',
  });
  const failed = await runner.run(
    process.execPath,
    ['-e', 'process.exit(13)'],
    '',
  );
  assert.equal(failed.exitCode, 13);
  const missing = await runner.run(
    join(tmpdir(), 'buddy-no-such-command-for-test'),
    [],
    PLAIN_VALUE,
  );
  assert.equal(missing.exitCode, null);
});

test(
  'Windows の実機の DPAPI: PowerShell で保護・復号の往復ができ、別の項目へ差し替えた blob は復号できない',
  // 本物の DPAPI は Windows にだけある。他の OS では上の模擬の試験で形を確かめる。
  {
    skip: process.platform !== 'win32' && 'Windows の DPAPI だけで動く試験',
    timeout: 180_000,
  },
  async (t) => {
    const dir = await tempDir(t);
    const real: WindowsDpapiOptions = { directory: dir };
    const slot: SecretSlot = await windowsDpapiSlotOpener(
      'data-key-v1',
      real,
    )();
    await slot.write(PLAIN_VALUE);
    const stored = await readFile(join(dir, DATA_ITEM_FILE), 'utf8');
    assert.ok(!stored.includes(PLAIN_VALUE));
    assert.ok(!stored.includes(PLAIN_VALUE_B64));
    assert.equal(await slot.read(), PLAIN_VALUE);
    // 日本語を含む値も往復する（UTF-8）。
    await slot.write('合成の値 synthetic');
    assert.equal(await slot.read(), '合成の値 synthetic');
    // 項目名まで書き換えて別の項目へ移しても、entropy が違うので本物の DPAPI が復号を拒む。
    const moved = (await readFile(join(dir, DATA_ITEM_FILE), 'utf8')).replace(
      '"account":"data-key-v1"',
      '"account":"tls-key-v1"',
    );
    await writeFile(join(dir, dpapiFileName('tls-key-v1')), moved);
    await rejectsWith(
      (await windowsDpapiSlotOpener('tls-key-v1', real)()).read(),
      false,
    );
    await rm(join(dir, dpapiFileName('tls-key-v1')));

    // KeyStore・probe を本物の DPAPI で通す。
    const store = createKeyStore('win32', real);
    assert.equal(store.backend, 'windows_dpapi');
    const probe = createKeyProtectionProbe('win32', {
      directory: await tempDir(t),
    });
    assert.deepEqual(await keyProtectionPreflight(probe), []);
    const tls = createTlsKeyStore('win32', real);
    const created = await tls.loadOrCreateTlsKey();
    assert.ok(created.ok && created.created);
    const loaded = await tls.loadTlsKey();
    assert.ok(
      loaded.ok &&
        loaded.privateKey.publicKey().equals(created.privateKey.publicKey()),
    );
    const oauth = createOAuthTokenStore('win32', real);
    const tokens = new OAuthTokens({
      accessToken: 'b'.repeat(4096),
      refreshToken: null,
      expiresAt: null,
      grantedScopes: [],
    });
    assert.deepEqual(await oauth.write('conn-1', tokens), { ok: true });
    const got = await oauth.read('conn-1');
    assert.ok(got.ok && got.tokens.accessToken === 'b'.repeat(4096));
    assert.deepEqual(await oauth.remove('conn-1'), { ok: true });
    const backup = createBackupKeyStore('win32', real);
    assert.ok((await backup.put('backup_file', 'k1', Buffer.alloc(32, 9))).ok);
    const key = await backup.read('backup_file', 'k1');
    assert.ok(key.ok && key.key.key.equals(Buffer.alloc(32, 9)));
  },
);
