// OAuth トークンの KeyStore（設計 02 保存と秘密情報・04、ADR 0010・0144）。
// 接続ごとのアクセストークン・リフレッシュトークンを、データ鍵と同じサービス名 `dev.buddy.core` の
// 別の項目（アカウント名 `oauth-v1:<connection_id>`）に JSON で置く。DB には項目名（credential_ref）だけを置き、
// トークン本体は DB・バックアップに入れない（ADR 0010）。バックアップの鍵と違い、トークンは更新のたびに
// 値が変わるのが正常なので、書込みは上書きを許し、読み戻して確かめる。
// macOS はキーチェーン、Windows は DPAPI（CurrentUser）で保護したファイル（ADR 0202）。Linux の中枢は初期版の対象外。
// 使えない・読めない・形式が不正なときは理由だけを返し、平文の保存へ切り替えない。
// トークンの値はログ・例外・結果の理由に入れない。
import { inspect } from 'node:util';
import { keychainSlotOpener, slotFailureReason } from './key-store.js';
import type {
  KeyStoreBackend,
  MacKeychainKeyStoreOptions,
  OsKeyStoreOptions,
  SecretSlot,
} from './key-store.js';
import { corePlatformOf } from './supervisor.js';
import { windowsDpapiSlotOpener } from './windows-dpapi.js';
import type { WindowsDpapiOptions } from './windows-dpapi.js';

const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** connections.credential_ref に置く、接続のトークン項目の名前。 */
export function oauthTokenAccount(connectionId: string): string {
  return `oauth-v1:${connectionId}`;
}

export type OAuthTokenStoreFailureReason =
  | 'keystore_module_unavailable'
  | 'dpapi_unavailable'
  | 'keystore_read_failed'
  | 'keystore_write_failed'
  | 'keystore_remove_failed'
  | 'oauth_connection_id_invalid'
  | 'oauth_token_missing'
  | 'oauth_token_format_invalid'
  // 書いた値を読み戻したら違った。
  | 'oauth_token_verify_failed'
  | 'linux_core_not_supported_in_initial_release'
  | 'platform_not_supported'
  | 'mock_unavailable';

/** 接続 1 件の OAuth トークン。値は JSON・inspect・文字列化で出さない。 */
export class OAuthTokens {
  readonly #accessToken: string;
  readonly #refreshToken: string | null;
  /** アクセストークンの失効時刻（ISO 8601）。プロバイダが返さなければ null。 */
  readonly expiresAt: string | null;
  /** 認可で得たスコープ（プロバイダの表記そのまま）。 */
  readonly grantedScopes: readonly string[];

  constructor(input: {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: string | null;
    grantedScopes: readonly string[];
  }) {
    if (typeof input.accessToken !== 'string' || input.accessToken.length === 0)
      throw new RangeError('access token must be a non-empty string');
    if (input.refreshToken !== null && typeof input.refreshToken !== 'string')
      throw new RangeError('refresh token must be a string or null');
    this.#accessToken = input.accessToken;
    this.#refreshToken = input.refreshToken;
    this.expiresAt = input.expiresAt;
    this.grantedScopes = [...input.grantedScopes];
  }

  get accessToken(): string {
    return this.#accessToken;
  }

  get refreshToken(): string | null {
    return this.#refreshToken;
  }

  /** KeyStore へ置く正準の JSON 表現。これ以外では値を外へ出さない。 */
  encode(): string {
    return JSON.stringify({
      v: 1,
      access_token: this.#accessToken,
      refresh_token: this.#refreshToken,
      expires_at: this.expiresAt,
      granted_scopes: [...this.grantedScopes],
    });
  }

  toJSON(): {
    accessToken: '[redacted]';
    refreshToken: '[redacted]' | null;
    expiresAt: string | null;
    grantedScopes: readonly string[];
  } {
    return {
      accessToken: '[redacted]',
      refreshToken: this.#refreshToken === null ? null : '[redacted]',
      expiresAt: this.expiresAt,
      grantedScopes: this.grantedScopes,
    };
  }

  toString(): string {
    return 'OAuthTokens([redacted])';
  }

  [inspect.custom](): string {
    return 'OAuthTokens { accessToken: [redacted], refreshToken: [redacted] }';
  }
}

