// 音声レンダラーの限定 IPC・Live の制御接続・リースの更新・input_kind の受付・外部への送信の同意の純粋な規則
// （B05-01、ADR 0038。設計 10 §1・§1A・§2・§2A・§3・§6A、07 §2・§5）。
// 端末・中枢・OS には依存しない。判定の入力はすべて呼び出し側が渡す。実装は B05-02 以降。

import type { SessionControlAction } from './conversation.js';
import {
  AUDIO_ACTION_REASONS,
  audioControlScopeMatches,
  type AudioAction,
  type AudioReason,
  type InputKind,
} from './audio.js';

// ---- 音声レンダラーへの限定 IPC（main → 音声レンダラー） ----------------------------------------------

export const VOICE_IPC_CHANNELS = [
  'voice.start',
  'voice.stop_playback',
  'voice.close_voice_session',
  'voice.suspend_io',
  'voice.play',
  'voice.set_silence_timeout',
] as const;
export type VoiceIpcChannel = (typeof VOICE_IPC_CHANNELS)[number];

// 音声レンダラーが再生してよいのは効果音だけ（質問 99。定型句は使わない）。
export const VOICE_CLIP_IDS = [
  'wake_detected',
  'listening_started',
  'still_connecting',
  'refused',
  'text_reply_wake',
  'notification_wake',
] as const;
export type VoiceClipId = (typeof VOICE_CLIP_IDS)[number];

// 無音の猶予の範囲（ms）。原本の値は 10 秒・質問の後は 20 秒・「ちょっと待って」で 60 秒（10 §3）。
export const SILENCE_TIMEOUT_MS_RANGE = { min: 1000, max: 60000 } as const;

const CHANNEL_ACTION: Readonly<Partial<Record<VoiceIpcChannel, AudioAction>>> =
  {
    'voice.stop_playback': 'stop_playback',
    'voice.close_voice_session': 'close_voice_session',
    'voice.suspend_io': 'suspend_io',
  };

// ACK が来なかったときに main がすること。
// - force_kill_renderer: 音声レンダラーを強制終了し、WebRTC を消す（10 §1 第 2 層。X30）。
// - escalate_suspend_io: 安全側に全停止し、入力の中断を画面で知らせる（10 §1。再生停止の ACK 喪失）。
// - close_session: 接続を閉じて③へ切り替える（10 §2、X54）。
// - ignore: 何もしない（効果音の欠落・無音の猶予の値の欠落。判定は main が持つ）。
export type VoiceIpcTimeoutAction =
  'force_kill_renderer' | 'escalate_suspend_io' | 'close_session' | 'ignore';

export interface VoiceIpcTimeoutRule {
  // 要求に付ける ACK の待ち時間の上限（ms）。要求の ack_timeout_ms はこれ以下。
  readonly maxAckTimeoutMs: number;
  readonly onTimeout: VoiceIpcTimeoutAction;
  // design は原本の値、provisional は原本に決めがなく、T04 の実測まで置く仮の値（合格値ではない）。
  readonly basis: 'design' | 'provisional';
}

export const VOICE_IPC_TIMEOUTS: Readonly<
  Record<VoiceIpcChannel, VoiceIpcTimeoutRule>
> = {
  'voice.start': {
    maxAckTimeoutMs: 3000,
    onTimeout: 'close_session',
    basis: 'provisional',
  },
  'voice.stop_playback': {
    maxAckTimeoutMs: 300,
    onTimeout: 'escalate_suspend_io',
    basis: 'provisional',
  },
  'voice.close_voice_session': {
    maxAckTimeoutMs: 1500,
    onTimeout: 'force_kill_renderer',
    basis: 'provisional',
  },
  'voice.suspend_io': {
    maxAckTimeoutMs: 300,
    onTimeout: 'force_kill_renderer',
    basis: 'design',
  },
  'voice.play': {
    maxAckTimeoutMs: 500,
    onTimeout: 'ignore',
    basis: 'provisional',
  },
  'voice.set_silence_timeout': {
    maxAckTimeoutMs: 500,
    onTimeout: 'ignore',
    basis: 'provisional',
  },
};

export interface VoiceEpochs {
  readonly io_epoch?: string;
  readonly audio_epoch?: string | null;
  readonly output_epoch?: string;
  readonly session_epoch?: string;
}

