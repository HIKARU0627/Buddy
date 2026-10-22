// 端末側の接続の状態機械（設計 07 §2〜§4、02 端末登録と接続、ADR 0023・0025）。
//
//   bootstrap → スナップショット → 購読（WSS） → （切断・再スナップショットの要求）→ bootstrap …
//
// - bootstrap ごとに新しい接続範囲（command_scope_id）を受け取る。再接続では必ず取り直す（07 §3）。
// - API の major が合わなければ使わない（upgrade_required。以後は要求を送らない）。
// - DB 世代が同じで cursor があれば、スナップショットを省いて cursor から購読し、欠けたイベントを受け取る。
//   世代が違う・中枢が再スナップショットを求めた・cursor が使えないときはスナップショットから始める。
// - イベントは domain の applyEvents で反映し（重複・古い版を捨てる）、版が進んだ操作は getOperation で
//   表示用の値を取り直す（イベントは ID と版だけで本文・状態を持たない。ADR 0023）。
// - 切断中の命令はためない。送れる状態（live）でなければその場で not_sent を返し、復帰しても送らない。
// - 401・証明書の不一致・失効（4401）は再登録が必要（以後は要求を送らない）。自宅の外（403・4403）・
//   接続できない・中枢の停止などは間隔を空けて接続し直す。
// Node・DOM・Electron の API を使わない。通信・時計・形式の検査は transport.ts の境界から受け取る。

import type {
  Bootstrap,
  CommandReceipt,
  EventEnvelope,
  OperationSnapshot,
  Snapshot,
} from '@buddy/contracts';
import { applyEvents } from '@buddy/domain';
import type { ClientView } from '@buddy/domain';
import { checkApiVersion } from './api-version.js';
import { DEFAULT_BACKOFF, reconnectDelay } from './backoff.js';
import type { BackoffPolicy } from './backoff.js';
import type {
  CancelTimer,
  ClientApiOutcome,
  ClientClock,
  ClientContract,
  ClientLockState,
  ClientStreamEvent,
  ClientStreamHandle,
  ClientTransport,
} from './transport.js';

export type LinkPhase =
  // start の前。
  | 'idle'
  | 'bootstrapping'
  | 'snapshotting'
  | 'subscribing'
  // 購読中。命令を送れるのはこの間だけ。
  | 'live'
  // 間隔を空けて接続し直す。
  | 'waiting_retry'
  // 中枢の API の major が違う。使わない。
  | 'upgrade_required'
  // トークンが無効・失効・中枢の証明書が違う。再登録が要る。
  | 'reregistration_required'
  | 'stopped';

export type LinkReason =
  | 'unreachable'
  | 'outside_home_network'
  | 'rate_limited'
  | 'dependency_unavailable'
  | 'protocol_error'
  | 'core_stopping'
  | 'slow_consumer'
  | 'stream_closed'
  | 'alive_timeout'
  | 'resnapshot'
  | 'unauthenticated'
  | 'device_revoked'
  | 'certificate_mismatch'
  | 'api_major_mismatch';

// 状態欄の「中枢との接続」（DesktopStatusBar.hub_connection）。
export type HubConnection = 'connected' | 'unreachable' | 'not_connected';

export interface LinkState {
  readonly phase: LinkPhase;
  // 直近の失敗・切断の理由（live になれば null）。
  readonly reason: LinkReason | null;
  // 連続した失敗の回数（再接続の間隔に使う）。
  readonly attempt: number;
  readonly retryAt: number | null;
  // 中枢からの応答・メッセージ・ping を最後に受け取った時刻（UTC のミリ秒）。
  readonly lastConfirmedAt: number | null;
  readonly apiVersion: string | null;
  readonly coreInstanceId: string | null;
  readonly storeGeneration: string | null;
  readonly deviceId: string | null;
  readonly commandScopeId: string | null;
  // スナップショットの表示の範囲。ロック中・ロック状態不明は management_only で操作を持たない。
  readonly view: 'full' | 'management_only' | null;
  readonly cursor: string | null;
  // 操作の表示用の値（operation_id の順）。view が full のときだけ中身がある。
  readonly operations: readonly OperationSnapshot[];
}

