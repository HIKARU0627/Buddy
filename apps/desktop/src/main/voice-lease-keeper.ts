// 音声リースの heartbeat（設計 07 §5、10 §2・§2A、B05-06、ADR 0050）。Electron に依存しない（node:test で試験する）。
// - 会話を始める前に新しい lease_id で最初の更新を送り、受け付けられたら 2 秒ごとに更新する（heartbeat 2 秒・ttl 6 秒）。
// - 期限は要求を送った時点の単調時計から数え、遅れて届いた応答の受信時刻から足し直さない（domain の acceptLeaseRenewal）。
// - 待っている更新は 1 つだけ。応答の要求 ID・リース ID・nonce が一致し、中枢の起動 ID・接続範囲・入出力の世代が
//   送った時点と同じで、入出力が止まっていないときだけ受け取る。
// - 中枢が拒否した・時計が信用できない・期限が来た（更新が届かない）ときは、リースを失ったとして知らせる
//   （main は suspend_io の core_lease_lost で止める）。結果が分からない応答では延ばさず、期限まで待つ。
import {
  acceptLeaseRenewal,
  observeLease,
  type ClockReading,
  type HeldLease,
  type LeaseRenewalResponseLike,
  type LeaseSendRecord,
} from '@buddy/domain';

// 設計 10 §2 の heartbeat（2 秒）と、07 §5 の期限（6 秒）。設計初期値で合格値ではない。
export const LEASE_HEARTBEAT_MS = 2000;
export const LEASE_TTL_MS = 6000;

// リースの更新の本文（契約の LeaseRenewalRequest）。
export interface LeaseRenewalBody {
  readonly request_id: string;
  readonly lease_id: string;
  readonly kind: 'audio';
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

// 中枢の接続の事実（端末 ID・中枢の起動 ID・接続範囲）。接続していなければ null。
export interface LeaseCoreContext {
  readonly deviceId: string;
  readonly coreInstanceId: string;
  readonly commandScopeId: string;
}

export interface LeasePort {
  readonly context: () => LeaseCoreContext | null;
  // 更新を送る。応答（形を検査した LeaseRenewalResponse）か、結果が分からないときは null。
  readonly renew: (
    body: LeaseRenewalBody,
  ) => Promise<LeaseRenewalResponseLike | null>;
}

export interface LeaseClock {
  // 単調時計（整数の ms）と壁時計（UTC の ms）。
  readonly mono: () => number;
  readonly wall: () => number;
  readonly setTimer: (ms: number, run: () => void) => () => void;
  readonly newId: () => string;
}

export type LeaseLostReason =
  'renewal_rejected' | 'expired' | 'clock_unusable' | 'not_connected';

export interface LeaseKeeperOptions {
  readonly port: LeasePort;
  readonly clock: LeaseClock;
  // 端末の今の入出力の世代と、止まっているか。
  readonly ioState: () => {
    readonly ioEpoch: string;
    readonly suspended: boolean;
  };
  readonly onLost: (reason: LeaseLostReason) => void;
  readonly log?: (code: string) => void;
}

export class VoiceLeaseKeeper {
  readonly #options: LeaseKeeperOptions;
  // 始めた回数。止めた後に届いた応答・タイマーは使わない。
  #generation = 0;
  #active = false;
  // 最初の更新が受け付けられた（会話の途中）。最初の更新の前の拒否は「始められない」で、失ったとは知らせない。
  #established = false;
  #leaseId: string | null = null;
  #previousNonce: string | null = null;
  #held: HeldLease | null = null;
  #pending: LeaseSendRecord | null = null;
  #context: LeaseCoreContext | null = null;
  #heartbeat: (() => void) | null = null;
  #watchdog: (() => void) | null = null;

  constructor(options: LeaseKeeperOptions) {
    this.#options = options;
  }

  get active(): boolean {
    return this.#active;
  }

  get held(): HeldLease | null {
    return this.#held;
  }

  get leaseId(): string | null {
    return this.#leaseId;
  }

