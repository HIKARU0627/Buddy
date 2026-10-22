// デスクトップの UI レンダラーと main の間の限定 IPC の受付と、端末の入出力・ロックの状態の規則
// （設計 10 §1・§1A、07 §2・§5、01 いつも見える状態、02 停止、ADR 0014）。
// 形式（JSON Schema の DesktopIpcRequest）は main が先に検査し、不正なら invalid_request にする。
// 中枢の停止・来客モード・全体停止はこの規則の対象外（B03 以降に Core が扱う）。

export const DESKTOP_IPC_CHANNELS = [
  'desktop.get_state',
  'desktop.io_stop',
  'desktop.io_resume',
  'desktop.window_hide',
  'desktop.client_quit',
  // B03-05: 中枢との接続・ペアリング（ADR 0025）。
  'desktop.get_connection',
  'desktop.pairing_begin',
  'desktop.pairing_confirm',
  'desktop.pairing_submit',
  'desktop.pairing_cancel',
  // B03-06: 中枢の画面の端末の申請の承認・端末の管理（ADR 0026）。
  'desktop.claims_list',
  'desktop.claim_decide',
  'desktop.devices_list',
  'desktop.device_revoke',
  'desktop.pairing_open',
  // B03-08: 中枢の画面の端末の自宅のネットワークの登録（ADR 0022）。
  'desktop.home_status',
  'desktop.home_register',
  // B04-05: 発言・承認表示の準備・承認・取消・照合（ADR 0031）。
  'desktop.turn_submit',
  'desktop.operation_preview',
  'desktop.operation_approve',
  'desktop.operation_cancel',
  'desktop.operation_reconcile',
  'desktop.operation_retry',
  'desktop.operation_check',
] as const;

export type DesktopIpcChannel = (typeof DESKTOP_IPC_CHANNELS)[number];

export const DESKTOP_NOTIFICATION_CHANNELS = [
  'desktop.state_changed',
  'desktop.power_event',
  'desktop.connection_changed',
] as const;

export const DESKTOP_POWER_EVENTS = [
  'lock_screen',
  'unlock_screen',
  'suspend',
  'resume',
  'shutdown',
] as const;

export type DesktopPowerEvent = (typeof DESKTOP_POWER_EVENTS)[number];

export const DESKTOP_IPC_REJECT_REASONS = [
  'invalid_request',
  'untrusted_sender',
  'device_locked',
  'screen_operation_required',
  'not_stopped',
  'core_required',
  'io_epoch_mismatch',
  // ペアリングの手順と合わない要求（指紋の確認の前の申請など。ADR 0025）。
  'pairing_step_mismatch',
  // 保護の弱い方式しか使えずトークンを保存できない（ADR 0025）。
  'secure_storage_unavailable',
  // B03-06: 中枢の画面でない・接続していない・一覧にない参照・中枢が拒否した・結果が分からない（ADR 0026）。
  'hub_screen_required',
  'not_connected',
  'entry_not_found',
  'core_rejected',
  'outcome_unknown',
  // 入力した指紋の最後の 4 桁が、受け取った証明書の指紋と合わない（本人の判断 2026-10-21、ADR 0025）。
  'fingerprint_tail_mismatch',
  // ペアリングの宛先が Tailscale のアドレス・ループバック・*.ts.net の名前でない（ADR 0025、hub-host.ts）。
  'pairing_host_not_allowed',
  // 承認・拒否・失効の OS の確認で「やめる」を選んだ・別の確認を表示している（本人の判断 2026-10-22、ADR 0026）。
  'confirmation_declined',
  'confirmation_pending',
  // 一覧の要求が、後から始めた一覧・変更の操作に追い越された（古い一覧で表示と参照を戻さない）。
  'list_superseded',
  // 自宅の登録の確認を出した後に、このマシンのネットワークの指紋が変わった・読み取れなくなった（B03-08）。
  'home_network_changed',
  // 承認の確認に出した内容・状態が、確認の後に変わった（承認しない。内容を確かめ直す。B04-05、ADR 0031）。
  'preview_stale',
  // 入出力が止まっている間は、発言と承認を受け付けない（B04-05、ADR 0031）。
  'input_stopped',
  // 取消・再試行の確認に出す操作の内容（見出し）を、今の内容版で確かめられない（確認へ進ませない。B04-05、ADR 0031）。
  'content_unavailable',
] as const;

export type DesktopIpcRejectReason =
  (typeof DESKTOP_IPC_REJECT_REASONS)[number];

export interface DesktopIoState {
  // ロック状態が取得できなければ unknown（07 §2）。
  readonly lockState: 'unlocked' | 'locked' | 'unknown';
  readonly stopScope: 'none' | 'local' | 'guest' | 'global';
  readonly ioEpoch: string;
}

