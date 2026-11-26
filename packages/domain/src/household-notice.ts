// カード会社の利用通知メールから家計簿の記録を読み取る規則（ADR 0159）。
//
// - 送り主の確かめ: 差出人のドメインが、カード会社ごとの送信元の一覧（各社の公式の案内に載ったドメイン）に入り、かつ
//   受信したメールサーバーの認証結果（Authentication-Results）で DMARC が合格しているか、DKIM が合格して署名の
//   ドメインが同じカード会社の一覧に入るときだけ、通知として扱う。差出人の表示は偽れるため、ドメインの一致だけでは信じない。
// - 件名: 利用のお知らせ・利用通知の件名だけを読む。請求・明細・キャンペーン・本人確認・ログインなどの件名は読まない。
//   同じ利用を速報と確定の二度知らせるカード会社は、確定の方だけを記録する（速報は読まない）。
// - 本文: 項目名（ご利用日時・ご利用先・ご利用金額など、各社の表記の揺れを含む）と値の組を順に読み、利用ごとにまとめる。
//   円の金額だけを記録する。外貨・取消・金額のない利用は記録しない（理由を返す）。
// 呼び出し側（Core）は、本文を平文にし、受信日（本人の地域の日付）を渡す。ここでは時計・ネットワーク・DB を扱わない。

import { householdContentErrors, isHouseholdDate } from './household.js';
import type { HouseholdEntryContent } from './household.js';

export interface HouseholdNoticeIssuer {
  readonly id: string;
  // 記録の支払い手段に入れる表示名。
  readonly label: string;
  // 送信元のドメイン（この値か、その下のドメイン）。
  readonly domains: readonly string[];
  // 速報の件名。これに合う通知は記録しない（確定の通知を待つ）。速報を送らない会社は null。
  readonly provisional_subject: RegExp | null;
}

// 送信元のドメインは各社の公式の案内（迷惑メールの対策・送信元の案内のページ）に載ったものだけ。
export const HOUSEHOLD_NOTICE_ISSUERS: readonly HouseholdNoticeIssuer[] = [
  {
    id: 'view_card',
    label: 'ビューカード',
    domains: ['mail.viewsnet.jp'],
    provisional_subject: /速報/u,
  },
  {
    id: 'rakuten_card',
    label: '楽天カード',
    domains: ['mail.rakuten-card.co.jp'],
    provisional_subject: /速報/u,
  },
  {
    id: 'smbc_card',
    label: '三井住友カード',
    domains: ['vpass.ne.jp', 'smbc-card.com'],
    provisional_subject: null,
  },
  {
    id: 'jcb',
    label: 'JCB',
    domains: ['qa.jcb.co.jp'],
    provisional_subject: null,
  },
];

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

function underDomain(domain: string, base: string): boolean {
  return domain === base || domain.endsWith(`.${base}`);
}

function issuerOfDomain(
  domain: string,
  issuers: readonly HouseholdNoticeIssuer[],
): HouseholdNoticeIssuer | null {
  return (
    issuers.find((issuer) =>
      issuer.domains.some((base) => underDomain(domain, base)),
    ) ?? null
  );
}

/** 差出人の欄（"表示名 <addr>" または addr）からドメインを取り出す。読めなければ null。 */
export function householdNoticeSenderDomain(from: string): string | null {
  const bracket = /<([^<>]*)>\s*$/u.exec(from);
  const address = (bracket?.[1] ?? from).trim();
  const at = address.lastIndexOf('@');
  if (at <= 0 || at !== address.indexOf('@')) return null;
  const domain = address.slice(at + 1).toLowerCase();
  return DOMAIN.test(domain) ? domain : null;
}

export interface HouseholdNoticeSender {
  // 差出人の欄（From）。
  readonly from: string;
  // 受信したメールサーバー自身が付けた認証結果（Authentication-Results）の値。複数あれば全部。
  // 呼び出し側は、自分の受信サーバーの識別子（authserv-id）のものだけを渡す（途中のサーバーが付けたものは偽れる）。
  readonly authentication_results: readonly string[];
}

