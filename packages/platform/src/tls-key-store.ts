// 中枢の TLS の秘密鍵の KeyStore（設計 02 端末登録と接続・保存と秘密情報、ADR 0017・0020）。
// HTTPS の自己署名証明書の秘密鍵（ECDSA P-256）を OS の保護領域に置き、取得・初回作成する。
// 初期版の中枢は macOS だけで、データ鍵と同じサービス名 `dev.buddy.core` の別の項目
// （アカウント名 `tls-key-v1`）に、PKCS#8 の DER を正準の base64 で保存する。平文の鍵をディスクに置かない。
// 使えない・読めない・形式が不正なときは構造化した理由を返し、平文の保存へ切り替えない。
// 鍵の値（DER・PEM・base64）はログ・例外・結果の理由に入れない。
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { inspect } from 'node:util';
import { decodeCanonicalBase64, keychainSlotOpener } from './key-store.js';
import type {
  KeyStoreBackend,
  MacKeychainKeyStoreOptions,
  SecretSlot,
} from './key-store.js';
import { corePlatformOf } from './supervisor.js';

/** キーチェーンのアカウント名。鍵の世代を名前に持ち、個人情報を含まない。 */
export const TLS_KEY_ACCOUNT = 'tls-key-v1';
/** 秘密鍵の曲線（OpenSSL の名前）。NIST P-256。 */
export const TLS_KEY_CURVE = 'prime256v1';

export type TlsKeyStoreFailureReason =
  | 'keystore_module_unavailable'
  | 'keystore_read_failed'
  | 'keystore_write_failed'
  // 作成しない読み出しで、鍵がまだない。
  | 'tls_key_missing'
  // 保存値が正準の base64 でない、PKCS#8 の DER として読めない、P-256 の EC 鍵でない。
  | 'tls_key_format_invalid'
  // 作成した鍵を読み戻した値が書いた値と一致しない。
  | 'tls_key_verify_failed'
  | 'windows_core_not_supported_in_initial_release'
  | 'linux_core_not_supported_in_initial_release'
  | 'platform_not_supported'
  | 'mock_unavailable';

/**
 * TLS の秘密鍵。鍵の値は JSON・inspect・文字列化で出さない。
 * JavaScript ではメモリ上の鍵の消去を保証できない（ADR 0017）。
 */
export class TlsPrivateKey {
  readonly #key: KeyObject;

  constructor(key: KeyObject) {
    if (!isP256PrivateKey(key))
      throw new TypeError('tls key must be an ECDSA P-256 private key');
    this.#key = key;
  }

  /** 署名に使う KeyObject（変更できない値）。 */
  get keyObject(): KeyObject {
    return this.#key;
  }

  publicKey(): KeyObject {
    return createPublicKey(this.#key);
  }

  /** TLS の設定（tls.createSecureContext）に渡す PKCS#8 の PEM。メモリ上だけで使い、保存しない。 */
  toPkcs8Pem(): string {
    return this.#key.export({ type: 'pkcs8', format: 'pem' }).toString();
  }

  toJSON(): { key: '[redacted]' } {
    return { key: '[redacted]' };
  }

  toString(): string {
    return 'TlsPrivateKey([redacted])';
  }

  [inspect.custom](): string {
    return 'TlsPrivateKey { key: [redacted] }';
  }
}

function isP256PrivateKey(key: KeyObject): boolean {
  return (
    key.type === 'private' &&
    key.asymmetricKeyType === 'ec' &&
    key.asymmetricKeyDetails?.namedCurve === TLS_KEY_CURVE
  );
}

/** 保存値（PKCS#8 の DER の正準の base64）を読む。理由だけを返し、値は返さない。 */
export function decodeStoredTlsKey(
  stored: string,
):
  | { readonly ok: true; readonly key: TlsPrivateKey }
  | { readonly ok: false; readonly reason: 'tls_key_format_invalid' } {
  const der = decodeCanonicalBase64(stored);
  if (der === null) return { ok: false, reason: 'tls_key_format_invalid' };
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch {
    return { ok: false, reason: 'tls_key_format_invalid' };
  }
  if (!isP256PrivateKey(key))
    return { ok: false, reason: 'tls_key_format_invalid' };
  return { ok: true, key: new TlsPrivateKey(key) };
}

export type TlsKeyResult =
  | {
      readonly ok: true;
      readonly backend: Exclude<KeyStoreBackend, 'none'>;
      readonly privateKey: TlsPrivateKey;
      /** この呼び出しで鍵を作成したか。 */
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly backend: KeyStoreBackend;
      readonly reason: TlsKeyStoreFailureReason;
    };

export interface TlsKeyStore {
  /** 'os' は実機の保護領域、'mock' は試験用の模擬。 */
  readonly kind: 'os' | 'mock';
  readonly backend: KeyStoreBackend;
  /** 既存の秘密鍵を読む。なければ tls_key_missing（作成しない）。 */
  loadTlsKey(): Promise<TlsKeyResult>;
  /**
   * 既存の秘密鍵を読み、なければ P-256 の鍵を作成して保存し、読み戻して確かめる。
   * 既存の値が不正なときは上書きしない。
   */
  loadOrCreateTlsKey(): Promise<TlsKeyResult>;
}

export interface SlotTlsKeyStoreOptions {
  readonly kind: 'os' | 'mock';
  readonly backend: Exclude<KeyStoreBackend, 'none'>;
  readonly openSlot: () => Promise<SecretSlot>;
  readonly unavailableReason: TlsKeyStoreFailureReason;
}

/** 保護領域の項目の上に TlsKeyStore を作る。鍵の作成・形式の検査・読み戻しはここだけで行う。 */
export function createSlotTlsKeyStore(
  options: SlotTlsKeyStoreOptions,
): TlsKeyStore {
  const { kind, backend, unavailableReason } = options;
  const fail = (reason: TlsKeyStoreFailureReason): TlsKeyResult => ({
    ok: false,
    backend,
    reason,
  });

  async function load(create: boolean): Promise<TlsKeyResult> {
    let slot: SecretSlot;
    try {
      slot = await options.openSlot();
    } catch {
      return fail(unavailableReason);
    }
    let stored: string | null;
    try {
      stored = await slot.read();
    } catch {
      return fail('keystore_read_failed');
    }
    if (stored !== null) {
      if (typeof stored !== 'string') return fail('tls_key_format_invalid');
      const decoded = decodeStoredTlsKey(stored);
      if (!decoded.ok) return fail(decoded.reason);
      return { ok: true, backend, privateKey: decoded.key, created: false };
    }
    if (!create) return fail('tls_key_missing');
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: TLS_KEY_CURVE,
    });
    const encoded = privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64');
    try {
      await slot.write(encoded);
    } catch {
      return fail('keystore_write_failed');
    }
    // 書いた値を読み戻し、保護領域から同じ鍵を取得できることを確かめてから使う。
    let readBack: string | null;
    try {
      readBack = await slot.read();
    } catch {
      return fail('keystore_read_failed');
    }
    if (readBack !== encoded) return fail('tls_key_verify_failed');
    return {
      ok: true,
      backend,
      privateKey: new TlsPrivateKey(privateKey),
      created: true,
    };
  }

  return {
    kind,
    backend,
    loadTlsKey: () => load(false),
    loadOrCreateTlsKey: () => load(true),
  };
}

