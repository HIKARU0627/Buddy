// 鍵保護の可否の確認と起動前検査。実機のキーチェーンには触れない（模擬の KeyStore と模擬の keyring モジュール）。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { KeyProtectionProbe } from './key-protection.js';
import {
  createKeyProtectionProbe,
  createKeyStoreProbe,
  createMockKeyProtectionProbe,
  keyProtectionPreflight,
} from './key-protection.js';
import type { KeyringModule } from './key-store.js';
import { createMockKeyStore } from './key-store.js';

// 模擬の keyring モジュール。メモリ上に保存し、呼び出しを記録する（実機のキーチェーンには触れない）。
function fakeKeyring(options: { getFails?: boolean } = {}) {
  const items = new Map<string, string>();
  const entries: string[] = [];
  const module: KeyringModule = {
    AsyncEntry: class {
      readonly #name: string;
      constructor(service: string, username: string) {
        this.#name = `${service}/${username}`;
        entries.push(this.#name);
      }
      getPassword() {
        if (options.getFails === true)
          return Promise.reject(new Error('User interaction is not allowed.'));
        return Promise.resolve(items.get(this.#name) ?? null);
      }
      setPassword(password: string) {
        items.set(this.#name, password);
        return Promise.resolve();
      }
    },
  };
  return { module, items, entries };
}

test('macOS: キーチェーンでデータ鍵を取得（初回は作成）できれば使える。鍵の値は結果に含めない', async () => {
  const keyring = fakeKeyring();
  let loads = 0;
  const probe = createKeyProtectionProbe('darwin', {
    loadModule: () => {
      loads += 1;
      return Promise.resolve(keyring.module);
    },
  });
  assert.equal(probe.kind, 'os');
  // probe を作っただけではネイティブモジュールを読み込まない。
  assert.equal(loads, 0);
  const status = await probe.check();
  assert.deepEqual(status, {
    available: true,
    backend: 'macos_keychain',
    reason: null,
  });
  assert.deepEqual(keyring.entries, ['dev.buddy.core/data-key-v1']);
  const stored = keyring.items.get('dev.buddy.core/data-key-v1');
  assert.equal(typeof stored, 'string');
  assert.ok(!JSON.stringify(status).includes(stored ?? '-'));
  // 起動前検査（2 回目の確認）は既存の鍵を読むだけで、上書きしない。
  assert.deepEqual(await keyProtectionPreflight(probe), []);
  assert.equal(keyring.items.get('dev.buddy.core/data-key-v1'), stored);
  assert.equal(loads, 1);
});

test('macOS: キーチェーンを使えない・鍵が不正なら起動前検査で拒否する', async () => {
  const cases: [KeyProtectionProbe, string][] = [
    [
      createKeyProtectionProbe('darwin', {
        loadModule: () =>
          Promise.reject(new Error('Cannot find native binding')),
      }),
      'keystore_module_unavailable',
    ],
    [
      createKeyProtectionProbe('darwin', {
        loadModule: () =>
          Promise.resolve(fakeKeyring({ getFails: true }).module),
      }),
      'keystore_read_failed',
    ],
  ];
  const corrupt = fakeKeyring();
  corrupt.items.set('dev.buddy.core/data-key-v1', 'not base64!');
  cases.push([
    createKeyProtectionProbe('darwin', {
      loadModule: () => Promise.resolve(corrupt.module),
    }),
    'data_key_format_invalid',
  ]);
  for (const [probe, reason] of cases) {
    assert.deepEqual(await probe.check(), {
      available: false,
      backend: 'macos_keychain',
      reason,
    });
    assert.deepEqual(await keyProtectionPreflight(probe), [
      `key_protection_unavailable:${reason}`,
    ]);
  }
  // 不正な値は上書きしない（既存の暗号文を読めなくしないため）。
  assert.equal(corrupt.items.get('dev.buddy.core/data-key-v1'), 'not base64!');
});

test('Windows・Linux の中枢は初期版の対象外として使えない', async () => {
  let loads = 0;
  const loadModule = () => {
    loads += 1;
    return Promise.resolve(fakeKeyring().module);
  };
  const cases: [string, string][] = [
    ['win32', 'windows_core_not_supported_in_initial_release'],
    ['linux', 'linux_core_not_supported_in_initial_release'],
    ['freebsd', 'platform_not_supported'],
  ];
  for (const [platform, reason] of cases) {
    // 差し替えの KeyStore を渡しても、対象外の OS では使わない。
    const probe = createKeyProtectionProbe(platform, {
      loadModule,
      keyStore: createMockKeyStore(),
    });
    assert.equal(probe.kind, 'os');
    assert.deepEqual(await probe.check(), {
      available: false,
      backend: 'none',
      reason,
    });
    assert.deepEqual(await keyProtectionPreflight(probe), [
      `key_protection_unavailable:${reason}`,
    ]);
  }
  // 対象外の OS ではネイティブモジュールを読み込まない。
  assert.equal(loads, 0);
});

test('KeyStore に基づく probe: 模擬の KeyStore は kind が mock で、既定では起動前検査で拒否する', async () => {
  const store = createMockKeyStore();
  const probe = createKeyStoreProbe(store);
  assert.equal(probe.kind, 'mock');
  assert.deepEqual(await keyProtectionPreflight(probe), [
    'key_protection_unavailable:mock_not_allowed',
  ]);
  // 模擬を許さない検査は KeyStore に触れない。
  assert.equal(store.writes, 0);
  assert.deepEqual(
    await keyProtectionPreflight(probe, { allowMock: true }),
    [],
  );
  assert.equal(store.writes, 1);
  assert.ok(store.hasStoredValue);

  const cases: [Parameters<typeof createMockKeyStore>[0], string][] = [
    [{ available: false }, 'mock_unavailable'],
    [{ readFails: true }, 'keystore_read_failed'],
    [{ writeFails: true }, 'keystore_write_failed'],
    [{ readBackDiffers: true }, 'data_key_verify_failed'],
    [{ stored: 'AAAA' }, 'data_key_length_invalid'],
  ];
  for (const [options, reason] of cases)
    assert.deepEqual(
      await keyProtectionPreflight(
        createKeyStoreProbe(createMockKeyStore(options)),
        { allowMock: true },
      ),
      [`key_protection_unavailable:${reason}`],
    );
});

test('模擬の probe は名前・kind・backend で模擬と分かり、既定では起動前検査で拒否する', async () => {
  const available = createMockKeyProtectionProbe({ available: true });
  assert.equal(available.kind, 'mock');
  assert.deepEqual(await available.check(), {
    available: true,
    backend: 'mock',
    reason: null,
  });
  assert.deepEqual(await keyProtectionPreflight(available), [
    'key_protection_unavailable:mock_not_allowed',
  ]);
  assert.deepEqual(
    await keyProtectionPreflight(available, { allowMock: true }),
    [],
  );

  const unavailable = createMockKeyProtectionProbe({
    available: false,
    reason: 'keychain_locked',
  });
  assert.deepEqual(
    await keyProtectionPreflight(unavailable, { allowMock: true }),
    ['key_protection_unavailable:keychain_locked'],
  );
  assert.deepEqual(
    await keyProtectionPreflight(
      createMockKeyProtectionProbe({ available: false }),
      { allowMock: true },
    ),
    ['key_protection_unavailable:mock_unavailable'],
  );
});

test('起動前検査: 例外・不正な結果は使えない扱いにする（良好と推測しない）', async () => {
  const probe = (check: () => Promise<unknown>): KeyProtectionProbe => ({
    kind: 'os',
    check: check as KeyProtectionProbe['check'],
  });
  const cases: [KeyProtectionProbe, string][] = [
    [probe(() => Promise.reject(new Error('boom'))), 'probe_failed'],
    [
      probe(() => {
        throw new Error('sync boom');
      }),
      'probe_failed',
    ],
    [probe(() => Promise.resolve(undefined)), 'probe_result_invalid'],
    [probe(() => Promise.resolve(null)), 'probe_result_invalid'],
    [
      probe(() =>
        Promise.resolve({ available: 'yes', backend: 'macos_keychain' }),
      ),
      'probe_result_invalid',
    ],
    [
      probe(() => Promise.resolve({ available: 1, backend: 'macos_keychain' })),
      'probe_result_invalid',
    ],
    // 実機の probe が模擬・none の「使える」を返しても受け入れない。
    [
      probe(() =>
        Promise.resolve({ available: true, backend: 'mock', reason: null }),
      ),
      'probe_result_invalid',
    ],
    [
      probe(() =>
        Promise.resolve({ available: true, backend: 'none', reason: null }),
      ),
      'probe_result_invalid',
    ],
    // 理由コードに使えない値（パスや改行を含む出力など）はそのまま出さない。
    [
      probe(() =>
        Promise.resolve({
          available: false,
          backend: 'macos_keychain',
          reason: '/Users/synthetic/Library\nKeychains',
        }),
      ),
      'unknown',
    ],
    [
      probe(() =>
        Promise.resolve({ available: false, backend: 'macos_keychain' }),
      ),
      'unknown',
    ],
  ];
  for (const [target, reason] of cases)
    assert.deepEqual(await keyProtectionPreflight(target), [
      `key_protection_unavailable:${reason}`,
    ]);

  // 模擬の probe が実機の backend を名乗っても、模擬として扱う。
  const disguised: KeyProtectionProbe = {
    kind: 'mock',
    check: () =>
      Promise.resolve({
        available: true,
        backend: 'macos_keychain',
        reason: null,
      }),
  };
  assert.deepEqual(await keyProtectionPreflight(disguised), [
    'key_protection_unavailable:mock_not_allowed',
  ]);
  assert.deepEqual(
    await keyProtectionPreflight(disguised, { allowMock: true }),
    ['key_protection_unavailable:probe_result_invalid'],
  );
});