export function hubConnectionOf(state: LinkState): HubConnection {
  if (state.phase === 'live') return 'connected';
  if (
    state.phase === 'idle' ||
    state.phase === 'stopped' ||
    state.phase === 'reregistration_required' ||
    state.phase === 'upgrade_required'
  )
    return 'not_connected';
  // 最初の接続の途中（まだ一度も応答がなく、失敗もしていない）は接続していない扱い。
  if (
    state.phase !== 'waiting_retry' &&
    state.reason === null &&
    state.lastConfirmedAt === null
  )
    return 'not_connected';
  return 'unreachable';
}

export type ClientCommand =
  | {
      // cancel は取消の要求、reconcile は照合の要求（参照だけ。書込みを増やさない。再送ではない）。
      // retry は、実行されなかったと確定した操作の本人の明示の再試行（画面操作）。
      readonly kind: 'cancel' | 'reconcile' | 'retry';
      readonly operationId: string;
      readonly expectedStateRevision: string;
      // 本人が操作したときに見ていた接続範囲。今の接続範囲と違えば送らない。
      readonly commandScopeId?: string;
    }
  | {
      readonly kind: 'approve';
      readonly operationId: string;
      readonly previewId: string;
      readonly contentVersion: string;
      readonly contentHash: string;
      readonly expectedStateRevision: string;
      readonly commandScopeId?: string;
    };

export type CommandOutcome =
  // 送っていない。切断中・接続範囲の変更・ロック中。後で自動では送らない。
  | {
      readonly kind: 'not_sent';
      readonly reason: 'not_connected' | 'scope_changed' | 'device_locked';
    }
  | {
      readonly kind: 'accepted';
      readonly requestId: string;
      readonly receipt: CommandReceipt;
    }
  | {
      readonly kind: 'rejected';
      readonly requestId: string;
      readonly status: number;
      readonly code: string | null;
    }
  // 送った後に結果が分からない。自動で再送しない（同じ request_id で本人が確かめる）。
  | { readonly kind: 'unknown'; readonly requestId: string };

export interface ClientConnectionOptions {
  readonly transport: ClientTransport;
  readonly clock: ClientClock;
  readonly contract: ClientContract;
  readonly backoff?: BackoffPolicy;
  // 中枢の ping（15 秒）を受け取らないまま、この時間が過ぎたら切れたとみなす。
  readonly aliveTimeoutMs?: number;
  // 受け取ったイベント ID を覚えておく数（重複の判定）。
  readonly seenEventLimit?: number;
  readonly lockState?: ClientLockState;
}

export const DEFAULT_ALIVE_TIMEOUT_MS = 45_000;
const DEFAULT_SEEN_EVENT_LIMIT = 1_000;
// 再スナップショットの要求が続いたときは、2 回目から間隔を空ける。
const IMMEDIATE_RESNAPSHOTS = 1;

const INITIAL_STATE: LinkState = {
  phase: 'idle',
  reason: null,
  attempt: 0,
  retryAt: null,
  lastConfirmedAt: null,
  apiVersion: null,
  coreInstanceId: null,
  storeGeneration: null,
  deviceId: null,
  commandScopeId: null,
  view: null,
  cursor: null,
  operations: [],
};

const TERMINAL: ReadonlySet<LinkPhase> = new Set([
  'upgrade_required',
  'reregistration_required',
  'stopped',
]);

