// 中枢の画面の端末の「申請の承認」「端末の管理」の画面の状態と、操作から送る要求（ADR 0024・0026）。
// React と DOM に依存しない純粋な関数だけを置き、node:test で試験する。受付の規則・参照の解決は main が持つ。
// 画面が持つのは main が作った参照（ref）だけで、申請 ID・端末 ID・コード・秘密・トークンは来ない。
// 操作の結果の文言（notice）は、押した行のすぐ下に出すため、タブと行の参照を持つ（UI レビュー 2 回目 R1-M2）。
import type {
  DesktopClaimEntry,
  DesktopDeviceEntry,
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopPairingSession,
} from '@buddy/contracts';
import { request } from '../desktop-api.js';
import { clockOf } from '../format.js';
import { REJECT_MESSAGES } from '../labels.js';

type Channel = DesktopIpcRequest['channel'];
type Rejected = Extract<DesktopIpcResponse, { outcome: 'rejected' }>;
type RejectReason = Rejected['reason'];

// 承認待ちの申請を取り直す間隔（中枢は新しい申請を知らせないため）。
export const CLAIMS_REFRESH_MS = 3_000;
// ワンタイムコードの有効期間（ADR 0021。コードを出した時刻を期限から求める）。
export const PAIRING_CODE_TTL_MS = 5 * 60_000;

export type HubPane = 'claims' | 'devices';
// 文言を出す場所: 行（参照）・ペアリングの開始のボタンの下・欄の先頭。
export type NoticePlace =
  | { readonly kind: 'row'; readonly ref: string }
  | { readonly kind: 'open' }
  | { readonly kind: 'section' };

export interface HubNotice {
  readonly pane: HubPane;
  readonly place: NoticePlace;
  // warning は失敗・結果不明（role="alert"）、success は適用できたとき（role="status"）。
  readonly tone: 'warning' | 'success';
  readonly text: string;
}

// 送った重い操作（結果の文言に、どの行のどの操作かを入れるため）。
export interface PendingOperation {
  readonly channel: Channel;
  readonly ref: string | null;
  readonly name: string | null;
  readonly verb: string;
}

export interface HubViewState {
  // null はまだ受け取っていない。
  readonly claims: readonly DesktopClaimEntry[] | null;
  readonly devices: readonly DesktopDeviceEntry[] | null;
  // 中枢の画面で始めたペアリングのコードと指紋（始めていなければ null）。
  readonly session: DesktopPairingSession | null;
  // 出したコードで申請が届いた（コードは 1 回だけ使える。ADR 0021）。
  readonly sessionUsed: boolean;
  // コードの表示を画面のロックで消した（次にコードを出すまで、その理由を出す。UI レビュー 3 回目 R1-L7）。
  readonly sessionCleared: 'lock' | null;
  readonly notice: HubNotice | null;
  // 承認・拒否・失効・ペアリングの開始を送って結果を待っている（二重に押させない）。
  readonly pending: PendingOperation | null;
  // 結果が分からなかった行の参照（申請・端末ごと）と、結果が分かったときの通し番号（after）。それより後に始めた
  // 同じ種類の一覧を反映するまで操作させない（別の種類の一覧・結果が分かる前に始めた一覧では解かない）。
  readonly held: {
    readonly claims: readonly HeldRef[];
    readonly devices: readonly HeldRef[];
  };
  // 一覧の要求の順: これより前に始めた一覧の応答は古いので反映しない（変更の操作・新しい一覧で進む）。
  readonly listFloor: { readonly claims: number; readonly devices: number };
}

export interface HeldRef {
  readonly ref: string;
  readonly after: number;
}

export const INITIAL_HUB_STATE: HubViewState = {
  claims: null,
  devices: null,
  session: null,
  sessionUsed: false,
  sessionCleared: null,
  notice: null,
  pending: null,
  held: { claims: [], devices: [] },
  listFloor: { claims: 0, devices: 0 },
};

export const HUB_IPC_FAILURE_MESSAGE =
  '画面と Buddy の本体の間で通信できませんでした。Buddy を終了して、開き直してください。';

const HEAVY: ReadonlySet<Channel> = new Set([
  'desktop.claim_decide',
  'desktop.device_revoke',
  'desktop.pairing_open',
]);