export interface DesktopIpcSender {
  // 送信元が main の作った UI レンダラーの主フレームである（main が webContents から判定する）。
  readonly trustedSender: boolean;
  // ウィンドウが表示中かつ前面にある。再開を画面操作として扱う条件。
  readonly windowFocused: boolean;
}

export type DesktopAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DesktopIpcRejectReason };

const reject = (reason: DesktopIpcRejectReason): DesktopAdmission => ({
  ok: false,
  reason,
});

const isChannel = (channel: string): channel is DesktopIpcChannel =>
  (DESKTOP_IPC_CHANNELS as readonly string[]).includes(channel);

// 本人の画面操作として受け付けるペアリングの手順（ADR 0025）。指紋の確認・コードの入力は本人の操作なので、
// ロック解除済みで、ウィンドウが表示中かつ前面のときだけ受け付ける。やめる（pairing_cancel）はいつでも。
export const DESKTOP_PAIRING_SCREEN_CHANNELS: readonly DesktopIpcChannel[] = [
  'desktop.pairing_begin',
  'desktop.pairing_confirm',
  'desktop.pairing_submit',
  // 申請の承認・拒否と端末の失効も本人の画面操作（B03-06）。
  'desktop.claim_decide',
  'desktop.device_revoke',
  'desktop.pairing_open',
  // 自宅の登録（登録し直しを含む）も本人の画面操作（B03-08）。
  'desktop.home_register',
  // 発言・承認表示の準備・承認・取消・照合も本人の画面操作（B04-05）。
  'desktop.turn_submit',
  'desktop.operation_preview',
  'desktop.operation_approve',
  'desktop.operation_cancel',
  'desktop.operation_reconcile',
  'desktop.operation_retry',
  'desktop.operation_check',
];

// ロック解除済みのときだけ受け付ける一覧（内容なので、ロック中・不明は出さない。B03-06）。
export const DESKTOP_UNLOCKED_CHANNELS: readonly DesktopIpcChannel[] = [
  'desktop.claims_list',
  'desktop.devices_list',
  // 自宅の登録の状態とこのマシンのネットワークの伏せた表示（B03-08）。
  'desktop.home_status',
];

// 要求を受け付けてよいか。最初に満たさない検査の拒否を返す。
// 状態欄・接続の状態の取得・入出力停止・ウィンドウを閉じる・クライアント終了・ペアリングをやめるは、
// ロック中・不明・停止中でも受け付ける。ペアリングの手順は ロック解除済み → 画面操作 の順に検査する
// （手順の順序は main が検査する）。
// 再開は ロック解除済み → 画面操作 → この端末の停止 → 期待する io_epoch の一致 の順に検査する。
export function admitDesktopRequest(
  channel: string,
  expectedIoEpoch: string | null,
  state: DesktopIoState,
  sender: DesktopIpcSender,
): DesktopAdmission {
  if (!isChannel(channel)) return reject('invalid_request');
  if (!sender.trustedSender) return reject('untrusted_sender');
  if (DESKTOP_UNLOCKED_CHANNELS.includes(channel))
    return state.lockState === 'unlocked'
      ? { ok: true }
      : reject('device_locked');
  if (DESKTOP_PAIRING_SCREEN_CHANNELS.includes(channel)) {
    if (state.lockState !== 'unlocked') return reject('device_locked');
    if (!sender.windowFocused) return reject('screen_operation_required');
    return { ok: true };
  }
  if (channel !== 'desktop.io_resume') return { ok: true };
  if (state.lockState !== 'unlocked') return reject('device_locked');
  if (!sender.windowFocused) return reject('screen_operation_required');
  if (state.stopScope === 'none') return reject('not_stopped');
  // 来客モード・全体停止の解除は中枢の操作（B03 以降）。デスクトップだけでは解除しない。
  if (state.stopScope !== 'local') return reject('core_required');
  if (expectedIoEpoch === null || expectedIoEpoch !== state.ioEpoch)
    return reject('io_epoch_mismatch');
  return { ok: true };
}

// 窓の役割（ADR 0032）。キャンバス（画面ぴったりの 1 枚。AI が宣言的に置く物を描く）・状態の層（端のつまみ・
// スライドのパネル。状態・停止・確認の一覧）・入力バー（画面の下）。窓ごとに使えるチャネルを分け、
// main は送信元の窓の役割でも受付を絞る（UI-02 で接続する。今の窓の受付 admitDesktopRequest は変えない）。
export const DESKTOP_WINDOW_ROLES = ['canvas', 'status', 'input'] as const;

export type DesktopWindowRole = (typeof DESKTOP_WINDOW_ROLES)[number];

// 役割ごとに使える要求のチャネル。キャンバスは承認・停止・再開・取消・登録・失効・終了のチャネルを使えない
// （AI の部品が状態や停止を隠す・承認の画面に見せかけることを、構造で防ぐ）。入力バーは状態の取得と発言
// （B04-05 の desktop.turn_submit）だけ。承認表示の準備・承認・取消・照合・再試行・状態の確認は状態の層だけ。
export const DESKTOP_ROLE_CHANNELS: Readonly<
  Record<DesktopWindowRole, readonly DesktopIpcChannel[]>
