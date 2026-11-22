// Google API の読み取り用 HTTP 土台（B08-03、設計 04・11 §1、ADR 0071）。
// 再試行の正本は @buddy/domain の CONNECTOR_RETRY_POLICY。読み取り（GET）だけを扱い、書込みはここに置かない。
// トークン・URL のクエリ値・応答本文は、ログ・エラー・例外メッセージに出さない。
import { request } from 'node:https';
import {
  CONNECTOR_RETRY_POLICY,
  type ConnectorRetryPolicy,
} from '@buddy/domain';

export interface GoogleHttpTransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface GoogleHttpTransportResponse {
  readonly status: number;
  /** キーは小文字。 */
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
}

/** 通信自体の失敗（未送信・応答なし）は GoogleTransportFailure を throw する。 */
export type GoogleHttpTransport = (
  request: GoogleHttpTransportRequest,
) => Promise<GoogleHttpTransportResponse>;

export type GoogleTransportFailureReason = 'not_sent' | 'no_response';

export class GoogleTransportFailure extends Error {
  readonly reason: GoogleTransportFailureReason;
  constructor(reason: GoogleTransportFailureReason) {
    super(`Google API との通信に失敗しました（種別: ${reason}）`);
    this.name = 'GoogleTransportFailure';
    this.reason = reason;
  }
}

// node:https で 1 回だけ GET する。自動再送はしない（keep-alive も使わず、毎回新しい接続で送る）。
export const defaultGoogleHttpTransport: GoogleHttpTransport = (call) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      outcome:
        | { readonly ok: true; readonly response: GoogleHttpTransportResponse }
        | { readonly ok: false; readonly reason: GoogleTransportFailureReason },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome.ok) resolve(outcome.response);
      else reject(new GoogleTransportFailure(outcome.reason));
    };
    const req = request(
      call.url,
      {
        method: 'GET',
        agent: false,
        headers: { ...call.headers, connection: 'close' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            headers[name.toLowerCase()] = Array.isArray(value)
              ? value.join(', ')
              : value;
          }
          finish({
            ok: true,
            response: {
              status: res.statusCode ?? 0,
              headers,
              bodyText: Buffer.concat(chunks).toString('utf8'),
            },
          });
        });
        res.on('error', () => finish({ ok: false, reason: 'no_response' }));
        res.on('aborted', () => finish({ ok: false, reason: 'no_response' }));
      },
    );
    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'no_response' });
      req.destroy();
    }, call.timeoutMs);
    req.on('error', (error: NodeJS.ErrnoException) => {
      // 接続を確立できなかった失敗は未送信。それ以外（送信後の切断など）は応答なし。
      const notSent =
        error.code === 'ECONNREFUSED' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'EAI_AGAIN' ||
        error.code === 'EHOSTUNREACH' ||
        error.code === 'ENETUNREACH';
      finish({ ok: false, reason: notSent ? 'not_sent' : 'no_response' });
    });
    req.end();
  });

export interface GoogleAccessTokenSource {
  getAccessToken(): Promise<string>;
}

export type GoogleApiErrorKind =
  | 'http_error'
  | 'not_sent'
  | 'no_response'
  | 'wait_limit_exceeded'
  | 'invalid_response';

export class GoogleApiError extends Error {
  readonly kind: GoogleApiErrorKind;
  readonly status?: number;
  readonly attempts: number;
  constructor(kind: GoogleApiErrorKind, attempts: number, status?: number) {
    // 固定文言＋種別＋状態コードだけを入れる。トークン・URL・応答本文は入れない。
    super(
      `Google API の読み取りに失敗しました（種別: ${kind}, 状態: ${
        status === undefined ? 'なし' : String(status)
      }）`,
    );
    this.name = 'GoogleApiError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
    this.attempts = attempts;
  }
}

export interface GoogleHttpClientOptions {
  readonly tokenSource: GoogleAccessTokenSource;
  readonly transport?: GoogleHttpTransport;
  readonly policy?: ConnectorRetryPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  /** [0, 1) の値。 */
  readonly random?: () => number;
  /** Retry-After の HTTP 日付の解釈に使う（エポックミリ秒）。 */
  readonly now?: () => number;
  readonly baseUrl?: string;
}

export type GoogleQuery = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  429, 500, 502, 503, 504,
]);

// ジッターの割合（±20%、packages/client/src/backoff.ts と同じ流儀）。
const JITTER_RATIO = 0.2;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function buildQueryString(query: GoogleQuery): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    const values: readonly string[] =
      typeof value === 'string' ? [value] : value;
    for (const item of values) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
    }
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

// Retry-After（秒数、または HTTP 日付）を待機ミリ秒に直す。読めなければ undefined。
function parseRetryAfter(value: string, now: number): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

type AttemptFailure =
  | {
      readonly kind: 'http_error';
      readonly status: number;
      readonly retryAfterMs?: number;
    }
  | { readonly kind: 'not_sent' | 'no_response' };

