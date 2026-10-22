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
  // 操作の拒否・失敗の文言。null なら出さない。
  readonly message: string | null;
  // 文言を出す場所（押したボタンのすぐ下）。status は欄の見出しの「読み取り直す」、register は登録のボタン。
  readonly messageFrom: 'status' | 'register' | null;
  // 登録が終わった知らせ（一度だけ出す）。
  readonly registered: boolean;
  // main が参照を捨てた（ネットワークが変わった・参照が古い・ロックした）。読み取り直すまで登録のボタンを出さない。
  readonly stale: boolean;
  // 反映した最新の自宅の応答の main の通し番号（list_seq。0 はまだ反映していない）。画面は自分では番号を持たず、
  // これより小さい番号の応答を反映しない（届いた順ではなく main の順で比べる。ADR 0022・0026）。
  readonly seq: number;
  // 結果が分からなかった登録の通し番号。これより大きい番号の読み取りを反映するまで登録のボタンを出さない。
  readonly heldSeq: number | null;
}

export const INITIAL_HOME_STATE: HomeViewState = {
  home: null,
  reading: false,
  busy: false,
  message: null,
  messageFrom: null,
  registered: false,
  stale: false,
  seq: 0,
  heldSeq: null,
};

// 開発の語（main）を出さない（ADR 0024 の UI レビュー 2 回目の追記 8。中枢の画面と同じ文言）。
export const HOME_IPC_FAILURE_MESSAGE =
  '画面と Buddy の本体の間で通信できませんでした。Buddy を終了して、開き直してください。';

const messageFromOf = (
  sent: DesktopIpcRequest['channel'],
): HomeViewState['messageFrom'] =>
  sent === 'desktop.home_register' ? 'register' : 'status';

// 自宅のネットワークで言い方を変える拒否（何が起きたかと、次の行動）。操作（読み取り・登録）ごとに分ける。
// それ以外は共通の文言。
const STATUS_REJECT_MESSAGES: Partial<Record<RejectReason, string>> = {
  core_rejected:
    '中枢から自宅の登録の状態を受け取れませんでした。少し待ってから「読み取り直す」を押してください。',
  not_connected:
    '中枢に接続していないため、自宅のネットワークを確かめられません。接続してから「読み取り直す」を押してください。',
};
const REGISTER_REJECT_MESSAGES: Partial<Record<RejectReason, string>> = {
  entry_not_found:
    '読み取った内容が古くなっています。「読み取り直す」を押してから、もう一度登録してください。',
  outcome_unknown:
    '登録できたか確かめられませんでした。自動では送り直しません。「読み取り直す」で最終更新の時刻を確かめてください。',
  core_rejected:
    '中枢が登録を受け付けませんでした。「読み取り直す」を押してから、もう一度登録してください。',
  not_connected:
    '中枢に接続していないため、登録しませんでした。接続してから「読み取り直す」を押してください。',
  device_locked:
    'ロックされたため、登録しませんでした。ロックを解除してから「読み取り直す」を押してください。',
};

export function homeRejectMessage(
  channel: DesktopIpcRequest['channel'],
  reason: RejectReason,
): string {
  const table =
    channel === 'desktop.home_register'
      ? REGISTER_REJECT_MESSAGES
      : STATUS_REJECT_MESSAGES;
  return table[reason] ?? REJECT_MESSAGES[reason];
}

// main が参照を捨てた拒否（読み取り直すまで登録できない）。
const STALE_REASONS: ReadonlySet<RejectReason> = new Set([
  'home_network_changed',
  'entry_not_found',
  'device_locked',
]);

// main の応答を反映する。読み取り・登録の応答は表示を置き換え、拒否は文言だけを出して表示を変えない。
export function applyHomeResponse(
  state: HomeViewState,
  sent: DesktopIpcRequest['channel'],
  response: DesktopIpcResponse,
): HomeViewState {
  const busy = sent === 'desktop.home_register' ? false : state.busy;
  const reading = sent === 'desktop.home_status' ? false : state.reading;
  // 確認で「やめる」を選んだ・main が古い読み取りとして捨てたときは、何も出さない（表示と参照もそのまま。
  // 承認・失効と同じ扱い。ADR 0026）。
  if (
    response.outcome === 'rejected' &&
    (response.reason === 'confirmation_declined' ||
      response.reason === 'list_superseded')
  )
    return { ...state, busy, reading };
  if (response.outcome === 'rejected') {
    // 結果が分からなかった登録は、main が保留にした時点の番号より大きい番号の読み取りまで登録させない。
    const held =
      sent === 'desktop.home_register' &&
      response.reason === 'outcome_unknown' &&
      response.list_seq !== undefined
        ? Math.max(state.heldSeq ?? 0, response.list_seq)
        : state.heldSeq;
    return {
      ...state,
      busy,
      reading,
      message: homeRejectMessage(sent, response.reason),
      messageFrom: messageFromOf(sent),
      registered: false,
      heldSeq: held,
      stale:
        state.stale ||
        held !== null ||
        (sent === 'desktop.home_register' &&
          STALE_REASONS.has(response.reason)),
    };
  }
  if (!('home' in response)) return { ...state, busy, reading };
  // main の順で古い応答（後から始めた読み取り・登録をもう反映した）は、表示も参照も戻さない。
  if (response.list_seq < state.seq) return { ...state, busy, reading };
  const heldSeq =
    state.heldSeq !== null && response.list_seq > state.heldSeq
      ? null
      : state.heldSeq;
  return {
    ...state,
    busy,
    reading,
    home: response.home,
    seq: response.list_seq,
    heldSeq,
    registered: sent === 'desktop.home_register',
    stale: heldSeq !== null,
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
    messageFrom: messageFromOf(sent),
  };
}

export interface HomeActions {
  // このマシンのネットワークを読み取り直し、登録の状態を取り直す。
  readonly refresh: () => void;
  // 確認の後に、読み取った内容（ref）を自宅として登録する。includeSsid は Wi-Fi 名（SSID）も確かめるか
  // （本人の判断 2026-10-22。画面の既定は確かめる）。
  readonly register: (ref: string, includeSsid: boolean) => void;
  // 登録の知らせを閉じる。
  readonly dismiss: () => void;
}

export function homeActions(
  send: (built: DesktopIpcRequest) => void,
  dismiss: () => void,
): HomeActions {
  return {
    refresh: () => send(request('desktop.home_status', null)),
    register: (ref, includeSsid) =>
      send(
        request('desktop.home_register', { ref, include_ssid: includeSsid }),
      ),
    dismiss,
  };
}

// 送る前の状態。次の操作を始めたら前の文言と知らせを消し、登録は結果を待つ間ボタンを止める。
export function markHomeSending(
  state: HomeViewState,
  built: DesktopIpcRequest,
): HomeViewState {
  if (built.channel === 'desktop.home_register')
    return {
      ...state,
      busy: true,
      message: null,
      messageFrom: null,
      registered: false,
    };
  if (built.channel === 'desktop.home_status')
    return {
      ...state,
      reading: true,
      message: null,
      messageFrom: null,
      registered: false,
    };
  return state;
}
