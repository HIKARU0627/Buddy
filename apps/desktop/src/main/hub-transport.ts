// 中枢との通信（TLS のピン留め・HTTPS・WSS）（設計 02 端末登録と接続、ADR 0020・0021・0023・0025）。
//
// - 登録した中枢へは、TLS 1.3 の確立で中枢が示した証明書が、登録の時に本人が指紋を確かめた証明書と DER で完全に
//   同じで、DER 全体の SHA-256 が指紋と同じときだけ要求を書く（証明書の完全一致のピン留め）。合わなければ要求を
//   1 バイトも送らない。TLS の確立では中枢がその証明書の秘密鍵を持つこと（CertificateVerify）を TLS が確かめる。
// - 信頼の起点（ca）による証明書の連鎖の検証は使わない。Electron の BoringSSL は、CA でない自己署名の証明書
//   （ADR 0020 の中枢の証明書。基本制約 CA:FALSE）を信頼の起点として受け付けず、ピン留めした中枢でも
//   UNABLE_TO_VERIFY_LEAF_SIGNATURE になるため（Node の OpenSSL では通る。ADR 0025 の読み取り）。
//   完全一致のピン留めは連鎖の検証より狭い（その 1 枚だけを受け付ける）。この扱いはこのモジュールの接続だけで、
//   アプリ全体（NODE_TLS_REJECT_UNAUTHORIZED・既定のエージェント）の検証は変えない。
// - ペアリングの最初の接続（fetchPeerCertificate）は、何も書かずに証明書を読んだら閉じる（ADR 0021）。
// - 端末トークンは Authorization ヘッダーにだけ入れ、結果・例外・ログに入れない。
// Electron に依存しない（node:test で 127.0.0.1 の中枢・模擬のサーバーと試験する）。

import { X509Certificate, createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { isIPv6 } from 'node:net';
import { connect } from 'node:tls';
import type { TLSSocket } from 'node:tls';
import type {
  ClientApiOutcome,
  ClientApiRequest,
  ClientLockState,
  ClientStreamEvent,
  ClientStreamOpen,
  ClientTransport,
} from '@buddy/client';
import { WebSocket } from 'ws';
import type { ClientOptions } from 'ws';

// 登録の時に受け取り、本人が指紋を確かめた中枢。
export interface PinnedHub {
  readonly host: string;
  readonly port: number;
  // 信頼の起点にする中枢の証明書（PEM）。
  readonly certificatePem: string;
  // 証明書の DER 全体の SHA-256 の小文字の 16 進。
  readonly fingerprint: string;
}

export const HUB_REQUEST_TIMEOUT_MS = 10_000;
// 中枢の応答の上限（スナップショットを含む。超えたら読むのをやめて接続できない扱い）。
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// 中枢の WSS のメッセージの上限（中枢の 1 件のイベントは数百バイト）。
const MAX_STREAM_MESSAGE_BYTES = 1024 * 1024;

export function certificateFingerprint(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex');
}

// 証明書の検証の失敗（信頼の起点で検証できない・指紋が違う）か。
export class CertificateMismatchError extends Error {
  constructor() {
    super('certificate_mismatch');
    this.name = 'CertificateMismatchError';
  }
}

// 証明書の不一致（再登録が必要）として扱うか。ピン留めの照合（matchesPin）で合わなかったときだけ。
// 連鎖の検証はしない（rejectUnauthorized: false）ので、名前に CERT・SIGNATURE などを含む TLS・OpenSSL の
// エラーは通信の途中の不調・中継機器の干渉などで、中枢の証明書が変わった証拠にならない。それらは接続できない
// （unreachable）として待つ（レビューの指摘 L6）。
export function isCertificateMismatch(error: unknown): boolean {
  return error instanceof CertificateMismatchError;
}

// 失敗の理由のコード（宛先・トークンを含めない）。
function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code)) return code;
  if (error instanceof Error && /^[a-z0-9_]{1,64}$/u.test(error.message))
    return error.message;
  return 'connection_failed';
}

export type PeerCertificateResult =
  | {
      readonly ok: true;
      readonly certificatePem: string;
      readonly fingerprint: string;
    }
  | { readonly ok: false; readonly reason: string };