  // 新しい lease_id で最初の更新を送る。受け付けられたら true（以後 2 秒ごとに更新する）。
  async start(): Promise<boolean> {
    this.stop();
    const context = this.#options.port.context();
    if (context === null) return false;
    this.#generation += 1;
    const generation = this.#generation;
    this.#active = true;
    this.#context = context;
    this.#leaseId = this.#options.clock.newId();
    this.#previousNonce = null;
    const ok = await this.#renew(generation);
    if (generation !== this.#generation) return false;
    if (!ok || this.#held === null) {
      this.stop();
      return false;
    }
    this.#established = true;
    this.#arm(generation);
    return true;
  }

  // 更新をやめる（会話の終わり・停止）。待っている更新の応答は、届いても使わない。
  stop(): void {
    this.#generation += 1;
    this.#active = false;
    this.#established = false;
    this.#held = null;
    this.#pending = null;
    this.#leaseId = null;
    this.#previousNonce = null;
    this.#context = null;
    this.#heartbeat?.();
    this.#heartbeat = null;
    this.#watchdog?.();
    this.#watchdog = null;
  }

  #reading(): ClockReading {
    return {
      mono_ms: this.#options.clock.mono(),
      wall_ms: this.#options.clock.wall(),
    };
  }

  #lost(reason: LeaseLostReason): void {
    if (!this.#active) return;
    const established = this.#established;
    this.stop();
    this.#options.log?.(`voice_lease_lost:${reason}`);
    if (established) this.#options.onLost(reason);
  }

  // 次の更新と、期限の見張りを予約する。
  #arm(generation: number): void {
    const { setTimer } = this.#options.clock;
    this.#heartbeat?.();
    this.#heartbeat = setTimer(LEASE_HEARTBEAT_MS, () => {
      this.#heartbeat = null;
      if (generation !== this.#generation) return;
      // 期限を見てから送る（届かない間に切れていれば送らずに失う）。
      if (!this.#observe()) return;
      if (this.#pending === null) void this.#renew(generation);
      this.#arm(generation);
    });
    this.#armWatchdog(generation);
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

  // 今のリースが有効か。失効・時計の不整合なら失ったとして知らせ、false。
  #observe(): boolean {
    const observation = observeLease(this.#held, this.#reading());
    if (observation.status.status === 'valid') {
      this.#held = observation.held;
      return true;
    }
    this.#lost(
      observation.status.status === 'expired' ? 'expired' : 'clock_unusable',
    );
    return false;
  }

  async #renew(generation: number): Promise<boolean> {
    const context = this.#context;
    const leaseId = this.#leaseId;
    if (context === null || leaseId === null) return false;
    const io = this.#options.ioState();
    if (io.suspended) {
      this.#lost('not_connected');
      return false;
    }
    const sent = this.#reading();
    const nonce = this.#options.clock.newId();
    const body: LeaseRenewalBody = {
      request_id: this.#options.clock.newId(),
      lease_id: leaseId,
      kind: 'audio',
      device_id: context.deviceId,
      core_instance_id: context.coreInstanceId,
      command_scope_id: context.commandScopeId,
      io_epoch: io.ioEpoch,
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
      io_epoch: io.ioEpoch,
      requested_at_mono_ms: sent.mono_ms,
      requested_at_wall_ms: sent.wall_ms,
      heartbeat_ms: LEASE_HEARTBEAT_MS,
    };
    this.#pending = pending;
    let response: LeaseRenewalResponseLike | null;
    try {
      response = await this.#options.port.renew(body);
    } catch {
      response = null;
    }
    if (generation !== this.#generation || this.#pending !== pending)
      return false;
    this.#pending = null;
    // 結果が分からない: 延ばさない（期限の見張りが止める）。
    if (response === null) {
      this.#options.log?.('voice_lease_renew_unknown');
      return false;
    }
    if (response.result === 'rejected') {
      // 自分の要求への拒否だけを拒否として扱う（違う要求の応答は使わない）。
      if (
        response.request_id === pending.request_id &&
        response.lease_id === pending.lease_id &&
        response.nonce === pending.nonce
      )
        this.#lost('renewal_rejected');
      return false;
    }
    const now = this.#reading();
    const latest = this.#options.port.context();
    const ioNow = this.#options.ioState();
    const outcome = acceptLeaseRenewal(
      pending,
      response,
      now,
      {
        core_instance_id: latest?.coreInstanceId ?? '',
        command_scope_id: latest?.commandScopeId ?? '',
        io_epoch: ioNow.ioEpoch,
        io_suspended: ioNow.suspended,
      },
      this.#held,
    );
    if (outcome.held === null) {
      this.#options.log?.(
        `voice_lease_renew_ignored:${outcome.reasons.join('+')}`,
      );
      // 時計が信用できなければ、今のリースも捨てる（延命しない）。
      if (outcome.clock !== 'consistent') this.#lost('clock_unusable');
      return false;
    }
    this.#held = outcome.held;
    this.#previousNonce = nonce;
    this.#armWatchdog(generation);
    return true;
  }
}
