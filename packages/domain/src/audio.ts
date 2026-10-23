// 停止理由ごとの動作と再開条件、遅着した結果の受け入れ（設計 10 §1A F03・§2A、07 §5、ADR 0005）。

export type AudioAction =
  'stop_playback' | 'close_voice_session' | 'suspend_io';

export const AUDIO_ACTION_REASONS = {
  stop_playback: ['user_stop', 'barge_in'],
  close_voice_session: [
    'silence',
    'output_mode_text',
    'budget_reached',
    'private_conversation',
    'conversation_ended',
    'device_move',
    'provider_failure',
    'sideband_lost',
    'consent_revoked',
  ],
  suspend_io: [
    'device_io_stop',
    'os_lock',
    'guest_mode',
    'global_stop',
    'device_revoked',
    'core_lease_lost',
  ],
} as const satisfies Record<AudioAction, readonly string[]>;

export type AudioReason = (typeof AUDIO_ACTION_REASONS)[AudioAction][number];

// playback_queue: 再生キューと現在の output_epoch を照合して再開。旧音声を新しい世代へ付け替えない。
// wake_word: 入出力の許可が有効なら次の呼びかけで新しい Live を開く（同じ session_id）。
// local_asr_until_*: その間は①を開かず③を使う。条件が解けたら次の呼びかけで①。
// wake_word_new_session: 会話（session_id）を終え、次の呼びかけは新しい会話。
// wake_word_on_new_device: 移動先の端末の呼びかけで新しい Live を開く。
// local_asr_or_wake_word: ③は使える。①は次の呼びかけで新しい接続（同じ接続は復活させない）。
// local_asr_until_consent: 外部への送信の同意を取り直すまで③。①は開かない（ADR 0038。原本に決めなし）。
// explicit_screen_resume: 登録済み・ロック解除済みの端末の画面で明示再開し、許可とリースを再検査する。
export type ResumeCondition =
  | 'playback_queue'
  | 'wake_word'
  | 'local_asr_until_voice_mode'
  | 'local_asr_until_budget'
  | 'local_asr_until_private_ends'
  | 'wake_word_new_session'
  | 'wake_word_on_new_device'
  | 'local_asr_or_wake_word'
  | 'local_asr_until_consent'
  | 'explicit_screen_resume';

export interface AudioControlRule {
  readonly action: AudioAction;
  readonly stopsPlayback: boolean;
  readonly closesLive: boolean;
  // 収音元・KWS / VAD / ASR への配送を止め、PCM とリングを破棄する。
  readonly stopsCapture: boolean;
  readonly endsSession: boolean;
  readonly scope: 'local' | 'guest' | 'global' | null;
  readonly resume: ResumeCondition;
}

const stop = (): AudioControlRule => ({
  action: 'stop_playback',
  stopsPlayback: true,
  closesLive: false,
  stopsCapture: false,
  endsSession: false,
  scope: null,
  resume: 'playback_queue',
});
const close = (
  resume: ResumeCondition,
  endsSession = false,
): AudioControlRule => ({
  action: 'close_voice_session',
  stopsPlayback: true,
  closesLive: true,
  stopsCapture: false,
  endsSession,
  scope: null,
  resume,
});
const suspend = (scope: 'local' | 'guest' | 'global'): AudioControlRule => ({
  action: 'suspend_io',
  stopsPlayback: true,
  closesLive: true,
  stopsCapture: true,
  endsSession: false,
  scope,
  resume: 'explicit_screen_resume',
});

export const AUDIO_CONTROL_RULES: Readonly<
  Record<AudioReason, AudioControlRule>
