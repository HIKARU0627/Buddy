// OAuth トークンの KeyStore（ADR 0010・0144）。模擬だけ（実機のキーチェーンには触れない）。
// 期待値は手書き。トークンの値は合成。

import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import {
  OAuthTokens,
  createMockOAuthTokenStore,
  createUnsupportedOAuthTokenStore,
  oauthTokenAccount,
} from './index.js';

const TOKENS = new OAuthTokens({
  accessToken: 'access-token-value-1',
  refreshToken: 'refresh-token-value-1',
  expiresAt: '2026-11-23T12:00:00.000Z',
  grantedScopes: ['gmail.readonly'],
});

test('置いたトークンは読み戻せ、項目名は oauth-v1:<connection_id>', async () => {
  const store = createMockOAuthTokenStore();
  assert.equal(oauthTokenAccount('conn-1'), 'oauth-v1:conn-1');
  assert.ok((await store.write('conn-1', TOKENS)).ok);
  assert.deepEqual(store.accounts(), ['oauth-v1:conn-1']);
  const read = await store.read('conn-1');
  assert.ok(read.ok);
  assert.equal(read.tokens.accessToken, 'access-token-value-1');
  assert.equal(read.tokens.refreshToken, 'refresh-token-value-1');
  assert.equal(read.tokens.expiresAt, '2026-11-23T12:00:00.000Z');
  assert.deepEqual(read.tokens.grantedScopes, ['gmail.readonly']);
  // 別の接続の項目は無い。
  const missing = await store.read('conn-2');
  assert.equal(missing.ok ? '' : missing.reason, 'oauth_token_missing');
});

test('更新トークンの回転では上書きできる（バックアップの鍵と違う）', async () => {
  const store = createMockOAuthTokenStore();
  assert.ok((await store.write('conn-1', TOKENS)).ok);
  const rotated = new OAuthTokens({
    accessToken: 'access-token-value-2',
    refreshToken: 'refresh-token-value-2',
    expiresAt: '2026-11-23T13:00:00.000Z',
    grantedScopes: ['gmail.readonly'],
  });
  assert.ok((await store.write('conn-1', rotated)).ok);
  const read = await store.read('conn-1');
  assert.ok(read.ok);
  assert.equal(read.tokens.accessToken, 'access-token-value-2');
  assert.equal(read.tokens.refreshToken, 'refresh-token-value-2');
});

test('消すと読めなくなり、無い項目の削除は成功として扱う', async () => {
  const store = createMockOAuthTokenStore();
  assert.ok((await store.write('conn-1', TOKENS)).ok);
  assert.ok((await store.remove('conn-1')).ok);
  assert.deepEqual(store.accounts(), []);
  const read = await store.read('conn-1');
  assert.equal(read.ok ? '' : read.reason, 'oauth_token_missing');
  assert.ok((await store.remove('conn-1')).ok);
});

test('保存値の形式が壊れていれば format_invalid で、値は理由に出ない', async () => {
  const store = createMockOAuthTokenStore();
  store.overwrite('conn-1', 'not-json');
  const read = await store.read('conn-1');
  assert.equal(read.ok ? '' : read.reason, 'oauth_token_format_invalid');
  store.overwrite('conn-1', JSON.stringify({ v: 2, access_token: 'x' }));
  const read2 = await store.read('conn-1');
  assert.equal(read2.ok ? '' : read2.reason, 'oauth_token_format_invalid');
});

test('接続 ID が不正なら oauth_connection_id_invalid', async () => {
  const store = createMockOAuthTokenStore();
  const read = await store.read('bad id!');
  assert.equal(read.ok ? '' : read.reason, 'oauth_connection_id_invalid');
  const write = await store.write('', TOKENS);
  assert.equal(write.ok ? '' : write.reason, 'oauth_connection_id_invalid');
});

test('トークンの値は JSON・inspect・文字列化に出ない', () => {
  const json = JSON.stringify(TOKENS);
  assert.ok(!json.includes('access-token-value-1'));
  assert.ok(!json.includes('refresh-token-value-1'));
  assert.ok(!inspect(TOKENS).includes('access-token-value-1'));
  assert.ok(!String(TOKENS).includes('access-token-value-1'));
  assert.equal(TOKENS.toJSON().accessToken, '[redacted]');
});

test('対応しない OS のストアは理由だけを返す', async () => {
  const store = createUnsupportedOAuthTokenStore('linux');
  const read = await store.read('conn-1');
  assert.equal(
    read.ok ? '' : read.reason,
    'linux_core_not_supported_in_initial_release',
  );
  const write = await store.write('conn-1', TOKENS);
  assert.equal(write.ok, false);
});

test('模擬が開けない・書けないときは理由だけを返す', async () => {
  const unavailable = createMockOAuthTokenStore({ available: false });
  const read = await unavailable.read('conn-1');
  assert.equal(read.ok ? '' : read.reason, 'mock_unavailable');
  const writeFails = createMockOAuthTokenStore({ writeFails: true });
  const write = await writeFails.write('conn-1', TOKENS);
  assert.equal(write.ok ? '' : write.reason, 'keystore_write_failed');
});
