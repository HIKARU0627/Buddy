// 気づき（候補）の表示順と見出し（設計 11 §4 表示順、設計 04、ADR 0115）。時計とタイムゾーンは
// 呼び出し側が渡し、実時刻に依存しない。DB・画面は B11-03・B11-05。ここは純粋な規則だけを持つ。
//
// 表示順: (1) 今日・明日の予定重複、(2) 期限の近い順（期限不明は最後）、(3) 受信の新しい順。
// 見出し: 今日・明日・今週・それ以降・期限不明。初回取り込みの過去の期限は別にまとめて折りたたむ。

import {
  candidateDateToDay as dateToDay,
  candidateLocalClock as localClock,
} from './candidate-time.js';
import { isRealLocalDateTime } from './local-time.js';
import type { Deadline } from './extraction.js';

export const CANDIDATE_HEADINGS = [
  'today',
  'tomorrow',
  'this_week',
  'later',
  'unknown',
  'initial_import_past',
] as const;
export type CandidateHeading = (typeof CANDIDATE_HEADINGS)[number];

export const CANDIDATE_HEADING_LABELS: Readonly<
  Record<CandidateHeading, string>
> = {
  today: '今日',
  tomorrow: '明日',
  this_week: '今週',
  later: 'それ以降',
  unknown: '期限不明',
  initial_import_past: '初回取り込み（過去の期限）',
};

export type CandidateKindName =
  'schedule_overlap' | 'mail_deadline' | 'mail_reply' | 'research_done';

// 並べる入力。received_at は受信（予定の重複・調査では候補を作った）の UTC 時刻。
// 予定の重複の候補は、deadline に重複の始まり（instant）を入れて渡す（B11-04）。
export interface CandidateOrderItem {
  readonly candidate_id: string;
  readonly kind: CandidateKindName;
  readonly deadline: Deadline;
  readonly initial_import: boolean;
  readonly received_at: string;
}

export interface CandidateOrderContext {
  // 現在の UTC 時刻（ISO 8601）。
  readonly now: string;
  // 本人のタイムゾーン（IANA）。日付だけの期限と「今日」の基準に使う。
  readonly zone: string;
}

export interface CandidateGroup<T extends CandidateOrderItem> {
  readonly heading: CandidateHeading;
  readonly label: string;
  // 初回取り込みの過去の期限だけ、既定で折りたたむ。
  readonly collapsed: boolean;
  readonly items: readonly T[];
}

export type CandidateOrderResult<T extends CandidateOrderItem> =
  | { readonly ok: true; readonly groups: readonly CandidateGroup<T>[] }
  | { readonly ok: false; readonly reason: 'now_invalid' | 'zone_invalid' };

// 月曜を週の始まりとする（U272）。月曜 = 0 … 日曜 = 6。1970-01-01 は木曜。
const weekdayOfDay = (day: number): number => (((day + 3) % 7) + 7) % 7;

interface Classified {
  readonly heading: CandidateHeading;
  // 並べ替えの鍵。期限不明は null。日付だけの期限はその日の終わりとして並べる（時刻は補わない）。
  readonly sortKey: string | null;
}

interface ParsedDeadline {
  readonly date: string;
  readonly sortKey: string;
  // 「いま」の現地時計を読むタイムゾーン。時刻付きの期限はその期限の zone、日付だけは本人の zone。
  readonly clockZone: string;
  readonly ended: (clock: { date: string; time: string }) => boolean;
}

// 期限の日付・並べ替えの鍵・過ぎたかの判定。期限が無い・一意でない・暦にないときは null。
function parseDeadline(
  deadline: Deadline,
  zone: string,
): ParsedDeadline | null {
  if (deadline.kind === 'instant') {
    if (!isRealLocalDateTime(deadline.local_datetime)) return null;
    const date = deadline.local_datetime.slice(0, 10);
    const time = deadline.local_datetime.slice(11);
    const sortKey = `${date}T${time.length === 5 ? `${time}:00` : time}`;
    return {
      date,
      sortKey,
      clockZone: deadline.zone,
      ended: (clock) => sortKey < `${clock.date}T${clock.time}`,
    };
  }
  if (deadline.kind === 'date') {
    if (!isRealLocalDateTime(`${deadline.date}T00:00`)) return null;
    const day = deadline.date;
    return {
      date: day,
      sortKey: `${day}T24:00:00`,
      clockZone: zone,
      ended: (clock) => day < clock.date,
    };
  }
  return null;
}

