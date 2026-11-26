// 家計簿の請求予定（家計簿 段階 2、ADR 0176）。
//
// カード会社の請求のお知らせ（今回の請求の金額と引き落とし日を知らせるメール）を、家計の記録（利用・支払い済み）とは
// 別の「請求予定」として読む。請求の金額は、利用通知で記録済みの利用を後からまとめて知らせるものなので、家計の記録として
// 月の支出に足すと二重の計上になる。そのため請求予定は家計の記録（household_entries）に入れず、月の合計・予算・定期の
// 支出の計算に渡さない。
// - 送り主の確かめ: 利用通知と同じ（checkHouseholdNoticeSender。送信元のドメインの一覧と、受信サーバーの DMARC・DKIM
//   の合格。ADR 0159）。呼び出し側が確かめてから、この規則に会社（issuer）を渡す。
// - 件名: 請求・支払い・引き落としの金額や予定を知らせる件名だけを読む。キャンペーン・ポイント・引き落としの失敗・
//   督促・変更などの語がある件名は読まない。利用通知の件名（householdNoticeSubjectKind が usage）は請求として読まない。
// - 本文: 請求の金額の項目（ご請求金額・お支払い金額・お引き落とし金額など）と、引き落とし日の項目（お支払日・
//   お引き落とし日・口座振替日など）を読む。項目の値が二つ以上あって食い違えば読まない（どちらも信じない）。
// - 件名・本文の書き方は、実在のメールで確かめていない。合成の例で作り、読める書き方を広めにした（U356）。
// 時計・ネットワーク・DB はここで扱わない。呼び出し側（Core）が本文を平文にし、受信日（本人の地域の日付）を渡す。

import {
  HOUSEHOLD_AMOUNT_MAX,
  HOUSEHOLD_PAYMENT_LIMIT,
  isHouseholdDate,
  householdMonthOf,
} from './household.js';
import {
  parseHouseholdMailDate,
  parseHouseholdNoticeAmount,
} from './household-notice.js';
import type {
  HouseholdNoticeIssuer,
  HouseholdYearlessWindow,
} from './household-notice.js';

/** 請求予定の中身（暗号文の中身）。 */
export interface HouseholdBillContent {
  // 請求したカード会社の表示名（送信元の一覧の label）。
  readonly issuer: string;
  // 請求の金額（円の正の整数）。
  readonly amount_yen: number;
  // 引き落とし日（本人の地域の日付、YYYY-MM-DD）。月の平文はこの日の月。
  readonly due_on: string;
}

const BILL_KEYS = ['amount_yen', 'due_on', 'issuer'].join(',');

// 制御文字・孤立したサロゲート（会社の表示名は 1 行）。
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

/** 請求予定の中身の検査。理由が空なら正しい。 */
export function householdBillContentErrors(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return ['bill_invalid'];
  if (Object.keys(value).sort().join(',') !== BILL_KEYS)
    return ['bill_keys_invalid'];
  const content = value as Record<string, unknown>;
  const errors: string[] = [];
  const issuer = content['issuer'];
  if (
    typeof issuer !== 'string' ||
    issuer.trim().length === 0 ||
    [...issuer].length > HOUSEHOLD_PAYMENT_LIMIT ||
    CONTROL.test(issuer) ||
    LONE_SURROGATE.test(issuer)
  )
    errors.push('issuer_invalid');
  const amount = content['amount_yen'];
  if (
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > HOUSEHOLD_AMOUNT_MAX
  )
    errors.push('amount_invalid');
  if (!isHouseholdDate(content['due_on'])) errors.push('due_on_invalid');
  return errors;
}

// --- 出所 ---

const SOURCE_ID = /^[\x21-\x7e]{1,256}$/u;

export interface HouseholdBillSourceParts {
  readonly provider: 'google' | 'microsoft';
  readonly account_id: string;
  readonly remote_id: string;
}

/**
 * 請求予定の出所の鍵の材料（項目の順を固定した JSON。家計の記録の出所とは別の名前空間）。呼び出し側が SHA-256 にして
 * DB の source_key に置く。同じメールから二つ目の請求予定を作らない。形が正しくなければ null。
 */
export function householdBillSourceKeyMaterial(
  parts: HouseholdBillSourceParts,
): string | null {
  if (
    (parts.provider !== 'google' && parts.provider !== 'microsoft') ||
    !SOURCE_ID.test(parts.account_id) ||
    !SOURCE_ID.test(parts.remote_id)
  )
    return null;
  return JSON.stringify([
    'buddy.household_bill_source.v1',
    'mail_bill',
    parts.provider,
    parts.account_id,
    parts.remote_id,
  ]);
}

/**
 * 同じ請求か（同じ会社・同じ引き落とし日・同じ金額）。同じ請求を知らせるメールが二通届いた（確定のお知らせと引き落とし前の
 * お知らせなど）ときに、二つ目を作らないために使う。
 */
export function householdSameBill(
  a: HouseholdBillContent,
  b: HouseholdBillContent,
): boolean {
  return (
    a.issuer === b.issuer &&
    a.due_on === b.due_on &&
    a.amount_yen === b.amount_yen
  );
}

