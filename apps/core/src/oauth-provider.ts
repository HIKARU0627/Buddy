// OAuth プロバイダの口（設計 04 対象サービスとの連携・B03-04、ADR 0144）。
// 認可コードフロー（システムブラウザー＋PKCE＋ループバック、ADR 0009）のプロバイダ依存部分だけをここに閉じる。
// 埋め込みのクライアントシークレットには依存しない（公開クライアント。設計 04）。トークン交換で得た ID トークンは
// プロバイダのトークンエンドポイントから TLS で直接受け取ったものなので、署名の検証はせず、ペイロードの
// クレーム（sub／oid 等）だけを読む（アカウント識別が目的で、第三者から受け取ったトークンは扱わない）。
// 失敗は理由コードだけを返し、コード・トークン・応答本文は結果にも例外にも入れない。

import { request as httpsRequest } from 'node:https';

export type OAuthProviderName = 'google' | 'microsoft';
export type OAuthAccessLevel = 'read' | 'read_write';

/** 認可で確定したアカウントの識別（封筒に入れて保存する。トークンではない）。 */
export interface OAuthAccountIdentity {
  readonly account_id: string;
  readonly email: string | null;
  readonly display_name: string | null;
  /** Microsoft のテナント ID。Google では null。 */
  readonly tenant_id: string | null;
  /** Microsoft のテナントからの判定（個人／職場・学校）。判定できなければ null。 */
  readonly account_kind: 'personal' | 'work_or_school' | null;
}

export interface OAuthExchangedTokens {
  readonly access_token: string;
  readonly refresh_token: string | null;
  /** 失効時刻（ISO 8601）。プロバイダが返さなければ null。 */
  readonly expires_at: string | null;
  readonly granted_scopes: readonly string[];
}

export interface OAuthTokenExchange extends OAuthExchangedTokens {
  readonly account: OAuthAccountIdentity;
}

export type OAuthProviderFailureReason =
  // プロバイダが拒否した（HTTP のエラー応答。invalid_grant を含む）。
  | 'provider_rejected'
  // 送れなかった・応答が無かった。
  | 'provider_unreachable'
  // 応答の形が想定と違う（ID トークンの欠落を含む）。
  | 'invalid_response';

export type OAuthProviderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: OAuthProviderFailureReason };

export interface OAuthProviderPort {
  /** 本人がシステムブラウザーで開く認可 URL（PKCE の challenge と state は呼び出し側が作る）。 */
  authorizationUrl(input: {
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
    readonly scopes: readonly string[];
  }): string;
  /** 認可コードの交換。アカウント識別は ID トークンのクレームから取る。 */
  exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<OAuthProviderResult<OAuthTokenExchange>>;
  /** 更新トークンでの再取得。新しい更新トークンが返らなければ refresh_token は null（呼び出し側が旧値を保つ）。 */
  refresh(input: {
    readonly refreshToken: string;
  }): Promise<OAuthProviderResult<OAuthExchangedTokens>>;
  /** トークンの失効（ベストエフォート。失敗しても投げない）。 */
  revoke(input: { readonly token: string }): Promise<void>;
}

/** 設計 04 の初期スコープ（読み取り）と、書き込みを足す場合のスコープ。 */
export function oauthScopes(
  provider: OAuthProviderName,
  access: OAuthAccessLevel,
): readonly string[] {
  if (provider === 'google') {
    return access === 'read'
      ? [
          'openid',
          'email',
          'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
          'https://www.googleapis.com/auth/calendar.events.readonly',
          'https://www.googleapis.com/auth/gmail.readonly',
        ]
      : [
          'openid',
          'email',
          'https://www.googleapis.com/auth/calendar.events',
          'https://www.googleapis.com/auth/gmail.modify',
        ];
  }
  return access === 'read'
    ? [
        'openid',
        'profile',
        'offline_access',
        'https://graph.microsoft.com/Mail.Read',
        'https://graph.microsoft.com/MailboxSettings.Read',
      ]
    : [
        'openid',
        'profile',
        'offline_access',
        'https://graph.microsoft.com/Mail.ReadWrite',
        'https://graph.microsoft.com/Mail.Send',
        'https://graph.microsoft.com/MailboxSettings.Read',
      ];
}

/** フォーム送信の口（試験で差し替える）。応答本文は呼び出し側で JSON として読むだけ。 */
export type OAuthHttpTransport = (input: {
  readonly url: string;
  readonly form: Readonly<Record<string, string>>;
}) => Promise<{ readonly status: number; readonly body: string }>;

const MAX_RESPONSE_BYTES = 1_000_000;

