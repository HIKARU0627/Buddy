// TLS の秘密鍵の KeyStore（ADR 0020）。実機のキーチェーンには書き込まない（模擬の KeyStore と模擬の keyring モジュール）。
// 鍵の形式の期待値は node:crypto の KeyObject の性質（曲線の名前・種類）から確かめる。
import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { inspect } from 'node:util';
import type { KeyringModule } from './key-store.js';
import { DATA_KEY_ACCOUNT, KEY_STORE_SERVICE } from './key-store.js';
import type { TlsKeyResult } from './tls-key-store.js';
import {
  createMacKeychainTlsKeyStore,
  createMockTlsKeyStore,
  createTlsKeyStore,
  decodeStoredTlsKey,
  TLS_KEY_ACCOUNT,
  TlsPrivateKey,
} from './tls-key-store.js';

function expectKey(result: TlsKeyResult): TlsPrivateKey {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.privateKey;
}

const pkcs8 = (key: ReturnType<typeof generateKeyPairSync>['privateKey']) =>
  key.export({ type: 'pkcs8', format: 'der' }).toString('base64');

test('アカウント名はデータ鍵と別の固定の汎用名', () => {
  assert.equal(TLS_KEY_ACCOUNT, 'tls-key-v1');
  assert.notEqual(TLS_KEY_ACCOUNT, DATA_KEY_ACCOUNT);
});

test('模擬の TlsKeyStore: 初回は P-256 の鍵を作成し、以後は同じ鍵を読む', async () => {
  const store = createMockTlsKeyStore();
  const missing = await store.loadTlsKey();
  assert.deepEqual(missing, {
    ok: false,
    backend: 'mock',
    reason: 'tls_key_missing',
  });
  assert.equal(store.writes, 0);
  const created = await store.loadOrCreateTlsKey();
  assert.equal(created.ok && created.created, true);
  const key = expectKey(created);
  assert.equal(key.keyObject.asymmetricKeyType, 'ec');
  assert.equal(key.keyObject.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  assert.equal(store.writes, 1);
  const loaded = await store.loadTlsKey();
  assert.equal(loaded.ok && loaded.created, false);
  const again = expectKey(loaded);
  assert(again.publicKey().equals(key.publicKey()));
  // 2 回目の作成の要求は既存の鍵を読むだけ。
  expectKey(await store.loadOrCreateTlsKey());
  assert.equal(store.writes, 1);
});

test('鍵の値は JSON・inspect・文字列化に出ない', async () => {
  const key = expectKey(await createMockTlsKeyStore().loadOrCreateTlsKey());
  const pem = key.toPkcs8Pem();
  const body = pem.split('\n').slice(1, -2).join('');
  for (const text of [JSON.stringify({ key }), inspect(key), String(key)]) {
    assert(!text.includes(body));
    assert(text.includes('redacted'));
  }
  // PEM は PKCS#8 の P-256 の秘密鍵として読める（TLS の設定に渡す値）。
  const parsed = createPrivateKey(pem);
  assert.equal(parsed.asymmetricKeyDetails?.namedCurve, 'prime256v1');
});

test('保存値の検査: 正準の base64・PKCS#8・P-256 の EC 鍵だけを受け入れる', () => {
  const p256 = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  }).privateKey;
  assert.equal(decodeStoredTlsKey(pkcs8(p256)).ok, true);
  const invalid = [
    '',
    'not base64!',
    `${pkcs8(p256)}\n`,
    // URL 用の文字に置き換えた別表記・途中で切った値。
    pkcs8(p256).replace(/\+/gu, '-').replace(/\//gu, '_') + '-',
    pkcs8(p256).slice(0, -4),
    Buffer.from('not a key').toString('base64'),
    pkcs8(generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey),
    pkcs8(generateKeyPairSync('ed25519').privateKey),
    pkcs8(generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey),
  ];
  for (const value of invalid)
    assert.deepEqual(decodeStoredTlsKey(value), {
      ok: false,
      reason: 'tls_key_format_invalid',
    });
  const p384 = generateKeyPairSync('ec', {
    namedCurve: 'secp384r1',
  }).privateKey;
  assert.throws(() => new TlsPrivateKey(p384), TypeError);
});

