// 外部の家計簿サービス（マネーフォワード ME）の入出金履歴の書き出し（CSV）を家計の記録にする規則（ADR 0164）。
//
// - 列は見出しの名前で探す（並びに頼らない）。公式の案内の列: 計算対象・日付・内容・金額（円）・保有金融機関・大項目・
//   中項目・メモ・振替・ID。金額の列の括弧は全角・半角のどちらも受ける。日付・金額の書き方と文字コードは公式の案内で
//   確かめられていない（U336）ので、日付は YYYY/MM/DD と YYYY-MM-DD を、金額は桁区切りのコンマと先頭の符号を受ける。
// - 向き: 振替が 1 なら振替、金額が負なら支出、正なら収入。金額 0 の行は取り込まない。計算対象が 0 の行（本人が集計から
//   外した行）も取り込まない。
// - 分類: 支出は大項目の名前（domain の分類の表示名と同じ）で引き、引けなければ未分類。収入は収入、振替は振替。
// - 店名は「内容」。店名・メモ・支払い手段（保有金融機関）が家計の記録の検査（長さ・制御文字・長い数字の並び）に
//   合わなければ、その項目だけを空にして行は取り込む（口座番号の写し込みを記録に入れない）。
// - 同じ行を二度取り込まないための鍵は ID の列（出所の鍵の材料、ADR 0158）。
// 文字コードの変換・ファイルの読み取り・暗号・DB はここで扱わない。

import {
  HOUSEHOLD_AMOUNT_MAX,
  householdCategoryByLabel,
  householdContentErrors,
  householdDefaultCategory,
  isHouseholdDate,
} from './household.js';
import type { HouseholdDirection, HouseholdEntryContent } from './household.js';

// 一度に読む行の上限（見出しを除く）。これを超える書き出しは分けて取り込む。
export const HOUSEHOLD_IMPORT_ROW_LIMIT = 50_000;

export type HouseholdImportSkip =
  // 計算対象が 0（本人が集計から外した行）。
  | 'excluded'
  // 金額が 0。
  | 'zero_amount'
  // 日付・金額・ID が読めない。
  | 'unreadable';

export interface HouseholdImportRow {
  // 書き出しの行の ID（出所の鍵の材料）。
  readonly row_id: string;
  readonly content: HouseholdEntryContent;
  // 大項目から分類を決めたか（未分類・収入・振替でない分類）。店名の規則を学ぶのに使う。
  readonly categorized: boolean;
}

export type HouseholdImportRead =
  | {
      readonly ok: true;
      // 書き出しの順。
      readonly rows: readonly HouseholdImportRow[];
      readonly skipped: Readonly<Record<HouseholdImportSkip, number>>;
    }
  | {
      readonly ok: false;
      readonly reason:
        'csv_invalid' | 'header_missing' | 'too_many_rows' | 'duplicate_row_id';
    };

/**
 * RFC 4180 の CSV を行と欄に分ける。先頭の BOM を除き、改行は CRLF・LF の両方を受ける。引用符の中の改行・コンマ・
 * 二重の引用符を扱う。閉じていない引用符・引用符の後の余計な文字は null。末尾の空行は数えない。
 */
