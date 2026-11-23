// 連携の接続（取得範囲の選択）の画面の状態と、操作から送る要求（B08-02 P3・B09-05、ADR 0142。設計 01 接続・端末、
// 設計 04 接続・権限／取得する対象、ADR 0072・0086）。React と DOM に依存しない純粋な関数と状態の持ち主を置き、
// node:test で試験する。受付の規則・参照の解決・期待する許可版は main が持つ。画面に来るのは main の参照（ref）と
// 表示用の値（提供元・状態・権限・取得範囲・Microsoft のアカウントの状態）だけで、接続 ID・版は来ない。
// - 未取得・取得の失敗を「接続なし」にしない（設計 01）。
// - 画面から足せる対象はない。編集できるのは、今保存されている対象のうちの選択と、期間・添付の範囲だけ
//   （新しい対象の追加は接続時、B03-04）。範囲の検査は domain の validateFetchScope（上限は設計の初期値）。
// 理由のコード・API の名前は画面に出さない。
import type {
  ConnectionTargets,
  DesktopConnectionEntry,
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopProviderConnectionsView,
} from '@buddy/contracts';
import { sameFetchScope, validateFetchScope } from '@buddy/domain';
import type { FetchScope } from '@buddy/domain';
import { request } from '../desktop-api.js';
import { REJECT_MESSAGES } from '../labels.js';

type Rejected = Extract<DesktopIpcResponse, { outcome: 'rejected' }>;
type RejectReason = Rejected['reason'];

export const CONNECTION_IPC_FAILURE_MESSAGE =
  '画面と Buddy の本体の間で通信できませんでした。Buddy を終了して、開き直してください。';

// --- 文言 ---

export const CONNECTION_LABELS = {
  section: '連携アカウント',
  refresh: '読み直す',
  reading: '読み込んでいます…',
  empty: '連携しているアカウントはまだありません。',
  scopes: '許可されている権限',
  noScopes: '許可されている権限はありません。',
  targets: '取得する対象と範囲',
  calendars: 'カレンダー',
  attachmentKinds: '添付ファイルの種類',
  save: '保存する',
  busy: '保存しています…',
  saved: '保存しました。',
  unknown: '結果を確認できませんでした',
  addNote:
    '選べる対象は接続時に決まります。ここでは、今選んでいる対象を外すことと、期間・添付の範囲の変更ができます。',
  rangeProblem:
    '期間と大きさは上限の範囲で選んでください（メールは 1〜90 日、カレンダーは過去 0〜30 日・先 0〜90 日、添付は 1〜10,000,000 バイト）。',
  account: 'アカウント',
  rejection: '使える範囲の制限',
  mailLookback: 'メールを遡る日数（上限 90\u00a0日）',
  calendarPast: 'カレンダーを遡る日数（上限 30\u00a0日）',
  calendarFuture: 'カレンダーの先の日数（上限 90\u00a0日）',
  attachmentMax: '添付 1\u00a0件の大きさの上限（バイト）',
  days: '日',
} as const;

export const CONNECTION_FETCH_LABELS: Readonly<
  Record<DesktopProviderConnectionsView['fetch'], string>
> = {
  loaded: '取得できています',
  stale: '最新の取得に失敗しました。前回の内容を表示しています',
  unavailable: 'まだ取得できていません',
};

export const PROVIDER_LABELS: Readonly<
  Record<DesktopConnectionEntry['provider'], string>
> = {
  google: 'Google',
  microsoft: 'Outlook（Microsoft）',
};

export const CONNECTION_STATUS_LABELS: Readonly<
  Record<DesktopConnectionEntry['status'], string>
> = {
  active: '連携中',
  needs_reauth: '再認可が必要です',
  needs_attention: '確認が必要です',
  disconnected: '接続を解除済み',
};

export const ACCESS_LABELS: Readonly<
  Record<DesktopConnectionEntry['access'], string>