const paneOf = (channel: Channel): HubPane =>
  channel === 'desktop.devices_list' || channel === 'desktop.device_revoke'
    ? 'devices'
    : 'claims';

// 操作ごとの拒否の文言（何が送れなかったかと、次に何をするか）。状態帯の「接続中」と矛盾しないよう、
// 送れなかった・届いたか分からない、と操作の結果として書く。
export function operationFailureText(
  operation: PendingOperation,
  reason: RejectReason,
): string {
  const target =
    operation.name === null
      ? operation.verb
      : `「${operation.name}」の${operation.verb}`;
  switch (reason) {
    case 'not_connected':
      return `中枢に${target}を送れませんでした。中枢との接続が戻ってから、もう一度押してください。自動では送り直しません。`;
    case 'outcome_unknown':
      // ペアリングの開始は一覧に出ないので、コードを出し直してもらう（前のコードは使えなくなっているかもしれない。
      // PR #79 のコードレビュー Low-5）。
      if (operation.channel === 'desktop.pairing_open')
        return `中枢に${target}が届いたか確かめられませんでした。自動では送り直しません。前のコードは使えなくなっている可能性があります。もう一度コードを出してください。`;
      return `中枢に${target}が届いたか確かめられませんでした。自動では送り直しません。「一覧を更新」を押して、結果を確かめてください。`;
    case 'entry_not_found':
      return `一覧が古いため、${target}ができませんでした。「一覧を更新」を押してから、もう一度操作してください。`;
    case 'core_rejected':
      return `中枢が${target}を受け付けませんでした（期限切れ・決め済みなど）。「一覧を更新」を押して確かめてください。`;
    default:
      return `この操作（${target}）ができませんでした。${REJECT_MESSAGES[reason]}`;
  }
}

// 操作が適用できたときの知らせ（R1-M1。押した行は一覧から消えるので、欄の先頭に出す）。
export function operationSuccessText(
  operation: PendingOperation,
  now: number,
): string | null {
  const name = operation.name === null ? null : `「${operation.name}」`;
  if (name === null) return null;
  switch (operation.verb) {
    case '承認':
      return `中枢で${name}を承認しました（${clockOf(new Date(now).toISOString(), now)}）。「登録済みの端末」に出ています。`;
    case '拒否':
      return `中枢で${name}の申請を拒否しました。`;
    case '失効':
      return `中枢で${name}を失効しました。`;
    default:
      return null;
  }
}

const placeOf = (operation: PendingOperation): NoticePlace =>
  operation.channel === 'desktop.pairing_open'
    ? { kind: 'open' }
    : operation.ref === null
      ? { kind: 'section' }
      : { kind: 'row', ref: operation.ref };

// 出したコードで申請が届いたか（コードを出した時刻より後の申請があるか）。中枢の画面の端末は中枢と同じマシンなので、
// 時計は同じ。
function usedBy(
  session: DesktopPairingSession,
  claims: readonly DesktopClaimEntry[],
): boolean {
  const opened = Date.parse(session.expires_at) - PAIRING_CODE_TTL_MS;
  return claims.some((claim) => Date.parse(claim.claimed_at) >= opened);
}

