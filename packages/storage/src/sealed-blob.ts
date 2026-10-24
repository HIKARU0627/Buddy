// sealed_blobs の封筒の暗号化・復号（設計 02・03・08 §5、ADR 0010・0017）。
// 形式版・key_id・nonce・暗号文・認証タグを分けて持ち、所有者の表・ID・版・用途・形式版・key_id を
// 追加認証データ（AAD）に結び付ける。別の行・別の版・別の用途への暗号文の差替えは復号で検出する。
// 純粋な関数で、DB への保存（B02-03・04）と鍵の取得（@buddy/platform の KeyStore）は呼び出し側が行う。
// 失敗は理由だけを返し、平文・鍵・nonce の値を結果・例外に入れない。平文へのフォールバックはない。
import { randomBytes } from 'node:crypto';
import {
  AES_256_GCM_KEY_BYTES,
  AES_GCM_NONCE_BYTES,
  AES_GCM_TAG_BYTES,
  aes256GcmDecrypt,
  aes256GcmEncrypt,
} from './aes-gcm.js';

/** 封筒の形式版。AAD の作り方・アルゴリズム・nonce とタグの長さを変えるときに上げる。 */
export const SEALED_BLOB_FORMAT_VERSION = 1;

/**
 * sealed_blobs.purpose の値（最新のマイグレーションの CHECK と一致することを試験する）。
 * task_content は 0011 で足した（用事の題名・期限・本文。所有者は tasks。ADR 0051）。
 */
export const SEALED_BLOB_PURPOSES = [
  'operation_intent',
  'turn_text',
  'session_summary',
  'source_body',
  'candidate_title',
  'candidate_excerpt',
  'memory_text',
  'memory_target_key',
  'directive_text',
  'connection_account',
  'request_summary',
  'proposal',
  'task_content',
] as const;

export type SealedBlobPurpose = (typeof SEALED_BLOB_PURPOSES)[number];

/** 暗号文の持ち主。sealed_blobs の (owner_table, owner_id, owner_version, purpose) に対応する。 */
export interface SealedBlobOwner {
  readonly ownerTable: string;
  readonly ownerId: string;
  /** 所有者の内容版（0 以上の整数）。 */
  readonly ownerVersion: number;
  readonly purpose: SealedBlobPurpose;
}

/** 暗号化に使う鍵。@buddy/platform の DataKey はこの形を満たす。 */
export interface DataKeyMaterial {
  readonly keyId: string;
  /** 32 バイトの AES-256 の鍵。 */
  readonly key: Uint8Array;
}

/** sealed_blobs の format_version・key_id・nonce・ciphertext・tag の列に対応する。 */
export interface SealedEnvelope {
  readonly formatVersion: number;
  readonly keyId: string;
  /** 12 バイト。 */
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  /** 16 バイト。 */
  readonly tag: Uint8Array;
}

export type SealFailureReason =
  'key_invalid' | 'key_id_invalid' | 'owner_invalid' | 'plaintext_invalid';

export type SealResult =
  | { readonly ok: true; readonly envelope: SealedEnvelope }
  | { readonly ok: false; readonly reason: SealFailureReason };

export type OpenFailureReason =
  | 'key_invalid'
  | 'owner_invalid'
  // nonce・タグの長さ・型などが封筒の形でない。
  | 'envelope_invalid'
  // 対応しない形式版（将来の版・壊れた値）。
  | 'format_version_unsupported'
  // 封筒の key_id と渡された鍵の key_id が違う（鍵の取り違え）。
  | 'key_id_mismatch'
  // 認証タグの検証に失敗した（暗号文・タグ・nonce の改ざん、AAD の差替え、同じ key_id の別の鍵）。
  // GCM ではこれらを互いに区別できない。
  | 'authentication_failed';

export type OpenResult =
  | { readonly ok: true; readonly plaintext: Buffer }
  | { readonly ok: false; readonly reason: OpenFailureReason };

/** 平文の上限（64 MiB）。上限を超える本文は分割して扱う（DB の 1 値の大きさを抑えるため）。 */
export const SEALED_BLOB_MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;

const AAD_LABEL = 'buddy/sealed_blobs';
const TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_OWNER_ID_BYTES = 256;
const PURPOSES: ReadonlySet<string> = new Set(SEALED_BLOB_PURPOSES);