> = {
  read: '参照だけ',
  read_write: '参照と変更',
};

// フォルダー／ラベルの呼び方は提供元で分ける（設計 04: Gmail のラベル、Outlook のフォルダー）。
export const CONTAINER_LABELS: Readonly<
  Record<DesktopConnectionEntry['provider'], string>
> = {
  google: 'ラベル',
  microsoft: 'フォルダー',
};

export const ATTACHMENT_KIND_LABELS: Readonly<Record<'pdf' | 'text', string>> =
  {
    pdf: 'PDF',
    text: 'テキスト（txt・md・csv）',
  };

export const GRAPH_ACCOUNT_KIND_LABELS: Readonly<
  Record<'personal' | 'work_or_school', string>
> = {
  personal: '個人アカウント',
  work_or_school: '職場・学校アカウント',
};

export const GRAPH_DELEGATION_LABELS: Readonly<
  Record<'delegated_user', string>
> = {
  delegated_user: '本人の委任された権限で連携しています',
};

// 拒否の理由と使える範囲（設計 04 接続・権限、ADR 0072）。理由のコードは出さない。
export const GRAPH_REJECTION_LABELS: Readonly<
  Record<
    | 'insufficient_permission'
    | 'organization_policy'
    | 'admin_consent_required'
    | 'tenant_restriction'
    | 'unknown',
    string
  >
> = {
  insufficient_permission: '権限が足りないため、再認可が必要です',
  organization_policy: '組織の方針で制限されています',
  admin_consent_required: '組織の管理者の同意が必要です',
  tenant_restriction: 'テナントの制限で使えません',
  unknown: '理由は分かりませんが、制限されています',
};

export const GRAPH_CATEGORY_LABELS: Readonly<Record<'display_only', string>> = {
  display_only: 'カテゴリは案の表示だけです（自動では付けません）',
};

// --- 取得範囲の下書き ---

// 画面の入力の下書き。数値は入力の途中で空・不正になり得るので文字列で持つ。
export interface TargetsDraft {
  readonly calendarIds: readonly string[];
  readonly mailContainerIds: readonly string[];
  readonly attachmentKinds: readonly ('pdf' | 'text')[];
  readonly mailLookbackDays: string;
  readonly calendarPastDays: string;
  readonly calendarFutureDays: string;
  readonly attachmentMaxBytes: string;
}

export function draftFromTargets(targets: ConnectionTargets): TargetsDraft {
  return {
    calendarIds: [...targets.calendar_ids],
    mailContainerIds: [...targets.mail_container_ids],
    attachmentKinds: [...targets.attachment_kinds],
    mailLookbackDays: String(targets.mail_lookback_days),
    calendarPastDays: String(targets.calendar_past_days),
    calendarFutureDays: String(targets.calendar_future_days),
    attachmentMaxBytes: String(targets.attachment_max_bytes),
  };
}

const toFetchScope = (targets: ConnectionTargets): FetchScope => ({
  calendarIds: targets.calendar_ids,
  mailContainerIds: targets.mail_container_ids,
  attachmentKinds: targets.attachment_kinds,
  mailLookbackDays: targets.mail_lookback_days,
  calendarPastDays: targets.calendar_past_days,
  calendarFutureDays: targets.calendar_future_days,
  attachmentMaxBytes: targets.attachment_max_bytes,
});

// 下書きを送る形にする。数値が読めない・範囲外なら null（保存させない）。
export function draftToTargets(draft: TargetsDraft): ConnectionTargets | null {
  const numbers = [
    draft.mailLookbackDays,
    draft.calendarPastDays,
    draft.calendarFutureDays,
    draft.attachmentMaxBytes,
  ].map((value) => (/^[0-9]+$/.test(value.trim()) ? Number(value) : NaN));
  if (numbers.some((value) => !Number.isSafeInteger(value))) return null;
  const targets: ConnectionTargets = {
    calendar_ids: [...draft.calendarIds],
    mail_container_ids: [...draft.mailContainerIds],
    attachment_kinds: [...draft.attachmentKinds],
    mail_lookback_days: numbers[0] as number,
    calendar_past_days: numbers[1] as number,
    calendar_future_days: numbers[2] as number,
    attachment_max_bytes: numbers[3] as number,
  };
  return validateFetchScope(toFetchScope(targets)).length === 0
    ? targets
    : null;
}

