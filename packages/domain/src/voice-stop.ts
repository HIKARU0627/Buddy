// 3 層の停止の時間モデル（B05-02、ADR 0039。設計 10 §1・§1A・§9、09 X13・X30・QA43）。
// 時刻は呼び出し側が単調時計で読んで渡す。200ms・300ms は設計の初期値（目標・期限）で、合格値ではない（質問 44）。
// 第 1 層（端末のローカル停止）は ACK・session.close を待たない。第 2 層（main の強制終了）は ACK の期限、
// 第 3 層（中枢のサイドバンドからの終了と使用量の照合）は終了を確認するまで予約を精算しない。

import {
  AUDIO_CONTROL_RULES,
  type AudioAction,
  type AudioReason,
} from './audio.js';
import {
  VOICE_IPC_TIMEOUTS,
  type VoiceIpcChannel,
  type VoiceIpcTimeoutAction,
} from './voice.js';

// 第 1 層の目標（ms）。ローカルで再生・送信・収音を止めるまで。目標を外しても失敗とはせず記録する。
export const STOP_LAYER1_TARGET_MS = 200;
// 第 2 層の期限（ms）。main が ACK を待つ上限（suspend_io と stop_playback。VOICE_IPC_TIMEOUTS と同じ値）。
export const STOP_LAYER2_DEADLINE_MS = 300;

const ACTION_CHANNEL: Readonly<Record<AudioAction, VoiceIpcChannel>> = {
  stop_playback: 'voice.stop_playback',
  close_voice_session: 'voice.close_voice_session',
  suspend_io: 'voice.suspend_io',
};

export type StopStepName =
  | 'mute_playback'
  | 'discard_queued_audio'
  | 'disable_live_send'
  | 'close_webrtc'
  | 'stop_mic_track'
  | 'discard_pcm_ring'
  | 'stop_kws_vad_asr_delivery'
  | 'advance_output_epoch'
  | 'advance_io_epoch'
  | 'invalidate_old_epoch_results'
  | 'core_sideband_close'
  | 'reconcile_usage_hold_reservation';

export interface StopPlan {
  readonly action: AudioAction;
  readonly channel: VoiceIpcChannel;
  // 第 1 層。端末がその場で行う。ACK・session.close を待たない（待たせる項目を持たない）。
  readonly local: readonly StopStepName[];
  // 第 2 層。main が ACK を待つ上限（ms）。
  readonly ack_deadline_ms: number;
  // 第 3 層。中枢がサイドバンドから閉じ、終了と使用量を照合する。Live を閉じない stop_playback は空。
  readonly core: readonly StopStepName[];
}

// 理由ごとの停止の手順。Live を閉じるか・収音を止めるかは AUDIO_CONTROL_RULES（audio.ts）の表から決め、
// この関数で表を二重に持たない。世代の進め方は ADR 0005（端末が停止時にその場で進める）の読みで、
// stop_playback と close は output_epoch、suspend_io は io_epoch と output_epoch を進める（原本は stop_playback の
// output_epoch だけを明記。他は原本に決めなし）。
export function planStop(reason: AudioReason): StopPlan {
  const rule = AUDIO_CONTROL_RULES[reason];
  const local: StopStepName[] = ['mute_playback', 'discard_queued_audio'];
  if (rule.closesLive) local.push('disable_live_send', 'close_webrtc');
  if (rule.stopsCapture)
    local.push(
      'stop_mic_track',
      'discard_pcm_ring',
      'stop_kws_vad_asr_delivery',
    );
  local.push('advance_output_epoch');
  if (rule.action === 'suspend_io') local.push('advance_io_epoch');
  const core: StopStepName[] = [];
  if (rule.stopsCapture) core.push('invalidate_old_epoch_results');
  if (rule.closesLive)
    core.push('core_sideband_close', 'reconcile_usage_hold_reservation');
  const channel = ACTION_CHANNEL[rule.action];
  return {
    action: rule.action,
    channel,
    local,
    ack_deadline_ms: VOICE_IPC_TIMEOUTS[channel].maxAckTimeoutMs,
    core,
  };
}

export type StopLayer1Status = 'met' | 'missed' | 'not_reported';
export type StopLayer2Status = 'acked' | 'waiting' | 'timed_out';

export interface StopObservation {
  readonly reason: AudioReason;
  // main が停止を決めた（命令を出した）時刻。
  readonly requested_at_mono_ms: number;
  // 端末が第 1 層のローカル停止を終えたと報告した時刻。報告がなければ null。
  readonly local_stop_completed_at_mono_ms: number | null;
  // ACK を受けた時刻。受けていなければ null。
  readonly ack_at_mono_ms: number | null;
  // acceptVoiceAck の結果（受け付けたか）。ACK がなければ null。受け付けなかった ACK は、なかったものとして扱う。
  readonly ack_accepted: boolean | null;
  // 要求に付けた ACK の待ち時間。チャネルの上限（VOICE_IPC_TIMEOUTS）を超えた分は切り詰める。
  readonly ack_timeout_ms: number;
  readonly now_mono_ms: number;
}

