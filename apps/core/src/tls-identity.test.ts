// TLS の身元（秘密鍵はキーチェーン、証明書はデータディレクトリ）の試験（ADR 0020）。
// 鍵は模擬の TlsKeyStore（実機のキーチェーンに触れない）。指紋の期待値は X509Certificate から求める。

import assert from 'node:assert/strict';
import { X509Certificate, generateKeyPairSync } from 'node:crypto';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createMockTlsKeyStore } from '@buddy/platform';
import { tempDir } from './api-test-support.js';
import type { TlsIdentityError } from './tls-identity.js';
import {
  TLS_CERTIFICATE_FILE,
  loadOrCreateTlsIdentity,
} from './tls-identity.js';

const NOW = new Date(Date.UTC(2030, 9, 5));

const fingerprintOf = (pem: string) =>
  new X509Certificate(pem).fingerprint256.replace(/:/gu, '').toLowerCase();

test('the first start creates the key in the key store and only the certificate on disk', async (t) => {
  const dir = await tempDir(t, 'buddy-tls-');
  const tlsKeyStore = createMockTlsKeyStore();
  const identity = await loadOrCreateTlsIdentity({
    dataDir: dir,
    tlsKeyStore,
    now: NOW,
  });
  assert.equal(identity.creation, 'key_and_certificate');
  assert.equal(tlsKeyStore.writes, 1);
  const pem = await readFile(join(dir, TLS_CERTIFICATE_FILE), 'utf8');
  assert.equal(pem, identity.certificatePem);
  assert.equal(identity.fingerprint, fingerprintOf(pem));
  // データディレクトリには証明書（公開部分）だけがあり、秘密鍵の平文はない。
  assert.deepEqual(await readdir(dir), [TLS_CERTIFICATE_FILE]);
  assert(!pem.includes('PRIVATE KEY'));
  const keyPem = identity.privateKey.toPkcs8Pem();
  const keyBody = keyPem.split('\n').slice(1, -2).join('');
  assert(!pem.includes(keyBody));
  if (process.platform !== 'win32')
    assert.equal(
      (await stat(join(dir, TLS_CERTIFICATE_FILE))).mode & 0o777,
      0o600,
    );
  // 秘密鍵は JSON・文字列化で出ない。
  assert(!JSON.stringify(identity).includes(keyBody));
  assert.equal(String(identity.privateKey), 'TlsPrivateKey([redacted])');

  // 2 回目は同じ鍵と証明書（同じ指紋）を使う。
  const again = await loadOrCreateTlsIdentity({
    dataDir: dir,
    tlsKeyStore,
    now: NOW,
  });
  assert.equal(again.creation, 'existing');
  assert.equal(again.fingerprint, identity.fingerprint);
  assert.equal(tlsKeyStore.writes, 1);
});

test('a missing certificate or key is recreated with a new fingerprint', async (t) => {
  const dir = await tempDir(t, 'buddy-tls-');
  const tlsKeyStore = createMockTlsKeyStore();
  const first = await loadOrCreateTlsIdentity({
    dataDir: dir,
    tlsKeyStore,
    now: NOW,
  });
  // 証明書を消すと、同じ鍵で作り直す（指紋は変わる）。
  await writeFile(join(dir, TLS_CERTIFICATE_FILE), '');
  await assert.rejects(
    loadOrCreateTlsIdentity({ dataDir: dir, tlsKeyStore, now: NOW }),
    (error: TlsIdentityError) => error.reason === 'tls_certificate_invalid',
  );
  await rm(join(dir, TLS_CERTIFICATE_FILE));
  const second = await loadOrCreateTlsIdentity({
    dataDir: dir,
    tlsKeyStore,
    now: NOW,
  });
  assert.equal(second.creation, 'certificate');
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(tlsKeyStore.writes, 1);
  assert(
    new X509Certificate(second.certificatePem).checkPrivateKey(
      first.privateKey.keyObject,
    ),
  );
  // 鍵がなくなっていれば（別の KeyStore）、鍵と証明書を作り直す。
  const fresh = createMockTlsKeyStore();
  const third = await loadOrCreateTlsIdentity({
    dataDir: dir,
    tlsKeyStore: fresh,
    now: NOW,
  });
  assert.equal(third.creation, 'key_and_certificate');
  assert.notEqual(third.fingerprint, second.fingerprint);
  assert.equal(
    await readFile(join(dir, TLS_CERTIFICATE_FILE), 'utf8'),
    third.certificatePem,
  );
});

test('a certificate of another key, an unreadable key and an unavailable key store are refused without overwriting', async (t) => {
  const dir = await tempDir(t, 'buddy-tls-');
  await loadOrCreateTlsIdentity({
    dataDir: dir,
    tlsKeyStore: createMockTlsKeyStore(),
    now: NOW,
  });
  const before = await readFile(join(dir, TLS_CERTIFICATE_FILE), 'utf8');
  // 別の鍵がキーチェーンにある（証明書と合わない）。
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ type: 'pkcs8', format: 'der' })
    .toString('base64');
  await assert.rejects(
    loadOrCreateTlsIdentity({
      dataDir: dir,
      tlsKeyStore: createMockTlsKeyStore({ stored: other }),
      now: NOW,
    }),
    (error: TlsIdentityError) =>
      error.reason === 'tls_certificate_mismatch' &&
      error.reasons.includes('certificate_key_mismatch'),
  );
  // 保存値が壊れている・読めない・保護領域を開けない。どれも鍵を作り直さない。
  const cases = [
    [
      createMockTlsKeyStore({ stored: 'not base64!' }),
      'tls_key_unavailable:tls_key_format_invalid',
    ],
    [
      createMockTlsKeyStore({ readFails: true }),
      'tls_key_unavailable:keystore_read_failed',
    ],
    [
      createMockTlsKeyStore({ available: false }),
      'tls_key_unavailable:mock_unavailable',
    ],
  ] as const;
  for (const [tlsKeyStore, reason] of cases) {
    await assert.rejects(
      loadOrCreateTlsIdentity({ dataDir: dir, tlsKeyStore, now: NOW }),
      (error: TlsIdentityError) =>
        error.reason === 'tls_key_unavailable' && error.reasons[0] === reason,
    );
    assert.equal(tlsKeyStore.writes, 0);
  }
  // 書けない保護領域では鍵も証明書も作らない。
  const empty = await tempDir(t, 'buddy-tls-');
  await assert.rejects(
    loadOrCreateTlsIdentity({
      dataDir: empty,
      tlsKeyStore: createMockTlsKeyStore({ writeFails: true }),
      now: NOW,
    }),
    (error: TlsIdentityError) =>
      error.reasons[0] === 'tls_key_unavailable:keystore_write_failed',
  );
  assert.deepEqual(await readdir(empty), []);
  assert.equal(await readFile(join(dir, TLS_CERTIFICATE_FILE), 'utf8'), before);
});