function isWellFormedText(value: unknown): value is string {
  // 孤立したサロゲートは UTF-8 に変換すると別の文字（U+FFFD）になり、別の値と同じ AAD になり得るので拒否する。
  return (
    typeof value === 'string' &&
    Buffer.from(value, 'utf8').toString('utf8') === value
  );
}

function isValidOwner(owner: unknown): owner is SealedBlobOwner {
  if (owner === null || typeof owner !== 'object') return false;
  const { ownerTable, ownerId, ownerVersion, purpose } = owner as Partial<
    Record<keyof SealedBlobOwner, unknown>
  >;
  return (
    typeof ownerTable === 'string' &&
    TABLE_NAME.test(ownerTable) &&
    isWellFormedText(ownerId) &&
    ownerId.length > 0 &&
    Buffer.byteLength(ownerId, 'utf8') <= MAX_OWNER_ID_BYTES &&
    typeof ownerVersion === 'number' &&
    Number.isSafeInteger(ownerVersion) &&
    ownerVersion >= 0 &&
    typeof purpose === 'string' &&
    PURPOSES.has(purpose)
  );
}

function isValidKeyId(keyId: unknown): keyId is string {
  return typeof keyId === 'string' && KEY_ID.test(keyId);
}

function isValidKey(key: unknown): key is Uint8Array {
  return key instanceof Uint8Array && key.length === AES_256_GCM_KEY_BYTES;
}

function readKey(
  dataKey: unknown,
): { keyId: string; key: Uint8Array } | 'key_invalid' | 'key_id_invalid' {
  if (dataKey === null || typeof dataKey !== 'object') return 'key_invalid';
  const { keyId, key } = dataKey as Partial<
    Record<keyof DataKeyMaterial, unknown>
  >;
  if (!isValidKey(key)) return 'key_invalid';
  if (!isValidKeyId(keyId)) return 'key_id_invalid';
  return { keyId, key };
}

