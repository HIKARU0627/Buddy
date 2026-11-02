// バックアップの暗号（設計 03 バックアップ・復元、ADR 0040・0047・0055）。
// 導き方の入力（salt・info・AAD）は domain（backup-keys.ts）が組み立てて検査し、ここは node:crypto で計算するだけ。
// - 鍵の包み: 復旧キー（256 ビット）から HKDF-SHA256 で導いた鍵で、3 つの鍵（本体・DB の暗号文・台帳の HMAC）を AES-256-GCM で包む。
// - 本体: backup_file の鍵と backup_id から HKDF で導いた鍵で、SQLite の写しを AES-256-GCM で暗号化する。
//   本体の並びは nonce（12 バイト）‖ 暗号文 ‖ 認証タグ（16 バイト）。nonce は毎回乱数。
// 失敗は理由だけを返し、鍵・平文・nonce の値を結果・例外に入れない。平文へのフォールバックはない。

import canonicalize from 'canonicalize';
import {
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  backupHkdfInputProblems,
  backupPayloadAad,
  backupPayloadHkdfInput,
  keyWrapAad,
  keyWrapFor,
  keyWrapHkdfInput,
  recoveryCheckHkdfInput,
} from '@buddy/domain';
import type {
  BackupHkdfInput,
  BackupKeyPurpose,
  BackupPayloadAadFields,
} from '@buddy/domain';
import {
  AES_256_GCM_KEY_BYTES,
  AES_GCM_NONCE_BYTES,
  AES_GCM_TAG_BYTES,
  aes256GcmDecrypt,
  aes256GcmEncrypt,
} from './aes-gcm.js';

export const RECOVERY_KEY_BYTES = 32;
export const BACKUP_MATERIAL_BYTES = 32;
const WRAP_SALT_BYTES = 16;

// 契約の BackupKeyWrap と同じ形（storage は @buddy/contracts に依存しない）。
export interface BackupKeyWrapValue {
  readonly purpose: BackupKeyPurpose;
  readonly key_id: string;
  readonly recovery_key_id: string;
  readonly kdf: { readonly algorithm: 'hkdf-sha256'; readonly salt: string };
  readonly cipher: 'aes-256-gcm';
  readonly nonce: string;
  readonly wrapped_material: string;
  readonly tag: string;
}

export class BackupCryptoError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`バックアップの暗号に失敗しました（${reason}）。`);
    this.name = 'BackupCryptoError';
    this.reason = reason;
  }
}

function checkBytes(name: string, value: Uint8Array, bytes: number): void {
  if (!(value instanceof Uint8Array) || value.length !== bytes)
    throw new BackupCryptoError(`${name}_length_invalid`);
}

// HKDF-SHA256。入力を domain の検査に通してから計算する。
export function backupHkdf(ikm: Uint8Array, input: BackupHkdfInput): Buffer {
  const problems = backupHkdfInputProblems(input);
  if (problems.length > 0) throw new BackupCryptoError(problems[0] as string);
  if (!(ikm instanceof Uint8Array) || ikm.length === 0)
    throw new BackupCryptoError('ikm_invalid');
  return Buffer.from(
    hkdfSync('sha256', ikm, input.salt, input.info, input.length),
  );
}

// 復旧キーの確認値（大文字の 16 進 8 桁）。打ち間違いを先に見つけるためだけで、復旧キーは導けない。
export function recoveryCheckValue(recoveryKey: Uint8Array): string {
  checkBytes('recovery_key', recoveryKey, RECOVERY_KEY_BYTES);
  return backupHkdf(recoveryKey, recoveryCheckHkdfInput())
    .toString('hex')
    .toUpperCase();
}