> = {
  user_stop: stop(),
  barge_in: stop(),
  silence: close('wake_word'),
  output_mode_text: close('local_asr_until_voice_mode'),
  budget_reached: close('local_asr_until_budget'),
  private_conversation: close('local_asr_until_private_ends'),
  conversation_ended: close('wake_word_new_session', true),
  device_move: close('wake_word_on_new_device'),
  provider_failure: close('local_asr_or_wake_word'),
  sideband_lost: close('local_asr_or_wake_word'),
  consent_revoked: close('local_asr_until_consent'),
  device_io_stop: suspend('local'),
  os_lock: suspend('local'),
  guest_mode: suspend('guest'),
  global_stop: suspend('global'),
  device_revoked: suspend('local'),
  core_lease_lost: suspend('local'),
};

const STRENGTH: Readonly<Record<AudioAction, number>> = {
  stop_playback: 1,
  close_voice_session: 2,
  suspend_io: 3,
};

// 重なった停止は強い方を優先する（10 §1A: 端末自体の停止が重なれば suspend_io）。
export function strongerReason(a: AudioReason, b: AudioReason): AudioReason {
  return STRENGTH[AUDIO_CONTROL_RULES[b].action] >
    STRENGTH[AUDIO_CONTROL_RULES[a].action]
    ? b
    : a;
}

export function audioControlScopeMatches(
  reason: AudioReason,
  scope: 'local' | 'guest' | 'global' | null,
): boolean {
  return AUDIO_CONTROL_RULES[reason].scope === scope;
}

export type InputKind = 'voice_live' | 'voice_local' | 'text';

// 出力先は入力時に固定する。音声の接続が開いているかは見ない（文字の依頼は常に文字。D14、10 §6）。
export function resolveOutputMode(inputKind: InputKind): 'voice' | 'text' {
  return inputKind === 'voice_live' ? 'voice' : 'text';
}

export interface DeviceEpochs {
  readonly deviceId: string;
  readonly ioEpoch: string;
  readonly audioEpoch: string | null;
  readonly outputEpoch: string;
  readonly sessionEpoch: string | null;
  readonly ioSuspended: boolean;
  readonly audioLeaseValid: boolean;
}

export interface Delivery {
  readonly kind: 'voice_output' | 'live_start' | 'asr_result' | 'stop_ack';
  readonly deviceId: string;
  readonly mode?: 'voice' | 'text';
  readonly ioEpoch?: string;
  readonly audioEpoch?: string;
  readonly outputEpoch?: string;
  readonly sessionEpoch?: string;
}

export type DeliveryDecision =
  | { readonly decision: 'accept' }
  | { readonly decision: 'screen_only' | 'discard'; readonly reason: string };

// 遅着した結果・音声・ACK の受け入れ（07 §5 D15、10 §1A）。
// 音声で返す結果が使えないときは一覧（画面）に回し、それ以外の遅着は破棄する。
export function acceptDelivery(
  delivery: Delivery,
  current: DeviceEpochs,
): DeliveryDecision {
  const rejected = (reason: string): DeliveryDecision => ({
    decision: delivery.kind === 'voice_output' ? 'screen_only' : 'discard',
    reason,
  });
  if (delivery.deviceId !== current.deviceId) return rejected('other_device');
  const pairs: [string | undefined, string | null][] = [
    [delivery.ioEpoch, current.ioEpoch],
    [delivery.audioEpoch, current.audioEpoch],
    [delivery.outputEpoch, current.outputEpoch],
    [delivery.sessionEpoch, current.sessionEpoch],
  ];
  for (const [given, now] of pairs) {
    if (given === undefined) continue;
    if (now === null) return rejected('no_current_epoch');
    if (BigInt(given) < BigInt(now)) return rejected('stale_epoch');
    if (BigInt(given) > BigInt(now)) return rejected('unknown_epoch');
  }
  if (delivery.kind === 'voice_output') {
    if (delivery.mode !== 'voice') return rejected('text_request');
    if (current.ioSuspended || !current.audioLeaseValid)
      return rejected('voice_unavailable');
  }
  if (delivery.kind === 'live_start' && current.ioSuspended)
    return rejected('io_suspended');
  return { decision: 'accept' };
}
