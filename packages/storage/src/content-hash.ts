// 確定 intent の内容 hash と、hash と暗号文を同じ正規形から作る封（設計 08 §2・§5、H01、ADR 0019）。
//
// - content_hash は確定 intent を RFC 8785（JCS）で表し、UTF-8 のバイト列に SHA-256 を適用した小文字の 16 進。
//   JCS は canonicalize 5.1.0（開発ツールの scripts/contract-tools.mjs と同じ版）、SHA-256 は node:crypto。
// - JSON の値として表せないもの（undefined・関数・BigInt・Date などのオブジェクト・孤立したサロゲート・
//   有限でない数・疎な配列）は、黙って落とさずに拒否する。JSON.stringify と同じように落とすと、承認した内容と
//   hash の対象がずれるため。Unicode の正規化（NFC など）はしない（content-hash-cases.json の label-nfc / nfd）。
// - DB worker は平文を受け取らない（ADR 0018）ため、hash は暗号化する側（Core main）で作る。
//   sealOperationIntent は同じ正規形のバイト列から hash と暗号文を作り、両者がずれないようにする。

import canonicalize from 'canonicalize';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { StorageError } from './errors.js';
import type { SealedBlobInput } from './operation-commands.js';
import { openBlob, sealBlob } from './sealed-blob.js';
import type {
  DataKeyMaterial,
  OpenFailureReason,
  SealFailureReason,
  SealedBlobOwner,
  SealedEnvelope,
} from './sealed-blob.js';

// 入れ子の上限（scripts/contract-tools.mjs の parseStrictJson と同じ 64）。
export const INTENT_MAX_DEPTH = 64;

export type IntentInvalidReason =
  | 'intent_not_object'
  | 'intent_not_json'
  | 'intent_number_not_finite'
  | 'intent_lone_surrogate'
  | 'intent_sparse_array'
  | 'intent_too_deep';

const HASH_TEXT = /^[0-9a-f]{64}$/u;

// 孤立したサロゲートを含まないか（UTF-8 へ往復して変わらないか）。sealed-blob.ts と同じ確かめ方。
function isWellFormedText(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// JSON の値として表せるかを確かめる。理由を返し、問題がなければ null。
function jsonValueReason(
  value: unknown,
  depth: number,
): IntentInvalidReason | null {
  if (depth > INTENT_MAX_DEPTH) return 'intent_too_deep';
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'string')
    return isWellFormedText(value) ? null : 'intent_lone_surrogate';
  if (typeof value === 'number')
    return Number.isFinite(value) ? null : 'intent_number_not_finite';
  if (typeof value !== 'object') return 'intent_not_json';
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) return 'intent_sparse_array';
      const reason = jsonValueReason(value[index], depth + 1);
      if (reason !== null) return reason;
    }
    return null;
  }
  // Date・Map・Buffer・クラスのインスタンス・toJSON を持つ値は、JSON に写すと形が変わるので受け付けない。
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0)
    return 'intent_not_json';
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function')
    return 'intent_not_json';
  for (const [key, item] of Object.entries(value)) {
    if (!isWellFormedText(key)) return 'intent_lone_surrogate';
    const reason = jsonValueReason(item, depth + 1);
    if (reason !== null) return reason;
  }
  return null;
}

// 確定 intent の JCS（RFC 8785）の正規形。intent はオブジェクトに限る。表せない値は StorageError で拒否する。
export function canonicalIntentJson(intent: unknown): string {
  if (intent === null || typeof intent !== 'object' || Array.isArray(intent))
    throw new StorageError(
      'intent_invalid',
      '確定 intent は JSON のオブジェクトにしてください。',
      ['intent_not_object'],
    );
  const reason = jsonValueReason(intent, 0);
  if (reason !== null)
    throw new StorageError(
      'intent_invalid',
      '確定 intent に JSON として表せない値があります。',
      [reason],
    );
  const canonical = canonicalize(intent);
  if (typeof canonical !== 'string')
    throw new StorageError(
      'intent_invalid',
      '確定 intent を正規化できません。',
      ['intent_not_json'],
    );
  return canonical;
}