export function createHttpsOAuthTransport(
  timeoutMs = 15_000,
): OAuthHttpTransport {
  return (input) =>
    new Promise((resolve, reject) => {
      const body = new URLSearchParams(input.form).toString();
      const req = httpsRequest(
        input.url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(body),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy(new Error('oauth response too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('oauth request timeout')));
      req.on('error', reject);
      req.end(body);
    });
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** ID トークンのペイロードだけを読む（署名は検証しない。冒頭のコメント参照）。 */
function idTokenClaims(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    return parseJson(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export interface OAuthProviderPortOptions {
  readonly clientId: string;
  /** Microsoft のテナント（既定は common＝個人と職場・学校の両方）。 */
  readonly tenant?: string;
  readonly transport?: OAuthHttpTransport;
  readonly now?: () => Date;
}

abstract class BaseOAuthPort implements OAuthProviderPort {
  protected readonly clientId: string;
  protected readonly transport: OAuthHttpTransport;
  protected readonly now: () => Date;

  constructor(options: OAuthProviderPortOptions) {
    this.clientId = options.clientId;
    this.transport = options.transport ?? createHttpsOAuthTransport();
    this.now = options.now ?? (() => new Date());
  }

  abstract authorizationUrl(input: {
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
    readonly scopes: readonly string[];
  }): string;

  protected abstract tokenEndpoint(): string;
  protected abstract identity(
    claims: Record<string, unknown>,
  ): OAuthAccountIdentity | null;
  protected revokeEndpoint(): string | null {
    return null;
  }

  protected async postToken(
    form: Readonly<Record<string, string>>,
  ): Promise<OAuthProviderResult<Record<string, unknown>>> {
    let response: { status: number; body: string };
    try {
      response = await this.transport({ url: this.tokenEndpoint(), form });
    } catch {
      return { ok: false, reason: 'provider_unreachable' };
    }
    if (response.status < 200 || response.status >= 300)
      return { ok: false, reason: 'provider_rejected' };
    const json = parseJson(response.body);
    return json === null
      ? { ok: false, reason: 'invalid_response' }
      : { ok: true, value: json };
  }

  protected tokensFrom(
    json: Record<string, unknown>,
  ): OAuthExchangedTokens | null {
    const accessToken = textOrNull(json['access_token']);
    if (accessToken === null) return null;
    const expiresIn = json['expires_in'];
    const expiresAt =
      typeof expiresIn === 'number' &&
      Number.isFinite(expiresIn) &&
      expiresIn > 0
        ? new Date(this.now().getTime() + expiresIn * 1000).toISOString()
        : null;
    const scope = textOrNull(json['scope']);
    return {
      access_token: accessToken,
      refresh_token: textOrNull(json['refresh_token']),
      expires_at: expiresAt,
      granted_scopes: scope === null ? [] : scope.split(' ').filter(Boolean),
    };
  }

  async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<OAuthProviderResult<OAuthTokenExchange>> {
    const posted = await this.postToken({
      client_id: this.clientId,
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    if (!posted.ok) return posted;
    const tokens = this.tokensFrom(posted.value);
    const idToken = textOrNull(posted.value['id_token']);
    if (tokens === null || idToken === null)
      return { ok: false, reason: 'invalid_response' };
    const claims = idTokenClaims(idToken);
    const account = claims === null ? null : this.identity(claims);
    if (account === null) return { ok: false, reason: 'invalid_response' };
    return { ok: true, value: { ...tokens, account } };
  }

  async refresh(input: {
    readonly refreshToken: string;
  }): Promise<OAuthProviderResult<OAuthExchangedTokens>> {
    // scope は送らない（認可時に得たスコープがそのまま使われる。Google・Microsoft 共通）。
    const posted = await this.postToken({
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    });
    if (!posted.ok) return posted;
    const tokens = this.tokensFrom(posted.value);
    return tokens === null
      ? { ok: false, reason: 'invalid_response' }
      : { ok: true, value: tokens };
  }

  async revoke(input: { readonly token: string }): Promise<void> {
    const endpoint = this.revokeEndpoint();
    if (endpoint === null) return;
    try {
      await this.transport({
        url: endpoint,
        form: { token: input.token, client_id: this.clientId },
      });
    } catch {
      // ベストエフォート。ローカルの削除が正本（ADR 0144）。
    }
  }
}

class GoogleOAuthPort extends BaseOAuthPort {
  authorizationUrl(input: {
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
    readonly scopes: readonly string[];
  }): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: input.scopes.join(' '),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      // 更新トークンを確実に得る（再認可でも毎回同意画面を出す）。
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  protected tokenEndpoint(): string {
    return 'https://oauth2.googleapis.com/token';
  }

  protected override revokeEndpoint(): string | null {
    return 'https://oauth2.googleapis.com/revoke';
  }

  protected identity(
    claims: Record<string, unknown>,
  ): OAuthAccountIdentity | null {
    const sub = textOrNull(claims['sub']);
    if (sub === null) return null;
    return {
      account_id: sub,
      email: textOrNull(claims['email']),
      display_name: textOrNull(claims['name']),
      tenant_id: null,
      account_kind: null,
    };
  }
}

const MICROSOFT_PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

class MicrosoftOAuthPort extends BaseOAuthPort {
  readonly #tenant: string;

  constructor(options: OAuthProviderPortOptions) {
    super(options);
    this.#tenant = options.tenant ?? 'common';
  }

  authorizationUrl(input: {
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
    readonly scopes: readonly string[];
  }): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: input.scopes.join(' '),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `https://login.microsoftonline.com/${this.#tenant}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  protected tokenEndpoint(): string {
    return `https://login.microsoftonline.com/${this.#tenant}/oauth2/v2.0/token`;
  }

  // 更新トークンの交換では scope を送らない（認可時に得たスコープがそのまま使われる）。

  protected identity(
    claims: Record<string, unknown>,
  ): OAuthAccountIdentity | null {
    // /me の id（Graph の readAccount の account_id）と一致する oid を正にする。
    const oid = textOrNull(claims['oid']) ?? textOrNull(claims['sub']);
    if (oid === null) return null;
    const tenantId = textOrNull(claims['tid']);
    return {
      account_id: oid,
      email:
        textOrNull(claims['preferred_username']) ?? textOrNull(claims['email']),
      display_name: textOrNull(claims['name']),
      tenant_id: tenantId,
      account_kind:
        tenantId === null
          ? null
          : tenantId === MICROSOFT_PERSONAL_TENANT
            ? 'personal'
            : 'work_or_school',
    };
  }
}

export function createGoogleOAuthPort(
  options: OAuthProviderPortOptions,
): OAuthProviderPort {
  return new GoogleOAuthPort(options);
}

export function createMicrosoftOAuthPort(
  options: OAuthProviderPortOptions,
): OAuthProviderPort {
  return new MicrosoftOAuthPort(options);
}