export interface VoiceRendererRequestLike {
  readonly channel: string;
  readonly request_id: string;
  readonly ack_timeout_ms: number;
  readonly payload: VoiceEpochs & {
    readonly reason?: string;
    readonly scope?: 'local' | 'guest' | 'global' | null;
    readonly clip_id?: string;
    readonly timeout_ms?: number;
  };
}

// 形は Schema が検査する。ここは意味（チャネルと理由・範囲の組、ACK の待ち時間、値の範囲）を検査する。
export function voiceRequestErrors(
  request: VoiceRendererRequestLike,
): string[] {
  const errors: string[] = [];
  const channel = request.channel as VoiceIpcChannel;
  const rule = VOICE_IPC_TIMEOUTS[channel] as VoiceIpcTimeoutRule | undefined;
  if (!rule) return ['unknown_channel'];
  if (request.ack_timeout_ms > rule.maxAckTimeoutMs)
    errors.push('ack_timeout_exceeds_limit');
  const action = CHANNEL_ACTION[channel];
  if (action) {
    const reason = request.payload.reason as AudioReason | undefined;
    const reasons: readonly string[] = AUDIO_ACTION_REASONS[action];
    if (reason === undefined || !reasons.includes(reason))
      errors.push('reason_not_for_action');
    else if (!audioControlScopeMatches(reason, request.payload.scope ?? null))
      errors.push('scope_mismatch');
  }
  if (channel === 'voice.close_voice_session' && !request.payload.audio_epoch)
    errors.push('audio_epoch_required');
  if (channel === 'voice.start' && !request.payload.audio_epoch)
    errors.push('audio_epoch_required');
  if (channel === 'voice.set_silence_timeout') {
    const ms = request.payload.timeout_ms;
    if (
      ms === undefined ||
      ms < SILENCE_TIMEOUT_MS_RANGE.min ||
      ms > SILENCE_TIMEOUT_MS_RANGE.max
    )
      errors.push('silence_timeout_out_of_range');
  }
  return errors;
}

const EPOCH_KEYS = [
  'io_epoch',
  'audio_epoch',
  'output_epoch',
  'session_epoch',
] as const;

// 音声レンダラーが命令の世代を自分の世代と照合する。main が世代を進めてから命令を出すので、
// 自分の世代より新しい値は受け入れ、古い値は無視する（現在の世代にだけ作用する。10 §1A）。
export function rendererEpochDecision(
  command: VoiceEpochs,
  renderer: VoiceEpochs,
): 'apply' | 'ignore_stale' {
  for (const key of EPOCH_KEYS) {
    const given = command[key];
    const now = renderer[key];
    if (given == null || now == null) continue;
    if (BigInt(given) < BigInt(now)) return 'ignore_stale';
  }
  return 'apply';
}

export interface VoiceRendererAckLike extends VoiceEpochs {
  readonly request_id: string;
  readonly channel: string;
  readonly outcome:
    'applied' | 'ignored_stale_epoch' | 'rejected_invalid' | 'failed';
}

// ACK が要求に対応し、世代が戻っていないことを検査する。
// - applied: 要求の世代をそのまま返す（音声レンダラーは世代を進めない。世代を進めるのは main）。
// - ignored_stale_epoch: 音声レンダラーの現在の世代を返す。要求より新しい世代の項目が 1 つ以上ある。
// どの ACK も、遅着した古い世代のものを現在の命令の完了や再開として扱わない（X30）。
export function voiceAckErrors(
  request: VoiceRendererRequestLike,
  ack: VoiceRendererAckLike,
): string[] {
  const errors: string[] = [];
  if (ack.request_id !== request.request_id)
    errors.push('ack_request_mismatch');
  if (ack.channel !== request.channel) errors.push('ack_channel_mismatch');
  let regressed = false;
  let differs = false;
  let newer = false;
  for (const key of EPOCH_KEYS) {
    const given = request.payload[key];
    const acked = ack[key];
    if (given == null) continue;
    if (acked == null) {
      differs = true;
      continue;
    }
    if (BigInt(acked) < BigInt(given)) regressed = true;
    else if (BigInt(acked) > BigInt(given)) newer = true;
  }
  if (regressed) errors.push('epoch_regressed');
  if (ack.outcome === 'applied' && !regressed && (differs || newer))
    errors.push('epoch_mismatch');
  if (ack.outcome === 'ignored_stale_epoch' && !regressed && !newer)
    errors.push('stale_ack_without_newer_epoch');
  return errors;
}

