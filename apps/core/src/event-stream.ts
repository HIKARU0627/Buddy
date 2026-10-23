// WSS /v1/events/stream の配信（設計 07 §2・§4、ADR 0009・0020・0023）。
//
// - 切り替えの前（admit）: 経路の検査（端末トークン・自宅判定）は api-server.ts が済ませている。ここでは
//   開始位置のクエリー `cursor` が中枢の発行した形かを確かめ、違えば 422 invalid_input（切り替えない）。
//   配信の元（EventFeed）を止めた後（中枢の停止の途中）は 503 dependency_unavailable（B03-07 M3）。
//   同じ端末の開いている購読が上限（DEFAULT_MAX_STREAMS_PER_DEVICE）に達していれば 429 rate_limited（B03-07 L3）。
// - 切り替えの後（open）: 接続を端末の今の接続範囲（今回の起動で発行し、失効・期限切れでないもの）に結び付ける。
//   なければ resnapshot_required（scope_expired）を送って閉じる。cursor の DB 世代違い・期限切れも同じく閉じる。
// - 配信: EventFeed の購読で、cursor の後の COMMIT 済みのイベントを `{type:"event"}` で順に送る。
// - ping を pingIntervalMs ごとに送り、前の ping に pong がなければ切る。同じ間隔で、接続範囲（再接続・失効・期限）
//   と自宅判定を確かめ直し、満たさなければ理由つきで閉じる。端末の失効・自宅判定の不成立は DeviceConnections から
//   すぐに閉じる（B03-02・B03-03 が呼ぶ）。
// - 端末から送るメッセージは定義していない。受け取ったら閉じる。送り先が詰まったら閉じる（端末は cursor から再開する）。
//
// 閉じるコード（OpenAPI の x-buddy-websocket-close-codes と同じ）:
//   4410 resnapshot_required の後（理由: store_generation_changed・history_expired・scope_expired）
//   4401 端末の失効（device_revoked）
//   4403 自宅判定の不成立（outside_home_network）
//   1001 中枢の停止（core_stopping）
//   1003 端末からのメッセージ（unsupported_data）
//   1011 DB の照会の失敗（dependency_unavailable）
//   1013 送り先の詰まり（slow_consumer）
//   4429 同じ端末の購読の数の上限（too_many_streams。同時の切り替えで後から開いたもの。B03-07 L3）
//   pong のない接続は閉じる手順を踏まずに切る（端末からは 1006）。

import type { DbWorkerClient } from '@buddy/storage';
import { WebSocket } from 'ws';
import { commandScopeState } from './api-auth.js';
import type {
  EnvironmentInput,
  RequestEnvironment,
} from './api-environment.js';
import { apiErrorResponse } from './api-server.js';
import type { ApiEventStream, ApiHandlerRequest } from './api-server.js';
import type { DeviceConnections } from './device-connections.js';
import type { FaultHook } from './turn-ports.js';
import { cursorReplayDecision, decodeEventCursor } from './event-cursor.js';
import type { ResnapshotReason } from './event-cursor.js';
import type {
  EventEnvelope,
  EventFeed,
  EventQueryStore,
} from './event-feed.js';

export const STREAM_CLOSE_CODES = {
  resnapshot_required: 4410,
  device_revoked: 4401,
  outside_home_network: 4403,
  core_stopping: 1001,
  unsupported_data: 1003,
  dependency_unavailable: 1011,
  slow_consumer: 1013,
  too_many_streams: 4429,
} as const;

export const DEFAULT_PING_INTERVAL_MS = 15_000;
// 端末ごとに同時に開ける購読の数（B03-07 L3）。設計に数値がないため仮の値（理由は ADR 0023）。
export const DEFAULT_MAX_STREAMS_PER_DEVICE = 4;
// 送り先に溜めてよい量。超えたら閉じ、端末に cursor から再開させる。
export const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;
// 閉じる手順（close フレームのやり取り）を待つ上限。過ぎたら切る。
const CLOSE_FALLBACK_MS = 2_000;

export interface EventStreamOptions {
  readonly feed: EventFeed;
  readonly store: EventQueryStore & Pick<DbWorkerClient, 'device'>;
  readonly coreInstanceId: string;
  readonly environment: RequestEnvironment;
  readonly deviceConnections: DeviceConnections;
  // キャンバスの記述が新しい版になったことを知らせる元（ADR 0032）。購読ごとに版だけを `{type:"canvas"}` で送る。
  // イベントの記録（cursor）には入れない。なければ送らない。
  readonly canvas?: CanvasNotifier;
  readonly now?: () => number;
  readonly pingIntervalMs?: number;
  readonly maxBufferedBytes?: number;
  readonly maxStreamsPerDevice?: number;
  // 故障点（試験用、ADR 0030）。イベントを送った後・端末の ACK（cursor の前進）の前。注入で例外になれば、
  // 配信の後に接続を失ったものとして閉じる（端末は cursor から再開する）。
  readonly faults?: FaultHook;
}