// main の応答を反映する。一覧の応答は置き換え、拒否は文言だけを出して一覧を変えない。seq は要求を始めたときの
// 通し番号、doneSeq は応答が届いたときの通し番号（変更の操作の結果が分かった時点。これより前に始めた一覧は古い）。
export function applyHubResponse(
  state: HubViewState,
  sent: Channel,
  response: DesktopIpcResponse,
  now: number = Date.now(),
  seq?: number,
  doneSeq?: number,
): HubViewState {
  const heavy = HEAVY.has(sent);
  const operation = heavy ? state.pending : null;
  const pending = heavy ? null : state.pending;
  // 後から始めた一覧・変更の操作に追い越された一覧の応答は、表示を戻さないよう捨てる。
  if (
    !heavy &&
    seq !== undefined &&
    sent !== 'desktop.pairing_open' &&
    seq < state.listFloor[paneOf(sent)]
  )
    return state;
  if (response.outcome === 'rejected') {
    // 確認で「やめる」を選んだ・main が古い一覧として捨てたときは、何も出さない。
    if (
      response.reason === 'confirmation_declined' ||
      response.reason === 'list_superseded'
    )
      return { ...state, pending };
    if (operation !== null)
      return {
        ...state,
        pending,
        held:
          response.reason === 'outcome_unknown' &&
          operation.ref !== null &&
          sent !== 'desktop.pairing_open'
            ? {
                ...state.held,
                [paneOf(sent)]: [
                  ...state.held[paneOf(sent)],
                  { ref: operation.ref, after: doneSeq ?? 0 },
                ],
              }
            : state.held,
        notice: {
          pane: paneOf(sent),
          place: placeOf(operation),
          tone: 'warning',
          text: operationFailureText(operation, response.reason),
        },
      };
    // 一覧の取り直しの失敗は欄の先頭に出す（同じ文言を繰り返し出さないよう、既にあれば置き換えない）。
    return {
      ...state,
      pending,
      notice:
        state.notice !== null && state.notice.pane === paneOf(sent)
          ? state.notice
          : {
              pane: paneOf(sent),
              place: { kind: 'section' },
              tone: 'warning',
              text: `一覧を更新できませんでした。${REJECT_MESSAGES[response.reason]}`,
            },
    };
  }
  // 操作が適用できたら、成功の知らせを欄の先頭に出す。一覧の取り直し（定期）は、欄の先頭の一覧の失敗だけを消す。
  const success =
    operation === null ? null : operationSuccessText(operation, now);
  const notice = heavy
    ? success === null
      ? null
      : {
          pane: paneOf(sent),
          place: { kind: 'section' } as const,
          tone: 'success' as const,
          text: success,
        }
    : state.notice !== null &&
        state.notice.pane === paneOf(sent) &&
        state.notice.place.kind === 'section' &&
        state.notice.tone === 'warning' &&
        state.notice.text.startsWith('一覧を更新できませんでした')
      ? null
      : state.notice;
  if ('session' in response)
    return {
      ...state,
      pending,
      notice,
      session: response.session,
      sessionUsed: false,
      sessionCleared: null,
    };
  if ('list_refreshed' in response) {
    // 適用はできたが、一覧の取り直しだけが失敗した（CR-L2）。前の一覧からその行を除く。
    const ref = operation?.ref ?? null;
    const name = operation?.name ?? null;
    const verb = operation?.verb ?? '操作';
    return {
      ...state,
      pending,
      // POST の最中に始めた一覧も古い（取り直しが失敗しても、この境目を保つ）。
      listFloor: advanceFloor(state.listFloor, paneOf(sent), doneSeq),
      claims:
        sent === 'desktop.claim_decide' && state.claims !== null
          ? state.claims.filter((claim) => claim.ref !== ref)
          : state.claims,
      devices:
        sent === 'desktop.device_revoke' && state.devices !== null
          ? state.devices.map((device) =>
              device.ref !== null && device.ref === ref
                ? {
                    ...device,
                    ref: null,
                    revoked_at: new Date(now).toISOString(),
                  }
                : device,
            )
          : state.devices,
      notice: {
        pane: paneOf(sent),
        place: { kind: 'section' },
        tone: 'success',
        text: `中枢で${name === null ? '' : `「${name}」を`}${verb}しました。一覧を更新できなかったため、「一覧を更新」を押して確かめてください。`,
      },
    };
  }
  // 変更の操作の後の一覧（main が POST の後に取り直した）は、応答が届いた時点を境目にする。
  const at = heavy ? (doneSeq ?? seq) : seq;
  const listed = (pane: HubPane) => ({
    // 結果が分かった後に始めた同じ種類の一覧だけが、その保留を解く。
    held:
      at === undefined
        ? state.held
        : {
            ...state.held,
            [pane]: state.held[pane].filter((held) => held.after >= at),
          },
    listFloor: advanceFloor(state.listFloor, pane, at),
  });
  if ('claims' in response)
    return {
      ...state,
      ...listed('claims'),
      pending,
      notice,
      claims: response.claims,
      sessionUsed:
        state.sessionUsed ||
        (state.session !== null && usedBy(state.session, response.claims)),
    };
  if ('devices' in response)
    return {
      ...state,
      ...listed('devices'),
      pending,
      notice,
      devices: response.devices,
    };
  return { ...state, pending, notice };
}

// ロック・接続の切り替えをまたいだ応答は内容を捨て、重い操作の待ちだけを外す。
export function dropStaleResponse(
  state: HubViewState,
  sent: Channel,
): HubViewState {
  return HEAVY.has(sent) ? { ...state, pending: null } : state;
}