// main が今持っている世代（io・output は main が進めた値、audio・session は中枢が発行した値）。
export interface VoiceCurrentState extends VoiceEpochs {
  readonly io_suspended: boolean;
}

// 要求の世代が今の世代と一致するか。送った後に世代が進んだ（停止・再接続・端末交代）要求は古い、
// 今の世代より新しい要求は main が出していないので不明として、どちらも使わない。
export function voiceRequestFreshness(
  request: VoiceRendererRequestLike,
  current: VoiceEpochs,
): string[] {
  const errors: string[] = [];
  for (const key of EPOCH_KEYS) {
    const given = request.payload[key];
    if (given == null) continue;
    const now = current[key];
    if (now == null) errors.push('no_current_epoch');
    else if (BigInt(given) < BigInt(now)) errors.push('request_epoch_stale');
    else if (BigInt(given) > BigInt(now)) errors.push('request_epoch_unknown');
  }
  return [...new Set(errors)];
}

// 音を出す・始める命令。端末の入出力が止まっている間は待たせない（停止の命令だけが待ちに残る）。
const AUDIBLE_CHANNELS: readonly string[] = [
  'voice.start',
  'voice.play',
  'voice.set_silence_timeout',
];

// 停止・失効・世代の更新の後に、まだ待ってよい（ACK を待つ）要求だけを残す。世代が今の世代と一致しない要求と、
// 入出力の停止中の start・play・set_silence_timeout は捨てる（10 §1・§1A）。捨てた要求の ACK は
// 後から届いても使わない（acceptVoiceAck は pending にない要求の ACK を拒否する）。
export function retainPendingVoiceRequests(
  pending: readonly VoiceRendererRequestLike[],
  current: VoiceCurrentState,
): VoiceRendererRequestLike[] {
  return pending.filter(
    (request) =>
      voiceRequestFreshness(request, current).length === 0 &&
      !(current.io_suspended && AUDIBLE_CHANNELS.includes(request.channel)),
  );
}

export interface VoiceAckDecision {
  readonly accepted: boolean;
  readonly errors: string[];
}

// 遅れて届いた ACK を使ってよいかの最終判定。待っている要求（pending）に対応し、ACK の世代が戻っておらず、
// 要求の世代が今の世代と一致し、入出力が止まっている間は音を出す命令の ACK を使わない。受け付けた ACK だけが
// 命令の完了になる。これで、停止の後に届いた古い applied の ACK は、再開や完了として扱われない（X30、QA43）。
// 中枢側で遅着の結果・音声・ACK を受けるときは acceptDelivery（audio.ts）を使い、この関数は main の側で使う。
export function acceptVoiceAck(
  pending: readonly VoiceRendererRequestLike[],
  ack: VoiceRendererAckLike,
  current: VoiceCurrentState,
): VoiceAckDecision {
  const request = pending.find((entry) => entry.request_id === ack.request_id);
  if (!request) return { accepted: false, errors: ['no_pending_request'] };
  const errors = [
    ...voiceAckErrors(request, ack),
    ...voiceRequestFreshness(request, current),
  ];
  if (current.io_suspended && AUDIBLE_CHANNELS.includes(request.channel))
    errors.push('io_suspended');
  return { accepted: errors.length === 0, errors: [...new Set(errors)] };
}

// ---- stop_playback の後の再開（10 §1A、ADR 0038） --------------------------------------------------------------

export type PlaybackResume = 'new_live_connection' | 'same_connection';

// 既定は新しい Live 接続（確定済みの文脈を渡す）。同じ接続のまま再生に戻るのは、実機で検証して設定を有効にし、
// かつその場で旧ストリームの音声を排除できたと確認できたときだけ。どちらかが欠ければ出力 mute を保持し、
// 訂正の入力と画面での応答を続ける。再開は本人の音声再開の操作で、旧世代の音声を新しい世代へ付け替えない。
export function resolvePlaybackResume(
  sameConnectionPlaybackResume: boolean,
  oldStreamExcluded: boolean,
): PlaybackResume {
  return sameConnectionPlaybackResume && oldStreamExcluded
    ? 'same_connection'
    : 'new_live_connection';
}

