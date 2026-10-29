// main の音声の制御（設計 10 §1・§1A・§2・§3、07 §5、B05-06、ADR 0050）。Electron に依存しない（node:test で試験する）。
// - 隠した音声レンダラー（VoiceRendererPort）へ、6 つの限定 IPC（VoiceRendererRequest）だけを送り、ACK を照合する。
//   世代を進めるのは main だけで、進めた後の値を命令に付ける（ADR 0038）。
// - 3 層の停止: 第 1 層は音声レンダラーがその場で止める。第 2 層は main が ACK の期限（suspend_io は 300 ms）を見て、
//   ACK がない・失敗した・受け付けられない ACK しかないときは音声レンダラーを強制終了し、この端末の入出力も止める
//   （「ACK が返らないときは、全部止める」）。再生停止の ACK がなければ全停止へ上げ、入力の中断を画面で知らせる。
//   第 3 層は中枢がサイドバンドから閉じる（main は中枢へ閉じる要求を送る。VoiceCorePort.closeLive）。
// - 古い世代の結果の無効化: 停止・強制終了・作り直しの後に届いた ACK、前の音声レンダラーからの ACK、世代の合わない ACK を
//   使わない（acceptVoiceAck・音声レンダラーの世代）。
// - OS のロック・この端末の停止・来客モード・全体停止・スリープは suspend_io で止める。解除・再接続・呼びかけでは
//   自動で再開しない（再開は画面の明示の再開の後に「続ける」で新しく始める）。
// - 最小の「続ける」: 外部への送信の同意がなければ OS の確認ダイアログで 1 回だけ取り、リースを取り、中枢へ Live の接続を
//   求め、answer を音声レンダラーへ渡す。途中で止まった・ロックした・同意を取り消したら始めない。
// - 判別できないとき（音声レンダラーの無応答・クラッシュ・読み込みの失敗・時計の逆行）は止める側へ倒す。
// - 返し方（声で返す・文字で返す。B05-05、ADR 0052）は端末ごとの設定で main が持つ。声から文字へ切り替えたら、開いている
//   Live をすぐ閉じる（理由 output_mode_text。同じ会話と文脈は続く）。文字のときは Live を開かず、「続ける」を押せない。
//   会話の操作（読み上げの停止・会話の終了・返し方の切り替え）は、画面のボタン・照合表に当たった発言（文字の応答の
//   session_control）・中枢が照合した Live の発話（中枢の音声イベント）のどれからでも、同じ処理を通る。
import type {
  DesktopIpcChannel,
  DesktopIpcResponse,
  DesktopVoiceView,
  VoiceRendererAck,
  VoiceRendererRequest,
  VoiceState,
} from '@buddy/contracts';
import {
  SESSION_CONTROL_EFFECTS,
  VOICE_IPC_TIMEOUTS,
  acceptVoiceAck,
  admitDesktopRequest,
  advanceEpoch,
  assessStop,
  classifyEpoch,
  planReplyModeChange,
  retainPendingVoiceRequests,
  voiceRequestErrors,
  type AudioReason,
  type DesktopIoState,
  type DesktopIpcRejectReason,
  type DesktopIpcSender,
  type SessionControlAction,
  type VoiceCurrentState,
  type VoiceIpcChannel,
} from '@buddy/domain';
import type { DesktopContract } from './contract.js';
import { VoiceLeaseKeeper, type LeasePort } from './voice-lease-keeper.js';
import type { VoiceConsentStore } from './voice-consent.js';
import type { VoiceReplyModeStore } from './voice-reply-mode.js';
import type { StatusBarVoice } from './status-bar.js';

export const VOICE_CHANNELS: readonly DesktopIpcChannel[] = [
  'desktop.get_voice',
  'desktop.voice_continue',
  'desktop.voice_consent_revoke',
  'desktop.voice_control',
];

// 音声レンダラーの窓の操作（Electron のアダプターが BrowserWindow で実装する）。
export interface VoiceRendererPort {
  // 新しい音声レンダラーを作る。generation はこの作り直しの番号（ACK・出来事をこの番号で受ける）。
  create(generation: number): void;
  // 命令を送る。送れなかった（窓がない・壊れた）ら false。
  send(generation: number, request: VoiceRendererRequest): boolean;
  // 強制終了する（レンダラーのプロセスを止め、窓を壊す）。
  kill(generation: number): void;
}

export type LiveOpenResult =
  | {
      readonly kind: 'answer';
      readonly liveSessionId: string;
      readonly sdpAnswer: string;
      readonly audioEpoch: string;
      readonly sessionEpoch: string;
    }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unknown' };

// 中枢との音声の経路（リースの更新と Live の接続）。製品の起動では、中枢の Live の provider がまだないので使えない
// （ADR 0050）。開発の模擬（--buddy-voice=mock）では端末の中だけで答える。
export interface VoiceCorePort extends LeasePort {
  openLive(request: {
    readonly purpose: 'conversation' | 'notification';
  }): Promise<LiveOpenResult>;
  // 中枢へ閉じる要求を送る（第 3 層の起点。結果は待たない）。
  closeLive(liveSessionId: string, reason: AudioReason): void;
}

