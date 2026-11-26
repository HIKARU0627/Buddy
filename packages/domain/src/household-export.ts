// 家計簿の記録を本人が表計算ソフトなどで見るための CSV にする規則（ADR 0172）。副作用はなく、読んだ記録を文字列にするだけ。
//
// - 列: 先頭の 10 列は、取り込む書き出し（ADR 0164）と同じ見出し・同じ意味（計算対象・日付・内容・金額（円）・保有金融機関・
//   大項目・中項目・メモ・振替・ID）にする。取り込みは列を見出しの名前で探すので、後ろに足した 3 列（時刻・向き・出所の種類）は
//   取り込みに影響しない。金額は支出を負、収入と振替を正の整数にする（振替は「振替」の列が 1）。ID は Buddy の記録の ID に
//   `buddy:` を付けた値で、空の Buddy へ取り込み直しても二重にならない。
// - 並び: 日付の古い順（同じ日は時刻の早い順。時刻のない記録が先。それも同じなら、入力が中枢の並び（新しい順）なので、その逆）。
// - CSV の書き方: 区切りはコンマ、行末は CRLF（RFC 4180）。コンマ・引用符・改行・前後の空白を含む値は引用符で囲み、中の引用符は
//   二つにする。先頭に BOM（U+FEFF）を付ける（表計算ソフトが UTF-8 と判断するため。ADR 0172）。
// - CSV 注入: 店名・メモ・支払い手段（本人や外部が書いた文字）が、表計算ソフトで式として解釈されうる文字（=、+、-、@、
//   タブ、復帰。全角の＝＋－＠も含む。先頭の空白を飛ばして判定する）で始まるときは、先頭に `'` を付けて文字として開かせる。
//   金額の列の符号は Buddy が作った数字なので守りの対象にしない。
// 文字コードの変換・ファイルの書き込み・保存先の選択はここで扱わない（端末の main）。

import {
  HOUSEHOLD_AMOUNT_MAX,
  householdCategory,
  householdMonthShift,
  householdMonthSpan,
  isHouseholdDate,
} from './household.js';
import type { HouseholdDirection, HouseholdSourceKind } from './household.js';

// 一度に書き出す月の数の上限（10 年）。月ごとに 1 回ずつ中枢から読むので、読む回数の上限でもある（ADR 0172）。
export const HOUSEHOLD_EXPORT_MONTH_MAX = 120;

export const HOUSEHOLD_EXPORT_HEADER = [
  '計算対象',
  '日付',
  '内容',
  '金額（円）',
  '保有金融機関',
  '大項目',
  '中項目',
  'メモ',
  '振替',
  'ID',
  '時刻',
  '向き',
  '出所の種類',
] as const;

export const HOUSEHOLD_EXPORT_DIRECTION_LABELS: Readonly<
  Record<HouseholdDirection, string>
> = { expense: '支出', income: '収入', transfer: '振替' };

export const HOUSEHOLD_EXPORT_SOURCE_LABELS: Readonly<
  Record<HouseholdSourceKind, string>
> = {
  mail_notice: '利用通知メール',
  csv_import: '書き出しの取り込み',
  manual: '手入力',
};

// 書き出す記録 1 件（中枢の GET /v1/household/months/{month} の記録のうち書き出す項目）。
export interface HouseholdExportEntry {
  readonly entry_id: string;
  readonly source_kind: HouseholdSourceKind;
  readonly direction: HouseholdDirection;
  readonly amount_yen: number;
  readonly occurred_on: string;
  readonly occurred_time: string | null;
  readonly category: string;
  readonly merchant: string | null;
  readonly memo: string | null;
  readonly payment: string | null;
}

/**
 * from から to までの月（両端を含む。古い月から）。形の誤り・逆順・2000〜2099 年の外・上限（120 か月）を超える範囲は null。
 */
export function householdExportMonths(
  from: string,
  to: string,
): string[] | null {
  const span = householdMonthSpan(from, to);
  if (span === null || span > HOUSEHOLD_EXPORT_MONTH_MAX) return null;
  const months: string[] = [];
  for (let offset = 0; offset < span; offset += 1) {
    const month = householdMonthShift(from, offset);
    if (month === null) return null;
    months.push(month);
  }
  return months;
}

/** 保存先の候補にするファイル名（日本語・空白・記号を含めない）。範囲が一月なら 1 つの月だけを入れる。 */
export function householdExportFileName(from: string, to: string): string {
  return from === to
    ? `buddy-household-${from}.csv`
    : `buddy-household-${from}_${to}.csv`;
}

const FORMULA_START = /^(?:[\t\r]|\s*[=+\-@＝＋－＠])/u;

/** 表計算ソフトで式として解釈されうる先頭の文字を `'` で無効にする。 */
export function householdCsvGuard(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** CSV の 1 つの値。コンマ・引用符・改行・前後の空白を含むときだけ引用符で囲む。 */
export function householdCsvField(text: string): string {
  return /[",\r\n]|^\s|\s$/u.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,100}$/u;

// 文字の並びを文字コードの順に比べる（言語や地域の設定で順が変わらないように）。
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function rowOf(entry: HouseholdExportEntry): string | null {
  if (
    !isHouseholdDate(entry.occurred_on) ||
    !Number.isSafeInteger(entry.amount_yen) ||
    entry.amount_yen < 1 ||
    entry.amount_yen > HOUSEHOLD_AMOUNT_MAX ||
    (entry.occurred_time !== null && !TIME.test(entry.occurred_time)) ||
    !Object.hasOwn(HOUSEHOLD_EXPORT_DIRECTION_LABELS, entry.direction) ||
    !Object.hasOwn(HOUSEHOLD_EXPORT_SOURCE_LABELS, entry.source_kind) ||
    !ENTRY_ID.test(entry.entry_id)
  )
    return null;
  const signed =
    entry.direction === 'expense' ? -entry.amount_yen : entry.amount_yen;
  const text = (value: string | null): string =>
    householdCsvField(householdCsvGuard(value ?? ''));
  return [
    '1',
    entry.occurred_on.replaceAll('-', '/'),
    text(entry.merchant),
    String(signed),
    text(entry.payment),
    householdCsvField(
      householdCategory(entry.category)?.label ?? entry.category,
    ),
    '',
    text(entry.memo),
    entry.direction === 'transfer' ? '1' : '0',
    `buddy:${entry.entry_id}`,
    entry.occurred_time ?? '',
    HOUSEHOLD_EXPORT_DIRECTION_LABELS[entry.direction],
    HOUSEHOLD_EXPORT_SOURCE_LABELS[entry.source_kind],
  ].join(',');
}

/**
 * 記録を CSV の文字列（先頭の BOM・見出し・CRLF の行）にする。entries は中枢の並び（新しい順）で渡し、日付の古い順に
 * 並べ直す。記録が空でも見出しだけの CSV を返す。1 件でも不正な記録（日付・金額・時刻・向き・出所・ID）があれば、
 * 欠けたファイルを作らないために null を返す。
 */
export function buildHouseholdCsv(
  entries: readonly HouseholdExportEntry[],
): string | null {
  const ordered = [...entries]
    .reverse()
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        compare(a.entry.occurred_on, b.entry.occurred_on) ||
        compare(a.entry.occurred_time ?? '', b.entry.occurred_time ?? '') ||
        a.index - b.index,
    );
  const lines: string[] = [HOUSEHOLD_EXPORT_HEADER.join(',')];
  for (const { entry } of ordered) {
    const row = rowOf(entry);
    if (row === null) return null;
    lines.push(row);
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
