// 中枢のデータ鍵の KeyStore（設計 02 保存と秘密情報・03・08 §5、ADR 0017）。
// データ鍵（AES-256-GCM の 32 バイトの鍵）を OS の保護領域に置き、取得・初回作成する。
// 初期版の中枢は macOS だけで、キーチェーンに @napi-rs/keyring で保存する。
// 使えない・読めない・形式が不正なときは構造化した理由を返し、平文の保存へ切り替えない。
// 鍵の値（バイト列・base64）はログ・例外・結果の理由に入れない。
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { corePlatformOf } from './supervisor.js';

/** キーチェーンのサービス名。個人情報を含まない固定の汎用名（LaunchAgent の Label と同じ）。 */
export const KEY_STORE_SERVICE = 'dev.buddy.core';
/** キーチェーンのアカウント名。鍵の世代を名前に持ち、個人情報を含まない。 */
export const DATA_KEY_ACCOUNT = 'data-key-v1';
/** sealed_blobs.key_id に入れる鍵の識別子。鍵の値から導かない固定の名前。 */
export const DATA_KEY_ID = 'data-key-v1';
/** AES-256 の鍵の長さ（バイト）。 */
export const DATA_KEY_BYTES = 32;

export type KeyStoreBackend = 'macos_keychain' | 'none' | 'mock';

export type KeyStoreFailureReason =
  // ネイティブモジュール（@napi-rs/keyring）を読み込めない。
  | 'keystore_module_unavailable'
  // 保護領域の読み出しに失敗した（ロック中・アクセスの拒否など）。
  | 'keystore_read_failed'
  // 保護領域への書込みに失敗した。
  | 'keystore_write_failed'
  // 作成しない読み出しで、鍵がまだない。
  | 'data_key_missing'
  // 保存値が正準の base64 でない。
  | 'data_key_format_invalid'
  // 保存値を復号した長さが 32 バイトでない。
  | 'data_key_length_invalid'
  // 作成した鍵を読み戻した値が書いた値と一致しない（並行した作成など）。
  | 'data_key_verify_failed'
  | 'windows_core_not_supported_in_initial_release'
  | 'linux_core_not_supported_in_initial_release'
  | 'platform_not_supported'
  // 模擬の KeyStore が使えない状態。
  | 'mock_unavailable';

/**
 * データ鍵。鍵の値は JSON・inspect・文字列化で出さない。
 * `key` は呼び出しごとに複製を返す（受け取った側が書き換えても保持している値は変わらない）。
 * JavaScript ではメモリ上の鍵の消去を保証できない（ADR 0017）。
 */
export class DataKey {
  readonly keyId: string;
  readonly #bytes: Buffer;

  constructor(keyId: string, bytes: Uint8Array) {
    if (bytes.length !== DATA_KEY_BYTES)
      throw new RangeError('data key must be 32 bytes');
    this.keyId = keyId;
    this.#bytes = Buffer.from(bytes);
  }