export function recoveryCheckMatches(
  recoveryKey: Uint8Array,
  expected: string,
): boolean {
  if (typeof expected !== 'string' || !/^[0-9A-F]{8}$/u.test(expected))
    return false;
  const actual = Buffer.from(recoveryCheckValue(recoveryKey), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function newRecoveryKey(): Buffer {
  return randomBytes(RECOVERY_KEY_BYTES);
}

// 鍵を復旧キーで包む。salt・nonce は毎回乱数。
export function wrapBackupKey(input: {
  readonly recoveryKey: Uint8Array;
  readonly recoveryKeyId: string;
  readonly purpose: BackupKeyPurpose;
  readonly keyId: string;
  readonly material: Uint8Array;
}): BackupKeyWrapValue {
  checkBytes('recovery_key', input.recoveryKey, RECOVERY_KEY_BYTES);
  checkBytes('material', input.material, BACKUP_MATERIAL_BYTES);
  const base = {
    purpose: input.purpose,
    key_id: input.keyId,
    recovery_key_id: input.recoveryKeyId,
    kdf: {
      algorithm: 'hkdf-sha256' as const,
      salt: randomBytes(WRAP_SALT_BYTES).toString('base64'),
    },
    cipher: 'aes-256-gcm' as const,
  };
  const wrapKey = backupHkdf(
    input.recoveryKey,
    keyWrapHkdfInput({ ...base, nonce: '', wrapped_material: '', tag: '' }),
  );
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const sealed = aes256GcmEncrypt(
    wrapKey,
    nonce,
    input.material,
    keyWrapAad({ ...base, nonce: '', wrapped_material: '', tag: '' }),
  );
  return {
    ...base,
    nonce: nonce.toString('base64'),
    wrapped_material: sealed.ciphertext.toString('base64'),
    tag: sealed.tag.toString('base64'),
  };
}

// 包みを開く。復旧キーが違う・包みを入れ替えた・壊れているときは null（認証に失敗した値は返さない）。
export function unwrapBackupKey(
  recoveryKey: Uint8Array,
  wrap: BackupKeyWrapValue,
): Buffer | null {
  checkBytes('recovery_key', recoveryKey, RECOVERY_KEY_BYTES);
  let wrapKey: Buffer;
  try {
    wrapKey = backupHkdf(recoveryKey, keyWrapHkdfInput(wrap));
  } catch {
    return null;
  }
  const nonce = Buffer.from(wrap.nonce, 'base64');
  const ciphertext = Buffer.from(wrap.wrapped_material, 'base64');
  const tag = Buffer.from(wrap.tag, 'base64');
  if (
    nonce.length !== AES_GCM_NONCE_BYTES ||
    tag.length !== AES_GCM_TAG_BYTES ||
    ciphertext.length !== BACKUP_MATERIAL_BYTES
  )
    return null;
  return aes256GcmDecrypt(wrapKey, nonce, ciphertext, tag, keyWrapAad(wrap));
}

export interface BackupPayloadKeyInput {
  // backup_file の鍵（32 バイト）とその ID。
  readonly key: Uint8Array;
  readonly keyId: string;
  readonly fields: Omit<BackupPayloadAadFields, 'backup_file_key_id'>;
}

function payloadKey(input: BackupPayloadKeyInput): Buffer {
  checkBytes('backup_file_key', input.key, AES_256_GCM_KEY_BYTES);
  return backupHkdf(
    input.key,
    backupPayloadHkdfInput(input.keyId, input.fields.backup_id),
  );
}

function payloadAad(input: BackupPayloadKeyInput): Uint8Array {
  return backupPayloadAad({
    ...input.fields,
    backup_file_key_id: input.keyId,
  });
}

// 本体（SQLite の写し）を暗号化する。戻り値は nonce ‖ 暗号文 ‖ 認証タグ。
export function encryptBackupPayload(
  input: BackupPayloadKeyInput,
  plaintext: Uint8Array,
): Buffer {
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const sealed = aes256GcmEncrypt(
    payloadKey(input),
    nonce,
    plaintext,
    payloadAad(input),
  );
  return Buffer.concat([nonce, sealed.ciphertext, sealed.tag]);
}

// 本体を開く。鍵・封筒の欄・本体のどれかが違えば null。
export function decryptBackupPayload(
  input: BackupPayloadKeyInput,
  blob: Uint8Array,
): Buffer | null {
  if (blob.length < AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES) return null;
  const buffer = Buffer.from(blob.buffer, blob.byteOffset, blob.length);
  const nonce = buffer.subarray(0, AES_GCM_NONCE_BYTES);
  const tag = buffer.subarray(buffer.length - AES_GCM_TAG_BYTES);
  const ciphertext = buffer.subarray(
    AES_GCM_NONCE_BYTES,
    buffer.length - AES_GCM_TAG_BYTES,
  );
  return aes256GcmDecrypt(
    payloadKey(input),
    nonce,
    ciphertext,
    tag,
    payloadAad(input),
  );
}

// 封筒（BackupManifest）の平文の欄のうち payload（本体の長さと SHA-256。別に照合する）を除いた全体の SHA-256。正規の JSON
// （RFC 8785）から求めるので、欄の順序や空白に依らない。どの欄を書き換えても値が変わり、本体の AES-GCM の追加認証データ
// （backupPayloadAad の envelope_sha256）に入っているので、本体の認証に失敗する（PR #175 の P1）。
export function envelopeSha256(manifest: Record<string, unknown>): string {
  const rest = { ...manifest };
  delete rest['payload'];
  const canonical = canonicalize(rest);
  if (canonical === undefined) throw new BackupCryptoError('manifest_not_json');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface ManifestPayloadKey {
  // backup_file の鍵の ID（封筒の key_wraps の backup_file の key_id）。
  readonly keyId: string;
  readonly fields: BackupPayloadKeyInput['fields'];
}

// 封筒から本体の鍵の ID と追加認証データの欄を取り出す。欄が足りない・型が違う・backup_file の包みがちょうど 1 つでない
// ときは null（推測で補わない）。封筒を書くとき（作成）も、開くとき（掃除の認証・復元）も、この関数で同じ欄にする。
export function manifestPayloadKey(
  manifest: unknown,
): ManifestPayloadKey | null {
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest)
  )
    return null;
  const m = manifest as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof m[key] === 'string' ? (m[key] as string) : null;
  const backupId = text('backup_id');
  const createdAt = text('created_at');
  const storeGeneration = text('store_generation');
  const forgettingGeneration = text('forgetting_generation');
  const ledgerId = text('ledger_id');
  const ledgerHeadHash = text('ledger_head_hash');
  const version = m['db_schema_version'];
  const tables = m['excluded_tables'];
  const wraps = m['key_wraps'];
  if (
    backupId === null ||
    createdAt === null ||
    storeGeneration === null ||
    forgettingGeneration === null ||
    ledgerId === null ||
    ledgerHeadHash === null ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    !Array.isArray(tables) ||
    !tables.every((table) => typeof table === 'string') ||
    !Array.isArray(wraps)
  )
    return null;
  const wrap = keyWrapFor(
    wraps as Parameters<typeof keyWrapFor>[0],
    'backup_file',
  );
  if (wrap === null) return null;
  try {
    return {
      keyId: wrap.key_id,
      fields: {
        backup_id: backupId,
        created_at: createdAt,
        store_generation: storeGeneration,
        db_schema_version: version,
        forgetting_generation: forgettingGeneration,
        ledger_id: ledgerId,
        ledger_head_hash: ledgerHeadHash,
        excluded_tables: tables as string[],
        envelope_sha256: envelopeSha256(m),
      },
    };
  } catch {
    return null;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