// 正規形の UTF-8 のバイト列の SHA-256（小文字の 16 進）。
export function sha256OfCanonical(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// 確定 intent の content_hash（08 §2）。
export function intentContentHash(intent: unknown): string {
  return sha256OfCanonical(canonicalIntentJson(intent));
}

export interface OperationIntentTarget {
  readonly operationId: string;
  // 内容版（1 以上）。sealed_blobs の owner_version になる。
  readonly contentVersion: number;
}

// operation_versions の確定 intent の持ち主（operation-store.ts の createOperation の行と同じ）。
export function operationIntentOwner(
  target: OperationIntentTarget,
): SealedBlobOwner {
  return {
    ownerTable: 'operation_versions',
    ownerId: target.operationId,
    ownerVersion: target.contentVersion,
    purpose: 'operation_intent',
  };
}

export type SealOperationIntentResult =
  | {
      readonly ok: true;
      readonly content_hash: string;
      // operation.create の intent にそのまま渡せる sealed_blobs の行。
      readonly intent: SealedBlobInput;
    }
  | {
      readonly ok: false;
      readonly reason: SealFailureReason | 'intent_invalid';
      readonly detail: readonly string[];
    };

// 確定 intent を正規化し、そのバイト列から content_hash と暗号文（平文は正規形の UTF-8）を作る。
// 呼び出し側は戻り値の content_hash と intent をそのまま operation.create に入れる。
export function sealOperationIntent(
  dataKey: DataKeyMaterial,
  target: OperationIntentTarget,
  intent: unknown,
  blobId: string = randomUUID(),
): SealOperationIntentResult {
  let canonical: string;
  try {
    canonical = canonicalIntentJson(intent);
  } catch (error) {
    if (!(error instanceof StorageError)) throw error;
    return { ok: false, reason: 'intent_invalid', detail: error.reasons };
  }
  if (!Number.isSafeInteger(target.contentVersion) || target.contentVersion < 1)
    return { ok: false, reason: 'owner_invalid', detail: ['owner_invalid'] };
  const sealed = sealBlob(
    dataKey,
    Buffer.from(canonical, 'utf8'),
    operationIntentOwner(target),
  );
  if (!sealed.ok)
    return { ok: false, reason: sealed.reason, detail: [sealed.reason] };
  const envelope = sealed.envelope;
  return {
    ok: true,
    content_hash: sha256OfCanonical(canonical),
    intent: {
      blob_id: blobId,
      format_version: envelope.formatVersion,
      key_id: envelope.keyId,
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
      tag: envelope.tag,
    },
  };
}

export type OpenOperationIntentResult =
  | {
      readonly ok: true;
      // 復号した正規形（JCS）の文字列。
      readonly canonical: string;
      readonly content_hash: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | OpenFailureReason
        | 'intent_not_canonical'
        | 'content_hash_invalid'
        | 'content_hash_mismatch';
    };

// 保存した確定 intent を復号し、正規形であることと、保存した content_hash と一致することを確かめる。
// 一致しなければ平文を返さない。
export function openOperationIntent(
  dataKey: DataKeyMaterial,
  target: OperationIntentTarget,
  envelope: SealedEnvelope,
  expectedContentHash: string,
): OpenOperationIntentResult {
  if (
    typeof expectedContentHash !== 'string' ||
    !HASH_TEXT.test(expectedContentHash)
  )
    return { ok: false, reason: 'content_hash_invalid' };
  const opened = openBlob(dataKey, envelope, operationIntentOwner(target));
  if (!opened.ok) return opened;
  let canonical: string;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      opened.plaintext,
    );
    if (canonicalIntentJson(JSON.parse(text)) !== text)
      return { ok: false, reason: 'intent_not_canonical' };
    canonical = text;
  } catch {
    return { ok: false, reason: 'intent_not_canonical' };
  }
  const actual = sha256OfCanonical(canonical);
  if (
    !timingSafeEqual(
      Buffer.from(actual, 'hex'),
      Buffer.from(expectedContentHash, 'hex'),
    )
  )
    return { ok: false, reason: 'content_hash_mismatch' };
  return { ok: true, canonical, content_hash: actual };
}