export type HouseholdNoticeSenderCheck =
  | { readonly ok: true; readonly issuer: HouseholdNoticeIssuer }
  | {
      readonly ok: false;
      readonly reason:
        | 'sender_invalid'
        | 'sender_unknown'
        | 'authentication_missing'
        | 'authentication_failed';
    };

interface AuthResult {
  readonly method: string;
  readonly result: string;
  readonly properties: ReadonlyMap<string, string>;
}

// Authentication-Results の値（RFC 8601）を method=result と property=value の組に分ける。最初の authserv-id は捨てる。
function authResults(value: string): AuthResult[] {
  const withoutComments = value.replace(/\([^()]*\)/gu, ' ');
  const parts = withoutComments.split(';').slice(1);
  const results: AuthResult[] = [];
  for (const part of parts) {
    const tokens = part.trim().split(/\s+/u).filter(Boolean);
    const head = tokens[0];
    if (head === undefined) continue;
    const match = /^([a-z0-9-]+)=([a-z]+)$/iu.exec(head);
    if (match === null) continue;
    const properties = new Map<string, string>();
    for (const token of tokens.slice(1)) {
      const pair = /^([a-z0-9-]+\.[a-z0-9-]+)=(.+)$/iu.exec(token);
      if (pair?.[1] !== undefined && pair[2] !== undefined)
        properties.set(pair[1].toLowerCase(), pair[2].replace(/^"|"$/gu, ''));
    }
    results.push({
      method: (match[1] ?? '').toLowerCase(),
      result: (match[2] ?? '').toLowerCase(),
      properties,
    });
  }
  return results;
}

function domainOfIdentity(identity: string | undefined): string | null {
  if (identity === undefined) return null;
  const at = identity.lastIndexOf('@');
  const domain = (at >= 0 ? identity.slice(at + 1) : identity).toLowerCase();
  return DOMAIN.test(domain) ? domain : null;
}

/** 差出人がカード会社の送信元で、受信サーバーの認証に合格しているかを確かめる。issuers は既定で組み込みの一覧。 */
export function checkHouseholdNoticeSender(
  sender: HouseholdNoticeSender,
  issuers: readonly HouseholdNoticeIssuer[] = HOUSEHOLD_NOTICE_ISSUERS,
): HouseholdNoticeSenderCheck {
  const domain = householdNoticeSenderDomain(sender.from);
  if (domain === null) return { ok: false, reason: 'sender_invalid' };
  const issuer = issuerOfDomain(domain, issuers);
  if (issuer === null) return { ok: false, reason: 'sender_unknown' };
  const results = sender.authentication_results.flatMap(authResults);
  if (results.length === 0)
    return { ok: false, reason: 'authentication_missing' };
  const dmarc = results.some(
    (entry) =>
      entry.method === 'dmarc' &&
      entry.result === 'pass' &&
      domainOfIdentity(entry.properties.get('header.from')) === domain,
  );
  const dkim = results.some((entry) => {
    if (entry.method !== 'dkim' || entry.result !== 'pass') return false;
    const signer = domainOfIdentity(
      entry.properties.get('header.d') ?? entry.properties.get('header.i'),
    );
    return signer !== null && issuerOfDomain(signer, issuers)?.id === issuer.id;
  });
  if (!dmarc && !dkim) return { ok: false, reason: 'authentication_failed' };
  return { ok: true, issuer };
}

// --- 件名 ---

const USAGE_SUBJECT = /利用(?:の)?(?:お知らせ|通知|速報|確認)|利用通知/u;
const OTHER_SUBJECT =
  /請求|明細|引落|引き落|キャンペーン|ポイント|本人確認|パスワード|ログイン|不正|登録|変更|停止|再発行|ご案内|特典/u;

export type HouseholdNoticeSubjectKind = 'usage' | 'provisional' | 'other';

