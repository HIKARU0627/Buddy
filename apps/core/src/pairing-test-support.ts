// ペアリングの試験で使う道具（試験専用。index.ts から export しない。ADR 0021）。
//
// 登録前の端末（試験用のクライアント）の流れ:
//   1. 最初の接続で中枢の証明書を受け取る（fetchPeerCertificate）。この接続では HTTP の要求を 1 バイトも
//      書かず、証明書を読んだらすぐ閉じる。証明書の検証の結果はこの接続の信頼に使わない。
//   2. 受け取った証明書の指紋（DER 全体の SHA-256）を、本人が中枢の画面・CLI の表示と比べたとみなす。
//      違えば申請しない（requireFingerprint）。
//   3. 受け取った証明書を信頼の起点（ca）にし、比べた指紋でピン留めした新しい接続で申請する
//      （api-test-support の pinnedRequest。証明書の検証は無効にしない）。
// 申請用の秘密・トークンは試験の中で作る合成の値で、アサーションのメッセージ・出力に入れない。

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { connect } from 'node:tls';
import { pinnedRequest, sha256Hex } from './api-test-support.js';
import type { ApiResponse, PinnedTarget } from './api-test-support.js';

export interface PeerCertificate {
  readonly certificatePem: string;
  // 試験側で求めた指紋（DER 全体の SHA-256 の小文字の 16 進）。
  readonly fingerprint: string;
}

// 最初の接続: TLS の確立で見えた証明書だけを受け取り、何も書かずに閉じる。
export function fetchPeerCertificate(
  host: string,
  port: number,
): Promise<PeerCertificate> {
  return new Promise((resolve, reject) => {
    // この接続は証明書を受け取るためだけに使い、要求を送らない。信頼の判断は本人の指紋の比較で行う。
    const socket = connect({
      host,
      port,
      minVersion: 'TLSv1.3',
      rejectUnauthorized: false,
    });
    let settled = false;
    const finish = (result: PeerCertificate | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error('certificate_fetch_timeout')),
      10_000,
    );
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerX509Certificate();
      if (certificate === undefined) {
        finish(new Error('certificate_missing'));
        return;
      }
      finish({
        certificatePem: certificate.toString(),
        fingerprint: sha256Hex(certificate.raw),
      });
    });
    socket.once('error', (error) => finish(error));
    socket.once('close', () => finish(new Error('closed_before_secure')));
  });
}

// 本人が比べた指紋と、最初の接続で見えた指紋が同じときだけ、申請の接続先を返す。
export function requireFingerprint(
  host: string,
  port: number,
  peer: PeerCertificate,
  confirmedFingerprint: string,
): PinnedTarget {
  if (peer.fingerprint !== confirmedFingerprint)
    throw new Error('certificate_fingerprint_not_confirmed');
  return {
    host,
    port,
    certificatePem: peer.certificatePem,
    fingerprint: confirmedFingerprint,
  };
}

export interface ClaimSecret {
  // 申請用の秘密（256 ビットの base64url）。出力に入れない。
  readonly secret: string;
  // 試験側で求めた SHA-256（ASCII の 43 文字）。
  readonly hash: string;
}

export function createClaimSecret(): ClaimSecret {
  const secret = randomBytes(32).toString('base64url');
  return {
    secret,
    hash: createHash('sha256').update(secret, 'ascii').digest('hex'),
  };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export function claimPairing(
  target: PinnedTarget,
  code: string,
  secret: ClaimSecret,
  options: { readonly name?: string; readonly platform?: string } = {},
): Promise<ApiResponse> {
  return pinnedRequest(target, {
    method: 'POST',
    path: '/v1/pairing/claims',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      request_id: randomUUID(),
      pairing_code: code,
      device_name: options.name ?? '合成の端末',
      platform: options.platform ?? 'windows',
      claim_secret_hash: secret.hash,
    }),
  });
}

export function pickupToken(
  target: PinnedTarget,
  claimId: string,
  secret: string,
): Promise<ApiResponse> {
  return pinnedRequest(target, {
    method: 'POST',
    path: `/v1/pairing/claims/${claimId}/token`,
    headers: JSON_HEADERS,
    body: JSON.stringify({ claim_secret: secret }),
  });
}

// 端末トークンで認証した画面操作の要求（Buddy-Input-Origin: screen）。
export function screenRequest(
  target: PinnedTarget,
  token: string,
  method: string,
  path: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<ApiResponse> {
  return pinnedRequest(target, {
    method,
    path,
    headers: {
      authorization: `Bearer ${token}`,
      'buddy-input-origin': 'screen',
      ...(body === undefined ? {} : JSON_HEADERS),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// 本文の中に秘密の値が出ていないか（出力しないよう、真偽だけを返す）。
export function containsAny(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.length > 0 && text.includes(secret));
}