// ---- Live の制御接続（サイドバンド。10 §2A） -----------------------------------------------------------

export type LiveControlStateName =
  'connecting' | 'ready' | 'lost' | 'closing' | 'closed';
export type LiveClosure =
  'open' | 'close_requested' | 'close_confirmed' | 'close_unconfirmed';
export type LiveReservationState = 'reserved' | 'held' | 'settled';

export interface LiveControl {
  readonly live_session_id: string;
  readonly control_state: LiveControlStateName;
  readonly control_epoch: string;
  readonly closure: LiveClosure;
  readonly usage_seconds: number | null;
  readonly reservation_state: LiveReservationState;
}

export const LIVE_CONTROL_TRIGGERS = [
  'sideband_connected',
  'sideband_connect_failed',
  'sideband_disconnected',
  'ping_timeout',
  'core_restarted',
  'close_requested',
  'session_closed_received',
  'close_unconfirmed',
  'usage_reconciled',
] as const;
export type LiveControlTrigger = (typeof LIVE_CONTROL_TRIGGERS)[number];

export type LiveControlResult =
  | { readonly ok: true; readonly next: LiveControl }
  | { readonly ok: false; readonly reason: string };

const bump = (epoch: string): string => (BigInt(epoch) + 1n).toString();

// 制御接続の遷移。lost・closing・closed から ready へは戻らない（同じ Live セッションへ再接続して会話を
// 継続しない。10 §2A）。lost へ入るときは control_epoch を進める。終了や使用量が確認できなければ
// 予約を held のまま保持し、確認できたときだけ settled にする。
export function nextLiveControl(
  state: LiveControl,
  trigger: LiveControlTrigger,
  usageSeconds: number | null = null,
): LiveControlResult {
  const no = (reason: string): LiveControlResult => ({ ok: false, reason });
  const to = (patch: Partial<LiveControl>): LiveControlResult => ({
    ok: true,
    next: { ...state, ...patch },
  });
  const { control_state: s, closure } = state;
  switch (trigger) {
    case 'sideband_connected':
      return s === 'connecting'
        ? to({ control_state: 'ready' })
        : no('invalid_transition');
    case 'sideband_connect_failed':
      return s === 'connecting'
        ? to({
            control_state: 'lost',
            control_epoch: bump(state.control_epoch),
          })
        : no('invalid_transition');
    case 'sideband_disconnected':
    case 'ping_timeout':
      return s === 'ready'
        ? to({
            control_state: 'lost',
            control_epoch: bump(state.control_epoch),
          })
        : no('invalid_transition');
    case 'core_restarted':
      return s === 'connecting' || s === 'ready'
        ? to({
            control_state: 'lost',
            control_epoch: bump(state.control_epoch),
          })
        : no('invalid_transition');
    case 'close_requested':
      return s === 'connecting' || s === 'ready' || s === 'lost'
        ? to({ control_state: 'closing', closure: 'close_requested' })
        : no('invalid_transition');
    case 'session_closed_received':
      // こちらが閉じる要求を出した後（closing）のほか、provider が先に閉じた場合（connecting・ready・lost のまま
      // 使用秒数つきで届く）と、終了を待つ時間が切れて close_unconfirmed になった後に届いた場合も、そのまま受け付ける
      // （usage_reconciled と同じ結果）。確認済みになった後の重複は受け付けない。
      if (!(
        (s === 'closing' && closure === 'close_requested') ||
        ((s === 'connecting' || s === 'ready' || s === 'lost') &&
          closure === 'open') ||
        (s === 'closed' && closure === 'close_unconfirmed')
      ))
        return no('invalid_transition');
      if (
        usageSeconds === null ||
        !Number.isInteger(usageSeconds) ||
        usageSeconds < 0
      )
        return no('usage_required');
      return to({
        control_state: 'closed',
        closure: 'close_confirmed',
        usage_seconds: usageSeconds,
        reservation_state: 'settled',
      });
    case 'close_unconfirmed':
      return s === 'closing' && closure === 'close_requested'
        ? to({
            control_state: 'closed',
            closure: 'close_unconfirmed',
            usage_seconds: null,
            reservation_state: 'held',
          })
        : no('invalid_transition');
    case 'usage_reconciled':
      if (s !== 'closed' || closure !== 'close_unconfirmed')
        return no('invalid_transition');
      if (
        usageSeconds === null ||
        !Number.isInteger(usageSeconds) ||
        usageSeconds < 0
      )
        return no('usage_required');
      return to({
        closure: 'close_confirmed',
        usage_seconds: usageSeconds,
        reservation_state: 'settled',
      });
  }
}

