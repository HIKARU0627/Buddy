// HTTPS の受付の試験で使う道具（試験専用。index.ts から export しない）。
//
// - ピン留めする試験用のクライアント: 先に TLS だけを接続し、信頼の起点を中枢の証明書 1 枚に限り（ca）、
//   checkServerIdentity で証明書の DER 全体の SHA-256 を指紋と照合する。どちらかが合わなければ接続を捨て、
//   HTTP の要求は 1 バイトも書かない（要求は TLS の確立と照合の後にだけ書く）。証明書の検証は無効にしない。
// - 期待値の指紋は X509Certificate#fingerprint256 など、検査対象の関数とは別の方法から求める。
// - DB は一時ディレクトリに作って消す。端末トークンは試験の中で作る合成の値で、出力に出さない。

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type test from 'node:test';
import { connect } from 'node:tls';
import type { PeerCertificate, SecureVersion, TLSSocket } from 'node:tls';
import { DbWorkerClient } from '@buddy/storage';
import type { DeviceRecord } from '@buddy/storage';
import { createDeviceToken, deviceTokenHash } from './api-auth.js';

export const STORE_GENERATION = '00000000-0000-4000-8000-0000000000aa';

export async function tempDir(
  t: test.TestContext,
  prefix: string,
): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), prefix));
  t.after(() =>
    rm(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => undefined),
  );
  return base;
}

export async function startTestStore(
  t: test.TestContext,
): Promise<DbWorkerClient> {
  const dir = await tempDir(t, 'buddy-api-store-');
  const store = await DbWorkerClient.start({
    path: join(dir, 'data', 'buddy.sqlite'),
    storeGeneration: STORE_GENERATION,
    responseTimeoutMs: 10_000,
  });
  t.after(() => store.close());
  return store;
}

export interface TestDevice {
  readonly device: DeviceRecord;
  // 合成の端末トークン。出力・例外のメッセージに入れない。
  readonly token: string;
}

export async function insertDevice(
  store: Pick<DbWorkerClient, 'device'>,
  options: { readonly hubLocal?: boolean; readonly name?: string } = {},
): Promise<TestDevice> {
  const token = createDeviceToken();
  const result = await store.device({
    kind: 'device.insert',
    device_id: randomUUID(),
    device_name: options.name ?? '合成の端末',
    platform: 'macos',
    hub_local: options.hubLocal ?? false,
    token_hash: deviceTokenHash(token),
    registered_at: Date.UTC(2030, 9, 1),
  });
  if (!result.ok)
    throw new Error(`device insert failed: ${result.reasons.join(',')}`);
  return { device: result.value, token };
}

// 試験側で求める指紋（DER 全体の SHA-256 の小文字の 16 進）。
export function sha256Hex(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex');
}

export interface PinnedTarget {
  readonly host: string;
  readonly port: number;
  // 信頼の起点にする中枢の証明書（PEM）。登録のときに受け取った証明書を想定する。
  readonly certificatePem: string;
  // ピン留めした指紋。
  readonly fingerprint: string;
  readonly minVersion?: SecureVersion;
  readonly maxVersion?: SecureVersion;
}

export function pinnedCheck(fingerprint: string) {
  return (_host: string, certificate: PeerCertificate): Error | undefined =>
    sha256Hex(certificate.raw) === fingerprint
      ? undefined
      : new Error('certificate_fingerprint_mismatch');
}

// TLS だけを接続し、証明書の検証と指紋の照合が終わってから返す。失敗すれば例外（要求は書いていない）。
export function pinnedConnect(target: PinnedTarget): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: target.host,
      port: target.port,
      ca: [target.certificatePem],
      checkServerIdentity: pinnedCheck(target.fingerprint),
      minVersion: target.minVersion ?? 'TLSv1.3',
      ...(target.maxVersion === undefined
        ? {}
        : { maxVersion: target.maxVersion }),
      rejectUnauthorized: true,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('tls_connect_timeout'));
    }, 10_000);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      if (!socket.authorized) {
        socket.destroy();
        reject(new Error('tls_not_authorized'));
        return;
      }
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
  readonly json: Record<string, unknown> | null;
}

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ピン留めの照合を終えた TLS の接続の上で HTTP の要求を 1 件送る（接続は閉じる）。
export async function pinnedRequest(
  target: PinnedTarget,
  request: ApiRequest,
): Promise<ApiResponse> {
  const socket = await pinnedConnect(target);
  return new Promise((resolve, reject) => {
    const body =
      request.body === undefined
        ? undefined
        : typeof request.body === 'string'
          ? Buffer.from(request.body, 'utf8')
          : Buffer.from(request.body);
    const req = httpsRequest({
      createConnection: () => socket,
      host: target.host,
      port: target.port,
      method: request.method,
      path: request.path,
      headers: {
        connection: 'close',
        ...(body === undefined
          ? {}
          : { 'content-length': String(body.length) }),
        ...request.headers,
      },
    });
    const timer = setTimeout(() => {
      req.destroy(new Error('request_timeout'));
    }, 10_000);
    req.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text,
          json: parseJson(text),
        });
        socket.destroy();
      });
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
    req.end(body);
  });
}

// ピン留めの照合を終えた TLS の接続に生のバイト列を書き、応答（または切断）までに受け取った内容を返す。
// 宣言の長さだけを送って本文を送らない要求・少しずつ送る要求など、HTTP のクライアントが作らない要求に使う。
export async function rawExchange(
  target: PinnedTarget,
  head: string,
  options: {
    // 応答を受け取るまで、この間隔で送り続ける本文の断片（chunked など）。
    readonly drip?: {
      readonly chunk: Buffer;
      readonly intervalMs: number;
      readonly max: number;
    };
  } = {},
): Promise<{ readonly text: string; readonly closed: boolean }> {
  const socket = await pinnedConnect(target);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let sent = 0;
    let timer: NodeJS.Timeout | null = null;
    const finish = (closed: boolean) => {
      if (timer) clearInterval(timer);
      clearTimeout(deadline);
      socket.destroy();
      resolve({ text: Buffer.concat(chunks).toString('utf8'), closed });
    };
    const deadline = setTimeout(() => finish(false), 10_000);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => finish(true));
    socket.write(head);
    const drip = options.drip;
    if (drip !== undefined)
      timer = setInterval(() => {
        if (chunks.length > 0 || sent >= drip.max || socket.destroyed) {
          if (timer) clearInterval(timer);
          return;
        }
        sent += 1;
        socket.write(drip.chunk);
      }, drip.intervalMs);
  });
}

export function statusOf(rawText: string): number {
  const match = /^HTTP\/1\.1 (\d{3}) /u.exec(rawText);
  return match ? Number(match[1]) : 0;
}

export function jsonOfRaw(rawText: string): Record<string, unknown> | null {
  const at = rawText.indexOf('\r\n\r\n');
  return at === -1 ? null : parseJson(rawText.slice(at + 4));
}