// 下書きが保存値と違うか（並び順は比べない）。送る形にできない下書きは「違う」扱い（問題の文言を出すため）。
export function draftChanged(
  saved: ConnectionTargets,
  draft: TargetsDraft,
): boolean {
  const targets = draftToTargets(draft);
  if (targets === null) return true;
  return !sameFetchScope(toFetchScope(saved), toFetchScope(targets));
}

// --- 状態 ---

export interface ConnectionNotice {
  readonly tone: 'warning' | 'success';
  readonly text: string;
  // 出す場所。null は欄の頭（読み直し）、それ以外は行の参照。
  readonly ref: string | null;
}

export interface ConnectionsViewState {
  // null はまだ受け取っていない。
  readonly view: DesktopProviderConnectionsView | null;
  // 反映した一覧の main の通し番号（0 はまだ反映していない）。これより小さい番号の一覧は反映しない。
  readonly seq: number;
  readonly reading: boolean;
  // 取得範囲の変更を送って結果を待っている行の参照（二重に押させない）。
  readonly busy: string | null;
  readonly notice: ConnectionNotice | null;
}

export const INITIAL_CONNECTIONS_STATE: ConnectionsViewState = {
  view: null,
  seq: 0,
  reading: false,
  busy: null,
  notice: null,
};

export function connectionFailureText(reason: RejectReason): string {
  switch (reason) {
    case 'preview_stale':
      return '保存する前に、ほかの場所で変更されていました。一覧を読み直したので、確かめてからもう一度保存してください。';
    case 'outcome_unknown':
      return '結果を確かめられませんでした。自動では送り直しません。一覧が更新されるまで、お待ちください。';
    case 'core_rejected':
      return '中枢が受け付けませんでした。一覧を読み直してから、もう一度保存してください。';
    case 'invalid_request':
      return '選んだ内容では保存できません。今の保存値にない対象は、ここからは足せません（対象の追加は接続時に行います）。';
    case 'not_connected':
      return '中枢に接続していないため、連携を読めません。接続してから「読み直す」を押してください。';
    default:
      return REJECT_MESSAGES[reason];
  }
}

// 一覧の応答を反映する（main の順で古い一覧は反映しない）。
function withView(
  state: ConnectionsViewState,
  view: DesktopProviderConnectionsView,
): ConnectionsViewState {
  if (view.list_seq < state.seq) return state;
  const refs = new Set(view.entries.map((entry) => entry.ref));
  return {
    ...state,
    view,
    seq: view.list_seq,
    notice:
      state.notice !== null &&
      state.notice.ref !== null &&
      !refs.has(state.notice.ref) &&
      state.notice.tone === 'warning'
        ? null
        : state.notice,
  };
}

export function applyConnectionsListResponse(
  state: ConnectionsViewState,
  response: DesktopIpcResponse,
): ConnectionsViewState {
  const reading = { ...state, reading: false };
  if (response.outcome === 'rejected')
    return {
      ...reading,
      notice: {
        tone: 'warning',
        text: connectionFailureText(response.reason),
        ref: null,
      },
    };
  if (!('connections' in response)) return reading;
  return withView(reading, response.connections);
}

export function applyTargetsUpdateResponse(
  state: ConnectionsViewState,
  ref: string,
  response: DesktopIpcResponse,
): ConnectionsViewState {
  const idle = { ...state, busy: state.busy === ref ? null : state.busy };
  if (response.outcome === 'rejected')
    return {
      ...idle,
      notice: {
        tone: 'warning',
        text: connectionFailureText(response.reason),
        ref,
      },
    };
  if (!('connections' in response)) return idle;
  const next = withView(idle, response.connections);
  return {
    ...next,
    notice: { tone: 'success', text: CONNECTION_LABELS.saved, ref },
  };
}

