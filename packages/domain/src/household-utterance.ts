// 会話の一言からの家計の記録の候補（家計簿 段階 3 の一部、ADR 0171）。
//
// 本人が会話で言った一言（「コンビニで 500 円使った」）を、決まった規則だけで読み、手入力の欄（ADR 0167）に入れる値の
// 候補を作る。LLM は使わない。候補は記録ではない。記録を作るのは、本人が家計簿の欄で中身を確かめて「足す」を押したとき
// （POST /v1/household/entries）だけ。
// - 支出だけを読む。支出を表す言い方（使った・払った・買った・かかった・購入した）がなければ読まない（none）。
//   問い（「使ったっけ」「？」で終わる）と仮定（「使ったら」）も読まない。円・¥・通貨の言葉がなければ読まない。
// - 金額は円の正の整数を一つだけ読む（「500 円」「1,280 円」「¥500」「1 万 2000 円」「3 千円」）。取り消し・返金の言葉、
//   円以外の通貨、負の金額、複数の金額、0 円・桁の多すぎる金額・3 桁ごとでないコンマ、読めない金額（漢数字・小数）は
//   候補にせず、理由を返す（unreadable）。
// - 日付は「今日」「昨日」「おととい」だけを読み、日付の言葉がなければ今日にする。読めない日付の言葉（「3 日」「先週」）や
//   違う日付の言葉が二つあれば null（本人が入れる）。
// - 店名は金額のすぐ前の「〜で」の部分（読点か文の頭まで。頭の「今日は」などの時の言葉を除く）。記録に入れられない店名
//   （長すぎる・制御文字・12 桁以上の数字の並び）は入れない。支払い手段は「現金で」「カードで」などの決まった言葉だけを読む。
// - 分類は読まない（未分類のまま。店名の規則は中枢が当てる。ADR 0167）。
// 時計は呼び出し側が渡す今日の日付（YYYY-MM-DD）だけを使う。

import {
  HOUSEHOLD_AMOUNT_MAX,
  householdMerchantErrors,
  isHouseholdDate,
} from './household.js';

export interface HouseholdUtteranceDraft {
  readonly amount_yen: number;
  // 利用した日。読めない日付の言葉があれば null。
  readonly occurred_on: string | null;
  readonly merchant: string | null;
  readonly payment: string | null;
}

export type HouseholdUtteranceUnreadable =
  | 'amount_missing'
  | 'amount_invalid'
  | 'several_amounts'
  | 'negative_amount'
  | 'foreign_currency'
  | 'cancellation';

export type HouseholdUtteranceReading =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'unreadable';
      readonly reason: HouseholdUtteranceUnreadable;
    }
  | { readonly kind: 'draft'; readonly draft: HouseholdUtteranceDraft };

// 支出を表す言い方。後ろに「ら」「り」が続けば仮定・例示なので読まない。
const SPENDING =
  /(?:使った|使いました|つかった|払った|払いました|はらった|買った|買いました|かかった|かかりました|購入した|購入しました)(?!ら|り)/u;
// 問い。
const QUESTION = /[?]\s*$|っけ/u;
// 円の金額の話か。「円安」のような数のない「円」は数えない（漢数字の金額は数える。読めないと知らせる）。
// 円以外の通貨の言葉（FOREIGN）も金額の話として数える。
const YEN_MONEY = /[0-9〇一二三四五六七八九十百千万]\s*円|¥/u;
const CANCELLATION = /取り消|取消|キャンセル|返金|返品|払い戻|払戻/u;
const FOREIGN =
  /[$€£₩]|[0-9]\s*(?:ドル|ユーロ|ポンド|ウォン|元|ペソ|バーツ|ルピー)|(?:USD|EUR|GBP|KRW|CNY)(?![A-Z])/iu;
// 「500 円」「1,280 円」「1 万 2000 円」「3 千円」「1 万円」。数の途中（小数点・コンマの後）からは始めない。
const YEN_SUFFIX =
  /(?<![0-9,.])(?:([0-9]+)\s*万\s*)?(?:([0-9]+)\s*千\s*)?([0-9][0-9,]*)?\s*円/gu;