/** 件名から、利用の通知か・速報か・それ以外かを決める。 */
export function householdNoticeSubjectKind(
  issuer: HouseholdNoticeIssuer,
  subject: string,
): HouseholdNoticeSubjectKind {
  const normalized = subject.normalize('NFKC');
  if (!USAGE_SUBJECT.test(normalized) || OTHER_SUBJECT.test(normalized))
    return 'other';
  if (
    issuer.provisional_subject !== null &&
    issuer.provisional_subject.test(normalized)
  )
    return 'provisional';
  return 'usage';
}

// --- 本文 ---

type Field = 'date' | 'merchant' | 'amount' | 'payment_amount';

// 項目名（NFKC にした後の表記）。長いものから試す。
const LABELS: readonly (readonly [string, Field])[] = (
  [
    ['ご利用年月日', 'date'],
    ['ご利用日時', 'date'],
    ['ご利用日', 'date'],
    ['利用年月日', 'date'],
    ['利用日時', 'date'],
    ['利用日', 'date'],
    ['お取引日時', 'date'],
    ['取引日時', 'date'],
    ['決済日時', 'date'],
    ['ご利用加盟店名', 'merchant'],
    ['ご利用加盟店', 'merchant'],
    ['ご利用先店名', 'merchant'],
    ['ご利用店舗名', 'merchant'],
    ['ご利用店舗', 'merchant'],
    ['ご利用店名', 'merchant'],
    ['ご利用先', 'merchant'],
    ['利用加盟店', 'merchant'],
    ['利用先店名', 'merchant'],
    ['利用店名', 'merchant'],
    ['利用先', 'merchant'],
    ['加盟店名', 'merchant'],
    ['店舗名', 'merchant'],
    ['ご利用金額', 'amount'],
    ['利用金額', 'amount'],
    ['お支払い金額', 'payment_amount'],
    ['お支払金額', 'payment_amount'],
    ['支払金額', 'payment_amount'],
    ['決済金額', 'payment_amount'],
  ] as const
)
  .slice()
  .sort((a, b) => b[0].length - a[0].length);

// 行頭の飾り（記号・括弧）と、項目名の後の区切り。
const DECORATION = /^[\s■□◆◇●○・*＊‐−–—>【[〔-]+/u;
const AFTER_LABEL = /^(?:[\s】\]〕]*[:：=]\s*|[\s】\]〕]+|$)/u;

interface FieldValue {
  readonly field: Field;
  readonly value: string;
  // 支払いの金額の項目の種類（お支払い金額・お支払金額・支払金額は同じ、決済金額は別）。ほかの項目は空。
  readonly paymentKind: string | null;
}

function fieldsOf(text: string): FieldValue[] {
  const lines = text
    .normalize('NFKC')
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim());
  const fields: FieldValue[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').replace(DECORATION, '');
    const label = LABELS.find(([name]) => line.startsWith(name));
    if (label === undefined) continue;
    const rest = line.slice(label[0].length);
    // 「ご利用日」が「ご利用日時」の一部でないように、項目名の直後は区切りか行末だけを認める。
    if (rest.length > 0 && !AFTER_LABEL.test(rest)) continue;
    let value = rest.replace(AFTER_LABEL, '').trim();
    if (value.length === 0) {
      // 値が次の行にある書式（項目名だけの行の次の行）。
      const next = lines.slice(index + 1).find((candidate) => candidate !== '');
      if (next === undefined) continue;
      if (
        LABELS.some(([name]) => next.replace(DECORATION, '').startsWith(name))
      )
        continue;
      value = next;
    }
    fields.push({
      field: label[1],
      value,
      paymentKind:
        label[1] === 'payment_amount'
          ? label[0].includes('決済')
            ? 'settlement'
            : 'payment'
          : null,
    });
  }
  return fields;
}

export type HouseholdNoticeAmount =
  | { readonly ok: true; readonly yen: number }
  | {
      readonly ok: false;
      readonly reason:
        'amount_unreadable' | 'foreign_currency' | 'cancellation';
    };

