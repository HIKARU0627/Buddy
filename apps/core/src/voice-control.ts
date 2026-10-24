// 中枢の音声の制御（B05-03、ADR 0046。設計 07 §5、10 §1・§1A・§2・§2A・§8）。
//
// 持つもの:
// - リース（音声・機密表示）。RAM だけで、中枢の再起動（起動 ID の変更）で全て無効になる（07 §4・§5）。更新の可否は domain の
//   leaseRenewalReasons、音声所有権の調停は arbitrateAudioClaim、返す期限は grantedLeaseTtlMs で決め、ここで判定を作り直さない。
//   Live とリースの結び付きは端末単位（その端末の開いている Live）で見る。lease_id を取り直しても Live は管理から外れない。
// - 世代と停止の状態。DB（0008）が正本で、中枢の再起動で巻き戻さない。Live の世代は issueLiveEpochs で決めて DB に書く。
// - Live の制御接続（サイドバンド）。遷移は nextLiveControl だけで決め、まずメモリーの状態を変えて副作用（更新の拒否・停止の
//   イベント・session.close・再接続）を行い、DB へは compare-and-set で書く（失敗すれば再試行する）。ping 2 秒・期限 6 秒
//   （設計初期値）で lost にし、lost では音声リースを更新せず、停止のイベントを送り、閉じるためだけの再接続を 1 回・3 秒まで
//   試して session.close を送る。終了と使用秒数を確認できなければ予約を保持する。
// - 停止（/v1/io/stop）。停止は版を求めず常に受け付ける。DB の成否・他の要求の待ちにかかわらず、まずメモリーで止め（停止中の印・
//   リースの取り消し・Live を閉じ始める・停止のイベント）、その後に DB へ書く（中枢が io・output の世代を進める。ADR 0046・U70）。
//   書けなければ再試行し、保存できるまでは停止中の印で更新と Live の受付を拒否する。
// - 再開（/v1/io/resume）は画面操作と版の一致だけ。リースは戻さず、端末は新しいリースを取り直す（10 §1A）。
// provider（OpenAI の Live）と予算の門・同意は注入する境界で、呼び出しには期限を付ける（切れたら結果不明。予約は保持）。
// 製品の起動ではまだ渡さない（実 API は使わない。渡されなければ Live の接続は 503）。結果不明の外部への送信を自動で送り直さない。

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
  LiveControlStateName,
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
// 外部（同意・予算の門）の呼び出しの期限（ms）。原本に決めなし（仮置き）。切れたら結果不明として扱う。
export const VOICE_EXTERNAL_TIMEOUT_MS = 5000;
// provider のセッション作成の期限（ms）。原本は「OpenAI の応答は実測」まで（仮置き）。切れたら結果不明（予約を保持）。
export const LIVE_CREATE_TIMEOUT_MS = 10000;
// DB への書込みの再試行の間隔（ms）と、停止の応答の前に試す回数。原本に決めなし（仮置き）。
export const VOICE_PERSIST_RETRY_MS = 1000;
export const STOP_WRITE_ATTEMPTS = 3;
// 終わった Live の記録を診断のために残す数（メモリーが増え続けないように、古いものから捨てる）。
const FINISHED_KEPT = 32;

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
  // SDP offer を交換してセッションを作る。ok でない・例外・期限切れは、送った可能性があるので結果不明として扱う（送り直さない）。
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

// このリースで開いた Live の結果。更新で作り直すエントリーの間で同じものを持ち回る。
interface OpenedLive {
  readonly live_session_id: string;
  // open: 終わっていない。lost: サイドバンドの喪失を経て終わった。normal: それ以外で終わった。
  outcome: 'open' | 'lost' | 'normal';
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
  opened: OpenedLive | null;
  // 端末の交代で前の所有者から取ったリースか（Live の世代の発行の出来事を device_move にする）。
  readonly via_takeover: boolean;
  // 停止・交代・中枢の見積もりの期限切れで取り消した（以後の更新を受けない。端末は自分の期限で止まる）。
  revoked: boolean;
  expiry: unknown;
}

interface OwnerRecord {
  readonly device_id: string;
  readonly lease_id: string;
  readonly granted_at: number;
}

interface LiveRuntime {
  // メモリーの今の状態（正本として判定に使う）。DB には persisted まで書けている。
  record: LiveSessionRecord;
  persisted: LiveControlValues;
  persisting: Promise<void> | null;
  retryTimer: unknown;
  readonly opened: OpenedLive;
  readonly ticket: unknown;
  provider_session_id: string | null;
  sideband: LiveSideband | null;
  connectTimer: unknown;
  pingTimer: unknown;
  deadlineTimer: unknown;
  confirmTimer: unknown;
  // サイドバンドの喪失を経たか。
  lost: boolean;
  settled: boolean;
  // 予算の門の呼び出しを 1 つずつ行う（保持の後に精算する順を守る）。
  budgetChain: Promise<void>;
}

