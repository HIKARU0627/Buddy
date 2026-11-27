// 表示のリースの保持（UI-05 の段階 4、ADR 0188。設計 07 §5、ADR 0032・0068）。Electron に依存しない（node:test で試験する）。
// 音声のリース（voice-lease-keeper.ts、ADR 0050）と同じ型と同じ domain の規則（acceptLeaseRenewal・observeLease）を使う。
// - キャンバスの窓が見えている間だけ（キャンバス表示・窓が隠れていない・ロック解除済み・入出力が止まっていない・中枢に接続中。
//   条件は呼び出し側が wanted で渡す）、POST /v1/leases/renew の display を新しい lease_id で取り、期限より前に更新する
//   （heartbeat 2 秒・ttl 6 秒。音声と同じ設計初期値で合格値ではない。U471）。
// - 条件を外れたら更新をやめる（idle）。リースを返す経路は契約にないので、中枢では ttl で切れる（U472）。これは「失った」ではない。
// - 更新の拒否・期限切れ・時計の不整合・最初の取得の結果が分からないときは「失った」（lost）にする。条件が揃っている間は、
//   間隔を延ばしながら新しい lease_id で取り直し（2・4・8・16・30 秒、以後 30 秒）、取れたら held に戻る。
// - 同じリースの更新の数の上限（lease_rotation_required）と nonce の食い違い（結果の分からない更新の後）での拒否は、今のリースを
//   保ったまま新しい lease_id で 1 回だけ取り直す（描画を止めない）。取り直しも拒否されたら失う。
// - 期限は要求を送った時点の単調時計から数え、応答の受信時刻から足し直さない。待っている更新は 1 つだけで、応答の要求 ID・
//   リース ID・nonce と、中枢の起動 ID・接続範囲・中枢の入出力の世代が送った時点と同じときだけ受け取る。
import {
  acceptLeaseRenewal,
  observeLease,
  type ClockReading,
  type HeldLease,
  type LeaseRenewalResponseLike,
  type LeaseSendRecord,
} from '@buddy/domain';
import {
  LEASE_HEARTBEAT_MS,
  LEASE_TTL_MS,
  type LeaseClock,
  type LeaseCoreContext,
  type LeaseRenewalBody,
} from './voice-lease-keeper.js';

// idle: 取りに行かない（条件が揃っていない）。acquiring: 最初の取得を待っている。held: 持っている。lost: 失って取り直している。
export type DisplayLeaseState = 'idle' | 'acquiring' | 'held' | 'lost';

export type DisplayLeaseLostReason =
  'renewal_rejected' | 'expired' | 'clock_unusable' | 'outcome_unknown';

// 取り直しの間隔（失った回数ごと。最後の値をくり返す）。原本に決めなし（U471）。
export const DISPLAY_LEASE_RETRY_MS: readonly number[] = [
  2000, 4000, 8000, 16000, 30000,
];

// 今のリースを保ったまま新しい lease_id で取り直す拒否の理由（中枢の権限を失ったのではなく、更新の数・nonce の食い違い）。
const ROTATE_REASONS: ReadonlySet<string> = new Set([
  'lease_rotation_required',
  'nonce_replayed',
  'nonce_reused',
  'unexpected_previous_nonce',
]);

export interface DisplayLeaseContext extends LeaseCoreContext {
  // 中枢が持つこの端末の入出力の世代（bootstrap の io_state.io_epoch。端末の io_epoch とは別。U70・U470）。
  readonly ioEpoch: string;
}

// 契約の LeaseRenewalResponse（形を検査したもの）。拒否の理由を見る。
export type DisplayLeaseResponse = LeaseRenewalResponseLike & {
  readonly reasons: readonly string[];
};

export interface DisplayLeasePort {
  // 取る条件が揃っていれば中枢の事実、揃っていなければ null。
  readonly wanted: () => DisplayLeaseContext | null;
  // 更新を送る。応答（形を検査したもの）か、結果が分からない・送れなかったときは null。
  readonly renew: (
    body: LeaseRenewalBody,
  ) => Promise<DisplayLeaseResponse | null>;
}

export interface DisplayLeaseKeeperOptions {
  readonly port: DisplayLeasePort;
  readonly clock: LeaseClock;
  // 状態が変わったときだけ呼ぶ。
  readonly onChange: (state: DisplayLeaseState) => void;
  readonly log?: (code: string) => void;
}

const sameContext = (a: DisplayLeaseContext, b: DisplayLeaseContext) =>
  a.deviceId === b.deviceId &&
  a.coreInstanceId === b.coreInstanceId &&
  a.commandScopeId === b.commandScopeId &&
  a.ioEpoch === b.ioEpoch;