test('不正な保存値は上書きせず、読めない・書けない・読み戻しの不一致は理由を返す', async () => {
  const invalid = createMockTlsKeyStore({ stored: 'AAAA' });
  assert.deepEqual(await invalid.loadOrCreateTlsKey(), {
    ok: false,
    backend: 'mock',
    reason: 'tls_key_format_invalid',
  });
  assert.equal(invalid.writes, 0);
  const cases = [
    [{ available: false }, 'mock_unavailable'],
    [{ readFails: true }, 'keystore_read_failed'],
    [{ writeFails: true }, 'keystore_write_failed'],
    [{ readBackDiffers: true }, 'tls_key_verify_failed'],
  ] as const;
  for (const [options, reason] of cases) {
    const result = await createMockTlsKeyStore(options).loadOrCreateTlsKey();
    assert.deepEqual(result, { ok: false, backend: 'mock', reason });
  }
});

test('macOS: キーチェーンの dev.buddy.core / tls-key-v1 の項目に保存する（模擬の keyring モジュール）', async () => {
  const entries = new Map<string, string>();
  const opened: string[] = [];
  let loads = 0;
  const module: KeyringModule = {
    AsyncEntry: class {
      readonly #key: string;
      constructor(service: string, account: string) {
        this.#key = `${service}/${account}`;
        opened.push(this.#key);
      }
      getPassword() {
        return Promise.resolve(entries.get(this.#key));
      }
      setPassword(value: string) {
        entries.set(this.#key, value);
        return Promise.resolve();
      }
    },
  };
  const store = createMacKeychainTlsKeyStore({
    loadModule: () => {
      loads += 1;
      return Promise.resolve(module);
    },
  });
  assert.equal(store.backend, 'macos_keychain');
  assert.equal(store.kind, 'os');
  const created = expectKey(await store.loadOrCreateTlsKey());
  const loaded = expectKey(await store.loadTlsKey());
  assert(loaded.publicKey().equals(created.publicKey()));
  assert.deepEqual(
    [...entries.keys()],
    [`${KEY_STORE_SERVICE}/${TLS_KEY_ACCOUNT}`],
  );
  assert(
    opened.every((key) => key === `${KEY_STORE_SERVICE}/${TLS_KEY_ACCOUNT}`),
  );
  assert.equal(loads, 1);
  // モジュールを読み込めなければ使えない。失敗は保持せず、次の呼び出しで読み込み直す。
  let attempts = 0;
  const flaky = createMacKeychainTlsKeyStore({
    loadModule: () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('load failed'))
        : Promise.resolve(module);
    },
  });
  assert.deepEqual(await flaky.loadTlsKey(), {
    ok: false,
    backend: 'macos_keychain',
    reason: 'keystore_module_unavailable',
  });
  expectKey(await flaky.loadTlsKey());
});

test('Windows・Linux の中枢は初期版の対象外で鍵を返さない', async () => {
  const loadModule = () => Promise.reject(new Error('must not load'));
  for (const [platform, reason] of [
    ['win32', 'windows_core_not_supported_in_initial_release'],
    ['linux', 'linux_core_not_supported_in_initial_release'],
    ['freebsd', 'platform_not_supported'],
  ] as const) {
    const store = createTlsKeyStore(platform, { loadModule });
    assert.deepEqual(await store.loadOrCreateTlsKey(), {
      ok: false,
      backend: 'none',
      reason,
    });
  }
  assert.equal(
    createTlsKeyStore('darwin', { loadModule }).backend,
    'macos_keychain',
  );
});