interface PendingStop {
  readonly scope: VoiceStopScope;
  readonly device_id: string;
  readonly at: number;
  retry: unknown;
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

const valuesOf = (
  value: LiveControl | LiveSessionRecord,
): LiveControlValues => ({
  control_state: value.control_state,
  control_epoch: value.control_epoch,
  closure: value.closure,
  usage_seconds: value.usage_seconds,
});

const sameValues = (a: LiveControlValues, b: LiveControlValues): boolean =>
  a.control_state === b.control_state &&
  a.control_epoch === b.control_epoch &&
  a.closure === b.closure &&
  a.usage_seconds === b.usage_seconds;

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

const bump = (epoch: string): string => (BigInt(epoch) + 1n).toString();

const TIMED_OUT: unique symbol = Symbol('timed_out');

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
  readonly #finished = new Map<string, LiveSessionRecord>();
  readonly #listeners = new Map<string, Set<(event: object) => void>>();
  // 最後に読んだ（または停止で進めた）端末の世代。停止のイベントを DB の読み書きを待たずに作るために使う。
  readonly #known = new Map<string, DeviceVoiceState>();
  // DB へ書けていない停止（保存できるまで、停止中の印として更新と Live の受付を拒否する）。
  readonly #pendingStops: PendingStop[] = [];
  // Live の受付の 1 段目と 2 段目の間にいる端末（2 つ目の受付を 409 にする）。
  readonly #opening = new Set<string>();
  // 応答を待たずに進めた予算の門の呼び出し（試験の idle が待つ）。
  readonly #inflight = new Set<Promise<void>>();
  #owner: OwnerRecord | null = null;
  #serial: Promise<unknown> = Promise.resolve();
  // 停止を受けるたびに進める。DB を読んだ後にこれが変わっていれば読み直す（停止の前の状態で判定しない）。
  #stopGen = 0;
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