export class DisplayLeaseKeeper {
  readonly #options: DisplayLeaseKeeperOptions;
  #state: DisplayLeaseState = 'idle';
  // 止めた・失った・取り直した回数。またいだ応答・タイマーは使わない。
  #generation = 0;
  #context: DisplayLeaseContext | null = null;
  #leaseId: string | null = null;
  #previousNonce: string | null = null;
  #held: HeldLease | null = null;
  #pending: LeaseSendRecord | null = null;
  // 今のリースを保ったまま取り直している途中（1 回だけ）。
  #rotating = false;
  // 続けて失った回数（取り直しの間隔に使う）。取れたら 0。
  #failures = 0;
  #heartbeat: (() => void) | null = null;
  #watchdog: (() => void) | null = null;
  #retry: (() => void) | null = null;
  // 取り直しの要求の途中で retryNow が呼ばれた印。その要求が拒否されたら、間隔を待たずにもう一度取る。
  #retryRequested = false;

  constructor(options: DisplayLeaseKeeperOptions) {
    this.#options = options;
  }

  get state(): DisplayLeaseState {
    return this.#state;
  }

  get held(): HeldLease | null {
    return this.#held;
  }

  get leaseId(): string | null {
    return this.#leaseId;
  }

  // 条件を見直す（窓・ロック・停止・接続の変化のたびに呼ぶ。何度呼んでもよい）。
  update(): void {
    const context = this.#options.port.wanted();
    if (context === null) {
      this.#halt();
      return;
    }
    if (this.#context !== null && sameContext(this.#context, context)) return;
    // 初めて、または中枢の起動・接続範囲・世代が変わった: 前のリースは使えないので捨て、新しく取る。失っていた間は、取れるまで
    // 失ったまま（理由の表示を続ける）。
    this.#clear();
    this.#context = context;
    this.#failures = 0;
    if (this.#state !== 'lost') this.#set('acquiring');
    void this.#acquire(this.#generation);
  }

  // 失っている間、取り直しの間隔を待たずにすぐ取り直す（本人が「このPCに出す」で表示先をこの端末へ移したとき。ADR 0193）。
  // 失っていないとき・取り直しの途中のときは何もしない。条件が外れていれば止める。
  retryNow(): void {
    if (this.#state !== 'lost') return;
    // 移動を受け付けたので、続けて失った回数は数え直す。
    this.#failures = 0;
    if (this.#retry === null) {
      // 取り直しの要求の途中（答えを待っている）。その要求が拒否されたら待たずにもう一度取る。
      this.#retryRequested = true;
      return;
    }
    const context = this.#options.port.wanted();
    if (context === null) {
      this.#halt();
      return;
    }
    this.#retry();
    this.#retry = null;
    this.#context = context;
    void this.#acquire(this.#generation);
  }

  // 更新をやめる（終了）。
  stop(): void {
    this.#halt();
  }

  #set(state: DisplayLeaseState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onChange(state);
  }

  // タイマー・待っている更新・持っているリースを捨て、世代を進める。
  #clear(): void {
    this.#generation += 1;
    this.#held = null;
    this.#pending = null;
    this.#leaseId = null;
    this.#previousNonce = null;
    this.#rotating = false;
    this.#heartbeat?.();
    this.#heartbeat = null;
    this.#watchdog?.();
    this.#watchdog = null;
    this.#retry?.();
    this.#retry = null;
  }

  #halt(): void {
    this.#retryRequested = false;
    this.#clear();
    this.#context = null;
    this.#failures = 0;
    this.#set('idle');
  }

