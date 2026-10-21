// 端末トークンの保存（設計 02 端末登録と接続・保存と秘密情報、ADR 0025）。
//
// - トークンと中枢の証明書・指紋を一つの記録にし、Electron の safeStorage（macOS はキーチェーン、Windows は DPAPI）で
//   暗号化して userData の device-credential.bin に置く。平文をディスクに置かない。
// - 保護の弱い方式しか使えない（Linux の basic_text・判定できない backend・暗号化が使えない）ときは保存しない。
//   その場合はペアリングもしない（受け取っても保存できないトークンを作らない）。
// - safeStorage の呼び出しは Electron の層（electron/main.ts）にだけ置き、ここは SecretProtector を受け取る
//   （試験は模擬を注入し、実機のキーチェーン・safeStorage を使わない）。
// - トークンは SecretText に包み、文字列化・JSON・inspect で値を出さない。
// Electron に依存しない。

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { inspect } from 'node:util';
import { isNormalizedHubHost } from '@buddy/domain';

export const CREDENTIAL_FILE = 'device-credential.bin';
const MAX_FILE_BYTES = 64 * 1024;

// safeStorage の必要な部分（Electron の層が実装を渡す）。
export interface SecretProtector {
  readonly platform: NodeJS.Platform;
  isEncryptionAvailable(): boolean;
  // Linux だけ: safeStorage.getSelectedStorageBackend() の値。他の OS は null。
  selectedBackend(): string | null;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

export type ProtectionCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        'encryption_unavailable' | 'weak_backend' | 'platform_unsupported';
    };

// Linux で保護が十分とみなす backend（OS の鍵束）。basic_text（固定の鍵）・unknown は弱い。
const STRONG_LINUX_BACKENDS: readonly string[] = [
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
];

export function protectionCheck(protector: SecretProtector): ProtectionCheck {
  let available: boolean;
  try {
    available = protector.isEncryptionAvailable();
  } catch {
    available = false;
  }
  if (protector.platform === 'darwin' || protector.platform === 'win32')
    return available
      ? { ok: true }
      : { ok: false, reason: 'encryption_unavailable' };
  if (protector.platform === 'linux') {
    if (!available) return { ok: false, reason: 'encryption_unavailable' };
    let backend: string | null;
    try {
      backend = protector.selectedBackend();
    } catch {
      backend = null;
    }
    return backend !== null && STRONG_LINUX_BACKENDS.includes(backend)
      ? { ok: true }
      : { ok: false, reason: 'weak_backend' };
  }
  return { ok: false, reason: 'platform_unsupported' };
}

// 値を出さない秘密の文字列。reveal() だけが値を返す。
export class SecretText {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[redacted]';
  }
  toJSON(): string {
    return '[redacted]';
  }
  [inspect.custom](): string {
    return '[redacted]';
  }
}

export interface StoredCredential {
  readonly deviceId: string;
  readonly token: SecretText;
  readonly issuedAt: string;
  readonly hub: {
    readonly host: string;
    readonly port: number;
    readonly certificatePem: string;
    readonly fingerprint: string;
  };
}

export type CredentialLoad =
  | { readonly kind: 'missing' }
  | { readonly kind: 'loaded'; readonly credential: StoredCredential }
  // 保護の弱い方式しか使えない（読まない・保存しない）。
  | { readonly kind: 'unprotected'; readonly reason: string }
  // 復号できない・形が違う（OS の鍵束の作り直しなど）。再登録が要る。
  | { readonly kind: 'unreadable' };

export class CredentialStoreError extends Error {
  constructor(readonly reason: string) {
    super(`credential_store_failed:${reason}`);
    this.name = 'CredentialStoreError';
  }
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const UTC =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](\.[0-9]+)?Z$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export function parseCredential(text: string): StoredCredential | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ['v', 'device_id', 'device_token', 'issued_at', 'hub']) ||
    value['v'] !== 1
  )
    return null;
  const hub = value['hub'];
  if (
    !isRecord(hub) ||
    !exactKeys(hub, ['host', 'port', 'certificate_pem', 'fingerprint'])
  )
    return null;
  const {
    device_id: deviceId,
    device_token: token,
    issued_at: issuedAt,
  } = value;
  const { host, port, certificate_pem: pem, fingerprint } = hub;
  if (
    typeof deviceId !== 'string' ||
    !UUID_V4.test(deviceId) ||
    typeof token !== 'string' ||
    !TOKEN.test(token) ||
    typeof issuedAt !== 'string' ||
    !UTC.test(issuedAt) ||
    typeof host !== 'string' ||
    // 宛先は domain の正規化（契約の DesktopHubHost と同じ一つの正規表現）を通した値だけ（レビューの指摘 L2）。
    !isNormalizedHubHost(host) ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof pem !== 'string' ||
    !pem.startsWith('-----BEGIN CERTIFICATE-----') ||
    pem.length > 16_384 ||
    typeof fingerprint !== 'string' ||
    !FINGERPRINT.test(fingerprint)
  )
    return null;
  return {
    deviceId,
    token: new SecretText(token),
    issuedAt,
    hub: { host, port, certificatePem: pem, fingerprint },
  };
}

function serialize(credential: StoredCredential): string {
  return JSON.stringify({
    v: 1,
    device_id: credential.deviceId,
    device_token: credential.token.reveal(),
    issued_at: credential.issuedAt,
    hub: {
      host: credential.hub.host,
      port: credential.hub.port,
      certificate_pem: credential.hub.certificatePem,
      fingerprint: credential.hub.fingerprint,
    },
  });
}

const isMissing = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'ENOENT';

export function loadCredential(
  path: string,
  protector: SecretProtector,
): CredentialLoad {
  const check = protectionCheck(protector);
  if (!check.ok) return { kind: 'unprotected', reason: check.reason };
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'unreadable' };
  }
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES)
    return { kind: 'unreadable' };
  let text: string;
  try {
    text = protector.decryptString(bytes);
  } catch {
    return { kind: 'unreadable' };
  }
  const credential = parseCredential(text);
  return credential === null
    ? { kind: 'unreadable' }
    : { kind: 'loaded', credential };
}

// 保護が十分なときだけ暗号化して保存する。一時ファイル → fsync → rename（→ ディレクトリの fsync）。
export function saveCredential(
  path: string,
  protector: SecretProtector,
  credential: StoredCredential,
): void {
  const check = protectionCheck(protector);
  if (!check.ok) throw new CredentialStoreError(check.reason);
  const text = serialize(credential);
  // 保存する前に、読み戻せる形であることを確かめる（読み戻せない記録を置くと、毎回「再登録が必要」になる）。
  if (parseCredential(text) === null)
    throw new CredentialStoreError('not_readable');
  let cipher: Buffer;
  try {
    cipher = protector.encryptString(text);
  } catch {
    throw new CredentialStoreError('encrypt_failed');
  }
  // 暗号化の結果に平文のトークンが残っていないこと（壊れた実装・平文の方式への切り替わりを拒否する）。
  if (cipher.includes(Buffer.from(credential.token.reveal(), 'ascii')))
    throw new CredentialStoreError('not_encrypted');
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, cipher);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch {
    rmSync(temporary, { force: true });
    throw new CredentialStoreError('write_failed');
  }
  if (process.platform !== 'win32') {
    try {
      const fd = openSync(directory, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // ディレクトリの fsync に失敗しても書いた内容は rename 済み。
    }
  }
}

export function clearCredential(path: string): void {
  rmSync(path, { force: true });
}
