// Microsoft Graph 用の薄い HTTP transport（B09-02、ADR 0134）。
// B08-03 の HTTP の土台が未マージのため、Graph 専用に置く。connector は transport を注入で受け取るので、
// 土台が入ったら差し替えられる。1 回だけ送り、自動再送はしない（keep-alive も使わず、毎回新しい接続で送る）。
// 意味論は http.ts の callOnce と同じ（not_sent と no_response を区別する）。Retry-After を読むため応答ヘッダーも返す。
import { request } from 'node:https';
import type { HttpOutcome } from './http.js';

/** Graph の結果。HttpOutcome の応答に、応答ヘッダー（小文字のキー）を加えたもの。 */
export type GraphHttpOutcome =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      /** JSON として読めない本文は null。 */
      readonly body: unknown;
    }
  | Exclude<HttpOutcome, { readonly kind: 'response' }>;

export interface GraphHttpCall {
  readonly method: 'GET';
  /** 完全な URL（@odata.nextLink もそのまま渡す）。 */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** 中止されたら時間切れとして扱う（試験用）。 */
  readonly signal?: AbortSignal;
}

export type GraphTransport = (call: GraphHttpCall) => Promise<GraphHttpOutcome>;

export const defaultGraphTransport: GraphTransport = (call) =>
  new Promise((resolve) => {
    let settled = false;
    function expire(): void {
      finish({ kind: 'no_response', reason: 'timeout' });
      req.destroy();
    }
    const finish = (outcome: GraphHttpOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 終わった要求は、中止の通知を受けない（同じ signal を使う後の要求に影響しない）。
      call.signal?.removeEventListener('abort', expire);
      resolve(outcome);
    };
    const req = request(
      new URL(call.url),
      {
        method: call.method,
        // 新しい接続を 1 本だけ使い、再利用・再試行をしない。
        agent: false,
        headers: { ...call.headers, connection: 'close' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown;
          try {
            body = text.length === 0 ? null : JSON.parse(text);
          } catch {
            body = null;
          }
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') headers[name] = value;
            else if (Array.isArray(value)) headers[name] = value.join(', ');
          }
          finish({
            kind: 'response',
            status: res.statusCode ?? 0,
            headers,
            body,
          });
        });
        res.on('error', () =>
          finish({ kind: 'no_response', reason: 'connection_lost' }),
        );
        res.on('aborted', () =>
          finish({ kind: 'no_response', reason: 'connection_lost' }),
        );
      },
    );
    const timer = setTimeout(expire, call.timeoutMs);
    if (call.signal?.aborted === true) expire();
    else call.signal?.addEventListener('abort', expire, { once: true });
    // エラーの内容（ヘッダーを含みうる）は結果に載せない。
    req.on('error', (error: NodeJS.ErrnoException) => {
      finish(
        error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND'
          ? { kind: 'not_sent' }
          : { kind: 'no_response', reason: 'connection_lost' },
      );
    });
    req.end();
  });
