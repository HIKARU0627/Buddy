// 中枢の画面の端末の「申請の承認」「端末の管理」の画面の状態と、操作から送る要求（ADR 0024・0026）。
// React と DOM に依存しない純粋な関数だけを置き、node:test で試験する。受付の規則・参照の解決は main が持つ。
// 画面が持つのは main が作った参照（ref）だけで、申請 ID・端末 ID・コード・秘密・トークンは来ない。
import type {
  DesktopClaimEntry,
  DesktopDeviceEntry,
  DesktopPairingSession,
  DesktopIpcRequest,
  DesktopIpcResponse,
} from '@buddy/contracts';
import { request } from '../desktop-api.js';
import { REJECT_MESSAGES } from '../labels.js';

// 承認待ちの申請を取り直す間隔（中枢は新しい申請を知らせないため）。
export const CLAIMS_REFRESH_MS = 3_000;

export interface HubViewState {
  // null はまだ受け取っていない。
  readonly claims: readonly DesktopClaimEntry[] | null;
  readonly devices: readonly DesktopDeviceEntry[] | null;
  // 中枢の画面で始めたペアリングのコードと指紋（始めていなければ null）。
  readonly session: DesktopPairingSession | null;
  // 操作の結果の文言（拒否・失敗）。null なら出さない。
  readonly message: string | null;
  // 承認・拒否・失効を送って結果を待っている（二重に押させない）。
  readonly busy: boolean;
}

export const INITIAL_HUB_STATE: HubViewState = {
  claims: null,
  devices: null,
  session: null,
  message: null,
  busy: false,
};

export const HUB_IPC_FAILURE_MESSAGE = 'main と通信できませんでした。';

const HEAVY: ReadonlySet<string> = new Set([
  'desktop.claim_decide',
  'desktop.device_revoke',
  'desktop.pairing_open',
]);

// main の応答を反映する。一覧の応答は置き換え、拒否は文言だけを出して一覧を変えない。
export function applyHubResponse(
  state: HubViewState,
  sent: DesktopIpcRequest['channel'],
  response: DesktopIpcResponse,
): HubViewState {
  const busy = HEAVY.has(sent) ? false : state.busy;
  if (response.outcome === 'rejected')
    return { ...state, busy, message: REJECT_MESSAGES[response.reason] };
  if ('session' in response)
    return { ...state, busy, session: response.session, message: null };
  if ('claims' in response)
    return {
      ...state,
      busy,
      claims: response.claims,
      message: HEAVY.has(sent) ? null : state.message,
    };
  if ('devices' in response)
    return {
      ...state,
      busy,
      devices: response.devices,
      message: HEAVY.has(sent) ? null : state.message,
    };
  return { ...state, busy };
}

export function applyHubFailure(state: HubViewState): HubViewState {
  return { ...state, busy: false, message: HUB_IPC_FAILURE_MESSAGE };
}

export interface HubActions {
  readonly refreshClaims: () => void;
  readonly refreshDevices: () => void;
  readonly decide: (ref: string, decision: 'approve' | 'reject') => void;
  readonly revoke: (ref: string) => void;
  readonly openPairing: () => void;
}

export function hubActions(
  send: (built: DesktopIpcRequest) => void,
): HubActions {
  return {
    refreshClaims: () => send(request('desktop.claims_list', null)),
    refreshDevices: () => send(request('desktop.devices_list', null)),
    decide: (ref, decision) =>
      send(request('desktop.claim_decide', { ref, decision })),
    revoke: (ref) => send(request('desktop.device_revoke', { ref })),
    openPairing: () => send(request('desktop.pairing_open', null)),
  };
}

// 送る前の状態（重い操作は結果を待つ間ボタンを止める）。
export function markSending(
  state: HubViewState,
  built: DesktopIpcRequest,
): HubViewState {
  return HEAVY.has(built.channel) ? { ...state, busy: true } : state;
}
