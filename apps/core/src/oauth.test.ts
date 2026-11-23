// 接続の作成・OAuth のサービス（B03-04、ADR 0144）の試験。保存は実際の DB worker、プロバイダと
// トークンの KeyStore は偽物・模擬。期待値は設計 04・11 §1A と ADR 0144 の決定から手で書いた値。
// 実アカウント・実トークンは使わない（すべて合成値）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { OAuthTokens, createMockOAuthTokenStore } from '@buddy/platform';
import type { ConnectionRecord } from '@buddy/storage';
import type { ApiHandlerRequest } from './api-server.js';
import { DATA_KEY_MATERIAL, startEventCore } from './event-test-support.js';
import { createOAuthService } from './oauth.js';
import type {
  OAuthProviderPort,
  OAuthProviderResult,
  OAuthTokenExchange,
} from './oauth-provider.js';

const EXCHANGE: OAuthTokenExchange = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_at: '2026-11-23T01:00:00.000Z',
  granted_scopes: [
    'openid',
    'email',
    'https://www.googleapis.com/auth/gmail.readonly',
  ],
  account: {
    account_id: 'google-user-42',
    email: 'user@example.com',
    display_name: 'Example User',
    tenant_id: null,
    account_kind: null,
  },
};

class FakePort implements OAuthProviderPort {
  exchangeResult: OAuthProviderResult<OAuthTokenExchange> = {
    ok: true,
    value: EXCHANGE,
  };
  refreshResult: OAuthProviderResult<Omit<OAuthTokenExchange, 'account'>> = {
    ok: true,
    value: {
      access_token: 'access-refreshed',
      refresh_token: null,
      expires_at: '2026-11-23T02:00:00.000Z',
      granted_scopes: [],
    },
  };
  readonly revoked: string[] = [];

  authorizationUrl(input: {
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
    readonly scopes: readonly string[];
  }): string {
    const params = new URLSearchParams({
      state: input.state,
      challenge: input.codeChallenge,
      redirect: input.redirectUri,
    });
    return `https://auth.example/authorize?${params.toString()}`;
  }
  exchangeCode(): Promise<OAuthProviderResult<OAuthTokenExchange>> {
    return Promise.resolve(this.exchangeResult);
  }
  refresh(): Promise<OAuthProviderResult<Omit<OAuthTokenExchange, 'account'>>> {
    return Promise.resolve(this.refreshResult);
  }
  revoke(input: { readonly token: string }): Promise<void> {
    this.revoked.push(input.token);
    return Promise.resolve();
  }
}

function request(
  body: Record<string, unknown>,
  params: Record<string, string> = {},
): ApiHandlerRequest {
  return {
    route: null,
    device: null,
    body,
    params,
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
  } as unknown as ApiHandlerRequest;
}

async function harness(t: test.TestContext) {
  const core = await startEventCore(t);
  const store = core.handle.store;
  const tokenStore = createMockOAuthTokenStore();
  const port = new FakePort();
  let idCounter = 0;
  let randomCounter = 0;
  let current = new Date('2026-11-23T00:00:00.000Z');
  const service = createOAuthService({
    store,
    keyStore: {
      loadDataKey: () =>
        Promise.resolve({ ok: true, dataKey: DATA_KEY_MATERIAL }),
    },
    tokenStore,
    providers: { google: { port } },
    redirectUri: 'http://127.0.0.1:47445/oauth/callback',
    now: () => current,
    newId: () => `id-${(idCounter += 1)}`,
    random: (size) => Buffer.alloc(size, (randomCounter += 1)),
  });
  return {
    store,
    tokenStore,
    port,
    service,
    setNow(value: string) {
      current = new Date(value);
    },
  };
}