  // リース・所有者・Live の受付の判定と書込みを 1 つずつ行う。中には外部の待ちを入れない（DB の短い読み書きだけ）。
  // 停止はこの列に並ばない。
  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#serial.then(run, run);
    this.#serial = next.catch(() => undefined);
    return next;
  }

  // 外部の呼び出しに期限を付ける。切れた・例外なら TIMED_OUT（結果不明）。
  #within<T>(
    ms: number,
    run: () => Promise<T> | T,
  ): Promise<T | typeof TIMED_OUT> {
    return new Promise((resolve) => {
      let done = false;
      const timer = this.#timers.set(ms, () => {
        if (done) return;
        done = true;
        resolve(TIMED_OUT);
      });
      Promise.resolve()
        .then(run)
        .then(
          (value) => {
            if (done) return;
            done = true;
            this.#timers.clear(timer);
            resolve(value);
          },
          () => {
            // 例外も結果不明として扱う。
            if (done) return;
            done = true;
            this.#timers.clear(timer);
            resolve(TIMED_OUT);
          },
        );
    });
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

  // 停止のイベント（VoiceEvent の audio_control）。届かなくても端末はリースの期限で止まる。世代は最後に知った値を使い、
  // DB の読み書きを待たない（知らなければ 0）。
  #emitAudioControl(
    deviceId: string,
    reason: AudioReason,
    live: LiveSessionRecord | null,
  ): void {
    const rule = AUDIO_CONTROL_RULES[reason];
    const known = this.#known.get(deviceId);
    const at = new Date(this.#wallNow()).toISOString();
    this.#emit(deviceId, {
      schema: 'buddy.voice-event.v1',
      event_id: this.#newId(),
      event_type: 'audio_control',
      device_id: deviceId,
      session_id: live?.session_id ?? null,
      live_session_id: live?.live_session_id ?? null,
      audio_epoch: live?.audio_epoch ?? null,
      control_epoch: live?.control_epoch ?? null,
      candidate_ids: [],
      audio_control: {
        action: rule.action,
        reason,
        device_id: deviceId,
        scope: rule.scope,
        io_epoch: known?.io_epoch ?? '0',
        audio_epoch: live?.audio_epoch ?? known?.audio_epoch ?? '0',
        output_epoch: known?.output_epoch ?? '0',
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
    if (found.value !== null) this.#known.set(deviceId, found.value);
    return found.value;
  }

  // 停止と並んで読んだ値で判定しないよう、読んでいる間に停止が来たら読み直す。
  async #freshState(deviceId: string): Promise<DeviceVoiceState | null> {
    for (;;) {
      const generation = this.#stopGen;
      const state = await this.#deviceState(deviceId);
      if (generation === this.#stopGen) return state;
    }
  }

  // DB の停止の印と、まだ DB へ書けていない停止の印を合わせる。
  #stopScope(state: DeviceVoiceState): 'none' | 'local' | 'guest' | 'global' {
    const pending = this.#pendingStops;
    if (state.global_stop || pending.some((stop) => stop.scope === 'global'))
      return 'global';
    if (state.guest_mode || pending.some((stop) => stop.scope === 'guest'))
      return 'guest';
    if (
      state.local_stop ||
      pending.some(
        (stop) => stop.scope === 'local' && stop.device_id === state.device_id,
      )
    )
      return 'local';
    return 'none';
  }

  #suspended(state: DeviceVoiceState): boolean {
    return this.#stopScope(state) !== 'none';
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

  // 端末の Live のうち、閉じる要求をまだ出していないもの。
  #openLives(deviceId: string): LiveRuntime[] {
    return [...this.#lives.values()].filter(
      (runtime) =>
        runtime.record.device_id === deviceId &&
        runtime.record.closure === 'open',
    );
  }

  // 端末の Live のうち、閉じ終えていないもの。
  #unfinishedLives(deviceId: string): LiveRuntime[] {
    return [...this.#lives.values()].filter(
      (runtime) =>
        runtime.record.device_id === deviceId &&
        runtime.record.control_state !== 'closed',
    );
  }

  // 中枢が知っている端末（リース・Live・購読・読んだ世代のどれかがある）。DB を読めないときの停止の対象。
  #knownDevices(): Set<string> {
    const ids = new Set<string>([
      ...this.#leases.keys(),
      ...this.#listeners.keys(),
      ...this.#known.keys(),
    ]);
    for (const runtime of this.#lives.values())
      ids.add(runtime.record.device_id);
    return ids;
  }

  // 入出力の状態（DeviceIOState）。getBootstrap と再開の応答。
  async ioState(
    device: DeviceRecord,
    lock: DeclaredLockState | null,
  ): Promise<object | null> {
    const state = await this.#deviceState(device.device_id);
    if (state === null) return null;
    const stop = this.#stopScope(state);
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

  // 音声リースの更新に使う制御接続の状態。端末単位で、閉じ終えていない Live を見る（取り直したリースでも同じ）。
  // 閉じる要求を出した後の Live は、喪失を経たものだけを数える（正常に閉じている途中の Live のために、次の呼びかけの
  // リースを止めない）。このリースで開いた Live が喪失を経て終わっていれば lost。
  #controlFor(
    deviceId: string,
    entry: LeaseEntry | null,
  ): LiveControlStateName | 'none' {
    const relevant = this.#unfinishedLives(deviceId).filter(
      (runtime) => runtime.record.closure === 'open' || runtime.lost,
    );
    const states = relevant.map((runtime) => runtime.record.control_state);
    for (const state of ['lost', 'closing', 'closed'] as const)
      if (states.includes(state)) return state;
    if (relevant.some((runtime) => runtime.lost)) return 'lost';
    if (states.includes('ready')) return 'ready';
    if (states.includes('connecting')) return 'connecting';
    if (entry?.opened?.outcome === 'lost') return 'lost';
    return 'none';
  }

  // このリースで開いた Live が、喪失を経ずに閉じた・閉じ始めたか。
  #openedEnded(entry: LeaseEntry): boolean {
    const opened = entry.opened;
    if (opened === null) return false;
    if (opened.outcome === 'normal') return true;
    if (opened.outcome === 'lost') return false;
    const runtime = this.#lives.get(opened.live_session_id);
    return (
      runtime !== undefined &&
      !runtime.lost &&
      runtime.record.closure !== 'open'
    );
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
    let read: DeviceVoiceState | null;
    try {
      read = await this.#freshState(device.device_id);
    } catch {
      return error(503, 'dependency_unavailable', requestId);
    }
    if (read === null) return error(401, 'unauthenticated', requestId);
    const state = read;
    // ロック中・ロック状態が分からない端末にはリースを渡さない（解除済みと扱わない。07 §2）。
    const ioSuspended = this.#suspended(state) || lock !== 'unlocked';
    const current = this.#leases.get(device.device_id)?.get(request.kind);
    const context = (entry: LeaseEntry | null) => ({
      core_instance_id: this.#coreInstanceId,
      command_scope_id: entry?.command_scope_id ?? request.command_scope_id,
      io_epoch: state.io_epoch,
      io_suspended: ioSuspended,
      device_revoked: !state.active,
      control:
        request.kind === 'audio'
          ? this.#controlFor(device.device_id, entry)
          : ('none' as const),
    });
    // 取り消した（停止・交代・期限切れ）リースは、同じ lease_id では更新しない。交代で別の端末が所有していれば 409、
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
      const reasons = leaseRenewalReasons(
        current.stored,
        request,
        context(current),
      );
      return rejected(
        reasons.length > 0 ? reasons : ['lease_rotation_required'],
      );
    }
    // 同じ lease_id の、取り消していないリースだけを更新の対象にする。別の lease_id は新しい取得。
    const same =
      current !== undefined && current.lease_id === request.lease_id
        ? current
        : null;
    const reasons = leaseRenewalReasons(
      same?.stored ?? null,
      request,
      context(same),
    );
    if (leaseRotationRequired(same?.stored ?? null))
      reasons.push('lease_rotation_required');
    // 正常に終わった（終わりかけの）Live を開いたリースは、同じ lease_id で更新せず取り直させる（1 つのリースで 1 つの
    // Live。喪失による終わりは sideband_lost）。
    if (reasons.length === 0 && same !== null && this.#openedEnded(same))
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
        this.#releaseOwner(decision.replaces);
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
      opened: same?.opened ?? null,
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
  #releaseOwner(deviceId: string): void {
    const entry = this.#leases.get(deviceId)?.get('audio');
    if (entry !== undefined) entry.revoked = true;
    if (this.#owner?.device_id === deviceId) this.#owner = null;
    const lives = this.#openLives(deviceId);
    for (const runtime of lives) this.#beginClose(runtime, 'device_move');
    this.#emitAudioControl(deviceId, 'device_move', lives[0]?.record ?? null);
  }

  // 中枢の見積もりでリースが切れた。以後の遅れた更新は受けず、音声リースなら端末の開いている Live を中枢からも閉じる（07 §5）。
  #onLeaseExpired(entry: LeaseEntry): void {
    if (this.#closed) return;
    const current = this.#leases.get(entry.device_id)?.get(entry.kind);
    if (current !== entry) return;
    entry.revoked = true;
    if (this.#owner?.lease_id === entry.lease_id) this.#owner = null;
    if (entry.kind !== 'audio') return;
    const lives = this.#openLives(entry.device_id);
    if (lives.length === 0) return;
    for (const runtime of lives) this.#beginClose(runtime, 'core_lease_lost');
    this.#emitAudioControl(
      entry.device_id,
      'core_lease_lost',
      lives[0]?.record ?? null,
    );
  }

  // ---- 停止と再開 ---------------------------------------------------------------------------------------------

  // 停止は他の要求の待ち（#exclusive）に並ばず、DB の成否にかかわらずまずメモリーで止める。
  async stopIo(device: DeviceRecord, body: JsonObject): Promise<Status> {
    const requestId = str(body, 'request_id');
    const scope = body['scope'] as VoiceStopScope;
    const reason = STOP_REASON[scope];
    this.#stopGen += 1;
    const stop: PendingStop = {
      scope,
      device_id: device.device_id,
      at: this.#wallNow(),
      retry: null,
    };
    this.#pendingStops.push(stop);
    const targets =
      scope === 'local'
        ? new Set([device.device_id])
        : new Set([...this.#knownDevices(), device.device_id]);
    const plan = planStop(reason);
    for (const deviceId of targets) {
      this.#revokeLeases(deviceId);
      const known = this.#known.get(deviceId);
      if (known !== undefined)
        this.#known.set(deviceId, {
          ...known,
          io_epoch: bump(known.io_epoch),
          output_epoch: bump(known.output_epoch),
        });
      const lives = this.#openLives(deviceId);
      // 第 3 層: 中枢がサイドバンドから閉じ、使用量を照合する（planStop の core）。
      if (plan.core.includes('core_sideband_close'))
        for (const runtime of lives) this.#beginClose(runtime, reason);
      if (deviceId !== device.device_id)
        this.#emitAudioControl(deviceId, reason, lives[0]?.record ?? null);
    }
    const written = await this.#writeStop(stop, STOP_WRITE_ATTEMPTS);
    if (written === null) {
      this.#scheduleStopRetry(stop);
      return error(503, 'dependency_unavailable', requestId);
    }
    if (written === 'rejected') return error(401, 'unauthenticated', requestId);
    const reach = ioStopReach(
      written.map((state) => ({
        device_id: state.device_id,
        requester: state.device_id === device.device_id,
        lease_expires_at_mono_ms: this.#latestExpiry(state.device_id),
      })),
      this.#monoNow(),
    );
    const own = written.find((state) => state.device_id === device.device_id);
    return {
      status: 202,
      body: {
        scope,
        io_epoch: own?.io_epoch ?? '0',
        devices: reach.devices,
        all_confirmed: reach.all_confirmed,
      },
    };
  }

  // 停止を DB へ書く。書けたら停止中の印を外し、知っている世代を DB の値にそろえる。書けなければ null。
  async #writeStop(
    stop: PendingStop,
    attempts: number,
  ): Promise<readonly DeviceVoiceState[] | 'rejected' | null> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await this.#store
        .voice({
          kind: 'voice.stop',
          scope: stop.scope,
          device_id: stop.device_id,
          now: stop.at,
        })
        .catch(() => null);
      if (result?.ok === true) {
        this.#removePendingStop(stop);
        for (const state of result.value.devices)
          this.#known.set(state.device_id, state);
        return result.value.devices;
      }
      if (
        result !== null &&
        !result.ok &&
        (result.reasons.includes('device_revoked') ||
          result.reasons.includes('device_not_found'))
      ) {
        // 失効した端末の停止は書かない。メモリーで止めた分はそのまま（安全側）だが、印は外す。
        this.#removePendingStop(stop);
        return 'rejected';
      }
    }
    return null;
  }

  #removePendingStop(stop: PendingStop): void {
    const index = this.#pendingStops.indexOf(stop);
    if (index !== -1) this.#pendingStops.splice(index, 1);
    if (stop.retry !== null) this.#timers.clear(stop.retry);
    stop.retry = null;
  }

  #scheduleStopRetry(stop: PendingStop): void {
    if (this.#closed) return;
    this.#log(
      '停止を DB へ書けませんでした。停止中の印を保ったまま再試行します。',
    );
    stop.retry = this.#timers.set(VOICE_PERSIST_RETRY_MS, () => {
      stop.retry = null;
      const retried = this.#writeStop(stop, 1).then((written) => {
        if (written === null) this.#scheduleStopRetry(stop);
      });
      this.#inflight.add(retried);
      void retried.finally(() => this.#inflight.delete(retried));
    });
  }

  resumeIo(
    device: DeviceRecord,
    body: JsonObject,
    lock: DeclaredLockState | null,
  ): Promise<Status> {
    return this.#exclusive(async () => {
      const requestId = str(body, 'request_id');
      // DB へ書けていない停止があるうちは再開しない（後から書けた停止が再開を上書きしないように）。
      if (this.#pendingStops.length > 0)
        return error(503, 'dependency_unavailable', requestId);
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

  // 受付の判定（所有者・停止・リース・同意など）。外部を待たない値だけで決める。拒否なら応答、受けるならリース。
  #liveAdmission(
    device: DeviceRecord,
    state: DeviceVoiceState,
    body: JsonObject,
    consent: ConsentStatus,
    requestId: string,
  ): Status | LeaseEntry {
    const lease = this.#leases.get(device.device_id)?.get('audio');
    const owner = this.audioOwner(device);
    // 古い世代・期限切れ・取り消し・別の接続範囲・すでに Live を開いたリースでは開かない（07 §5）。
    const leaseValid =
      lease !== undefined &&
      owner === 'self' &&
      this.#leaseLive(lease) &&
      lease.io_epoch === state.io_epoch &&
      lease.command_scope_id === str(body, 'command_scope_id') &&
      lease.opened === null;
    const admission = admitLiveStart({
      purpose: body['purpose'] as 'conversation' | 'notification',
      audioOwner: owner,
      ioSuspended: this.#suspended(state),
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
    // 中枢で同時に開いてよい Live は 1 つ（端末の交代でも、前の Live の閉じる要求の後）。受付の途中の端末も数える。
    if (
      [...this.#lives.values()].some(
        (runtime) => runtime.record.closure === 'open',
      ) ||
      this.#opening.size > 0
    )
      return error(409, 'conflict', requestId);
    return lease as LeaseEntry;
  }

  async createLiveSession(
    device: DeviceRecord,
    body: JsonObject,
  ): Promise<Status> {
    const requestId = str(body, 'request_id');
    const provider = this.#provider;
    const budget = this.#budget;
    // 同意は外部の値なので、受付の列の外で期限を付けて読む（読めなければ missing）。
    const consent = await this.#within(VOICE_EXTERNAL_TIMEOUT_MS, () =>
      this.#consent(device.device_id),
    );
    const consentStatus: ConsentStatus =
      consent === TIMED_OUT ? 'missing' : consent;
    // 1 段目: 受付の判定と、受付の途中の印（短い。外部を待たない）。
    const first = await this.#exclusive(async (): Promise<Status | null> => {
      let state: DeviceVoiceState | null;
      try {
        state = await this.#freshState(device.device_id);
      } catch {
        return error(503, 'dependency_unavailable', requestId);
      }
      if (state === null) return error(401, 'unauthenticated', requestId);
      const admitted = this.#liveAdmission(
        device,
        state,
        body,
        consentStatus,
        requestId,
      );
      if ('status' in admitted) return admitted;
      if (provider === null || budget === null)
        return error(503, 'dependency_unavailable', requestId);
      this.#opening.add(device.device_id);
      return null;
    });
    if (first !== null) return first;
    try {
      return await this.#openLive(
        device,
        body,
        requestId,
        provider as LiveProvider,
        budget as LiveBudgetPort,
        consentStatus,
      );
    } finally {
      this.#opening.delete(device.device_id);
    }
  }

  async #openLive(
    device: DeviceRecord,
    body: JsonObject,
    requestId: string,
    provider: LiveProvider,
    budget: LiveBudgetPort,
    consent: ConsentStatus,
  ): Promise<Status> {
    const sessionId = str(body, 'session_id');
    const session = await this.#store
      .conversation({ kind: 'session.get', session_id: sessionId })
      .catch(() => null);
    if (session === null || !session.ok)
      return error(503, 'dependency_unavailable', requestId);
    if (session.value === null || session.value.ended_at !== null)
      return error(409, 'conflict', requestId);
    // 外部の待ち（予算の門）は列の外で、期限を付ける。切れたら結果不明（予約ができたかは門の照合に任せる）。
    const reserved = await this.#within(VOICE_EXTERNAL_TIMEOUT_MS, () =>
      budget.reserve({
        request_id: requestId,
        seconds: LIVE_INITIAL_RESERVE_SECONDS,
      }),
    );
    if (reserved === TIMED_OUT)
      return error(503, 'dependency_unavailable', requestId);
    if (!reserved.ok)
      return reserved.budget_held
        ? error(422, 'budget_held', requestId)
        : error(503, 'dependency_unavailable', requestId);
    const ticket = reserved.ticket;
    const dispatched = await this.#within(VOICE_EXTERNAL_TIMEOUT_MS, () =>
      budget.dispatch(ticket),
    );
    if (dispatched === TIMED_OUT || !dispatched.ok) {
      // 期限切れ・成否不明は送出意図を記録したかもしれない（解放しない）。
      if (dispatched === TIMED_OUT || dispatched.uncertain)
        this.#budgetLater(null, () => budget.hold(ticket));
      else this.#budgetLater(null, () => budget.release(ticket));
      return error(503, 'dependency_unavailable', requestId);
    }
    // 2 段目: 外部を待っている間に停止・交代・期限切れがあれば開かない。世代を発行して記録する。
    const second = await this.#exclusive(
      async (): Promise<Status | LiveRuntime> => {
        let state: DeviceVoiceState | null;
        try {
          state = await this.#freshState(device.device_id);
        } catch {
          return error(503, 'dependency_unavailable', requestId);
        }
        if (state === null) return error(401, 'unauthenticated', requestId);
        this.#opening.delete(device.device_id);
        const admitted = this.#liveAdmission(
          device,
          state,
          body,
          consent,
          requestId,
        );
        if ('status' in admitted) return admitted;
        const lease = admitted;
        const event: LiveEpochEvent = lease.via_takeover
          ? 'device_move'
          : 'live_start';
        const issued = issueLiveEpochs(
          {
            audio_epoch: state.audio_epoch,
            session_epoch: state.session_epoch,
            control_epoch: '0',
          },
          event,
        );
        const liveSessionId = this.#newId();
        const opened = await this.#store
          .voice({
            kind: 'voice.live_open',
            live_session_id: liveSessionId,
            device_id: device.device_id,
            session_id: sessionId,
            purpose: body['purpose'] as 'conversation' | 'notification',
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
          })
          .catch(() => null);
        if (opened === null || !opened.ok)
          return error(503, 'dependency_unavailable', requestId);
        this.#known.set(device.device_id, {
          ...state,
          audio_epoch: opened.value.audio_epoch,
          session_epoch: opened.value.session_epoch,
        });
        const live: OpenedLive = {
          live_session_id: liveSessionId,
          outcome: 'open',
        };
        lease.opened = live;
        const runtime: LiveRuntime = {
          record: opened.value,
          persisted: valuesOf(opened.value),
          persisting: null,
          retryTimer: null,
          opened: live,
          ticket,
          provider_session_id: null,
          sideband: null,
          connectTimer: null,
          pingTimer: null,
          deadlineTimer: null,
          confirmTimer: null,
          lost: false,
          settled: false,
          budgetChain: Promise.resolve(),
        };
        this.#lives.set(liveSessionId, runtime);
        return runtime;
      },
    );
    if ('status' in second) {
      // 送出意図を記録した後なので解放しない（ADR 0037）。
      this.#budgetLater(null, () => budget.hold(ticket));
      return second;
    }
    const runtime = second;
    const created = await this.#within(LIVE_CREATE_TIMEOUT_MS, () =>
      provider.createSession({
        live_session_id: runtime.record.live_session_id,
        purpose: runtime.record.purpose,
        sdp_offer: str(body, 'sdp_offer'),
      }),
    );
    if (created === TIMED_OUT || !created.ok) {
      // 送った可能性がある。送り直さず、終了未確認として予約を保持する。
      this.#step(runtime, 'close_requested', null, 'provider_failure');
      this.#markUnconfirmed(runtime);
      return error(503, 'dependency_unavailable', requestId);
    }
    runtime.provider_session_id = created.provider_session_id;
    if (runtime.record.closure !== 'open') {
      // 作成の途中で停止・交代・期限切れが来た。閉じるためだけに接続して session.close を送る。
      this.#closeOnlyReconnect(runtime);
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

  // 端末からの終了の通知（いつでも受け付ける）。使用秒数が確認できるまで予約を精算済みにしない。
  async closeLiveSession(
    device: DeviceRecord,
    liveSessionId: string,
    body: JsonObject,
  ): Promise<Status> {
    const requestId = str(body, 'request_id');
    const runtime = this.#lives.get(liveSessionId);
    let record = runtime?.record ?? this.#finished.get(liveSessionId) ?? null;
    if (record === null) {
      const found = await this.#store
        .voice({ kind: 'voice.live_get', live_session_id: liveSessionId })
        .catch(() => null);
      if (found === null || !found.ok)
        return error(503, 'dependency_unavailable', requestId);
      record = found.value;
    }
    if (record === null || record.device_id !== device.device_id)
      return error(404, 'invalid_input', requestId);
    if (record.audio_epoch !== str(body, 'audio_epoch'))
      return error(409, 'conflict', requestId);
    if (runtime !== undefined && runtime.record.closure === 'open')
      this.#beginClose(runtime, str(body, 'reason'));
    return {
      status: 202,
      body: liveControlState(runtime?.record ?? record),
    };
  }

  // ---- 制御接続（サイドバンド） ---------------------------------------------------------------------------------

  // 予算の門の呼び出しを、Live ごとに 1 つずつ・期限つきで行う（応答を待たない）。
  #budgetLater(runtime: LiveRuntime | null, run: () => Promise<void>): void {
    const call = () =>
      this.#within(VOICE_EXTERNAL_TIMEOUT_MS, run)
        .then((value) => {
          if (value === TIMED_OUT)
            this.#log('予算の門の応答が期限までにありませんでした。');
        })
        .catch(() => undefined);
    const track = (promise: Promise<void>) => {
      this.#inflight.add(promise);
      void promise.finally(() => this.#inflight.delete(promise));
    };
    if (runtime === null) {
      track(call());
      return;
    }
    runtime.budgetChain = runtime.budgetChain.then(call, call);
    track(runtime.budgetChain);
  }

  // nextLiveControl で次の状態を決め、まずメモリーの状態を変える（判定と副作用はこの値で行う）。DB へは後から書く。
  #step(
    runtime: LiveRuntime,
    trigger: LiveControlTrigger,
    usageSeconds: number | null = null,
    endReason: string | null = null,
  ): boolean {
    const next = nextLiveControl(
      controlOf(runtime.record),
      trigger,
      usageSeconds,
    );
    if (!next.ok) return false;
    const closed = next.next.control_state === 'closed';
    runtime.record = {
      ...runtime.record,
      ...valuesOf(next.next),
      end_reason: runtime.record.end_reason ?? endReason,
      ended_at: closed
        ? (runtime.record.ended_at ?? this.#wallNow())
        : runtime.record.ended_at,
    };
    if (
      trigger === 'sideband_connect_failed' ||
      trigger === 'sideband_disconnected' ||
      trigger === 'ping_timeout' ||
      trigger === 'core_restarted'
    )
      runtime.lost = true;
    if (closed && runtime.opened.outcome === 'open')
      runtime.opened.outcome = runtime.lost ? 'lost' : 'normal';
    void this.#persist(runtime);
    return true;
  }

  // メモリーの状態を DB へ compare-and-set で書く（途中の状態は飛ばして今の値を書く。trigger が戻す更新を拒否する）。
  // 書けなければ間隔を置いて再試行する。応答を失って DB が先に進んでいれば、DB の値を書けた値として読み直す。
  #persist(runtime: LiveRuntime): Promise<void> {
    if (runtime.persisting !== null) return runtime.persisting;
    if (runtime.retryTimer !== null) {
      this.#timers.clear(runtime.retryTimer);
      runtime.retryTimer = null;
    }
    const run = async () => {
      while (!sameValues(runtime.persisted, valuesOf(runtime.record))) {
        const target = valuesOf(runtime.record);
        const updated = await this.#store
          .voice({
            kind: 'voice.live_update',
            live_session_id: runtime.record.live_session_id,
            expected: runtime.persisted,
            next: target,
            ended_at: runtime.record.ended_at,
            end_reason: runtime.record.end_reason,
          })
          .catch(() => null);
        if (updated !== null && updated.ok) {
          runtime.persisted = target;
          continue;
        }
        if (
          updated !== null &&
          !updated.ok &&
          updated.reasons.includes('live_state_conflict')
        ) {
          const found = await this.#store
            .voice({
              kind: 'voice.live_get',
              live_session_id: runtime.record.live_session_id,
            })
            .catch(() => null);
          if (found !== null && found.ok && found.value !== null) {
            runtime.persisted = valuesOf(found.value);
            continue;
          }
        }
        this.#log('Live の制御の状態を DB へ書けませんでした。再試行します。');
        if (!this.#closed)
          runtime.retryTimer = this.#timers.set(VOICE_PERSIST_RETRY_MS, () => {
            runtime.retryTimer = null;
            void this.#persist(runtime);
          });
        return;
      }
      this.#retire(runtime);
    };
    runtime.persisting = run().finally(() => {
      runtime.persisting = null;
    });
    return runtime.persisting;
  }

  // 閉じ終え、DB へ書け、予算の扱いを決めた Live をメモリーから外す（終わった記録は少しだけ残す）。
  // 外した後も、サイドバンドの受け口は Live を持ち続けるので、遅れて届いた使用秒数で照合できる。
  #retire(runtime: LiveRuntime): void {
    const record = runtime.record;
    if (record.control_state !== 'closed') return;
    if (!sameValues(runtime.persisted, valuesOf(record))) return;
    if (!this.#lives.has(record.live_session_id)) {
      this.#finished.set(record.live_session_id, record);
      return;
    }
    this.#lives.delete(record.live_session_id);
    this.#finished.set(record.live_session_id, record);
    while (this.#finished.size > FINISHED_KEPT) {
      const oldest = this.#finished.keys().next().value as string;
      this.#finished.delete(oldest);
    }
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
      onSessionClosed: (usage) => this.#onSessionClosed(runtime, usage),
      onDisconnected: () => {
        if (handleRef.handle !== runtime.sideband) return;
        this.#onLost(
          runtime,
          runtime.record.control_state === 'connecting'
            ? 'sideband_connect_failed'
            : 'sideband_disconnected',
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
          this.#onLost(runtime, 'sideband_connect_failed');
      },
    );
    void provider
      .connectSideband(
        runtime.provider_session_id as string,
        this.#handlers(runtime, ref),
      )
      .catch(() => null)
      .then((handle) => {
        if (runtime.connectTimer !== null) {
          this.#timers.clear(runtime.connectTimer);
          runtime.connectTimer = null;
        }
        if (handle === null) {
          if (runtime.record.control_state === 'connecting')
            this.#onLost(runtime, 'sideband_connect_failed');
          return;
        }
        if (runtime.record.control_state !== 'connecting') {
          // 期限の後に接続できた・閉じ始めた後。閉じる手順は閉じるためだけの再接続が受け持つので、この接続は使わない。
          handle.terminate();
          return;
        }
        ref.handle = handle;
        runtime.sideband = handle;
        if (!this.#step(runtime, 'sideband_connected')) return;
        this.#armDeadline(runtime);
        runtime.pingTimer = this.#timers.set(SIDEBAND_PING_INTERVAL_MS, () =>
          this.#ping(runtime),
        );
        const deviceId = runtime.record.device_id;
        this.#emit(deviceId, {
          schema: 'buddy.voice-event.v1',
          event_id: this.#newId(),
          event_type: 'sideband_connected',
          device_id: deviceId,
          session_id: runtime.record.session_id,
          live_session_id: runtime.record.live_session_id,
          audio_epoch: runtime.record.audio_epoch,
          control_epoch: runtime.record.control_epoch,
          candidate_ids: [],
          audio_control: null,
          occurred_at: new Date(this.#wallNow()).toISOString(),
        });
      });
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
        this.#onLost(runtime, 'ping_timeout');
    });
  }

  // lost: control_epoch を進め（nextLiveControl）、新規の委譲・読み上げを止め、音声リースを更新しない（sideband_lost）。
  // 停止のイベントを送り、閉じるためだけの再接続を 1 回試す（10 §2A）。DB の書込みを待たない。
  #onLost(
    runtime: LiveRuntime,
    trigger:
      'sideband_connect_failed' | 'sideband_disconnected' | 'ping_timeout',
  ): void {
    if (!this.#step(runtime, trigger)) return;
    const old = runtime.sideband;
    runtime.sideband = null;
    old?.terminate();
    this.#clearTimers(runtime);
    this.#emitAudioControl(
      runtime.record.device_id,
      'sideband_lost',
      runtime.record,
    );
    if (!this.#step(runtime, 'close_requested', null, 'sideband_lost')) return;
    this.#closeOnlyReconnect(runtime);
  }

  // 閉じるためだけのサイドバンドの再接続（1 回・3 秒まで）。接続できたら session.close を送って終了を待つ。
  // できなければ終了未確認にして予約を保持する（端末側の停止は待たせない）。
  #closeOnlyReconnect(runtime: LiveRuntime): void {
    const provider = this.#provider;
    const sessionId = runtime.provider_session_id;
    if (provider === null || sessionId === null) {
      this.#markUnconfirmed(runtime);
      return;
    }
    const ref: { handle: LiveSideband | null } = { handle: null };
    let done = false;
    const timer = this.#timers.set(SIDEBAND_CLOSE_RECONNECT_MS, () => {
      if (done) return;
      done = true;
      this.#markUnconfirmed(runtime);
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
        if (handle === null) {
          this.#markUnconfirmed(runtime);
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
  }

  // 中枢から閉じ始める。閉じる要求をメモリーに記録し、サイドバンドが使えれば session.close を送る（lost なら再接続を試す）。
  // 終了の確認（session.closed）と DB の書込みは待たない（停止を遅らせない）。
  #beginClose(runtime: LiveRuntime, reason: string): void {
    if (runtime.record.closure !== 'open') return;
    const wasLost = runtime.record.control_state === 'lost';
    if (!this.#step(runtime, 'close_requested', null, reason)) return;
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
    // provider のセッションがまだない（作成中）なら、作成の応答の後に閉じるためだけに接続する（createLiveSession）。
    if (runtime.provider_session_id === null) return;
    this.#closeOnlyReconnect(runtime);
  }

  #armConfirm(runtime: LiveRuntime): void {
    if (runtime.confirmTimer !== null) this.#timers.clear(runtime.confirmTimer);
    runtime.confirmTimer = this.#timers.set(CORE_CLOSE_CONFIRM_MS, () => {
      runtime.confirmTimer = null;
      this.#markUnconfirmed(runtime);
    });
  }

  // 終了・使用秒数を確認できない。予約を解放せず保持する（10 §2A）。
  #markUnconfirmed(runtime: LiveRuntime): void {
    if (runtime.record.control_state !== 'closing') return;
    if (!this.#step(runtime, 'close_unconfirmed')) return;
    this.#clearTimers(runtime);
    const budget = this.#budget;
    if (budget !== null && runtime.ticket !== null)
      this.#budgetLater(runtime, () => budget.hold(runtime.ticket));
  }

  #onSessionClosed(runtime: LiveRuntime, usage: number | null): void {
    if (usage === null) {
      // 使用秒数のない終了は断線として扱う（精算しない）。
      if (runtime.record.control_state === 'ready')
        this.#onLost(runtime, 'sideband_disconnected');
      else if (runtime.record.control_state === 'connecting')
        this.#onLost(runtime, 'sideband_connect_failed');
      return;
    }
    const providerFirst =
      runtime.record.closure === 'open' &&
      runtime.record.control_state !== 'lost';
    if (
      !this.#step(runtime, 'session_closed_received', usage, 'provider_failure')
    )
      return;
    this.#clearTimers(runtime);
    runtime.sideband?.terminate();
    runtime.sideband = null;
    const settlement = settleLiveSeconds(usage, LIVE_INITIAL_RESERVE_SECONDS);
    const budget = this.#budget;
    if (
      settlement.settled &&
      budget !== null &&
      runtime.ticket !== null &&
      !runtime.settled
    ) {
      runtime.settled = true;
      this.#budgetLater(runtime, () =>
        budget.settle(runtime.ticket, settlement.billable_seconds),
      );
    }
    // provider が先に閉じた。端末へ close_voice_session（provider_failure）を送る（ADR 0038）。
    if (providerFirst)
      this.#emitAudioControl(
        runtime.record.device_id,
        'provider_failure',
        runtime.record,
      );
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
        persisted: valuesOf(record),
        persisting: null,
        retryTimer: null,
        opened: { live_session_id: record.live_session_id, outcome: 'open' },
        ticket: null,
        provider_session_id: null,
        sideband: null,
        connectTimer: null,
        pingTimer: null,
        deadlineTimer: null,
        confirmTimer: null,
        lost: false,
        settled: false,
        budgetChain: Promise.resolve(),
      };
      if (
        record.control_state === 'connecting' ||
        record.control_state === 'ready'
      )
        this.#step(runtime, 'core_restarted');
      if (runtime.record.closure === 'open')
        this.#step(runtime, 'close_requested', null, 'core_lease_lost');
      if (runtime.record.control_state === 'closing')
        this.#step(runtime, 'close_unconfirmed');
      await this.#persist(runtime);
      // 書けなかったものは、再試行の間もメモリーに置く（閉じ終えた記録として扱う）。
      if (!sameValues(runtime.persisted, valuesOf(runtime.record)))
        this.#lives.set(record.live_session_id, runtime);
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
      if (runtime.retryTimer !== null) this.#timers.clear(runtime.retryTimer);
      runtime.retryTimer = null;
      runtime.sideband?.terminate();
      runtime.sideband = null;
    }
    for (const stop of this.#pendingStops)
      if (stop.retry !== null) this.#timers.clear(stop.retry);
    for (const byKind of this.#leases.values())
      for (const entry of byKind.values()) this.#timers.clear(entry.expiry);
  }

  // 試験・診断用。Live の今の記録（終わって外したものは、残している範囲で返す）。
  liveRecord(liveSessionId: string): LiveSessionRecord | null {
    return (
      this.#lives.get(liveSessionId)?.record ??
      this.#finished.get(liveSessionId) ??
      null
    );
  }

  // 試験・診断用。メモリーに置いている Live の数（終わったものは外す）。
  get liveCount(): number {
    return this.#lives.size;
  }

  // 試験・診断用。受付の列・DB の書込み・予算の門の呼び出しが落ち着くまで待つ（再試行のタイマーは待たない）。
  async idle(): Promise<void> {
    await this.#serial.catch(() => undefined);
    for (const runtime of [...this.#lives.values()])
      await runtime.persisting?.catch(() => undefined);
    await Promise.all([...this.#inflight]).catch(() => undefined);
  }
}