const FOREIGN =
  /\b(?:USD|EUR|GBP|AUD|CAD|CNY|KRW|TWD|HKD|SGD|THB)\b|ドル|ユーロ|ウォン|元|外貨/u;

/** 金額の値を円の整数にする。円の印（円・¥・JPY）がない金額・外貨・取消（負の金額）は記録しない。 */
export function parseHouseholdNoticeAmount(
  value: string,
): HouseholdNoticeAmount {
  const text = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (/^[-−△▲]/u.test(text) || /取消|取り消/u.test(text))
    return { ok: false, reason: 'cancellation' };
  const yen =
    /^(?:¥|\\|JPY)\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?![0-9.,])/u.exec(
      text,
    ) ?? /^([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*(?:円|JPY)/u.exec(text);
  if (yen?.[1] === undefined) {
    if (FOREIGN.test(text)) return { ok: false, reason: 'foreign_currency' };
    return { ok: false, reason: 'amount_unreadable' };
  }
  const amount = Number(yen[1].replace(/,/gu, ''));
  if (!Number.isSafeInteger(amount) || amount < 1)
    return { ok: false, reason: 'amount_unreadable' };
  return { ok: true, yen: amount };
}

export interface HouseholdNoticeDate {
  readonly on: string;
  readonly time: string | null;
}

const pad = (value: number): string => String(value).padStart(2, '0');

const DAY_MS = 86_400_000;

/** 年のない日付の年を決める範囲（受信日から見た日数）。ahead は受信日より後、behind は受信日より前の日数の上限（その日を含む）。 */
export interface HouseholdYearlessWindow {
  readonly ahead: number;
  readonly behind: number;
}

// 利用の日付の範囲。受信日の 7 日先まで（タイムゾーンの違いで 1 日先になる場合の余裕）から、358 日前（約 1 年前）まで。
// 範囲は 366 日分あるので、月日が実在する年なら受信日の前の年・同じ年・翌年のどれかが必ず入る。
const USAGE_YEARLESS_WINDOW: HouseholdYearlessWindow = {
  ahead: 7,
  behind: 358,
};

// 年のない月日の年を、受信日の前の年・同じ年・翌年の三つの候補から決める。範囲に入る候補が複数あるのは、ちょうど 7 日先と
// 358 日前が同時に入る境目だけで、受信日に近い方（7 日先）を使う（近い方を選ぶので、境目の前後で年が揺れない）。その年に
// 月日が実在しない（うるう年でない年の 2/29）候補は数えず、どれも範囲に入らなければ null（2/28 や 3/1 に丸めない）。
function yearlessYear(
  month: number,
  day: number,
  receivedOn: string,
  range: HouseholdYearlessWindow,
): number | null {
  const receivedYear = Number(receivedOn.slice(0, 4));
  const received = Date.UTC(
    receivedYear,
    Number(receivedOn.slice(5, 7)) - 1,
    Number(receivedOn.slice(8, 10)),
  );
  let best: { readonly year: number; readonly distance: number } | null = null;
  for (const year of [receivedYear - 1, receivedYear, receivedYear + 1]) {
    if (!isHouseholdDate(`${String(year)}-${pad(month)}-${pad(day)}`)) continue;
    const offset = Math.round(
      (Date.UTC(year, month - 1, day) - received) / DAY_MS,
    );
    if (offset > range.ahead || offset < -range.behind) continue;
    const distance = Math.abs(offset);
    if (best === null || distance < best.distance) best = { year, distance };
  }
  return best === null ? null : best.year;
}

/**
 * 日付の値を YYYY-MM-DD と HH:MM にする。年がない書式（11/26）は、受信日の前の年・同じ年・翌年のうち、受信日から見て
 * 7 日先まで（タイムゾーンの違いで 1 日先になっただけの日付を含む）から 358 日前までに入るものを年とする。年末年始の
 * 12/31 の利用を 1/2 に受け取れば前の年、12/31 の受信に 01/01 の利用なら翌年になる。その年に月日がない（うるう年でない年の
 * 2/29）ときや、どの年も範囲に入らないときは null（ADR 0170）。読めなければ null。
 */
export function parseHouseholdNoticeDate(
  value: string,
  receivedOn: string,
): HouseholdNoticeDate | null {
  return parseHouseholdMailDate(value, receivedOn, USAGE_YEARLESS_WINDOW);
}

/**
 * 日付の値を YYYY-MM-DD と HH:MM にする（parseHouseholdNoticeDate と同じ書き方を読む）。年がない書式は、受信日の前の年・
 * 同じ年・翌年のうち引数 range の日数の範囲に入るものを年とし、複数入れば受信日に近い方、どれも入らなければ null。請求のお知らせの
 * 引き落とし日（ADR 0176）は利用の日付と違う範囲で年を決めるので、範囲を引数で受ける。
 */
export function parseHouseholdMailDate(
  value: string,
  receivedOn: string,
  range: HouseholdYearlessWindow,
): HouseholdNoticeDate | null {
  const text = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const full =
    /^(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*日?/u.exec(text);
  const short =
    full === null ? /^(\d{1,2})\s*[/月]\s*(\d{1,2})\s*日?/u.exec(text) : null;
  let year: number;
  let month: number;
  let day: number;
  let rest: string;
  if (full !== null) {
    year = Number(full[1]);
    month = Number(full[2]);
    day = Number(full[3]);
    rest = text.slice(full[0].length);
  } else if (short !== null && isHouseholdDate(receivedOn)) {
    month = Number(short[1]);
    day = Number(short[2]);
    const decided = yearlessYear(month, day, receivedOn, range);
    if (decided === null) return null;
    year = decided;
    rest = text.slice(short[0].length);
  } else return null;
  const on = `${String(year)}-${pad(month)}-${pad(day)}`;
  if (!isHouseholdDate(on)) return null;
  const clock = /^\s*(?:\([^)]*\))?\s*(\d{1,2})\s*[:時]\s*(\d{2})/u.exec(rest);
  let time: string | null = null;
  if (clock !== null) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour <= 23 && minute <= 59) time = `${pad(hour)}:${pad(minute)}`;
  }
  return { on, time };
}