function field(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/**
 * 追加認証データ（形式版 1）。次の 7 個の欄を、各欄「4 バイトのビッグエンディアンの長さ + UTF-8 のバイト列」で順に連結する。
 * 1. 固定の識別子 `buddy/sealed_blobs`（他の用途の AAD と混ざらないため）
 * 2. format_version（10 進）
 * 3. key_id
 * 4. owner_table
 * 5. owner_id
 * 6. owner_version（10 進、先頭の 0 なし）
 * 7. purpose
 * 長さ付きなので、欄の境界をずらした別の値（例 "ab"+"c" と "a"+"bc"）が同じバイト列にならない。
 */
export function sealedBlobAad(
  owner: SealedBlobOwner,
  formatVersion: number,
  keyId: string,
): Buffer {
  if (!isValidOwner(owner)) throw new RangeError('owner is invalid');
  if (!Number.isSafeInteger(formatVersion) || formatVersion < 1)
    throw new RangeError('format version is invalid');
  if (!isValidKeyId(keyId)) throw new RangeError('key id is invalid');
  return Buffer.concat([
    field(AAD_LABEL),
    field(String(formatVersion)),
    field(keyId),
    field(owner.ownerTable),
    field(owner.ownerId),
    field(String(owner.ownerVersion)),
    field(owner.purpose),
  ]);
}

/**
 * 平文を暗号化して封筒にする。nonce は呼び出しごとに 12 バイトの暗号論的乱数で作る。
 * 同じ鍵での nonce の重複は、DB の UNIQUE (key_id, nonce) でも拒否される（ADR 0010）。
 */
export function sealBlob(
  dataKey: DataKeyMaterial,
  plaintext: Uint8Array,
  owner: SealedBlobOwner,
): SealResult {
  const material = readKey(dataKey);
  if (typeof material === 'string') return { ok: false, reason: material };
  if (!isValidOwner(owner)) return { ok: false, reason: 'owner_invalid' };
  if (
    !(plaintext instanceof Uint8Array) ||
    plaintext.length > SEALED_BLOB_MAX_PLAINTEXT_BYTES
  )
    return { ok: false, reason: 'plaintext_invalid' };
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const aad = sealedBlobAad(owner, SEALED_BLOB_FORMAT_VERSION, material.keyId);
  const { ciphertext, tag } = aes256GcmEncrypt(
    material.key,
    nonce,
    plaintext,
    aad,
  );
  return {
    ok: true,
    envelope: {
      formatVersion: SEALED_BLOB_FORMAT_VERSION,
      keyId: material.keyId,
      nonce,
      ciphertext,
      tag,
    },
  };
}

/**
 * 封筒を復号する。所有者は DB の行の値ではなく、呼び出し側が読もうとしている行（表・ID・版・用途）を渡す。
 * 認証に失敗したら平文を返さない。
 */
export function openBlob(
  dataKey: DataKeyMaterial,
  envelope: SealedEnvelope,
  owner: SealedBlobOwner,
): OpenResult {
  const material = readKey(dataKey);
  if (typeof material === 'string') return { ok: false, reason: 'key_invalid' };
  if (!isValidOwner(owner)) return { ok: false, reason: 'owner_invalid' };
  if (envelope === null || typeof envelope !== 'object')
    return { ok: false, reason: 'envelope_invalid' };
  const { formatVersion, keyId, nonce, ciphertext, tag } = envelope;
  if (
    !(nonce instanceof Uint8Array) ||
    nonce.length !== AES_GCM_NONCE_BYTES ||
    !(tag instanceof Uint8Array) ||
    tag.length !== AES_GCM_TAG_BYTES ||
    !(ciphertext instanceof Uint8Array) ||
    typeof keyId !== 'string' ||
    typeof formatVersion !== 'number'
  )
    return { ok: false, reason: 'envelope_invalid' };
  if (formatVersion !== SEALED_BLOB_FORMAT_VERSION)
    return { ok: false, reason: 'format_version_unsupported' };
  if (keyId !== material.keyId) return { ok: false, reason: 'key_id_mismatch' };
  const aad = sealedBlobAad(owner, formatVersion, keyId);
  const plaintext = aes256GcmDecrypt(material.key, nonce, ciphertext, tag, aad);
  if (plaintext === null) return { ok: false, reason: 'authentication_failed' };
  return { ok: true, plaintext };
}

/**
 * データ鍵の取得元。@buddy/platform の KeyStore（loadDataKey）はこの形を満たす。
 * storage は platform に依存しないため、形だけを定める。
 */
export interface DataKeyProvider {
  loadDataKey(): Promise<
    | { readonly ok: true; readonly dataKey: DataKeyMaterial }
    | { readonly ok: false; readonly reason: string }
  >;
}

export interface DataKeyUnavailable {
  readonly ok: false;
  readonly reason: 'data_key_unavailable';
  /** KeyStore の理由コード。コードの形でない値は unknown にする。 */
  readonly detail: string;
}

const REASON_CODE = /^[a-z0-9_:.-]{1,128}$/u;

async function loadKey(
  provider: DataKeyProvider,
): Promise<
  { readonly ok: true; readonly dataKey: DataKeyMaterial } | DataKeyUnavailable
> {
  const unavailable = (detail: unknown): DataKeyUnavailable => ({
    ok: false,
    reason: 'data_key_unavailable',
    detail:
      typeof detail === 'string' && REASON_CODE.test(detail)
        ? detail
        : 'unknown',
  });
  let result: Awaited<ReturnType<DataKeyProvider['loadDataKey']>>;
  try {
    result = await provider.loadDataKey();
  } catch {
    return unavailable('provider_failed');
  }
  if (result === null || typeof result !== 'object')
    return unavailable('provider_result_invalid');
  if (result.ok === true) return { ok: true, dataKey: result.dataKey };
  return unavailable(
    result.ok === false ? result.reason : 'provider_result_invalid',
  );
}

/**
 * KeyStore から鍵を取得して暗号化する。鍵を取得できなければ暗号化せず data_key_unavailable を返す
 * （平文の保存へ切り替えない。設計 02・08 §5）。
 */
export async function sealWithDataKeyProvider(
  provider: DataKeyProvider,
  plaintext: Uint8Array,
  owner: SealedBlobOwner,
): Promise<SealResult | DataKeyUnavailable> {
  const loaded = await loadKey(provider);
  if (!loaded.ok) return loaded;
  return sealBlob(loaded.dataKey, plaintext, owner);
}

/** KeyStore から鍵を取得して復号する。鍵を取得できなければ復号しない。 */
export async function openWithDataKeyProvider(
  provider: DataKeyProvider,
  envelope: SealedEnvelope,
  owner: SealedBlobOwner,
): Promise<OpenResult | DataKeyUnavailable> {
  const loaded = await loadKey(provider);
  if (!loaded.ok) return loaded;
  return openBlob(loaded.dataKey, envelope, owner);
}