// ready の間だけ新規の委譲・結果の読み上げ・送出前の音声依頼の変更を受け付ける（10 §2A）。
export function controlAllowsVoiceWork(state: LiveControl): boolean {
  return state.control_state === 'ready';
}

// 音声リースを更新してよい制御接続の状態。lost 以降は端末とのハートビートが正常でも更新しない（10 §2A）。
export function controlAllowsAudioLease(state: LiveControl): boolean {
  return (
    state.control_state === 'connecting' || state.control_state === 'ready'
  );
}

// ---- リースの更新（07 §5、10 §2A） ----------------------------------------------------------------------

export interface StoredLease {
  readonly lease_id: string;
  readonly kind: 'audio' | 'display';
  readonly device_id: string;
  // このリースで中枢が受け付けた nonce を古い順に全て持つ（最後が直前の nonce）。リースの寿命の間だけ RAM に持つ。
  readonly used_nonces: readonly string[];
  readonly last_requested_at_mono_ms: number;
}

export interface LeaseRenewalRequestLike {
  readonly lease_id: string;
  readonly kind: 'audio' | 'display';
  readonly device_id: string;
  readonly core_instance_id: string;
  readonly command_scope_id: string;
  readonly io_epoch: string;
  readonly nonce: string;
  readonly previous_nonce: string | null;
  readonly requested_at_mono_ms: number;
  readonly heartbeat_ms: number;
  readonly ttl_ms: number;
}

export interface LeaseRenewalContext {
  readonly core_instance_id: string;
  readonly command_scope_id: string;
  readonly io_epoch: string;
  readonly io_suspended: boolean;
  readonly device_revoked: boolean;
  // 音声リースのときの制御接続。none は Live を開く前（接続の前の初回の発行）。
  readonly control: LiveControlStateName | 'none';
}

// 中枢が更新要求を受け付けてよいかの理由（空なら受け付ける）。端末が送った単調時計の値は、
// 同じリースの中での増加だけを見る（端末の時刻は中枢の時刻と比べない）。
export function leaseRenewalReasons(
  stored: StoredLease | null,
  request: LeaseRenewalRequestLike,
  context: LeaseRenewalContext,
): string[] {
  const reasons: string[] = [];
  if (request.heartbeat_ms >= request.ttl_ms)
    reasons.push('heartbeat_not_shorter_than_ttl');
  if (request.core_instance_id !== context.core_instance_id)
    reasons.push('core_restarted');
  if (request.command_scope_id !== context.command_scope_id)
    reasons.push('scope_changed');
  if (BigInt(request.io_epoch) < BigInt(context.io_epoch))
    reasons.push('stale_io_epoch');
  else if (BigInt(request.io_epoch) > BigInt(context.io_epoch))
    reasons.push('unknown_io_epoch');
  if (context.device_revoked) reasons.push('device_revoked');
  if (context.io_suspended) reasons.push('io_suspended');
  if (
    request.kind === 'audio' &&
    context.control !== 'none' &&
    context.control !== 'connecting' &&
    context.control !== 'ready'
  )
    reasons.push('sideband_lost');
  if (stored === null) {
    if (request.previous_nonce !== null)
      reasons.push('unexpected_previous_nonce');
  } else {
    if (stored.device_id !== request.device_id) reasons.push('device_mismatch');
    if (stored.kind !== request.kind) reasons.push('lease_kind_mismatch');
    // 使い済みの nonce は、直前でなくても拒否する（A → B → A で、最初の A の遅着の応答を最後の A に当てさせない）。
    if (
      stored.used_nonces.includes(request.nonce) ||
      request.nonce === request.previous_nonce
    )
      reasons.push('nonce_reused');
    if (request.previous_nonce !== (stored.used_nonces.at(-1) ?? null))
      reasons.push('nonce_replayed');
    if (request.requested_at_mono_ms <= stored.last_requested_at_mono_ms)
      reasons.push('mono_clock_regressed');
  }
  return [...new Set(reasons)];
}

