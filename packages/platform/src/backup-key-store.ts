// バックアップの鍵の KeyStore（設計 02 保存と秘密情報・03、ADR 0017・0040・0055）。
// バックアップ本体の鍵（backup_file）と台帳・記憶の HMAC の鍵（ledger_hmac_key）を、データ鍵と同じサービス名
// `dev.buddy.core` の別の項目（アカウント名 `backup-file:<key_id>`・`ledger-hmac:<key_id>`）に、32 バイトを正準の base64 で置く。
// 鍵の ID を名前に持つので、ID ごとに 1 項目。別の ID の鍵を上書きしない（置換は新しい ID の鍵を足してから切り替える）。
// 初期版の中枢は macOS だけ。使えない・読めない・形式が不正なときは理由だけを返し、平文の保存へ切り替えない。
// 鍵の値（バイト列・base64）はログ・例外・結果の理由に入れない。
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { decodeCanonicalBase64, keychainSlotOpener } from './key-store.js';
import type {
  KeyStoreBackend,
  MacKeychainKeyStoreOptions,
  SecretSlot,
} from './key-store.js';
import { corePlatformOf } from './supervisor.js';

export const BACKUP_KEY_BYTES = 32;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export type BackupKeyPurposeName = 'backup_file' | 'ledger_hmac_key';

export type BackupKeyStoreFailureReason =
  | 'keystore_module_unavailable'
  | 'keystore_read_failed'
  | 'keystore_write_failed'
  | 'backup_key_id_invalid'
  | 'backup_key_missing'
  | 'backup_key_format_invalid'
  // 置こうとした鍵の ID に、別の鍵がすでにある（上書きしない）。
  | 'backup_key_exists'
  // 書いた値を読み戻したら違った。
  | 'backup_key_verify_failed'
  | 'windows_core_not_supported_in_initial_release'
  | 'linux_core_not_supported_in_initial_release'
  | 'platform_not_supported'
  | 'mock_unavailable';

/** バックアップの鍵 1 つ。鍵の値は JSON・inspect・文字列化で出さない。 */
export class BackupKey {
  readonly purpose: BackupKeyPurposeName;
  readonly keyId: string;
  readonly #bytes: Buffer;

  constructor(purpose: BackupKeyPurposeName, keyId: string, bytes: Uint8Array) {
    if (bytes.length !== BACKUP_KEY_BYTES)
      throw new RangeError('backup key must be 32 bytes');
    this.purpose = purpose;
    this.keyId = keyId;
    this.#bytes = Buffer.from(bytes);
  }