export function splitHouseholdCsv(text: string): string[][] | null {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let index = 0;
  const endField = () => {
    row.push(field);
    field = '';
    afterQuote = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (index < source.length) {
    const char = source[index] as string;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        afterQuote = true;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === ',') {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r' || char === '\n') {
      endRow();
      index += char === '\r' && source[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (afterQuote) return null;
    if (char === '"') {
      if (field.length > 0) return null;
      quoted = true;
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (quoted) return null;
  if (field.length > 0 || row.length > 0 || afterQuote) endRow();
  while (
    rows.length > 0 &&
    (rows.at(-1) as string[]).every((cell) => cell.trim().length === 0)
  )
    rows.pop();
  return rows;
}

const COLUMNS = {
  included: ['計算対象'],
  date: ['日付'],
  content: ['内容'],
  amount: ['金額（円）', '金額(円)'],
  institution: ['保有金融機関'],
  major: ['大項目'],
  memo: ['メモ'],
  transfer: ['振替'],
  id: ['ID'],
} as const;

type Column = keyof typeof COLUMNS;

const DATE = /^([0-9]{4})[/-]([0-9]{1,2})[/-]([0-9]{1,2})$/u;
const AMOUNT = /^([+-]?)([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)$/u;
const ROW_ID = /^[\x21-\x7e]{1,256}$/u;

function dateOf(value: string): string | null {
  const match = DATE.exec(value.trim());
  if (match === null) return null;
  const date = `${match[1] as string}-${(match[2] as string).padStart(2, '0')}-${(match[3] as string).padStart(2, '0')}`;
  return isHouseholdDate(date) ? date : null;
}

// 符号つきの整数の円。読めない・上限を超えるなら null。
function amountOf(value: string): number | null {
  const match = AMOUNT.exec(value.trim());
  if (match === null) return null;
  const magnitude = Number((match[2] as string).replaceAll(',', ''));
  if (!Number.isSafeInteger(magnitude) || magnitude > HOUSEHOLD_AMOUNT_MAX)
    return null;
  return match[1] === '-' ? -magnitude : magnitude;
}

// 前後の空白を除き、空白の並びを 1 つにする。空なら null。
function textOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length === 0 ? null : text;
}

// 長さの上限で切る（コードポイントで数える）。
const clip = (text: string, limit: number): string =>
  [...text].slice(0, limit).join('');

// 家計の記録の検査に合わない項目は空にする（店名・メモ・支払い手段の順に確かめる）。
function cleaned(content: HouseholdEntryContent): HouseholdEntryContent {
  let next = content;
  for (const key of ['merchant', 'memo', 'payment'] as const) {
    const errors = householdContentErrors(next);
    if (errors.some((reason) => reason.startsWith(`${key}_`)))
      next = { ...next, [key]: null };
  }
  return next;
}

/** 書き出しの CSV（文字列にしたもの）を家計の記録の行にする。 */
export function readMoneyforwardExport(text: string): HouseholdImportRead {
  const table = splitHouseholdCsv(text);
  if (table === null) return { ok: false, reason: 'csv_invalid' };
  const header = (table[0] ?? []).map((cell) => cell.trim());
  const position = {} as Record<Column, number>;
  for (const [column, names] of Object.entries(COLUMNS) as [
    Column,
    readonly string[],
  ][]) {
    const found = header.findIndex((cell) => names.includes(cell));
    if (found === -1) return { ok: false, reason: 'header_missing' };
    position[column] = found;
  }
  const body = table.slice(1);
  if (body.length > HOUSEHOLD_IMPORT_ROW_LIMIT)
    return { ok: false, reason: 'too_many_rows' };
  const skipped: Record<HouseholdImportSkip, number> = {
    excluded: 0,
    zero_amount: 0,
    unreadable: 0,
  };
  const rows: HouseholdImportRow[] = [];
  const seen = new Set<string>();
  for (const cells of body) {
    if (cells.every((cell) => cell.trim().length === 0)) continue;
    const cell = (column: Column): string => cells[position[column]] ?? '';
    if (cell('included').trim() === '0') {
      skipped.excluded += 1;
      continue;
    }
    const rowId = cell('id').trim();
    const date = dateOf(cell('date'));
    const amount = amountOf(cell('amount'));
    if (!ROW_ID.test(rowId) || date === null || amount === null) {
      skipped.unreadable += 1;
      continue;
    }
    if (amount === 0) {
      skipped.zero_amount += 1;
      continue;
    }
    if (seen.has(rowId)) return { ok: false, reason: 'duplicate_row_id' };
    seen.add(rowId);
    const direction: HouseholdDirection =
      cell('transfer').trim() === '1'
        ? 'transfer'
        : amount < 0
          ? 'expense'
          : 'income';
    const named = householdCategoryByLabel(cell('major'));
    const category =
      direction === 'expense' && named?.direction === 'expense'
        ? named.id
        : householdDefaultCategory(direction);
    const merchant = textOf(cell('content'));
    const memo = textOf(cell('memo'));
    const payment = textOf(cell('institution'));
    const content = cleaned({
      direction,
      amount_yen: Math.abs(amount),
      occurred_on: date,
      occurred_time: null,
      category,
      merchant: merchant === null ? null : clip(merchant, 100),
      memo: memo === null ? null : clip(memo, 500),
      payment: payment === null ? null : clip(payment, 40),
    });
    if (householdContentErrors(content).length > 0) {
      skipped.unreadable += 1;
      continue;
    }
    rows.push({
      row_id: rowId,
      content,
      categorized: direction === 'expense' && category !== 'uncategorized',
    });
  }
  return { ok: true, rows, skipped };
}

/**
 * 利用通知の記録と同じ利用かを見る鍵（日付と金額。支出だけ）。書き出しにはカード会社の利用通知と同じ利用が入るので、
 * 同じ日・同じ金額の利用通知の記録があれば取り込まない（ADR 0164、U335）。
 */
export function householdNoticeMatchKey(
  content: Pick<
    HouseholdEntryContent,
    'direction' | 'occurred_on' | 'amount_yen'
  >,
): string | null {
  return content.direction === 'expense'
    ? `${content.occurred_on}|${String(content.amount_yen)}`
    : null;
}