function decodeTokens(stored: string): OAuthTokens | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return null;
  const record = parsed as Record<string, unknown>;
  if (record['v'] !== 1) return null;
  const accessToken = record['access_token'];
  const refreshToken = record['refresh_token'];
  const expiresAt = record['expires_at'];
  const grantedScopes = record['granted_scopes'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
  if (refreshToken !== null && typeof refreshToken !== 'string') return null;
  if (expiresAt !== null && typeof expiresAt !== 'string') return null;
  if (
    !Array.isArray(grantedScopes) ||
    !grantedScopes.every((scope) => typeof scope === 'string')
  )
    return null;
  return new OAuthTokens({
    accessToken,
    refreshToken: refreshToken as string | null,
    expiresAt: expiresAt as string | null,
    grantedScopes: grantedScopes as string[],
  });
}

export interface OAuthTokenFailure {
  readonly ok: false;
  readonly backend: KeyStoreBackend;
  readonly reason: OAuthTokenStoreFailureReason;
}

export type OAuthTokenResult =
  { readonly ok: true; readonly tokens: OAuthTokens } | OAuthTokenFailure;

export type OAuthTokenUnitResult = { readonly ok: true } | OAuthTokenFailure;

export interface OAuthTokenStore {
  readonly kind: 'os' | 'mock';
  readonly backend: KeyStoreBackend;
  /** トークンを読む。なければ oauth_token_missing（作らない）。 */
  read(connectionId: string): Promise<OAuthTokenResult>;
  /** トークンを置く（更新トークンの回転を含む上書き可）。置いた値を読み戻して確かめる。 */
  write(
    connectionId: string,
    tokens: OAuthTokens,
  ): Promise<OAuthTokenUnitResult>;
  /** トークンを消す（接続の解除・失効）。項目が無ければ成功として扱う。 */
  remove(connectionId: string): Promise<OAuthTokenUnitResult>;
}

export interface SlotOAuthTokenStoreOptions {
  readonly kind: 'os' | 'mock';
  readonly backend: Exclude<KeyStoreBackend, 'none'>;
  readonly openSlot: (account: string) => Promise<SecretSlot>;
  readonly unavailableReason: OAuthTokenStoreFailureReason;
}

/** 保護領域の項目の上に、OAuth トークンの KeyStore を作る。 */
export function createSlotOAuthTokenStore(
  options: SlotOAuthTokenStoreOptions,
): OAuthTokenStore {
  const { kind, backend, unavailableReason } = options;
  const fail = (reason: OAuthTokenStoreFailureReason): OAuthTokenFailure => ({
    ok: false,
    backend,
    reason,
  });
  const failUnit = (
    reason: OAuthTokenStoreFailureReason,
  ): OAuthTokenUnitResult => ({ ok: false, backend, reason });
  async function open(
    connectionId: string,
  ): Promise<SecretSlot | OAuthTokenFailure> {
    if (typeof connectionId !== 'string' || !CONNECTION_ID.test(connectionId))
      return fail('oauth_connection_id_invalid');
    try {
      return await options.openSlot(oauthTokenAccount(connectionId));
    } catch {
      return fail(unavailableReason);
    }
  }
  const isFailure = (
    value: SecretSlot | OAuthTokenFailure,
  ): value is OAuthTokenFailure => 'ok' in value;
  return {
    kind,
    backend,
    async read(connectionId) {
      const slot = await open(connectionId);
      if (isFailure(slot)) return slot;
      let stored: string | null;
      try {
        stored = await slot.read();
      } catch (error) {
        return fail(
          slotFailureReason(error, unavailableReason, 'keystore_read_failed'),
        );
      }
      if (stored === null) return fail('oauth_token_missing');
      const tokens = decodeTokens(stored);
      return tokens === null
        ? fail('oauth_token_format_invalid')
        : { ok: true, tokens };
    },
    async write(connectionId, tokens) {
      const slot = await open(connectionId);
      if (isFailure(slot)) return failUnit(slot.reason);
      const encoded = tokens.encode();
      try {
        await slot.write(encoded);
      } catch (error) {
        return failUnit(
          slotFailureReason(error, unavailableReason, 'keystore_write_failed'),
        );
      }
      let back: string | null;
      try {
        back = await slot.read();
      } catch (error) {
        return failUnit(
          slotFailureReason(error, unavailableReason, 'keystore_read_failed'),
        );
      }
      return back === encoded
        ? { ok: true }
        : failUnit('oauth_token_verify_failed');
    },
    async remove(connectionId) {
      const slot = await open(connectionId);
      if (isFailure(slot)) return failUnit(slot.reason);
      if (slot.remove === undefined) return failUnit(unavailableReason);
      try {
        await slot.remove();
      } catch (error) {
        return failUnit(
          slotFailureReason(error, unavailableReason, 'keystore_remove_failed'),
        );
      }
      return { ok: true };
    },
  };
}

