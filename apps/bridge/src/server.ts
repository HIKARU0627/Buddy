// Muse 向けの窓口（HTTP。ADR 0143）。
//
// - 公開する経路は v1 の範囲だけ（候補の読み取り・根拠・状態の変更、接続と同期の状態、状態照会、
//   イベントのポーリング、調べ物の依頼）。ここに無い経路は 404 で、Core へは送らない。
//   操作の承認・ペアリング・端末管理・OAuth の開始・Live・キャンバスの操作は公開しない（ADR 0143）。
// - 認証はブリッジ独自のトークン（Authorization: Bearer）。設定には hash だけがあり、照合は hash 同士。
// - 応答は Core の状態と本文をそのまま返す（中継であって、解釈・再判定はしない。正本は Core）。
// - 調べ物の依頼は、ブリッジ専用の会話（セッション）を 1 つ持ち回して発言として送る（U254 の受け口）。
//   区切りの世代が進んで 409 になったら、会話を作り直して 1 回だけ送り直す。
// - 監査ログには時刻・経路の名前・結果の状態だけを出す。本文・トークン・候補の題は出さない。
// - 待ち受けは Tailscale のアドレスを明示したときだけ（ワイルドカードは拒否する。cli が起動前に確かめる）。

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { BridgeConfig } from './config.js';
import { bridgeTokenMatches } from './config.js';
import type { CoreClient, CoreClientOutcome } from './core-client.js';

export interface AuditEntry {
  readonly at: string;
  // 経路の名前（例: candidate_state）。具体の ID は含めない。
  readonly route: string;
  readonly method: string;
  readonly status: number;
}

export interface BridgeServerDeps {
  readonly config: BridgeConfig;
  readonly client: CoreClient;
  readonly audit?: (entry: AuditEntry) => void;
  readonly now?: () => Date;
  // 頻度制限（1 分あたりの要求数。既定 120）。
  readonly rateLimitPerMinute?: number;
}

export interface BridgeServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  readonly port: number;
}

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_RATE_LIMIT = 120;

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const bridgeError = (status: number, code: string, message: string): Reply => ({
  status,
  body: { code, message },
});

