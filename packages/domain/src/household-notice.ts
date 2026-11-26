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
    fields.push({ field: label[1], value });
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

/**
 * 日付の値を YYYY-MM-DD と HH:MM にする。年がない書式（11/26）は受信日の年を使い、受信日の年の月日が受信日より
 * 7 日を超えて後なら前の年とする（年末年始の 12/31 の利用を 1/2 に受け取る場合）。7 日以内の先なら、タイムゾーンの違いで
 * 1 日先になっただけとして受信日の年のままにする（ADR 0170）。読めなければ null。
 */
export function parseHouseholdNoticeDate(
  value: string,
  receivedOn: string,
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
    const receivedYear = Number(receivedOn.slice(0, 4));
    const sameYear = Date.UTC(receivedYear, month - 1, day);
    const received = Date.UTC(
      receivedYear,
      Number(receivedOn.slice(5, 7)) - 1,
      Number(receivedOn.slice(8, 10)),
    );
    const later = sameYear - received > 7 * 86_400_000;
    year = later ? receivedYear - 1 : receivedYear;
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
  // 利用の金額の項目がなければ、支払いの金額の項目を利用の金額として読む（ADR 0170）。
  const allFields = fieldsOf(input.text);
  const hasUsageAmount = allFields.some(({ field }) => field === 'amount');
  const fields = allFields
    .filter(({ field }) => !hasUsageAmount || field !== 'payment_amount')
    .map(({ field, value }) => ({
      field: field === 'payment_amount' ? ('amount' as const) : field,
      value,
    }));
  // 項目を利用ごとにまとめる。同じ項目が二度目に出たら、次の利用が始まったとみなす。
  const groups: Map<Field, string>[] = [];
  let current = new Map<Field, string>();
  for (const { field, value } of fields) {
    if (current.has(field)) {
      groups.push(current);
      current = new Map();
    }
    current.set(field, value);
  }
  if (current.size > 0) groups.push(current);
  const usages = groups.filter((group) => group.has('amount'));
  if (usages.length === 0) return { outcome: 'ignored', reason: 'no_usage' };
  const entries: { index: number; content: HouseholdEntryContent }[] = [];
  const skipped: HouseholdNoticeSkip[] = [];
  usages.slice(0, HOUSEHOLD_NOTICE_USAGE_MAX).forEach((group, index) => {
    const amount = parseHouseholdNoticeAmount(group.get('amount') ?? '');
    if (!amount.ok) {
      skipped.push({ index, reason: amount.reason });
      return;
    }
    const dateValue = group.get('date');
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
      merchant: merchantOf(group.get('merchant')),
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