// ペアリングの最初の接続（ADR 0021）。TLS の確立で見えた証明書だけを受け取り、HTTP の要求を 1 バイトも
// 書かずに閉じる。この接続の検証の結果は信頼に使わず、指紋は本人が中枢の表示と比べる。
// rejectUnauthorized: false はこの接続だけ（何も送らないので、なりすましの中枢に渡る情報はない）。
export function fetchPeerCertificate(
  host: string,
  port: number,
  timeoutMs = HUB_REQUEST_TIMEOUT_MS,
): Promise<PeerCertificateResult> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({
      host,
      port,
      minVersion: 'TLSv1.3',
      rejectUnauthorized: false,
    });
    const finish = (result: PeerCertificateResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: 'certificate_fetch_timeout' }),
      timeoutMs,
    );
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerX509Certificate();
      if (certificate === undefined) {
        finish({ ok: false, reason: 'certificate_missing' });
        return;
      }
      finish({
        ok: true,
        certificatePem: certificate.toString(),
        fingerprint: certificateFingerprint(certificate.raw),
      });
    });
    socket.once('error', (error) =>
      finish({ ok: false, reason: reasonOf(error) }),
    );
    socket.once('close', () =>
      finish({ ok: false, reason: 'closed_before_secure' }),
    );
  });
}

// PEM の証明書の DER（ピン留めした証明書と、中枢が示した証明書を比べる）。
function pemDer(pem: string): Buffer | null {
  try {
    return new X509Certificate(pem).raw;
  } catch {
    return null;
  }
}

// 中枢が示した証明書がピン留めした証明書と同じか（DER の完全一致と指紋の一致）。
export function matchesPin(hub: PinnedHub, peerDer: Buffer): boolean {
  const pinned = pemDer(hub.certificatePem);
  return (
    pinned !== null &&
    pinned.equals(peerDer) &&
    certificateFingerprint(peerDer) === hub.fingerprint
  );
}

// TLS だけを接続し、ピン留めの照合が終わってから返す。失敗すれば例外（要求は書いていない）。
export function pinnedConnect(
  hub: PinnedHub,
  timeoutMs = HUB_REQUEST_TIMEOUT_MS,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // 連鎖の検証の代わりに、確立の後に証明書の完全一致を確かめる（上の注記）。照合の前には何も書かない。
    const socket = connect({
      host: hub.host,
      port: hub.port,
      minVersion: 'TLSv1.3',
      rejectUnauthorized: false,
    });
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(
        isCertificateMismatch(error)
          ? new CertificateMismatchError()
          : error instanceof Error
            ? error
            : new Error('connection_failed'),
      );
    };
    const timer = setTimeout(
      () => fail(new Error('tls_connect_timeout')),
      timeoutMs,
    );
    socket.once('secureConnect', () => {
      if (settled) return;
      const peer = socket.getPeerX509Certificate();
      if (
        socket.getProtocol() !== 'TLSv1.3' ||
        peer === undefined ||
        !matchesPin(hub, peer.raw)
      ) {
        fail(new CertificateMismatchError());
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', fail);
    socket.once('close', () => fail(new Error('tls_closed_before_secure')));
  });
}

export interface HubHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

// ピン留めの照合を終えた TLS の接続の上で HTTP の要求を 1 件送る（接続は閉じる）。
// 応答・失敗・時間切れのどれかで必ず終える。例外は投げない。
export async function hubRequest(
  hub: PinnedHub,
  request: HubHttpRequest,
  timeoutMs = HUB_REQUEST_TIMEOUT_MS,
): Promise<ClientApiOutcome> {
  let socket: TLSSocket;
  try {
    socket = await pinnedConnect(hub, timeoutMs);
  } catch (error) {
    if (error instanceof CertificateMismatchError)
      return { kind: 'certificate_mismatch' };
    return { kind: 'unreachable', reason: reasonOf(error) };
  }
  const body =
    request.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(request.body), 'utf8');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ClientApiOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const req = httpsRequest({
      createConnection: () => socket,
      host: hub.host,
      port: hub.port,
      method: request.method,
      path: request.path,
      headers: {
        connection: 'close',
        ...(body === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'content-length': String(body.length),
            }),
        ...request.headers,
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish({ kind: 'unreachable', reason: 'request_timeout' });
    }, timeoutMs);
    req.on('response', (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy();
          finish({ kind: 'unreachable', reason: 'response_too_large' });
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () =>
        finish({
          kind: 'response',
          status: response.statusCode ?? 0,
          body: parseJson(Buffer.concat(chunks)),
        }),
      );
      response.on('error', () =>
        finish({ kind: 'unreachable', reason: 'response_aborted' }),
      );
      response.on('close', () =>
        finish({ kind: 'unreachable', reason: 'response_closed' }),
      );
    });
    req.on('error', (error) =>
      finish({ kind: 'unreachable', reason: reasonOf(error) }),
    );
    req.on('close', () =>
      finish({ kind: 'unreachable', reason: 'request_closed' }),
    );
    req.end(body);
  });
}