export class GoogleHttpClient {
  readonly #tokenSource: GoogleAccessTokenSource;
  readonly #transport: GoogleHttpTransport;
  readonly #policy: ConnectorRetryPolicy;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #baseUrl: string;

  constructor(options: GoogleHttpClientOptions) {
    this.#tokenSource = options.tokenSource;
    this.#transport = options.transport ?? defaultGoogleHttpTransport;
    this.#policy = options.policy ?? CONNECTOR_RETRY_POLICY;
    this.#sleep = options.sleep ?? realSleep;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#baseUrl = options.baseUrl ?? 'https://www.googleapis.com';
  }

  async getJson(path: string, query: GoogleQuery): Promise<unknown> {
    const url = `${this.#baseUrl}${path}${buildQueryString(query)}`;
    const maxAttempts = Math.max(1, this.#policy.read_max_attempts);
    let totalWaitMs = 0;
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.#attempt(url, attempt);
      if (outcome.ok) return outcome.body;
      const failure = outcome.failure;
      const status = failure.kind === 'http_error' ? failure.status : undefined;
      if (attempt >= maxAttempts) {
        throw new GoogleApiError(failure.kind, attempt, status);
      }
      const delay = this.#delayFor(attempt, failure);
      if (totalWaitMs + delay > this.#policy.read_max_total_wait_ms) {
        throw new GoogleApiError('wait_limit_exceeded', attempt, status);
      }
      totalWaitMs += delay;
      await this.#sleep(delay);
    }
  }

  // 1 回の試行。成功なら { ok: true, body }、再試行してよい失敗なら { ok: false, failure } を返す。
  // 応答本文にも 'kind' という名前の項目がありうるので、成否は ok の印だけで見分ける。再試行しない失敗は throw する。
  async #attempt(
    url: string,
    attempt: number,
  ): Promise<
    | { readonly ok: true; readonly body: unknown }
    | { readonly ok: false; readonly failure: AttemptFailure }
  > {
    const token = await this.#tokenSource.getAccessToken();
    let response: GoogleHttpTransportResponse;
    try {
      response = await this.#transport({
        url,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        timeoutMs: this.#policy.read_timeout_ms,
      });
    } catch (error) {
      if (error instanceof GoogleTransportFailure)
        return { ok: false, failure: { kind: error.reason } };
      throw error;
    }
    if (response.status === 200) {
      try {
        return { ok: true, body: JSON.parse(response.bodyText) as unknown };
      } catch {
        throw new GoogleApiError('invalid_response', attempt, response.status);
      }
    }
    if (!RETRYABLE_STATUSES.has(response.status)) {
      throw new GoogleApiError('http_error', attempt, response.status);
    }
    const header = response.headers['retry-after'];
    const retryAfterMs =
      header === undefined ? undefined : parseRetryAfter(header, this.#now());
    const failure: AttemptFailure =
      retryAfterMs === undefined
        ? { kind: 'http_error', status: response.status }
        : { kind: 'http_error', status: response.status, retryAfterMs };
    return { ok: false, failure };
  }

  #delayFor(attempt: number, failure: AttemptFailure): number {
    if ('retryAfterMs' in failure && failure.retryAfterMs !== undefined) {
      return failure.retryAfterMs;
    }
    const delays = this.#policy.read_base_delay_ms;
    const base = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
    const r = Math.min(Math.max(this.#random(), 0), 1);
    const factor = 1 - JITTER_RATIO + 2 * JITTER_RATIO * r;
    return Math.max(0, Math.round(base * factor));
  }
}

export interface GooglePage<T> {
  readonly items: readonly T[];
  readonly nextPageToken?: string;
}

// nextPageToken が無くなるまで読む（items が空でも続ける）。途中の失敗は部分結果を返さずそのまま伝播する。
export async function collectPages<T>(
  fetchPage: (pageToken: string | undefined) => Promise<GooglePage<T>>,
): Promise<readonly T[]> {
  const collected: T[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await fetchPage(pageToken);
    pages += 1;
    collected.push(...page.items);
    const next = page.nextPageToken;
    if (next === undefined || next.length === 0) return collected;
    if (seen.has(next)) {
      // 同じ pageToken が再び返った。無限ループを避けて失敗にする。
      throw new GoogleApiError('invalid_response', pages);
    }
    seen.add(next);
    pageToken = next;
  }
}

// 応答の検証用の小さな補助（google-calendar / google-gmail で使う）。
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function invalidResponse(): GoogleApiError {
  return new GoogleApiError('invalid_response', 1);
}

export function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalidResponse();
  return value;
}

export function readNextPageToken(record: Record<string, unknown>): {
  readonly nextPageToken?: string;
} {
  const token = optionalString(record, 'nextPageToken');
  return token === undefined || token.length === 0
    ? {}
    : { nextPageToken: token };
}
