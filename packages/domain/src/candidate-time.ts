// 気づきの規則が共有する時刻の読み取り（ADR 0115〜0117）。時計は引数で注入し、端末の既定のタイムゾーンへ黙って置き換えない。

const UTC_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;

// UTC の RFC 3339 だけを読む。暦にない日時（2 月 30 日）は繰り上げず null。
export function parseCandidateUtc(value: unknown): number | null {
  if (typeof value !== 'string' || !UTC_TIME.test(value)) return null;
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) return null;
  return new Date(millis).toISOString().slice(0, 19) === value.slice(0, 19)
    ? millis
    : null;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  if (!ZONE_NAME.test(zone)) return null;
  if (!formatters.has(zone)) {
    let formatter: Intl.DateTimeFormat | null;
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        calendar: 'gregory',
        numberingSystem: 'latn',
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      formatter = null;
    }
    formatters.set(zone, formatter);
  }
  return formatters.get(zone) ?? null;
}

// その時刻の、タイムゾーンでの現地の日付（YYYY-MM-DD）と時刻（HH:MM:SS）。zone が読めなければ null。
export function candidateLocalClock(
  at: number,
  zone: string,
): { readonly date: string; readonly time: string } | null {
  const formatter = formatterFor(zone);
  if (formatter === null) return null;
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(at)))
    parts[part.type] = part.value;
  const { year, month, day, hour, minute, second } = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  )
    return null;
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
  };
}

// 本人のタイムゾーンとして使える IANA の名前か。
export const isCandidateZone = (zone: string): boolean =>
  candidateLocalClock(0, zone) !== null;

const DAY_MS = 86_400_000;

// 現地の日付の 0 時の UTC 時刻（ミリ秒）。0 時が夏時間の切り替えで存在しない日は、その日が始まる最初の時刻。
// 現地の日付は時刻とともに戻らないので、二分探索で求める。date が暦にない・zone が読めなければ null。
export function zonedStartOfDay(date: string, zone: string): number | null {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/u.exec(date);
  if (match === null || candidateLocalClock(0, zone) === null) return null;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const utc = Date.UTC(year, month - 1, day);
  if (new Date(utc).toISOString().slice(0, 10) !== date) return null;
  // 時差は ±14 時間以内なので、この範囲に境目がある。
  let low = utc - 36 * 3_600_000;
  let high = utc + 36 * 3_600_000;
  const reaches = (at: number): boolean =>
    (candidateLocalClock(at, zone)?.date ?? '') >= date;
  while (high - low > 1000) {
    const mid = low + Math.floor((high - low) / 2 / 1000) * 1000;
    if (reaches(mid)) high = mid;
    else low = mid;
  }
  return reaches(low) ? low : high;
}

export const candidateDateToDay = (date: string): number => {
  const [year, month, day] = date.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  return Date.UTC(year, month - 1, day) / DAY_MS;
};
