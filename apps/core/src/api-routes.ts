// HTTPS の経路の表（packages/contracts/openapi.yaml の paths、ADR 0009・0020）。
// 経路ごとの検査の順は domain の ROUTE_CHECKS が正本で、ここには形式（パス・クエリー・ヘッダー・本文の
// JSON Schema の定義名）だけを書く。OpenAPI と同じ表であることを api-routes.test.ts で確かめる。

export type HttpMethod = 'GET' | 'POST' | 'PUT';

export interface ApiRoute {
  readonly operationId: string;
  readonly method: HttpMethod;
  // OpenAPI のパスの書き方（`{name}` がパスの値）。
  readonly path: string;
  // パスの値の名前 → JSON Schema の定義名。
  readonly pathParams: Readonly<Record<string, string>>;
  // 必須のクエリー → JSON Schema の定義名。ここにないクエリーは拒否する。
  readonly query: Readonly<Record<string, string>>;
  // 本文の JSON Schema の定義名。null は本文なし（本文があれば拒否する）。
  readonly body: string | null;
  // 要求ヘッダー Buddy-Input-Origin（screen・voice・system）を必須とするか。
  readonly inputOrigin: boolean;
  // WebSocket へ切り替える経路（101）。
  readonly websocket: boolean;
  // 処理が未実装の経路（ADR 0034）。認可の検査（端末・自宅・接続範囲・ロック・画面操作）の後に 503 で閉じる。
  // 版を照合する先（予約の行など）がまだないので expected_revision は照合しない（実装した後の版の不一致 409 と
  // 区別する）。処理を足すときはこの印を外す（印のある経路に処理を渡すと createApiServer が拒否する）。
  readonly pending: boolean;
}

const route = (
  operationId: string,
  method: HttpMethod,
  path: string,
  options: {
    readonly body?: string;
    readonly inputOrigin?: boolean;
    readonly query?: Readonly<Record<string, string>>;
    readonly websocket?: boolean;
    readonly pending?: boolean;
  } = {},
): ApiRoute => {
  const pathParams: Record<string, string> = {};
  for (const match of path.matchAll(/\{([a-z_]+)\}/gu))
    pathParams[match[1] as string] = 'Id';
  return {
    operationId,
    method,
    path,
    pathParams,
    query: options.query ?? {},
    body: options.body ?? null,
    inputOrigin: options.inputOrigin ?? false,
    websocket: options.websocket ?? false,
    pending: options.pending ?? false,
  };
};

const SCREEN = { inputOrigin: true } as const;
const PENDING = { pending: true } as const;

