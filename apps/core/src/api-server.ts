// 中枢の HTTPS の受付（設計 02 端末登録と接続・主な通信契約、07 §2・§3、ADR 0009・0020）。
//
// node:https（TLS 1.3 以上）で、注入されたアドレス（製品は Tailscale のアドレス、試験は 127.0.0.1）を待ち受ける。
// アドレスは正規化してから、ループバックと Tailscale の範囲だけを受け付ける（domain の listenAddressDecision）。
// TLS の確立から最初の要求のヘッダーがそろうまでに headersTimeoutMs を過ぎた接続は、応答せずに切る（B03-07 M1）。
// 一つの要求は次の順に処理し、最初に満たさないものの拒否を返す。
//   1. 接続数の上限（超えた接続の要求は 429 rate_limited）。Core が受付中（running）でなければ 503
//   2. Origin ヘッダーのある要求（ブラウザーからの要求）は 403 forbidden
//   3. 認証前の頻度の上限（接続元ごと。超えたら 429 rate_limited）
//   4. 経路（なければ 404・方法違いは 405、どちらも invalid_input）
//   5. 端末トークンの照合（SHA-256 で devices を引く。失効・未登録・形式違いは未認証）。認証できた端末ごとの
//      頻度の上限（超えたら 429 rate_limited、B03-07 L1）
//   6. 本文の上限（宣言の長さで先に判定。認証後 256 KiB・認証前の経路 16 KiB、超えたら切り詰めずに 413）
//   7. 端末トークンを求める経路で未認証なら、本文を読まずに経路の検査の結果（401）を返す
//   8. 本文を上限まで読む（超えたら 413）
//   9. 形式の検査（パスの値・クエリー・ヘッダー・厳格な JSON（重複キー）・JSON Schema）。不正は 422 invalid_input
//  10. 経路の検査（domain の admitRequest。ROUTE_CHECKS の順）
//  11. 経路の処理。getBootstrap と、handlers に渡された経路（B03-02・B03-04 など）。他の経路は検査の後に 503 で閉じる
// WebSocket（/v1/events/stream）は ws で受け、同じ検査の後に切り替える。配信は eventStream（B03-04、ADR 0023）が行い、
// 渡されなければ切り替えた後に 1013 で閉じる。
// 拒否の本文は ApiError（code・message・request_id）だけで、対象の本文・トークン・hash を返さない。

import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'node:http';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import {
  MAX_CONTROL_JSON_BYTES,
  MAX_PREAUTH_JSON_BYTES,
  ROUTE_CHECKS,
  admitRequest,
  listenAddressDecision,
} from '@buddy/domain';
import type { CoreCheck, RequestContext } from '@buddy/domain';
import { COMMAND_SCOPE_MAX_TTL_MS } from '@buddy/storage';
import type { DbWorkerClient, DeviceRecord } from '@buddy/storage';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import {
  commandScopeState,
  deviceTokenHash,
  parseBearerToken,
} from './api-auth.js';
import { createApiContract } from './api-contract.js';
import type { ApiContract } from './api-contract.js';
import {
  DECLARED_LOCK_STATES,
  SAFE_REQUEST_ENVIRONMENT,
} from './api-environment.js';
import type {
  DeclaredLockState,
  EnvironmentInput,
  RequestEnvironment,
} from './api-environment.js';
import { matchRoute } from './api-routes.js';
import type { ApiRoute } from './api-routes.js';
import {
  StrictJsonError,
  isJsonObject,
  parseStrictJson,
} from './strict-json.js';
import type { JsonObject } from './strict-json.js';
import type { TlsIdentity } from './tls-identity.js';

// Bootstrap.api_version（OpenAPI の info.version の major.minor）。
export const API_VERSION = '1.0';
// 待ち受けの既定のポート（ADR 0020 の読み取り）。
export const DEFAULT_HTTPS_PORT = 47_443;
// 要求の起点（OpenAPI の components.parameters.InputOrigin）。screen だけが画面操作。
export const INPUT_ORIGINS: readonly string[] = ['screen', 'voice', 'system'];
// 本文の JSON の入れ子の上限（契約の要求の形はこれより浅い）。
const MAX_JSON_DEPTH = 32;
const CLOSE_FALLBACK_MS = 1000;

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'conflict'
  | 'expired_scope'
  | 'invalid_input'
  | 'rate_limited'
  | 'dependency_unavailable'
  | 'device_locked'
  | 'screen_operation_required'
  | 'hub_screen_required'
  | 'outside_home_network'
  | 'audio_owned_elsewhere'
  | 'audio_ownership_required'
  | 'payload_too_large'
  | 'pairing_failed';

const MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  unauthenticated: '端末トークンがない、無効、または失効しています。',
  forbidden: 'この要求は受け付けません。',
  conflict: '内容または状態が変わりました。',
  expired_scope: '接続範囲が古くなりました。接続し直してください。',
  invalid_input: '要求の形式が不正です。',
  rate_limited: '要求が多すぎます。',
  dependency_unavailable: '中枢が要求を処理できません。',
  device_locked: '端末のロックを解除してください。',
  screen_operation_required: '画面からの操作が必要です。',
  hub_screen_required: '中枢の画面からの操作が必要です。',
  outside_home_network: '自宅のネットワークからの接続ではありません。',
  audio_owned_elsewhere: '別の端末が音声を使っています。',
  audio_ownership_required: '音声の所有権がありません。',
  payload_too_large: '要求が大きすぎます。',
  pairing_failed: 'ペアリングは無効です。最初からやり直してください。',
};

// 経路の処理（handlers）が返す拒否の応答。本文は ApiError（code・message・request_id）だけ。
export function apiErrorResponse(
  status: number,
  code: ApiErrorCode,
  requestId: string | null = null,
): { status: number; body: object } {
  return {
    status,
    body: { code, message: MESSAGES[code], request_id: requestId },
  };
}

export interface ApiLimits {
  // 同時の TLS 接続の数。超えた接続の要求は 429。
  readonly maxConnections: number;
  // TCP の接続の数の上限。超えた接続は応答せずに切る。
  readonly hardMaxConnections: number;
  // 認証前の頻度（接続元ごとの固定の窓）。端末トークンで認証できなかった要求を数える。
  readonly preAuthWindowMs: number;
  readonly preAuthMaxRequests: number;
  // 認証した端末ごとの頻度（端末ごとの固定の窓、B03-07 L1）。端末トークンで認証できた要求（WSS の切り替えを含む）を数える。
  readonly deviceWindowMs: number;
  readonly deviceMaxRequests: number;
  readonly handshakeTimeoutMs: number;
  // ヘッダーの期限。TLS の確立から最初の要求のヘッダーがそろうまでの期限（接続ごと、B03-07 M1）にも使う。
  readonly headersTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly maxHeaderBytes: number;
}

// 既定値（ADR 0020 の読み取り。設計に数値の定めがないもの）。
export const DEFAULT_API_LIMITS: ApiLimits = {
  maxConnections: 32,
  hardMaxConnections: 64,
  preAuthWindowMs: 60_000,
  preAuthMaxRequests: 30,
  // 仮の値（理由は ADR 0020 の B03-07 の変更）。
  deviceWindowMs: 60_000,
  deviceMaxRequests: 300,
  handshakeTimeoutMs: 10_000,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 15_000,
  keepAliveTimeoutMs: 5_000,
  maxHeaderBytes: 8_192,
};

export type ApiStore = Pick<DbWorkerClient, 'device' | 'storeGeneration'>;

// 検査を通った要求（経路の処理へ渡す）。本文・パスの値・クエリーは形式の検査に通った値。
export interface ApiHandlerRequest {
  readonly route: ApiRoute;
  readonly device: DeviceRecord | null;
  readonly body: JsonObject | null;
  readonly params: Readonly<Record<string, string>>;
  readonly remoteAddress: string;
  readonly query: Readonly<Record<string, string>>;
  // Buddy-Lock-State の申告（なければ null。B03-05、ADR 0025）。
  readonly declaredLockState: DeclaredLockState | null;
}

export type ApiRouteHandler = (
  request: ApiHandlerRequest,
) => Promise<{ status: number; body: object }>;

// WSS の配信（B03-04、ADR 0023）。admit は切り替えの前に呼び、拒否なら HTTP の応答（ApiError）を返す。
// open は切り替えた後に呼ぶ。
export interface ApiEventStream {
  admit(
    request: ApiHandlerRequest,
  ): Promise<{ status: number; body: object } | null>;
  open(client: WebSocket, request: ApiHandlerRequest): void;
}

