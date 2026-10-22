// 1 回だけ送る HTTP の呼び出し。自動再送はしない（keep-alive も使わず、毎回新しい接続で送る）。
import { request } from 'node:http';

export type HttpOutcome =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly body: unknown;
    }
  /** 接続を確立できなかった。要求は送られていない。 */
  | { readonly kind: 'not_sent' }
  /** 送ったが応答を受け取れなかった（時間切れ・切断）。相手が適用したかは分からない。 */
  | {
      readonly kind: 'no_response';
      readonly reason: 'timeout' | 'connection_lost';
    };

export interface HttpCall {
  readonly baseUrl: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly timeoutMs: number;
}

export function callOnce(call: HttpCall): Promise<HttpOutcome> {
  return new Promise((resolve) => {
    const url = new URL(call.path, call.baseUrl);
    const payload =
      call.body === undefined ? undefined : JSON.stringify(call.body);
    let settled = false;
    const finish = (outcome: HttpOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const req = request(
      url,
      {
        method: call.method,
        // 新しい接続を 1 本だけ使い、再利用・再試行をしない。
        agent: false,
        headers: {
          connection: 'close',
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = null;
          try {
            body = text.length === 0 ? null : JSON.parse(text);
          } catch {
            body = null;
          }
          finish({ kind: 'response', status: res.statusCode ?? 0, body });
        });
        res.on('error', () =>
          finish({ kind: 'no_response', reason: 'connection_lost' }),
        );
        res.on('aborted', () =>
          finish({ kind: 'no_response', reason: 'connection_lost' }),
        );
      },
    );
    const timer = setTimeout(() => {
      finish({ kind: 'no_response', reason: 'timeout' });
      req.destroy();
    }, call.timeoutMs);
    req.on('error', (error: NodeJS.ErrnoException) => {
      finish(
        error.code === 'ECONNREFUSED'
          ? { kind: 'not_sent' }
          : { kind: 'no_response', reason: 'connection_lost' },
      );
    });
    req.end(payload);
  });
}
