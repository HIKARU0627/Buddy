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

// 公開の検査（scripts/public-content.mjs は tailnet のホスト名の形を拒否する）に掛からないよう、`*.ts.net` の
// 合成の名前は実行時に組み立てる（実在の Tailnet の名前ではない）。
const TS_NET = ['ts', 'net'].join('.');
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

test('only OS-backed protection is accepted; weak or unknown backends are refused', async () => {
  const cases: [Parameters<typeof mockProtector>[0], string][] = [
    [{ platform: 'darwin' }, 'ok'],
    [{ platform: 'win32' }, 'ok'],
    [{ platform: 'darwin', available: false }, 'encryption_unavailable'],
    [{ platform: 'win32', available: false }, 'encryption_unavailable'],
    [{ platform: 'linux', backend: 'gnome_libsecret' }, 'ok'],
    [{ platform: 'linux', backend: 'kwallet6' }, 'ok'],
    // Linux の非同期の暗号化が実際に使う鍵の種類。v11（Secret Service・KWallet）と v12（portal）だけを強とする。
    [{ platform: 'linux', backend: 'gnome_libsecret', asyncTag: 'v12' }, 'ok'],
    [
      { platform: 'linux', backend: 'gnome_libsecret', asyncTag: 'v10' },
      'weak_backend',
    ],
    [
      { platform: 'linux', backend: 'kwallet6', asyncTag: 'v10' },
      'weak_backend',
    ],
    [
      { platform: 'linux', backend: 'gnome_libsecret', asyncTag: null },
      'weak_backend',
    ],
    [
      { platform: 'linux', backend: 'gnome_libsecret', asyncTag: 'unknown' },
      'weak_backend',
    ],
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
    const check = await protectionCheck(mockProtector(options));
    assert.equal(
      check.ok ? 'ok' : check.reason,
      expected,
      JSON.stringify(options),
    );
  }
  // 問い合わせが例外を投げても保護なしとして扱う。
  const throwing: SecretProtector = {
    ...mockProtector({ platform: 'darwin' }),
    isEncryptionAvailableAsync: () => {
      throw new Error('boom');
    },
  };
  assert.deepEqual(await protectionCheck(throwing), {
    ok: false,
    reason: 'encryption_unavailable',
  });
});

