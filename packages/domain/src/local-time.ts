// 地域日時（契約の LocalDateTime）の意味検査（ADR 0027・0029）。
// 契約の Schema は文字列の形（YYYY-MM-DDTHH:MM[:SS]）だけを見る。暦に実在する日付と、時刻の範囲
// （時 0〜23・分 0〜59・秒 0〜59）をここで確かめる。年は 0001〜9999。うるう秒は受け付けない。

const LOCAL_DATE_TIME =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?$/u;

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isRealLocalDateTime(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = LOCAL_DATE_TIME.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map((part) => (part === undefined ? 0 : Number(part))) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const days =
    month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] as number);
  if (day > days) return false;
  return hour <= 23 && minute <= 59 && second <= 59;
}
