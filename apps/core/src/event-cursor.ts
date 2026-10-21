// イベントの位置（event_cursor）の符号化と、再生できるかの判定（設計 07 §4、ADR 0009・0023）。
//
// - cursor は DB 世代（store_generation）・連番（sequence）・発行の時刻を含む不透明な値。端末は中を解釈しない。
//   秘密でも認証情報でもない（認証は端末トークン）。改ざんされても位置が変わるだけで、見せる範囲は広がらない。
// - 形: `ec1_` ＋ base64url（パディングなし）の `<store_generation>.<sequence>.<issued_at_ms>`。
//   読み取りは厳格にし、符号化し直して同じ文字列になるものだけを受け付ける（別の書き方を同じ位置にしない）。
// - 再生できない（再スナップショットが要る）とき:
//   - DB 世代が違う（新しい DB・復元）→ store_generation_changed
//   - 発行から 7 日（event_outbox の保存期限）を過ぎた・時計が発行より前へ戻った → history_expired
//   - cursor の直後のイベントがもう残っていない（最小の連番が cursor の連番＋1 より大きい）、
//     または cursor の連番が今の最大より大きい（連番が戻った・作った値）→ history_expired
// - 連番の飛びだけで欠落と判定するのは端末ではなく中枢の役目で、端末は event_id と state_revision で
//   重複・逆順を捨てる（domain の applyEvents）。見せないイベントがあれば、端末から見た連番は飛ぶ。

import { RETENTION_RULES } from '@buddy/domain';

const PREFIX = 'ec1_';
// event_outbox の保存期限（7 日）。cursor の期限も同じにする。
export const EVENT_CURSOR_TTL_MS = RETENTION_RULES['event_outbox']?.ms ?? 0;
const GENERATION =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NUMBER = /^(0|[1-9][0-9]{0,15})$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export interface EventCursorValue {
  readonly storeGeneration: string;
  // この連番までのイベントを受け取った（または反映済みの）位置。0 は最初から。
  readonly sequence: number;
  // UTC の Unix ミリ秒。
  readonly issuedAt: number;
}

export function encodeEventCursor(value: EventCursorValue): string {
  if (
    !GENERATION.test(value.storeGeneration) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !Number.isSafeInteger(value.issuedAt) ||
    value.issuedAt < 0
  )
    throw new TypeError('event_cursor_value_invalid');
  const body = `${value.storeGeneration}.${value.sequence}.${value.issuedAt}`;
  return PREFIX + Buffer.from(body, 'utf8').toString('base64url');
}

// 中枢が発行した形の cursor だけを読む。形が違えば null（getEvents は 422、WSS は切り替えない）。
export function decodeEventCursor(cursor: string): EventCursorValue | null {
  if (!cursor.startsWith(PREFIX) || cursor.length > 128) return null;
  const encoded = cursor.slice(PREFIX.length);
  if (!BASE64URL.test(encoded)) return null;
  const body = Buffer.from(encoded, 'base64url').toString('utf8');
  const parts = body.split('.');
  if (parts.length !== 3) return null;
  const [generation, sequence, issuedAt] = parts as [string, string, string];
  if (
    !GENERATION.test(generation) ||
    !NUMBER.test(sequence) ||
    !NUMBER.test(issuedAt)
  )
    return null;
  const value: EventCursorValue = {
    storeGeneration: generation,
    sequence: Number(sequence),
    issuedAt: Number(issuedAt),
  };
  if (
    !Number.isSafeInteger(value.sequence) ||
    !Number.isSafeInteger(value.issuedAt)
  )
    return null;
  // 符号化し直して同じ文字列になるものだけ（base64url の余りのビット・別の書き方を受け付けない）。
  return encodeEventCursor(value) === cursor ? value : null;
}

export type ResnapshotReason =
  'store_generation_changed' | 'history_expired' | 'scope_expired';

export interface ReplayRange {
  readonly storeGeneration: string;
  // 今の時刻（UTC の Unix ミリ秒）。
  readonly now: number;
  // event_outbox に残っている最小・最大の連番（なければ null・0）。同じ読み取りで取った値。
  readonly minSequence: number | null;
  readonly maxSequence: number;
}

// cursor の後のイベントを欠けなく再生できるか。できなければ再スナップショットの理由を返す。
export function cursorReplayDecision(
  cursor: EventCursorValue,
  range: ReplayRange,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ResnapshotReason } {
  if (cursor.storeGeneration !== range.storeGeneration)
    return { ok: false, reason: 'store_generation_changed' };
  if (
    range.now < cursor.issuedAt ||
    range.now - cursor.issuedAt >= EVENT_CURSOR_TTL_MS
  )
    return { ok: false, reason: 'history_expired' };
  if (cursor.sequence > range.maxSequence)
    return { ok: false, reason: 'history_expired' };
  if (range.minSequence !== null && range.minSequence > cursor.sequence + 1)
    return { ok: false, reason: 'history_expired' };
  return { ok: true };
}