export function applyHubFailure(
  state: HubViewState,
  sent: Channel,
): HubViewState {
  const operation = HEAVY.has(sent) ? state.pending : null;
  return {
    ...state,
    pending: HEAVY.has(sent) ? null : state.pending,
    notice: {
      pane: paneOf(sent),
      place: operation === null ? { kind: 'section' } : placeOf(operation),
      tone: 'warning',
      text: HUB_IPC_FAILURE_MESSAGE,
    },
  };
}

// 画面のロックでコードの表示を消す（ロック中は内容を隠すため。次に開いたときは理由を出し、コードを出し直してもらう）。
export function forgetSession(state: HubViewState): HubViewState {
  if (state.session === null) return state;
  return {
    ...state,
    session: null,
    sessionUsed: false,
    sessionCleared: 'lock',
  };
}

// タブを切り替えたとき・「一覧を更新」を押したときは、文言を消す。
export function clearNotice(state: HubViewState, pane?: HubPane): HubViewState {
  if (state.notice === null) return state;
  if (pane !== undefined && state.notice.pane !== pane) return state;
  return { ...state, notice: null };
}

export interface HubActions {
  // 「一覧を更新」（押したら、その欄の文言を消す）。
  readonly refresh: (pane: HubPane) => void;
  // 定期の取り直し（文言は消さない）。
  readonly pollClaims: () => void;
  readonly decide: (
    claim: Pick<DesktopClaimEntry, 'ref' | 'device_name'>,
    decision: 'approve' | 'reject',
  ) => void;
  readonly revoke: (device: {
    readonly ref: string;
    readonly name: string;
  }) => void;
  readonly openPairing: () => void;
  readonly clearNotice: () => void;
}

export interface HubSend {
  readonly request: (
    built: DesktopIpcRequest,
    operation?: PendingOperation,
  ) => void;
  readonly update: (change: (state: HubViewState) => HubViewState) => void;
}

export function hubActions(send: HubSend): HubActions {
  return {
    refresh: (pane) => {
      send.update((state) => clearNotice(state, pane));
      send.request(
        request(
          pane === 'claims' ? 'desktop.claims_list' : 'desktop.devices_list',
          null,
        ),
      );
    },
    pollClaims: () => send.request(request('desktop.claims_list', null)),
    decide: (claim, decision) => {
      const built = request('desktop.claim_decide', {
        ref: claim.ref,
        decision,
      });
      send.request(built, {
        channel: built.channel,
        ref: claim.ref,
        name: claim.device_name,
        verb: decision === 'approve' ? '承認' : '拒否',
      });
    },
    revoke: (device) => {
      const built = request('desktop.device_revoke', { ref: device.ref });
      send.request(built, {
        channel: built.channel,
        ref: device.ref,
        name: device.name,
        verb: '失効',
      });
    },
    openPairing: () => {
      const built = request('desktop.pairing_open', null);
      send.request(built, {
        channel: built.channel,
        ref: null,
        name: null,
        verb: 'ペアリングの開始',
      });
    },
    clearNotice: () => send.update((state) => clearNotice(state)),
  };
}

// 一覧の境目を進める（戻さない）。
function advanceFloor(
  floor: HubViewState['listFloor'],
  pane: HubPane,
  seq: number | undefined,
): HubViewState['listFloor'] {
  if (seq === undefined || seq <= floor[pane]) return floor;
  return { ...floor, [pane]: seq };
}

// 送る前の状態（重い操作は結果を待つ間ボタンを止め、その行の前の文言を消す）。
export function markSending(
  state: HubViewState,
  built: DesktopIpcRequest,
  operation?: PendingOperation,
  seq?: number,
): HubViewState {
  if (!HEAVY.has(built.channel)) return state;
  // 変更の操作より前に始めた一覧は古い（決めた申請・失効した端末を戻さない）。
  const pane = paneOf(built.channel);
  return {
    ...state,
    listFloor:
      seq === undefined || built.channel === 'desktop.pairing_open'
        ? state.listFloor
        : { ...state.listFloor, [pane]: seq },
    pending: operation ?? {
      channel: built.channel,
      ref: null,
      name: null,
      verb: '操作',
    },
    notice: null,
  };
}
