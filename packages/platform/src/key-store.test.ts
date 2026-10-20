// KeyStore（データ鍵の取得・初回作成・形式の検査）。実機のキーチェーンには書き込まない（模擬の KeyStore と模擬の keyring モジュール）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import type { DataKeyResult, KeyringModule } from './key-store.js';
import {
  createKeyStore,
  createMacKeychainKeyStore,
  createMockKeyStore,
  createUnsupportedKeyStore,
  DATA_KEY_ACCOUNT,
  DATA_KEY_ID,
  DataKey,
  decodeStoredDataKey,
  KEY_STORE_SERVICE,
} from './key-store.js';

function expectKey(result: DataKeyResult): DataKey {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.dataKey;
}

test('サービス名・アカウント名・key_id は個人情報を含まない固定の汎用名', () => {
  assert.equal(KEY_STORE_SERVICE, 'dev.buddy.core');
  assert.equal(DATA_KEY_ACCOUNT, 'data-key-v1');
  assert.equal(DATA_KEY_ID, 'data-key-v1');
});

test('模擬の KeyStore: 初回は 32 バイトの鍵を作成し、以後は同じ鍵を読む', async () => {
  const store = createMockKeyStore();
  assert.equal(store.kind, 'mock');
  assert.equal(store.backend, 'mock');
  assert.equal(store.hasStoredValue, false);

  const first = await store.loadOrCreateDataKey();
  assert.equal(first.ok && first.created, true);
  const key1 = expectKey(first);
  assert.equal(key1.keyId, 'data-key-v1');
  assert.equal(key1.key.length, 32);
  assert.equal(store.writes, 1);

  const second = await store.loadOrCreateDataKey();
  assert.equal(second.ok && second.created, false);
  assert.ok(expectKey(second).key.equals(key1.key));
  const loaded = await store.loadDataKey();
  assert.ok(expectKey(loaded).key.equals(key1.key));
  assert.equal(store.writes, 1);

  // 別の KeyStore で作った鍵は別の乱数（固定値・同じ値の使い回しでない）。
  const other = expectKey(await createMockKeyStore().loadOrCreateDataKey());
  assert.ok(!other.key.equals(key1.key));
});

test('作成しない読み出しは、鍵がなければ data_key_missing を返して何も書かない', async () => {
  const store = createMockKeyStore();
  assert.deepEqual(await store.loadDataKey(), {
    ok: false,
    backend: 'mock',
    reason: 'data_key_missing',
  });
  assert.equal(store.writes, 0);
  assert.equal(store.hasStoredValue, false);
});

