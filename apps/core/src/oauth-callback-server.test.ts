// OAuth のループバックの戻り先（B03-04、ADR 0144）の試験。実ポート（OS が選んだ空き）で受ける。
// 期待値は手書き。文面にアカウント識別・トークン・コードが出ないことも確かめる。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createOAuthCallbackServer } from './oauth-callback-server.js';
import type { OAuthCallbackOutcome } from './oauth.js';

test('the callback server answers only /oauth/callback and renders fixed pages', async (t) => {
  const seen: string[] = [];
  const server = createOAuthCallbackServer({
    port: 0,
    handleCallback: (query): Promise<OAuthCallbackOutcome> => {
      seen.push(query.get('state') ?? '');
      return Promise.resolve(
        query.get('state') === 'good'
          ? { kind: 'connected', provider: 'google' }
          : { kind: 'failed', reason: 'state_invalid' },
      );
    },
  });
  await server.listen();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  assert.equal(server.redirectUri, `${base}/oauth/callback`);

  const ok = await fetch(`${base}/oauth/callback?state=good&code=secret-code`);
  assert.equal(ok.status, 200);
  const okText = await ok.text();
  assert.match(okText, /接続が完了しました/u);
  assert.ok(!okText.includes('secret-code'));

  const bad = await fetch(`${base}/oauth/callback?state=bad&code=secret-code`);
  assert.equal(bad.status, 400);
  const badText = await bad.text();
  assert.match(badText, /接続できませんでした/u);
  assert.ok(!badText.includes('secret-code'));

  const other = await fetch(`${base}/v1/connections`);
  assert.equal(other.status, 404);
  assert.deepEqual(seen, ['good', 'bad']);
});

test('a non-loopback host is refused', () => {
  assert.throws(
    () =>
      createOAuthCallbackServer({
        host: '0.0.0.0',
        handleCallback: () =>
          Promise.resolve({ kind: 'failed', reason: 'state_invalid' }),
      }),
    /oauth_callback_host_not_loopback/u,
  );
});
