// AES-256-GCM の薄い包み（設計 02「標準暗号ライブラリによる AES-256-GCM」、ADR 0017）。
// node:crypto（OpenSSL）だけを使い、独自の暗号は作らない。nonce は 12 バイト、認証タグは 16 バイトに固定する。
// nonce を呼び出し側が渡すこの関数は公開出口（index.ts）に出さない。製品の暗号化は sealed-blob.ts の
// sealBlob を使い、nonce は毎回暗号論的乱数で作る（nonce を再利用しない）。
import { createCipheriv, createDecipheriv } from 'node:crypto';

export const AES_256_GCM_KEY_BYTES = 32;
export const AES_GCM_NONCE_BYTES = 12;
export const AES_GCM_TAG_BYTES = 16;

const ALGORITHM = 'aes-256-gcm';

function checkLength(name: string, value: Uint8Array, bytes: number): void {
  // 例外のメッセージには長さの条件だけを入れ、値は入れない。
  if (!(value instanceof Uint8Array) || value.length !== bytes)
    throw new RangeError(`${name} must be ${bytes} bytes`);
}

export function aes256GcmEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): { readonly ciphertext: Buffer; readonly tag: Buffer } {
  checkLength('key', key, AES_256_GCM_KEY_BYTES);
  checkLength('nonce', nonce, AES_GCM_NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, {
    authTagLength: AES_GCM_TAG_BYTES,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

/**
 * 復号する。認証（タグ・追加認証データ・鍵・nonce・暗号文の一致）に失敗したら null を返し、
 * 途中まで復号したバイト列も返さない。
 */
export function aes256GcmDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array,
): Buffer | null {
  checkLength('key', key, AES_256_GCM_KEY_BYTES);
  checkLength('nonce', nonce, AES_GCM_NONCE_BYTES);
  checkLength('tag', tag, AES_GCM_TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, nonce, {
    authTagLength: AES_GCM_TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const head = decipher.update(ciphertext);
  try {
    const tail = decipher.final();
    return Buffer.concat([head, tail]);
  } catch {
    // 認証に失敗した。update で得た未検証のバイト列は捨てる。
    head.fill(0);
    return null;
  }
}
