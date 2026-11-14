// 気づきの通知の識別子（notification_key）の材料・生成と、候補の重複排除・通知の可否
// （設計 04 通知の重複と再通知、設計 11 §4、設計 08 §7、ADR 0073・0117）。
// SHA-256 は Core（node:crypto）が計算する。domain は材料の組み立てと検査、結果の形の確認までを持つ。
// 本文・件名・宛先・メールアドレス、期限の原文（original_text）は材料にしない。取得時刻や再接続も材料にしない。

import { isRealLocalDateTime } from './local-time.js';
import { parseCandidateUtc } from './candidate-time.js';
import {
  deliveryDecision,
  type DeliveryRecord,
  type DeliveryTrigger,
} from './notification.js';
import type { CandidateState } from './candidate.js';
import type { Deadline } from './extraction.js';
import type { EvidenceDecision } from './candidate-lifecycle.js';
import type { OverlapPeriod } from './schedule-overlap.js';

export const NOTIFICATION_MATERIAL_VERSION = 'buddy.notification-key.v1';

export type NotificationKeyParts =
  | {
      readonly kind: 'mail_deadline' | 'mail_reply';
      readonly source_account_id: string;
      readonly request_entity_id: string;
      // 依頼エンティティの版（設計 11 §5A）。期限などが変われば上がり、別の識別子になる。
      readonly request_revision: string;
      readonly due: Deadline;
    }
  | {
      readonly kind: 'schedule_overlap';
      // 重複する予定の参照（calendarOccurrenceRef）。並びは問わない（昇順にして使う）。
      readonly event_refs: readonly string[];
      readonly period: OverlapPeriod;
    }
  | {
      readonly kind: 'research_done';
      readonly workflow_id: string;
      readonly completion_version: string;
    };

