// HTTPS の受付の試験で使う道具（試験専用。index.ts から export しない）。
//
// - ピン留めする試験用のクライアント: 先に TLS だけを接続し、信頼の起点を中枢の証明書 1 枚に限り（ca）、
//   checkServerIdentity で証明書の DER 全体の SHA-256 を指紋と照合する。どちらかが合わなければ接続を捨て、
//   HTTP の要求は 1 バイトも書かない（要求は TLS の確立と照合の後にだけ書く）。証明書の検証は無効にしない。
// - 期待値の指紋は X509Certificate#fingerprint256 など、検査対象の関数とは別の方法から求める。
// - DB は一時ディレクトリに作って消す。端末トークンは試験の中で作る合成の値で、出力に出さない。

import { createHash, randomUUID } from 'node:crypto';
import { constants, mkdtempSync, rmSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type test from 'node:test';
import { connect } from 'node:tls';
import type { PeerCertificate, SecureVersion, TLSSocket } from 'node:tls';
import {
  DbWorkerClient,
  openWriteConnection,
  storagePlatform,
} from '@buddy/storage';
import type { DeviceRecord } from '@buddy/storage';
import { createDeviceToken, deviceTokenHash } from './api-auth.js';
import { createApiContract } from './api-contract.js';
import type { ApiContract } from './api-contract.js';

// 契約の検証器は、全 Schema を Ajv で組み立てて検証関数を作る重い処理（1 回あたり CPU 約 0.6〜1 秒）。
// 検証器は状態を持たない（検証関数の控えだけ）ので、試験ごとに作らず、プロセスで 1 つを共有する。
// 試験ごとに作ると、CPU の少ない CI（Windows）で試験の 20 秒の上限を超える（予算・音声の試験が約 100 件ある）。
// 契約の Schema を差し替える試験は、これを使わず createApiContract(schema) を直接呼ぶ。
let sharedContract: ApiContract | null = null;
export function sharedApiContract(): ApiContract {
  sharedContract ??= createApiContract();
  return sharedContract;
}

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

// 移行済みの DB の雛形（store_generation ごとに、プロセスで 1 つ）。DB worker の起動は全マイグレーションを
// 適用するので、試験ごとに新しいファイルから起動すると、1 回の準備で書込みと同期（fsync）を数十回行う。
// 同期の遅い Windows の CI では、DB を使う試験の時間の大半がこの準備になり、同じ shard の音声・予算の試験が
// 20 秒の上限を超えた（Issue #348）。雛形は本番と同じ DB worker の起動で作り、試験ごとにファイルを写す。
// 写した DB でも DB worker の起動はマイグレーションの照合と store_generation の確認を行う（適用済みなら書かない）。
const migratedTemplates = new Map<string, Promise<string>>();

function migratedTemplate(storeGeneration: string): Promise<string> {
  let template = migratedTemplates.get(storeGeneration);
  if (template === undefined) {
    template = (async () => {
      const dir = mkdtempSync(join(tmpdir(), 'buddy-core-template-'));
      process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
      const path = join(dir, 'buddy.sqlite');
      const store = await DbWorkerClient.start({
        path,
        storeGeneration,
        responseTimeoutMs: 10_000,
      });
      await store.close();
      // WAL に残った分を本体へ書き戻す（本体のファイルだけを写すため）。
      const db = openWriteConnection(path, { platform: storagePlatform() });
      try {
        const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)') as {
          busy: number;
        }[];
        if (checkpoint?.busy !== 0)
          throw new Error(
            '試験の DB の雛形の WAL を本体へ書き戻せませんでした。',
          );
      } finally {
        db.close();
      }
      return path;
    })();
    migratedTemplates.set(storeGeneration, template);
  }
  return template;
}

// path（まだ無いこと）に、移行済みの DB の雛形を写す。
export async function copyMigratedDatabase(
  path: string,
  storeGeneration: string,
): Promise<void> {
  const template = await migratedTemplate(storeGeneration);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await copyFile(template, path, constants.COPYFILE_EXCL);
}

export async function startTestStore(
  t: test.TestContext,
): Promise<DbWorkerClient> {
  const dir = await tempDir(t, 'buddy-api-store-');
  const path = join(dir, 'data', 'buddy.sqlite');
  await copyMigratedDatabase(path, STORE_GENERATION);
  const store = await DbWorkerClient.start({
    path,
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
