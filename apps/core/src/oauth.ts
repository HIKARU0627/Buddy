// 接続の作成・OAuth・トークンの出所（B03-04、ADR 0144。設計 04・06・11 §1A、ADR 0009・0010）。
//
// - 認可の開始（startOAuth）は契約どおり中枢の画面操作（screen＋hub_screen）で、認可 URL と失効時刻だけを返す。
//   認可コードの戻りは /v1 の外のループバック受付（oauth-callback-server.ts）が受け、ここで交換・接続の作成まで行う。
// - アカウント識別（account_id 等）はデータ鍵で封をして sealed_blobs（用途 connection_account）に置く。
//   トークン本体は OS の KeyStore（@buddy/platform の OAuthTokenStore）にだけ置き、DB・ログ・応答に入れない。
// - すでに同じアカウントの接続があれば作り直さず再認可として更新する（対象・取得集合・版は触らない）。
//   切断済みの接続は再認可では戻さず、新しい接続を作る。
// - 実行器向けのトークンの出所は、失効が近ければ更新トークンで取り直し、恒常的に失敗したら接続を
//   needs_reauth に落とす。スケジューラ向けの対象（targetsFor）は封筒から account_id を復元し、
//   取得集合の ID の規約（scope:<connection_id>:<resource>）で資源種別と結び付ける。
// ログには経路・結果コードだけを出す（アカウント識別・トークン・認可コードは出さない）。

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { initialFetchScope } from '@buddy/domain';
import type { OAuthTokenStore } from '@buddy/platform';
import { OAuthTokens, oauthTokenAccount } from '@buddy/platform';
import type {
  ConnectionRecord,
  DataKeyMaterial,
  DataKeyProvider,
  DbWorkerClient,
  SealedBlobInput,
} from '@buddy/storage';
import { openBlob, sealBlob } from '@buddy/storage';
import { connectionSummary } from './api-connections.js';
import { apiErrorResponse } from './api-server.js';
import type { ApiRouteHandler } from './api-server.js';
import type { JsonObject } from './strict-json.js';
import {
  oauthScopes,
  type OAuthAccountIdentity,
  type OAuthProviderName,
  type OAuthProviderPort,
} from './oauth-provider.js';
import type { SyncSchedulerTarget } from './sync-scheduler.js';

export interface OAuthProviderConfig {
  readonly port: OAuthProviderPort;
}

export interface OAuthServiceOptions {
  readonly store: Pick<DbWorkerClient, 'connectionTargets'>;
  readonly keyStore: DataKeyProvider;
  readonly tokenStore: OAuthTokenStore;
  readonly providers: Readonly<
    Partial<Record<OAuthProviderName, OAuthProviderConfig>>
  >;
  /** ループバックの戻り先（http://127.0.0.1:<port>/oauth/callback）。 */
  readonly redirectUri: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly random?: (size: number) => Buffer;
  readonly log?: (message: string) => void;
}

export type OAuthCallbackOutcome =
  | { readonly kind: 'connected'; readonly provider: OAuthProviderName }
  | {
      readonly kind: 'failed';
      readonly reason:
        | 'provider_denied'
        | 'state_invalid'
        | 'exchange_failed'
        | 'token_store_failed'
        | 'store_failed';
    };