/** macOS のキーチェーンの OAuth トークンの KeyStore。 */
export function createMacKeychainOAuthTokenStore(
  options: MacKeychainKeyStoreOptions = {},
): OAuthTokenStore {
  const openers = new Map<string, () => Promise<SecretSlot>>();
  return createSlotOAuthTokenStore({
    kind: 'os',
    backend: 'macos_keychain',
    unavailableReason: 'keystore_module_unavailable',
    openSlot(account) {
      let opener = openers.get(account);
      if (opener === undefined) {
        opener = keychainSlotOpener(account, options);
        openers.set(account, opener);
      }
      return opener();
    },
  });
}

/**
 * Windows の DPAPI（CurrentUser）の OAuth トークンの KeyStore（ADR 0202）。項目名はキーチェーンと同じ
 * `oauth-v1:<connection_id>`。資格情報マネージャーは 1 項目の大きさの上限が小さく、長いトークンが入らないため使わない。
 */
export function createWindowsDpapiOAuthTokenStore(
  options: WindowsDpapiOptions = {},
): OAuthTokenStore {
  return createSlotOAuthTokenStore({
    kind: 'os',
    backend: 'windows_dpapi',
    unavailableReason: 'dpapi_unavailable',
    openSlot: (account) => windowsDpapiSlotOpener(account, options)(),
  });
}

/** 中枢の鍵保護に対応しない OS（Linux など）。トークンを返さない・置かない。 */
export function createUnsupportedOAuthTokenStore(
  nodePlatform: string,
): OAuthTokenStore {
  const reason: OAuthTokenStoreFailureReason =
    corePlatformOf(nodePlatform) === 'linux'
      ? 'linux_core_not_supported_in_initial_release'
      : 'platform_not_supported';
  const failure: OAuthTokenResult = { ok: false, backend: 'none', reason };
  const failureUnit: OAuthTokenUnitResult = {
    ok: false,
    backend: 'none',
    reason,
  };
  return {
    kind: 'os',
    backend: 'none',
    read: () => Promise.resolve(failure),
    write: () => Promise.resolve(failureUnit),
    remove: () => Promise.resolve(failureUnit),
  };
}

export function createOAuthTokenStore(
  nodePlatform: string,
  options: OsKeyStoreOptions = {},
): OAuthTokenStore {
  switch (corePlatformOf(nodePlatform)) {
    case 'macos':
      return createMacKeychainOAuthTokenStore(options);
    case 'windows':
      return createWindowsDpapiOAuthTokenStore(options);
    default:
      return createUnsupportedOAuthTokenStore(nodePlatform);
  }
}

export interface MockOAuthTokenStoreOptions {
  /** false なら保護領域を開けない状態。 */
  readonly available?: boolean;
  /** 書込みを失敗させる。 */
  readonly writeFails?: boolean;
}

export interface MockOAuthTokenStore extends OAuthTokenStore {
  readonly kind: 'mock';
  /** 置かれている項目名の一覧（値は公開しない）。 */
  readonly accounts: () => readonly string[];
  /** 試験用: 項目の値を直接置き換える（形式不正の再現）。 */
  readonly overwrite: (connectionId: string, stored: string) => void;
}

/** 試験用の模擬。メモリ上だけで、実機のキーチェーンには触れない。 */
export function createMockOAuthTokenStore(
  options: MockOAuthTokenStoreOptions = {},
): MockOAuthTokenStore {
  const values = new Map<string, string>();
  const store = createSlotOAuthTokenStore({
    kind: 'mock',
    backend: 'mock',
    unavailableReason: 'mock_unavailable',
    openSlot(account) {
      if (options.available === false)
        return Promise.reject(new Error('mock oauth token store unavailable'));
      return Promise.resolve({
        read: () => Promise.resolve(values.get(account) ?? null),
        write(value) {
          if (options.writeFails === true)
            return Promise.reject(new Error('mock write failed'));
          values.set(account, value);
          return Promise.resolve();
        },
        remove() {
          values.delete(account);
          return Promise.resolve();
        },
      });
    },
  });
  return {
    ...store,
    kind: 'mock',
    accounts: () => [...values.keys()].sort(),
    overwrite: (connectionId, stored) => {
      values.set(oauthTokenAccount(connectionId), stored);
    },
  };
}