// 端末が送って応答を待っている更新要求（1 つのリースにつき最新の 1 件だけ）。
export interface PendingLeaseRequest {
  readonly request_id: string;
  readonly lease_id: string;
  readonly nonce: string;
  readonly core_instance_id: string;
  readonly command_scope_id: string;
  readonly io_epoch: string;
  readonly requested_at_mono_ms: number;
  readonly heartbeat_ms: number;
}

export interface LeaseRenewalResponseLike {
  readonly request_id: string;
  readonly lease_id: string;
  readonly nonce: string;
  readonly result: 'renewed' | 'rejected';
  readonly ttl_ms: number | null;
}

// 応答を受けた時点で端末が持つ今の状態。
export interface LeaseCurrentState {
  readonly core_instance_id: string;
  readonly command_scope_id: string;
  readonly io_epoch: string;
  readonly io_suspended: boolean;
}

// 端末が応答を受けたときの判定。期限は要求を送った時点の単調時計から数え、応答の受信時刻から足し直さない。
// 応答が遅れて、数え直した期限がすでに過ぎていれば（expired_before_applied）リースを延ばさない。
// - 待っている要求（pending）がなければ（停止・失効・拒否・適用済みで捨てた後）使わない（no_pending_request）。
// - 要求 ID・リース ID・nonce が待っている要求と全て一致するときだけ見る。古い要求の成功の応答や、
//   同じ nonce を使い回した別の要求の応答は使わない。
// - 要求を送った後に、中枢の起動 ID・接続範囲・入出力の世代が変わった、または端末の入出力が止まったなら使わない。
export function applyLeaseResponse(
  pending: PendingLeaseRequest | null,
  response: LeaseRenewalResponseLike,
  nowMonoMs: number,
  clockConsistent: boolean,
  current: LeaseCurrentState,
): { readonly expires_at_mono_ms: number | null; readonly reasons: string[] } {
  const none = (...reasons: string[]) => ({
    expires_at_mono_ms: null,
    reasons,
  });
  if (pending === null) return none('no_pending_request');
  if (response.request_id !== pending.request_id)
    return none('request_id_mismatch');
  if (response.lease_id !== pending.lease_id) return none('lease_id_mismatch');
  if (response.nonce !== pending.nonce) return none('nonce_mismatch');
  const stale: string[] = [];
  if (pending.core_instance_id !== current.core_instance_id)
    stale.push('core_restarted');
  if (pending.command_scope_id !== current.command_scope_id)
    stale.push('scope_changed');
  if (BigInt(pending.io_epoch) < BigInt(current.io_epoch))
    stale.push('stale_io_epoch');
  else if (BigInt(pending.io_epoch) > BigInt(current.io_epoch))
    stale.push('unknown_io_epoch');
  if (current.io_suspended) stale.push('io_suspended');
  if (stale.length > 0) return none(...stale);
  if (response.result !== 'renewed' || response.ttl_ms === null)
    return none('renewal_rejected');
  const reasons: string[] = [];
  if (!clockConsistent) reasons.push('clock_inconsistent');
  if (response.ttl_ms <= pending.heartbeat_ms)
    reasons.push('heartbeat_not_shorter_than_ttl');
  const expires = pending.requested_at_mono_ms + response.ttl_ms;
  if (clockConsistent && nowMonoMs >= expires)
    reasons.push('expired_before_applied');
  return reasons.length === 0
    ? { expires_at_mono_ms: expires, reasons }
    : none(...reasons);
}

// ---- input_kind の受付（10 §4・§5A・§6・§6A、07 §2） ---------------------------------------------------

export const INPUT_CONDITIONS = [
  'device_authenticated',
  'home_network',
  'command_scope_current',
  'device_unlocked',
  'io_permitted',
  'local_asr_on_device',
  'live_control_ready',
  'audio_epoch_current',
  'session_epoch_current',
  'audio_lease_valid',
  'voice_output_mode',
  'not_private_conversation',
  'external_send_consent',
  'budget_reserved',
] as const;
export type InputCondition = (typeof INPUT_CONDITIONS)[number];

export type InputRoute = 'http_turn' | 'sideband_transcript';

