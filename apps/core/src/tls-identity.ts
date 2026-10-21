// 中枢の TLS の身元（秘密鍵と自己署名証明書）の読み込みと初回作成（設計 02、ADR 0020）。
//
// - 秘密鍵は KeyStore（キーチェーンの tls-key-v1）にだけ置き、平文をディスクに書かない。
// - 証明書（公開部分）はデータディレクトリの tls-certificate.pem に置く（0600、アトミックに置き換える）。
// - 鍵がなければ鍵と証明書を作る。鍵があって証明書がなければ、同じ鍵で証明書を作り直す。
//   どちらも指紋が変わるので、全端末の再登録が必要になる（作り直したことを結果で返す）。
// - 鍵と証明書が合わない・証明書が読めない・鍵が読めないときは、上書きせずに拒否する。
// 鍵保護が使えなければ HTTPS を開かない（呼び出し側が起動を拒否する）。

import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { TlsKeyStore, TlsPrivateKey } from '@buddy/platform';
import { writeFileAtomic } from './data-dir.js';
import {
  certificateFingerprint,
  certificateFromPem,
  certificateReasons,
  certificateToPem,
  createSelfSignedCertificate,
} from './tls-certificate.js';

export const TLS_CERTIFICATE_FILE = 'tls-certificate.pem';
// 証明書の PEM の上限（読み込み時）。P-256 の自己署名証明書は 1 KiB に満たない。
const MAX_CERTIFICATE_FILE_BYTES = 16_384;

export type TlsIdentityCreation =
  // 既存の鍵と証明書をそのまま使った。
  | 'existing'
  // 既存の鍵で証明書を作り直した（指紋が変わる）。
  | 'certificate'
  // 鍵と証明書を作った（初回、または鍵がなくなっていた。指紋が変わる）。
  | 'key_and_certificate';

export interface TlsIdentity {
  readonly certificateDer: Buffer;
  readonly certificatePem: string;
  // 証明書の DER 全体の SHA-256 の小文字の 16 進（ADR 0020）。
  readonly fingerprint: string;
  readonly privateKey: TlsPrivateKey;
  readonly creation: TlsIdentityCreation;
}

export class TlsIdentityError extends Error {
  readonly reason: string;
  readonly reasons: readonly string[];
  constructor(reason: string, reasons: readonly string[] = [reason]) {
    super(`${reason}: ${reasons.join(', ')}`);
    this.name = 'TlsIdentityError';
    this.reason = reason;
    this.reasons = reasons;
  }
}

async function readCertificateFile(dataDir: string): Promise<Buffer | null> {
  let text: string;
  try {
    const handle = await open(join(dataDir, TLS_CERTIFICATE_FILE), 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_CERTIFICATE_FILE_BYTES)
        throw new TlsIdentityError('tls_certificate_invalid');
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof TlsIdentityError) throw error;
    throw new TlsIdentityError('tls_certificate_invalid', [
      'tls_certificate_unreadable',
    ]);
  }
  const der = certificateFromPem(text);
  if (der === null) throw new TlsIdentityError('tls_certificate_invalid');
  return der;
}

export interface LoadTlsIdentityOptions {
  readonly dataDir: string;
  readonly tlsKeyStore: TlsKeyStore;
  readonly now: Date;
}

export async function loadOrCreateTlsIdentity(
  options: LoadTlsIdentityOptions,
): Promise<TlsIdentity> {
  const existing = await readCertificateFile(options.dataDir);
  let loaded = await options.tlsKeyStore.loadTlsKey().catch(() => null);
  if (loaded === null)
    throw new TlsIdentityError('tls_key_unavailable', [
      'tls_key_unavailable:load_failed',
    ]);
  let keyCreated = false;
  if (!loaded.ok && loaded.reason === 'tls_key_missing') {
    loaded = await options.tlsKeyStore.loadOrCreateTlsKey().catch(() => null);
    if (loaded === null)
      throw new TlsIdentityError('tls_key_unavailable', [
        'tls_key_unavailable:create_failed',
      ]);
    keyCreated = loaded.ok && loaded.created;
  }
  if (!loaded.ok)
    throw new TlsIdentityError('tls_key_unavailable', [
      `tls_key_unavailable:${loaded.reason}`,
    ]);
  const privateKey = loaded.privateKey;
  const publicKey = privateKey.publicKey();

  if (existing !== null && !keyCreated) {
    const reasons = certificateReasons(
      existing,
      privateKey.keyObject,
      publicKey,
      options.now,
    );
    if (reasons.length > 0)
      throw new TlsIdentityError(
        reasons.includes('certificate_key_mismatch')
          ? 'tls_certificate_mismatch'
          : 'tls_certificate_invalid',
        reasons,
      );
    return {
      certificateDer: existing,
      certificatePem: certificateToPem(existing),
      fingerprint: certificateFingerprint(existing),
      privateKey,
      creation: 'existing',
    };
  }

  const der = createSelfSignedCertificate(privateKey.keyObject, publicKey, {
    now: options.now,
  });
  const reasons = certificateReasons(
    der,
    privateKey.keyObject,
    publicKey,
    options.now,
  );
  if (reasons.length > 0)
    throw new TlsIdentityError('tls_certificate_invalid', reasons);
  const pem = certificateToPem(der);
  try {
    await writeFileAtomic(options.dataDir, TLS_CERTIFICATE_FILE, pem);
  } catch {
    throw new TlsIdentityError('tls_certificate_write_failed');
  }
  return {
    certificateDer: der,
    certificatePem: pem,
    fingerprint: certificateFingerprint(der),
    privateKey,
    creation: keyCreated ? 'key_and_certificate' : 'certificate',
  };
}