// Core の結果をそのまま返す。届かない・証明書が違うときは、ブリッジ側の 503 にする（理由のコードだけ）。
function relay(outcome: CoreClientOutcome): Reply {
  if (outcome.kind === 'response') {
    const body =
      typeof outcome.body === 'object' &&
      outcome.body !== null &&
      !Array.isArray(outcome.body)
        ? (outcome.body as Record<string, unknown>)
        : { value: outcome.body };
    return { status: outcome.status, body };
  }
  if (outcome.kind === 'certificate_mismatch')
    return bridgeError(
      503,
      'core_certificate_mismatch',
      '中枢の証明書がピン留めした指紋と違います。再ペアリングが必要です。',
    );
  return bridgeError(
    503,
    'core_unreachable',
    `中枢へ接続できません（${outcome.reason}）。`,
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface ResearchSession {
  readonly sessionId: string;
  readonly segmentGeneration: string;
}

export function createBridgeServer(deps: BridgeServerDeps): BridgeServer {
  const now = deps.now ?? (() => new Date());
  const rateLimit = deps.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT;
  let researchSession: ResearchSession | null = null;
  let windowStartMs = 0;
  let windowCount = 0;

  const createResearchSession = async (): Promise<
    { ok: true; session: ResearchSession } | { ok: false; reply: Reply }
  > => {
    const created = await deps.client.command('POST', '/v1/sessions', {
      storage_mode: 'normal',
    });
    if (created.kind !== 'response' || created.status !== 201)
      return { ok: false, reply: relay(created) };
    if (!isRecord(created.body))
      return {
        ok: false,
        reply: bridgeError(
          503,
          'core_response_invalid',
          '中枢の応答が読めません。',
        ),
      };
    const sessionId = created.body['session_id'];
    const generation = created.body['segment_generation'];
    if (typeof sessionId !== 'string' || typeof generation !== 'string')
      return {
        ok: false,
        reply: bridgeError(
          503,
          'core_response_invalid',
          '中枢の応答が読めません。',
        ),
      };
    return {
      ok: true,
      session: { sessionId, segmentGeneration: generation },
    };
  };

  const postResearch = async (text: string): Promise<Reply> => {
    if (researchSession === null) {
      const created = await createResearchSession();
      if (!created.ok) return created.reply;
      researchSession = created.session;
    }
    const sendTurn = async (
      session: ResearchSession,
    ): Promise<CoreClientOutcome> =>
      deps.client.command(
        'POST',
        `/v1/sessions/${encodeURIComponent(session.sessionId)}/turns`,
        {
          text,
          input_kind: 'text',
          origin: {
            segment_id: session.sessionId,
            segment_generation: session.segmentGeneration,
          },
        },
      );
    const first = await sendTurn(researchSession);
    // 区切りの世代が進んだ（別の窓口の操作などで会話が進んだ）ときは、会話を作り直して 1 回だけ送り直す。
    // 409 は受付の前の照合の拒否で、発言は記録されていない。
    if (first.kind === 'response' && first.status === 409) {
      researchSession = null;
      const created = await createResearchSession();
      if (!created.ok) return created.reply;
      researchSession = created.session;
      return relay(await sendTurn(researchSession));
    }
    return relay(first);
  };

  interface RouteMatch {
    readonly name: string;
    readonly params: Readonly<Record<string, string>>;
    readonly run: (
      params: Readonly<Record<string, string>>,
      query: URLSearchParams,
      body: Record<string, unknown> | null,
    ) => Promise<Reply>;
  }

  const routes: readonly {
    readonly name: string;
    readonly method: string;
    readonly segments: readonly string[];
    readonly run: RouteMatch['run'];
  }[] = [
    {
      name: 'health',
      method: 'GET',
      segments: ['bridge', 'v1', 'health'],
      run: async () => ({ status: 200, body: { status: 'ok' } }),
    },
    {
      name: 'candidates_list',
      method: 'GET',
      segments: ['bridge', 'v1', 'candidates'],
      run: async () => relay(await deps.client.read('/v1/candidates')),
    },
    {
      name: 'candidate_evidence',
      method: 'POST',
      segments: ['bridge', 'v1', 'candidates', '{candidate_id}', 'evidence'],
      run: async (params) =>
        relay(
          await deps.client.command(
            'POST',
            `/v1/candidates/${encodeURIComponent(params['candidate_id'] ?? '')}/evidence`,
            {},
          ),
        ),
    },
    {
      name: 'candidate_state',
      method: 'POST',
      segments: ['bridge', 'v1', 'candidates', '{candidate_id}', 'state'],
      run: async (params, _query, body) => {
        // 形は Core の契約（CandidateStateCommand）が正本で、ブリッジは項目を絞って渡すだけ。
        const event = body?.['event'];
        const expectedState = body?.['expected_state'];
        const snoozeUntil = body?.['snooze_until'] ?? null;
        if (typeof event !== 'string' || typeof expectedState !== 'string')
          return bridgeError(
            422,
            'invalid_input',
            'event と expected_state（文字列）が必要です。',
          );
        if (snoozeUntil !== null && typeof snoozeUntil !== 'string')
          return bridgeError(
            422,
            'invalid_input',
            'snooze_until は文字列か null です。',
          );
        return relay(
          await deps.client.command(
            'POST',
            `/v1/candidates/${encodeURIComponent(params['candidate_id'] ?? '')}/state`,
            {
              event,
              expected_state: expectedState,
              snooze_until: snoozeUntil,
            },
            { inputOrigin: 'chat' },
          ),
        );
      },
    },
    {
      name: 'connections_list',
      method: 'GET',
      segments: ['bridge', 'v1', 'connections'],
      run: async () => relay(await deps.client.read('/v1/connections')),
    },
    {
      name: 'connection_targets',
      method: 'GET',
      segments: ['bridge', 'v1', 'connections', '{connection_id}', 'targets'],
      run: async (params) =>
        relay(
          await deps.client.read(
            `/v1/connections/${encodeURIComponent(params['connection_id'] ?? '')}/targets`,
          ),
        ),
    },
    {
      name: 'connection_sync',
      method: 'GET',
      segments: ['bridge', 'v1', 'connections', '{connection_id}', 'sync'],
      run: async (params) =>
        relay(
          await deps.client.read(
            `/v1/connections/${encodeURIComponent(params['connection_id'] ?? '')}/sync`,
          ),
        ),
    },
    {
      name: 'snapshot',
      method: 'GET',
      segments: ['bridge', 'v1', 'snapshot'],
      run: async () => relay(await deps.client.read('/v1/snapshot')),
    },
    {
      name: 'budget_usage',
      method: 'GET',
      segments: ['bridge', 'v1', 'budget', 'usage'],
      run: async () => relay(await deps.client.read('/v1/budget/usage')),
    },
    {
      name: 'operation_get',
      method: 'GET',
      segments: ['bridge', 'v1', 'operations', '{id}'],
      run: async (params) =>
        relay(
          await deps.client.read(
            `/v1/operations/${encodeURIComponent(params['id'] ?? '')}`,
          ),
        ),
    },
    {
      name: 'events',
      method: 'GET',
      segments: ['bridge', 'v1', 'events'],
      run: async (_params, query) => {
        const cursor = query.get('cursor');
        if (cursor === null || cursor === '')
          return bridgeError(
            422,
            'invalid_input',
            'cursor が必要です。最初の位置は snapshot の event_cursor です。',
          );
        return relay(
          await deps.client.read(
            `/v1/events?cursor=${encodeURIComponent(cursor)}`,
          ),
        );
      },
    },
    {
      name: 'research',
      method: 'POST',
      segments: ['bridge', 'v1', 'research'],
      run: async (_params, _query, body) => {
        const text = body?.['text'];
        if (typeof text !== 'string' || text === '' || text.length > 4000)
          return bridgeError(
            422,
            'invalid_input',
            'text（1〜4000 文字）が必要です。',
          );
        return postResearch(text);
      },
    },
  ];

  const match = (
    method: string,
    pathname: string,
  ): (RouteMatch & { authExempt: boolean }) | null => {
    const segments = pathname.split('/').slice(1);
    for (const route of routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (const [index, part] of route.segments.entries()) {
        const actual = segments[index] as string;
        const name = /^\{([a-z_]+)\}$/u.exec(part)?.[1];
        if (name !== undefined) {
          if (actual.length === 0) {
            matched = false;
            break;
          }
          try {
            params[name] = decodeURIComponent(actual);
          } catch {
            matched = false;
            break;
          }
        } else if (part !== actual) {
          matched = false;
          break;
        }
      }
      if (matched)
        return {
          name: route.name,
          params,
          run: route.run,
          authExempt: route.name === 'health',
        };
    }
    return null;
  };

  const readBody = async (
    request: IncomingMessage,
  ): Promise<
    | { readonly kind: 'ok'; readonly body: Record<string, unknown> | null }
    | { readonly kind: 'too_large' }
    | { readonly kind: 'invalid' }
  > => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) return { kind: 'too_large' };
      chunks.push(buffer);
    }
    if (bytes === 0) return { kind: 'ok', body: null };
    try {
      const value = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      ) as unknown;
      return isRecord(value)
        ? { kind: 'ok', body: value }
        : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  };

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const send = (reply: Reply, routeName: string) => {
      const text = JSON.stringify(reply.body);
      response.writeHead(reply.status, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(text)),
      });
      response.end(text);
      deps.audit?.({
        at: now().toISOString(),
        route: routeName,
        method: request.method ?? '',
        status: reply.status,
      });
    };
    const url = new URL(request.url ?? '/', 'http://bridge.invalid');
    const matched = match(request.method ?? '', url.pathname);
    if (matched === null) {
      send(
        bridgeError(
          404,
          'not_found',
          'その経路はブリッジでは公開していません。',
        ),
        'unmatched',
      );
      return;
    }
    // 頻度制限（1 分の窓。認証の前で数える）。
    const atMs = now().getTime();
    if (atMs - windowStartMs >= 60_000) {
      windowStartMs = atMs;
      windowCount = 0;
    }
    windowCount += 1;
    if (windowCount > rateLimit) {
      send(
        bridgeError(
          429,
          'rate_limited',
          '要求が多すぎます。少し待ってください。',
        ),
        matched.name,
      );
      return;
    }
    if (!matched.authExempt) {
      const header = request.headers['authorization'];
      const presented =
        typeof header === 'string' && header.startsWith('Bearer ')
          ? header.slice('Bearer '.length)
          : null;
      if (!bridgeTokenMatches(deps.config, presented)) {
        send(
          bridgeError(
            401,
            'unauthenticated',
            'ブリッジの認証トークンが違います。',
          ),
          matched.name,
        );
        return;
      }
    }
    let body: Record<string, unknown> | null = null;
    if (request.method === 'POST') {
      const read = await readBody(request);
      if (read.kind === 'too_large') {
        send(
          bridgeError(413, 'payload_too_large', '本文が大きすぎます。'),
          matched.name,
        );
        return;
      }
      if (read.kind === 'invalid') {
        send(
          bridgeError(
            422,
            'invalid_input',
            '本文は JSON のオブジェクトにしてください。',
          ),
          matched.name,
        );
        return;
      }
      body = read.body;
    }
    try {
      send(
        await matched.run(matched.params, url.searchParams, body),
        matched.name,
      );
    } catch {
      send(
        bridgeError(503, 'bridge_error', 'ブリッジの処理に失敗しました。'),
        matched.name,
      );
    }
  };

  const server: Server = createServer((request, response) => {
    // 予期しない失敗でも応答を返す（待ちを残さない）。
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        const text = JSON.stringify({
          code: 'bridge_error',
          message: 'ブリッジの処理に失敗しました。',
        });
        response.writeHead(503, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(text)),
        });
        response.end(text);
      } else response.destroy();
    });
  });

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(deps.config.listen.port, deps.config.listen.host, () => {
          server.off('error', reject);
          resolve();
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
    get port() {
      const address = server.address();
      return typeof address === 'object' && address !== null
        ? address.port
        : deps.config.listen.port;
    },
  };
}
