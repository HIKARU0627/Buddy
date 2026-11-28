// 中枢のデータ鍵の KeyStore（設計 02 保存と秘密情報・03・08 §5、ADR 0017）。
// データ鍵（AES-256-GCM の 32 バイトの鍵）を OS の保護領域に置き、取得・初回作成する。
// macOS はキーチェーンに @napi-rs/keyring で、Windows は DPAPI（CurrentUser）で保護したファイルに保存する
// （ADR 0202。Linux の中枢は初期版の対象外）。
// 使えない・読めない・形式が不正なときは構造化した理由を返し、平文の保存へ切り替えない。
// 鍵の値（バイト列・base64）はログ・例外・結果の理由に入れない。
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { corePlatformOf } from './supervisor.js';
import {
  KeyStoreUnavailableError,
  SecretSlotExistsError,
  windowsDpapiSlotOpener,
} from './windows-dpapi.js';
import type { WindowsDpapiOptions } from './windows-dpapi.js';

/** キーチェーンのサービス名。個人情報を含まない固定の汎用名（LaunchAgent の Label と同じ）。 */
export const KEY_STORE_SERVICE = 'dev.buddy.core';
/** キーチェーンのアカウント名。鍵の世代を名前に持ち、個人情報を含まない。 */
export const DATA_KEY_ACCOUNT = 'data-key-v1';
/** sealed_blobs.key_id に入れる鍵の識別子。鍵の値から導かない固定の名前。 */
export const DATA_KEY_ID = 'data-key-v1';
/** AES-256 の鍵の長さ（バイト）。 */
export const DATA_KEY_BYTES = 32;

export type KeyStoreBackend =
  'macos_keychain' | 'windows_dpapi' | 'none' | 'mock';

export type KeyStoreFailureReason =
  // ネイティブモジュール（@napi-rs/keyring）を読み込めない。
  | 'keystore_module_unavailable'
  // Windows の DPAPI を使えない（PowerShell を起動できない、DPAPI の型を読み込めない、置き場所がない。ADR 0202）。
  | 'dpapi_unavailable'
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
  // 復元で別のデータ鍵を入れようとしたが、違う素材の既存の鍵がある（上書きしない）。
  | 'data_key_exists'
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
   * 復元で取り出したデータ鍵を置く。同じ ID に同じ素材があれば何もしない。違う素材があれば上書きせず
   * data_key_exists。置いた値を読み戻して確かめる（U130・U134）。
   */
  importDataKey(material: Uint8Array): Promise<DataKeyResult>;
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
  /**
   * 初回の作成（対応する保護領域だけが持つ。Windows の DPAPI）。項目がすでにあれば上書きせず
   * SecretSlotExistsError を投げる。持たない保護領域では write で作る（U704）。
   */
  readonly create?: (value: string) => Promise<void>;
  /** 項目を消す（対応する保護領域だけが持つ。OAuth トークンの失効・削除で使う）。 */
  readonly remove?: () => Promise<void>;
}

/**
 * 空の項目に値を置く。create を持つ保護領域は排他的に作り、並行した作成に先を越されたら 'exists'（上書きしない）。
 * 持たない保護領域は write で置き、書いた後の読み戻しの照合で並行した作成を検出する（ADR 0017）。
 */
export async function createSlotValue(
  slot: SecretSlot,
  value: string,
): Promise<'created' | 'exists'> {
  if (slot.create === undefined) {
    await slot.write(value);
    return 'created';
  }
  try {
    await slot.create(value);
    return 'created';
  } catch (error) {
    if (error instanceof SecretSlotExistsError) return 'exists';
    throw error;
  }
}

/**
 * 保護領域の操作の失敗を理由にする。保護領域そのものを使えない（KeyStoreUnavailableError）なら
 * unavailableReason、それ以外は操作ごとの失敗（読み出し・書込み・削除）にする。例外の文は使わない。
 */