export const API_ROUTES: readonly ApiRoute[] = [
  route('getBootstrap', 'GET', '/v1/bootstrap'),
  route('getSnapshot', 'GET', '/v1/snapshot'),
  route('createSession', 'POST', '/v1/sessions', {
    body: 'SessionCreateRequest',
  }),
  route('postTurn', 'POST', '/v1/sessions/{session_id}/turns', {
    body: 'TurnRequest',
  }),
  // 流れへの発言（ADR 0032）。UI-03 は区切り 1 つの最小の処理（自動の区切りは UI-05）。
  route('postStreamTurn', 'POST', '/v1/stream/turns', {
    body: 'StreamTurnRequest',
  }),
  // キャンバスの今の記述の読み取り（ADR 0032）。イベントの canvas の知らせ（版だけ）を受けた端末が取る。
  route('getCanvas', 'GET', '/v1/canvas'),
  route('handoffSession', 'POST', '/v1/sessions/{session_id}/handoff', {
    body: 'HandoffRequest',
    ...SCREEN,
  }),
  route('getOperation', 'GET', '/v1/operations/{id}'),
  route('previewOperation', 'POST', '/v1/operations/{id}/preview', {
    body: 'PreviewRequest',
  }),
  route('displayOperation', 'POST', '/v1/operations/{id}/display', {
    body: 'PreviewRequest',
  }),
  route('approveOperation', 'POST', '/v1/operations/{id}/approve', {
    body: 'ApprovalRequest',
    ...SCREEN,
  }),
  route('cancelOperation', 'POST', '/v1/operations/{id}/cancel', {
    body: 'StateCommand',
  }),
  route('reconcileOperation', 'POST', '/v1/operations/{id}/reconcile', {
    body: 'StateCommand',
  }),
  route('retryOperation', 'POST', '/v1/operations/{id}/retry', {
    body: 'StateCommand',
    ...SCREEN,
  }),
  route('listAutoActions', 'GET', '/v1/auto-actions'),
  route('undoAutoAction', 'POST', '/v1/auto-actions/{id}/undo', {
    body: 'StateCommand',
    ...SCREEN,
  }),
  route('resumeSafety', 'POST', '/v1/safety/resume', {
    body: 'SafetyResumeRequest',
    ...SCREEN,
  }),
  route('stopIo', 'POST', '/v1/io/stop', { body: 'IoStopRequest' }),
  route('resumeIo', 'POST', '/v1/io/resume', {
    body: 'IoResumeRequest',
    ...SCREEN,
  }),
  route('getEvents', 'GET', '/v1/events', { query: { cursor: 'EventCursor' } }),
  route('streamEvents', 'GET', '/v1/events/stream', {
    query: { cursor: 'EventCursor' },
    websocket: true,
  }),
  route('createLiveSession', 'POST', '/v1/live/sessions', {
    body: 'LiveSessionRequest',
  }),
  route(
    'closeLiveSession',
    'POST',
    '/v1/live/sessions/{live_session_id}/close',
    { body: 'LiveSessionClose' },
  ),
  route('startPairing', 'POST', '/v1/pairing/sessions', {
    body: 'PairingStartRequest',
    ...SCREEN,
  }),
  // B03-06: 承認待ちの申請の一覧（中枢の画面だけ。ADR 0026）。
  route('listPairingClaims', 'GET', '/v1/pairing/claims'),
  route('claimPairing', 'POST', '/v1/pairing/claims', {
    body: 'PairingClaimRequest',
  }),
  route(
    'decidePairingClaim',
    'POST',
    '/v1/pairing/claims/{claim_id}/decision',
    { body: 'PairingDecisionRequest', ...SCREEN },
  ),
  route('pickupPairingToken', 'POST', '/v1/pairing/claims/{claim_id}/token', {
    body: 'PairingTokenRequest',
  }),
  route('listDevices', 'GET', '/v1/devices'),
  route('revokeDevice', 'POST', '/v1/devices/{device_id}/revoke', {
    body: 'DeviceRevokeRequest',
    ...SCREEN,
  }),
  // 自宅の指紋の報告と自宅の登録（B03-03、ADR 0022）。
  route('reportHomeFingerprint', 'POST', '/v1/home-network/reports', {
    body: 'HomeFingerprintReport',
  }),
  // B03-08: 自宅の登録の状態（中枢の画面だけ）。
  route('getHomeRegistration', 'GET', '/v1/home-network/registration'),
  route('registerHome', 'PUT', '/v1/home-network/registration', {
    body: 'HomeRegistrationRequest',
    ...SCREEN,
  }),
  route('listConnections', 'GET', '/v1/connections'),
  route('startOAuth', 'POST', '/v1/connections/oauth/start', {
    body: 'OAuthStartRequest',
    ...SCREEN,
  }),
  route(
    'updateConnectionTargets',
    'PUT',
    '/v1/connections/{connection_id}/targets',
    { body: 'ConnectionTargetsRequest', ...SCREEN },
  ),
  route(
    'disconnectConnection',
    'POST',
    '/v1/connections/{connection_id}/disconnect',
    { body: 'ConnectionDisconnectRequest', ...SCREEN },
  ),
  // 予算（ADR 0034）。処理は B07-05 で足す。それまでは認可の検査の後に 503（pending）。
  route('getBudgetUsage', 'GET', '/v1/budget/usage', PENDING),
  route(
    'decideBudgetOverage',
    'POST',
    '/v1/budget/overage-approvals/{approval_id}/decision',
    { body: 'BudgetOverageDecision', ...SCREEN, ...PENDING },
  ),
  route(
    'reviewBudgetOverrun',
    'POST',
    '/v1/budget/reservations/{reservation_id}/overrun-review',
    { body: 'BudgetOverrunReview', ...SCREEN, ...PENDING },
  ),
  route(
    'settleBudgetManually',
    'POST',
    '/v1/budget/reservations/{reservation_id}/manual-settlement',
    { body: 'BudgetManualSettlement', ...SCREEN, ...PENDING },
  ),
];

export type RouteMatch =
  | {
      readonly ok: true;
      readonly route: ApiRoute;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly status: 404 | 405 };

const segmentsOf = (path: string): string[] => path.split('/').slice(1);

// パスと方法から経路を選ぶ。固定の部分が一致する経路を、パスの値を含む経路より優先する。
// パスの値は復号しない（% を含む値は JSON Schema の Id に合わず、形式の検査で拒否される）。
export function matchRoute(method: string, pathname: string): RouteMatch {
  const segments = segmentsOf(pathname);
  let pathMatched = false;
  let best: {
    route: ApiRoute;
    params: Record<string, string>;
    literals: number;
  } | null = null;
  for (const candidate of API_ROUTES) {
    const template = segmentsOf(candidate.path);
    if (template.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let literals = 0;
    let matched = true;
    for (const [index, part] of template.entries()) {
      const actual = segments[index] as string;
      const name = /^\{([a-z_]+)\}$/u.exec(part)?.[1];
      if (name !== undefined) {
        if (actual.length === 0) {
          matched = false;
          break;
        }
        params[name] = actual;
      } else if (part === actual) literals += 1;
      else {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    pathMatched = true;
    if (candidate.method !== method) continue;
    if (best === null || literals > best.literals)
      best = { route: candidate, params, literals };
  }
  if (best !== null)
    return { ok: true, route: best.route, params: best.params };
  return { ok: false, status: pathMatched ? 405 : 404 };
}

// 処理が未実装の経路（pending）の operationId。
export const PENDING_ROUTE_IDS: ReadonlySet<string> = new Set(
  API_ROUTES.filter((route) => route.pending).map((route) => route.operationId),
);