export interface CanvasNotifier {
  subscribe(listener: (revision: string) => void): () => void;
}

export interface EventStreamManager extends ApiEventStream {
  // 開いている購読の数（診断・試験用）。
  readonly openCount: number;
  // 中枢の停止。すべての購読を 1001 で閉じ、close の往復（または打ち切り）が終わるまで待つ。
  // 下の層（HTTPS の接続）を先に切ると close フレームが届かない（Windows で 1006 になった）。
  closeAll(): Promise<void>;
}

type CloseReason = keyof typeof STREAM_CLOSE_CODES | ResnapshotReason;

export function createEventStream(
  options: EventStreamOptions,
): EventStreamManager {
  const now = options.now ?? (() => Date.now());
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const sessions = new Set<(reason: CloseReason) => void>();
  // 閉じ始めた購読の、close の完了（打ち切りを含む）。
  const closing = new Set<Promise<void>>();
  const maxPerDevice =
    options.maxStreamsPerDevice ?? DEFAULT_MAX_STREAMS_PER_DEVICE;
  // 端末ごとの開いている購読の数。切り替えた直後（open）に同期で数え、閉じたら（cleanup）減らす。
  const perDevice = new Map<string, number>();
  const streamsOf = (deviceId: string) => perDevice.get(deviceId) ?? 0;

  const admit = (
    request: ApiHandlerRequest,
  ): Promise<{ status: number; body: object } | null> => {
    if (request.device === null)
      return Promise.resolve(apiErrorResponse(401, 'unauthenticated'));
    // 配信の元を止めた後（中枢の停止の途中）は切り替えない（B03-07 M3）。
    if (options.feed.closed)
      return Promise.resolve(apiErrorResponse(503, 'dependency_unavailable'));
    // 同じ端末の購読が上限に達していれば切り替えない（B03-07 L3）。
    if (streamsOf(request.device.device_id) >= maxPerDevice)
      return Promise.resolve(apiErrorResponse(429, 'rate_limited'));
    const cursor = decodeEventCursor(request.query['cursor'] ?? '');
    return Promise.resolve(
      cursor === null ? apiErrorResponse(422, 'invalid_input') : null,
    );
  };

  const open = (client: WebSocket, request: ApiHandlerRequest): void => {
    const device = request.device;
    const cursor = decodeEventCursor(request.query['cursor'] ?? '');
    if (device === null || cursor === null) {
      client.close(
        STREAM_CLOSE_CODES.dependency_unavailable,
        'dependency_unavailable',
      );
      return;
    }
    if (streamsOf(device.device_id) >= maxPerDevice) {
      // 受け付けの判定の後に、同じ端末の購読が先に開いた（同時の切り替え）。理由つきで閉じる（B03-07 L3）。
      client.close(STREAM_CLOSE_CODES.too_many_streams, 'too_many_streams');
      return;
    }
    perDevice.set(device.device_id, streamsOf(device.device_id) + 1);
    let counted = true;
    let closed = false;
    let alive = true;
    let scopeId: string | null = null;
    let subscription: { close(): void } | null = null;
    let unregister: (() => void) | null = null;
    let unsubscribeCanvas: (() => void) | null = null;
    let pingTimer: NodeJS.Timeout | null = null;
    let checking = false;

    const cleanup = () => {
      if (pingTimer !== null) clearInterval(pingTimer);
      pingTimer = null;
      subscription?.close();
      subscription = null;
      unregister?.();
      unregister = null;
      unsubscribeCanvas?.();
      unsubscribeCanvas = null;
      sessions.delete(finish);
      if (counted) {
        counted = false;
        const left = streamsOf(device.device_id) - 1;
        if (left > 0) perDevice.set(device.device_id, left);
        else perDevice.delete(device.device_id);
      }
    };

    // 理由つきで閉じる。再スナップショットの理由なら resnapshot_required を送ってから閉じる。
    function finish(reason: CloseReason): void {
      if (closed) return;
      closed = true;
      cleanup();
      if (client.readyState !== WebSocket.OPEN) {
        client.terminate();
        return;
      }
      const resnapshot =
        reason === 'store_generation_changed' ||
        reason === 'history_expired' ||
        reason === 'scope_expired';
      const code = resnapshot
        ? STREAM_CLOSE_CODES.resnapshot_required
        : STREAM_CLOSE_CODES[reason];
      const fallback = setTimeout(() => client.terminate(), CLOSE_FALLBACK_MS);
      fallback.unref();
      const done = new Promise<void>((resolve) => {
        client.once('close', () => {
          clearTimeout(fallback);
          resolve();
        });
      });
      closing.add(done);
      void done.then(() => closing.delete(done));
      if (resnapshot)
        client.send(JSON.stringify({ type: 'resnapshot_required', reason }));
      client.close(code, reason);
    }
    sessions.add(finish);
    // キャンバスの版の知らせ。受け付けた直後（非同期の処理の前）に登録するので、端末が開いた後に取る getCanvas より
    // 後の変更は必ず知らせが届く。版だけを送り、記述の本文を含めない。
    unsubscribeCanvas =
      options.canvas?.subscribe((revision) => {
        if (closed || client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount > maxBuffered) {
          finish('slow_consumer');
          return;
        }
        client.send(
          JSON.stringify({ type: 'canvas', canvas_revision: revision }),
        );
      }) ?? null;

    client.on('pong', () => {
      alive = true;
    });
    client.on('message', () => finish('unsupported_data'));
    client.on('error', () => {
      closed = true;
      cleanup();
      client.terminate();
    });
    client.on('close', () => {
      closed = true;
      cleanup();
    });

    const environmentInput: EnvironmentInput = {
      operationId: request.route.operationId,
      device,
      remoteAddress: request.remoteAddress,
      params: request.params,
      body: null,
      declaredLockState: request.declaredLockState,
    };

    const deliver = (events: readonly EventEnvelope[]): boolean => {
      if (closed || client.readyState !== WebSocket.OPEN) return false;
      if (client.bufferedAmount > maxBuffered) {
        finish('slow_consumer');
        return false;
      }
      for (const event of events) {
        client.send(JSON.stringify({ type: 'event', event }));
        options.faults
          ?.hit('after_event_delivery_before_ack', {
            operation_id: event.operation_id,
          })
          .catch(() => {
            finish('dependency_unavailable');
          });
      }
      return true;
    };

    // 接続範囲（再接続・失効・期限）と自宅判定を確かめ直す。
    const recheck = async () => {
      if (checking || closed || scopeId === null) return;
      checking = true;
      try {
        const found = await options.store.device({
          kind: 'scope.find',
          command_scope_id: scopeId,
        });
        if (closed) return;
        if (!found.ok) {
          finish('dependency_unavailable');
          return;
        }
        const state = commandScopeState(found.value, {
          deviceId: device.device_id,
          coreInstanceId: options.coreInstanceId,
          now: now(),
        });
        if (state !== 'current') {
          finish('scope_expired');
          return;
        }
        const home = await options.environment.homeNetwork(environmentInput);
        if (!closed && !home) finish('outside_home_network');
      } catch {
        finish('dependency_unavailable');
      } finally {
        checking = false;
      }
    };

    const start = async () => {
      let scope;
      try {
        scope = await options.store.query({
          kind: 'current_scope',
          device_id: device.device_id,
          core_instance_id: options.coreInstanceId,
          now: now(),
        });
      } catch {
        finish('dependency_unavailable');
        return;
      }
      if (closed) return;
      if (scope === null) {
        finish('scope_expired');
        return;
      }
      scopeId = scope.command_scope_id;
      const early = cursorReplayDecision(cursor, {
        storeGeneration: options.feed.storeGeneration,
        now: now(),
        minSequence: null,
        maxSequence: Number.MAX_SAFE_INTEGER,
      });
      if (!early.ok) {
        finish(early.reason);
        return;
      }
      unregister = options.deviceConnections.register(
        device.device_id,
        (reason) => finish(reason),
      );
      subscription = options.feed.subscribe(cursor.sequence, {
        deliver,
        resnapshot: (reason) => finish(reason),
        fail: () => finish('dependency_unavailable'),
      });
      pingTimer = setInterval(() => {
        if (closed) return;
        if (!alive) {
          // 前の ping に応答がない。閉じる手順を待たずに切る。
          closed = true;
          cleanup();
          client.terminate();
          return;
        }
        alive = false;
        client.ping();
        void recheck();
      }, pingIntervalMs);
      pingTimer.unref();
    };
    // 開始の失敗（受け付けの判定の後に配信の元が止まり、subscribe が event_feed_closed を投げるなど）は、
    // 購読の失敗として閉じる。未処理の拒否にしない（B03-07 M3）。
    start().catch(() => finish('dependency_unavailable'));
  };

  return {
    admit,
    open,
    get openCount() {
      return sessions.size;
    },
    async closeAll() {
      for (const finish of [...sessions]) finish('core_stopping');
      await Promise.all([...closing]);
    },
  };
}
