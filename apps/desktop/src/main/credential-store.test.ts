// 端末トークンの保存の試験（ADR 0025）。safeStorage は模擬（試験ごとの乱数の鍵）で、実機のキーチェーンを使わない。
// 期待値は試験に手で書いた値。

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { inspect } from 'node:util';
import {
  CREDENTIAL_FILE,
  CredentialStoreError,
  SecretText,
  loadCredential,
  protectionCheck,
  saveCredential,
} from './credential-store.js';
import type { SecretProtector, StoredCredential } from './credential-store.js';
import { mockProtector, tempDir } from './hub-test-support.js';

const TOKEN = 'T'.repeat(20) + 'k'.repeat(23);
const credential = (): StoredCredential => ({
  deviceId: '00000000-0000-4000-8000-0000000000f1',
  token: new SecretText(TOKEN),
  issuedAt: '2030-10-01T00:00:00Z',
  hub: {
    host: '100.64.0.10',
    port: 47443,
    certificatePem:
      '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n',
    fingerprint: 'ab'.repeat(32),
  },
});

test('only OS-backed protection is accepted; weak or unknown backends are refused', () => {
  const cases: [Parameters<typeof mockProtector>[0], string][] = [
    [{ platform: 'darwin' }, 'ok'],
    [{ platform: 'win32' }, 'ok'],
    [{ platform: 'darwin', available: false }, 'encryption_unavailable'],
    [{ platform: 'win32', available: false }, 'encryption_unavailable'],
    [{ platform: 'linux', backend: 'gnome_libsecret' }, 'ok'],
    [{ platform: 'linux', backend: 'kwallet6' }, 'ok'],
    [{ platform: 'linux', backend: 'basic_text' }, 'weak_backend'],
    [{ platform: 'linux', backend: 'unknown' }, 'weak_backend'],
    [{ platform: 'linux', backend: null }, 'weak_backend'],
    [
      { platform: 'linux', available: false, backend: 'kwallet' },
      'encryption_unavailable',
    ],
    [{ platform: 'freebsd' }, 'platform_unsupported'],
  ];
  for (const [options, expected] of cases) {
    const check = protectionCheck(mockProtector(options));
    assert.equal(
      check.ok ? 'ok' : check.reason,
      expected,
      JSON.stringify(options),
    );
  }
  // 問い合わせが例外を投げても保護なしとして扱う。
  const throwing: SecretProtector = {
    ...mockProtector({ platform: 'darwin' }),
    isEncryptionAvailable: () => {
      throw new Error('boom');
    },
  };
  assert.deepEqual(protectionCheck(throwing), {
    ok: false,
    reason: 'encryption_unavailable',
  });
});

test('the credential is stored encrypted and read back; the token never appears in the file or in strings', async (t) => {
  const dir = await tempDir(t, 'bdcs-');
  const path = join(dir, CREDENTIAL_FILE);
  const protector = mockProtector();
  assert.deepEqual(loadCredential(path, protector), { kind: 'missing' });
  saveCredential(path, protector, credential());
  const bytes = readFileSync(path);
  assert.equal(bytes.includes(Buffer.from(TOKEN)), false);
  assert.equal(bytes.includes(Buffer.from('device_token')), false);
  const loaded = loadCredential(path, protector);
  assert.equal(loaded.kind, 'loaded');
  if (loaded.kind !== 'loaded') return;
  assert.equal(loaded.credential.token.reveal(), TOKEN);
  assert.equal(loaded.credential.hub.port, 47443);
  for (const text of [
    JSON.stringify(loaded.credential),
    String(loaded.credential.token),
    `${loaded.credential.token}`,
    inspect(loaded.credential),
    inspect(loaded.credential.token),
  ])
    assert.equal(text.includes(TOKEN), false);
  // 別の鍵（OS の鍵束の作り直し）・壊れたファイルは読めない（再登録が要る）。
  assert.deepEqual(loadCredential(path, mockProtector()), {
    kind: 'unreadable',
  });
  writeFileSync(path, Buffer.from('not encrypted'));
  assert.deepEqual(loadCredential(path, protector), { kind: 'unreadable' });
  writeFileSync(path, protector.encryptString('{"v":1}'));
  assert.deepEqual(loadCredential(path, protector), { kind: 'unreadable' });
  writeFileSync(
    path,
    protector.encryptString(
      JSON.stringify({
        v: 1,
        device_id: '00000000-0000-4000-8000-0000000000f1',
        device_token: TOKEN,
        issued_at: '2030-10-01T00:00:00Z',
        hub: {
          host: 'https://x',
          port: 1,
          certificate_pem: '-----BEGIN CERTIFICATE-----',
          fingerprint: 'ab'.repeat(32),
        },
      }),
    ),
  );
  assert.deepEqual(loadCredential(path, protector), { kind: 'unreadable' });
});

test('nothing is stored or read with weak protection, and a protector that returns plain text is refused', async (t) => {
  const dir = await tempDir(t, 'bdcw-');
  const path = join(dir, CREDENTIAL_FILE);
  const weak = mockProtector({ platform: 'linux', backend: 'basic_text' });
  assert.throws(
    () => saveCredential(path, weak, credential()),
    (error: unknown) =>
      error instanceof CredentialStoreError && error.reason === 'weak_backend',
  );
  assert.equal(existsSync(path), false);
  assert.deepEqual(loadCredential(path, weak), {
    kind: 'unprotected',
    reason: 'weak_backend',
  });
  const plain: SecretProtector = {
    ...mockProtector(),
    encryptString: (text) => Buffer.from(text, 'utf8'),
  };
  assert.throws(
    () => saveCredential(path, plain, credential()),
    (error: unknown) =>
      error instanceof CredentialStoreError && error.reason === 'not_encrypted',
  );
  assert.equal(existsSync(path), false);
});