export interface VoiceClock {
  // 単調時計（整数の ms）と壁時計（UTC の ms）。
  readonly mono: () => number;
  readonly wall: () => number;
  readonly setTimer: (ms: number, run: () => void) => () => void;
  readonly newId: () => string;
}

export interface VoiceControllerOptions {
  // 音声を使う組み立てか（開発用のフラグの模擬のときだけ true。false なら音声レンダラーを作らない）。
  readonly enabled: boolean;
  readonly contract: DesktopContract;
  readonly renderer: VoiceRendererPort;
  readonly core: VoiceCorePort;
  readonly clock: VoiceClock;
  readonly consent: VoiceConsentStore;
  // OS の確認ダイアログで同意を取る。同意したら true、やめたら false、出せなかったら 'not_shown'。
  readonly confirmConsent: () => Promise<boolean | 'not_shown'>;
  // 出している同意の確認を閉じる（止まった・ロックした・取り消した。閉じた確認は「やめる」と同じく同意しない）。
  readonly cancelConsent?: () => void;
  // この端末の入出力を止める（DesktopDeviceController.stopFromMain。同期で deviceChanged が呼ばれる）。
  readonly stopDevice: () => void;
  // 音声の状態（画面の表示・状態欄）が変わった。
  readonly onChange: () => void;
  readonly log: (code: string) => void;
  // この端末の返し方の記録（声で返す・文字で返す）。なければ保存しない「声で返す」。
  readonly replyMode?: VoiceReplyModeStore;
  // 本人の「ちょっと待って」（中枢の音声イベント silence_extension・文字の応答の session_control）。次の 1 つの無音の区間だけ
  // 猶予をこの値（ms）にする。無音の判定は main だけが行う（ADR 0041）。
  readonly onSilenceExtension?: (ms: number) => void;
}

interface PendingVoiceRequest {
  readonly request: VoiceRendererRequest;
  readonly generation: number;
  readonly sentAtMono: number;
  readonly reason: AudioReason | null;
  cancel: () => void;
  // 直前に期限を見た時刻（時計の逆行の検出）。
  observedAtMono: number | null;
}

interface LiveSession {
  readonly liveSessionId: string;
  readonly purpose: 'conversation' | 'notification';
  phase: 'starting' | 'live';
}

type StopChannel =
  'voice.stop_playback' | 'voice.close_voice_session' | 'voice.suspend_io';

const STOP_CHANNELS: readonly string[] = [
  'voice.stop_playback',
  'voice.close_voice_session',
  'voice.suspend_io',
];

const isStopChannel = (channel: string): channel is StopChannel =>
  STOP_CHANNELS.includes(channel);

const permitted = (state: DesktopIoState): boolean =>
  state.lockState === 'unlocked' && state.stopScope === 'none';

// 止める理由（端末の状態から決める。ロックが最優先。来客モード・全体停止は中枢の停止の範囲）。
export function suspendReasonFor(state: DesktopIoState): {
  readonly reason: AudioReason;
  readonly scope: 'local' | 'guest' | 'global';
} {
  if (state.lockState !== 'unlocked')
    return { reason: 'os_lock', scope: 'local' };
  if (state.stopScope === 'global')
    return { reason: 'global_stop', scope: 'global' };
  if (state.stopScope === 'guest')
    return { reason: 'guest_mode', scope: 'guest' };
  return { reason: 'device_io_stop', scope: 'local' };
}

// 状態の通知の処理（electron/main.ts）で、音声の制御の例外を記録だけして投げ直さない。トレイの更新・ロックしたときに
// キャンバスを戻す処理などを飛ばさない（PR #160 のレビュー P3、Issue #162）。
// 例外の後はフォールバックで必ず止める（音声レンダラーの強制終了とこの端末の停止）。途中で例外が出ても、停止が
// 黙って失われないようにする（Issue #162 の P2）。
export function notifyVoiceDeviceChanged(
  voice: {
    deviceChanged(state: DesktopIoState): void;
    failSafeStop(): void;
  } | null,
  state: DesktopIoState,
  log: (code: string) => void,
): void {
  try {
    voice?.deviceChanged(state);
  } catch {
    log('voice_device_changed_failed');
    try {
      voice?.failSafeStop();
    } catch {
      log('voice_fail_safe_stop_failed');
    }
  }
}