// --- 件名 ---

// 請求の金額・予定を知らせる件名（合成の例で決めた広めの書き方。U356）。NFKC にした後で比べる。
const BILL_SUBJECT =
  /請求|お?支払い?(?:金額|額|予定|日)|引き?落(?:とし|し)?(?:金額|額|予定|日)|口座振替|利用代金|利用明細/u;
// 請求のお知らせでない件名（宣伝・手続き・引き落としの失敗と督促・変更・訂正・再送・取消・速報）。訂正・修正・お詫び・再送は
// 訂正前と訂正後の両方の請求予定ができないように読まない（消す操作がない。U360）。速報は利用通知の速報（ADR 0159）に合わせて
// 読まない。
const BILL_EXCLUDED =
  /キャンペーン|ポイント|プレゼント|当選|抽選|エントリー|特典|割引|キャッシュバック|おトク|お得|チャンス|本人確認|パスワード|ログイン|不正|登録|変更|訂正|修正|お?詫び|再送|取消|取り消し|速報|停止|再発行|できません|できなかった|未入金|未払|残高不足|延滞|遅延|督促|再引|再振替|アンケート|メンテナンス/u;

/** 件名が請求のお知らせか。利用通知の件名かどうかは呼び出し側が先に決め、利用通知なら請求として読まない。 */
export function householdBillSubject(subject: string): boolean {
  const normalized = subject.normalize('NFKC');
  return BILL_SUBJECT.test(normalized) && !BILL_EXCLUDED.test(normalized);
}

// --- 本文 ---

// 項目名（NFKC にした後、行頭の飾りを除いた行の頭。判定だけで、値には飾りを除いた行を使わない）。前回の金額（前回お支払い金額など）は読まない。
const AMOUNT_LABEL =
  /^(?:今回|今月|当月|次回|合計)?の?(?:ご|お)?(?:利用代金請求|請求|支払い?|引き?落(?:とし|し)?|口座振替|振替)(?:予定)?金?額(?:合計)?/u;
const DUE_LABEL =
  /^(?:今回|次回)?の?(?:ご|お)?(?:支払い?|引き?落(?:とし|し)?|口座振替|振替)(?:予定)?期?日/u;
// 行頭の飾り（記号・括弧）。
const DECORATION = /^[\s■□◆◇●○・*＊‐−–—>【[〔-]+/u;
// 項目名の後: 括弧の補足（「(予定)」「(12月分)」など）を一つ許し、その後は区切りか行末。前回・前月・先月などの補足は今回の
// 請求ではないので許さない（項目として読まない）。
const AFTER_LABEL =
  /^(?:\s*\((?![^()]*(?:前回|前月|先月|前々|昨月|前年))[^()]*\))?(?:[\s】\]〕]*[:：=]\s*|[\s】\]〕]+|$)/u;

type BillField = 'amount' | 'due';

function labelOf(
  line: string,
): { readonly field: BillField; readonly rest: string } | null {
  for (const [field, pattern] of [
    ['amount', AMOUNT_LABEL],
    ['due', DUE_LABEL],
  ] as const) {
    const match = pattern.exec(line);
    if (match === null) continue;
    const rest = line.slice(match[0].length);
    if (rest.length > 0 && !AFTER_LABEL.test(rest)) continue;
    return { field, rest };
  }
  return null;
}

function billFields(
  text: string,
): { readonly field: BillField; readonly value: string }[] {
  const lines = text
    .normalize('NFKC')
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim());
  const fields: { field: BillField; value: string }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    // 飾りを取るのは項目名の判定のときだけ。値には trim しただけの元の行を使う（次の行の「-1,000円」の印を落とさない）。
    const label = labelOf((lines[index] ?? '').replace(DECORATION, ''));
    if (label === null) continue;
    let value = label.rest.replace(AFTER_LABEL, '').trim();
    if (value.length === 0) {
      // 値が次の行にある書式（項目名だけの行の次の行）。次の行も項目名なら値はない。
      const next = lines.slice(index + 1).find((candidate) => candidate !== '');
      if (next === undefined || labelOf(next.replace(DECORATION, '')) !== null)
        continue;
      value = next;
    }
    fields.push({ field: label.field, value });
  }
  return fields;
}

// 引き落とし日の年を決める範囲（受信日から見た日数）。請求のお知らせは引き落とし日の前に届くので、受信日の 92 日先（約
// 3 か月）まで。引き落としの後に届くお知らせもあるので、31 日前まで。範囲は 124 日分で 1 年より短いので、年の候補は
// 多くても一つしか入らない（U359）。
export const HOUSEHOLD_BILL_DUE_WINDOW: HouseholdYearlessWindow = {
  ahead: 92,
  behind: 31,
};

// 0 円（今回の請求はない）。
const ZERO_AMOUNT = /^(?:¥|\\|JPY)?\s*0+\s*(?:円|JPY)?(?![0-9.,])/u;