test('保存値の形式: 正準の base64 で 32 バイトのときだけ受け入れ、不正な値は上書きしない', async () => {
  // 32 バイト（0x00..0x1f）の base64。期待値は手で書いた固定値。
  const valid = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  const decoded = decodeStoredDataKey(valid);
  assert.equal(decoded.ok, true);
  if (decoded.ok)
    assert.deepEqual(
      [...decoded.bytes],
      Array.from({ length: 32 }, (_, i) => i),
    );

  const cases: [string, string][] = [
    ['', 'data_key_format_invalid'],
    ['not base64!', 'data_key_format_invalid'],
    [`${valid}\n`, 'data_key_format_invalid'],
    [` ${valid}`, 'data_key_format_invalid'],
    // URL 用の文字（- _）は使わない。
    ['AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh-_', 'data_key_format_invalid'],
    // パディングの欠落。
    ['AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'data_key_format_invalid'],
    // 末尾の桁の未使用ビットが 0 でない（同じバイト列の別表記）。
    ['AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9=', 'data_key_format_invalid'],
    // 16 バイト・31 バイト・33 バイト。
    ['AAECAwQFBgcICQoLDA0ODw==', 'data_key_length_invalid'],
    ['AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHg==', 'data_key_length_invalid'],
    ['AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g', 'data_key_length_invalid'],
  ];
  for (const [stored, reason] of cases) {
    assert.deepEqual(decodeStoredDataKey(stored), { ok: false, reason });
    const store = createMockKeyStore({ stored });
    for (const result of [
      await store.loadDataKey(),
      await store.loadOrCreateDataKey(),
    ])
      assert.deepEqual(result, { ok: false, backend: 'mock', reason });
    assert.equal(store.writes, 0);
  }

  const store = createMockKeyStore({ stored: valid });
  const key = expectKey(await store.loadOrCreateDataKey());
  assert.deepEqual(
    [...key.key],
    Array.from({ length: 32 }, (_, i) => i),
  );
  assert.equal(store.writes, 0);
});

test('模擬の KeyStore が使えない・読めない・書けないときは鍵を返さない', async () => {
  const cases: [Parameters<typeof createMockKeyStore>[0], string][] = [
    [{ available: false }, 'mock_unavailable'],
    [{ readFails: true }, 'keystore_read_failed'],
    [{ writeFails: true }, 'keystore_write_failed'],
    [{ readBackDiffers: true }, 'data_key_verify_failed'],
  ];
  for (const [options, reason] of cases) {
    const result = await createMockKeyStore(options).loadOrCreateDataKey();
    assert.deepEqual(result, { ok: false, backend: 'mock', reason });
    assert.ok(!('dataKey' in result));
  }
});

test('DataKey: JSON・inspect・文字列化で鍵の値を出さず、key は複製を返す', () => {
  const bytes = Buffer.from(
    Array.from({ length: 32 }, (_, i) => 0xa0 + (i % 16)),
  );
  const key = new DataKey('data-key-v1', bytes);
  const hex = bytes.toString('hex');
  const base64 = bytes.toString('base64');
  for (const text of [
    JSON.stringify(key),
    JSON.stringify({ result: { dataKey: key } }),
    inspect(key),
    inspect({ dataKey: key }, { depth: 5 }),
    String(key),
    `${key}`,
  ]) {
    assert.ok(!text.includes(hex), text);
    assert.ok(!text.includes(base64), text);
    assert.ok(text.includes('data-key-v1'), text);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(key)), {
    keyId: 'data-key-v1',
    key: '[redacted]',
  });
  // 受け取った複製を書き換えても、保持している鍵は変わらない。
  const copy = key.key;
  copy.fill(0);
  assert.ok(key.key.equals(bytes));
  bytes.fill(0);
  assert.equal(key.key[0], 0xa0);
  assert.throws(() => new DataKey('data-key-v1', Buffer.alloc(31)), RangeError);
  assert.throws(() => new DataKey('data-key-v1', Buffer.alloc(33)), RangeError);
});

