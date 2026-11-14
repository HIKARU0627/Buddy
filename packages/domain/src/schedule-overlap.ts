// 予定の重複の判定（設計 04 気づきの作成／予定重複、設計 11 §4、ADR 0117）。LLM ではなく時刻の比較だけで求める。
// 入力の予定は、取得側（connector）が繰り返しを個別の回へ展開したもの。題・参加者・本文は受け取らない。
// 区間は開始を含み終了を含まない。終了と次の開始が同時なら重複にしない。

import {
  candidateLocalClock,
  parseCandidateUtc,
  zonedStartOfDay,
} from './candidate-time.js';
import type { Deadline } from './extraction.js';

export type CalendarOccurrenceTime =
  | {
      readonly kind: 'timed';
      // UTC の ISO 8601（末尾 Z）。
      readonly start: string;
      readonly end: string;
    }
  | {
      // 終日。時刻付きの短い予定へ変換せず、日付のまま持つ。終了の日付は含まない（翌日）。
      readonly kind: 'all_day';
      readonly start_date: string;
      readonly end_date: string;
    };

export interface CalendarOccurrence {
  readonly calendar_id: string;
  readonly event_id: string;
  // 同じ予定を複数のカレンダーに持つときの同一性（iCalUID）。無ければ null。
  readonly ical_uid: string | null;
  // 繰り返しの個別の回を見分ける値（その回の元の開始）。繰り返しでなければ null。
  readonly recurrence_id: string | null;
  readonly status: 'confirmed' | 'tentative' | 'cancelled';
  // 本人の出欠。参加者のいない予定や主催者は 'none'。
  readonly response:
    'accepted' | 'tentative' | 'needs_action' | 'declined' | 'none';
  // 元カレンダーの busy / free（透明度）。false は空き時間扱い。
  readonly busy: boolean;
  readonly time: CalendarOccurrenceTime;
}

export type OverlapExclusion =
  'cancelled' | 'declined' | 'free_time' | 'time_invalid';

export type OverlapPeriod =
  | {
      readonly kind: 'timed';
      readonly start: string;
      readonly end: string;
    }
  | {
      readonly kind: 'all_day';
      readonly start_date: string;
      readonly end_date: string;
    };

export interface ScheduleOverlap {
  // 重複する 2 つの予定の参照（昇順）。同じ予定は複数のカレンダーにあっても 1 つの参照になる。
  readonly refs: readonly [string, string];
  // 参照ごとの予定の元の識別（カレンダーと予定の ID。畳んだ同一の予定は先頭の 1 つ）。
  readonly events: readonly [
    { readonly calendar_id: string; readonly event_id: string },
    { readonly calendar_id: string; readonly event_id: string },
  ];
  readonly period: OverlapPeriod;
  // どちらかに iCalUID が無く、別々の予定だと確かめられないとき 'unconfirmed'（重複候補として根拠を示す）。
  readonly identity: 'distinct' | 'unconfirmed';
}

export interface OverlapWindow {
  // 判定する期間 [start, end)。UTC の ISO 8601。重複する時間帯がこの期間と交わるものだけを返す。
  readonly start: string;
  readonly end: string;
}

export type ScheduleOverlapResult =
  | {
      readonly ok: true;
      readonly overlaps: readonly ScheduleOverlap[];
      readonly excluded: readonly {
        readonly calendar_id: string;
        readonly event_id: string;
        readonly reason: OverlapExclusion;
      }[];
    }
  | {
      readonly ok: false;
      readonly reason: 'window_invalid' | 'zone_invalid';
    };

// 予定の参照。iCalUID があればカレンダーをまたいで同じ予定を 1 つに、無ければカレンダーと予定の ID。どちらも繰り返しの回の識別を
// 含める（同じ予定の別の回を同じ参照にして、重複を見落とさない）。各部分は URI 成分として符号化するので、`#`・`/` を含む
// 識別子が別の組と同じ参照にならず、`@` も `%40` になる（参照に生のメールアドレスの形が残らない）。
export function calendarOccurrenceRef(event: CalendarOccurrence): string {
  const part = encodeURIComponent;
  const occurrence = part(event.recurrence_id ?? '');
  return event.ical_uid !== null
    ? `ical:${part(event.ical_uid)}#${occurrence}`
    : `id:${part(event.calendar_id)}/${part(event.event_id)}#${occurrence}`;
}

interface Resolved {
  readonly event: CalendarOccurrence;
  readonly ref: string;
  // UTC のミリ秒の区間 [start, end)。
  readonly start: number;
  readonly end: number;
  readonly allDay: boolean;
}

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;

function resolveTime(
  event: CalendarOccurrence,
  zone: string,
): { start: number; end: number; allDay: boolean } | null {
  const { time } = event;
  if (time.kind === 'timed') {
    const start = parseCandidateUtc(time.start);
    const end = parseCandidateUtc(time.end);
    if (start === null || end === null || end <= start) return null;
    return { start, end, allDay: false };
  }
  if (!DATE.test(time.start_date) || !DATE.test(time.end_date)) return null;
  if (time.end_date <= time.start_date) return null;
  const start = zonedStartOfDay(time.start_date, zone);
  const end = zonedStartOfDay(time.end_date, zone);
  if (start === null || end === null || end <= start) return null;
  return { start, end, allDay: true };
}

const iso = (millis: number): string =>
  new Date(millis).toISOString().replace('.000Z', 'Z');