export interface HouseholdNoticeInput {
  readonly issuer: HouseholdNoticeIssuer;
  readonly subject: string;
  // 本文の平文（HTML のメールは呼び出し側が文字だけにしたもの）。
  readonly text: string;
  // 受信日（本人の地域の YYYY-MM-DD）。本文に日付がない・年がないときに使う。
  readonly received_on: string;
}

export interface HouseholdNoticeSkip {
  readonly index: number;
  readonly reason:
    | 'amount_unreadable'
    | 'foreign_currency'
    | 'cancellation'
    | 'content_invalid';
}

export type HouseholdNoticeReading =
  | {
      readonly outcome: 'entries';
      // 本文に出た順。index は出所の鍵に使う（同じメールの何番目の利用か）。
      readonly entries: readonly {
        readonly index: number;
        readonly content: HouseholdEntryContent;
      }[];
      // 記録しなかった利用と理由。
      readonly skipped: readonly HouseholdNoticeSkip[];
    }
  | {
      readonly outcome: 'ignored';
      readonly reason: 'not_usage_notice' | 'provisional' | 'no_usage';
    };

export const HOUSEHOLD_NOTICE_USAGE_MAX = 100;

const MERCHANT_MAX = 100;
const LONG_DIGITS = /[0-9](?:[\s-]*[0-9]){11,}/u;

function merchantOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  if (text === '' || LONG_DIGITS.test(text)) return null;
  return [...text].slice(0, MERCHANT_MAX).join('');
}