> = {
  canvas: ['desktop.get_state'],
  status: [
    'desktop.get_state',
    'desktop.io_stop',
    'desktop.io_resume',
    'desktop.window_hide',
    'desktop.client_quit',
    'desktop.get_connection',
    'desktop.pairing_begin',
    'desktop.pairing_confirm',
    'desktop.pairing_submit',
    'desktop.pairing_cancel',
    'desktop.claims_list',
    'desktop.claim_decide',
    'desktop.devices_list',
    'desktop.device_revoke',
    'desktop.pairing_open',
    'desktop.home_status',
    'desktop.home_register',
    'desktop.operation_preview',
    'desktop.operation_approve',
    'desktop.operation_cancel',
    'desktop.operation_reconcile',
    'desktop.operation_retry',
    'desktop.operation_check',
  ],
  input: ['desktop.get_state', 'desktop.turn_submit'],
};

// 役割ごとに main から送る通知。電源・ロックの記録と接続の状態は状態の層だけ。
export const DESKTOP_ROLE_NOTIFICATIONS: Readonly<
  Record<
    DesktopWindowRole,
    readonly (typeof DESKTOP_NOTIFICATION_CHANNELS)[number][]
  >
> = {
  canvas: ['desktop.state_changed'],
  status: [
    'desktop.state_changed',
    'desktop.power_event',
    'desktop.connection_changed',
  ],
  input: ['desktop.state_changed'],
};

// 送信元の窓の役割がそのチャネルを使えるか。未知のチャネルは使えない。
export function desktopChannelAllowedForRole(
  role: DesktopWindowRole,
  channel: string,
): boolean {
  return (DESKTOP_ROLE_CHANNELS[role] as readonly string[]).includes(channel);
}

export function desktopInputPermitted(state: DesktopIoState): boolean {
  return state.lockState === 'unlocked' && state.stopScope === 'none';
}

// ロック中・ロック状態不明では状態欄の内容を隠す（01 いつも見える状態）。
export function statusBarVisibility(
  lockState: DesktopIoState['lockState'],
): 'shown' | 'hidden' {
  return lockState === 'unlocked' ? 'shown' : 'hidden';
}

export type DesktopIoEvent =
  | { readonly kind: 'io_stop' }
  | { readonly kind: 'io_resume' }
  | { readonly kind: 'power'; readonly event: DesktopPowerEvent };

// 停止していなければこの端末の停止にして io_epoch を進める。既に停止中なら範囲も世代も変えない
// （来客モード・全体停止を local で上書きしない）。
function stopLocally(state: DesktopIoState): DesktopIoState {
  if (state.stopScope !== 'none') return state;
  return {
    ...state,
    stopScope: 'local',
    ioEpoch: (BigInt(state.ioEpoch) + 1n).toString(),
  };
}

// 端末の入出力・ロックの状態の遷移。io_resume は admitDesktopRequest で受け付けた後だけ適用する。
// ロック解除・スリープからの復帰では自動で再開しない（01、10 §1）。
export function nextDesktopIoState(
  state: DesktopIoState,
  event: DesktopIoEvent,
): DesktopIoState {
  if (event.kind === 'io_stop') return stopLocally(state);
  if (event.kind === 'io_resume')
    return state.stopScope === 'local'
      ? { ...state, stopScope: 'none' }
      : state;
  switch (event.event) {
    case 'lock_screen':
      return { ...stopLocally(state), lockState: 'locked' };
    case 'unlock_screen':
      return { ...state, lockState: 'unlocked' };
    case 'suspend':
      // 復帰後のロック状態を確かめるまで解除済みと扱わない（07 §2・§5）。
      return {
        ...stopLocally(state),
        lockState: state.lockState === 'unlocked' ? 'unknown' : state.lockState,
      };
    case 'resume':
      return state;
    case 'shutdown':
      return stopLocally(state);
  }
}

// 本人が中枢の画面の指紋から入力した最後の 4 桁が、端末が受け取った証明書の指紋（DER 全体の SHA-256 の
// 小文字の 16 進 64 桁）の最後の 4 桁と同じか（本人の判断 2026-10-21、ADR 0025）。大文字・小文字と空白は区別しない。
// 指紋の形が正しくないとき・4 桁の 16 進でないときは一致としない。
export function fingerprintTailMatches(
  fingerprint: string,
  typedTail: string,
): boolean {
  if (!/^[0-9a-f]{64}$/u.test(fingerprint)) return false;
  const tail = typedTail.replace(/\s/gu, '').toLowerCase();
  return /^[0-9a-f]{4}$/u.test(tail) && fingerprint.endsWith(tail);
}