export interface OAuthService {
  readonly handlers: {
    readonly startOAuth: ApiRouteHandler;
    readonly disconnectConnection: ApiRouteHandler;
  };
  /** ループバックの戻り（GET のクエリ）を処理する。応答の文面は受付側が作る。 */
  handleCallback(query: URLSearchParams): Promise<OAuthCallbackOutcome>;
  /** Google の実行器向けのトークンの出所。Google の接続でなければ null。 */
  googleTokenSourceFor(
    connection: ConnectionRecord,
  ): { getAccessToken(): Promise<string> } | null;
  /** Microsoft Graph の実行器向けのトークンの出所。Microsoft の接続でなければ null。 */
  graphTokenSourceFor(
    connection: ConnectionRecord,
  ): (() => Promise<string>) | null;
  /** スケジューラ向けの走査対象。封筒が開けなければ空（走査しない）。 */
  targetsFor(
    connection: ConnectionRecord,
  ): Promise<readonly SyncSchedulerTarget[]>;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;

interface PendingAuthorization {
  readonly provider: OAuthProviderName;
  readonly access: 'read' | 'read_write';
  readonly codeVerifier: string;
  readonly expiresAt: number;
}

interface AccountIdentityPayload extends OAuthAccountIdentity {
  readonly v: 1;
}

export function oauthScopeId(
  connectionId: string,
  resource: 'mail' | 'calendar',
): string {
  return `scope:${connectionId}:${resource}`;
}

const INBOX_CONTAINER: Readonly<Record<OAuthProviderName, string>> = {
  google: 'INBOX',
  microsoft: 'inbox',
};

export function createOAuthService(options: OAuthServiceOptions): OAuthService {
  const { store, tokenStore } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const random = options.random ?? ((size: number) => randomBytes(size));
  const log = options.log ?? (() => undefined);
  const pending = new Map<string, PendingAuthorization>();
  // targetsFor の封筒の開封結果（許可版が変わったら読み直す）。
  const identityCache = new Map<
    string,
    { readonly permission_revision: string; readonly account_id: string }
  >();

  const loadKey = async (): Promise<DataKeyMaterial | null> => {
    try {
      const result = await options.keyStore.loadDataKey();
      return result.ok ? result.dataKey : null;
    } catch {
      return null;
    }
  };

  function sealIdentity(
    key: DataKeyMaterial,
    connectionId: string,
    identity: OAuthAccountIdentity,
  ): SealedBlobInput | null {
    const payload: AccountIdentityPayload = { v: 1, ...identity };
    const sealed = sealBlob(key, Buffer.from(JSON.stringify(payload), 'utf8'), {
      ownerTable: 'connections',
      ownerId: connectionId,
      ownerVersion: 0,
      purpose: 'connection_account',
    });
    if (!sealed.ok) return null;
    return {
      blob_id: newId(),
      format_version: sealed.envelope.formatVersion,
      key_id: sealed.envelope.keyId,
      nonce: sealed.envelope.nonce,
      ciphertext: sealed.envelope.ciphertext,
      tag: sealed.envelope.tag,
    };
  }

  async function openIdentity(
    connectionId: string,
  ): Promise<OAuthAccountIdentity | null> {
    const blob = await store.connectionTargets({
      kind: 'connections.account_blob',
      connection_id: connectionId,
    });
    if (!blob.ok || blob.value === null) return null;
    const key = await loadKey();
    if (key === null) return null;
    const opened = openBlob(
      key,
      {
        formatVersion: blob.value.format_version,
        keyId: blob.value.key_id,
        nonce: blob.value.nonce,
        ciphertext: blob.value.ciphertext,
        tag: blob.value.tag,
      },
      {
        ownerTable: 'connections',
        ownerId: connectionId,
        ownerVersion: 0,
        purpose: 'connection_account',
      },
    );
    if (!opened.ok) return null;
    try {
      const parsed = JSON.parse(
        opened.plaintext.toString('utf8'),
      ) as AccountIdentityPayload;
      if (parsed.v !== 1 || typeof parsed.account_id !== 'string') return null;
      return {
        account_id: parsed.account_id,
        email: parsed.email ?? null,
        display_name: parsed.display_name ?? null,
        tenant_id: parsed.tenant_id ?? null,
        account_kind: parsed.account_kind ?? null,
      };
    } catch {
      return null;
    }
  }

  const startOAuth: ApiRouteHandler = async (request) => {
    const body = request.body as JsonObject;
    const requestId =
      typeof body['request_id'] === 'string' ? body['request_id'] : '';
    const provider = body['provider'] as OAuthProviderName;
    const access = body['access'] as 'read' | 'read_write';
    const config = options.providers[provider];
    // プロバイダの設定が無い、または戻り先を開かない構成では、認可を開始できない。
    if (config === undefined || options.redirectUri === '')
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const state = random(32).toString('base64url');
    const codeVerifier = random(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const expiresAt = now().getTime() + PENDING_TTL_MS;
    // 同じプロバイダの古い認可待ちは置き換える（state は 1 回だけ有効）。
    for (const [key, value] of pending) {
      if (value.provider === provider || value.expiresAt <= now().getTime())
        pending.delete(key);
    }
    pending.set(state, { provider, access, codeVerifier, expiresAt });
    const authorizationUrl = config.port.authorizationUrl({
      redirectUri: options.redirectUri,
      state,
      codeChallenge,
      scopes: oauthScopes(provider, access),
    });
    return {
      status: 200,
      body: {
        authorization_url: authorizationUrl,
        expires_at: new Date(expiresAt).toISOString(),
      },
    };
  };

  async function completeAuthorization(
    entry: PendingAuthorization,
    code: string,
  ): Promise<OAuthCallbackOutcome> {
    const config = options.providers[entry.provider];
    if (config === undefined)
      return { kind: 'failed', reason: 'exchange_failed' };
    const exchanged = await config.port.exchangeCode({
      code,
      codeVerifier: entry.codeVerifier,
      redirectUri: options.redirectUri,
    });
    if (!exchanged.ok) {
      log(
        `OAuth の交換に失敗しました（${entry.provider}: ${exchanged.reason}）`,
      );
      return { kind: 'failed', reason: 'exchange_failed' };
    }
    const { account } = exchanged.value;
    const tokens = new OAuthTokens({
      accessToken: exchanged.value.access_token,
      refreshToken: exchanged.value.refresh_token,
      expiresAt: exchanged.value.expires_at,
      grantedScopes: exchanged.value.granted_scopes,
    });
    const grantedScopes =
      exchanged.value.granted_scopes.length > 0
        ? exchanged.value.granted_scopes
        : oauthScopes(entry.provider, entry.access);

    // 同じアカウントの既存の接続を探す（切断済みは対象にしない＝作り直す）。
    const listed = await store.connectionTargets({ kind: 'connections.list' });
    if (!listed.ok) return { kind: 'failed', reason: 'store_failed' };
    for (const connection of listed.value) {
      if (connection.provider !== entry.provider) continue;
      if (connection.status === 'disconnected') continue;
      const identity = await openIdentity(connection.connection_id);
      if (identity === null || identity.account_id !== account.account_id)
        continue;
      // 再認可: トークンを置き換えてから、接続を active に戻す。対象・取得集合は触らない。
      const written = await tokenStore.write(connection.connection_id, tokens);
      if (!written.ok) {
        log(`OAuth トークンの保存に失敗しました（${written.reason}）`);
        return { kind: 'failed', reason: 'token_store_failed' };
      }
      const reactivated = await store.connectionTargets({
        kind: 'connections.reactivate',
        connection_id: connection.connection_id,
        credential_ref: oauthTokenAccount(connection.connection_id),
        access: entry.access,
        granted_scopes: grantedScopes,
      });
      if (!reactivated.ok) {
        return { kind: 'failed', reason: 'store_failed' };
      }
      identityCache.delete(connection.connection_id);
      log(`接続を再認可しました（${entry.provider}）`);
      return { kind: 'connected', provider: entry.provider };
    }

    // 新しい接続。トークンを先に置き、失敗したら接続を作らない。
    const connectionId = `conn-${newId()}`;
    const written = await tokenStore.write(connectionId, tokens);
    if (!written.ok) {
      log(`OAuth トークンの保存に失敗しました（${written.reason}）`);
      return { kind: 'failed', reason: 'token_store_failed' };
    }
    const key = await loadKey();
    const sealed =
      key === null ? null : sealIdentity(key, connectionId, account);
    if (sealed === null) {
      await tokenStore.remove(connectionId).catch(() => undefined);
      return { kind: 'failed', reason: 'store_failed' };
    }
    const scope = initialFetchScope(INBOX_CONTAINER[entry.provider]);
    const created = await store.connectionTargets({
      kind: 'connections.create',
      connection_id: connectionId,
      provider: entry.provider,
      created_at: now().getTime(),
      account: sealed,
      credential_ref: oauthTokenAccount(connectionId),
      access: entry.access,
      granted_scopes: grantedScopes,
      targets: {
        calendar_ids: [...scope.calendarIds],
        mail_container_ids: [...scope.mailContainerIds],
        attachment_kinds: [...scope.attachmentKinds],
        mail_lookback_days: scope.mailLookbackDays,
        calendar_past_days: scope.calendarPastDays,
        calendar_future_days: scope.calendarFutureDays,
        attachment_max_bytes: scope.attachmentMaxBytes,
      },
      scopes: [
        { scope_id: oauthScopeId(connectionId, 'mail'), resource: 'mail' },
        {
          scope_id: oauthScopeId(connectionId, 'calendar'),
          resource: 'calendar',
        },
      ],
    });
    if (!created.ok) {
      await tokenStore.remove(connectionId).catch(() => undefined);
      log(`接続の作成に失敗しました（${created.reasons.join(', ')}）`);
      return { kind: 'failed', reason: 'store_failed' };
    }
    log(`接続を作成しました（${entry.provider}）`);
    return { kind: 'connected', provider: entry.provider };
  }

  async function handleCallback(
    query: URLSearchParams,
  ): Promise<OAuthCallbackOutcome> {
    if (query.get('error') !== null)
      return { kind: 'failed', reason: 'provider_denied' };
    const state = query.get('state');
    const code = query.get('code');
    if (state === null || code === null)
      return { kind: 'failed', reason: 'state_invalid' };
    const entry = pending.get(state);
    pending.delete(state);
    if (entry === undefined || entry.expiresAt <= now().getTime())
      return { kind: 'failed', reason: 'state_invalid' };
    return completeAuthorization(entry, code);
  }

  const disconnectConnection: ApiRouteHandler = async (request) => {
    const body = request.body as JsonObject;
    const requestId =
      typeof body['request_id'] === 'string' ? body['request_id'] : '';
    const connectionId = request.params['connection_id'] ?? '';
    const result = await store.connectionTargets({
      kind: 'connections.disconnect',
      connection_id: connectionId,
      expected_permission_revision:
        typeof body['expected_permission_revision'] === 'string'
          ? body['expected_permission_revision']
          : '',
    });
    if (!result.ok) {
      if (
        result.outcome === 'rejected' &&
        result.reasons.every(
          (reason) =>
            reason === 'permission_revision_mismatch' ||
            reason === 'connection_not_found' ||
            reason === 'connection_disconnected',
        )
      )
        return apiErrorResponse(409, 'conflict', requestId);
      if (result.reasons.includes('connection_id_invalid'))
        return apiErrorResponse(422, 'invalid_input', requestId);
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    }
    // 後処理（ベストエフォート）: プロバイダ側の失効と KeyStore の削除。失敗しても切断は成立している。
    try {
      const stored = await tokenStore.read(connectionId);
      if (stored.ok) {
        const config = options.providers[result.value.connection.provider];
        if (config !== undefined) {
          await config.port.revoke({
            token: stored.tokens.refreshToken ?? stored.tokens.accessToken,
          });
        }
      }
      await tokenStore.remove(connectionId);
    } catch {
      log('切断の後処理（トークンの削除）に失敗しました');
    }
    identityCache.delete(connectionId);
    return { status: 200, body: connectionSummary(result.value.connection) };
  };

  async function accessTokenFor(connection: ConnectionRecord): Promise<string> {
    const stored = await tokenStore.read(connection.connection_id);
    if (!stored.ok) {
      // 資格情報が無い active な接続は、再認可が必要な状態として記録する。
      if (connection.status === 'active') {
        await store
          .connectionTargets({
            kind: 'connections.mark_needs_reauth',
            connection_id: connection.connection_id,
          })
          .catch(() => undefined);
      }
      throw new Error('oauth_token_unavailable');
    }
    const tokens = stored.tokens;
    const expiresAt =
      tokens.expiresAt === null ? null : Date.parse(tokens.expiresAt);
    if (expiresAt === null || expiresAt - now().getTime() > REFRESH_MARGIN_MS)
      return tokens.accessToken;
    // 失効が近い・過ぎている: 更新トークンで取り直す。
    if (tokens.refreshToken === null)
      throw new Error('oauth_token_unavailable');
    const config = options.providers[connection.provider];
    if (config === undefined) throw new Error('oauth_token_unavailable');
    const refreshed = await config.port.refresh({
      refreshToken: tokens.refreshToken,
    });
    if (!refreshed.ok) {
      if (refreshed.reason === 'provider_rejected') {
        // 恒常的な失敗（invalid_grant 等）。接続を再認可待ちに落とす。
        await store
          .connectionTargets({
            kind: 'connections.mark_needs_reauth',
            connection_id: connection.connection_id,
          })
          .catch(() => undefined);
      }
      throw new Error('oauth_token_unavailable');
    }
    const next = new OAuthTokens({
      accessToken: refreshed.value.access_token,
      // 新しい更新トークンが返らなければ旧値を保つ（Google の通常の応答）。
      refreshToken: refreshed.value.refresh_token ?? tokens.refreshToken,
      expiresAt: refreshed.value.expires_at,
      grantedScopes:
        refreshed.value.granted_scopes.length > 0
          ? refreshed.value.granted_scopes
          : tokens.grantedScopes,
    });
    const written = await tokenStore.write(connection.connection_id, next);
    if (!written.ok) throw new Error('oauth_token_unavailable');
    return next.accessToken;
  }

  return {
    handlers: { startOAuth, disconnectConnection },
    handleCallback,
    googleTokenSourceFor(connection) {
      if (connection.provider !== 'google') return null;
      return { getAccessToken: () => accessTokenFor(connection) };
    },
    graphTokenSourceFor(connection) {
      if (connection.provider !== 'microsoft') return null;
      return () => accessTokenFor(connection);
    },
    async targetsFor(connection) {
      if (connection.status === 'disconnected') return [];
      const cached = identityCache.get(connection.connection_id);
      let accountId: string;
      if (
        cached !== undefined &&
        cached.permission_revision === connection.permission_revision
      ) {
        accountId = cached.account_id;
      } else {
        const identity = await openIdentity(connection.connection_id);
        if (identity === null) return [];
        accountId = identity.account_id;
        identityCache.set(connection.connection_id, {
          permission_revision: connection.permission_revision,
          account_id: accountId,
        });
      }
      // Microsoft はメールの読み取りだけを持つ（Graph に予定の読み取りは無い）ので、予定の対象は返さない。
      // 取得集合の行は作成時に両方あるが、スケジューラは対象に無い取得集合を走査しない。
      const targets: SyncSchedulerTarget[] = [
        {
          account_id: accountId,
          scope_id: oauthScopeId(connection.connection_id, 'mail'),
          resource: 'mail',
        },
      ];
      if (connection.provider === 'google') {
        targets.push({
          account_id: accountId,
          scope_id: oauthScopeId(connection.connection_id, 'calendar'),
          resource: 'calendar',
        });
      }
      return targets;
    },
  };
}