export type HouseholdBillSkipReason =
  | 'amount_unreadable'
  | 'foreign_currency'
  | 'cancellation'
  | 'zero_amount'
  | 'amount_mismatch'
  | 'due_on_missing'
  | 'due_on_unreadable'
  | 'due_on_mismatch'
  | 'content_invalid';

export type HouseholdBillReading =
  | { readonly outcome: 'bill'; readonly content: HouseholdBillContent }
  | {
      readonly outcome: 'ignored';
      // not_bill_notice は件名が請求のお知らせでない、no_amount は請求の金額の項目がない（会員サイトで見るよう促すだけの
      // お知らせなど）。
      readonly reason: 'not_bill_notice' | 'no_amount';
    }
  | { readonly outcome: 'skipped'; readonly reason: HouseholdBillSkipReason };

export interface HouseholdBillInput {
  readonly issuer: HouseholdNoticeIssuer;
  readonly subject: string;
  // 本文の平文（HTML のメールは呼び出し側が文字だけにしたもの）。
  readonly text: string;
  // 受信日（本人の地域の YYYY-MM-DD）。年のない引き落とし日の年を決めるのに使う。
  readonly received_on: string;
}

type Decided<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: HouseholdBillSkipReason };

function billAmount(values: readonly string[]): Decided<number> {
  if (values.every((value) => ZERO_AMOUNT.test(value.normalize('NFKC'))))
    return { ok: false, reason: 'zero_amount' };
  let amount: number | null = null;
  for (const value of values) {
    const parsed = parseHouseholdNoticeAmount(value);
    if (!parsed.ok) {
      if (ZERO_AMOUNT.test(value.normalize('NFKC')))
        return { ok: false, reason: 'amount_mismatch' };
      return { ok: false, reason: parsed.reason };
    }
    if (amount !== null && amount !== parsed.yen)
      return { ok: false, reason: 'amount_mismatch' };
    amount = parsed.yen;
  }
  return amount === null
    ? { ok: false, reason: 'amount_unreadable' }
    : { ok: true, value: amount };
}

function billDue(
  values: readonly string[],
  receivedOn: string,
): Decided<string> {
  if (values.length === 0) return { ok: false, reason: 'due_on_missing' };
  let due: string | null = null;
  for (const value of values) {
    const parsed = parseHouseholdMailDate(
      value,
      receivedOn,
      HOUSEHOLD_BILL_DUE_WINDOW,
    );
    if (parsed === null) return { ok: false, reason: 'due_on_unreadable' };
    if (due !== null && due !== parsed.on)
      return { ok: false, reason: 'due_on_mismatch' };
    due = parsed.on;
  }
  return due === null
    ? { ok: false, reason: 'due_on_missing' }
    : { ok: true, value: due };
}

/**
 * 請求のお知らせの件名と本文から、請求予定を読む。送り主の確かめ（checkHouseholdNoticeSender）は呼び出し側が済ませ、
 * 利用通知の件名（householdNoticeSubjectKind が usage）のメールは渡さない。
 */
export function readHouseholdBill(
  input: HouseholdBillInput,
): HouseholdBillReading {
  if (!householdBillSubject(input.subject))
    return { outcome: 'ignored', reason: 'not_bill_notice' };
  const fields = billFields(input.text);
  const amounts = fields
    .filter(({ field }) => field === 'amount')
    .map(({ value }) => value);
  if (amounts.length === 0) return { outcome: 'ignored', reason: 'no_amount' };
  const amount = billAmount(amounts);
  if (!amount.ok) return { outcome: 'skipped', reason: amount.reason };
  const due = billDue(
    fields.filter(({ field }) => field === 'due').map(({ value }) => value),
    input.received_on,
  );
  if (!due.ok) return { outcome: 'skipped', reason: due.reason };
  const content: HouseholdBillContent = {
    issuer: input.issuer.label,
    amount_yen: amount.value,
    due_on: due.value,
  };
  if (householdBillContentErrors(content).length > 0)
    return { outcome: 'skipped', reason: 'content_invalid' };
  return { outcome: 'bill', content };
}

// --- 月の請求予定 ---

export interface HouseholdMonthBills {
  // 引き落とし日の早い順（同じなら会社の表示名の順、金額の小さい順）。
  readonly items: readonly HouseholdBillContent[];
  // 請求予定の合計。支出の合計・予算・定期の支出には入れない。
  readonly total_yen: number;
}

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** その月の請求予定を並べ、合計を出す。月の外の引き落とし日の請求予定は入れない。 */
export function summarizeHouseholdBills(
  bills: readonly HouseholdBillContent[],
  month: string,
): HouseholdMonthBills {
  const items = bills
    .filter((bill) => householdMonthOf(bill.due_on) === month)
    .slice()
    .sort(
      (a, b) =>
        compareText(a.due_on, b.due_on) ||
        compareText(a.issuer, b.issuer) ||
        a.amount_yen - b.amount_yen,
    );
  return {
    items,
    total_yen: items.reduce((sum, bill) => sum + bill.amount_yen, 0),
  };
}
