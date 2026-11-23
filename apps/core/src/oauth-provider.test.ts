// OAuth プロバイダの口（B03-04、ADR 0144）の試験。輸送は偽物で、実プロバイダへは送らない。
// 期待値（スコープ・URL の要素・クレームの写し方）は設計 04 と各プロバイダの認可の仕様から手で書いた値。
// トークン・ID トークンは合成値。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGoogleOAuthPort,
  createMicrosoftOAuthPort,
  oauthScopes,
  type OAuthHttpTransport,
} from './oauth-provider.js';

const NOW = new Date('2026-11-23T00:00:00.000Z');

function idToken(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function transportReturning(
  status: number,
  body: unknown,
  captured?: { url?: string; form?: Readonly<Record<string, string>> },
): OAuthHttpTransport {
  return async (input) => {
    if (captured !== undefined) {
      captured.url = input.url;
      captured.form = input.form;
    }
    return {
      status,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    };
  };
}

test('scopes match design 04 (read) and add write scopes only for read_write', () => {
  assert.deepEqual(oauthScopes('google', 'read'), [
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
    'https://www.googleapis.com/auth/gmail.readonly',
  ]);
  assert.deepEqual(oauthScopes('google', 'read_write'), [
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/gmail.modify',
  ]);
  assert.deepEqual(oauthScopes('microsoft', 'read'), [
    'openid',
    'profile',
    'offline_access',
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/MailboxSettings.Read',
  ]);
  assert.deepEqual(oauthScopes('microsoft', 'read_write'), [
    'openid',
    'profile',
    'offline_access',
    'https://graph.microsoft.com/Mail.ReadWrite',
    'https://graph.microsoft.com/Mail.Send',
    'https://graph.microsoft.com/MailboxSettings.Read',
  ]);
});

test('google authorization URL carries PKCE, state, and offline access', () => {
  const port = createGoogleOAuthPort({
    clientId: 'google-client-1',
    transport: transportReturning(200, {}),
    now: () => NOW,
  });
  const url = new URL(
    port.authorizationUrl({
      redirectUri: 'http://127.0.0.1:47445/oauth/callback',
      state: 'state-1',
      codeChallenge: 'challenge-1',
      scopes: oauthScopes('google', 'read'),
    }),
  );
  assert.equal(
    url.origin + url.pathname,
    'https://accounts.google.com/o/oauth2/v2/auth',
  );
  assert.equal(url.searchParams.get('client_id'), 'google-client-1');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-1');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.match(url.searchParams.get('scope') ?? '', /gmail\.readonly/u);
});

test('google exchange maps the id_token claims to the account identity', async () => {
  const captured: { url?: string; form?: Readonly<Record<string, string>> } =
    {};
  const port = createGoogleOAuthPort({
    clientId: 'google-client-1',
    transport: transportReturning(
      200,
      {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
        id_token: idToken({
          sub: 'google-user-42',
          email: 'user@example.com',
          name: 'Example User',
        }),
      },
      captured,
    ),
    now: () => NOW,
  });
  const result = await port.exchangeCode({
    code: 'code-1',
    codeVerifier: 'verifier-1',
    redirectUri: 'http://127.0.0.1:47445/oauth/callback',
  });
  assert.ok(result.ok);
  assert.equal(result.value.access_token, 'access-1');
  assert.equal(result.value.refresh_token, 'refresh-1');
  assert.equal(result.value.expires_at, '2026-11-23T01:00:00.000Z');
  assert.deepEqual(result.value.account, {
    account_id: 'google-user-42',
    email: 'user@example.com',
    display_name: 'Example User',
    tenant_id: null,
    account_kind: null,
  });
  assert.equal(captured.url, 'https://oauth2.googleapis.com/token');
  assert.equal(captured.form?.['grant_type'], 'authorization_code');
  assert.equal(captured.form?.['code_verifier'], 'verifier-1');
  // シークレット未設定ならクライアントシークレットは送らない（ADR 0144 追補）。
  assert.equal(captured.form?.['client_secret'], undefined);
});

test('microsoft identity uses oid and classifies the tenant', async () => {
  const personal = createMicrosoftOAuthPort({
    clientId: 'ms-client-1',
    transport: transportReturning(200, {
      access_token: 'access-2',
      expires_in: 3600,
      id_token: idToken({
        oid: 'ms-user-7',
        sub: 'pairwise-sub',
        preferred_username: 'person@example.com',
        name: 'Person',
        tid: '9188040d-6c67-4c5b-b112-36a304b66dad',
      }),
    }),
    now: () => NOW,
  });
  const result = await personal.exchangeCode({
    code: 'code-2',
    codeVerifier: 'verifier-2',
    redirectUri: 'http://127.0.0.1:47445/oauth/callback',
  });
  assert.ok(result.ok);
  assert.equal(result.value.account.account_id, 'ms-user-7');
  assert.equal(result.value.account.account_kind, 'personal');
  assert.equal(result.value.account.email, 'person@example.com');
  assert.equal(result.value.refresh_token, null);

  const work = createMicrosoftOAuthPort({
    clientId: 'ms-client-1',
    transport: transportReturning(200, {
      access_token: 'access-3',
      expires_in: 3600,
      id_token: idToken({
        oid: 'ms-user-8',
        tid: 'contoso-tenant-id',
        preferred_username: 'staff@example.org',
      }),
    }),
    now: () => NOW,
  });
  const workResult = await work.exchangeCode({
    code: 'code-3',
    codeVerifier: 'verifier-3',
    redirectUri: 'http://127.0.0.1:47445/oauth/callback',
  });
  assert.ok(workResult.ok);
  assert.equal(workResult.value.account.account_kind, 'work_or_school');
});

test('provider failures map to reason codes without response bodies', async () => {
  const rejected = createGoogleOAuthPort({
    clientId: 'google-client-1',
    transport: transportReturning(400, { error: 'invalid_grant' }),
    now: () => NOW,
  });
  const rejectedResult = await rejected.refresh({ refreshToken: 'refresh-x' });
  assert.deepEqual(rejectedResult, { ok: false, reason: 'provider_rejected' });

  const unreachable = createGoogleOAuthPort({
    clientId: 'google-client-1',
    transport: async () => {
      throw new Error('network down');
    },
    now: () => NOW,
  });
  const unreachableResult = await unreachable.refresh({
    refreshToken: 'refresh-x',
  });
  assert.deepEqual(unreachableResult, {
    ok: false,
    reason: 'provider_unreachable',
  });

  const noIdToken = createGoogleOAuthPort({
    clientId: 'google-client-1',
    transport: transportReturning(200, { access_token: 'access-9' }),
    now: () => NOW,
  });
  const invalidResult = await noIdToken.exchangeCode({
    code: 'code-9',
    codeVerifier: 'verifier-9',
    redirectUri: 'http://127.0.0.1:47445/oauth/callback',
  });
  assert.deepEqual(invalidResult, { ok: false, reason: 'invalid_response' });
});

test('refresh returns the new access token and keeps a missing refresh token as null', async () => {
  const captured: { url?: string; form?: Readonly<Record<string, string>> } =
    {};
  const port = createMicrosoftOAuthPort({
    clientId: 'ms-client-1',
    transport: transportReturning(
      200,
      { access_token: 'access-new', expires_in: 1800 },
      captured,
    ),
    now: () => NOW,
  });
  const result = await port.refresh({ refreshToken: 'refresh-9' });
  assert.ok(result.ok);
  assert.equal(result.value.access_token, 'access-new');
  assert.equal(result.value.refresh_token, null);
  assert.equal(result.value.expires_at, '2026-11-23T00:30:00.000Z');
  assert.equal(captured.form?.['grant_type'], 'refresh_token');
  assert.equal(captured.form?.['refresh_token'], 'refresh-9');
});

// ADR 0144 追補: Google のデスクトップ型クライアントは PKCE でもトークンエンドポイントがシークレットを要求する。
// シークレットは設定時だけ交換・更新のフォームに載せ、未設定なら載せない。Microsoft は常に載せない。
// 期待するフォームは各プロバイダのトークンエンドポイントの仕様から手で書いた値（シークレットは合成値）。

const SYNTHETIC_SECRET = 'synthetic-google-secret-0001';

function recordingTransport(
  forms: Readonly<Record<string, string>>[],
  body: unknown,
): OAuthHttpTransport {
  return async (input) => {
    forms.push({ ...input.form });
    return { status: 200, body: JSON.stringify(body) };
  };
}

const GOOGLE_TOKEN_BODY = {
  access_token: 'access-s1',
  refresh_token: 'refresh-s1',
  expires_in: 3600,
  id_token: idToken({ sub: 'google-user-s1' }),
};

test('google sends client_secret on exchange and refresh only when configured', async () => {
  const forms: Readonly<Record<string, string>>[] = [];
  const port = createGoogleOAuthPort({
    clientId: 'google-client-1',
    clientSecret: SYNTHETIC_SECRET,
    transport: recordingTransport(forms, GOOGLE_TOKEN_BODY),
    now: () => NOW,
  });
  const exchanged = await port.exchangeCode({
    code: 'code-s1',
    codeVerifier: 'verifier-s1',
    redirectUri: 'http://127.0.0.1:47445/oauth/callback',
  });
  assert.ok(exchanged.ok);
  const refreshed = await port.refresh({ refreshToken: 'refresh-s1' });
  assert.ok(refreshed.ok);
  assert.deepEqual(forms, [
    {
      client_id: 'google-client-1',
      client_secret: 'synthetic-google-secret-0001',
      grant_type: 'authorization_code',
      code: 'code-s1',
      redirect_uri: 'http://127.0.0.1:47445/oauth/callback',
      code_verifier: 'verifier-s1',
    },
    {
      client_id: 'google-client-1',
      client_secret: 'synthetic-google-secret-0001',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-s1',
    },
  ]);

  // 失効（revoke）はシークレットを要しないので載せない。
  const revokeForms: Readonly<Record<string, string>>[] = [];
  const revoking = createGoogleOAuthPort({
    clientId: 'google-client-1',
    clientSecret: SYNTHETIC_SECRET,
    transport: recordingTransport(revokeForms, {}),
    now: () => NOW,
  });
  await revoking.revoke({ token: 'refresh-s1' });
  assert.deepEqual(revokeForms, [
    { token: 'refresh-s1', client_id: 'google-client-1' },
  ]);
});

test('google omits client_secret when unset or empty', async () => {
  for (const clientSecret of [undefined, '']) {
    const forms: Readonly<Record<string, string>>[] = [];
    const port = createGoogleOAuthPort({
      clientId: 'google-client-1',
      ...(clientSecret === undefined ? {} : { clientSecret }),
      transport: recordingTransport(forms, GOOGLE_TOKEN_BODY),
      now: () => NOW,
    });
    assert.ok(
      (
        await port.exchangeCode({
          code: 'code-s2',
          codeVerifier: 'verifier-s2',
          redirectUri: 'http://127.0.0.1:47445/oauth/callback',
        })
      ).ok,
    );
    assert.ok((await port.refresh({ refreshToken: 'refresh-s2' })).ok);
    assert.deepEqual(forms, [
      {
        client_id: 'google-client-1',
        grant_type: 'authorization_code',
        code: 'code-s2',
        redirect_uri: 'http://127.0.0.1:47445/oauth/callback',
        code_verifier: 'verifier-s2',
      },
      {
        client_id: 'google-client-1',
        grant_type: 'refresh_token',
        refresh_token: 'refresh-s2',
      },
    ]);
  }
});

test('google client secret does not appear in serialization or inspection of the port', async () => {
  const { inspect } = await import('node:util');
  const port = createGoogleOAuthPort({
    clientId: 'google-client-1',
    clientSecret: SYNTHETIC_SECRET,
    transport: recordingTransport([], GOOGLE_TOKEN_BODY),
    now: () => NOW,
  });
  assert.ok(!JSON.stringify(port).includes(SYNTHETIC_SECRET));
  assert.ok(
    !inspect(port, { depth: 10, showHidden: true }).includes(SYNTHETIC_SECRET),
  );
  assert.ok(!String(port).includes(SYNTHETIC_SECRET));
  assert.ok(!Object.values(port).some((value) => value === SYNTHETIC_SECRET));
});

test('microsoft token forms stay without client_secret', async () => {
  const forms: Readonly<Record<string, string>>[] = [];
  const port = createMicrosoftOAuthPort({
    clientId: 'ms-client-1',
    transport: recordingTransport(forms, {
      access_token: 'access-m1',
      expires_in: 3600,
      id_token: idToken({ oid: 'ms-user-m1', tid: 'contoso-tenant-id' }),
    }),
    now: () => NOW,
  });
  assert.ok(
    (
      await port.exchangeCode({
        code: 'code-m1',
        codeVerifier: 'verifier-m1',
        redirectUri: 'http://127.0.0.1:47445/oauth/callback',
      })
    ).ok,
  );
  assert.ok((await port.refresh({ refreshToken: 'refresh-m1' })).ok);
  assert.deepEqual(forms, [
    {
      client_id: 'ms-client-1',
      grant_type: 'authorization_code',
      code: 'code-m1',
      redirect_uri: 'http://127.0.0.1:47445/oauth/callback',
      code_verifier: 'verifier-m1',
    },
    {
      client_id: 'ms-client-1',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-m1',
    },
  ]);
});