export class VoiceController {
  readonly #options: VoiceControllerOptions;
  readonly #lease: VoiceLeaseKeeper;
  #device: DesktopIoState = {
    lockState: 'unknown',
    stopScope: 'local',
    ioEpoch: '0',
  };
  #generation = 0;
  #alive = false;
  #ready = false;
  // main が進める出力の世代（RAM。音声レンダラーは起動ごとに作り直すので、起動の間だけ増えればよい。ADR 0050）。
  #output = '0';
  // 中枢が発行した最後の音声・会話の世代（Live の接続ごとに進む）。
  #audio: string | null = null;
  #session: string | null = null;
  readonly #pending = new Map<string, PendingVoiceRequest>();
  #live: LiveSession | null = null;
  // 音声を外部へ送っている（送っているかもしれない）。開始の命令から、閉じる・停止の ACK か強制終了まで。
  #external = false;
  // 「続ける」の途中（同意の確認・リース・接続を待っている）。
  #starting = false;
  // 「続ける」の手順の番号。止める・ロック・取り消しで進め、待っている手順を捨てる。
  #flow = 0;
  // 最後に suspend_io を送った入出力の世代（同じ停止で重ねて送らない）。
  #suspendedIo: string | null = null;
  // 次の停止の理由（端末の状態からではなく、main が理由を知っているとき。リースの喪失など）。
  #nextStopReason: AudioReason | null = null;
  #notice: 'input_interrupted' | 'not_started' | null = null;
  #lastSignature = '';
  // 返し方（記録がなければ声）。文字のとき Live を開かない。
  #replyMode: 'voice' | 'text';

  constructor(options: VoiceControllerOptions) {
    this.#options = options;
    this.#replyMode = options.replyMode?.mode ?? 'voice';
    this.#lease = new VoiceLeaseKeeper({
      port: options.core,
      clock: options.clock,
      ioState: () => ({
        ioEpoch: this.#device.ioEpoch,
        suspended: !permitted(this.#device),
      }),
      onLost: () => this.#leaseLost(),
      log: options.log,
    });
  }

  // 試験用。
  get generation(): number {
    return this.#generation;
  }

  get rendererAlive(): boolean {
    return this.#alive;
  }

  get externalSend(): boolean {
    return this.#external;
  }

  get replyMode(): 'voice' | 'text' {
    return this.#replyMode;
  }

  get leaseActive(): boolean {
    return this.#lease.active;
  }

  get pendingChannels(): readonly string[] {
    return [...this.#pending.values()].map((entry) => entry.request.channel);
  }

  // ---- 端末の状態 -------------------------------------------------------------------------------------------

  // 端末の状態（ロック・停止・io_epoch）が変わった。止まったら suspend_io、許可が戻ったら音声レンダラーを用意する
  // （用意するだけで、収音・会話は始めない）。
  deviceChanged(state: DesktopIoState): void {
    const before = this.#device;
    this.#device = state;
    if (!this.#options.enabled) {
      this.#emit();
      return;
    }
    if (!permitted(state)) {
      if (this.#starting) this.#options.cancelConsent?.();
      this.#flow += 1;
      this.#starting = false;
      this.#lease.stop();
      const stop = suspendReasonFor(state);
      const reason = this.#nextStopReason ?? stop.reason;
      const scope = this.#nextStopReason === null ? stop.scope : 'local';
      this.#nextStopReason = null;
      if (this.#live !== null) {
        this.#closeLive(this.#live.liveSessionId, reason);
        this.#live = null;
      }
      if (this.#alive && this.#suspendedIo !== state.ioEpoch) {
        if (!this.#ready) this.#kill('not_ready_at_stop');
        else this.#suspend(reason, scope);
      }
    } else {
      this.#nextStopReason = null;
      if (!permitted(before)) this.#suspendedIo = null;
      if (!this.#alive) this.#create();
    }
    this.#retain();
    this.#emit();
  }

  // 例外の後でも必ず止める（notifyVoiceDeviceChanged のフォールバック。Issue #162 の P2）。音声レンダラーを強制終了して
  // 外部への送信を止め、この端末の入出力も止める（判別できないときは止める側へ倒す）。
  failSafeStop(): void {
    this.#kill('fail_safe');
    this.#stopDevice('device_io_stop');
  }

  // ---- 音声レンダラーの出来事 -------------------------------------------------------------------------------

  // 読み込みが終わった（命令を受けられる）。
  rendererReady(generation: number): void {
    if (generation !== this.#generation || !this.#alive) return;
    this.#ready = true;
    this.#emit();
  }

  // 壊れた・無応答・読み込みに失敗した。判別できないので強制終了し、この端末の入出力を止める。
  rendererGone(generation: number, cause: string): void {
    if (generation !== this.#generation || !this.#alive) return;
    this.#options.log(`voice_renderer_gone:${cause}`);
    this.#kill(cause);
    this.#stopDevice('device_io_stop');
  }

  // 音声レンダラーからの ACK。形・送信元の世代・待っている要求・今の世代を照合してから使う。
  receiveAck(generation: number, raw: unknown): void {
    if (generation !== this.#generation || !this.#alive) {
      this.#options.log('voice_ack_from_old_renderer');
      return;
    }
    if (!this.#options.contract.valid('VoiceRendererAck', raw)) {
      this.#options.log('voice_ack_invalid');
      return;
    }
    const ack = raw as VoiceRendererAck;
    const { session_epoch: ackSession, ...ackRest } = ack;
    const decision = acceptVoiceAck(
      [...this.#pending.values()].map((entry) => entry.request),
      ackSession === null ? ackRest : { ...ackRest, session_epoch: ackSession },
      this.#current(),
    );
    if (!decision.accepted) {
      this.#options.log(`voice_ack_ignored:${decision.errors.join('+')}`);
      return;
    }
    const entry = this.#pending.get(ack.request_id);
    if (entry === undefined) return;
    entry.cancel();
    this.#pending.delete(ack.request_id);
    const channel = entry.request.channel;
    if (isStopChannel(channel)) {
      const now = this.#options.clock.mono();
      const assessment = assessStop({
        reason: entry.reason as AudioReason,
        requested_at_mono_ms: entry.sentAtMono,
        local_stop_completed_at_mono_ms: null,
        ack_at_mono_ms: now,
        ack_accepted: true,
        ack_outcome: ack.outcome,
        ack_timeout_ms: entry.request.ack_timeout_ms,
        now_mono_ms: now,
        previous_observed_mono_ms: entry.observedAtMono,
      });
      if (assessment.layer2.status === 'acked') this.#stopApplied(channel);
      else this.#fallback(channel, assessment.fallback);
    } else if (channel === 'voice.start') {
      if (ack.outcome === 'applied' && this.#live !== null)
        this.#live.phase = 'live';
      else if (ack.outcome !== 'applied')
        this.#closeSession('provider_failure');
    }
    this.#emit();
  }

  // ---- 本人の操作 -------------------------------------------------------------------------------------------

  // 限定 IPC（状態の層の get_voice・voice_continue・voice_consent_revoke）。
  async handleIpc(
    ipcChannel: string,
    raw: unknown,
    sender: DesktopIpcSender,
  ): Promise<DesktopIpcResponse> {
    const contract = this.#options.contract;
    if (!contract.isRequest(raw) || raw.channel !== ipcChannel)
      return this.#respond({
        request_id: null,
        channel: null,
        outcome: 'rejected',
        reason: 'invalid_request',
      });
    const admission = admitDesktopRequest(
      raw.channel,
      null,
      this.#device,
      sender,
    );
    if (!admission.ok)
      return this.#reject(raw.request_id, raw.channel, admission.reason);
    switch (raw.channel) {
      case 'desktop.get_voice':
        return this.#ok(raw.request_id, raw.channel);
      case 'desktop.voice_consent_revoke':
        this.revokeConsent();
        return this.#ok(raw.request_id, raw.channel);
      case 'desktop.voice_control': {
        const result = this.#controlFromButton(raw.payload);
        return result === 'ok'
          ? this.#ok(raw.request_id, raw.channel)
          : this.#reject(raw.request_id, raw.channel, result);
      }
      case 'desktop.voice_continue': {
        const result = await this.continueConversation();
        return result === 'ok'
          ? this.#ok(raw.request_id, raw.channel)
          : this.#reject(raw.request_id, raw.channel, result);
      }
      default:
        return this.#reject(raw.request_id, raw.channel, 'invalid_request');
    }
  }

  // 最小の「続ける」（呼びかけ語なしで音声の会話を始める。設計 10 §3）。
  async continueConversation(): Promise<'ok' | DesktopIpcRejectReason> {
    if (!this.#options.enabled) return 'voice_unavailable';
    if (this.#device.lockState !== 'unlocked') return 'device_locked';
    if (!permitted(this.#device)) return 'input_stopped';
    // 文字で返す設定では Live を開かない（外へ音声を送らない。聞き取りは端末の中で文字にする③。10 §6A）。
    if (this.#replyMode === 'text') return 'voice_unavailable';
    if (
      !this.#alive ||
      !this.#ready ||
      this.#starting ||
      this.#live !== null ||
      this.#external
    )
      return 'voice_unavailable';
    this.#flow += 1;
    const flow = this.#flow;
    this.#starting = true;
    this.#notice = null;
    this.#emit();
    try {
      return await this.#continue(flow);
    } finally {
      if (flow === this.#flow) this.#starting = false;
      this.#emit();
    }
  }

  async #continue(flow: number): Promise<'ok' | DesktopIpcRejectReason> {
    const aborted = () => flow !== this.#flow || !permitted(this.#device);
    // 置き換えられた古い手順からは、新しい手順のリースを止めない（Issue #162）。
    const stopLeaseIfCurrent = () => {
      if (flow === this.#flow) this.#lease.stop();
    };
    if (this.#options.consent.status !== 'granted') {
      let confirmed: boolean | 'not_shown';
      try {
        confirmed = await this.#options.confirmConsent();
      } catch {
        confirmed = 'not_shown';
      }
      if (aborted()) return 'input_stopped';
      if (confirmed === 'not_shown') return 'screen_operation_required';
      if (!confirmed) return 'confirmation_declined';
      this.#options.consent.grant();
      this.#emit();
    }
    const leased = await this.#lease.start();
    if (aborted()) {
      stopLeaseIfCurrent();
      return 'input_stopped';
    }
    if (!leased) return this.#notStarted();
    let opened: LiveOpenResult;
    try {
      opened = await this.#options.core.openLive({ purpose: 'conversation' });
    } catch {
      opened = { kind: 'unknown' };
    }
    // 待っている間にリースを失った（更新の拒否・期限切れ・時計の不整合）: リースのないまま始めない。開いた接続は閉じる。
    if (
      !this.#lease.active &&
      permitted(this.#device) &&
      this.#options.consent.status === 'granted'
    ) {
      if (opened.kind === 'answer')
        this.#closeLive(opened.liveSessionId, 'core_lease_lost');
      return this.#notStarted();
    }
    if (aborted() || this.#options.consent.status !== 'granted') {
      // 待っている間に止まった・同意を取り消した: 開いていれば閉じ、音声レンダラーへは渡さない。
      // 置き換えられただけ（端末は止まっていない）なら、その手順を捨てた理由にする（Issue #162）。
      if (opened.kind === 'answer')
        this.#closeLive(
          opened.liveSessionId,
          this.#options.consent.status !== 'granted'
            ? 'consent_revoked'
            : permitted(this.#device)
              ? 'provider_failure'
              : suspendReasonFor(this.#device).reason,
        );
      stopLeaseIfCurrent();
      return aborted() ? 'input_stopped' : 'voice_unavailable';
    }
    if (opened.kind !== 'answer') {
      this.#lease.stop();
      return this.#notStarted();
    }
    // 中枢が発行した世代が、前の接続の世代より新しいときだけ使う（古い世代の answer を渡さない）。
    if (
      (this.#audio !== null &&
        classifyEpoch(opened.audioEpoch, this.#audio) !== 'unknown') ||
      (this.#session !== null &&
        classifyEpoch(opened.sessionEpoch, this.#session) === 'stale')
    ) {
      this.#options.log('voice_live_epoch_not_newer');
      this.#closeLive(opened.liveSessionId, 'provider_failure');
      this.#lease.stop();
      return this.#notStarted();
    }
    this.#audio = opened.audioEpoch;
    this.#session = opened.sessionEpoch;
    this.#live = {
      liveSessionId: opened.liveSessionId,
      purpose: 'conversation',
      phase: 'starting',
    };
    // 開始の命令を出した時点から、音声を外部へ送っているかもしれない（印を先に出す）。
    this.#external = true;
    this.#retain();
    const sent = this.#send('voice.start', null, {
      live_session_id: opened.liveSessionId,
      purpose: 'conversation',
      sdp_answer: opened.sdpAnswer,
      io_epoch: this.#device.ioEpoch,
      audio_epoch: opened.audioEpoch,
      output_epoch: this.#output,
      session_epoch: opened.sessionEpoch,
    });
    return sent ? 'ok' : 'voice_unavailable';
  }

  // 外部への送信の同意を取り消す（確認なし・いつでも）。会話中なら閉じる。
  revokeConsent(): void {
    this.#options.consent.revoke();
    // 同意の確認・接続を待っている「続ける」も捨てる。
    if (this.#starting) {
      this.#options.cancelConsent?.();
      this.#flow += 1;
      this.#starting = false;
      this.#lease.stop();
    }
    if (this.#live !== null || this.#external)
      this.#closeSession('consent_revoked');
    this.#emit();
  }

  // 会話を閉じる（無音・会話の終わり・返し方の変更など。理由は close_voice_session の理由）。
  closeConversation(reason: AudioReason): void {
    if (this.#live === null && !this.#external) return;
    this.#closeSession(reason);
    this.#emit();
  }

  // 返し方を切り替える（B05-05）。声から文字へは、開いている Live（始めている途中を含む）をすぐ閉じる。文字から声へは、
  // 設定を戻すだけで、接続は本人の次の「続ける」・呼びかけで新しく作る（閉じた接続は戻さない）。
  setReplyMode(next: 'voice' | 'text'): void {
    const change = planReplyModeChange({
      current: this.#replyMode,
      next,
      live_active:
        this.#live !== null || this.#external || this.#starting === true,
    });
    this.#replyMode = change.reply_mode;
    try {
      this.#options.replyMode?.set(change.reply_mode);
    } catch {
      this.#options.log('voice_reply_mode_save_failed');
    }
    if (change.close_live !== null) {
      // 「続ける」の途中（同意・リース・接続を待っている）は、待っている手順を捨てる。
      if (this.#starting) {
        this.#options.cancelConsent?.();
        this.#flow += 1;
        this.#starting = false;
        this.#lease.stop();
      }
      if (this.#live !== null || this.#external)
        this.#closeSession(change.close_live.reason);
    }
    this.#emit();
  }

  // 会話の操作（照合表の効果。画面のボタン・文字の応答の session_control・Live の発話から同じ処理を通る）。
  // どの操作も別々の効果で、同じ終了処理に束ねない（X58）。処理の取り消し（cancel_workflow）はここにない別の命令。
  applyControl(action: SessionControlAction): void {
    const effect = SESSION_CONTROL_EFFECTS[action];
    if (effect.extends_silence_ms !== null)
      this.#options.onSilenceExtension?.(effect.extends_silence_ms);
    if (effect.sets_output_mode_text) this.setReplyMode('text');
    else if (effect.audio_action === 'stop_playback')
      this.stopPlayback('user_stop');
    else if (effect.audio_reason !== null)
      this.closeConversation(effect.audio_reason);
  }

  // 文字の応答の session_control（LLM を呼ばずに照合表で決めた値）を、画面のボタンと同じ処理で行う。
  applyTurnControl(action: SessionControlAction): void {
    if (!this.#options.enabled) return;
    this.applyControl(action);
  }

  // 中枢の音声イベント（WSS の {type:'voice'}）。形と宛先・世代を確かめてから使う。使えない値は捨てる（止める側の
  // 命令だけを受け、開く・続けるは受けない）。本文・文字起こしは載っていない。
  onCoreVoiceEvent(raw: unknown): void {
    if (!this.#options.enabled) return;
    if (!this.#options.contract.valid('VoiceEvent', raw)) {
      this.#options.log('voice_event_invalid');
      return;
    }
    const event = raw as {
      readonly event_type: string;
      readonly device_id: string;
      readonly live_session_id: string | null;
      readonly audio_epoch: string | null;
      readonly silence_extension_ms?: number;
      readonly audio_control: {
        readonly action: string;
        readonly reason: AudioReason;
        readonly audio_epoch: string | null;
        readonly issued_by: string;
      } | null;
    };
    // 自分の端末宛ての、今の接続（世代が同じ）のイベントだけ。古い世代・別の接続のイベントで止めも延ばしもしない。
    if (event.device_id !== this.#options.core.context()?.deviceId) {
      this.#options.log('voice_event_other_device');
      return;
    }
    if (
      this.#live === null ||
      event.live_session_id !== this.#live.liveSessionId ||
      this.#audio === null ||
      event.audio_epoch === null ||
      classifyEpoch(event.audio_epoch, this.#audio) !== 'current'
    ) {
      this.#options.log('voice_event_stale');
      return;
    }
    if (event.event_type === 'silence_extension') {
      if (event.silence_extension_ms !== undefined)
        this.#options.onSilenceExtension?.(event.silence_extension_ms);
      return;
    }
    const control = event.audio_control;
    if (event.event_type !== 'audio_control' || control === null) return;
    if (control.issued_by !== 'core') return;
    if (control.action === 'stop_playback') this.stopPlayback('user_stop');
    else if (control.action === 'close_voice_session') {
      // 返し方を文字へ切り替える操作（「文字で返して」）は、この端末の設定も文字にする（次の呼びかけも文字で返す）。
      if (control.reason === 'output_mode_text') this.setReplyMode('text');
      else this.closeConversation(control.reason);
    }
  }

  // 画面のボタン（desktop.voice_control）。読み上げの停止・会話の終了・返し方の切り替え。
  #controlFromButton(payload: unknown): 'ok' | DesktopIpcRejectReason {
    if (!this.#options.enabled) return 'voice_unavailable';
    const action =
      typeof payload === 'object' && payload !== null
        ? (payload as { action?: unknown }).action
        : undefined;
    switch (action) {
      case 'stop_playback':
        this.applyControl('stop_playback');
        return 'ok';
      case 'end_conversation':
        this.applyControl('end_conversation');
        return 'ok';
      case 'reply_in_text':
        this.applyControl('reply_in_text');
        return 'ok';
      case 'reply_in_voice':
        this.setReplyMode('voice');
        return 'ok';
      default:
        return 'invalid_request';
    }
  }

  // 再生だけを止める（読み上げの停止・割り込み）。収音・Live は保つ。
  stopPlayback(reason: 'user_stop' | 'barge_in'): void {
    if (!this.#alive || !this.#ready || !permitted(this.#device)) return;
    this.#output = advanceEpoch(this.#output);
    this.#retain();
    this.#send('voice.stop_playback', reason, {
      reason,
      scope: null,
      io_epoch: this.#device.ioEpoch,
      audio_epoch: this.#audio,
      output_epoch: this.#output,
    });
    this.#emit();
  }

  // 効果音（質問 99。定型句は使わない）。入出力の停止中は鳴らさない。
  play(
    clip:
      'wake_detected' | 'listening_started' | 'still_connecting' | 'refused',
  ): void {
    if (!this.#alive || !this.#ready || !permitted(this.#device)) return;
    this.#send('voice.play', null, {
      clip_id: clip,
      io_epoch: this.#device.ioEpoch,
      output_epoch: this.#output,
    });
  }

  // ---- 表示 -----------------------------------------------------------------------------------------------

  // 状態欄の音声の状態（停止していないときの値。停止中の値は状態欄が端末の状態から決める）。
  statusVoice(): StatusBarVoice['state'] {
    if (!this.#options.enabled || !this.#alive || !this.#ready) return null;
    if (this.#live !== null || this.#external)
      return this.#live?.purpose === 'notification'
        ? 'reading_aloud'
        : 'conversation_live';
    return 'waiting_wake_word';
  }

  view(): DesktopVoiceView {
    if (this.#device.lockState !== 'unlocked') return { visibility: 'hidden' };
    const consent = this.#options.consent.status;
    const voiceState: VoiceState | null = !this.#options.enabled
      ? null
      : this.#device.stopScope === 'local'
        ? 'device_stopped'
        : this.#device.stopScope !== 'none'
          ? 'global_stopped'
          : this.statusVoice();
    // 文字で返す設定では、声の会話を始める「続ける」を押せない（音声を外へ送らない）。
    if (
      voiceState === 'waiting_wake_word' &&
      !this.#external &&
      !this.#starting &&
      this.#replyMode === 'voice'
    )
      return {
        visibility: 'shown',
        voice_state: 'waiting_wake_word',
        external_send: false,
        consent,
        can_continue: true,
        notice: this.#currentNotice(),
        reply_mode: this.#replyMode,
      };
    return {
      visibility: 'shown',
      voice_state: voiceState,
      external_send: this.#external,
      consent,
      can_continue: false,
      notice: this.#currentNotice(),
      reply_mode: this.#replyMode,
    };
  }

  // ---- 内部 -----------------------------------------------------------------------------------------------

  // 同意の取り消しを保存できなかったことを最優先で知らせる（次の起動で同意が戻るおそれがある）。
  #currentNotice():
    'input_interrupted' | 'not_started' | 'consent_not_saved' | null {
    return this.#options.consent.revokeUnsaved
      ? 'consent_not_saved'
      : this.#notice;
  }

  #current(): VoiceCurrentState {
    const base = {
      io_epoch: this.#device.ioEpoch,
      audio_epoch: this.#audio,
      output_epoch: this.#output,
      io_suspended: !permitted(this.#device),
    };
    return this.#session === null
      ? base
      : { ...base, session_epoch: this.#session };
  }

  #create(): void {
    this.#generation += 1;
    this.#alive = true;
    this.#ready = false;
    this.#suspendedIo = null;
    this.#options.renderer.create(this.#generation);
  }

  // 強制終了。送信中の音声も止まる（プロセスがなくなる）。待っている要求と会話を捨てる。
  #kill(cause: string): void {
    if (!this.#alive) return;
    this.#options.log(`voice_renderer_killed:${cause}`);
    // 先に「生きていない」にする（窓を壊すと閉じた出来事がその場で届くので、二重に扱わない）。
    this.#alive = false;
    this.#ready = false;
    this.#options.renderer.kill(this.#generation);
    this.#external = false;
    for (const entry of this.#pending.values()) entry.cancel();
    this.#pending.clear();
    if (this.#live !== null) {
      this.#closeLive(
        this.#live.liveSessionId,
        this.#nextStopReason ?? 'device_io_stop',
      );
      this.#live = null;
    }
    if (this.#starting) this.#options.cancelConsent?.();
    this.#flow += 1;
    this.#starting = false;
    this.#lease.stop();
  }

  // この端末の入出力を止める（全部止める）。既に止まっていれば何もしない。
  #stopDevice(reason: AudioReason): void {
    if (!permitted(this.#device)) return;
    this.#nextStopReason = reason;
    this.#options.stopDevice();
    this.#nextStopReason = null;
  }

  // 中枢へ閉じる要求を送る（第 3 層）。送れなくても（例外でも）記録して、この端末の停止を続ける
  // （Issue #162 の P2: 停止が黙って失われないようにする）。
  #closeLive(liveSessionId: string, reason: AudioReason): void {
    try {
      this.#options.core.closeLive(liveSessionId, reason);
    } catch {
      this.#options.log('voice_core_close_failed');
    }
  }

  #suspend(reason: AudioReason, scope: 'local' | 'guest' | 'global'): void {
    this.#output = advanceEpoch(this.#output);
    this.#suspendedIo = this.#device.ioEpoch;
    this.#retain();
    this.#send('voice.suspend_io', reason, {
      reason,
      scope,
      io_epoch: this.#device.ioEpoch,
      audio_epoch: this.#audio,
      output_epoch: this.#output,
    });
  }

  #closeSession(reason: AudioReason): void {
    this.#lease.stop();
    if (this.#live !== null) {
      this.#closeLive(this.#live.liveSessionId, reason);
      this.#live = null;
    }
    if (!this.#alive || this.#audio === null) {
      this.#external = false;
      return;
    }
    if (!this.#ready) {
      this.#kill('not_ready_at_close');
      return;
    }
    this.#output = advanceEpoch(this.#output);
    this.#retain();
    this.#send('voice.close_voice_session', reason, {
      reason,
      scope: null,
      io_epoch: this.#device.ioEpoch,
      audio_epoch: this.#audio,
      output_epoch: this.#output,
    });
  }

  #notStarted(): 'voice_unavailable' {
    this.#notice = 'not_started';
    this.play('refused');
    return 'voice_unavailable';
  }

  #leaseLost(): void {
    // 「続ける」の途中（Live の接続を待っている）でリースを失った: 始めない（待っている手順を捨てる。PR #160 のレビュー P1）。
    if (this.#starting) {
      this.#options.cancelConsent?.();
      this.#flow += 1;
      this.#starting = false;
      this.#emit();
      return;
    }
    // 会話中にリースを失った: 中枢のリースの喪失として、この端末の入出力を止める（07 §5）。
    if (this.#live === null && !this.#external) return;
    this.#stopDevice('core_lease_lost');
  }

  // 世代が合わなくなった要求・止まっている間の音を出す命令を、待ちから外す（ACK が後から届いても使わない）。
  #retain(): void {
    const keep = new Set(
      retainPendingVoiceRequests(
        [...this.#pending.values()].map((entry) => entry.request),
        this.#current(),
      ).map((request) => request.request_id),
    );
    for (const [id, entry] of this.#pending)
      if (!keep.has(id)) {
        entry.cancel();
        this.#pending.delete(id);
      }
  }

  #send(
    channel: VoiceIpcChannel,
    reason: AudioReason | null,
    payload: Record<string, unknown>,
  ): boolean {
    const request = {
      channel,
      request_id: this.#options.clock.newId(),
      ack_timeout_ms: VOICE_IPC_TIMEOUTS[channel].maxAckTimeoutMs,
      payload,
    } as VoiceRendererRequest;
    if (
      !this.#options.contract.valid('VoiceRendererRequest', request) ||
      voiceRequestErrors(request).length > 0
    ) {
      this.#options.log(`voice_request_invalid:${channel}`);
      // 停止の命令を作れないなら、強制終了で止める（止める側へ倒す）。
      if (isStopChannel(channel))
        this.#fallback(channel, 'force_kill_renderer');
      return false;
    }
    const generation = this.#generation;
    const entry: PendingVoiceRequest = {
      request,
      generation,
      sentAtMono: this.#options.clock.mono(),
      reason,
      cancel: () => undefined,
      observedAtMono: null,
    };
    this.#pending.set(request.request_id, entry);
    this.#armDeadline(entry);
    let sent: boolean;
    try {
      sent = this.#options.renderer.send(generation, request);
    } catch {
      sent = false;
    }
    if (!sent) {
      this.#options.log(`voice_send_failed:${channel}`);
      // 送れない（窓が壊れた）: ACK は来ないので、期限を待たずに ACK がないときの動作へ進む。
      entry.cancel();
      this.#pending.delete(request.request_id);
      this.#fallback(channel, VOICE_IPC_TIMEOUTS[channel].onTimeout);
    }
    return sent;
  }

  // ACK の期限。期限ちょうどは間に合い、1 ms 過ぎたら ACK がないときの動作（assessStop の境界と同じ）。
  #armDeadline(entry: PendingVoiceRequest, delayMs?: number): void {
    const wait = delayMs ?? entry.request.ack_timeout_ms + 1;
    entry.cancel = this.#options.clock.setTimer(wait, () =>
      this.#deadline(entry),
    );
  }

  #deadline(entry: PendingVoiceRequest): void {
    const id = entry.request.request_id;
    if (this.#pending.get(id) !== entry) return;
    const channel = entry.request.channel;
    if (isStopChannel(channel)) {
      const now = this.#options.clock.mono();
      const assessment = assessStop({
        reason: entry.reason as AudioReason,
        requested_at_mono_ms: entry.sentAtMono,
        local_stop_completed_at_mono_ms: null,
        ack_at_mono_ms: null,
        ack_accepted: null,
        ack_outcome: null,
        ack_timeout_ms: entry.request.ack_timeout_ms,
        now_mono_ms: now,
        previous_observed_mono_ms: entry.observedAtMono,
      });
      entry.observedAtMono = now;
      if (assessment.layer2.status === 'waiting') {
        // タイマーが早く来た: 残りを待つ。
        this.#armDeadline(
          entry,
          Math.max(
            1,
            entry.sentAtMono + assessment.layer2.deadline_ms + 1 - now,
          ),
        );
        return;
      }
      this.#pending.delete(id);
      this.#fallback(channel, assessment.fallback);
    } else {
      this.#pending.delete(id);
      this.#fallback(channel, VOICE_IPC_TIMEOUTS[channel].onTimeout);
    }
    this.#emit();
  }

  #stopApplied(channel: StopChannel): void {
    if (channel === 'voice.stop_playback') return;
    // Live を閉じた・入出力を止めたと音声レンダラーが報告した（この ACK は、閉じる・止める命令より前に出した開始の命令の
    // 後で適用されている。外部へ送っている間は新しい開始を出さないので、これで送っていない）。
    this.#external = false;
  }

  #fallback(channel: VoiceIpcChannel, action: string | null): void {
    switch (action) {
      case 'force_kill_renderer':
        this.#options.log(`voice_ack_missing:${channel}`);
        this.#kill(`ack_missing:${channel}`);
        // ACK が返らないときは、全部止める（この端末の入出力も止め、画面で明示再開するまで再開しない）。
        this.#stopDevice('device_io_stop');
        return;
      case 'escalate_suspend_io':
        // 再生停止の ACK がない: 安全側に全停止し、入力の中断を知らせる（10 §1）。理由は device_io_stop（ADR 0041）。
        this.#options.log(`voice_ack_missing:${channel}`);
        this.#notice = 'input_interrupted';
        this.#stopDevice('device_io_stop');
        return;
      case 'close_session':
        this.#options.log(`voice_ack_missing:${channel}`);
        this.#closeSession('provider_failure');
        return;
      default:
        return;
    }
  }

  #emit(): void {
    const signature = JSON.stringify([this.view(), this.statusVoice()]);
    if (signature === this.#lastSignature) return;
    this.#lastSignature = signature;
    this.#options.onChange();
  }

  #ok(
    requestId: string,
    channel:
      | 'desktop.get_voice'
      | 'desktop.voice_continue'
      | 'desktop.voice_consent_revoke'
      | 'desktop.voice_control',
  ): DesktopIpcResponse {
    return this.#respond({
      request_id: requestId,
      channel,
      outcome: 'ok',
      voice: this.view(),
    });
  }

  #reject(
    requestId: string,
    channel: DesktopIpcChannel,
    reason: DesktopIpcRejectReason,
  ): DesktopIpcResponse {
    return this.#respond({
      request_id: requestId,
      channel,
      outcome: 'rejected',
      reason,
    });
  }

  #respond(response: DesktopIpcResponse): DesktopIpcResponse {
    const errors = this.#options.contract.responseErrors(response);
    if (errors.length > 0)
      throw new Error(`desktop_contract_violation:${errors.join(',')}`);
    return response;
  }
}