  get key(): Buffer {
    return Buffer.from(this.#bytes);
  }

  toJSON(): { keyId: string; key: '[redacted]' } {
    return { keyId: this.keyId, key: '[redacted]' };
  }

  toString(): string {
    return `DataKey(${this.keyId})`;
  }

  [inspect.custom](): string {
    return `DataKey { keyId: '${this.keyId}', key: [redacted] }`;
  }
}

export type DataKeyResult =
  | {
      readonly ok: true;
      readonly backend: Exclude<KeyStoreBackend, 'none'>;
      readonly dataKey: DataKey;
      /** この呼び出しで鍵を作成したか。 */
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly backend: KeyStoreBackend;
      readonly reason: KeyStoreFailureReason;
    };

export interface KeyStore {
  /** 'os' は実機の保護領域、'mock' は試験用の模擬。 */
  readonly kind: 'os' | 'mock';
  readonly backend: KeyStoreBackend;
  /** 既存のデータ鍵を読む。なければ data_key_missing（作成しない）。 */
  loadDataKey(): Promise<DataKeyResult>;
  /**
   * 既存のデータ鍵を読み、なければ 32 バイトの暗号論的乱数で作成して保存し、読み戻して確かめる。
   * 既存の値が不正なときは上書きしない（既存の暗号文を読めなくしないため）。
   */
  loadOrCreateDataKey(): Promise<DataKeyResult>;
}

/** 保護領域の 1 項目（サービス名・アカウント名の組）の読み書き。KeyStore の内部の境界。 */
export interface SecretSlot {
  /** 値がなければ null。読めなければ例外。 */
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/**
 * 保存値（base64）を検査して鍵のバイト列にする。正準の base64（空白・改行・URL 用の文字・余分な桁を含まない）だけを受け入れる。
 * 理由だけを返し、値は返さない。
 */
export function decodeStoredDataKey(stored: string):
  | { readonly ok: true; readonly bytes: Buffer }
  | {
      readonly ok: false;
      readonly reason: 'data_key_format_invalid' | 'data_key_length_invalid';
    } {
  if (stored.length === 0 || !BASE64.test(stored))
    return { ok: false, reason: 'data_key_format_invalid' };
  const bytes = Buffer.from(stored, 'base64');
  // 末尾の桁の未使用ビットが 0 でない値は、同じバイト列の別表記なので拒否する。
  if (bytes.toString('base64') !== stored)
    return { ok: false, reason: 'data_key_format_invalid' };
  if (bytes.length !== DATA_KEY_BYTES)
    return { ok: false, reason: 'data_key_length_invalid' };
  return { ok: true, bytes };
}

export interface SlotKeyStoreOptions {
  readonly kind: 'os' | 'mock';
  readonly backend: Exclude<KeyStoreBackend, 'none'>;
  /** 保護領域の項目を開く。開けなければ例外（遅延読み込みの失敗など）。 */
  readonly openSlot: () => Promise<SecretSlot>;
  /** openSlot が失敗したときの理由。 */
  readonly unavailableReason: KeyStoreFailureReason;
  readonly keyId?: string;
}

/** 保護領域の項目の上に KeyStore を作る。鍵の作成・形式の検査・読み戻しはここだけで行う。 */
export function createSlotKeyStore(options: SlotKeyStoreOptions): KeyStore {
  const { kind, backend, unavailableReason } = options;
  const keyId = options.keyId ?? DATA_KEY_ID;
  const fail = (reason: KeyStoreFailureReason): DataKeyResult => ({
    ok: false,
    backend,
    reason,
  });

  async function load(create: boolean): Promise<DataKeyResult> {
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
      if (typeof stored !== 'string') return fail('data_key_format_invalid');
      const decoded = decodeStoredDataKey(stored);
      if (!decoded.ok) return fail(decoded.reason);
      return {
        ok: true,
        backend,
        dataKey: new DataKey(keyId, decoded.bytes),
        created: false,
      };
    }
    if (!create) return fail('data_key_missing');
    const bytes = randomBytes(DATA_KEY_BYTES);
    const encoded = bytes.toString('base64');
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
    if (readBack !== encoded) return fail('data_key_verify_failed');
    return {
      ok: true,
      backend,
      dataKey: new DataKey(keyId, bytes),
      created: true,
    };
  }

