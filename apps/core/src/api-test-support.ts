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

// 試験の後始末を「後に登録したものから先に」行う（LIFO）。
// node:test の t.after は登録した順（FIFO）に動くため、一時ディレクトリの削除を先に登録すると、
// DB・Core を閉じる前に削除が走る。Windows では開いているファイルを消せず、fs.rm の再試行
// （maxRetries がディレクトリの階層ごとに重なる）で 1 件あたり数十秒〜2 分かかっていた（ADR 0020）。
const cleanups = new WeakMap<object, (() => unknown)[]>();

export function onCleanup(t: test.TestContext, cleanup: () => unknown): void {
  let stack = cleanups.get(t);
  if (stack === undefined) {
    const created: (() => unknown)[] = [];
    stack = created;
    cleanups.set(t, created);
    t.after(async () => {
      for (const run of created.reverse()) {
        try {
          await run();
        } catch {
          // 後始末の失敗で他の後始末を止めない。
        }
      }
    });
  }
  stack.push(cleanup);
}

export async function tempDir(
  t: test.TestContext,
  prefix: string,
): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), prefix));
  // 先に登録するので、後から登録した DB・サーバー・Core を閉じた後に消す。
  onCleanup(t, () =>
    rm(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => undefined),
  );
  return base;
}

// 待ちが終わらないときに、名前つきの失敗にする（Windows で止まった箇所を CI のログで分かるようにする）。
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  onCleanup(t, () => store.close());
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
    // 警告も例外もなく閉じられた場合（相手の切断）も待ちを終える。確立の後の close では何もしない。
    socket.once('close', () => {
      clearTimeout(timer);
      reject(new Error('tls_closed_before_secure'));
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
    // 応答の終わり・要求の失敗・応答の途中の切断・時間切れのどれかで必ず終える。
    let settled = false;
    const finish = (result: ApiResponse | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish(new Error('request_timeout'));
    }, 10_000);
    req.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        finish({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text,
          json: parseJson(text),
        });
      });
      response.on('error', (error) => finish(error));
      response.on('close', () => finish(new Error('response_closed')));
    });
    req.on('error', (error) => finish(error));
    req.on('close', () => finish(new Error('request_closed')));
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
    let settled = false;
    let drip: NodeJS.Timeout | null = null;
    let afterResponse: NodeJS.Timeout | null = null;
    // 切断（ECONNRESET を含む）・応答の後の待ちの終わり・時間切れのどれかで必ず終える。
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      if (drip) clearInterval(drip);
      if (afterResponse) clearTimeout(afterResponse);
      clearTimeout(deadline);
      socket.destroy();
      resolve({ text: Buffer.concat(chunks).toString('utf8'), closed });
    };
    const deadline = setTimeout(() => finish(false), 10_000);
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      // 応答を全部受け取ったら、中枢が接続を閉じるのを最大 3 秒だけ待つ（閉じなければ closed: false）。
      if (afterResponse === null && completeResponse(Buffer.concat(chunks)))
        afterResponse = setTimeout(() => finish(false), 3_000);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => finish(true));
    socket.write(head);
    const dripOptions = options.drip;
    if (dripOptions !== undefined)
      drip = setInterval(() => {
        if (
          chunks.length > 0 ||
          sent >= dripOptions.max ||
          socket.destroyed ||
          settled
        ) {
          if (drip) clearInterval(drip);
          return;
        }
        sent += 1;
        socket.write(dripOptions.chunk);
      }, dripOptions.intervalMs);
  });
}

// ヘッダーと Content-Length の分の本文がそろったか。
function completeResponse(bytes: Buffer): boolean {
  const at = bytes.indexOf('\r\n\r\n');
  if (at === -1) return false;
  const length = /\r\ncontent-length: (\d+)\r\n/iu.exec(
    bytes.subarray(0, at + 2).toString('latin1'),
  );
  return length !== null && bytes.length >= at + 4 + Number(length[1]);
}

export function statusOf(rawText: string): number {
  const match = /^HTTP\/1\.1 (\d{3}) /u.exec(rawText);
  return match ? Number(match[1]) : 0;
}

export function jsonOfRaw(rawText: string): Record<string, unknown> | null {
  const at = rawText.indexOf('\r\n\r\n');
  return at === -1 ? null : parseJson(rawText.slice(at + 4));
}