const byEventId = (a: CalendarOccurrence, b: CalendarOccurrence): number =>
  a.calendar_id < b.calendar_id
    ? -1
    : a.calendar_id > b.calendar_id
      ? 1
      : a.event_id < b.event_id
        ? -1
        : a.event_id > b.event_id
          ? 1
          : 0;

// 重複する予定の組を返す。取消・辞退・空き時間扱いの予定は除き（理由を excluded に返す）、
// 時刻が読めない・終了が開始以前の予定は推測せず除く。同じ予定（参照と時間帯が同じ）は 1 つに畳み、
// 同じ参照の予定どうし（同じ予定の別の写し）は重複にしない。終日の予定は、本人のタイムゾーンの
// 日付の 0 時〜翌日の 0 時として時刻付きの予定と比べる（予定そのものは時刻に変換しない）。
export function findScheduleOverlaps(
  events: readonly CalendarOccurrence[],
  range: OverlapWindow,
  zone: string,
): ScheduleOverlapResult {
  const windowStart = parseCandidateUtc(range.start);
  const windowEnd = parseCandidateUtc(range.end);
  if (windowStart === null || windowEnd === null || windowEnd <= windowStart)
    return { ok: false, reason: 'window_invalid' };
  if (candidateLocalClock(0, zone) === null)
    return { ok: false, reason: 'zone_invalid' };

  const excluded: {
    calendar_id: string;
    event_id: string;
    reason: OverlapExclusion;
  }[] = [];
  const candidates: Resolved[] = [];
  for (const event of [...events].sort(byEventId)) {
    const reason: OverlapExclusion | null =
      event.status === 'cancelled'
        ? 'cancelled'
        : event.response === 'declined'
          ? 'declined'
          : !event.busy
            ? 'free_time'
            : null;
    const time = reason === null ? resolveTime(event, zone) : null;
    if (reason !== null || time === null) {
      excluded.push({
        calendar_id: event.calendar_id,
        event_id: event.event_id,
        reason: reason ?? 'time_invalid',
      });
      continue;
    }
    candidates.push({
      event,
      ref: calendarOccurrenceRef(event),
      start: time.start,
      end: time.end,
      allDay: time.allDay,
    });
  }

  // 同じ参照で同じ時間帯の写しは 1 つに畳む（先頭は ID の昇順で決める）。
  const unique: Resolved[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    const key = `${item.ref}|${item.start}|${item.end}|${item.allDay}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  unique.sort((a, b) => a.start - b.start || a.end - b.end);

  const found = new Map<string, ScheduleOverlap>();
  for (let i = 0; i < unique.length; i += 1) {
    const first = unique[i] as Resolved;
    for (let j = i + 1; j < unique.length; j += 1) {
      const second = unique[j] as Resolved;
      // 開始の昇順なので、これ以降は first の終了以降に始まる。終了と開始が同時なら重複にしない。
      if (second.start >= first.end) break;
      if (first.ref === second.ref) continue;
      const start = Math.max(first.start, second.start);
      const end = Math.min(first.end, second.end);
      if (!(start < end)) continue;
      // 期間 [windowStart, windowEnd) と交わらない重複は返さない。
      if (!(start < windowEnd && end > windowStart)) continue;
      const [x, y] = first.ref < second.ref ? [first, second] : [second, first];
      const bothAllDay = first.allDay && second.allDay;
      const period: OverlapPeriod = bothAllDay
        ? {
            kind: 'all_day',
            start_date: candidateLocalClock(start, zone)?.date ?? '',
            end_date: candidateLocalClock(end, zone)?.date ?? '',
          }
        : { kind: 'timed', start: iso(start), end: iso(end) };
      const overlap: ScheduleOverlap = {
        refs: [x.ref, y.ref],
        events: [
          { calendar_id: x.event.calendar_id, event_id: x.event.event_id },
          { calendar_id: y.event.calendar_id, event_id: y.event.event_id },
        ],
        period,
        identity:
          x.event.ical_uid === null || y.event.ical_uid === null
            ? 'unconfirmed'
            : 'distinct',
      };
      found.set(`${x.ref}\n${y.ref}\n${JSON.stringify(period)}`, overlap);
    }
  }
  const overlaps = [...found.values()].sort((a, b) => {
    const pa = a.period.kind === 'timed' ? a.period.start : a.period.start_date;
    const pb = b.period.kind === 'timed' ? b.period.start : b.period.start_date;
    if (pa !== pb) return pa < pb ? -1 : 1;
    const ra = `${a.refs[0]}\n${a.refs[1]}`;
    const rb = `${b.refs[0]}\n${b.refs[1]}`;
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
  return { ok: true, overlaps, excluded };
}

// 予定の重複の候補の期限（表示順に使う）。重複の始まり。終日どうしの重複は日付。
export function scheduleOverlapDeadline(
  overlap: ScheduleOverlap,
  zone: string,
): Deadline | null {
  if (overlap.period.kind === 'all_day')
    return {
      kind: 'date',
      date: overlap.period.start_date,
      original_text: '予定の重複',
    };
  const start = parseCandidateUtc(overlap.period.start);
  if (start === null) return null;
  const clock = candidateLocalClock(start, zone);
  if (clock === null) return null;
  return {
    kind: 'instant',
    local_datetime: `${clock.date}T${clock.time}`,
    zone,
    original_text: '予定の重複',
  };
}
