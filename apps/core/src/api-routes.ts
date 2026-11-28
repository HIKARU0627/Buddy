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
  // 要求ヘッダー Buddy-Input-Origin（screen・voice・system・chat）を必須とするか。
  readonly inputOrigin: boolean;
  // WebSocket へ切り替える経路（101）。
  readonly websocket: boolean;
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
    // パスの値のうち Id でないもの（名前 → JSON Schema の定義名）。
    readonly pathSchemas?: Readonly<Record<string, string>>;
  } = {},
): ApiRoute => {
  const pathParams: Record<string, string> = {};
  for (const match of path.matchAll(/\{([a-z_]+)\}/gu)) {
    const name = match[1] as string;
    pathParams[name] = options.pathSchemas?.[name] ?? 'Id';
  }
  return {
    operationId,
    method,
    path,
    pathParams,
    query: options.query ?? {},
    body: options.body ?? null,
    inputOrigin: options.inputOrigin ?? false,
    websocket: options.websocket ?? false,
  };
};

const SCREEN = { inputOrigin: true } as const;

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
  // 保存モードの切り替え（U170、ADR 0060）。流れの経路を唯一の入口・出口にし、端末は会話の ID を送らない。
  // 本人の画面操作だけ（UI-05 の段階 6、ADR 0189）。
  route('postStreamStorageMode', 'POST', '/v1/stream/storage-mode', {
    body: 'StorageModeChangeRequest',
    ...SCREEN,
  }),
  // 流れの今の保存モードの読み取り（UI-05 の段階 6、ADR 0189）。端末の状態欄に出す。
  route('getStreamStorageMode', 'GET', '/v1/stream/storage-mode'),
  // 流れの表示先の移動と今の表示先の読み取り（UI-05 の段階 5、ADR 0193）。端末は会話の ID を送らない。本人の画面操作だけ。
  route('postStreamHandoff', 'POST', '/v1/stream/handoff', {
    body: 'HandoffRequest',
    ...SCREEN,
  }),
  route('getStreamHandoff', 'GET', '/v1/stream/handoff'),
  // キャンバスの今の記述の読み取り（ADR 0032）。イベントの canvas の知らせ（版だけ）を受けた端末が取る。
  route('getCanvas', 'GET', '/v1/canvas'),
  // キャンバスのユーザーの操作の記録（UI-06、ADR 0032）。本人の画面操作。
  route('postCanvasUserOp', 'POST', '/v1/canvas/user-ops', {
    body: 'CanvasUserOpRequest',
    ...SCREEN,
  }),
  // キャンバスの物の中身の読み取り（UI-07、ADR 0032）。許可範囲内で本文を返す。読み取りだけで、イベントの記録に入れない。
  route('postCanvasContent', 'POST', '/v1/canvas/content', {
    body: 'CanvasContentRequest',
  }),
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
  // リースの取得と更新（heartbeat。ADR 0046）。
  route('renewLease', 'POST', '/v1/leases/renew', {
    body: 'LeaseRenewalRequest',
  }),
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
  // 取得対象と同期の状態（B08-01、ADR 0071）。どちらも読み取りで、トークンと本文を返さない。
  route(
    'getConnectionTargets',
    'GET',
    '/v1/connections/{connection_id}/targets',
  ),
  route('getConnectionSync', 'GET', '/v1/connections/{connection_id}/sync'),
  // 選べる取得対象（ADR 0145）。中枢が提供元から読み、保存しない。中枢の画面だけ。
  route(
    'listConnectionTargetOptions',
    'GET',
    '/v1/connections/{connection_id}/target-options',
  ),
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
  // 予算（ADR 0034・0039）。処理は api-budget.ts（B07-05）。
  route('getBudgetUsage', 'GET', '/v1/budget/usage'),
  route(
    'decideBudgetOverage',
    'POST',
    '/v1/budget/overage-approvals/{approval_id}/decision',
    { body: 'BudgetOverageDecision', ...SCREEN },
  ),
  route(
    'reviewBudgetOverrun',
    'POST',
    '/v1/budget/reservations/{reservation_id}/overrun-review',
    { body: 'BudgetOverrunReview', ...SCREEN },
  ),
  route(
    'settleBudgetManually',
    'POST',
    '/v1/budget/reservations/{reservation_id}/manual-settlement',
    { body: 'BudgetManualSettlement', ...SCREEN },
  ),
  // 気づき（候補）の一覧・根拠の再取得・状態の変更（B11-04 P2、ADR 0130）。処理は api-candidates.ts。
  route('listCandidates', 'GET', '/v1/candidates'),
  // 気づきの OS 通知の入・切（ADR 0196）。処理は candidate-alerts.ts。読み取りは端末の main が後ろで読む。
  route('getCandidateAlertSettings', 'GET', '/v1/candidates/alert-settings'),
  route(
    'changeCandidateAlertSettings',
    'POST',
    '/v1/candidates/alert-settings',
    {
      body: 'CandidateAlertSettingsChangeRequest',
      ...SCREEN,
    },
  ),
  // 根拠は許可範囲から取り直すので接続範囲を本文で示す（postCanvasContent と同じ POST）。
  route(
    'getCandidateEvidence',
    'POST',
    '/v1/candidates/{candidate_id}/evidence',
    { body: 'CandidateEvidenceRequest' },
  ),
  route('changeCandidateState', 'POST', '/v1/candidates/{candidate_id}/state', {
    body: 'CandidateStateCommand',
    ...SCREEN,
  }),
  // 家計簿の月ごとの合計・1 か月・分類の変更・削除（ADR 0161）。処理は api-household.ts。
  route('listHouseholdMonths', 'GET', '/v1/household/months'),
  route('getHouseholdMonth', 'GET', '/v1/household/months/{month}', {
    pathSchemas: { month: 'YearMonth' },
  }),
  route(
    'changeHouseholdCategory',
    'POST',
    '/v1/household/entries/{entry_id}/category',
    { body: 'HouseholdCategoryChangeRequest', ...SCREEN },
  ),
  route(
    'deleteHouseholdEntry',
    'POST',
    '/v1/household/entries/{entry_id}/delete',
    { body: 'HouseholdEntryDeleteRequest', ...SCREEN },
  ),
  // 請求予定を消す（ADR 0179）。家計の記録の削除と同じ検査。処理は api-household.ts。
  route('deleteHouseholdBill', 'POST', '/v1/household/bills/{bill_id}/delete', {
    body: 'HouseholdBillDeleteRequest',
    ...SCREEN,
  }),
  // 家計簿の設定（利用通知の取り込みの入・切。ADR 0163）。
  route('changeHouseholdSettings', 'POST', '/v1/household/settings', {
    body: 'HouseholdSettingsChangeRequest',
    ...SCREEN,
  }),
  // 外部の家計簿サービスの書き出しの取り込み（ADR 0164）。
  route('importHouseholdRows', 'POST', '/v1/household/imports', {
    body: 'HouseholdImportRequest',
    ...SCREEN,
  }),
  // 分類ごとの予算（ADR 0166）。
  route('changeHouseholdBudget', 'POST', '/v1/household/budget', {
    body: 'HouseholdBudgetChangeRequest',
    ...SCREEN,
  }),
  // 家計の記録の手入力（ADR 0167）。
  route('createHouseholdEntry', 'POST', '/v1/household/entries', {
    body: 'HouseholdEntryCreateRequest',
    ...SCREEN,
  }),
  // 家計の記録の中身の変更（ADR 0169）。
  route(
    'changeHouseholdEntry',
    'POST',
    '/v1/household/entries/{entry_id}/content',
    { body: 'HouseholdEntryContentChangeRequest', ...SCREEN },
  ),
  // レシートの写真の読み取りの入・切と、写真 1 枚の読み取り（ADR 0177）。
  route(
    'changeHouseholdReceiptSetting',
    'POST',
    '/v1/household/receipt-setting',
    { body: 'HouseholdReceiptSettingRequest', ...SCREEN },
  ),
  route('readHouseholdReceipt', 'POST', '/v1/household/receipt-readings', {
    body: 'HouseholdReceiptImageRequest',
    ...SCREEN,
  }),
  // 記憶の一覧（UI-10、ADR 0183）。処理は api-memory.ts。本文を返すので本人の画面操作だけ（Buddy-Input-Origin を求める）。
  route('listMemories', 'GET', '/v1/memory/records', SCREEN),
  // 保存してよい記憶の種類の設定の読み取りと変更（ADR 0191）。処理は api-memory.ts。
  route('getMemorySettings', 'GET', '/v1/memory/settings', SCREEN),
  route('changeMemorySettings', 'POST', '/v1/memory/settings', {
    body: 'MemorySettingsChangeRequest',
    ...SCREEN,
  }),
  // 記憶の忘却の計画と実行（B06-07b-2、ADR 0180）。処理は api-forget.ts。忘却の公開ゲートが閉じている間は 503。
  route('createForgetPlan', 'POST', '/v1/memory/forget-plans', {
    body: 'ForgetPlanRequest',
    ...SCREEN,
  }),
  route(
    'executeForgetPlan',
    'POST',
    '/v1/memory/forget-plans/{plan_id}/execute',
    { body: 'ForgetExecuteRequest', ...SCREEN },
  ),
  // 忘却台帳の端末への配信（B06-07b-2、ADR 0180）。本文なしの読み取り。
  route('getForgetLedgerEntries', 'POST', '/v1/forget-ledger/sync', {
    body: 'ForgetLedgerSyncRequest',
  }),
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