function lockHeader(lockState: ClientLockState): Record<string, string> {
  // unknown は申告しない（中枢は解除済みと扱わない）。
  return lockState === 'unknown' ? {} : { 'buddy-lock-state': lockState };
}

function authority(host: string): string {
  return isIPv6(host) ? `[${host}]` : host;
}

export interface HubTransportOptions {
  readonly hub: PinnedHub;
  // 端末トークンを返す（呼ぶたびに読む。値をこの包みの外へ出さない）。
  readonly token: () => string;
  readonly timeoutMs?: number;
}

// 登録した端末の通信（@buddy/client の ClientTransport の実装）。
export function createHubTransport(
  options: HubTransportOptions,
): ClientTransport {
  const timeoutMs = options.timeoutMs ?? HUB_REQUEST_TIMEOUT_MS;
  const authHeaders = (lockState: ClientLockState) => ({
    authorization: `Bearer ${options.token()}`,
    ...lockHeader(lockState),
  });
  return {
    request(request: ClientApiRequest): Promise<ClientApiOutcome> {
      return hubRequest(
        options.hub,
        {
          method: request.method,
          path: request.path,
          headers: {
            ...authHeaders(request.lockState),
            ...(request.screenOperation === true
              ? { 'buddy-input-origin': 'screen' }
              : {}),
          },
          ...(request.body === undefined ? {} : { body: request.body }),
        },
        timeoutMs,
      );
    },

    async openStream(
      cursor: string,
      lockState: ClientLockState,
      listener: (event: ClientStreamEvent) => void,
    ): Promise<ClientStreamOpen> {
      let socket: TLSSocket;
      try {
        socket = await pinnedConnect(options.hub, timeoutMs);
      } catch (error) {
        if (error instanceof CertificateMismatchError)
          return { kind: 'certificate_mismatch' };
        return { kind: 'unreachable', reason: reasonOf(error) };
      }
      const url = `wss://${authority(options.hub.host)}:${options.hub.port}/v1/events/stream?cursor=${encodeURIComponent(cursor)}`;
      return new Promise((resolve) => {
        let settled = false;
        let opened = false;
        const ws = new WebSocket(url, {
          // 照合を終えた TLS の接続の上で切り替える（照合の前に要求を書かない）。
          createConnection: () => socket,
          headers: authHeaders(lockState),
          perMessageDeflate: false,
          handshakeTimeout: timeoutMs,
          maxPayload: MAX_STREAM_MESSAGE_BYTES,
        } as ClientOptions);
        const finish = (result: ClientStreamOpen) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        ws.once('open', () => {
          opened = true;
          finish({
            kind: 'open',
            stream: { close: () => ws.close(1000) },
          });
        });
        ws.once('unexpected-response', (req, response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            if (chunks.length < 64) chunks.push(chunk);
          });
          const done = () => {
            finish({
              kind: 'rejected',
              status: response.statusCode ?? 0,
              body: parseJson(Buffer.concat(chunks)),
            });
            req.destroy();
            socket.destroy();
          };
          response.once('end', done);
          response.once('error', done);
          response.once('close', done);
        });
        ws.on('error', (error) => {
          if (!opened) {
            finish({ kind: 'unreachable', reason: reasonOf(error) });
            ws.terminate();
          }
        });
        ws.on('ping', () => {
          if (opened) listener({ type: 'alive' });
        });
        ws.on('message', (data: WebSocket.RawData) => {
          if (!opened) return;
          const bytes = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
          listener({ type: 'message', data: parseJson(bytes) });
        });
        ws.once('close', (code, reason) => {
          if (!opened) {
            finish({ kind: 'unreachable', reason: 'closed_before_open' });
            return;
          }
          listener({ type: 'closed', code, reason: reason.toString('utf8') });
        });
      });
    },
  };
}