export function applyConnectionsFailure(
  state: ConnectionsViewState,
  ref: string | null,
): ConnectionsViewState {
  return {
    ...state,
    reading: ref === null ? false : state.reading,
    busy: ref !== null && state.busy === ref ? null : state.busy,
    notice: { tone: 'warning', text: CONNECTION_IPC_FAILURE_MESSAGE, ref },
  };
}

// --- 操作 ---

export interface ConnectionActions {
  readonly refresh: () => void;
  readonly update: (ref: string, targets: ConnectionTargets) => void;
}

export interface ConnectionsApi {
  invoke(request: DesktopIpcRequest): Promise<DesktopIpcResponse>;
}

// 表示の権限の世代を持ち、世代をまたいだ応答（ロック・切断の前に送った要求の遅い応答）は反映しない。
export class ConnectionsStore {
  readonly #api: ConnectionsApi;
  readonly #listeners = new Set<() => void>();
  #state: ConnectionsViewState = INITIAL_CONNECTIONS_STATE;
  #epoch = 0;
  readonly actions: ConnectionActions;

  constructor(api: ConnectionsApi) {
    this.#api = api;
    this.actions = {
      refresh: () => this.#list(),
      update: (ref, targets) => this.#update(ref, targets),
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly snapshot = (): ConnectionsViewState => this.#state;

  #set(next: ConnectionsViewState): void {
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #send(
    built: DesktopIpcRequest,
    onResponse: (
      state: ConnectionsViewState,
      response: DesktopIpcResponse,
    ) => ConnectionsViewState,
    onFailure: (state: ConnectionsViewState) => ConnectionsViewState,
  ): Promise<void> {
    const epoch = this.#epoch;
    const apply = (
      change: (prev: ConnectionsViewState) => ConnectionsViewState,
    ) => {
      if (epoch !== this.#epoch) return;
      this.#set(change(this.#state));
    };
    return this.#api.invoke(built).then(
      (response) => apply((prev) => onResponse(prev, response)),
      () => apply(onFailure),
    );
  }

  #list(): void {
    this.#set({ ...this.#state, reading: true, notice: null });
    void this.#send(
      request('desktop.connections_list', null),
      applyConnectionsListResponse,
      (state) => applyConnectionsFailure(state, null),
    );
  }

  #update(ref: string, targets: ConnectionTargets): void {
    if (this.#state.busy !== null) return;
    const epoch = this.#epoch;
    let stale = false;
    this.#set({ ...this.#state, busy: ref, notice: null });
    void this.#send(
      request('desktop.connection_targets_update', { ref, targets }),
      (state, response) => {
        stale =
          response.outcome === 'rejected' &&
          (response.reason === 'preview_stale' ||
            response.reason === 'entry_not_found');
        return applyTargetsUpdateResponse(state, ref, response);
      },
      (state) => applyConnectionsFailure(state, ref),
    ).then(() => {
      // 版が変わっていた・参照が古かった（main が読み直した）ときは、読み直した一覧を受け取る（409 では読み直す）。
      if (stale && epoch === this.#epoch) this.#reread();
    });
  }

  // 文言を残したまま一覧だけを読み直す。
  #reread(): void {
    void this.#send(
      request('desktop.connections_list', null),
      (state, response) =>
        response.outcome === 'ok' && 'connections' in response
          ? withView(state, response.connections)
          : state,
      (state) => state,
    );
  }

  // 出せなくなった（ロック・切断）: 世代を進めて内容を捨てる。
  hide(): void {
    this.#epoch += 1;
    this.#set(INITIAL_CONNECTIONS_STATE);
  }
}
