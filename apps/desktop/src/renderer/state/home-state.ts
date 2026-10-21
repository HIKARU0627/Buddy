// 中枢の画面の「自宅のネットワーク」の画面の状態と、操作から送る要求（ADR 0022・0024・0026、B03-08）。
// React と DOM に依存しない純粋な関数だけを置き、node:test で試験する。受付の規則・参照の解決・指紋の読み取りは
// main が持つ。画面に来るのは伏せた表示と main の参照（ref）だけで、MAC・SSID の値は来ない。
import type {
  DesktopHomeView,
  DesktopIpcRequest,
  DesktopIpcResponse,
} from '@buddy/contracts';
import { request } from '../desktop-api.js';
import { REJECT_MESSAGES } from '../labels.js';

type RejectReason = Extract<
  DesktopIpcResponse,
  { outcome: 'rejected' }
>['reason'];

export interface HomeViewState {
  // null はまだ受け取っていない。
  readonly home: DesktopHomeView | null;
  // 読み取り（desktop.home_status）の結果を待っている。
  readonly reading: boolean;
  // 登録を送って結果を待っている（二重に押させない）。
  readonly busy: boolean;
  // 操作の拒否・失敗の文言（押したボタンのすぐ下に出す）。null なら出さない。
  readonly message: string | null;
  // 登録が終わった知らせ（一度だけ出す）。
  readonly registered: boolean;
}

export const INITIAL_HOME_STATE: HomeViewState = {
  home: null,
  reading: false,
  busy: false,
  message: null,
  registered: false,
};

export const HOME_IPC_FAILURE_MESSAGE =
  'main と通信できませんでした。「読み取り直す」を押してください。';

// 自宅の登録で言い方を変える拒否（何が起きたかと、次の行動）。それ以外は共通の文言。
const HOME_REJECT_MESSAGES: Partial<Record<RejectReason, string>> = {
  entry_not_found:
    '読み取った内容が古くなっています。「読み取り直す」を押してから、もう一度登録してください。',
  outcome_unknown:
    '登録できたか確かめられませんでした。自動では送り直しません。「読み取り直す」で最終更新の時刻を確かめてください。',
  core_rejected:
    '中枢が登録を受け付けませんでした。「読み取り直す」を押してから、もう一度登録してください。',
  not_connected:
    '中枢に接続していないため、自宅のネットワークを確かめられません。接続してから「読み取り直す」を押してください。',
};

export function homeRejectMessage(reason: RejectReason): string {
  return HOME_REJECT_MESSAGES[reason] ?? REJECT_MESSAGES[reason];
}

// main の応答を反映する。読み取り・登録の応答は表示を置き換え、拒否は文言だけを出して表示を変えない。
export function applyHomeResponse(
  state: HomeViewState,
  sent: DesktopIpcRequest['channel'],
  response: DesktopIpcResponse,
): HomeViewState {
  const busy = sent === 'desktop.home_register' ? false : state.busy;
  const reading = sent === 'desktop.home_status' ? false : state.reading;
  if (response.outcome === 'rejected')
    return {
      ...state,
      busy,
      reading,
      message: homeRejectMessage(response.reason),
      registered: false,
    };
  if (!('home' in response)) return { ...state, busy, reading };
  return {
    ...state,
    busy,
    reading,
    home: response.home,
    registered: sent === 'desktop.home_register',
  };
}

export function applyHomeFailure(
  state: HomeViewState,
  sent: DesktopIpcRequest['channel'],
): HomeViewState {
  return {
    ...state,
    busy: sent === 'desktop.home_register' ? false : state.busy,
    reading: sent === 'desktop.home_status' ? false : state.reading,
    message: HOME_IPC_FAILURE_MESSAGE,
  };
}

export interface HomeActions {
  // このマシンのネットワークを読み取り直し、登録の状態を取り直す。
  readonly refresh: () => void;
  // 確認の後に、読み取った内容（ref）を自宅として登録する。
  readonly register: (ref: string) => void;
  // 登録の知らせを閉じる。
  readonly dismiss: () => void;
}

export function homeActions(
  send: (built: DesktopIpcRequest) => void,
  dismiss: () => void,
): HomeActions {
  return {
    refresh: () => send(request('desktop.home_status', null)),
    register: (ref) => send(request('desktop.home_register', { ref })),
    dismiss,
  };
}

// 送る前の状態。次の操作を始めたら前の文言と知らせを消し、登録は結果を待つ間ボタンを止める。
export function markHomeSending(
  state: HomeViewState,
  built: DesktopIpcRequest,
): HomeViewState {
  if (built.channel === 'desktop.home_register')
    return { ...state, busy: true, message: null, registered: false };
  if (built.channel === 'desktop.home_status')
    return { ...state, reading: true, message: null, registered: false };
  return state;
}
