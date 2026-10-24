// 中枢の音声の制御（B05-03、ADR 0046。設計 07 §5、10 §1・§1A・§2・§2A・§8）。
//
// 持つもの:
// - リース（音声・機密表示）。RAM だけで、中枢の再起動（起動 ID の変更）で全て無効になる（07 §4・§5）。更新の可否は domain の
//   leaseRenewalReasons、音声所有権の調停は arbitrateAudioClaim、返す期限は grantedLeaseTtlMs で決め、ここで判定を作り直さない。
// - 世代と停止の状態。DB（0008）が正本で、中枢の再起動で巻き戻さない。Live の世代は issueLiveEpochs で決めて DB に書く。
// - Live の制御接続（サイドバンド）。遷移は nextLiveControl だけで決め、DB へ compare-and-set で書く。ping 2 秒・期限 6 秒
//   （設計初期値）で lost にし、lost では音声リースを更新せず（leaseRenewalReasons の sideband_lost）、停止のイベントを送り、
//   閉じるためだけの再接続を 1 回・3 秒まで試して session.close を送る。終了と使用秒数を確認できなければ予約を保持する。
// - 停止（/v1/io/stop）。停止は版を求めず常に受け付け、中枢が io・output の世代を進め（ADR 0046・U70）、対象の端末の
//   リースを取り消し、開いている Live をサイドバンドから閉じ（planStop の第 3 層）、停止のイベントを送る。
// - 再開（/v1/io/resume）は画面操作と版の一致だけ。リースは戻さず、端末は新しいリースを取り直す（10 §1A）。
// provider（OpenAI の Live）と予算の門は注入する境界（LiveProvider・LiveBudgetPort）で、製品の起動ではまだ渡さない
// （実 API は使わない。渡されなければ Live の接続は 503）。結果不明の外部への送信を自動で送り直さない。

import { randomUUID } from 'node:crypto';
import {
  AUDIO_CONTROL_RULES,
  LIVE_INITIAL_RESERVE_SECONDS,
  SIDEBAND_CONNECT_DEADLINE_MS,
  admitLiveStart,
  arbitrateAudioClaim,
  grantedLeaseTtlMs,
  ioStopReach,
  issueLiveEpochs,
  leaseRenewalReasons,
  leaseRotationRequired,
  nextLiveControl,
  planStop,
  settleLiveSeconds,
} from '@buddy/domain';
import type {
  AudioReason,
  ConsentStatus,
  LiveControl,
  LiveControlTrigger,
  LiveEpochEvent,
  StoredLease,
} from '@buddy/domain';
import type {
  DbWorkerClient,
  DeviceRecord,
  DeviceVoiceState,
  LiveControlValues,
  LiveSessionRecord,
  VoiceStopScope,
} from '@buddy/storage';
import { apiErrorResponse } from './api-server.js';
import type { ApiErrorCode } from './api-server.js';
import type { DeclaredLockState } from './api-environment.js';
import type { JsonObject } from './strict-json.js';

// サイドバンドの ping の間隔と期限（ms）。設計初期値（10 §2A）。合格値ではない。
export const SIDEBAND_PING_INTERVAL_MS = 2000;
export const SIDEBAND_PING_DEADLINE_MS = 6000;
// 閉じるためだけのサイドバンドの再接続の上限（ms）。原本の値（10 §2A）。
export const SIDEBAND_CLOSE_RECONNECT_MS = 3000;
// session.close を送ってから session.closed を待つ上限（ms）。原本は「close から精算まで 2 秒以内」の目標まで。
// 待つ時間は原本に決めなし（仮置き。U72）。過ぎたら終了未確認として予約を保持する。
export const CORE_CLOSE_CONFIRM_MS = 2000;

type Status = { status: number; body: object };

export interface VoiceTimers {
  set(ms: number, fn: () => void): unknown;
  clear(handle: unknown): void;
}