export interface ApiServerOptions {
  readonly host: string;
  readonly port: number;
  readonly identity: TlsIdentity;
  readonly store: ApiStore;
  readonly coreInstanceId: string;
  // Core が新しい要求を受け付けているか（running の間だけ true）。
  readonly accepting?: () => boolean;
  // 判定の元がまだない文脈（自宅判定・ロック状態など）。省略したものは安全側の既定。
  readonly environment?: Partial<RequestEnvironment>;
  readonly limits?: Partial<ApiLimits>;
  // UTC の Unix ミリ秒（接続範囲の発行・期限）。
  readonly now?: () => number;
  // 単調時計のミリ秒（頻度の窓）。
  readonly monotonicNow?: () => number;
  readonly contract?: ApiContract;
  // operationId → 経路の処理。getBootstrap 以外の実装した経路をここで渡す。
  readonly handlers?: Readonly<Partial<Record<string, ApiRouteHandler>>>;
  // WSS の配信。渡さなければ切り替えた後に 1013 で閉じる。
  readonly eventStream?: ApiEventStream;
}

export class ApiListenError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'ApiListenError';
    this.reason = reason;
  }
}

// 待ち受けるアドレスの検査。IP アドレスの文字列を正規化してから、許可する範囲（ループバック・Tailscale）だけを
// 受け付ける（Tailscale 以外の経路へ開かないため。domain の listenAddressDecision、ADR 0020・B03-07）。
// 理由コード（https_host_not_ip_address・https_host_unspecified・https_host_not_allowed）を返し、問題がなければ null。
export function listenHostReason(host: string): string | null {
  const decision = listenAddressDecision(host);
  return decision.ok ? null : `https_host_${decision.reason}`;
}

export function listenPortReason(port: number): string | null {
  return Number.isInteger(port) && port >= 0 && port <= 65_535
    ? null
    : 'https_port_invalid';
}

// 鍵（接続元の IP アドレス・認証した端末の ID）ごとの固定の窓の数え上げ。窓を過ぎた記録は数え直す。
class WindowLimiter {
  readonly #entries = new Map<string, { start: number; count: number }>();
  readonly #windowMs: number;
  readonly #max: number;

  constructor(windowMs: number, max: number) {
    this.#windowMs = windowMs;
    this.#max = max;
  }

  #entry(key: string, now: number): { start: number; count: number } {
    let entry = this.#entries.get(key);
    if (entry === undefined || now - entry.start >= this.#windowMs) {
      entry = { start: now, count: 0 };
      this.#entries.set(key, entry);
    }
    return entry;
  }

  exhausted(key: string, now: number): boolean {
    const entry = this.#entries.get(key);
    return (
      entry !== undefined &&
      now - entry.start < this.#windowMs &&
      entry.count >= this.#max
    );
  }

  record(key: string, now: number): void {
    this.#entry(key, now).count += 1;
    // 古い記録を片付ける（鍵の数を際限なく増やさない）。
    if (this.#entries.size > 4096)
      for (const [key, value] of this.#entries)
        if (now - value.start >= this.#windowMs) this.#entries.delete(key);
  }
}

interface Rejection {
  readonly kind: 'reject';
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly requestId: string | null;
  // 応答の後に接続を閉じる（本文を読んでいない・接続数の超過など）。
  readonly close: boolean;
}

interface Admitted extends ApiHandlerRequest {
  readonly kind: 'admitted';
}

type Evaluation = Rejection | Admitted | { readonly kind: 'aborted' };

const reject = (
  status: number,
  code: ApiErrorCode,
  options: {
    readonly requestId?: string | null;
    readonly close?: boolean;
  } = {},
): Rejection => ({
  kind: 'reject',
  status,
  code,
  requestId: options.requestId ?? null,
  close: options.close ?? false,
});

const ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requestIdOf(body: JsonObject | null): string | null {
  const value = body?.['request_id'];
  return typeof value === 'string' && ID.test(value) ? value : null;
}

// 形式の検査に通った Buddy-Lock-State（なければ null）。
function lockHeader(headers: IncomingHttpHeaders): DeclaredLockState | null {
  const value = headers['buddy-lock-state'];
  return value === 'unlocked' || value === 'locked' ? value : null;
}

function contentLength(headers: IncomingHttpHeaders): number | null {
  const value = headers['content-length'];
  if (value === undefined) return null;
  // Node の HTTP の読み取りが不正な値を先に拒否している。
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;

type BodyRead =
  | { readonly kind: 'body'; readonly bytes: Buffer }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'aborted' };

// 本文を上限まで読む。超えたら読むのをやめる（切り詰めた本文を処理しない）。
function readBody(request: IncomingMessage, limit: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: BodyRead) => {
      if (done) return;
      done = true;
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('close', onClose);
      request.off('error', onClose);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        request.pause();
        finish({ kind: 'too_large' });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish({ kind: 'body', bytes: Buffer.concat(chunks) });
    const onClose = () => finish({ kind: 'aborted' });
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('close', onClose);
    request.on('error', onClose);
  });
}

