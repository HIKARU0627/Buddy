// 気づき（候補）の表示順と見出し（設計 11 §4 表示順、設計 04、ADR 0115）。時計とタイムゾーンは
// 呼び出し側が渡し、実時刻に依存しない。DB・画面は B11-03・B11-05。ここは純粋な規則だけを持つ。
//
// 表示順: (1) 今日・明日の予定重複、(2) 期限の近い順（期限不明は最後）、(3) 受信の新しい順。
// 見出し: 今日・明日・今週・それ以降・期限不明。初回取り込みの過去の期限は別にまとめて折りたたむ。

import {
  candidateDateToDay as dateToDay,
  candidateLocalClock as localClock,
  parseCandidateUtc as parseUtc,
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

const DAY_MS = 86_400_000;

// 月曜を週の始まりとする（U272）。月曜 = 0 … 日曜 = 6。1970-01-01 は木曜。
const weekdayOfDay = (day: number): number => (((day + 3) % 7) + 7) % 7;

interface Classified {
  readonly heading: CandidateHeading;
  // 並べ替えの鍵（UTC のミリ秒）。期限不明は null。日付だけの期限は、その日が終わる時刻（翌日の 0 時）として
  // 並べる（並べるためだけで、時刻には変換しない）。タイムゾーンの違う期限も、同じ時間軸で比べる。
  readonly sortKey: number | null;
}

// 現地の日時（YYYY-MM-DDTHH:MM:SS）の UTC 時刻（ミリ秒）。夏時間の終わりで 2 回ある時刻は**後の回**、存在しない時刻
// （夏時間の隙間）はその直後の時刻にする。後の回にするのは、期限を早く過ぎたと見なして候補を解決しないため（U285）。
// zone が読めない・形が違うときは null。
function localToUtc(local: string, zone: string): number | null {
  const match =
    /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})$/u.exec(
      local,
    );
  if (match === null || localClock(0, zone) === null) return null;
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map(Number) as [number, number, number, number, number, number];
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const localOf = (at: number): string | null => {
    const clock = localClock(at, zone);
    return clock === null ? null : `${clock.date}T${clock.time}`;
  };
  // 目標の前後で使われる UTC との差（夏時間の前後の 2 つ）。その差で戻した時刻のうち、現地の時計が一致するものが回。
  const offsets = new Set<number>();
  for (const probe of [guess - DAY_MS, guess + DAY_MS]) {
    const text = localOf(probe);
    if (text !== null)
      offsets.add(Date.parse(`${text}Z`) - Math.floor(probe / 1000) * 1000);
  }
  const turns = [...offsets]
    .map((offset) => guess - offset)
    .filter((at) => localOf(at) === local);
  if (turns.length > 0) return Math.max(...turns);
  // 隙間の時刻: 現地の時計が初めてその時刻以降になる時点（直後）。時差は ±14 時間以内なので、この範囲に境目がある。
  let low = guess - 36 * 3_600_000;
  let high = guess + 36 * 3_600_000;
  const reaches = (at: number): boolean => {
    const text = localOf(at);
    return text !== null && text >= local;
  };
  while (high - low > 1000) {
    const mid = low + Math.floor((high - low) / 2 / 1000) * 1000;
    if (reaches(mid)) high = mid;
    else low = mid;
  }
  return reaches(low) ? low : high;
}

interface ParsedDeadline {
  readonly date: string;
  // 並べ替えの鍵（UTC のミリ秒）。
  readonly sortKey: number;
  // 「いま」の現地時計を読むタイムゾーン。時刻付きの期限はその期限の zone、日付だけは本人の zone。
  readonly clockZone: string;
  // 過ぎたか。時刻付きは確定した UTC の時点との比較（現地の文字列の比較は夏時間の終わりで逆戻りする）。
  readonly ended: (
    at: number,
    clock: { date: string; time: string },
  ) => boolean;
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
    const local = `${date}T${time.length === 5 ? `${time}:00` : time}`;
    const sortKey = localToUtc(local, deadline.zone);
    if (sortKey === null) return null;
    return {
      date,
      sortKey,
      clockZone: deadline.zone,
      ended: (at) => at > sortKey,
    };
  }
  if (deadline.kind === 'date') {
    if (!isRealLocalDateTime(`${deadline.date}T00:00`)) return null;
    const day = deadline.date;
    const next = new Date(dateToDay(day) * DAY_MS + DAY_MS)
      .toISOString()
      .slice(0, 10);
    const sortKey = localToUtc(`${next}T00:00:00`, zone);
    if (sortKey === null) return null;
    return {
      date: day,
      sortKey,
      clockZone: zone,
      ended: (_at, clock) => day < clock.date,
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
  return clock === null ? null : parsed.ended(at, clock);
}

function classify(
  item: CandidateOrderItem,
  now: number,
  zone: string,
): Classified {
  const unknown: Classified = { heading: 'unknown', sortKey: null };
  const parsed = parseDeadline(item.deadline, zone);
  if (parsed === null) return unknown;
  const { sortKey } = parsed;
  // 見出し（今日・明日・今週）は、期限の zone ではなく本人の zone の暦で決める（U287）。時刻付きの期限は、確定した時点を
  // 本人の zone の現地の日付に直す。日付だけの期限は本人の暦の日付そのもの。
  const clock = localClock(now, zone);
  if (clock === null) return unknown;
  const own = localClock(sortKey, zone);
  const date = item.deadline.kind === 'instant' ? own?.date : parsed.date;
  if (date === undefined) return unknown;
  if (parsed.ended(now, clock) && item.initial_import)
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

// 受信の時刻が読めない候補は、最も古いものとして並べる（隠さない）。
const receivedMs = (value: string): number =>
  parseUtc(value) ?? Number.NEGATIVE_INFINITY;

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
  const now = parseUtc(context.now);
  if (now === null) return { ok: false, reason: 'now_invalid' };
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
        return (ka - kb < 0 ? -1 : 1) * direction;
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