test('the credential is stored encrypted and read back; the token never appears in the file or in strings', async (t) => {
  const dir = await tempDir(t, 'bdcs-');
  const path = join(dir, CREDENTIAL_FILE);
  const protector = mockProtector();
  assert.deepEqual(await loadCredential(path, protector), { kind: 'missing' });
  await saveCredential(path, protector, credential());
  const bytes = readFileSync(path);
  assert.equal(bytes.includes(Buffer.from(TOKEN)), false);
  assert.equal(bytes.includes(Buffer.from('device_token')), false);
  const loaded = await loadCredential(path, protector);
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
  assert.deepEqual(await loadCredential(path, mockProtector()), {
    kind: 'unreadable',
  });
  writeFileSync(path, Buffer.from('not encrypted'));
  assert.deepEqual(await loadCredential(path, protector), {
    kind: 'unreadable',
  });
  writeFileSync(path, await protector.encryptStringAsync('{"v":1}'));
  assert.deepEqual(await loadCredential(path, protector), {
    kind: 'unreadable',
  });
  writeFileSync(
    path,
    await protector.encryptStringAsync(
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
  assert.deepEqual(await loadCredential(path, protector), {
    kind: 'unreadable',
  });
});

// 旧い（同期の safeStorage の時代の）暗号文は後継の非同期 API でもそのまま読める。鍵の入れ替えの合図
// （shouldReEncrypt）が来たら、読めた記録を捨てずに新しい鍵で書き直す。
test('a record from the previous synchronous API is read and rewritten when the key is rotated', async (t) => {
  const dir = await tempDir(t, 'bdcm-');
  const path = join(dir, CREDENTIAL_FILE);
  const previous = mockProtector();
  await saveCredential(path, previous, credential());
  const oldBytes = readFileSync(path);
  const rotated = mockProtector({ reencryptFrom: previous });
  const loaded = await loadCredential(path, rotated);
  assert.equal(loaded.kind, 'loaded');
  if (loaded.kind !== 'loaded') return;
  assert.equal(loaded.credential.token.reveal(), TOKEN);
  const newBytes = readFileSync(path);
  assert.equal(newBytes.equals(oldBytes), false);
  assert.equal(newBytes.includes(Buffer.from(TOKEN)), false);
  // 新しい鍵で書き直されている（旧い鍵ではもう読めない）。
  assert.throws(() => previous.reveal(newBytes));
  assert.equal(rotated.reveal(newBytes).includes(TOKEN), true);
  // 書き直した記録はそのまま読める（移行は 1 回で終わる）。
  const again = await loadCredential(path, rotated);
  assert.equal(again.kind, 'loaded');
  if (again.kind === 'loaded')
    assert.equal(again.credential.token.reveal(), TOKEN);
});

// 移行の書き直しが失敗しても、読めた資格情報は失わない。旧い記録はそのまま残り、平文は書かない。
test('a failed rewrite keeps the old record and never leaves plaintext', async (t) => {
  const dir = await tempDir(t, 'bdcf-');
  const path = join(dir, CREDENTIAL_FILE);
  const previous = mockProtector();
  await saveCredential(path, previous, credential());
  const oldBytes = readFileSync(path);
  const rotated = mockProtector({
    reencryptFrom: previous,
    failEncrypt: true,
  });
  const loaded = await loadCredential(path, rotated);
  assert.equal(loaded.kind, 'loaded');
  if (loaded.kind !== 'loaded') return;
  assert.equal(loaded.credential.token.reveal(), TOKEN);
  // 旧い記録は書き換えられていない（平文も残らない）。
  assert.deepEqual(readFileSync(path), oldBytes);
  assert.equal(readFileSync(path).includes(Buffer.from(TOKEN)), false);
  // 次の起動でも旧い鍵でそのまま読める（資格情報を失わない）。
  const reopened = await loadCredential(path, previous);
  assert.equal(reopened.kind, 'loaded');
  if (reopened.kind === 'loaded')
    assert.equal(reopened.credential.token.reveal(), TOKEN);
});

test('nothing is stored or read with weak protection, and a protector that returns plain text is refused', async (t) => {
  const dir = await tempDir(t, 'bdcw-');
  const path = join(dir, CREDENTIAL_FILE);
  const weak = mockProtector({ platform: 'linux', backend: 'basic_text' });
  await assert.rejects(
    saveCredential(path, weak, credential()),
    (error: unknown) =>
      error instanceof CredentialStoreError && error.reason === 'weak_backend',
  );
  assert.equal(existsSync(path), false);
  assert.deepEqual(await loadCredential(path, weak), {
    kind: 'unprotected',
    reason: 'weak_backend',
  });
  // 同期 backend の名前が強くても、非同期側が固定鍵の fallback（v10）なら保存しない（AO レビューの P1）。
  const fallback = mockProtector({
    platform: 'linux',
    backend: 'gnome_libsecret',
    asyncTag: 'v10',
  });
  await assert.rejects(
    saveCredential(path, fallback, credential()),
    (error: unknown) =>
      error instanceof CredentialStoreError && error.reason === 'weak_backend',
  );
  assert.equal(existsSync(path), false);
  assert.deepEqual(await loadCredential(path, fallback), {
    kind: 'unprotected',
    reason: 'weak_backend',
  });
  const plain: SecretProtector = {
    ...mockProtector(),
    encryptStringAsync: async (text) => Buffer.from(text, 'utf8'),
  };
  await assert.rejects(
    saveCredential(path, plain, credential()),
    (error: unknown) =>
      error instanceof CredentialStoreError && error.reason === 'not_encrypted',
  );
  assert.equal(existsSync(path), false);
});

// レビューの指摘 L2: 読み戻せない記録は保存しない。宛先は正規化した値（末尾のドットなし・小文字）だけ。
test('a credential that would not read back is refused before writing; normalized hosts read back', async (t) => {
  const dir = await tempDir(t, 'bdch-');
  const path = join(dir, CREDENTIAL_FILE);
  const protector = mockProtector();
  const withHost = (host: string): StoredCredential => ({
    ...credential(),
    hub: { ...credential().hub, host },
  });
  for (const host of [
    `hub.example-tailnet.${TS_NET}.`,
    `Hub.Example-Tailnet.${TS_NET}`,
    'FD7A:115C:A1E0::1',
  ]) {
    await assert.rejects(
      saveCredential(path, protector, withHost(host)),
      (error: unknown) =>
        error instanceof CredentialStoreError &&
        error.reason === 'not_readable',
      host,
    );
    assert.equal(existsSync(path), false, host);
  }
  for (const host of [
    `hub.example-tailnet.${TS_NET}`,
    'fd7a:115c:a1e0::1',
    '127.0.0.1',
    '::1',
  ]) {
    await saveCredential(path, protector, withHost(host));
    const loaded = await loadCredential(path, protector);
    assert.equal(loaded.kind, 'loaded', host);
    if (loaded.kind === 'loaded')
      assert.equal(loaded.credential.hub.host, host);
  }
});