export function slotFailureReason<R extends string>(
  error: unknown,
  unavailableReason: R,
  operationReason: R,
): R {
  return error instanceof KeyStoreUnavailableError
    ? unavailableReason
    : operationReason;
}

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/**
 * 保存値（base64）を検査して鍵のバイト列にする。正準の base64（空白・改行・URL 用の文字・余分な桁を含まない）だけを受け入れる。
 * 理由だけを返し、値は返さない。
 */
/** 正準の base64（空白・改行・URL 用の文字・未使用ビット・パディングの欠落を含まない）を復号する。違えば null。 */
export function decodeCanonicalBase64(stored: string): Buffer | null {
  if (stored.length === 0 || !BASE64.test(stored)) return null;
  const bytes = Buffer.from(stored, 'base64');
  // 末尾の桁の未使用ビットが 0 でない値は、同じバイト列の別表記なので拒否する。
  return bytes.toString('base64') === stored ? bytes : null;
}

export function decodeStoredDataKey(stored: string):
  | { readonly ok: true; readonly bytes: Buffer }
  | {
      readonly ok: false;
      readonly reason: 'data_key_format_invalid' | 'data_key_length_invalid';
    } {
  const bytes = decodeCanonicalBase64(stored);
  if (bytes === null) return { ok: false, reason: 'data_key_format_invalid' };
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
    } catch (error) {
      return fail(
        slotFailureReason(error, unavailableReason, 'keystore_read_failed'),
      );
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
      // 並行した作成に先を越されたら、先に置かれた鍵を読んで使う（上書きしない。U704）。
      if ((await createSlotValue(slot, encoded)) === 'exists')
        return load(false);
    } catch (error) {
      return fail(
        slotFailureReason(error, unavailableReason, 'keystore_write_failed'),
      );
    }
    // 書いた値を読み戻し、保護領域から同じ鍵を取得できることを確かめてから使う。
    let readBack: string | null;
    try {
      readBack = await slot.read();
    } catch (error) {
      return fail(
        slotFailureReason(error, unavailableReason, 'keystore_read_failed'),
      );
    }
    if (readBack !== encoded) return fail('data_key_verify_failed');
    return {
      ok: true,
      backend,
      dataKey: new DataKey(keyId, bytes),
      created: true,
    };
  }

  async function importKey(
    material: Uint8Array,
    retried = false,
  ): Promise<DataKeyResult> {
    if (material.length !== DATA_KEY_BYTES)
      return fail('data_key_length_invalid');
    let slot: SecretSlot;
    try {
      slot = await options.openSlot();
    } catch {
      return fail(unavailableReason);
    }
    let stored: string | null;
    try {
      stored = await slot.read();
    } catch (error) {
      return fail(
        slotFailureReason(error, unavailableReason, 'keystore_read_failed'),
      );
    }
    const encoded = Buffer.from(material).toString('base64');
    if (stored !== null) {
      if (typeof stored !== 'string') return fail('data_key_format_invalid');
      const decoded = decodeStoredDataKey(stored);
      if (!decoded.ok) return fail(decoded.reason);
      if (!decoded.bytes.equals(Buffer.from(material)))
        return fail('data_key_exists');
      return {
        ok: true,
        backend,
        dataKey: new DataKey(keyId, decoded.bytes),
        created: false,
      };
    }
    try {
      // 並行して置かれたら読み直して素材を照合する（1 度だけ。上書きしない。U704）。
      if ((await createSlotValue(slot, encoded)) === 'exists')
        return retried
          ? fail('data_key_verify_failed')
          : importKey(material, true);
    } catch (error) {
      return fail(
        slotFailureReason(error, unavailableReason, 'keystore_write_failed'),
      );
    }
    let readBack: string | null;
    try {
      readBack = await slot.read();
    } catch (error) {
      return fail(
        slotFailureReason(error, unavailableReason, 'keystore_read_failed'),
      );
    }
    if (readBack !== encoded) return fail('data_key_verify_failed');
    return {
      ok: true,
      backend,
      dataKey: new DataKey(keyId, Buffer.from(material)),
      created: false,
    };
  }

  return {
    kind,
    backend,
    loadDataKey: () => load(false),
    loadOrCreateDataKey: () => load(true),
    importDataKey: (material) => importKey(material),
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
    deletePassword?(): Promise<boolean | void>;
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
  return createSlotKeyStore({
    kind: 'os',
    backend: 'macos_keychain',
    unavailableReason: 'keystore_module_unavailable',
    openSlot: keychainSlotOpener(DATA_KEY_ACCOUNT, options),
  });
}