// その時刻（UTC のミリ秒）に期限が過ぎているか。時刻付きはその時刻を過ぎたとき、日付だけはその日が終わったとき。
// 期限が無い・一意でない・暦にない、タイムゾーンが読めないときは判断せず null。
export function candidateDeadlineEnded(
  deadline: Deadline,
  at: number,
  zone: string,
): boolean | null {
  if (Number.isNaN(at)) return null;
  const parsed = parseDeadline(deadline, zone);
  if (parsed === null) return null;
  const clock = localClock(at, parsed.clockZone);
  return clock === null ? null : parsed.ended(clock);
}

function classify(
  item: CandidateOrderItem,
  now: number,
  zone: string,
): Classified {
  const unknown: Classified = { heading: 'unknown', sortKey: null };
  const parsed = parseDeadline(item.deadline, zone);
  if (parsed === null) return unknown;
  const { date, sortKey } = parsed;
  const clock = localClock(now, parsed.clockZone);
  if (clock === null) return unknown;
  if (parsed.ended(clock) && item.initial_import)
    return { heading: 'initial_import_past', sortKey };
  // 初回取り込みでない過去の期限は、期限切れの解消（deadline_passed）までの間、今日に置く（U271）。
  if (date <= clock.date) return { heading: 'today', sortKey };
  const today = dateToDay(clock.date);
  const target = dateToDay(date);
  if (target === today + 1) return { heading: 'tomorrow', sortKey };
  const endOfWeek = today + (6 - weekdayOfDay(today));
  if (target <= endOfWeek) return { heading: 'this_week', sortKey };
  return { heading: 'later', sortKey };
}

const receivedMs = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

// 今日・明日の予定の重複を最初に出す。
const priorityOf = (item: CandidateOrderItem, heading: CandidateHeading) =>
  item.kind === 'schedule_overlap' &&
  (heading === 'today' || heading === 'tomorrow')
    ? 0
    : 1;

export function orderCandidates<T extends CandidateOrderItem>(
  items: readonly T[],
  context: CandidateOrderContext,
): CandidateOrderResult<T> {
  const now = Date.parse(context.now);
  if (Number.isNaN(now)) return { ok: false, reason: 'now_invalid' };
  if (localClock(now, context.zone) === null)
    return { ok: false, reason: 'zone_invalid' };

  const buckets = new Map<
    CandidateHeading,
    { item: T; classified: Classified }[]
  >();
  for (const item of items) {
    const classified = classify(item, now, context.zone);
    const bucket = buckets.get(classified.heading) ?? [];
    bucket.push({ item, classified });
    buckets.set(classified.heading, bucket);
  }

  const groups: CandidateGroup<T>[] = [];
  for (const heading of CANDIDATE_HEADINGS) {
    const bucket = buckets.get(heading);
    if (bucket === undefined) continue;
    // 初回取り込みの過去の期限は、いまに近い（新しい）期限から出す。
    const direction = heading === 'initial_import_past' ? -1 : 1;
    bucket.sort((a, b) => {
      const priority =
        priorityOf(a.item, heading) - priorityOf(b.item, heading);
      if (priority !== 0) return priority;
      const ka = a.classified.sortKey;
      const kb = b.classified.sortKey;
      if (ka !== kb) {
        if (ka === null) return 1;
        if (kb === null) return -1;
        return (ka < kb ? -1 : 1) * direction;
      }
      const received =
        receivedMs(b.item.received_at) - receivedMs(a.item.received_at);
      if (received !== 0 && !Number.isNaN(received)) return received;
      return a.item.candidate_id < b.item.candidate_id
        ? -1
        : a.item.candidate_id > b.item.candidate_id
          ? 1
          : 0;
    });
    groups.push({
      heading,
      label: CANDIDATE_HEADING_LABELS[heading],
      collapsed: heading === 'initial_import_past',
      items: bucket.map((entry) => entry.item),
    });
  }
  return { ok: true, groups };
}