export const REAL_VOICE_TIMERS: VoiceTimers = {
  set(ms, fn) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

// provider のサイドバンドの受け口。
export interface LiveSidebandHandlers {
  onPong(): void;
  // session.closed。使用秒数（usage.seconds）がなければ null。
  onSessionClosed(usageSeconds: number | null): void;
  // WebSocket の終了・エラー。
  onDisconnected(): void;
}

export interface LiveSideband {
  ping(): void;
  // session.close を送る。
  sendClose(): void;
  terminate(): void;
}

// OpenAI の Live（の模擬）。実 API の実装は B05 の後の作業。
export interface LiveProvider {
  // SDP offer を交換してセッションを作る。ok でない・例外は、送った可能性があるので結果不明として扱う（送り直さない）。
  createSession(input: {
    readonly live_session_id: string;
    readonly purpose: 'conversation' | 'notification';
    readonly sdp_offer: string;
  }): Promise<
    | {
        readonly ok: true;
        readonly provider_session_id: string;
        readonly sdp_answer: string;
      }
    | { readonly ok: false }
  >;
  // サイドバンドへ接続する。接続できなければ null。
  connectSideband(
    providerSessionId: string,
    handlers: LiveSidebandHandlers,
  ): Promise<LiveSideband | null>;
}

// 予算の門（B07）への境界。秒数だけを渡し、金額は門の側の規則が決める。ticket は門の値をそのまま持ち回る。
export interface LiveBudgetPort {
  reserve(input: {
    readonly request_id: string;
    readonly seconds: number;
  }): Promise<
    | {
        readonly ok: true;
        readonly reservation_id: string;
        readonly ticket: unknown;
      }
    | { readonly ok: false; readonly budget_held: boolean }
  >;
  // 送る直前の送出意図の記録。uncertain は記録したかもしれない（解放しない）。
  dispatch(
    ticket: unknown,
  ): Promise<{ readonly ok: boolean; readonly uncertain: boolean }>;
  // 送っていない予約の解放。
  release(ticket: unknown): Promise<void>;
  // 確認した使用秒数での精算（15 秒の最低課金を含めた秒数）。
  settle(ticket: unknown, billableSeconds: number): Promise<void>;
  // 使用秒数が分からない（予約を保持する）。
  hold(ticket: unknown): Promise<void>;
}

export type VoiceStore = Pick<DbWorkerClient, 'voice' | 'conversation'>;

export interface VoiceControlOptions {
  readonly store: VoiceStore;
  readonly coreInstanceId: string;
  // 中枢の単調時計（ms）。リースの見積もり・調停・サイドバンドの期限に使う。
  readonly monoNow: () => number;
  // UTC の Unix ミリ秒（記録とイベントの時刻）。
  readonly wallNow: () => number;
  readonly timers?: VoiceTimers;
  readonly provider?: LiveProvider | null;
  readonly budget?: LiveBudgetPort | null;
  // 外部への送信の同意（中枢が正本。ADR 0038）。同意の経路は未実装なので、既定は missing（開かない側）。
  readonly consent?: (
    deviceId: string,
  ) => ConsentStatus | Promise<ConsentStatus>;
  // 表示先の端末（同時の呼びかけで優先する。10 §8）。表示の移動の正本ができるまで既定は null。
  readonly displayTarget?: () => string | null;
  readonly newId?: () => string;
  readonly log?: (message: string) => void;
}

interface LeaseEntry {
  readonly lease_id: string;
  readonly kind: 'audio' | 'display';
  readonly device_id: string;
  readonly command_scope_id: string;
  readonly io_epoch: string;
  readonly ttl_ms: number;
  readonly stored: StoredLease;
  // 最後に更新を受け付けた中枢の単調時計。中枢の見積もりの期限は renewed_at + ttl_ms（端末は要求時から数えるので、
  // 端末の期限はこれより前に来る）。
  readonly renewed_at: number;
  // このリースで開いた Live（1 つのリースで 1 つまで）。
  live_session_id: string | null;
  // 端末の交代で前の所有者から取ったリースか（Live の世代の発行の出来事を device_move にする）。
  readonly via_takeover: boolean;
  // 停止・交代で取り消した（以後の更新を受けない。端末は自分の期限で止まる）。
  revoked: boolean;
  expiry: unknown;
}

interface OwnerRecord {
  readonly device_id: string;
  readonly lease_id: string;
  readonly granted_at: number;
}

interface LiveRuntime {
  record: LiveSessionRecord;
  readonly ticket: unknown;
  provider_session_id: string | null;
  sideband: LiveSideband | null;
  connectTimer: unknown;
  pingTimer: unknown;
  deadlineTimer: unknown;
  confirmTimer: unknown;
  // 遷移を 1 つずつ行う（compare-and-set の競合を作らない）。
  queue: Promise<void>;
  settled: boolean;
}

const reservationOf = (
  record: LiveSessionRecord,
): LiveControl['reservation_state'] =>
  record.closure === 'close_confirmed'
    ? 'settled'
    : record.closure === 'close_unconfirmed'
      ? 'held'
      : 'reserved';

const controlOf = (record: LiveSessionRecord): LiveControl => ({
  live_session_id: record.live_session_id,
  control_state: record.control_state,
  control_epoch: record.control_epoch,
  closure: record.closure,
  usage_seconds: record.usage_seconds,
  reservation_state: reservationOf(record),
});

const valuesOf = (control: LiveControl): LiveControlValues => ({
  control_state: control.control_state,
  control_epoch: control.control_epoch,
  closure: control.closure,
  usage_seconds: control.usage_seconds,
});

export function liveControlState(record: LiveSessionRecord): object {
  return {
    live_session_id: record.live_session_id,
    control_state: record.control_state,
    control_epoch: record.control_epoch,
    closure: record.closure,
    usage_seconds: record.usage_seconds,
    reservation_state: reservationOf(record),
  };
}

const STOP_REASON: Readonly<Record<VoiceStopScope, AudioReason>> = {
  local: 'device_io_stop',
  guest: 'guest_mode',
  global: 'global_stop',
};

const error = (status: number, code: ApiErrorCode, requestId: string | null) =>
  apiErrorResponse(status, code, requestId);

const str = (body: JsonObject | null, key: string): string =>
  typeof body?.[key] === 'string' ? (body[key] as string) : '';

export class VoiceControl {
  readonly #store: VoiceStore;
  readonly #coreInstanceId: string;
  readonly #monoNow: () => number;
  readonly #wallNow: () => number;
  readonly #timers: VoiceTimers;
  readonly #provider: LiveProvider | null;
  readonly #budget: LiveBudgetPort | null;
  readonly #consent: (
    deviceId: string,
  ) => ConsentStatus | Promise<ConsentStatus>;
  readonly #displayTarget: () => string | null;
  readonly #newId: () => string;
  readonly #log: (message: string) => void;
  readonly #leases = new Map<string, Map<'audio' | 'display', LeaseEntry>>();
  readonly #lives = new Map<string, LiveRuntime>();
  readonly #listeners = new Map<string, Set<(event: object) => void>>();
  #owner: OwnerRecord | null = null;
  #serial: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: VoiceControlOptions) {
    this.#store = options.store;
    this.#coreInstanceId = options.coreInstanceId;
    this.#monoNow = options.monoNow;
    this.#wallNow = options.wallNow;
    this.#timers = options.timers ?? REAL_VOICE_TIMERS;
    this.#provider = options.provider ?? null;
    this.#budget = options.budget ?? null;
    this.#consent = options.consent ?? (() => 'missing');
    this.#displayTarget = options.displayTarget ?? (() => null);
    this.#newId = options.newId ?? randomUUID;
    this.#log = options.log ?? (() => undefined);
  }

  // ---- 共通 -----------------------------------------------------------------------------------------------

  // 状態を変える処理を 1 つずつ行う（リース・所有者・停止・Live の開始の間で判定と書込みを割り込ませない）。
  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#serial.then(run, run);
    this.#serial = next.catch(() => undefined);
    return next;
  }

  subscribe(deviceId: string, listener: (event: object) => void): () => void {
    let set = this.#listeners.get(deviceId);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(deviceId, set);
    }
    set.add(listener);
    return () => {
      const current = this.#listeners.get(deviceId);
      current?.delete(listener);
      if (current?.size === 0) this.#listeners.delete(deviceId);
    };
  }

  #emit(deviceId: string, event: object): void {
    for (const listener of this.#listeners.get(deviceId) ?? []) {
      try {
        listener(event);
      } catch {
        // 1 つの購読の失敗で他の購読を止めない。
      }
    }
  }

  // 停止のイベント（VoiceEvent の audio_control）。届かなくても端末はリースの期限で止まる。
  #emitAudioControl(
    state: DeviceVoiceState,
    reason: AudioReason,
    live: LiveSessionRecord | null,
  ): void {
    const rule = AUDIO_CONTROL_RULES[reason];
    const at = new Date(this.#wallNow()).toISOString();
    const audioEpoch = live?.audio_epoch ?? state.audio_epoch;
    this.#emit(state.device_id, {
      schema: 'buddy.voice-event.v1',
      event_id: this.#newId(),
      event_type: 'audio_control',
      device_id: state.device_id,
      session_id: live?.session_id ?? null,
      live_session_id: live?.live_session_id ?? null,
      audio_epoch: live?.audio_epoch ?? null,
      control_epoch: live?.control_epoch ?? null,
      candidate_ids: [],
      audio_control: {
        action: rule.action,
        reason,
        device_id: state.device_id,
        scope: rule.scope,
        io_epoch: state.io_epoch,
        audio_epoch: audioEpoch,
        output_epoch: state.output_epoch,
        issued_by: 'core',
        issued_at: at,
      },
      occurred_at: at,
    });
  }

  async #deviceState(deviceId: string): Promise<DeviceVoiceState | null> {
    const found = await this.#store.voice({
      kind: 'voice.device_state',
      device_id: deviceId,
    });
    if (!found.ok) throw new Error('voice_state_unavailable');
    return found.value;
  }

  #leaseExpiresAt(entry: LeaseEntry): number {
    return entry.renewed_at + entry.ttl_ms;
  }

  #leaseLive(entry: LeaseEntry | undefined): boolean {
    return (
      entry !== undefined &&
      !entry.revoked &&
      this.#monoNow() < this.#leaseExpiresAt(entry)
    );
  }

  #ownerValid(): OwnerRecord | null {
    const owner = this.#owner;
    if (owner === null) return null;
    const entry = this.#leases.get(owner.device_id)?.get('audio');
    return entry !== undefined &&
      entry.lease_id === owner.lease_id &&
      this.#leaseLive(entry)
      ? owner
      : null;
  }

  // 経路の検査の audio_owner（createLiveSession）。
  audioOwner(device: DeviceRecord | null): 'self' | 'other' | 'none' {
    if (device === null) return 'none';
    const owner = this.#ownerValid();
    if (owner === null) return 'none';
    return owner.device_id === device.device_id ? 'self' : 'other';
  }

  // 端末のリースの、中枢が見積もった最も遅い期限（取り消したリースも端末は期限まで持っている）。なければ null。
  #latestExpiry(deviceId: string): number | null {
    let latest: number | null = null;
    for (const entry of this.#leases.get(deviceId)?.values() ?? []) {
      const at = this.#leaseExpiresAt(entry);
      if (latest === null || at > latest) latest = at;
    }
    return latest;
  }

  #revokeLeases(deviceId: string): void {
    for (const entry of this.#leases.get(deviceId)?.values() ?? [])
      entry.revoked = true;
    if (this.#owner?.device_id === deviceId) this.#owner = null;
  }

  #openLives(deviceId: string): LiveRuntime[] {
    return [...this.#lives.values()].filter(
      (runtime) =>
        runtime.record.device_id === deviceId &&
        runtime.record.closure === 'open',
    );
  }

  // 入出力の状態（DeviceIOState）。getBootstrap と再開の応答。
  async ioState(
    device: DeviceRecord,
    lock: DeclaredLockState | null,
  ): Promise<object | null> {
    const state = await this.#deviceState(device.device_id);
    if (state === null) return null;
    const stop = state.global_stop
      ? 'global'
      : state.guest_mode
        ? 'guest'
        : state.local_stop
          ? 'local'
          : 'none';
    const lockState = lock ?? 'unknown';
    const live = this.#openLives(device.device_id).some(
      (runtime) =>
        runtime.record.control_state === 'ready' ||
        runtime.record.control_state === 'connecting',
    );
    return {
      device_id: device.device_id,
      io_epoch: state.io_epoch,
      output_epoch: state.output_epoch,
      lock_state: lockState,
      stop_scope: stop,
      input_permitted: stop === 'none' && lockState === 'unlocked',
      voice_state:
        stop === 'global'
          ? 'global_stopped'
          : stop !== 'none'
            ? 'device_stopped'
            : live
              ? 'conversation_live'
              : 'waiting_wake_word',
      // 返し方・記録しない会話の正本は中枢にまだない（U71）。表示の既定は文字・記録する会話。
      output_mode: 'text',
      private_conversation: false,
      audio_lease_valid: this.#leaseLive(
        this.#leases.get(device.device_id)?.get('audio'),
      ),
    };
  }

  // resumeIo の expected_revision（expected_io_epoch が今の io_epoch と一致するか）。
  async revisionMatches(
    device: DeviceRecord | null,
    body: JsonObject | null,
  ): Promise<boolean> {
    if (device === null) return false;
    const state = await this.#deviceState(device.device_id);
    return state !== null && state.io_epoch === str(body, 'expected_io_epoch');
  }

  // ---- リースの取得と更新（heartbeat） -----------------------------------------------------------------------

  renewLease(
    device: DeviceRecord,
    body: JsonObject,
    lock: DeclaredLockState | null,
  ): Promise<Status> {
    return this.#exclusive(() => this.#renew(device, body, lock));
  }

  async #renew(
    device: DeviceRecord,
    body: JsonObject,
    lock: DeclaredLockState | null,
  ): Promise<Status> {
    const requestId = str(body, 'request_id');
    const request = {
      lease_id: str(body, 'lease_id'),
      kind: body['kind'] as 'audio' | 'display',
      device_id: str(body, 'device_id'),
      core_instance_id: str(body, 'core_instance_id'),
      command_scope_id: str(body, 'command_scope_id'),
      io_epoch: str(body, 'io_epoch'),
      nonce: str(body, 'nonce'),
      previous_nonce:
        typeof body['previous_nonce'] === 'string'
          ? body['previous_nonce']
          : null,
      requested_at_mono_ms: body['requested_at_mono_ms'] as number,
      heartbeat_ms: body['heartbeat_ms'] as number,
      ttl_ms: grantedLeaseTtlMs(body['ttl_ms'] as number),
    };
    const rejected = (reasons: readonly string[]): Status => ({
      status: 200,
      body: {
        request_id: requestId,
        lease_id: request.lease_id,
        nonce: request.nonce,
        result: 'rejected',
        reasons,
        ttl_ms: null,
      },
    });
    // 本文の端末は認証した端末と一致しなければならない（他の端末として処理しない。07 §2）。
    if (request.device_id !== device.device_id)
      return rejected(['device_mismatch']);
    let state: DeviceVoiceState | null;
    try {
      state = await this.#deviceState(device.device_id);
    } catch {
      return error(503, 'dependency_unavailable', requestId);
    }
    if (state === null) return error(401, 'unauthenticated', requestId);
    const current = this.#leases.get(device.device_id)?.get(request.kind);
    // 同じ lease_id の、取り消していないリースだけを更新の対象にする。別の lease_id は新しい取得。
    const same =
      current !== undefined &&
      current.lease_id === request.lease_id &&
      !current.revoked
        ? current
        : null;
    // 取り消した（停止・交代した）リースは、同じ lease_id では更新しない。交代で別の端末が所有していれば 409、
    // それ以外は更新の拒否の理由（停止なら世代の古さ）を返し、理由がなくても取り直し（lease_rotation_required）を求める。
    if (
      current !== undefined &&
      current.lease_id === request.lease_id &&
      current.revoked
    ) {
      const owner = this.#ownerValid();
      if (
        request.kind === 'audio' &&
        owner !== null &&
        owner.device_id !== device.device_id
      )
        return error(409, 'audio_owned_elsewhere', requestId);
      const reasons = leaseRenewalReasons(current.stored, request, {
        core_instance_id: this.#coreInstanceId,
        command_scope_id: current.command_scope_id,
        io_epoch: state.io_epoch,
        io_suspended:
          state.local_stop ||
          state.guest_mode ||
          state.global_stop ||
          lock !== 'unlocked',
        device_revoked: !state.active,
        control: 'none',
      });
      return rejected(
        reasons.length > 0 ? reasons : ['lease_rotation_required'],
      );
    }
    const live =
      same?.live_session_id === null || same === null
        ? null
        : (this.#lives.get(same.live_session_id) ?? null);
    const control =
      request.kind !== 'audio' || same === null || same.live_session_id === null
        ? ('none' as const)
        : (live?.record.control_state ?? 'closed');
    const reasons = leaseRenewalReasons(same?.stored ?? null, request, {
      core_instance_id: this.#coreInstanceId,
      command_scope_id: same?.command_scope_id ?? request.command_scope_id,
      io_epoch: state.io_epoch,
      // ロック中・ロック状態が分からない端末にはリースを渡さない（解除済みと扱わない。07 §2）。
      io_suspended:
        state.local_stop ||
        state.guest_mode ||
        state.global_stop ||
        lock !== 'unlocked',
      device_revoked: !state.active,
      control,
    });
    if (leaseRotationRequired(same?.stored ?? null))
      reasons.push('lease_rotation_required');
    if (reasons.length > 0) return rejected(reasons);

    const now = this.#monoNow();
    let viaTakeover = same?.via_takeover ?? false;
    if (request.kind === 'audio' && same === null) {
      const owner = this.#ownerValid();
      const decision = arbitrateAudioClaim(
        owner === null
          ? null
          : {
              device_id: owner.device_id,
              granted_at_mono_ms: owner.granted_at,
              valid: true,
            },
        { device_id: device.device_id, at_mono_ms: now },
        this.#displayTarget(),
      );
      if (decision.decision === 'reject')
        return error(409, decision.code, requestId);
      if (decision.replaces !== null) {
        // 前の所有者の Live を先に閉じ（閉じる要求を記録してサイドバンドへ送る）、リースを取り消してから発行する（10 §8）。
        viaTakeover = true;
        await this.#releaseOwner(decision.replaces);
      }
    }
    // 他の端末が交代で所有権を取った後の、前の所有者の音声リースの更新は受けない（期限で止まる）。
    if (
      request.kind === 'audio' &&
      same !== null &&
      this.#owner !== null &&
      this.#owner.device_id !== device.device_id
    )
      return error(409, 'audio_owned_elsewhere', requestId);

    if (current !== undefined) this.#timers.clear(current.expiry);
    const entry: LeaseEntry = {
      lease_id: request.lease_id,
      kind: request.kind,
      device_id: device.device_id,
      command_scope_id: request.command_scope_id,
      io_epoch: request.io_epoch,
      ttl_ms: request.ttl_ms,
      stored: {
        lease_id: request.lease_id,
        kind: request.kind,
        device_id: device.device_id,
        used_nonces: [...(same?.stored.used_nonces ?? []), request.nonce],
        last_requested_at_mono_ms: request.requested_at_mono_ms,
      },
      renewed_at: now,
      live_session_id: same?.live_session_id ?? null,
      via_takeover: viaTakeover,
      revoked: false,
      expiry: null,
    };
    entry.expiry = this.#timers.set(request.ttl_ms, () =>
      this.#onLeaseExpired(entry),
    );
    let byKind = this.#leases.get(device.device_id);
    if (byKind === undefined) {
      byKind = new Map();
      this.#leases.set(device.device_id, byKind);
    }
    byKind.set(request.kind, entry);
    if (request.kind === 'audio')
      this.#owner = {
        device_id: device.device_id,
        lease_id: entry.lease_id,
        granted_at:
          same !== null && this.#owner?.lease_id === entry.lease_id
            ? this.#owner.granted_at
            : now,
      };
    return {
      status: 200,
      body: {
        request_id: requestId,
        lease_id: request.lease_id,
        nonce: request.nonce,
        result: 'renewed',
        reasons: [],
        ttl_ms: request.ttl_ms,
      },
    };
  }

  // 端末の交代: 前の所有者の音声リースを取り消し、開いている Live を device_move で閉じ、停止のイベントを送る。
  async #releaseOwner(deviceId: string): Promise<void> {
    const entry = this.#leases.get(deviceId)?.get('audio');
    if (entry !== undefined) entry.revoked = true;
    if (this.#owner?.device_id === deviceId) this.#owner = null;
    const state = await this.#deviceState(deviceId).catch(() => null);
    const lives = this.#openLives(deviceId);
    for (const runtime of lives) await this.#beginClose(runtime, 'device_move');
    if (state !== null)
      this.#emitAudioControl(state, 'device_move', lives[0]?.record ?? null);
  }

  // 中枢の見積もりでリースが切れた。音声リースで開いている Live は中枢からも閉じる（07 §5）。
  #onLeaseExpired(entry: LeaseEntry): void {
    if (this.#closed) return;
    const current = this.#leases.get(entry.device_id)?.get(entry.kind);
    if (current !== entry) return;
    if (this.#owner?.lease_id === entry.lease_id) this.#owner = null;
    if (entry.kind !== 'audio' || entry.live_session_id === null) return;
    const runtime = this.#lives.get(entry.live_session_id);
    if (runtime === undefined || runtime.record.closure !== 'open') return;
    void this.#exclusive(async () => {
      await this.#beginClose(runtime, 'core_lease_lost');
      const state = await this.#deviceState(entry.device_id).catch(() => null);
      if (state !== null)
        this.#emitAudioControl(state, 'core_lease_lost', runtime.record);
    });
  }

  // ---- 停止と再開 ---------------------------------------------------------------------------------------------

  stopIo(device: DeviceRecord, body: JsonObject): Promise<Status> {
    return this.#exclusive(async () => {
      const requestId = str(body, 'request_id');
      const scope = body['scope'] as VoiceStopScope;
      const stopped = await this.#store.voice({
        kind: 'voice.stop',
        scope,
        device_id: device.device_id,
        now: this.#wallNow(),
      });
      if (!stopped.ok)
        return stopped.reasons.includes('device_revoked') ||
          stopped.reasons.includes('device_not_found')
          ? error(401, 'unauthenticated', requestId)
          : error(503, 'dependency_unavailable', requestId);
      const reason = STOP_REASON[scope];
      const plan = planStop(reason);
      for (const state of stopped.value.devices) {
        this.#revokeLeases(state.device_id);
        const lives = this.#openLives(state.device_id);
        // 第 3 層: 中枢がサイドバンドから閉じ、使用量を照合する（planStop の core）。
        if (plan.core.includes('core_sideband_close'))
          for (const runtime of lives) await this.#beginClose(runtime, reason);
        if (state.device_id !== device.device_id)
          this.#emitAudioControl(state, reason, lives[0]?.record ?? null);
      }
      const reach = ioStopReach(
        stopped.value.devices.map((state) => ({
          device_id: state.device_id,
          requester: state.device_id === device.device_id,
          lease_expires_at_mono_ms: this.#latestExpiry(state.device_id),
        })),
        this.#monoNow(),
      );
      const own = stopped.value.devices.find(
        (state) => state.device_id === device.device_id,
      );
      return {
        status: 202,
        body: {
          scope,
          io_epoch: own?.io_epoch ?? '0',
          devices: reach.devices,
          all_confirmed: reach.all_confirmed,
        },
      };
    });
  }

  resumeIo(
    device: DeviceRecord,
    body: JsonObject,
    lock: DeclaredLockState | null,
  ): Promise<Status> {
    return this.#exclusive(async () => {
      const requestId = str(body, 'request_id');
      const resumed = await this.#store.voice({
        kind: 'voice.resume',
        scope: body['scope'] as VoiceStopScope,
        device_id: device.device_id,
        expected_io_epoch: str(body, 'expected_io_epoch'),
        now: this.#wallNow(),
      });
      if (!resumed.ok) {
        if (resumed.reasons.includes('io_epoch_mismatch'))
          return error(409, 'conflict', requestId);
        if (
          resumed.reasons.includes('device_revoked') ||
          resumed.reasons.includes('device_not_found')
        )
          return error(401, 'unauthenticated', requestId);
        return error(503, 'dependency_unavailable', requestId);
      }
      const state = await this.ioState(device, lock).catch(() => null);
      return state === null
        ? error(503, 'dependency_unavailable', requestId)
        : { status: 200, body: state };
    });
  }

  // ---- Live の接続と終了の通知 ---------------------------------------------------------------------------------

  async createLiveSession(
    device: DeviceRecord,
    body: JsonObject,
  ): Promise<Status> {
    const requestId = str(body, 'request_id');
    const admitted = await this.#exclusive(() =>
      this.#admitLive(device, body, requestId),
    );
    if ('status' in admitted) return admitted;
    const { runtime, provider } = admitted;
    let created:
      | { ok: true; provider_session_id: string; sdp_answer: string }
      | { ok: false };
    try {
      created = await provider.createSession({
        live_session_id: runtime.record.live_session_id,
        purpose: runtime.record.purpose,
        sdp_offer: str(body, 'sdp_offer'),
      });
    } catch {
      created = { ok: false };
    }
    if (!created.ok) {
      // 送った可能性がある。送り直さず、終了未確認として予約を保持する。
      await this.#enqueue(runtime, async () => {
        await this.#step(runtime, 'close_requested', null, 'provider_failure');
        await this.#markUnconfirmed(runtime);
      });
      return error(503, 'dependency_unavailable', requestId);
    }
    runtime.provider_session_id = created.provider_session_id;
    if (runtime.record.closure !== 'open') {
      // 作成の途中で停止・交代が来た。閉じるためだけに接続して session.close を送る。
      void this.#enqueue(runtime, () => this.#closeOnlyReconnect(runtime));
      return error(409, 'conflict', requestId);
    }
    this.#connectSideband(runtime);
    return {
      status: 201,
      body: {
        live_session_id: runtime.record.live_session_id,
        purpose: runtime.record.purpose,
        sdp_answer: created.sdp_answer,
        audio_epoch: runtime.record.audio_epoch,
        control_epoch: runtime.record.control_epoch,
        session_epoch: runtime.record.session_epoch,
      },
    };
  }

  async #admitLive(
    device: DeviceRecord,
    body: JsonObject,
    requestId: string,
  ): Promise<Status | { runtime: LiveRuntime; provider: LiveProvider }> {
    let state: DeviceVoiceState | null;
    try {
      state = await this.#deviceState(device.device_id);
    } catch {
      return error(503, 'dependency_unavailable', requestId);
    }
    if (state === null) return error(401, 'unauthenticated', requestId);
    const lease = this.#leases.get(device.device_id)?.get('audio');
    const owner = this.audioOwner(device);
    // 古い世代・期限切れ・取り消し・別の接続範囲・すでに Live を開いたリースでは開かない（07 §5）。
    const leaseValid =
      lease !== undefined &&
      owner === 'self' &&
      this.#leaseLive(lease) &&
      lease.io_epoch === state.io_epoch &&
      lease.command_scope_id === str(body, 'command_scope_id') &&
      lease.live_session_id === null;
    let consent: ConsentStatus;
    try {
      consent = await this.#consent(device.device_id);
    } catch {
      consent = 'missing';
    }
    const purpose = body['purpose'] as 'conversation' | 'notification';
    const admission = admitLiveStart({
      purpose,
      audioOwner: owner,
      ioSuspended: state.local_stop || state.guest_mode || state.global_stop,
      audioLeaseValid: leaseValid,
      // 返し方の正本は中枢にまだない（U71）。文字で返す端末はこの経路を呼ばない（07 §2）。
      outputMode: 'voice',
      // 記録しない会話は B04-03 で受け付けていない（会話がないので記録しない会話中にならない。U71）。
      privateConversation: false,
      consent,
      // 予約の可否はこの後の予算の門で決める（できなければ 422）。
      budgetReservable: true,
    });
    if (!admission.ok)
      return error(admission.status, admission.code as ApiErrorCode, requestId);
    const sessionId = str(body, 'session_id');
    const session = await this.#store.conversation({
      kind: 'session.get',
      session_id: sessionId,
    });
    if (!session.ok) return error(503, 'dependency_unavailable', requestId);
    if (session.value === null || session.value.ended_at !== null)
      return error(409, 'conflict', requestId);
    const provider = this.#provider;
    const budget = this.#budget;
    if (provider === null || budget === null)
      return error(503, 'dependency_unavailable', requestId);
    if (
      this.#openLives(device.device_id).some(
        (runtime) =>
          runtime.record.control_state === 'connecting' ||
          runtime.record.control_state === 'ready',
      )
    )
      return error(409, 'conflict', requestId);
    const reserved = await budget
      .reserve({ request_id: requestId, seconds: LIVE_INITIAL_RESERVE_SECONDS })
      .catch(() => ({ ok: false as const, budget_held: false }));
    if (!reserved.ok)
      return reserved.budget_held
        ? error(422, 'budget_held', requestId)
        : error(503, 'dependency_unavailable', requestId);
    const dispatched = await budget
      .dispatch(reserved.ticket)
      .catch(() => ({ ok: false, uncertain: true }));
    if (!dispatched.ok) {
      if (dispatched.uncertain)
        await budget.hold(reserved.ticket).catch(() => undefined);
      else await budget.release(reserved.ticket).catch(() => undefined);
      return error(503, 'dependency_unavailable', requestId);
    }
    const event: LiveEpochEvent =
      lease?.via_takeover === true ? 'device_move' : 'live_start';
    const issued = issueLiveEpochs(
      {
        audio_epoch: state.audio_epoch,
        session_epoch: state.session_epoch,
        control_epoch: '0',
      },
      event,
    );
    const liveSessionId = this.#newId();
    const opened = await this.#store.voice({
      kind: 'voice.live_open',
      live_session_id: liveSessionId,
      device_id: device.device_id,
      session_id: sessionId,
      purpose,
      reservation_id: reserved.reservation_id,
      expected: {
        audio_epoch: state.audio_epoch,
        session_epoch: state.session_epoch,
      },
      next: {
        audio_epoch: issued.next.audio_epoch,
        session_epoch: issued.next.session_epoch,
      },
      started_at: this.#wallNow(),
    });
    if (!opened.ok) {
      // 送出意図を記録した後なので解放しない（送っていないが、記録した予約は保持する。ADR 0037）。
      await budget.hold(reserved.ticket).catch(() => undefined);
      return error(503, 'dependency_unavailable', requestId);
    }
    const runtime: LiveRuntime = {
      record: opened.value,
      ticket: reserved.ticket,
      provider_session_id: null,
      sideband: null,
      connectTimer: null,
      pingTimer: null,
      deadlineTimer: null,
      confirmTimer: null,
      queue: Promise.resolve(),
      settled: false,
    };
    this.#lives.set(liveSessionId, runtime);
    (lease as LeaseEntry).live_session_id = liveSessionId;
    return { runtime, provider };
  }

  // 端末からの終了の通知（いつでも受け付ける）。使用秒数が確認できるまで予約を精算済みにしない。
  async closeLiveSession(
    device: DeviceRecord,
    liveSessionId: string,
    body: JsonObject,
  ): Promise<Status> {
    const requestId = str(body, 'request_id');
    const runtime = this.#lives.get(liveSessionId);
    let record = runtime?.record ?? null;
    if (record === null) {
      const found = await this.#store.voice({
        kind: 'voice.live_get',
        live_session_id: liveSessionId,
      });
      if (!found.ok) return error(503, 'dependency_unavailable', requestId);
      record = found.value;
    }
    if (record === null || record.device_id !== device.device_id)
      return error(404, 'invalid_input', requestId);
    if (record.audio_epoch !== str(body, 'audio_epoch'))
      return error(409, 'conflict', requestId);
    if (runtime !== undefined && runtime.record.closure === 'open')
      await this.#exclusive(() =>
        this.#beginClose(runtime, str(body, 'reason')),
      );
    return {
      status: 202,
      body: liveControlState(runtime?.record ?? record),
    };
  }

  // ---- 制御接続（サイドバンド） ---------------------------------------------------------------------------------

  #enqueue(runtime: LiveRuntime, run: () => Promise<void>): Promise<void> {
    const next = runtime.queue.then(run, run);
    runtime.queue = next.catch(() => undefined);
    return next;
  }

  // nextLiveControl で次の状態を決め、DB へ compare-and-set で書く。遷移できなければ false。
  async #step(
    runtime: LiveRuntime,
    trigger: LiveControlTrigger,
    usageSeconds: number | null = null,
    endReason: string | null = null,
  ): Promise<boolean> {
    const current = controlOf(runtime.record);
    const next = nextLiveControl(current, trigger, usageSeconds);
    if (!next.ok) return false;
    const updated = await this.#store.voice({
      kind: 'voice.live_update',
      live_session_id: runtime.record.live_session_id,
      expected: valuesOf(current),
      next: valuesOf(next.next),
      ended_at: next.next.control_state === 'closed' ? this.#wallNow() : null,
      end_reason: endReason,
    });
    if (!updated.ok) {
      this.#log(
        `Live の制御の状態を記録できませんでした（${updated.reasons.join(', ')}）。`,
      );
      return false;
    }
    runtime.record = updated.value;
    return true;
  }

  #clearTimers(runtime: LiveRuntime): void {
    for (const handle of [
      runtime.connectTimer,
      runtime.pingTimer,
      runtime.deadlineTimer,
      runtime.confirmTimer,
    ])
      if (handle !== null) this.#timers.clear(handle);
    runtime.connectTimer = null;
    runtime.pingTimer = null;
    runtime.deadlineTimer = null;
    runtime.confirmTimer = null;
  }

  #handlers(
    runtime: LiveRuntime,
    handleRef: { handle: LiveSideband | null },
  ): LiveSidebandHandlers {
    return {
      onPong: () => {
        if (handleRef.handle !== runtime.sideband) return;
        this.#armDeadline(runtime);
      },
      onSessionClosed: (usage) => {
        void this.#enqueue(runtime, () =>
          this.#onSessionClosed(runtime, usage),
        );
      },
      onDisconnected: () => {
        if (handleRef.handle !== runtime.sideband) return;
        void this.#enqueue(runtime, () =>
          this.#onLost(
            runtime,
            runtime.record.control_state === 'connecting'
              ? 'sideband_connect_failed'
              : 'sideband_disconnected',
          ),
        );
      },
    };
  }

  // SDP answer を返すのと同時にサイドバンドへ接続する（answer を待たせない。10 §2）。3 秒で接続できなければ lost。
  #connectSideband(runtime: LiveRuntime): void {
    const provider = this.#provider as LiveProvider;
    const ref: { handle: LiveSideband | null } = { handle: null };
    runtime.connectTimer = this.#timers.set(
      SIDEBAND_CONNECT_DEADLINE_MS,
      () => {
        runtime.connectTimer = null;
        if (runtime.record.control_state === 'connecting')
          void this.#enqueue(runtime, () =>
            this.#onLost(runtime, 'sideband_connect_failed'),
          );
      },
    );
    void provider
      .connectSideband(
        runtime.provider_session_id as string,
        this.#handlers(runtime, ref),
      )
      .catch(() => null)
      .then((handle) =>
        this.#enqueue(runtime, async () => {
          if (runtime.connectTimer !== null) {
            this.#timers.clear(runtime.connectTimer);
            runtime.connectTimer = null;
          }
          if (handle === null) {
            if (runtime.record.control_state === 'connecting')
              await this.#onLost(runtime, 'sideband_connect_failed');
            return;
          }
          if (runtime.record.control_state !== 'connecting') {
            // 期限の後に接続できた・閉じ始めた後。閉じる手順は閉じるためだけの再接続が受け持つので、この接続は使わない。
            handle.terminate();
            return;
          }
          ref.handle = handle;
          runtime.sideband = handle;
          if (!(await this.#step(runtime, 'sideband_connected'))) return;
          this.#armDeadline(runtime);
          runtime.pingTimer = this.#timers.set(SIDEBAND_PING_INTERVAL_MS, () =>
            this.#ping(runtime),
          );
          const state = await this.#deviceState(runtime.record.device_id).catch(
            () => null,
          );
          if (state !== null)
            this.#emit(state.device_id, {
              schema: 'buddy.voice-event.v1',
              event_id: this.#newId(),
              event_type: 'sideband_connected',
              device_id: state.device_id,
              session_id: runtime.record.session_id,
              live_session_id: runtime.record.live_session_id,
              audio_epoch: runtime.record.audio_epoch,
              control_epoch: runtime.record.control_epoch,
              candidate_ids: [],
              audio_control: null,
              occurred_at: new Date(this.#wallNow()).toISOString(),
            });
        }),
      );
  }

  #ping(runtime: LiveRuntime): void {
    runtime.pingTimer = null;
    if (this.#closed || runtime.record.control_state !== 'ready') return;
    runtime.sideband?.ping();
    runtime.pingTimer = this.#timers.set(SIDEBAND_PING_INTERVAL_MS, () =>
      this.#ping(runtime),
    );
  }

  // 最後の pong（または接続）から 6 秒で ping_timeout。
  #armDeadline(runtime: LiveRuntime): void {
    if (runtime.deadlineTimer !== null)
      this.#timers.clear(runtime.deadlineTimer);
    runtime.deadlineTimer = this.#timers.set(SIDEBAND_PING_DEADLINE_MS, () => {
      runtime.deadlineTimer = null;
      if (runtime.record.control_state === 'ready')
        void this.#enqueue(runtime, () =>
          this.#onLost(runtime, 'ping_timeout'),
        );
    });
  }

  // lost: control_epoch を進め（nextLiveControl）、新規の委譲・読み上げを止め、音声リースを更新しない（sideband_lost）。
  // 停止のイベントを送り、閉じるためだけの再接続を 1 回試す（10 §2A）。
  async #onLost(
    runtime: LiveRuntime,
    trigger:
      'sideband_connect_failed' | 'sideband_disconnected' | 'ping_timeout',
  ): Promise<void> {
    if (!(await this.#step(runtime, trigger))) return;
    const old = runtime.sideband;
    runtime.sideband = null;
    old?.terminate();
    this.#clearTimers(runtime);
    const state = await this.#deviceState(runtime.record.device_id).catch(
      () => null,
    );
    if (state !== null)
      this.#emitAudioControl(state, 'sideband_lost', runtime.record);
    if (!(await this.#step(runtime, 'close_requested', null, 'sideband_lost')))
      return;
    await this.#closeOnlyReconnect(runtime);
  }

  // 閉じるためだけのサイドバンドの再接続（1 回・3 秒まで）。接続できたら session.close を送って終了を待つ。
  // できなければ終了未確認にして予約を保持する（端末側の停止は待たせない）。
  async #closeOnlyReconnect(runtime: LiveRuntime): Promise<void> {
    const provider = this.#provider;
    const sessionId = runtime.provider_session_id;
    if (provider === null || sessionId === null) {
      await this.#markUnconfirmed(runtime);
      return;
    }
    // 接続の待ちの間は遷移の待ち行列を止めない（その間に届く session.closed などを受ける）。結果は待ち行列へ戻して扱う。
    const ref: { handle: LiveSideband | null } = { handle: null };
    let done = false;
    const timer = this.#timers.set(SIDEBAND_CLOSE_RECONNECT_MS, () => {
      if (done) return;
      done = true;
      void this.#enqueue(runtime, () => this.#markUnconfirmed(runtime));
    });
    void provider
      .connectSideband(sessionId, this.#handlers(runtime, ref))
      .catch(() => null)
      .then((handle) => {
        if (done) {
          // 3 秒の後に成り立った接続は使わない。
          handle?.terminate();
          return;
        }
        done = true;
        this.#timers.clear(timer);
        void this.#enqueue(runtime, async () => {
          if (handle === null) {
            await this.#markUnconfirmed(runtime);
            return;
          }
          if (runtime.record.control_state !== 'closing') {
            handle.terminate();
            return;
          }
          ref.handle = handle;
          runtime.sideband = handle;
          handle.sendClose();
          this.#armConfirm(runtime);
        });
      });
  }

  // 中枢から閉じ始める。閉じる要求を記録し、サイドバンドが使えれば session.close を送る（lost なら再接続を試す）。
  // 終了の確認（session.closed）は待たずに戻る（停止を遅らせない）。
  async #beginClose(runtime: LiveRuntime, reason: string): Promise<void> {
    await this.#enqueue(runtime, async () => {
      if (runtime.record.closure !== 'open') return;
      const wasLost = runtime.record.control_state === 'lost';
      if (!(await this.#step(runtime, 'close_requested', null, reason))) return;
      if (runtime.connectTimer !== null) {
        this.#timers.clear(runtime.connectTimer);
        runtime.connectTimer = null;
      }
      if (runtime.pingTimer !== null) this.#timers.clear(runtime.pingTimer);
      runtime.pingTimer = null;
      if (runtime.deadlineTimer !== null)
        this.#timers.clear(runtime.deadlineTimer);
      runtime.deadlineTimer = null;
      if (!wasLost && runtime.sideband !== null) {
        runtime.sideband.sendClose();
        this.#armConfirm(runtime);
        return;
      }
      if (runtime.provider_session_id === null) {
        // provider のセッションがまだない（作成中）。作成の応答の後に閉じるためだけに接続する（createLiveSession）。
        return;
      }
      void this.#enqueue(runtime, () => this.#closeOnlyReconnect(runtime));
    });
  }

  #armConfirm(runtime: LiveRuntime): void {
    if (runtime.confirmTimer !== null) this.#timers.clear(runtime.confirmTimer);
    runtime.confirmTimer = this.#timers.set(CORE_CLOSE_CONFIRM_MS, () => {
      runtime.confirmTimer = null;
      void this.#enqueue(runtime, () => this.#markUnconfirmed(runtime));
    });
  }

  // 終了・使用秒数を確認できない。予約を解放せず保持する（10 §2A）。
  async #markUnconfirmed(runtime: LiveRuntime): Promise<void> {
    if (runtime.record.control_state !== 'closing') return;
    if (!(await this.#step(runtime, 'close_unconfirmed'))) return;
    this.#clearTimers(runtime);
    if (this.#budget !== null)
      await this.#budget.hold(runtime.ticket).catch(() => undefined);
  }

  async #onSessionClosed(
    runtime: LiveRuntime,
    usage: number | null,
  ): Promise<void> {
    if (usage === null) {
      // 使用秒数のない終了は断線として扱う（精算しない）。
      if (runtime.record.control_state === 'ready')
        await this.#onLost(runtime, 'sideband_disconnected');
      else if (runtime.record.control_state === 'connecting')
        await this.#onLost(runtime, 'sideband_connect_failed');
      return;
    }
    const providerFirst =
      runtime.record.closure === 'open' &&
      runtime.record.control_state !== 'lost';
    if (
      !(await this.#step(
        runtime,
        'session_closed_received',
        usage,
        'provider_failure',
      ))
    )
      return;
    this.#clearTimers(runtime);
    runtime.sideband?.terminate();
    runtime.sideband = null;
    const settlement = settleLiveSeconds(usage, LIVE_INITIAL_RESERVE_SECONDS);
    if (settlement.settled && this.#budget !== null && !runtime.settled) {
      runtime.settled = true;
      await this.#budget
        .settle(runtime.ticket, settlement.billable_seconds)
        .catch(() => undefined);
    }
    if (providerFirst) {
      // provider が先に閉じた。端末へ close_voice_session（provider_failure）を送る（ADR 0038）。
      const state = await this.#deviceState(runtime.record.device_id).catch(
        () => null,
      );
      if (state !== null)
        this.#emitAudioControl(state, 'provider_failure', runtime.record);
    }
  }

  // ---- 起動と停止 -----------------------------------------------------------------------------------------------

  // 起動時の照合。前の起動の閉じ終えていない Live は lost にし（core_restarted）、閉じる要求の後に終了未確認として予約を
  // 保持する（provider のセッションの ID は保存していないので、前の起動のサイドバンドからは閉じられない。U72）。
  async start(): Promise<{ readonly unfinished: readonly string[] }> {
    const found = await this.#store.voice({ kind: 'voice.live_unfinished' });
    if (!found.ok) throw new Error('voice_state_unavailable');
    const ids: string[] = [];
    for (const record of found.value) {
      const runtime: LiveRuntime = {
        record,
        ticket: null,
        provider_session_id: null,
        sideband: null,
        connectTimer: null,
        pingTimer: null,
        deadlineTimer: null,
        confirmTimer: null,
        queue: Promise.resolve(),
        settled: false,
      };
      if (
        record.control_state === 'connecting' ||
        record.control_state === 'ready'
      )
        await this.#step(runtime, 'core_restarted');
      if (runtime.record.closure === 'open')
        await this.#step(runtime, 'close_requested', null, 'core_lease_lost');
      if (runtime.record.control_state === 'closing')
        await this.#step(runtime, 'close_unconfirmed');
      ids.push(record.live_session_id);
    }
    if (ids.length > 0)
      this.#log(
        `前の起動の Live（${ids.length} 件）を終了未確認にしました。予約は保持し、使用量の照合を待ちます。`,
      );
    return { unfinished: ids };
  }

  // 中枢の停止。タイマーを止め、サイドバンドを切る（閉じ終えていない Live は次の起動の照合が扱う）。
  async close(): Promise<void> {
    this.#closed = true;
    await this.#serial.catch(() => undefined);
    for (const runtime of this.#lives.values()) {
      this.#clearTimers(runtime);
      runtime.sideband?.terminate();
      runtime.sideband = null;
    }
    for (const byKind of this.#leases.values())
      for (const entry of byKind.values()) this.#timers.clear(entry.expiry);
  }

  // 試験・診断用。Live の今の記録。
  liveRecord(liveSessionId: string): LiveSessionRecord | null {
    return this.#lives.get(liveSessionId)?.record ?? null;
  }

  // 試験・診断用。runtime の遷移の待ち行列が空になるまで待つ。
  async idle(): Promise<void> {
    await this.#serial.catch(() => undefined);
    for (const runtime of this.#lives.values())
      await runtime.queue.catch(() => undefined);
  }
}
