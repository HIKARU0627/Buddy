// イベントの送出記録の読み取りと、スナップショット・配信の照会の入口（設計 07 §1・§4、08 §5、ADR 0023）。
//
// - event_outbox は状態の更新と同じ transaction で書かれる（operation-store.ts）。ここでは読むだけ。
//   DB worker はメッセージを一つずつ処理するので、照会が返すのは COMMIT 済みの行だけ（durable commit の後の配信）。
// - 連番は store_generation ごとの最大値＋1 で、COMMIT した transaction だけが連番を使う（飛びはない）。
//   7 日の削除で古い行が消えると、残っている最小の連番が cursor の直後より大きくなる。この「欠け」を
//   min_sequence で検出できるよう、範囲（最小・最大）を同じ読み取りで返す。
// - 本文・宛先・トークンは event_outbox にない（0001 の列）。返す値も ID・版・種類・時刻だけ。

import type { SqliteDatabase } from './connection.js';
import type { CommandScopeRecord } from './device-store.js';
import type { OutboxEventRecord } from './operation-store.js';
import {
  hasReceiptForRequest,
  readConsistently,
  readCurrentScope,
  readOperationView,
  readSnapshot,
} from './snapshot-store.js';
import type { OperationView, SnapshotRead } from './snapshot-store.js';

// 1 回の照会で返すイベントの上限。
export const MAX_EVENT_PAGE = 500;

export interface EventsSinceRead {
  readonly store_generation: string;
  // 照会の時点で残っている最小・最大の連番（なければ null・0）。
  readonly min_sequence: number | null;
  readonly max_sequence: number;
  // after_sequence より後のイベント（連番の昇順、最大 limit 件）。
  readonly events: readonly OutboxEventRecord[];
  // limit より多く残っている。
  readonly has_more: boolean;
}

// DB worker の照会（db-protocol.ts の DbQuery に加えたもの）。
export type EventQuery =
  | { readonly kind: 'snapshot' }
  | {
      readonly kind: 'events_since';
      readonly after_sequence: number;
      readonly limit: number;
    }
  | { readonly kind: 'operation_view'; readonly operation_id: string }
  | {
      readonly kind: 'receipt_exists';
      readonly command_scope_id: string;
      readonly request_id: string;
    }
  | {
      readonly kind: 'current_scope';
      readonly device_id: string;
      readonly core_instance_id: string;
      readonly now: number;
    };

export type EventQueryKind = EventQuery['kind'];

export interface EventQueryValues {
  readonly snapshot: SnapshotRead;
  readonly events_since: EventsSinceRead;
  readonly operation_view: OperationView | null;
  readonly receipt_exists: boolean;
  readonly current_scope: CommandScopeRecord | null;
}

export type EventQueryValue = EventQueryValues[EventQueryKind];

export const EVENT_QUERY_KINDS: ReadonlySet<string> = new Set<EventQueryKind>([
  'snapshot',
  'events_since',
  'operation_view',
  'receipt_exists',
  'current_scope',
]);

export function isEventQuery(query: {
  readonly kind: string;
}): query is EventQuery {
  return EVENT_QUERY_KINDS.has(query.kind);
}

interface OutboxRow {
  store_generation: string;
  sequence: number;
  event_id: string;
  target_id: string;
  state_revision: number;
  event_type: string;
  occurred_at: number;
  delete_at: number;
}

export function readEventsSince(
  db: SqliteDatabase,
  storeGeneration: string,
  afterSequence: number,
  limit: number,
): EventsSinceRead {
  return readConsistently(db, () => {
    const bounds = db
      .prepare(
        'SELECT coalesce(max(sequence), 0) AS max_sequence, min(sequence) AS min_sequence FROM event_outbox WHERE store_generation = ?',
      )
      .get(storeGeneration) as {
      max_sequence: number;
      min_sequence: number | null;
    };
    const rows = db
      .prepare(
        'SELECT * FROM event_outbox WHERE store_generation = ? AND sequence > ? ORDER BY sequence LIMIT ?',
      )
      .all(storeGeneration, afterSequence, limit + 1) as OutboxRow[];
    const page = rows.slice(0, limit);
    return {
      store_generation: storeGeneration,
      min_sequence: bounds.min_sequence,
      max_sequence: bounds.max_sequence,
      events: page.map((row) => ({
        ...row,
        state_revision: String(row.state_revision),
      })),
      has_more: rows.length > limit,
    };
  });
}

const isSequence = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;

// 照会の形の検査。structured clone を通った値を信用しない。理由が空なら形は正しい。
export function eventQueryShapeReasons(query: EventQuery): string[] {
  switch (query.kind) {
    case 'snapshot':
      return [];
    case 'events_since':
      return isSequence(query.after_sequence) &&
        Number.isSafeInteger(query.limit) &&
        query.limit >= 1 &&
        query.limit <= MAX_EVENT_PAGE
        ? []
        : ['events_query_invalid'];
    case 'operation_view':
      return isText(query.operation_id) ? [] : ['operation_id_invalid'];
    case 'receipt_exists':
      return isText(query.command_scope_id) && isText(query.request_id)
        ? []
        : ['receipt_query_invalid'];
    case 'current_scope':
      return isText(query.device_id) &&
        isText(query.core_instance_id) &&
        isSequence(query.now)
        ? []
        : ['scope_query_invalid'];
  }
}

// DB worker の中で照会を一つ処理する。形が不正なら例外（worker は query_failed を返す）。
export function executeEventQuery(
  db: SqliteDatabase,
  storeGeneration: string,
  query: EventQuery,
): EventQueryValue {
  const reasons = eventQueryShapeReasons(query);
  if (reasons.length > 0) throw new Error(reasons.join(','));
  switch (query.kind) {
    case 'snapshot':
      return readSnapshot(db, storeGeneration);
    case 'events_since':
      return readEventsSince(
        db,
        storeGeneration,
        query.after_sequence,
        query.limit,
      );
    case 'operation_view':
      return readOperationView(db, query.operation_id);
    case 'receipt_exists':
      return hasReceiptForRequest(db, query.command_scope_id, query.request_id);
    case 'current_scope':
      return readCurrentScope(
        db,
        query.device_id,
        query.core_instance_id,
        query.now,
      );
  }
}