/**
 * キーチェーンの 1 項目（サービス名 `dev.buddy.core`・指定のアカウント名）を開く関数を作る。
 * データ鍵（`data-key-v1`）と TLS の秘密鍵（`tls-key-v1`、ADR 0020）で使う。
 * ネイティブモジュールは初めて開くときに読み込み、失敗した読み込みは保持しない。
 */
export function keychainSlotOpener(
  account: string,
  options: MacKeychainKeyStoreOptions = {},
): () => Promise<SecretSlot> {
  const loadModule = options.loadModule ?? importKeyring;
  let modulePromise: Promise<KeyringModule> | undefined;
  return async () => {
    modulePromise ??= loadModule();
    let keyring: KeyringModule;
    try {
      keyring = await modulePromise;
    } catch (error) {
      // 一時的な失敗のあとで読み込み直せるように、失敗した読み込みは保持しない。
      modulePromise = undefined;
      throw error;
    }
    const entry = new keyring.AsyncEntry(KEY_STORE_SERVICE, account);
    return {
      async read() {
        const value = await entry.getPassword();
        return value ?? null;
      },
      write: (value) => entry.setPassword(value),
      async remove() {
        if (typeof entry.deletePassword !== 'function')
          throw new Error('keyring entry has no deletePassword');
        await entry.deletePassword();
      },
    };
  };
}

/** 実行中の OS に合う KeyStore の選択肢。macOS は loadModule、Windows は WindowsDpapiOptions だけを使う。 */
export interface OsKeyStoreOptions
  extends MacKeychainKeyStoreOptions, WindowsDpapiOptions {}

/**
 * Windows の DPAPI（CurrentUser）の KeyStore（ADR 0202）。データ鍵（項目名 `data-key-v1`）を
 * 32 バイトの正準の base64 にして DPAPI で保護し、%LOCALAPPDATA%\Buddy\key-store の下のファイルに置く。
 */
export function createWindowsDpapiKeyStore(
  options: WindowsDpapiOptions = {},
): KeyStore {
  return createSlotKeyStore({
    kind: 'os',
    backend: 'windows_dpapi',
    unavailableReason: 'dpapi_unavailable',
    openSlot: windowsDpapiSlotOpener(DATA_KEY_ACCOUNT, options),
  });
}

/**
 * 中枢の鍵保護に対応しない OS の KeyStore。鍵を返さない。
 * Linux の中枢は初期版の対象外（ADR 0013・0202）。Windows は ADR 0202 から DPAPI で対応する。
 */
export function createUnsupportedKeyStore(nodePlatform: string): KeyStore {
  const reason: KeyStoreFailureReason =
    corePlatformOf(nodePlatform) === 'linux'
      ? 'linux_core_not_supported_in_initial_release'
      : 'platform_not_supported';
  const result: DataKeyResult = { ok: false, backend: 'none', reason };
  return {
    kind: 'os',
    backend: 'none',
    loadDataKey: () => Promise.resolve(result),
    loadOrCreateDataKey: () => Promise.resolve(result),
    importDataKey: () => Promise.resolve(result),
  };
}

/** 実行中の OS に合う KeyStore（Core では process.platform を渡す）。 */
export function createKeyStore(
  nodePlatform: string,
  options: OsKeyStoreOptions = {},
): KeyStore {
  switch (corePlatformOf(nodePlatform)) {
    case 'macos':
      return createMacKeychainKeyStore(options);
    case 'windows':
      return createWindowsDpapiKeyStore(options);
    default:
      return createUnsupportedKeyStore(nodePlatform);
  }
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