/** macOS のキーチェーンの TlsKeyStore（サービス名 `dev.buddy.core`・アカウント名 `tls-key-v1`）。 */
export function createMacKeychainTlsKeyStore(
  options: MacKeychainKeyStoreOptions = {},
): TlsKeyStore {
  return createSlotTlsKeyStore({
    kind: 'os',
    backend: 'macos_keychain',
    unavailableReason: 'keystore_module_unavailable',
    openSlot: keychainSlotOpener(TLS_KEY_ACCOUNT, options),
  });
}

/** 初期版で中枢の鍵保護に対応しない OS の TlsKeyStore。鍵を返さない。 */
export function createUnsupportedTlsKeyStore(
  nodePlatform: string,
): TlsKeyStore {
  const platform = corePlatformOf(nodePlatform);
  const reason: TlsKeyStoreFailureReason =
    platform === 'windows'
      ? 'windows_core_not_supported_in_initial_release'
      : platform === 'linux'
        ? 'linux_core_not_supported_in_initial_release'
        : 'platform_not_supported';
  const result: TlsKeyResult = { ok: false, backend: 'none', reason };
  return {
    kind: 'os',
    backend: 'none',
    loadTlsKey: () => Promise.resolve(result),
    loadOrCreateTlsKey: () => Promise.resolve(result),
  };
}

/** 実行中の OS に合う TlsKeyStore（Core では process.platform を渡す）。 */
export function createTlsKeyStore(
  nodePlatform: string,
  options: MacKeychainKeyStoreOptions = {},
): TlsKeyStore {
  return corePlatformOf(nodePlatform) === 'macos'
    ? createMacKeychainTlsKeyStore(options)
    : createUnsupportedTlsKeyStore(nodePlatform);
}

export interface MockTlsKeyStoreOptions {
  /** false なら保護領域を開けない状態（reason は mock_unavailable）。省略時は true。 */
  readonly available?: boolean;
  /** 最初に保存されている値（PKCS#8 の DER の base64）。省略時は空（鍵なし）。 */
  readonly stored?: string | null;
  readonly readFails?: boolean;
  readonly writeFails?: boolean;
  /** 書込みの後の読み出しで、書いた値と違う値を返す（並行した作成の再現）。 */
  readonly readBackDiffers?: boolean;
}

/** 試験用の模擬の TlsKeyStore。メモリ上の 1 項目に保存し、実機のキーチェーンには触れない。 */
export interface MockTlsKeyStore extends TlsKeyStore {
  readonly kind: 'mock';
  /** 書込みの回数。 */
  readonly writes: number;
  /** 保存されている値があるか（値そのものは公開しない）。 */
  readonly hasStoredValue: boolean;
}

export function createMockTlsKeyStore(
  options: MockTlsKeyStoreOptions = {},
): MockTlsKeyStore {
  let stored: string | null = options.stored ?? null;
  let writes = 0;
  const store = createSlotTlsKeyStore({
    kind: 'mock',
    backend: 'mock',
    unavailableReason: 'mock_unavailable',
    openSlot() {
      if (options.available === false)
        return Promise.reject(new Error('mock tls key store unavailable'));
      return Promise.resolve({
        read() {
          if (options.readFails === true)
            return Promise.reject(new Error('mock read failed'));
          if (options.readBackDiffers === true && writes > 0)
            return Promise.resolve('AAAA');
          return Promise.resolve(stored);
        },
        write(value) {
          if (options.writeFails === true)
            return Promise.reject(new Error('mock write failed'));
          writes += 1;
          stored = value;
          return Promise.resolve();
        },
      });
    },
  });
  return {
    ...store,
    kind: 'mock',
    get writes() {
      return writes;
    },
    get hasStoredValue() {
      return stored !== null;
    },
  };
}