export interface InputKindRule {
  readonly input_kind: InputKind;
  readonly route: InputRoute;
  // client は端末が送る入力、core は中枢が外部の接続から受け取る入力（端末は名乗れない）。
  readonly origin: 'client' | 'core';
  readonly output_mode: 'voice' | 'text';
  readonly requires: readonly InputCondition[];
}

const HTTP_BASE = [
  'device_authenticated',
  'home_network',
  'command_scope_current',
  'device_unlocked',
] as const;

// text は POST /v1/sessions/{id}/turns と /v1/stream/turns。voice_local は端末内で文字にした声で、同じ経路。
// voice_live は Live の文字起こしで、中枢がサイドバンドで受け取る。端末の HTTP 経路では受け付けない（X49）。
export const INPUT_KIND_RULES: readonly InputKindRule[] = [
  {
    input_kind: 'text',
    route: 'http_turn',
    origin: 'client',
    output_mode: 'text',
    requires: [...HTTP_BASE],
  },
  {
    input_kind: 'voice_local',
    route: 'http_turn',
    origin: 'client',
    output_mode: 'text',
    requires: [...HTTP_BASE, 'io_permitted', 'local_asr_on_device'],
  },
  {
    input_kind: 'voice_live',
    route: 'sideband_transcript',
    origin: 'core',
    output_mode: 'voice',
    requires: [
      'live_control_ready',
      'audio_epoch_current',
      'session_epoch_current',
      'audio_lease_valid',
      'io_permitted',
      'not_private_conversation',
      'voice_output_mode',
      'external_send_consent',
      'budget_reserved',
    ],
  },
];

export type InputAdmission =
  | { readonly decision: 'accept' }
  | {
      readonly decision: 'reject';
      readonly reason: 'route_not_allowed' | 'condition_not_met';
      readonly missing: readonly InputCondition[];
    };

// 入力の種類と経路が表に合い、必要な条件がすべて満たされているときだけ受け付ける。
// 満たされていない条件は表の順にすべて返す（呼び出し側が渡さなかった条件は満たされていないものとして扱う）。
export function admitInputKind(
  inputKind: string,
  route: string,
  conditions: Readonly<Partial<Record<InputCondition, boolean>>>,
): InputAdmission {
  const rule = INPUT_KIND_RULES.find(
    (entry) => entry.input_kind === inputKind && entry.route === route,
  );
  if (!rule)
    return { decision: 'reject', reason: 'route_not_allowed', missing: [] };
  const missing = rule.requires.filter((name) => conditions[name] !== true);
  return missing.length === 0
    ? { decision: 'accept' }
    : { decision: 'reject', reason: 'condition_not_met', missing };
}

// ---- 外部への送信の同意（#15 本人の判断、ADR 0038） --------------------------------------------------------

export type ConsentStatus =
  'granted' | 'missing' | 'revoked' | 'policy_outdated' | 'other_device';

export interface ExternalSendConsentLike {
  readonly device_id: string;
  readonly kind: string;
  readonly provider: string;
  readonly policy_version: string;
  readonly state: 'granted' | 'revoked';
  readonly granted_at: string;
  readonly revoked_at: string | null;
}

// 端末ごとに種類・送り先・同意の文面の版が現在のものと一致する同意だけが有効。
export function consentStatus(
  record: ExternalSendConsentLike | null,
  expected: {
    readonly device_id: string;
    readonly kind: string;
    readonly provider: string;
    readonly policy_version: string;
  },
): ConsentStatus {
  if (record === null) return 'missing';
  if (record.device_id !== expected.device_id) return 'other_device';
  if (record.kind !== expected.kind || record.provider !== expected.provider)
    return 'missing';
  if (record.state === 'revoked') return 'revoked';
  if (record.policy_version !== expected.policy_version)
    return 'policy_outdated';
  return 'granted';
}

export interface ConsentChangeLike {
  readonly action: 'grant' | 'revoke';
  readonly confirmation: {
    readonly method: string;
    readonly confirmed_at: string;
  } | null;
}

// 同意は main の OS の確認ダイアログの結果だけ（Renderer・LLM は作れない）。取り消しは確認なしでいつでもできる。
export function consentChangeErrors(change: ConsentChangeLike): string[] {
  const errors: string[] = [];
  if (change.action === 'grant' && change.confirmation === null)
    errors.push('grant_without_os_confirmation');
  return errors;
}