  #reading(): ClockReading {
    return {
      mono_ms: this.#options.clock.mono(),
      wall_ms: this.#options.clock.wall(),
    };
  }

  // 失った: 描画をやめる印を出し、条件が揃っている間は間隔を置いて新しい lease_id で取り直す。
  #lose(reason: DisplayLeaseLostReason): void {
    if (this.#state === 'idle') return;
    this.#clear();
    this.#options.log?.(`display_lease_lost:${reason}`);
    // 取り直しの途中で retryNow が呼ばれていたら、間隔を待たずにもう一度取る（1 回だけ）。
    const again = this.#retryRequested;
    this.#retryRequested = false;
    const delay = again
      ? 0
      : (DISPLAY_LEASE_RETRY_MS[
          Math.min(this.#failures, DISPLAY_LEASE_RETRY_MS.length - 1)
        ] ?? 30000);
    if (!again) this.#failures += 1;
    this.#set('lost');
    const generation = this.#generation;
    this.#retry = this.#options.clock.setTimer(delay, () => {
      this.#retry = null;
      if (generation !== this.#generation) return;
      const context = this.#options.port.wanted();
      if (context === null) {
        this.#halt();
        return;
      }
      this.#context = context;
      void this.#acquire(generation);
    });
  }

  #acquire(generation: number): Promise<void> {
    this.#leaseId = this.#options.clock.newId();
    this.#previousNonce = null;
    return this.#send(generation);
  }

  // 次の更新を予約する（期限を見てから送る。届かない間に切れていれば送らずに失う）。
  #armHeartbeat(generation: number): void {
    this.#heartbeat?.();
    this.#heartbeat = this.#options.clock.setTimer(LEASE_HEARTBEAT_MS, () => {
      this.#heartbeat = null;
      if (generation !== this.#generation) return;
      if (!this.#observe()) return;
      if (this.#pending === null) void this.#send(generation);
      this.#armHeartbeat(generation);
    });
  }

  #armWatchdog(generation: number): void {
    this.#watchdog?.();
    this.#watchdog = null;
    const held = this.#held;
    if (held === null) return;
    const remaining = held.expires_at_mono_ms - this.#options.clock.mono();
    this.#watchdog = this.#options.clock.setTimer(
      Math.max(0, remaining),
      () => {
        this.#watchdog = null;
        if (generation !== this.#generation) return;
        if (this.#observe()) this.#armWatchdog(generation);
      },
    );
  }

  // 今のリースが有効か。失効・時計の不整合なら失い、false。
  #observe(): boolean {
    const observation = observeLease(this.#held, this.#reading());
    if (observation.status.status === 'valid') {
      this.#held = observation.held;
      return true;
    }
    this.#lose(
      observation.status.status === 'expired' ? 'expired' : 'clock_unusable',
    );
    return false;
  }

  async #send(generation: number): Promise<void> {
    const context = this.#context;
    const leaseId = this.#leaseId;
    if (context === null || leaseId === null) return;
    const sent = this.#reading();
    const nonce = this.#options.clock.newId();
    const body: LeaseRenewalBody = {
      request_id: this.#options.clock.newId(),
      lease_id: leaseId,
      kind: 'display',
      device_id: context.deviceId,
      core_instance_id: context.coreInstanceId,
      command_scope_id: context.commandScopeId,
      io_epoch: context.ioEpoch,
      nonce,
      previous_nonce: this.#previousNonce,
      requested_at_mono_ms: sent.mono_ms,
      heartbeat_ms: LEASE_HEARTBEAT_MS,
      ttl_ms: LEASE_TTL_MS,
    };
    const pending: LeaseSendRecord = {
      request_id: body.request_id,
      lease_id: leaseId,
      nonce,
      core_instance_id: context.coreInstanceId,
      command_scope_id: context.commandScopeId,
      io_epoch: context.ioEpoch,
      requested_at_mono_ms: sent.mono_ms,
      requested_at_wall_ms: sent.wall_ms,
      heartbeat_ms: LEASE_HEARTBEAT_MS,
    };
    this.#pending = pending;
    let response: DisplayLeaseResponse | null;
    try {
      response = await this.#options.port.renew(body);
    } catch {
      response = null;
    }
    if (generation !== this.#generation || this.#pending !== pending) return;
    this.#pending = null;
    if (response === null) {
      this.#options.log?.('display_lease_renew_unknown');
      // 持っているリースは期限の見張りが止める（延ばさない）。まだ持っていなければ取れなかった。
      if (this.#held === null) this.#lose('outcome_unknown');
      return;
    }
    if (response.result === 'rejected') {
      // 自分の要求への拒否だけを拒否として扱う（違う要求の応答は使わない）。
      if (
        response.request_id !== pending.request_id ||
        response.lease_id !== pending.lease_id ||
        response.nonce !== pending.nonce
      )
        return;
      if (
        !this.#rotating &&
        this.#held !== null &&
        response.reasons.length > 0 &&
        response.reasons.every((reason) => ROTATE_REASONS.has(reason))
      ) {
        this.#rotating = true;
        this.#options.log?.('display_lease_rotate');
        void this.#acquire(generation);
        return;
      }
      this.#lose('renewal_rejected');
      return;
    }
    const latest = this.#options.port.wanted();
    const outcome = acceptLeaseRenewal(
      pending,
      response,
      this.#reading(),
      {
        core_instance_id: latest?.coreInstanceId ?? '',
        command_scope_id: latest?.commandScopeId ?? '',
        io_epoch: latest?.ioEpoch ?? context.ioEpoch,
        io_suspended: latest === null,
      },
      this.#held,
    );
    if (outcome.held === null) {
      this.#options.log?.(
        `display_lease_renew_ignored:${outcome.reasons.join('+')}`,
      );
      // 時計が信用できなければ、今のリースも捨てる（延命しない）。まだ持っていなければ取れなかった。
      if (outcome.clock !== 'consistent') this.#lose('clock_unusable');
      else if (this.#held === null) this.#lose('outcome_unknown');
      return;
    }
    this.#held = outcome.held;
    this.#previousNonce = nonce;
    this.#rotating = false;
    this.#failures = 0;
    this.#retryRequested = false;
    this.#armWatchdog(generation);
    if (this.#heartbeat === null) this.#armHeartbeat(generation);
    this.#set('held');
  }
}
