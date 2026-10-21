// 中枢の自己署名証明書（設計 02 端末登録と接続、ADR 0020）。
//
// - 鍵は ECDSA P-256（KeyStore の tls-key-v1）。署名は ecdsa-with-SHA256。
// - DER を自前で組み立て（der.ts）、node:crypto の sign で署名し、X509Certificate で読み戻して検証する。
// - 端末は証明書の指紋でピン留めする。指紋は証明書の DER 全体の SHA-256 の小文字の 16 進 64 桁
//   （契約の Hash、PairingSession.certificate_fingerprint）。
// - 宛先（IP アドレス・名前）を証明書に入れない。端末は名前の検証ではなく指紋で照合するため、
//   Tailscale のアドレスが変わっても証明書（指紋）は変わらない。
// - 有効期限は RFC 5280 §4.1.2.5 の「期限を定めない」値（9999-12-31T23:59:59Z）。証明書を作り直すと
//   指紋が変わり、全端末の再登録が必要になる。

import { X509Certificate, createHash, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  bitString,
  boolean,
  explicit,
  objectIdentifier,
  octetString,
  sequence,
  set,
  smallInteger,
  unsignedInteger,
  utf8String,
  x509Time,
} from './der.js';

export const CERTIFICATE_COMMON_NAME = 'Buddy Core';
// RFC 5280 §4.1.2.5 の期限を定めない値。
export const CERTIFICATE_NOT_AFTER = new Date(
  Date.UTC(9999, 11, 31, 23, 59, 59),
);
// 端末の時計が少し遅れていても「まだ有効でない」にならないよう、開始を 1 日前にする。
export const CERTIFICATE_BACKDATE_MS = 86_400_000;

const OID = {
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectKeyIdentifier: '2.5.29.14',
  serverAuth: '1.3.6.1.5.5.7.3.1',
} as const;

const FINGERPRINT = /^[0-9a-f]{64}$/u;

// 証明書の指紋: DER 全体の SHA-256 の小文字の 16 進（ADR 0020）。
export function certificateFingerprint(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex');
}

export function isCertificateFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT.test(value);
}

export interface SelfSignedCertificateOptions {
  readonly now: Date;
  // 試験用。省略時は 16 バイトの乱数（正の数になるよう先頭のビットを調整する）。
  readonly serial?: Uint8Array;
}

function randomSerial(): Buffer {
  const serial = randomBytes(16);
  // 正の数で、先頭のバイトが 0 にならない（DER の最小表現を 16 バイトに保つ）。
  serial[0] = ((serial[0] as number) & 0x7f) | 0x40;
  return serial;
}

// 自己署名証明書の DER を作る。privateKey は P-256 の秘密鍵。
export function createSelfSignedCertificate(
  privateKey: KeyObject,
  publicKey: KeyObject,
  options: SelfSignedCertificateOptions,
): Buffer {
  const notBefore = new Date(
    Math.floor((options.now.getTime() - CERTIFICATE_BACKDATE_MS) / 1000) * 1000,
  );
  const algorithm = sequence(objectIdentifier(OID.ecdsaWithSha256));
  const name = sequence(
    set(
      sequence(
        objectIdentifier(OID.commonName),
        utf8String(CERTIFICATE_COMMON_NAME),
      ),
    ),
  );
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // subjectKeyIdentifier は RFC 5280 §4.2.1.2 の方法 1（公開鍵の BIT STRING の SHA-1）に代えて
  // SPKI 全体の SHA-256 の先頭 20 バイトにする（識別用で、検証には使われない）。
  const keyId = createHash('sha256').update(spki).digest().subarray(0, 20);
  const extensions = sequence(
    // 基本制約: CA ではない（cA は既定の FALSE なので空の SEQUENCE）。重要。
    sequence(
      objectIdentifier(OID.basicConstraints),
      boolean(true),
      octetString(sequence()),
    ),
    // 鍵の用途: digitalSignature だけ（BIT STRING の先頭ビット、未使用 7 ビット）。重要。
    sequence(
      objectIdentifier(OID.keyUsage),
      boolean(true),
      octetString(bitString(Buffer.from([0x80]), 7)),
    ),
    // 拡張鍵用途: TLS のサーバー認証だけ。
    sequence(
      objectIdentifier(OID.extKeyUsage),
      octetString(sequence(objectIdentifier(OID.serverAuth))),
    ),
    sequence(
      objectIdentifier(OID.subjectKeyIdentifier),
      octetString(octetString(keyId)),
    ),
  );
  const tbs = sequence(
    explicit(0, smallInteger(2)),
    unsignedInteger(options.serial ?? randomSerial()),
    algorithm,
    name,
    sequence(x509Time(notBefore), x509Time(CERTIFICATE_NOT_AFTER)),
    name,
    spki,
    explicit(3, extensions),
  );
  const signature = sign('sha256', tbs, {
    key: privateKey,
    dsaEncoding: 'der',
  });
  return sequence(tbs, algorithm, bitString(signature));
}

export type CertificateCheckReason =
  | 'certificate_unreadable'
  | 'certificate_signature_invalid'
  | 'certificate_key_mismatch'
  | 'certificate_not_self_issued'
  | 'certificate_is_ca'
  | 'certificate_not_yet_valid'
  | 'certificate_expired';

// 証明書を読み戻し、この秘密鍵の自己署名証明書として使えるかを確かめる。理由コードだけを返す。
export function certificateReasons(
  der: Uint8Array,
  privateKey: KeyObject,
  publicKey: KeyObject,
  now: Date,
): CertificateCheckReason[] {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(der);
  } catch {
    return ['certificate_unreadable'];
  }
  const reasons: CertificateCheckReason[] = [];
  const spki = (key: KeyObject) => key.export({ type: 'spki', format: 'der' });
  if (
    !certificate.checkPrivateKey(privateKey) ||
    !spki(certificate.publicKey).equals(spki(publicKey))
  )
    reasons.push('certificate_key_mismatch');
  if (!certificate.verify(publicKey))
    reasons.push('certificate_signature_invalid');
  if (certificate.issuer !== certificate.subject)
    reasons.push('certificate_not_self_issued');
  if (certificate.ca) reasons.push('certificate_is_ca');
  if (Date.parse(certificate.validFrom) > now.getTime())
    reasons.push('certificate_not_yet_valid');
  if (Date.parse(certificate.validTo) <= now.getTime())
    reasons.push('certificate_expired');
  return reasons;
}

export function certificateToPem(der: Uint8Array): string {
  const base64 = Buffer.from(der).toString('base64');
  const lines = base64.match(/.{1,64}/gu) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

// PEM の証明書 1 枚を DER にする。読めなければ null。
export function certificateFromPem(text: string): Buffer | null {
  const match =
    /^-----BEGIN CERTIFICATE-----\n([A-Za-z0-9+/=\n]+)\n-----END CERTIFICATE-----\n?$/u.exec(
      text,
    );
  if (!match) return null;
  const der = Buffer.from((match[1] as string).replace(/\n/gu, ''), 'base64');
  try {
    return Buffer.from(new X509Certificate(der).raw);
  } catch {
    return null;
  }
}