async function startAndCallback(
  h: Awaited<ReturnType<typeof harness>>,
): Promise<string> {
  const started = await h.service.handlers.startOAuth(
    request({
      request_id: 'req-1',
      command_scope_id: 'scope-1',
      provider: 'google',
      access: 'read',
    }),
  );
  assert.equal(started.status, 200);
  const url = new URL(
    (started.body as { authorization_url: string }).authorization_url,
  );
  const state = url.searchParams.get('state');
  assert.ok(state !== null);
  const outcome = await h.service.handleCallback(
    new URLSearchParams({ state, code: 'code-1' }),
  );
  assert.deepEqual(outcome, { kind: 'connected', provider: 'google' });
  const listed = await h.store.connectionTargets({ kind: 'connections.list' });
  assert.ok(listed.ok);
  return listed.value[0]?.connection_id ?? '';
}

test('the full flow creates one connection with initial targets, scopes, and stored tokens', async (t) => {
  const h = await harness(t);
  const connectionId = await startAndCallback(h);
  assert.equal(connectionId, 'conn-id-1');

  const listed = await h.store.connectionTargets({ kind: 'connections.list' });
  assert.ok(listed.ok);
  assert.equal(listed.value.length, 1);
  const connection = listed.value[0] as ConnectionRecord;
  assert.equal(connection.provider, 'google');
  assert.equal(connection.status, 'active');
  assert.equal(connection.access, 'read');
  assert.equal(connection.permission_revision, '1');
  assert.equal(connection.targets_state, 'complete');
  // 初期の取得対象は domain の初期値（受信トレイだけ・添付は PDF とテキスト・期間は設計の初期値）。
  assert.deepEqual(connection.targets, {
    calendar_ids: [],
    mail_container_ids: ['INBOX'],
    attachment_kinds: ['pdf', 'text'],
    mail_lookback_days: 90,
    calendar_past_days: 30,
    calendar_future_days: 90,
    attachment_max_bytes: 10000000,
  });
  // 取得集合は mail と calendar の 2 つで、どちらも pending_full（最初の走査は全量）。
  const scopes = await h.store.sync({
    kind: 'sync.list_scopes',
    connection_id: connectionId,
  });
  assert.ok(scopes.ok);
  assert.deepEqual(
    scopes.value.map((snapshot) => snapshot.scope.scope_id).sort(),
    [`scope:${connectionId}:calendar`, `scope:${connectionId}:mail`],
  );
  assert.ok(
    scopes.value.every((snapshot) => snapshot.scope.pending_full === true),
  );
  // トークンは KeyStore にだけある。
  assert.deepEqual(h.tokenStore.accounts(), [`oauth-v1:${connectionId}`]);
  const tokens = await h.tokenStore.read(connectionId);
  assert.ok(tokens.ok);
  assert.equal(tokens.tokens.accessToken, 'access-1');
  // スケジューラの対象は封筒の account_id で組み立つ。
  const targets = await h.service.targetsFor(connection);
  assert.deepEqual(targets, [
    {
      account_id: 'google-user-42',
      scope_id: `scope:${connectionId}:mail`,
      resource: 'mail',
    },
    {
      account_id: 'google-user-42',
      scope_id: `scope:${connectionId}:calendar`,
      resource: 'calendar',
    },
  ]);
  // トークンの出所は失効前なら保存済みの値を返す。
  const source = h.service.googleTokenSourceFor(connection);
  assert.ok(source !== null);
  assert.equal(await source.getAccessToken(), 'access-1');
  // Microsoft の出所は Google の接続には無い。
  assert.equal(h.service.graphTokenSourceFor(connection), null);
});

test('authorizing the same account again is a reauthorization, not a second connection', async (t) => {
  const h = await harness(t);
  const connectionId = await startAndCallback(h);
  h.port.exchangeResult = {
    ok: true,
    value: {
      ...EXCHANGE,
      access_token: 'access-2',
      refresh_token: 'refresh-2',
    },
  };
  const againId = await startAndCallback(h);
  assert.equal(againId, connectionId);
  const listed = await h.store.connectionTargets({ kind: 'connections.list' });
  assert.ok(listed.ok);
  assert.equal(listed.value.length, 1);
  assert.equal(listed.value[0]?.permission_revision, '2');
  assert.equal(listed.value[0]?.status, 'active');
  const tokens = await h.tokenStore.read(connectionId);
  assert.ok(tokens.ok);
  assert.equal(tokens.tokens.accessToken, 'access-2');
  assert.equal(tokens.tokens.refreshToken, 'refresh-2');
});

