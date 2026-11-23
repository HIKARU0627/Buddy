// 中枢（Core の HTTPS）への通信の口と、Node の https による実装（ADR 0143）。
//
// - ピン留めはデスクトップの hub-transport と同じ: 信頼の起点を中枢の証明書 1 枚に限り（ca）、
//   checkServerIdentity で証明書の DER 全体の SHA-256 を指紋と照合する。合わなければ要求を 1 バイトも送らない。
//   連鎖の検証は無効にしない（rejectUnauthorized は既定の true）。
// - 端末トークンは Authorization ヘッダーにだけ入れる。結果・例外・ログに入れない。
// - 試験では模擬の実装を渡す（この口が境界）。

import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:tls';
import type { PeerCertificate } from 'node:tls';

export interface CoreTransportRequest {
  readonly method: 'GET' | 'POST' | 'PUT';
  // /v1/... のパス（クエリーを含む）。
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
  // 端末トークン。認証前の経路（ペアリングの申請・受取り）では null。
  readonly deviceToken: string | null;
  // 要求の起点。ブリッジが付けるのは chat だけ（screen と申告しない。型でも screen を出せなくする。ADR 0143）。
  readonly inputOrigin?: 'chat';
  // ロック状態の申告（Buddy-Lock-State）。ブリッジは画面を持たない常駐の端末として unlocked を申告する（ADR 0143）。
  readonly lockState?: 'unlocked';
}

export type CoreTransportOutcome =
  // 中枢が応答した（2xx 以外も含む）。本文は JSON として読めなければ null。
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly body: unknown;
    }
  // 接続できない・時間切れ・応答の前に切れた。命令なら成否不明（自動で再送しない）。
  | { readonly kind: 'unreachable'; readonly reason: string }
  // 中枢の証明書がピン留めした指紋と違う。要求は 1 バイトも送っていない。
  | { readonly kind: 'certificate_mismatch' };

export type PeerCertificateOutcome =
  | {
      readonly kind: 'ok';
      readonly certificatePem: string;
      // 証明書の DER 全体の SHA-256 の小文字の 16 進。
      readonly fingerprint: string;
    }
  | { readonly kind: 'unreachable'; readonly reason: string };

export interface CoreTransport {
  request(request: CoreTransportRequest): Promise<CoreTransportOutcome>;
  // ペアリングの最初の接続（ADR 0021 と同じ）。何も書かずに証明書を読んだら閉じる。
  fetchPeerCertificate(): Promise<PeerCertificateOutcome>;
}

export interface HubEndpoint {
  readonly host: string;
  readonly port: number;
  // ピン留めした中枢の証明書（PEM）と指紋。ペアリング前は null（request は使わず fetchPeerCertificate だけを使う）。
  readonly certificatePem: string | null;
  readonly fingerprint: string | null;
}

export const CORE_REQUEST_TIMEOUT_MS = 10_000;
// 中枢の応答の上限（デスクトップと同じ 4 MiB。超えたら読むのをやめて接続できない扱い）。
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function certificateFingerprint(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex');
}

// 応答の本文を JSON として読む。読めなければ null（中枢の応答は契約で JSON）。
function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// 失敗の理由のコード（宛先・トークンを含めない。hub-transport と同じ絞り方）。
function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code)) return code;
  if (error instanceof Error && /^[a-z0-9_]{1,64}$/u.test(error.message))
    return error.message;
  return 'connection_failed';
}

class CertificateMismatchError extends Error {
  constructor() {
    super('certificate_mismatch');
    this.name = 'CertificateMismatchError';
  }
}

export function createHttpsCoreTransport(endpoint: HubEndpoint): CoreTransport {
  const fetchPeerCertificate = (): Promise<PeerCertificateOutcome> =>
    new Promise((resolve) => {
      let settled = false;
      const socket = connect({
        host: endpoint.host,
        port: endpoint.port,
        minVersion: 'TLSv1.3',
        // この接続だけ検証を無効にする（何も送らないので、なりすましの中枢に渡る情報はない。ADR 0021）。
        rejectUnauthorized: false,
      });
      const finish = (outcome: PeerCertificateOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(outcome);
      };
      const timer = setTimeout(
        () =>
          finish({ kind: 'unreachable', reason: 'certificate_fetch_timeout' }),
        CORE_REQUEST_TIMEOUT_MS,
      );
      timer.unref();
      socket.once('secureConnect', () => {
        const certificate = socket.getPeerX509Certificate();
        if (certificate === undefined) {
          finish({ kind: 'unreachable', reason: 'certificate_missing' });
          return;
        }
        finish({
          kind: 'ok',
          certificatePem: certificate.toString(),
          fingerprint: certificateFingerprint(certificate.raw),
        });
      });
      socket.once('error', (error) =>
        finish({ kind: 'unreachable', reason: reasonOf(error) }),
      );
    });

  const request = (
    outgoing: CoreTransportRequest,
  ): Promise<CoreTransportOutcome> => {
    if (endpoint.certificatePem === null || endpoint.fingerprint === null)
      return Promise.resolve({
        kind: 'unreachable',
        reason: 'hub_not_pinned',
      });
    const pinnedPem = endpoint.certificatePem;
    const pinnedFingerprint = endpoint.fingerprint;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: CoreTransportOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(
        () => finish({ kind: 'unreachable', reason: 'request_timeout' }),
        CORE_REQUEST_TIMEOUT_MS,
      );
      timer.unref();
      const body =
        outgoing.body === undefined
          ? undefined
          : Buffer.from(JSON.stringify(outgoing.body), 'utf8');
      const req = httpsRequest(
        {
          host: endpoint.host,
          port: endpoint.port,
          method: outgoing.method,
          path: outgoing.path,
          ca: [pinnedPem],
          minVersion: 'TLSv1.3',
          rejectUnauthorized: true,
          checkServerIdentity: (
            _host: string,
            certificate: PeerCertificate,
          ): Error | undefined =>
            certificateFingerprint(certificate.raw) === pinnedFingerprint
              ? undefined
              : new CertificateMismatchError(),
          headers: {
            ...(outgoing.deviceToken === null
              ? {}
              : { authorization: `Bearer ${outgoing.deviceToken}` }),
            ...(outgoing.inputOrigin === undefined
              ? {}
              : { 'buddy-input-origin': outgoing.inputOrigin }),
            ...(outgoing.lockState === undefined
              ? {}
              : { 'buddy-lock-state': outgoing.lockState }),
            ...(body === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': String(body.length),
                }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) {
              req.destroy();
              finish({ kind: 'unreachable', reason: 'response_too_large' });
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            finish({
              kind: 'response',
              status: response.statusCode ?? 0,
              body: parseJsonBody(Buffer.concat(chunks).toString('utf8')),
            });
          });
          response.on('error', (error) =>
            finish({ kind: 'unreachable', reason: reasonOf(error) }),
          );
        },
      );
      req.on('error', (error) => {
        if (
          error instanceof CertificateMismatchError ||
          (error instanceof Error && error.message === 'certificate_mismatch')
        ) {
          finish({ kind: 'certificate_mismatch' });
          return;
        }
        // checkServerIdentity の不一致は TLS の警告として届く場合がある（コードで見分ける）。
        const code = (error as { code?: unknown }).code;
        if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
          finish({ kind: 'certificate_mismatch' });
          return;
        }
        finish({ kind: 'unreachable', reason: reasonOf(error) });
      });
      req.end(body);
    });
  };

  return { request, fetchPeerCertificate };
}