// 検査を満たさない側の文脈（未使用の欄の値。admitRequest は経路の検査にある欄だけを見る）。
const FAILING_CONTEXT: RequestContext = {
  bodyBytes: 0,
  deviceAuthenticated: false,
  claimSecretMatches: false,
  homeNetwork: false,
  commandScope: 'stale',
  lockState: 'unknown',
  screenOperation: false,
  hubLocal: false,
  audioOwner: 'none',
  revisionMatches: false,
};

export interface ApiServer {
  readonly host: string;
  // 待ち受けているポート（0 を渡したときは OS が選んだ値）。listen の後に決まる。
  readonly port: number;
  readonly fingerprint: string;
  // 受け取った HTTP の要求（切り替えの要求を含む）と、確立した TLS の接続の数（診断・試験用）。
  readonly requestsReceived: number;
  readonly tlsConnections: number;
  listen(): Promise<void>;
  // 新しい接続の受付を止め、残りの接続を graceMs 待ってから切る。
  close(graceMs: number): Promise<void>;
}

export function createApiServer(options: ApiServerOptions): ApiServer {
  const listenAddress = listenAddressDecision(options.host);
  if (!listenAddress.ok)
    throw new ApiListenError(`https_host_${listenAddress.reason}`);
  // 正規化したアドレスで待ち受ける（IPv4-mapped の表記は IPv4 に直す）。
  const host = listenAddress.address;
  const portReason = listenPortReason(options.port);
  if (portReason !== null) throw new ApiListenError(portReason);
  const limits: ApiLimits = { ...DEFAULT_API_LIMITS, ...options.limits };
  const environment: RequestEnvironment = {
    ...SAFE_REQUEST_ENVIRONMENT,
    ...options.environment,
  };
  const contract = options.contract ?? createApiContract();
  const now = options.now ?? (() => Date.now());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const accepting = options.accepting ?? (() => true);
  const limiter = new WindowLimiter(
    limits.preAuthWindowMs,
    limits.preAuthMaxRequests,
  );
  const deviceLimiter = new WindowLimiter(
    limits.deviceWindowMs,
    limits.deviceMaxRequests,
  );
  const sockets = new Set<TLSSocket>();
  // TLS の確立の前の接続も含めた TCP の接続（停止の時に切るため。closeAllConnections は HTTP の接続しか切らない）。
  const connections = new Set<Duplex>();
  const overLimit = new WeakSet<object>();
  let closing = false;
  let port = options.port;
  let requestsReceived = 0;
  let tlsConnections = 0;

  const server: Server = createServer({
    key: options.identity.privateKey.toPkcs8Pem(),
    cert: options.identity.certificatePem,
    minVersion: 'TLSv1.3',
    handshakeTimeout: limits.handshakeTimeoutMs,
    requestTimeout: limits.requestTimeoutMs,
    headersTimeout: limits.headersTimeoutMs,
    keepAliveTimeout: limits.keepAliveTimeoutMs,
    maxHeaderSize: limits.maxHeaderBytes,
    noDelay: true,
  });
  server.maxConnections = limits.hardMaxConnections;
  server.maxHeadersCount = 64;
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    // 端末から送るメッセージは定義していない。認証前の上限と同じ小さな値にする。
    maxPayload: MAX_PREAUTH_JSON_BYTES,
  });

  server.on('connection', (socket: Duplex) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  // TLS の確立から最初の要求（ヘッダーがそろう）までの期限（B03-07 M1）。何も送らない接続・ヘッダーを少しずつ
  // 送る接続が接続の枠を占め続けないよう、headersTimeoutMs を過ぎたら切る。Node の headersTimeout は確認の
  // 間隔（既定 30 秒）ごとにしか効かないため、接続ごとの時計で切る。最初の要求・切り替えが届いたら外し、その後は
  // keep-alive の時間切れ（keepAliveTimeoutMs）と WSS の ping に任せる。
  const firstRequestTimers = new WeakMap<object, NodeJS.Timeout>();
  const clearFirstRequestTimer = (socket: object) => {
    const timer = firstRequestTimers.get(socket);
    if (timer === undefined) return;
    clearTimeout(timer);
    firstRequestTimers.delete(socket);
  };
  server.on('secureConnection', (socket: TLSSocket) => {
    tlsConnections += 1;
    sockets.add(socket);
    if (sockets.size > limits.maxConnections) overLimit.add(socket);
    const timer = setTimeout(() => socket.destroy(), limits.headersTimeoutMs);
    timer.unref();
    firstRequestTimers.set(socket, timer);
    socket.on('close', () => {
      sockets.delete(socket);
      clearFirstRequestTimer(socket);
    });
  });
  // TLS 1.2 以下・証明書なしの接続などの失敗。応答はしない（TLS の警告だけ）。
  server.on('tlsClientError', (_error, socket) => socket.destroy());

  const formReject = (body: JsonObject | null) =>
    reject(422, 'invalid_input', { requestId: requestIdOf(body) });

  // 形式の検査（パスの値・クエリー・ヘッダー・本文）。通れば本文（なければ null）を返す。
  const validateForm = (
    route: ApiRoute,
    params: Readonly<Record<string, string>>,
    search: string,
    headers: IncomingHttpHeaders,
    raw: Buffer | null,
  ): { readonly kind: 'ok'; readonly body: JsonObject | null } | Rejection => {
    let body: JsonObject | null = null;
    if (route.body !== null) {
      const type = headers['content-type'];
      if (raw === null || raw.length === 0 || !type || !JSON_TYPE.test(type))
        return formReject(null);
      let text: string;
      try {
        text = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(raw);
      } catch {
        return formReject(null);
      }
      let value;
      try {
        value = parseStrictJson(text, MAX_JSON_DEPTH);
      } catch (error) {
        if (error instanceof StrictJsonError) return formReject(null);
        throw error;
      }
      if (!isJsonObject(value)) return formReject(null);
      body = value;
      if (!contract.valid(route.body, value)) return formReject(body);
    } else if (raw !== null && raw.length > 0) return formReject(null);
    for (const [name, definition] of Object.entries(route.pathParams))
      if (!contract.valid(definition, params[name])) return formReject(body);
    const query = new URLSearchParams(search);
    const names = [...query.keys()];
    if (new Set(names).size !== names.length) return formReject(body);
    for (const name of names)
      if (!Object.hasOwn(route.query, name)) return formReject(body);
    for (const [name, definition] of Object.entries(route.query)) {
      const value = query.get(name);
      if (value === null || !contract.valid(definition, value))
        return formReject(body);
    }
    if (route.inputOrigin) {
      const origin = headers['buddy-input-origin'];
      if (typeof origin !== 'string' || !INPUT_ORIGINS.includes(origin))
        return formReject(body);
    }
    // ロック状態の申告は任意。あれば値を検査する（どの経路でも同じ。B03-05、ADR 0025）。
    const lock = headers['buddy-lock-state'];
    if (
      lock !== undefined &&
      (typeof lock !== 'string' ||
        !(DECLARED_LOCK_STATES as readonly string[]).includes(lock))
    )
      return formReject(body);
    return { kind: 'ok', body };
  };

  // 経路の検査の文脈を組み立てる。経路の検査にある欄だけを求める（他は満たさない値のまま）。
  const buildContext = async (
    checks: readonly CoreCheck[],
    input: EnvironmentInput,
    headers: IncomingHttpHeaders,
    bodyBytes: number,
  ): Promise<RequestContext | null> => {
    const context: {
      -readonly [K in keyof RequestContext]: RequestContext[K];
    } = {
      ...FAILING_CONTEXT,
      bodyBytes,
      deviceAuthenticated: input.device !== null,
    };
    for (const check of checks) {
      if (check === 'claim_secret')
        context.claimSecretMatches =
          await environment.claimSecretMatches(input);
      else if (check === 'home_network')
        context.homeNetwork = await environment.homeNetwork(input);
      else if (check === 'command_scope') {
        const scopeId = input.body?.['command_scope_id'];
        if (input.device === null || typeof scopeId !== 'string')
          context.commandScope = 'stale';
        else {
          const found = await options.store.device({
            kind: 'scope.find',
            command_scope_id: scopeId,
          });
          if (!found.ok) return null;
          context.commandScope = commandScopeState(found.value, {
            deviceId: input.device.device_id,
            coreInstanceId: options.coreInstanceId,
            now: now(),
          });
        }
      } else if (check === 'unlocked')
        context.lockState = await environment.lockState(input);
      else if (check === 'screen_operation')
        context.screenOperation = headers['buddy-input-origin'] === 'screen';
      else if (check === 'hub_screen')
        context.hubLocal = await environment.hubLocal(input);
      else if (check === 'audio_owner')
        context.audioOwner = await environment.audioOwner(input);
      else if (check === 'expected_revision')
        context.revisionMatches = await environment.revisionMatches(input);
    }
    return context;
  };

  const evaluate = async (
    request: IncomingMessage,
    socket: TLSSocket,
    mode: 'request' | 'upgrade',
  ): Promise<Evaluation> => {
    const close = { close: true } as const;
    if (overLimit.has(socket)) return reject(429, 'rate_limited', close);
    if (closing || !accepting())
      return reject(503, 'dependency_unavailable', close);
    if (request.headers.origin !== undefined)
      return reject(403, 'forbidden', close);
    const address = socket.remoteAddress ?? '';
    const started = monotonicNow();
    if (limiter.exhausted(address, started))
      return reject(429, 'rate_limited', close);

    const url = request.url ?? '';
    const queryAt = url.indexOf('?');
    const pathname = queryAt === -1 ? url : url.slice(0, queryAt);
    const search = queryAt === -1 ? '' : url.slice(queryAt + 1);
    const match = matchRoute(request.method ?? '', pathname);

    // 端末トークンの照合。形式が違えば DB を引かない。失効・未登録は未認証。
    let device: DeviceRecord | null = null;
    const token = parseBearerToken(request.headers.authorization);
    if (token !== null) {
      const found = await options.store.device({
        kind: 'device.find_by_token_hash',
        token_hash: deviceTokenHash(token),
      });
      if (!found.ok) return reject(503, 'dependency_unavailable', close);
      if (found.value !== null && found.value.revoked_at === null)
        device = found.value;
    }
    if (device === null) limiter.record(address, started);
    else {
      // 認証した端末ごとの頻度（B03-07 L1）。上限に達した端末は、正しいトークンでも窓が過ぎるまで 429。
      if (deviceLimiter.exhausted(device.device_id, started))
        return reject(429, 'rate_limited', close);
      deviceLimiter.record(device.device_id, started);
    }

    if (!match.ok)
      return reject(match.status, 'invalid_input', { close: device === null });
    const route = match.route;
    if (mode === 'upgrade' && !route.websocket)
      return reject(404, 'invalid_input', close);
    const checks = ROUTE_CHECKS[route.operationId];
    if (checks === undefined) return reject(404, 'invalid_input', close);
    const limit = checks.includes('device_token')
      ? MAX_CONTROL_JSON_BYTES
      : MAX_PREAUTH_JSON_BYTES;
    const declared = contentLength(request.headers);
    const chunked = request.headers['transfer-encoding'] !== undefined;
    if (declared !== null && declared > limit)
      return reject(413, 'payload_too_large', close);
    if (checks.includes('device_token') && device === null) {
      // 認証前の要求の本文は読まない。宣言の長さは上限内なので、経路の検査は端末トークンで拒否する。
      const admission = admitRequest(route.operationId, {
        ...FAILING_CONTEXT,
        bodyBytes: declared ?? 0,
      });
      return admission.ok
        ? reject(401, 'unauthenticated', close)
        : reject(admission.status, admission.code as ApiErrorCode, close);
    }

    let raw: Buffer | null = null;
    if (mode === 'request') {
      const read = await readBody(request, limit);
      if (read.kind === 'aborted') return { kind: 'aborted' };
      if (read.kind === 'too_large')
        return reject(413, 'payload_too_large', close);
      raw = read.bytes;
    } else if ((declared ?? 0) > 0 || chunked)
      return reject(422, 'invalid_input', close);

    const form = validateForm(
      route,
      match.params,
      search,
      request.headers,
      raw,
    );
    if (form.kind === 'reject') return form;
    const declaredLock = lockHeader(request.headers);
    const input: EnvironmentInput = {
      operationId: route.operationId,
      device,
      remoteAddress: address,
      params: match.params,
      body: form.body,
      declaredLockState: declaredLock,
    };
    let context: RequestContext | null;
    try {
      context = await buildContext(
        checks,
        input,
        request.headers,
        raw?.length ?? 0,
      );
    } catch {
      context = null;
    }
    const requestId = requestIdOf(form.body);
    if (context === null)
      return reject(503, 'dependency_unavailable', { requestId });
    const admission = admitRequest(route.operationId, context);
    if (!admission.ok)
      return reject(admission.status, admission.code as ApiErrorCode, {
        requestId,
      });
    return {
      kind: 'admitted',
      route,
      device,
      body: form.body,
      params: match.params,
      remoteAddress: address,
      query: Object.fromEntries(new URLSearchParams(search)),
      declaredLockState: declaredLock,
    };
  };

  const headersFor = (
    body: string,
    closeAfter: boolean,
  ): Record<string, string> => ({
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(closeAfter ? { connection: 'close' } : {}),
  });

  const endSocket = (socket: Duplex) => {
    socket.end();
    setTimeout(() => socket.destroy(), CLOSE_FALLBACK_MS).unref();
  };

  const sendJson = (
    response: ServerResponse,
    status: number,
    value: object,
    closeAfter: boolean,
  ) => {
    const body = JSON.stringify(value);
    // 応答を書き終えると response.socket は外れるので、先に接続を取っておく。
    const socket = response.socket;
    if (closeAfter && socket !== null)
      response.on('finish', () => endSocket(socket));
    response.writeHead(status, headersFor(body, closeAfter));
    response.end(body);
  };

  const errorBody = (rejection: Rejection) => ({
    code: rejection.code,
    message: MESSAGES[rejection.code],
    request_id: rejection.requestId,
  });

  // 実装した経路の処理。getBootstrap と handlers に渡された経路。
  const handle = async (
    admitted: Admitted,
  ): Promise<{ status: number; body: object }> => {
    const handler = options.handlers?.[admitted.route.operationId];
    if (handler !== undefined) return handler(admitted);
    if (
      admitted.route.operationId !== 'getBootstrap' ||
      admitted.device === null
    )
      return {
        status: 503,
        body: errorBody(
          reject(503, 'dependency_unavailable', {
            requestId: requestIdOf(admitted.body),
          }),
        ),
      };
    const device = admitted.device;
    const issuedAt = now();
    const expiresAt = issuedAt + COMMAND_SCOPE_MAX_TTL_MS;
    const commandScopeId = randomUUID();
    const issued = await options.store.device({
      kind: 'scope.issue',
      command_scope_id: commandScopeId,
      device_id: device.device_id,
      core_instance_id: options.coreInstanceId,
      issued_at: issuedAt,
      expires_at: expiresAt,
    });
    if (!issued.ok) {
      // 照合の後に失効した端末は未認証として扱う。
      const revoked =
        issued.outcome === 'rejected' &&
        (issued.reasons.includes('device_revoked') ||
          issued.reasons.includes('device_not_found'));
      const rejection = revoked
        ? reject(401, 'unauthenticated')
        : reject(503, 'dependency_unavailable');
      return { status: rejection.status, body: errorBody(rejection) };
    }
    return {
      status: 200,
      body: {
        api_version: API_VERSION,
        core_instance_id: options.coreInstanceId,
        store_generation: options.store.storeGeneration,
        device_id: device.device_id,
        command_scope_id: issued.value.command_scope_id,
        command_scope_expires_at: new Date(
          issued.value.expires_at,
        ).toISOString(),
        // 端末能力の一覧は B03-04 以降で決める（ADR 0020 の読み取り）。
        capabilities: [],
        // 入出力の状態の正本は B03-04・B05 で作る。今は安全側の値（ロック状態は不明・入力不可）。
        io_state: {
          device_id: device.device_id,
          io_epoch: '0',
          output_epoch: '0',
          lock_state: 'unknown',
          stop_scope: 'none',
          input_permitted: false,
          voice_state: 'waiting_wake_word',
          output_mode: 'text',
          private_conversation: false,
          audio_lease_valid: false,
        },
      },
    };
  };

  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    requestsReceived += 1;
    const socket = request.socket as TLSSocket;
    clearFirstRequestTimer(socket);
    void (async () => {
      let outcome: Evaluation;
      try {
        outcome = await evaluate(request, socket, 'request');
      } catch {
        outcome = reject(503, 'dependency_unavailable', { close: true });
      }
      if (outcome.kind === 'aborted') {
        socket.destroy();
        return;
      }
      if (outcome.kind === 'reject') {
        sendJson(response, outcome.status, errorBody(outcome), outcome.close);
        return;
      }
      if (outcome.route.websocket) {
        // 切り替えの要求ではない（101 の経路を通常の要求で呼んだ）。
        sendJson(response, 422, errorBody(reject(422, 'invalid_input')), false);
        return;
      }
      let result: { status: number; body: object };
      try {
        result = await handle(outcome);
      } catch {
        result = {
          status: 503,
          body: errorBody(reject(503, 'dependency_unavailable')),
        };
      }
      sendJson(response, result.status, result.body, false);
    })();
  });

  const writeRaw = (socket: Duplex, rejection: Rejection) =>
    writeRawJson(socket, rejection.status, errorBody(rejection));

  const writeRawJson = (socket: Duplex, status: number, value: object) => {
    const body = JSON.stringify(value);
    const headers = headersFor(body, true);
    const lines = [
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ];
    socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
    endSocket(socket);
  };

  server.on(
    'upgrade',
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      requestsReceived += 1;
      clearFirstRequestTimer(socket);
      socket.on('error', () => undefined);
      void (async () => {
        let outcome: Evaluation;
        try {
          outcome = await evaluate(request, socket as TLSSocket, 'upgrade');
        } catch {
          outcome = reject(503, 'dependency_unavailable', { close: true });
        }
        if (outcome.kind === 'aborted') {
          socket.destroy();
          return;
        }
        if (outcome.kind === 'reject') {
          writeRaw(socket, outcome);
          return;
        }
        const stream = options.eventStream;
        if (stream === undefined) {
          wss.handleUpgrade(request, socket, head, (client) => {
            // 配信を渡されていない（受付の土台だけ）。切り替えた後に閉じる。
            client.close(1013, 'not_implemented');
          });
          return;
        }
        let refusal: { status: number; body: object } | null;
        try {
          refusal = await stream.admit(outcome);
        } catch {
          refusal = {
            status: 503,
            body: errorBody(reject(503, 'dependency_unavailable')),
          };
        }
        if (refusal !== null) {
          writeRawJson(socket, refusal.status, refusal.body);
          return;
        }
        if (closing || socket.destroyed) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (client) => {
          stream.open(client, outcome);
        });
      })();
    },
  );

  return {
    host,
    get port() {
      return port;
    },
    fingerprint: options.identity.fingerprint,
    get requestsReceived() {
      return requestsReceived;
    },
    get tlsConnections() {
      return tlsConnections;
    },
    listen() {
      return new Promise<void>((resolve, rejectListen) => {
        const onError = (error: NodeJS.ErrnoException) => {
          server.off('listening', onListening);
          rejectListen(
            new ApiListenError(
              `https_listen_failed:${(error.code ?? 'unknown').toLowerCase()}`,
            ),
          );
        };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          if (address !== null && typeof address === 'object')
            port = address.port;
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({
          host,
          port: options.port,
          exclusive: true,
        });
      });
    },
    async close(graceMs) {
      closing = true;
      for (const client of wss.clients) client.terminate();
      const closed = new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      server.closeIdleConnections();
      // 猶予を過ぎたら、HTTP の接続・切り替えた接続・TLS の確立の途中の接続をすべて切る。
      const destroyAll = () => {
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        for (const socket of connections) socket.destroy();
      };
      const timer = setTimeout(destroyAll, graceMs);
      // 切った後も close の通知が来ない場合に止まり続けないよう、上限を置く。
      let fallback: NodeJS.Timeout | undefined;
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          fallback = setTimeout(resolve, graceMs + CLOSE_FALLBACK_MS);
        }),
      ]);
      clearTimeout(timer);
      clearTimeout(fallback);
      destroyAll();
      wss.close();
    },
  };
}