test('callback rejects an unknown state and a provider denial', async (t) => {
  const h = await harness(t);
  assert.deepEqual(
    await h.service.handleCallback(
      new URLSearchParams({ state: 'unknown', code: 'code-1' }),
    ),
    { kind: 'failed', reason: 'state_invalid' },
  );
  assert.deepEqual(
    await h.service.handleCallback(
      new URLSearchParams({ error: 'access_denied', state: 'whatever' }),
    ),
    { kind: 'failed', reason: 'provider_denied' },
  );
  const listed = await h.store.connectionTargets({ kind: 'connections.list' });
  assert.ok(listed.ok);
  assert.equal(listed.value.length, 0);
});

test('startOAuth is closed for a provider without configuration', async (t) => {
  const h = await harness(t);
  const started = await h.service.handlers.startOAuth(
    request({
      request_id: 'req-2',
      command_scope_id: 'scope-1',
      provider: 'microsoft',
      access: 'read',
    }),
  );
  assert.equal(started.status, 503);
});

test('disconnect removes the tokens, revokes at the provider, and keeps the row as disconnected', async (t) => {
  const h = await harness(t);
  const connectionId = await startAndCallback(h);
  const response = await h.service.handlers.disconnectConnection(
    request(
      {
        request_id: 'req-3',
        command_scope_id: 'scope-1',
        expected_permission_revision: '1',
      },
      { connection_id: connectionId },
    ),
  );
  assert.equal(response.status, 200);
  assert.equal((response.body as { status: string }).status, 'disconnected');
  assert.deepEqual(h.tokenStore.accounts(), []);
  assert.deepEqual(h.port.revoked, ['refresh-1']);
  // 版が合わない切断は 409。
  const conflict = await h.service.handlers.disconnectConnection(
    request(
      {
        request_id: 'req-4',
        command_scope_id: 'scope-1',
        expected_permission_revision: '1',
      },
      { connection_id: connectionId },
    ),
  );
  assert.equal(conflict.status, 409);
});

test('an expired token is refreshed, and a rejected refresh marks the connection needs_reauth', async (t) => {
  const h = await harness(t);
  const connectionId = await startAndCallback(h);
  const listed = await h.store.connectionTargets({ kind: 'connections.list' });
  assert.ok(listed.ok);
  const connection = listed.value[0] as ConnectionRecord;
  // 失効済みのトークンに置き換える。
  await h.tokenStore.write(
    connectionId,
    new OAuthTokens({
      accessToken: 'access-old',
      refreshToken: 'refresh-1',
      expiresAt: '2026-11-22T23:00:00.000Z',
      grantedScopes: [],
    }),
  );
  const source = h.service.googleTokenSourceFor(connection);
  assert.ok(source !== null);
  assert.equal(await source.getAccessToken(), 'access-refreshed');
  // 更新トークンは旧値が保たれる（プロバイダが新しい値を返さなかった）。
  const stored = await h.tokenStore.read(connectionId);
  assert.ok(stored.ok);
  assert.equal(stored.tokens.refreshToken, 'refresh-1');
  // 恒常的な拒否では再認可待ちに落ちる。
  await h.tokenStore.write(
    connectionId,
    new OAuthTokens({
      accessToken: 'access-old',
      refreshToken: 'refresh-1',
      expiresAt: '2026-11-22T23:00:00.000Z',
      grantedScopes: [],
    }),
  );
  h.port.refreshResult = { ok: false, reason: 'provider_rejected' };
  await assert.rejects(source.getAccessToken());
  const after = await h.store.connectionTargets({
    kind: 'connections.get',
    connection_id: connectionId,
  });
  assert.ok(after.ok);
  assert.equal(after.value?.status, 'needs_reauth');
});