// 識別子の部品は、短い記号の列だけ受ける。メールアドレス（@）・空白・改行・本文らしい文は材料にならない。
const ID_PART = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)$/u;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
// 改行・制御文字（U+0000〜U+001F、U+007F）を含むか。材料の行を差し込めないようにする。
const hasControl = (value: string): boolean =>
  [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

const isDate = (value: string): boolean =>
  DATE.test(value) && isRealLocalDateTime(`${value}T00:00`);

// 期限の材料。原文は含めない。時刻付きは秒を補って正規化し、タイムゾーンを添える。
function dueMaterial(due: Deadline): string | null {
  switch (due.kind) {
    case 'instant': {
      if (!isRealLocalDateTime(due.local_datetime)) return null;
      if (due.zone === '' || hasControl(due.zone)) return null;
      const local =
        due.local_datetime.length === 16
          ? `${due.local_datetime}:00`
          : due.local_datetime;
      return `instant:${local}@${due.zone}`;
    }
    case 'date':
      return isDate(due.date) ? `date:${due.date}` : null;
    case 'unresolved':
      return `unresolved:${due.reason}`;
    case 'none':
      return 'none';
  }
}

// UTC のミリ秒を、秒までの正規の形（ミリ秒が 0 でなければミリ秒まで）にする。
const canonicalUtc = (millis: number): string =>
  new Date(millis).toISOString().replace('.000Z', 'Z');

function periodMaterial(period: OverlapPeriod): string | null {
  if (period.kind === 'timed') {
    const start = parseCandidateUtc(period.start);
    const end = parseCandidateUtc(period.end);
    if (start === null || end === null || end <= start) return null;
    // 同じ時刻の書き方の違い（Z と .000Z）で識別子が変わらないよう、正規の形（ミリ秒が 0 なら省く）にそろえる。
    return `timed:${canonicalUtc(start)}/${canonicalUtc(end)}`;
  }
  if (!isDate(period.start_date) || !isDate(period.end_date)) return null;
  if (period.end_date <= period.start_date) return null;
  return `all_day:${period.start_date}/${period.end_date}`;
}

// 識別子の材料の文字列。同じ入力から同じ文字列を作り、並びの違いや取得時刻で変わらない。作れなければ null。
export function notificationKeyMaterial(
  parts: NotificationKeyParts,
): string | null {
  const lines: string[] = [NOTIFICATION_MATERIAL_VERSION, `kind=${parts.kind}`];
  switch (parts.kind) {
    case 'mail_deadline':
    case 'mail_reply': {
      if (
        !ID_PART.test(parts.source_account_id) ||
        !ID_PART.test(parts.request_entity_id) ||
        !VERSION.test(parts.request_revision)
      )
        return null;
      const due = dueMaterial(parts.due);
      if (due === null) return null;
      lines.push(
        `source_account_id=${parts.source_account_id}`,
        `request_entity_id=${parts.request_entity_id}`,
        `request_revision=${parts.request_revision}`,
        `due=${due}`,
      );
      break;
    }
    case 'schedule_overlap': {
      const refs = [...parts.event_refs].sort();
      if (
        refs.length < 2 ||
        new Set(refs).size !== refs.length ||
        refs.some((ref) => ref === '' || ref.length > 512 || hasControl(ref))
      )
        return null;
      const period = periodMaterial(parts.period);
      if (period === null) return null;
      // 参照は JSON の配列にして、区切りの文字が参照に含まれても別の組と混ざらないようにする。
      lines.push(`event_refs=${JSON.stringify(refs)}`, `period=${period}`);
      break;
    }
    case 'research_done': {
      if (
        !ID_PART.test(parts.workflow_id) ||
        !VERSION.test(parts.completion_version)
      )
        return null;
      lines.push(
        `workflow_id=${parts.workflow_id}`,
        `completion_version=${parts.completion_version}`,
      );
      break;
    }
  }
  return lines.join('\n');
}

const HEX64 = /^[0-9a-f]{64}$/u;

// 識別子（SHA-256 の 64 桁の小文字 16 進）。ハッシュは呼び出し側（Core）が渡す。形が違う結果は受けない。
export function notificationKey(
  parts: NotificationKeyParts,
  sha256Hex: (material: string) => string,
): string | null {
  const material = notificationKeyMaterial(parts);
  if (material === null) return null;
  const key = sha256Hex(material);
  return HEX64.test(key) ? key : null;
}

// --- 候補を作るか（再同期・再取得で二重に作らない） ---

export interface CandidateKeyRecord {
  readonly notification_key: string;
  readonly state: CandidateState;
}

export type CandidateIntakeDecision =
  | { readonly action: 'create' }
  | { readonly action: 'duplicate'; readonly state: CandidateState }
  | { readonly action: 'reject'; readonly reason: 'key_invalid' };

// 同じ識別子の候補がすでにあれば作らない。却下・解決の後も、識別子が残る間（解決から 97 日）は作らない。
// 97 日を過ぎて行ごと消えた識別子は、ここには渡らない（存在しない）。
export function candidateIntakeDecision(
  existing: readonly CandidateKeyRecord[],
  key: string,
): CandidateIntakeDecision {
  if (!HEX64.test(key)) return { action: 'reject', reason: 'key_invalid' };
  const found = existing.find((record) => record.notification_key === key);
  return found === undefined
    ? { action: 'create' }
    : { action: 'duplicate', state: found.state };
}

// --- 通知を出すか ---

export interface CandidateAlertInput {
  readonly notification_key: string;
  readonly state: CandidateState;
  readonly initial_import: boolean;
  // 根拠を取り直した結果（P2 の evidenceDecision の evidence）。再通知は元情報を再確認してから出す。
  readonly evidence: EvidenceDecision['evidence'];
  readonly trigger: DeliveryTrigger;
  readonly reminder_id: string | null;
  readonly existing: readonly DeliveryRecord[];
}

// ポップアップ・読み上げを新しく出すか。配信の記録（通知の識別子と reminder_id）の重複と再接続・再取得・端末移動は
// `deliveryDecision` に従い、その上に候補の状態・初回取り込み・根拠の再確認を足す。
// ACK を失った配信（delivery_unknown）の記録も「配信済み」として数え、自動で鳴らし直さない。
export function candidateAlertDecision(input: CandidateAlertInput): {
  readonly deliver: boolean;
  readonly reason: string | null;
} {
  const base = deliveryDecision(input.existing, {
    notification_key: input.notification_key,
    trigger: input.trigger,
    reminder_id: input.reminder_id,
  });
  if (!base.deliver) return base;
  if (input.state === 'dismissed' || input.state === 'resolved')
    return { deliver: false, reason: 'candidate_closed' };
  // 初回の取り込みは一覧をまとめて作る。個別の新着通知にしない（U279）。
  if (input.trigger === 'new_candidate' && input.initial_import)
    return { deliver: false, reason: 'initial_import_listed_only' };
  if (input.trigger === 'user_reminder' && input.evidence !== 'valid')
    return { deliver: false, reason: 'source_not_confirmed' };
  return { deliver: true, reason: null };
}