  /** 呼び出しごとに複製を返す。 */
  get key(): Buffer {
    return Buffer.from(this.#bytes);
  }

  toJSON(): { purpose: string; keyId: string; key: '[redacted]' } {
    return { purpose: this.purpose, keyId: this.keyId, key: '[redacted]' };
  }

  toString(): string {
    return `BackupKey(${this.purpose}:${this.keyId})`;
  }

  [inspect.custom](): string {
    return `BackupKey { purpose: '${this.purpose}', keyId: '${this.keyId}', key: [redacted] }`;
  }
}

export type BackupKeyResult =
  | { readonly ok: true; readonly key: BackupKey }
  | {
      readonly ok: false;
      readonly backend: KeyStoreBackend;
      readonly reason: BackupKeyStoreFailureReason;
    };

export interface BackupKeyStore {
  readonly kind: 'os' | 'mock';
  readonly backend: KeyStoreBackend;
  /** 鍵を読む。なければ backup_key_missing（作らない）。 */
  read(purpose: BackupKeyPurposeName, keyId: string): Promise<BackupKeyResult>;
  /**
   * 鍵を置く。同じ ID に同じ値がすでにあれば何もしない。違う値がすでにあれば上書きせず backup_key_exists。
   * 置いた値を読み戻して確かめる。
   */
  put(
    purpose: BackupKeyPurposeName,
    keyId: string,
    material: Uint8Array,
  ): Promise<BackupKeyResult>;
}

const ACCOUNT_PREFIX: Readonly<Record<BackupKeyPurposeName, string>> = {
  backup_file: 'backup-file',
  ledger_hmac_key: 'ledger-hmac',
};

export function backupKeyAccount(
  purpose: BackupKeyPurposeName,
  keyId: string,
): string {
  return `${ACCOUNT_PREFIX[purpose]}:${keyId}`;
}

/** 新しい鍵の素材（32 バイトの暗号論的乱数）。 */
export function newBackupKeyMaterial(): Buffer {
  return randomBytes(BACKUP_KEY_BYTES);
}

export interface SlotBackupKeyStoreOptions {
  readonly kind: 'os' | 'mock';
  readonly backend: Exclude<KeyStoreBackend, 'none'>;
  readonly openSlot: (account: string) => Promise<SecretSlot>;
  readonly unavailableReason: BackupKeyStoreFailureReason;
}

/** 保護領域の項目の上に、バックアップの鍵の KeyStore を作る。 */
export function createSlotBackupKeyStore(
  options: SlotBackupKeyStoreOptions,
): BackupKeyStore {
  const { kind, backend, unavailableReason } = options;
  const fail = (reason: BackupKeyStoreFailureReason): BackupKeyResult => ({
    ok: false,
    backend,
    reason,
  });
  async function open(
    purpose: BackupKeyPurposeName,
    keyId: string,
  ): Promise<SecretSlot | BackupKeyResult> {
    if (typeof keyId !== 'string' || !KEY_ID.test(keyId))
      return fail('backup_key_id_invalid');
    try {
      return await options.openSlot(backupKeyAccount(purpose, keyId));
    } catch {
      return fail(unavailableReason);
    }
  }
  const isFailure = (
    value: SecretSlot | BackupKeyResult,
  ): value is BackupKeyResult => 'ok' in value;
  async function readSlot(
    slot: SecretSlot,
  ): Promise<{ readonly stored: string | null } | BackupKeyResult> {
    try {
      return { stored: await slot.read() };
    } catch {
      return fail('keystore_read_failed');
    }
  }
  function decode(
    purpose: BackupKeyPurposeName,
    keyId: string,
    stored: string,
  ): BackupKeyResult {
    const bytes =
      typeof stored === 'string' ? decodeCanonicalBase64(stored) : null;
    if (bytes === null || bytes.length !== BACKUP_KEY_BYTES)
      return fail('backup_key_format_invalid');
    return { ok: true, key: new BackupKey(purpose, keyId, bytes) };
  }
  return {
    kind,
    backend,
    async read(purpose, keyId) {
      const slot = await open(purpose, keyId);
      if (isFailure(slot)) return slot;
      const read = await readSlot(slot);
      if ('ok' in read) return read;
      if (read.stored === null) return fail('backup_key_missing');
      return decode(purpose, keyId, read.stored);
    },
    async put(purpose, keyId, material) {
      if (material.length !== BACKUP_KEY_BYTES)
        return fail('backup_key_format_invalid');
      const slot = await open(purpose, keyId);
      if (isFailure(slot)) return slot;
      const existing = await readSlot(slot);
      if ('ok' in existing) return existing;
      const encoded = Buffer.from(material).toString('base64');
      if (existing.stored !== null) {
        // 同じ値なら何もしない（設定のやり直し）。違えば上書きしない。
        return existing.stored === encoded
          ? decode(purpose, keyId, existing.stored)
          : fail('backup_key_exists');
      }
      try {
        await slot.write(encoded);
      } catch {
        return fail('keystore_write_failed');
      }
      const back = await readSlot(slot);
      if ('ok' in back) return back;
      if (back.stored !== encoded) return fail('backup_key_verify_failed');
      return decode(purpose, keyId, back.stored);
    },
  };
}

/** macOS のキーチェーンのバックアップの鍵の KeyStore。 */
export function createMacKeychainBackupKeyStore(
  options: MacKeychainKeyStoreOptions = {},
): BackupKeyStore {
  const openers = new Map<string, () => Promise<SecretSlot>>();
  return createSlotBackupKeyStore({
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

/** 初期版で中枢の鍵保護に対応しない OS。鍵を返さない。 */
export function createUnsupportedBackupKeyStore(
  nodePlatform: string,
): BackupKeyStore {
  const platform = corePlatformOf(nodePlatform);
  const reason: BackupKeyStoreFailureReason =
    platform === 'windows'
      ? 'windows_core_not_supported_in_initial_release'
      : platform === 'linux'
        ? 'linux_core_not_supported_in_initial_release'
        : 'platform_not_supported';
  const failure: BackupKeyResult = { ok: false, backend: 'none', reason };
  return {
    kind: 'os',
    backend: 'none',
    read: () => Promise.resolve(failure),
    put: () => Promise.resolve(failure),
  };
}

export function createBackupKeyStore(
  nodePlatform: string,
  options: MacKeychainKeyStoreOptions = {},
): BackupKeyStore {
  return corePlatformOf(nodePlatform) === 'macos'
    ? createMacKeychainBackupKeyStore(options)
    : createUnsupportedBackupKeyStore(nodePlatform);
}

export interface MockBackupKeyStoreOptions {
  /** false なら保護領域を開けない状態。 */
  readonly available?: boolean;
  /** 書込みを失敗させる。 */
  readonly writeFails?: boolean;
}

export interface MockBackupKeyStore extends BackupKeyStore {
  readonly kind: 'mock';
  /** 置かれている鍵の（用途:ID）の一覧（値は公開しない）。 */
  readonly accounts: () => readonly string[];
  /** 試験用: 鍵の値を直接置き換える（取り違え・形式不正の再現）。 */
  readonly overwrite: (
    purpose: BackupKeyPurposeName,
    keyId: string,
    stored: string,
  ) => void;
  /** 試験用: 鍵を消す（KeyStore の欠落の再現）。 */
  readonly remove: (purpose: BackupKeyPurposeName, keyId: string) => void;
}

/** 試験用の模擬。メモリ上だけで、実機のキーチェーンには触れない。 */
export function createMockBackupKeyStore(
  options: MockBackupKeyStoreOptions = {},
): MockBackupKeyStore {
  const values = new Map<string, string>();
  const store = createSlotBackupKeyStore({
    kind: 'mock',
    backend: 'mock',
    unavailableReason: 'mock_unavailable',
    openSlot(account) {
      if (options.available === false)
        return Promise.reject(new Error('mock backup key store unavailable'));
      return Promise.resolve({
        read: () => Promise.resolve(values.get(account) ?? null),
        write(value) {
          if (options.writeFails === true)
            return Promise.reject(new Error('mock write failed'));
          values.set(account, value);
          return Promise.resolve();
        },
      });
    },
  });
  return {
    ...store,
    kind: 'mock',
    accounts: () => [...values.keys()].sort(),
    overwrite: (purpose, keyId, stored) => {
      values.set(backupKeyAccount(purpose, keyId), stored);
    },
    remove: (purpose, keyId) => {
      values.delete(backupKeyAccount(purpose, keyId));
    },
  };
}