// 「¥500」「¥1,280」。後ろに「円」が続くもの（「¥500 円」）は円の形の方で数える。
const YEN_PREFIX = /¥\s*([0-9][0-9,]*)(?![0-9.]|\s*[万千])/gu;
const PLAIN = /^[1-9][0-9]*$/u;
const GROUPED = /^[1-9][0-9]{0,2}(?:,[0-9]{3})+$/u;
const NEGATIVE_BEFORE = /(?:[-−‐‑–—▲△]|マイナス)\s*$/u;

const RELATIVE_DAYS: Readonly<Record<string, number>> = {
  今日: 0,
  きょう: 0,
  本日: 0,
  昨日: -1,
  きのう: -1,
  一昨日: -2,
  おととい: -2,
};
const RELATIVE_WORD = /一昨日|おととい|昨日|きのう|今日|きょう|本日/gu;
const OTHER_DATE =
  /[0-9]+\s*(?:月|日)|先週|先月|先日|この前|こないだ|週末|[0-9]+\/[0-9]+|曜/u;
// 店名の頭から除く時と日付の言葉。
const LEADING_TIME =
  /^(?:(?:今日|きょう|本日|昨日|きのう|一昨日|おととい|さっき|先ほど|今朝|けさ|夕方|お昼|先週|先月|先日|この前|こないだ|週末|(?:[0-9]+\s*月\s*)?[0-9]+\s*日)(?:は|に|の)?|(?:朝|昼|夜)(?:は|に|の))\s*/u;
const PAYMENT_WORDS: readonly string[] = [
  '現金',
  'カード',
  'クレジットカード',
  'クレカ',
  '電子マネー',
];

interface AmountMatch {
  readonly start: number;
  readonly end: number;
  // null は形が金額として正しくない（0 円・桁が多すぎる・コンマの位置）。
  readonly value: number | null;
}

function restValue(rest: string, withUnits: boolean): number | null {
  if (withUnits) return /^[0-9]{1,4}$/u.test(rest) ? Number(rest) : null;
  if (!PLAIN.test(rest) && !GROUPED.test(rest)) return null;
  const digits = rest.replaceAll(',', '');
  return digits.length > 10 ? null : Number(digits);
}

function yenSuffixValue(
  man: string | undefined,
  sen: string | undefined,
  rest: string | undefined,
): number | null {
  if (man !== undefined && !PLAIN.test(man)) return null;
  if (sen !== undefined && !/^[1-9]$/u.test(sen)) return null;
  const units = man !== undefined || sen !== undefined;
  let value = 0;
  if (man !== undefined) {
    if (man.length > 6) return null;
    value += Number(man) * 10_000;
  }
  if (sen !== undefined) value += Number(sen) * 1_000;
  if (rest !== undefined) {
    const tail = restValue(rest, units);
    if (tail === null) return null;
    // 「1 万 12000 円」「3 千 1500 円」のような単位より大きい端数は読まない。
    if (sen !== undefined && tail >= 1_000) return null;
    if (man !== undefined && tail >= 10_000) return null;
    value += tail;
  }
  return value;
}

function amountMatches(text: string): AmountMatch[] {
  const found: AmountMatch[] = [];
  for (const match of text.matchAll(YEN_SUFFIX)) {
    const [whole, man, sen, rest] = match;
    // 数のない「円」（「円安」）は金額ではない。
    if (man === undefined && sen === undefined && rest === undefined) continue;
    found.push({
      start: match.index,
      end: match.index + whole.length,
      value: yenSuffixValue(man, sen, rest),
    });
  }
  for (const match of text.matchAll(YEN_PREFIX)) {
    const start = match.index;
    const end = start + match[0].length;
    // 「¥500 円」は円の形で数えた範囲と重なる。
    if (found.some((other) => start < other.end && other.start < end)) continue;
    found.push({
      start,
      end,
      value: restValue(match[1] as string, false),
    });
  }
  return found.sort((a, b) => a.start - b.start);
}