// 一つの利用の金額。利用の金額の項目があればそれ、なければ支払いの金額の項目（複数なら全部が読めて同じ額のときだけ）。
function groupAmount(
  usage: string | undefined,
  payments: readonly { readonly value: string }[],
): HouseholdNoticeAmount {
  if (usage !== undefined) return parseHouseholdNoticeAmount(usage);
  const parsed = payments.map((payment) =>
    parseHouseholdNoticeAmount(payment.value),
  );
  const first = parsed[0];
  if (first === undefined) return { ok: false, reason: 'amount_unreadable' };
  const failed = parsed.find((amount) => !amount.ok);
  if (failed !== undefined) return failed;
  const same = parsed.every(
    (amount) => amount.ok && first.ok && amount.yen === first.yen,
  );
  return same ? first : { ok: false, reason: 'amount_unreadable' };
}

/** 利用通知メールの件名と本文から、記録の内容を読み取る。 */
export function readHouseholdNotice(
  input: HouseholdNoticeInput,
): HouseholdNoticeReading {
  const kind = householdNoticeSubjectKind(input.issuer, input.subject);
  if (kind === 'other')
    return { outcome: 'ignored', reason: 'not_usage_notice' };
  if (kind === 'provisional')
    return { outcome: 'ignored', reason: 'provisional' };
  // 利用の金額の項目（ご利用金額・利用金額）が一つでもあれば、支払いの金額の項目は読まない（同じ利用の二重の記録を避ける）。
  // 利用の金額の項目がなければ、支払いの金額の項目を利用の金額として読む。このとき、一つの利用の区切りに支払いの金額の
  // 項目が種類の違うまま並んでも（お支払い金額と決済金額）一つの利用とし、金額が食い違えば読まない（ADR 0170）。
  const allFields = fieldsOf(input.text);
  const hasUsageAmount = allFields.some(({ field }) => field === 'amount');
  const fields = allFields.filter(
    ({ field }) => !hasUsageAmount || field !== 'payment_amount',
  );
  // 項目を利用ごとにまとめる。同じ項目（支払いの金額は同じ種類の項目）が二度目に出たら、次の利用が始まったとみなす。
  interface Group {
    readonly values: Map<Field, string>;
    readonly payments: { readonly kind: string; readonly value: string }[];
  }
  const groups: Group[] = [];
  let current: Group = { values: new Map(), payments: [] };
  for (const { field, value, paymentKind } of fields) {
    const repeated =
      field === 'payment_amount'
        ? current.payments.some((payment) => payment.kind === paymentKind)
        : current.values.has(field);
    if (repeated) {
      groups.push(current);
      current = { values: new Map(), payments: [] };
    }
    if (field === 'payment_amount')
      current.payments.push({ kind: paymentKind ?? '', value });
    else current.values.set(field, value);
  }
  if (current.values.size > 0 || current.payments.length > 0)
    groups.push(current);
  const usages = groups.filter(
    (group) => group.values.has('amount') || group.payments.length > 0,
  );
  if (usages.length === 0) return { outcome: 'ignored', reason: 'no_usage' };
  const entries: { index: number; content: HouseholdEntryContent }[] = [];
  const skipped: HouseholdNoticeSkip[] = [];
  usages.slice(0, HOUSEHOLD_NOTICE_USAGE_MAX).forEach((group, index) => {
    const amount = groupAmount(group.values.get('amount'), group.payments);
    if (!amount.ok) {
      skipped.push({ index, reason: amount.reason });
      return;
    }
    const dateValue = group.values.get('date');
    const date =
      dateValue === undefined
        ? null
        : parseHouseholdNoticeDate(dateValue, input.received_on);
    const occurredOn = date?.on ?? input.received_on;
    const content: HouseholdEntryContent = {
      direction: 'expense',
      amount_yen: amount.yen,
      occurred_on: occurredOn,
      occurred_time: date?.time ?? null,
      category: 'uncategorized',
      merchant: merchantOf(group.values.get('merchant')),
      memo: null,
      payment: input.issuer.label,
    };
    if (householdContentErrors(content).length > 0) {
      skipped.push({ index, reason: 'content_invalid' });
      return;
    }
    entries.push({ index, content });
  });
  return { outcome: 'entries', entries, skipped };
}