export function consentRecordErrors(record: ExternalSendConsentLike): string[] {
  const errors: string[] = [];
  if ((record.state === 'revoked') !== (record.revoked_at !== null))
    errors.push('revoked_at_mismatch');
  if (
    record.revoked_at !== null &&
    Date.parse(record.revoked_at) < Date.parse(record.granted_at)
  )
    errors.push('revoked_before_granted');
  return errors;
}

// ---- Live の接続の受付（POST /v1/live/sessions の後段。07 §2、10 §2・§6A） -------------------------------------

export interface LiveStartContext {
  readonly purpose: 'conversation' | 'notification';
  readonly audioOwner: 'self' | 'other' | 'none';
  readonly ioSuspended: boolean;
  readonly audioLeaseValid: boolean;
  readonly outputMode: 'voice' | 'text';
  readonly privateConversation: boolean;
  readonly consent: ConsentStatus;
  readonly budgetReservable: boolean;
}

export type LiveStartAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly code: string };

// 経路の検査（admitRequest）の後に呼ぶ。外部へ音声を送るので、同意がなければ他の条件が揃っても開かない。
// 順序は、端末の状態（所有・停止・リース）→ 記録しない会話 → 返し方 → 同意 → 予算。
export function admitLiveStart(context: LiveStartContext): LiveStartAdmission {
  const no = (status: number, code: string): LiveStartAdmission => ({
    ok: false,
    status,
    code,
  });
  if (context.audioOwner === 'other') return no(409, 'audio_owned_elsewhere');
  if (context.audioOwner === 'none') return no(403, 'audio_ownership_required');
  if (context.ioSuspended) return no(403, 'io_suspended');
  if (!context.audioLeaseValid) return no(403, 'audio_lease_invalid');
  if (context.privateConversation) return no(409, 'private_conversation');
  if (context.purpose === 'conversation' && context.outputMode !== 'voice')
    return no(409, 'output_mode_text');
  if (context.consent !== 'granted')
    return no(403, 'external_send_consent_required');
  if (!context.budgetReservable) return no(422, 'budget_held');
  return { ok: true };
}

// ---- 会話の操作（SessionControlPhrases）の効果（10 §3・§5・§1A、X58、QA43） --------------------------------------

export interface SessionControlEffect {
  // 声が開いているとき（①）に中枢が行う停止の命令。なければ null。
  readonly audio_action: AudioAction | null;
  readonly audio_reason: AudioReason | null;
  // 無音の猶予を 1 回だけ延ばす（ms）。
  readonly extends_silence_ms: number | null;
  // 以後の返し方を文字にする（②③と同じ画面の操作）。
  readonly sets_output_mode_text: boolean;
  readonly starts_private_conversation: boolean;
  readonly ends_session: boolean;
}

// どの言い回しも別々の効果を持ち、同じ終了処理に束ねない（X58）。「処理を取り消す」（cancel_workflow）は
// 照合表にない別の命令で、音声も会話も閉じない（10 §1A）。
export const SESSION_CONTROL_EFFECTS: Readonly<
  Record<SessionControlAction, SessionControlEffect>
> = {
  extend_silence: {
    audio_action: null,
    audio_reason: null,
    extends_silence_ms: 60000,
    sets_output_mode_text: false,
    starts_private_conversation: false,
    ends_session: false,
  },
  stop_playback: {
    audio_action: 'stop_playback',
    audio_reason: 'user_stop',
    extends_silence_ms: null,
    sets_output_mode_text: false,
    starts_private_conversation: false,
    ends_session: false,
  },
  end_conversation: {
    audio_action: 'close_voice_session',
    audio_reason: 'conversation_ended',
    extends_silence_ms: null,
    sets_output_mode_text: false,
    starts_private_conversation: false,
    ends_session: true,
  },
  start_private_conversation: {
    audio_action: 'close_voice_session',
    audio_reason: 'private_conversation',
    extends_silence_ms: null,
    sets_output_mode_text: false,
    starts_private_conversation: true,
    ends_session: false,
  },
  reply_in_text: {
    audio_action: 'close_voice_session',
    audio_reason: 'output_mode_text',
    extends_silence_ms: null,
    sets_output_mode_text: true,
    starts_private_conversation: false,
    ends_session: false,
  },
};