  return {
    kind,
    backend,
    loadDataKey: () => load(false),
    loadOrCreateDataKey: () => load(true),
  };
}

/** @napi-rs/keyring のうち、この KeyStore が使う部分。 */
export interface KeyringModule {
  readonly AsyncEntry: new (
    service: string,
    username: string,
  ) => {
    getPassword(): Promise<string | null | undefined>;
    setPassword(password: string): Promise<void>;
  };
}

export interface MacKeychainKeyStoreOptions {
  /**
   * @napi-rs/keyring の読み込み。省略時は初めて鍵を読むときに動的 import する。
   * Windows・Linux（CI を含む）では呼ばれないので、ネイティブモジュールを読み込まない。
   */
  readonly loadModule?: () => Promise<KeyringModule>;
}

async function importKeyring(): Promise<KeyringModule> {
  const module = (await import('@napi-rs/keyring')) as unknown as Partial<
    KeyringModule & { default: Partial<KeyringModule> }
  >;
  const AsyncEntry = module.AsyncEntry ?? module.default?.AsyncEntry;
  if (typeof AsyncEntry !== 'function')
    throw new Error('keyring module has no AsyncEntry');
  return { AsyncEntry };
}

/**
 * macOS のキーチェーンの KeyStore。サービス名 `dev.buddy.core`・アカウント名 `data-key-v1` の
 * 汎用パスワード項目に、32 バイトの鍵を base64 で保存する。
 */
export function createMacKeychainKeyStore(
  options: MacKeychainKeyStoreOptions = {},
): KeyStore {
  const loadModule = options.loadModule ?? importKeyring;
  let modulePromise: Promise<KeyringModule> | undefined;
  return createSlotKeyStore({
    kind: 'os',
    backend: 'macos_keychain',
    unavailableReason: 'keystore_module_unavailable',
    async openSlot() {
      modulePromise ??= loadModule();
      let keyring: KeyringModule;
      try {
        keyring = await modulePromise;
      } catch (error) {
        // 一時的な失敗のあとで読み込み直せるように、失敗した読み込みは保持しない。
        modulePromise = undefined;
        throw error;
      }
      const entry = new keyring.AsyncEntry(KEY_STORE_SERVICE, DATA_KEY_ACCOUNT);
      return {
        async read() {
          const value = await entry.getPassword();
          return value ?? null;
        },
        write: (value) => entry.setPassword(value),
      };
    },
  });
}

/** 初期版で中枢の鍵保護に対応しない OS の KeyStore。鍵を返さない。 */
export function createUnsupportedKeyStore(nodePlatform: string): KeyStore {
  const platform = corePlatformOf(nodePlatform);
  const reason: KeyStoreFailureReason =
    platform === 'windows'
      ? 'windows_core_not_supported_in_initial_release'
      : platform === 'linux'
        ? 'linux_core_not_supported_in_initial_release'
        : 'platform_not_supported';
  const result: DataKeyResult = { ok: false, backend: 'none', reason };
  return {
    kind: 'os',
    backend: 'none',
    loadDataKey: () => Promise.resolve(result),
    loadOrCreateDataKey: () => Promise.resolve(result),
  };
}

/** 実行中の OS に合う KeyStore（Core では process.platform を渡す）。 */
export function createKeyStore(
  nodePlatform: string,
  options: MacKeychainKeyStoreOptions = {},
): KeyStore {
  return corePlatformOf(nodePlatform) === 'macos'
    ? createMacKeychainKeyStore(options)
    : createUnsupportedKeyStore(nodePlatform);
}

export interface MockKeyStoreOptions {
  /** false なら保護領域を開けない状態（reason は mock_unavailable）。省略時は true。 */
  readonly available?: boolean;
  /** 最初に保存されている値。省略時は空（鍵なし）。形式の検査の試験で不正な値を入れる。 */
  readonly stored?: string | null;
  /** 読み出しを失敗させる。 */
  readonly readFails?: boolean;
  /** 書込みを失敗させる。 */
  readonly writeFails?: boolean;
  /** 書込みの後の読み出しで、書いた値と違う値を返す（並行した作成の再現）。 */
  readonly readBackDiffers?: boolean;
}

/** 試験用の模擬の KeyStore。メモリ上の 1 項目に保存し、実機のキーチェーンには触れない。 */
export interface MockKeyStore extends KeyStore {
  readonly kind: 'mock';
  /** 書込みの回数。 */
  readonly writes: number;
  /** 保存されている値があるか（値そのものは公開しない）。 */
  readonly hasStoredValue: boolean;
}

export function createMockKeyStore(
  options: MockKeyStoreOptions = {},
): MockKeyStore {
  let stored: string | null = options.stored ?? null;
  let writes = 0;
  const store = createSlotKeyStore({
    kind: 'mock',
    backend: 'mock',
    unavailableReason: 'mock_unavailable',
    openSlot() {
      if (options.available === false)
        return Promise.reject(new Error('mock key store unavailable'));
      return Promise.resolve({
        read() {
          if (options.readFails === true)
            return Promise.reject(new Error('mock read failed'));
          if (options.readBackDiffers === true && writes > 0)
            return Promise.resolve(
              Buffer.alloc(DATA_KEY_BYTES, 1).toString('base64'),
            );
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