export interface StopAssessment {
  readonly action: AudioAction;
  readonly layer1: {
    readonly target_ms: number;
    readonly elapsed_ms: number | null;
    readonly status: StopLayer1Status;
  };
  readonly layer2: {
    readonly deadline_ms: number;
    readonly status: StopLayer2Status;
    // 期限の後に届いた ACK（強制終了・全停止の後なので、再開・完了として使わない。X30）。
    readonly late_ack_ignored: boolean;
  };
  // ACK が来なかった（期限切れ）ときに main がすること。期限内なら null。
  readonly fallback: VoiceIpcTimeoutAction | null;
  // stop_playback の ACK 喪失で全停止に上げるときは、入力の中断を画面で知らせる（10 §1）。
  readonly notify_input_interrupted: boolean;
  // 全停止へ上げるときの端末の状態。理由は既存の device_io_stop（local）を使う（ADR 0039。新しい理由は足さない）。
  // 画面で明示再開するまで再開しない（安全側）。
  readonly escalation: {
    readonly action: 'suspend_io';
    readonly reason: 'device_io_stop';
    readonly scope: 'local';
  } | null;
  readonly invalidate_old_epoch_results: boolean;
  readonly reasons: readonly string[];
}

// 3 層の停止の判定。境界は「以内」で、ACK が期限ちょうどなら間に合い、期限を 1ms 過ぎれば強制終了する。
// 受け付けなかった ACK・要求より前の時刻の ACK（時計の戻り）は、ACK がなかったものとして期限まで待ち、期限で強制終了する。
export function assessStop(observation: StopObservation): StopAssessment {
  const plan = planStop(observation.reason);
  const rule = VOICE_IPC_TIMEOUTS[plan.channel];
  const deadline = Math.min(observation.ack_timeout_ms, rule.maxAckTimeoutMs);
  const reasons: string[] = [];
  if (observation.ack_timeout_ms > rule.maxAckTimeoutMs)
    reasons.push('ack_timeout_clamped');

  const l1 = observation.local_stop_completed_at_mono_ms;
  const elapsed1 = l1 === null ? null : l1 - observation.requested_at_mono_ms;
  let layer1: StopLayer1Status = 'not_reported';
  if (elapsed1 !== null) {
    if (elapsed1 < 0) reasons.push('local_stop_clock_regressed');
    else layer1 = elapsed1 <= STOP_LAYER1_TARGET_MS ? 'met' : 'missed';
  }

  const ackAt = observation.ack_at_mono_ms;
  const ackElapsed =
    ackAt === null ? null : ackAt - observation.requested_at_mono_ms;
  if (ackElapsed !== null && ackElapsed < 0)
    reasons.push('ack_clock_regressed');
  if (ackElapsed !== null && observation.ack_accepted === false)
    reasons.push('ack_not_accepted');
  const usableAck =
    ackElapsed !== null && ackElapsed >= 0 && observation.ack_accepted === true;
  const inTime = usableAck && (ackElapsed as number) <= deadline;
  const waited = observation.now_mono_ms - observation.requested_at_mono_ms;

  let layer2: StopLayer2Status;
  let lateAck = false;
  if (inTime) layer2 = 'acked';
  else if (waited <= deadline) layer2 = 'waiting';
  else {
    layer2 = 'timed_out';
    if (usableAck) {
      lateAck = true;
      reasons.push('late_ack_ignored');
    }
  }

  const timedOut = layer2 === 'timed_out';
  const fallback = timedOut ? rule.onTimeout : null;
  const escalates = fallback === 'escalate_suspend_io';
  return {
    action: plan.action,
    layer1: {
      target_ms: STOP_LAYER1_TARGET_MS,
      elapsed_ms: elapsed1 !== null && elapsed1 >= 0 ? elapsed1 : null,
      status: layer1,
    },
    layer2: {
      deadline_ms: deadline,
      status: layer2,
      late_ack_ignored: lateAck,
    },
    fallback,
    notify_input_interrupted: escalates,
    escalation: escalates
      ? { action: 'suspend_io', reason: 'device_io_stop', scope: 'local' }
      : null,
    // 強制終了・全停止へ上がったときは、KWS・ASR の入力と遅れて届く結果を旧世代として無効にする（10 §1 第 2 層）。
    invalidate_old_epoch_results:
      timedOut &&
      (fallback === 'force_kill_renderer' ||
        fallback === 'escalate_suspend_io'),
    reasons,
  };
}