type Failure =
  | { readonly kind: 'retry'; readonly reason: LinkReason }
  | {
      readonly kind: 'terminal';
      readonly phase: 'reregistration_required' | 'upgrade_required';
      readonly reason: LinkReason;
    }
  | { readonly kind: 'resnapshot' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function errorCode(body: unknown): string | null {
  return isRecord(body) && typeof body['code'] === 'string'
    ? body['code']
    : null;
}

// HTTP の拒否の分類。401 は再登録、自宅の外・頻度・中枢の不調は間隔を空けて接続し直す。
function httpFailure(status: number, body: unknown): Failure {
  const code = errorCode(body);
  if (status === 401)
    return {
      kind: 'terminal',
      phase: 'reregistration_required',
      reason: 'unauthenticated',
    };
  if (status === 403 && code === 'outside_home_network')
    return { kind: 'retry', reason: 'outside_home_network' };
  if (status === 429) return { kind: 'retry', reason: 'rate_limited' };
  if (status === 503)
    return { kind: 'retry', reason: 'dependency_unavailable' };
  return { kind: 'retry', reason: 'protocol_error' };
}

function outcomeFailure(
  outcome: Exclude<ClientApiOutcome, { kind: 'response' }>,
): Failure {
  if (outcome.kind === 'certificate_mismatch')
    return {
      kind: 'terminal',
      phase: 'reregistration_required',
      reason: 'certificate_mismatch',
    };
  return { kind: 'retry', reason: 'unreachable' };
}

// WSS の閉じるコード（ADR 0023 の表）。
function closeFailure(code: number): Failure {
  switch (code) {
    case 4410:
      return { kind: 'resnapshot' };
    case 4401:
      return {
        kind: 'terminal',
        phase: 'reregistration_required',
        reason: 'device_revoked',
      };
    case 4403:
      return { kind: 'retry', reason: 'outside_home_network' };
    case 1001:
      return { kind: 'retry', reason: 'core_stopping' };
    case 1011:
      return { kind: 'retry', reason: 'dependency_unavailable' };
    case 1013:
      return { kind: 'retry', reason: 'slow_consumer' };
    default:
      return { kind: 'retry', reason: 'stream_closed' };
  }
}

const byOperationId = (a: OperationSnapshot, b: OperationSnapshot) =>
  a.operation_id < b.operation_id
    ? -1
    : a.operation_id > b.operation_id
      ? 1
      : 0;

export class ClientConnection {
  readonly #options: ClientConnectionOptions;
  readonly #listeners = new Set<(state: LinkState) => void>();
  #state: LinkState = INITIAL_STATE;
  // 接続の試み・購読ごとに進める。古い試みの応答・切断は無視する。
  #generation = 0;
  #stream: ClientStreamHandle | null = null;
  #retryTimer: CancelTimer | null = null;
  #aliveTimer: CancelTimer | null = null;
  #lockState: ClientLockState;
  // スナップショットを取ったときのロック状態（解除済みか）。変われば取り直す。
  #viewUnlocked = false;
  #events: ClientView | null = null;
  readonly #operations = new Map<string, OperationSnapshot>();
  // 版が進んだので表示用の値を取り直す操作。
  readonly #refreshing = new Set<string>();
  #resnapshots = 0;

  constructor(options: ClientConnectionOptions) {
    this.#options = options;
    this.#lockState = options.lockState ?? 'unknown';
  }

  get state(): LinkState {
    return this.#state;
  }

  get lockState(): ClientLockState {
    return this.#lockState;
  }

  onChange(listener: (state: LinkState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#state.phase !== 'idle') return;
    void this.#connect();
  }

  // 接続を閉じて止める。以後は start できない（作り直す）。
  stop(): void {
    if (this.#state.phase === 'stopped') return;
    this.#generation += 1;
    this.#closeStream();
    this.#clearRetry();
    this.#clearAlive();
    this.#update({ phase: 'stopped', retryAt: null });
  }

  // 待ちの間隔を飛ばしてすぐに接続し直す（ネットワークの変化・自宅の判定が通った後など）。
  retryNow(): void {
    if (this.#state.phase !== 'waiting_retry') return;
    this.#clearRetry();
    void this.#connect();
  }

  // ロック状態が変わった。ロック・不明になったら操作の表示をすぐに捨て、解除・ロックのどちらでも
  // スナップショットを取り直す（中枢にも Buddy-Lock-State で伝わる）。
  // live でない間（購読の途中など）に変わった分は、live になった直後に取り直す（#subscribe）。
  setLockState(lockState: ClientLockState): void {
    if (lockState === this.#lockState) return;
    this.#lockState = lockState;
    const unlocked = lockState === 'unlocked';
    const shownUnlocked = this.#viewUnlocked;
    if (!unlocked) {
      // 表示はロック中のもの（management_only）に落とした。以後、解除されたら full を取り直す。
      this.#viewUnlocked = false;
      this.#operations.clear();
      this.#refreshing.clear();
      if (this.#state.view !== null)
        this.#update({ operations: [], view: 'management_only' });
    }
    if (this.#state.phase === 'live' && unlocked !== shownUnlocked) {
      const generation = this.#generation;
      void this.#snapshot(generation, false);
    }
  }

  // 命令を送る。live でなければ送らずに返し、ためない（07 §3）。
  async send(command: ClientCommand): Promise<CommandOutcome> {
    const state = this.#state;
    if (state.phase !== 'live' || state.commandScopeId === null)
      return { kind: 'not_sent', reason: 'not_connected' };
    if (
      command.commandScopeId !== undefined &&
      command.commandScopeId !== state.commandScopeId
    )
      return { kind: 'not_sent', reason: 'scope_changed' };
    if (this.#lockState !== 'unlocked')
      return { kind: 'not_sent', reason: 'device_locked' };
    const requestId = this.#options.clock.newRequestId();
    const base = {
      request_id: requestId,
      command_scope_id: state.commandScopeId,
      expected_state_revision: command.expectedStateRevision,
    };
    const path = `/v1/operations/${encodeURIComponent(command.operationId)}/${command.kind}`;
    const outcome = await this.#options.transport.request(
      command.kind === 'approve'
        ? {
            method: 'POST',
            path,
            screenOperation: true,
            lockState: this.#lockState,
            body: {
              ...base,
              preview_id: command.previewId,
              content_version: command.contentVersion,
              content_hash: command.contentHash,
            },
          }
        : {
            method: 'POST',
            path,
            lockState: this.#lockState,
            // 再試行は本人の画面操作（中枢が画面操作の印を検査する）。取消・照合は印を付けない。
            ...(command.kind === 'retry' ? { screenOperation: true } : {}),
            body: base,
          },
    );
    if (outcome.kind === 'certificate_mismatch') {
      this.#fail(this.#generation, outcomeFailure(outcome));
      return { kind: 'not_sent', reason: 'not_connected' };
    }
    if (outcome.kind === 'unreachable') return { kind: 'unknown', requestId };
    this.#confirmed();
    if (
      outcome.status === 202 &&
      this.#options.contract.valid('CommandReceipt', outcome.body)
    )
      return {
        kind: 'accepted',
        requestId,
        receipt: outcome.body as CommandReceipt,
      };
    if (outcome.status === 401)
      this.#fail(this.#generation, httpFailure(401, outcome.body));
    // 2xx でも形が契約に合わなければ結果は分からない扱い（自動で再送しない）。
    if (outcome.status >= 200 && outcome.status < 300)
      return { kind: 'unknown', requestId };
    return {
      kind: 'rejected',
      requestId,
      status: outcome.status,
      code: errorCode(outcome.body),
    };
  }

  // 中枢の画面の操作など、live のときだけ送る要求（B03-06）。scoped なら request_id と今の接続範囲を本文に入れる。
  // live でなければ送らずに返し、ためない。送った後に結果が分からなければ unknown（自動で再送しない）。
  async request(request: {
    readonly method: 'GET' | 'POST' | 'PUT';
    readonly path: string;
    readonly body?: Readonly<Record<string, unknown>>;
    readonly screenOperation?: boolean;
    readonly scoped?: boolean;
    // 本人が確かめたときの接続範囲。今の接続範囲と違えば（bootstrap をやり直した）送らない。
    readonly expectedScopeId?: string;
  }): Promise<
    | { readonly kind: 'not_sent'; readonly reason: 'not_connected' }
    | {
        readonly kind: 'response';
        readonly status: number;
        readonly body: unknown;
      }
    | { readonly kind: 'unknown' }
  > {
    const state = this.#state;
    if (state.phase !== 'live' || state.commandScopeId === null)
      return { kind: 'not_sent', reason: 'not_connected' };
    if (
      request.expectedScopeId !== undefined &&
      request.expectedScopeId !== state.commandScopeId
    )
      return { kind: 'not_sent', reason: 'not_connected' };
    const body =
      request.scoped === true
        ? {
            ...request.body,
            request_id: this.#options.clock.newRequestId(),
            command_scope_id: state.commandScopeId,
          }
        : request.body;
    const outcome = await this.#options.transport.request({
      method: request.method,
      path: request.path,
      lockState: this.#lockState,
      ...(request.screenOperation === true ? { screenOperation: true } : {}),
      ...(body === undefined ? {} : { body }),
    });
    if (outcome.kind === 'certificate_mismatch') {
      this.#fail(this.#generation, outcomeFailure(outcome));
      return { kind: 'not_sent', reason: 'not_connected' };
    }
    if (outcome.kind === 'unreachable') return { kind: 'unknown' };
    this.#confirmed();
    if (outcome.status === 401)
      this.#fail(this.#generation, httpFailure(401, outcome.body));
    return { kind: 'response', status: outcome.status, body: outcome.body };
  }

  // --- 接続の流れ ---

  async #connect(): Promise<void> {
    if (TERMINAL.has(this.#state.phase)) return;
    this.#generation += 1;
    const generation = this.#generation;
    this.#closeStream();
    this.#clearAlive();
    this.#update({ phase: 'bootstrapping', retryAt: null });
    const outcome = await this.#options.transport.request({
      method: 'GET',
      path: '/v1/bootstrap',
      lockState: this.#lockState,
    });
    if (generation !== this.#generation) return;
    if (outcome.kind !== 'response') {
      this.#fail(generation, outcomeFailure(outcome));
      return;
    }
    if (outcome.status !== 200) {
      this.#fail(generation, httpFailure(outcome.status, outcome.body));
      return;
    }
    if (!this.#options.contract.valid('Bootstrap', outcome.body)) {
      this.#fail(generation, { kind: 'retry', reason: 'protocol_error' });
      return;
    }
    const bootstrap = outcome.body as Bootstrap;
    if (checkApiVersion(bootstrap.api_version) !== 'compatible') {
      this.#update({ apiVersion: bootstrap.api_version });
      this.#fail(generation, {
        kind: 'terminal',
        phase: 'upgrade_required',
        reason: 'api_major_mismatch',
      });
      return;
    }
    this.#confirmed();
    const generationChanged =
      this.#state.storeGeneration !== null &&
      this.#state.storeGeneration !== bootstrap.store_generation;
    if (generationChanged) this.#dropView();
    this.#update({
      apiVersion: bootstrap.api_version,
      coreInstanceId: bootstrap.core_instance_id,
      storeGeneration: bootstrap.store_generation,
      deviceId: bootstrap.device_id,
      commandScopeId: bootstrap.command_scope_id,
    });
    const cursor = this.#state.cursor;
    const unlocked = this.#lockState === 'unlocked';
    if (
      cursor !== null &&
      this.#events !== null &&
      unlocked === this.#viewUnlocked
    )
      await this.#subscribe(generation, cursor);
    else await this.#snapshot(generation, true);
  }

  // subscribe が false なら購読を開き直さずに表示だけを取り直す（ロック状態の変化）。
  async #snapshot(generation: number, subscribe: boolean): Promise<void> {
    if (subscribe) this.#update({ phase: 'snapshotting' });
    const unlocked = this.#lockState === 'unlocked';
    const outcome = await this.#options.transport.request({
      method: 'GET',
      path: '/v1/snapshot',
      lockState: this.#lockState,
    });
    if (generation !== this.#generation) return;
    if (outcome.kind !== 'response') {
      this.#fail(generation, outcomeFailure(outcome));
      return;
    }
    if (outcome.status !== 200) {
      this.#fail(generation, httpFailure(outcome.status, outcome.body));
      return;
    }
    if (!this.#options.contract.valid('Snapshot', outcome.body)) {
      this.#fail(generation, { kind: 'retry', reason: 'protocol_error' });
      return;
    }
    const snapshot = outcome.body as Snapshot;
    // bootstrap の後に DB 世代が変わった・ロック状態が途中で変わった場合は取り直す。
    if (snapshot.store_generation !== this.#state.storeGeneration) {
      this.#fail(generation, { kind: 'resnapshot' });
      return;
    }
    if (unlocked !== (this.#lockState === 'unlocked')) {
      void this.#snapshot(generation, subscribe);
      return;
    }
    this.#confirmed();
    this.#viewUnlocked = unlocked;
    this.#operations.clear();
    this.#refreshing.clear();
    const full = snapshot.view === 'full' && unlocked;
    if (full)
      for (const operation of snapshot.operations)
        this.#operations.set(operation.operation_id, operation);
    // ロック中でもイベントの版は追う（表示はしない）。スナップショットの版から始める。
    this.#events = {
      store_generation: snapshot.store_generation,
      revisions: Object.fromEntries(
        snapshot.operations.map((operation) => [
          operation.operation_id,
          operation.state_revision,
        ]),
      ),
      seen_event_ids: [],
    };
    this.#update({
      view: full ? 'full' : 'management_only',
      cursor: snapshot.event_cursor,
      operations: this.#sortedOperations(),
    });
    if (subscribe) await this.#subscribe(generation, snapshot.event_cursor);
  }

  async #subscribe(generation: number, cursor: string): Promise<void> {
    this.#update({ phase: 'subscribing' });
    let opened = false;
    const pending: ClientStreamEvent[] = [];
    const listener = (event: ClientStreamEvent) => {
      if (generation !== this.#generation) return;
      // open の結果を受け取る前に届いたメッセージは、受け取った後に順に処理する。
      if (!opened) pending.push(event);
      else this.#onStreamEvent(generation, event);
    };
    const result = await this.#options.transport.openStream(
      cursor,
      this.#lockState,
      listener,
    );
    if (generation !== this.#generation) {
      if (result.kind === 'open') result.stream.close();
      return;
    }
    if (
      result.kind === 'certificate_mismatch' ||
      result.kind === 'unreachable'
    ) {
      this.#fail(generation, outcomeFailure(result));
      return;
    }
    if (result.kind === 'rejected') {
      // 中枢が発行した形でない cursor は 422。スナップショットからやり直す。
      if (result.status === 422) this.#fail(generation, { kind: 'resnapshot' });
      else this.#fail(generation, httpFailure(result.status, result.body));
      return;
    }
    this.#stream = result.stream;
    opened = true;
    this.#confirmed();
    this.#update({ phase: 'live', reason: null, attempt: 0, retryAt: null });
    this.#armAlive(generation);
    for (const event of pending.splice(0)) {
      if (generation !== this.#generation) return;
      this.#onStreamEvent(generation, event);
    }
    // 購読の途中でロック状態が変わり、表示の範囲が今のロック状態と合わなければ取り直す（購読は開き直さない）。
    if (
      generation === this.#generation &&
      (this.#lockState === 'unlocked') !== this.#viewUnlocked
    )
      void this.#snapshot(generation, false);
  }

  #onStreamEvent(generation: number, event: ClientStreamEvent): void {
    if (event.type === 'closed') {
      this.#stream = null;
      this.#fail(generation, closeFailure(event.code));
      return;
    }
    this.#confirmed();
    this.#armAlive(generation);
    if (event.type === 'alive') {
      // 購読が動いていると確かめられたので、再スナップショットの数を数え直す（ADR 0025）。
      // live になった時点では数え直さない（開いた直後にまた求められる繰り返しを、間隔なしで続けない）。
      this.#resnapshots = 0;
      return;
    }
    if (!this.#options.contract.valid('EventStreamMessage', event.data)) {
      this.#fail(generation, { kind: 'retry', reason: 'protocol_error' });
      return;
    }
    const message = event.data as
      | { type: 'event'; event: EventEnvelope }
      | { type: 'voice'; event: unknown }
      | { type: 'resnapshot_required'; reason: string };
    if (message.type === 'resnapshot_required') {
      this.#fail(generation, { kind: 'resnapshot' });
      return;
    }
    if (message.type === 'voice') return;
    this.#applyEvent(generation, message.event);
  }

  #applyEvent(generation: number, event: EventEnvelope): void {
    const view = this.#events;
    if (view === null) return;
    const result = applyEvents(view, [event]);
    if (result.resnapshot) {
      this.#fail(generation, { kind: 'resnapshot' });
      return;
    }
    const limit = this.#options.seenEventLimit ?? DEFAULT_SEEN_EVENT_LIMIT;
    this.#events = {
      ...result.view,
      seen_event_ids: result.view.seen_event_ids.slice(-limit),
    };
    this.#resnapshots = 0;
    this.#update({ cursor: event.event_cursor });
    if (result.applied.length > 0 && this.#state.view === 'full')
      void this.#refresh(generation, event.operation_id);
  }

  // 版が進んだ操作の表示用の値を取り直す。同じ操作の取り直しは一つにまとめる。
  async #refresh(generation: number, operationId: string): Promise<void> {
    if (this.#refreshing.has(operationId)) return;
    this.#refreshing.add(operationId);
    try {
      for (;;) {
        const wanted = this.#events?.revisions[operationId];
        const outcome = await this.#options.transport.request({
          method: 'GET',
          path: `/v1/operations/${encodeURIComponent(operationId)}`,
          lockState: this.#lockState,
        });
        if (generation !== this.#generation) return;
        if (outcome.kind !== 'response') {
          this.#fail(generation, outcomeFailure(outcome));
          return;
        }
        if (
          outcome.status !== 200 ||
          !this.#options.contract.valid('OperationSnapshot', outcome.body)
        ) {
          // 取り直せない操作は表示を正しく保てないので、スナップショットからやり直す。
          this.#fail(
            generation,
            outcome.status === 200
              ? { kind: 'retry', reason: 'protocol_error' }
              : outcome.status === 401 || outcome.status === 403
                ? httpFailure(outcome.status, outcome.body)
                : { kind: 'resnapshot' },
          );
          return;
        }
        this.#confirmed();
        const operation = outcome.body as OperationSnapshot;
        // ロック・ロック不明になった後の応答は表示に入れない。
        if (this.#state.view !== 'full' || this.#lockState !== 'unlocked')
          return;
        const current = this.#operations.get(operationId);
        if (
          current === undefined ||
          BigInt(operation.state_revision) >= BigInt(current.state_revision)
        ) {
          this.#operations.set(operationId, operation);
          this.#update({ operations: this.#sortedOperations() });
        }
        // 取り直している間にさらに版が進んでいれば、もう一度取る。
        const latest = this.#events?.revisions[operationId];
        if (
          latest === undefined ||
          latest === wanted ||
          BigInt(operation.state_revision) >= BigInt(latest)
        )
          return;
      }
    } finally {
      this.#refreshing.delete(operationId);
    }
  }

  // --- 失敗・再接続 ---

  #fail(generation: number, failure: Failure): void {
    if (generation !== this.#generation) return;
    if (TERMINAL.has(this.#state.phase)) return;
    this.#generation += 1;
    this.#closeStream();
    this.#clearAlive();
    this.#clearRetry();
    if (failure.kind === 'terminal') {
      // 以後は要求を送らない。表示していた操作も捨てる（古い値を見せ続けない）。
      this.#dropView();
      this.#update({
        phase: failure.phase,
        reason: failure.reason,
        retryAt: null,
        commandScopeId: null,
      });
      return;
    }
    if (failure.kind === 'resnapshot') {
      this.#dropCursor();
      this.#resnapshots += 1;
      if (this.#resnapshots <= IMMEDIATE_RESNAPSHOTS) {
        this.#update({ reason: 'resnapshot', commandScopeId: null });
        void this.#connect();
        return;
      }
    }
    const reason =
      failure.kind === 'resnapshot' ? 'resnapshot' : failure.reason;
    const attempt = this.#state.attempt;
    const delay = reconnectDelay(
      attempt,
      () => this.#options.clock.random(),
      this.#options.backoff ?? DEFAULT_BACKOFF,
    );
    const retryAt = this.#options.clock.now() + delay;
    this.#update({
      phase: 'waiting_retry',
      reason,
      attempt: attempt + 1,
      retryAt,
      // 切断した接続範囲では命令を送らない（次の bootstrap で取り直す）。
      commandScopeId: null,
    });
    this.#retryTimer = this.#options.clock.setTimer(delay, () => {
      this.#retryTimer = null;
      if (this.#state.phase === 'waiting_retry') void this.#connect();
    });
  }

  #armAlive(generation: number): void {
    this.#clearAlive();
    const timeout = this.#options.aliveTimeoutMs ?? DEFAULT_ALIVE_TIMEOUT_MS;
    this.#aliveTimer = this.#options.clock.setTimer(timeout, () => {
      this.#aliveTimer = null;
      this.#fail(generation, { kind: 'retry', reason: 'alive_timeout' });
    });
  }

  #confirmed(): void {
    this.#update({ lastConfirmedAt: this.#options.clock.now() });
  }

  #dropCursor(): void {
    this.#events = null;
    this.#update({ cursor: null });
  }

  #dropView(): void {
    this.#events = null;
    this.#operations.clear();
    this.#refreshing.clear();
    this.#update({ cursor: null, view: null, operations: [] });
  }

  #closeStream(): void {
    const stream = this.#stream;
    this.#stream = null;
    if (stream !== null)
      try {
        stream.close();
      } catch {
        // 閉じる処理の失敗で状態機械を止めない。
      }
  }

  #clearRetry(): void {
    this.#retryTimer?.();
    this.#retryTimer = null;
  }

  #clearAlive(): void {
    this.#aliveTimer?.();
    this.#aliveTimer = null;
  }

  #sortedOperations(): OperationSnapshot[] {
    return [...this.#operations.values()].sort(byOperationId);
  }

  #update(change: Partial<LinkState>): void {
    const next = { ...this.#state, ...change };
    const changed = (Object.keys(change) as (keyof LinkState)[]).some(
      (key) => next[key] !== this.#state[key],
    );
    this.#state = next;
    if (!changed) return;
    for (const listener of [...this.#listeners]) listener(next);
  }
}