test('macOS のキーチェーン: 固定のサービス名・アカウント名の項目に base64 で保存し、遅延読み込みする', async () => {
  const items = new Map<string, string>();
  const created: [string, string][] = [];
  let loads = 0;
  const module: KeyringModule = {
    AsyncEntry: class {
      readonly #name: string;
      constructor(service: string, username: string) {
        created.push([service, username]);
        this.#name = `${service}/${username}`;
      }
      getPassword() {
        return Promise.resolve(items.get(this.#name));
      }
      setPassword(password: string) {
        items.set(this.#name, password);
        return Promise.resolve();
      }
    },
  };
  const store = createMacKeychainKeyStore({
    loadModule: () => {
      loads += 1;
      return Promise.resolve(module);
    },
  });
  assert.equal(store.kind, 'os');
  assert.equal(store.backend, 'macos_keychain');
  assert.equal(loads, 0);

  // 項目がない（keyring は undefined / null を返す）ときは作成しない読み出しで missing。
  assert.deepEqual(await store.loadDataKey(), {
    ok: false,
    backend: 'macos_keychain',
    reason: 'data_key_missing',
  });
  const result = await store.loadOrCreateDataKey();
  const key = expectKey(result);
  assert.equal(result.ok && result.created, true);
  assert.deepEqual([...items.keys()], ['dev.buddy.core/data-key-v1']);
  const stored = items.get('dev.buddy.core/data-key-v1') ?? '';
  assert.match(stored, /^[A-Za-z0-9+/]{43}=$/u);
  assert.ok(Buffer.from(stored, 'base64').equals(key.key));
  assert.ok(!JSON.stringify(result).includes(stored));
  assert.ok(expectKey(await store.loadDataKey()).key.equals(key.key));
  // モジュールの読み込みは一度だけ。
  assert.equal(loads, 1);
  assert.ok(
    created.every(
      ([service, account]) =>
        service === 'dev.buddy.core' && account === 'data-key-v1',
    ),
  );
});

test('macOS のキーチェーン: 失敗は理由だけを返し、例外のメッセージを出さない', async () => {
  const secretLike = 'synthetic-sensitive-message';
  const failing = (
    getFails: boolean,
    setFails: boolean,
    stored?: string,
  ): KeyringModule => ({
    AsyncEntry: class {
      getPassword() {
        return getFails
          ? Promise.reject(new Error(secretLike))
          : Promise.resolve(stored ?? null);
      }
      setPassword() {
        return setFails
          ? Promise.reject(new Error(secretLike))
          : Promise.resolve();
      }
    },
  });
  const cases: [KeyringModule | Error, string][] = [
    [new Error(secretLike), 'keystore_module_unavailable'],
    [failing(true, false), 'keystore_read_failed'],
    [failing(false, true), 'keystore_write_failed'],
    // 書いたのに読み戻せない（null のまま）。
    [failing(false, false), 'data_key_verify_failed'],
  ];
  for (const [module, reason] of cases) {
    const store = createMacKeychainKeyStore({
      loadModule: () =>
        module instanceof Error
          ? Promise.reject(module)
          : Promise.resolve(module),
    });
    const result = await store.loadOrCreateDataKey();
    assert.deepEqual(result, { ok: false, backend: 'macos_keychain', reason });
    assert.ok(!JSON.stringify(result).includes(secretLike));
  }

  // 読み込みの一時的な失敗のあとは、次の呼び出しで読み込み直す。
  let attempts = 0;
  const items = new Map<string, string>();
  const store = createMacKeychainKeyStore({
    loadModule: () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error('transient'));
      return Promise.resolve({
        AsyncEntry: class {
          getPassword() {
            return Promise.resolve(items.get('k') ?? null);
          }
          setPassword(value: string) {
            items.set('k', value);
            return Promise.resolve();
          }
        },
      });
    },
  });
  assert.equal((await store.loadOrCreateDataKey()).ok, false);
  assert.equal((await store.loadOrCreateDataKey()).ok, true);
  assert.equal(attempts, 2);
});

test('Windows・Linux の中枢は KeyStore を持たず、ネイティブモジュールを読み込まない', async () => {
  let loads = 0;
  const loadModule = () => {
    loads += 1;
    return Promise.reject(new Error('must not load'));
  };
  const cases: [string, string][] = [
    ['win32', 'windows_core_not_supported_in_initial_release'],
    ['linux', 'linux_core_not_supported_in_initial_release'],
    ['freebsd', 'platform_not_supported'],
  ];
  for (const [platform, reason] of cases) {
    for (const store of [
      createKeyStore(platform, { loadModule }),
      createUnsupportedKeyStore(platform),
    ]) {
      assert.equal(store.backend, 'none');
      for (const result of [
        await store.loadDataKey(),
        await store.loadOrCreateDataKey(),
      ])
        assert.deepEqual(result, { ok: false, backend: 'none', reason });
    }
  }
  assert.equal(loads, 0);
  assert.equal(
    createKeyStore('darwin', { loadModule }).backend,
    'macos_keychain',
  );
  assert.equal(loads, 0);
});