function shiftDate(today: string, days: number): string | null {
  if (!isHouseholdDate(today)) return null;
  const [year, month, day] = today.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const text = shifted.toISOString().slice(0, 10);
  return isHouseholdDate(text) ? text : null;
}

function readDate(text: string, today: string): string | null {
  if (OTHER_DATE.test(text)) return null;
  const offsets = new Set(
    [...text.matchAll(RELATIVE_WORD)].map(
      (match) => RELATIVE_DAYS[match[0]] as number,
    ),
  );
  if (offsets.size > 1) return null;
  return shiftDate(today, offsets.size === 0 ? 0 : ([...offsets][0] as number));
}

function withoutLeadingTime(phrase: string): string {
  let current = phrase.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = current.replace(LEADING_TIME, '');
    if (next === current) break;
    current = next;
  }
  return current.trim();
}

// 金額のすぐ前の「〜で」の部分（読点か文の頭まで）。「で」で終わらなければ null。
function phraseBefore(prefix: string): string | null {
  const trimmed = prefix.replace(/[\s、,]+$/u, '');
  if (!trimmed.endsWith('で')) return null;
  const body = trimmed.slice(0, -1);
  return withoutLeadingTime(/[^、,。.!]*$/u.exec(body)?.[0] ?? '');
}

// 店名と支払い手段。「コンビニで現金で」「現金でコンビニで」「コンビニで」「現金で」を読む。
function readPlace(prefix: string): {
  readonly merchant: string | null;
  readonly payment: string | null;
} {
  const phrase = phraseBefore(prefix);
  if (phrase === null || phrase === '')
    return { merchant: null, payment: null };
  let merchant: string | null = phrase;
  let payment: string | null = null;
  for (const word of PAYMENT_WORDS) {
    if (phrase === word) {
      payment = word;
      merchant = null;
    } else if (phrase.endsWith(`で${word}`)) {
      payment = word;
      merchant = withoutLeadingTime(phrase.slice(0, -(word.length + 1)));
    } else if (phrase.startsWith(`${word}で`)) {
      payment = word;
      merchant = withoutLeadingTime(phrase.slice(word.length + 1));
    } else continue;
    break;
  }
  if (
    merchant !== null &&
    (merchant === '' || householdMerchantErrors(merchant).length > 0)
  )
    merchant = null;
  return { merchant, payment };
}

/**
 * 会話の一言を決まった規則で読み、家計の記録（支出）の候補を返す。today は呼び出し側の今日の日付（YYYY-MM-DD）。
 * 候補は手入力の欄に入れる値で、記録ではない（本人が確かめて足すまで何も保存しない）。
 */
export function readHouseholdUtterance(
  utterance: string,
  today: string,
): HouseholdUtteranceReading {
  const text = utterance.normalize('NFKC').trim();
  if (
    !SPENDING.test(text) ||
    QUESTION.test(text) ||
    !(YEN_MONEY.test(text) || FOREIGN.test(text))
  )
    return { kind: 'none' };
  const unreadable = (
    reason: HouseholdUtteranceUnreadable,
  ): HouseholdUtteranceReading => ({ kind: 'unreadable', reason });
  if (CANCELLATION.test(text)) return unreadable('cancellation');
  if (FOREIGN.test(text)) return unreadable('foreign_currency');
  const amounts = amountMatches(text);
  if (amounts.length === 0) return unreadable('amount_missing');
  if (amounts.length > 1) return unreadable('several_amounts');
  const amount = amounts[0] as AmountMatch;
  if (NEGATIVE_BEFORE.test(text.slice(0, amount.start)))
    return unreadable('negative_amount');
  if (
    amount.value === null ||
    amount.value < 1 ||
    amount.value > HOUSEHOLD_AMOUNT_MAX
  )
    return unreadable('amount_invalid');
  const place = readPlace(text.slice(0, amount.start));
  return {
    kind: 'draft',
    draft: {
      amount_yen: amount.value,
      occurred_on: readDate(text, today),
      merchant: place.merchant,
      payment: place.payment,
    },
  };
}
