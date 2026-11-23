// OAuth のループバックの戻り先（設計 04・ADR 0009・0144）。
// 認可の戻りは /v1 の経路ではなく、中枢の中の専用の小さな HTTP 受付で受ける（システムブラウザーが開く先なので
// 平文 HTTP・ループバックだけ）。受けるのは GET /oauth/callback だけで、state と code（または error）を
// OAuth サービスへ渡し、結果の文面（固定の文言。アカウント識別・トークン・コードは出さない）だけを返す。
// 待ち受けはループバック以外では開かない。

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { OAuthCallbackOutcome } from './oauth.js';

export interface OAuthCallbackServerOptions {
  /** 既定は 127.0.0.1。ループバック以外は拒否する。 */
  readonly host?: string;
  /** 既定は 47445。0 なら OS が空きポートを選ぶ（試験用）。 */
  readonly port?: number;
  readonly handleCallback: (
    query: URLSearchParams,
  ) => Promise<OAuthCallbackOutcome>;
  readonly log?: (message: string) => void;
}

export interface OAuthCallbackServer {
  readonly host: string;
  readonly port: number;
  /** リダイレクト先としてプロバイダへ登録・送信する URL。 */
  readonly redirectUri: string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  'localhost',
]);

function page(title: string, message: string): string {
  return [
    '<!doctype html>',
    '<html lang="ja"><head><meta charset="utf-8">',
    `<title>${title} - Buddy</title></head>`,
    `<body><h1>${title}</h1><p>${message}</p>`,
    '<p>このタブは閉じてかまいません。</p></body></html>',
  ].join('');
}

const SUCCESS_PAGE = page(
  '接続が完了しました',
  'Buddy に戻ると、接続が増えています。',
);
const FAILURE_PAGE = page(
  '接続できませんでした',
  'Buddy に戻って、もう一度接続を始めてください。',
);
const NOT_FOUND_PAGE = page('見つかりません', 'Buddy の OAuth の戻り先です。');

export function createOAuthCallbackServer(
  options: OAuthCallbackServerOptions,
): OAuthCallbackServer {
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host))
    throw new Error('oauth_callback_host_not_loopback');
  const requestedPort = options.port ?? 47445;
  const log = options.log ?? (() => undefined);
  let server: Server | null = null;
  let boundPort = requestedPort;

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/oauth/callback') {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(NOT_FOUND_PAGE);
      return;
    }
    let outcome: OAuthCallbackOutcome;
    try {
      outcome = await options.handleCallback(url.searchParams);
    } catch {
      outcome = { kind: 'failed', reason: 'exchange_failed' };
    }
    log(
      outcome.kind === 'connected'
        ? `OAuth の戻りを受け、接続を作成しました（${outcome.provider}）`
        : `OAuth の戻りを受けましたが、接続できませんでした（${outcome.reason}）`,
    );
    res.writeHead(outcome.kind === 'connected' ? 200 : 400, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(outcome.kind === 'connected' ? SUCCESS_PAGE : FAILURE_PAGE);
  }

  return {
    host,
    get port() {
      return boundPort;
    },
    get redirectUri() {
      return `http://${host}:${boundPort}/oauth/callback`;
    },
    listen() {
      return new Promise<void>((resolve, reject) => {
        server = createServer((req, res) => {
          void handle(req, res).catch(() => {
            try {
              res.writeHead(500);
              res.end();
            } catch {
              // 応答の失敗は諦める（ブラウザー側はタイムアウトで気づく）。
            }
          });
        });
        server.once('error', reject);
        server.listen(requestedPort, host, () => {
          const address = server?.address();
          if (address !== null && typeof address === 'object')
            boundPort = address.port;
          resolve();
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        if (server === null) {
          resolve();
          return;
        }
        const closing = server;
        server = null;
        closing.close(() => resolve());
        closing.closeAllConnections?.();
      });
    },
  };
}
