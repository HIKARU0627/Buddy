// 家計簿の記録の意味の規則（ADR 0158）。
//
// - 分類: マネーフォワード ME の大項目（同社の公式ヘルプの一覧）に合わせた支出の 16 分類と、Buddy 独自の「その他」「未分類」、
//   収入、振替。マネーフォワードの書き出しを取り込むとき、大項目の名前をそのまま分類に写せる。
// - 記録の内容: 向き（支出・収入・振替）・金額（円の整数）・日付・時刻・分類・店名・メモ・支払い手段の表示名。内容は DB で
//   暗号化し、平文で持つのは月（YYYY-MM）だけ（集計の範囲を引くため）。月の集計は Core が復号してからこの規則で計算する。
// - 振替（カード代金の口座からの引落し・口座間の移動）は、支出・収入の合計に入れない。カードの利用と引落しの二重計上を避ける。
// - 出所の鍵: 同じメール・同じ書き出しの行から二つ目の記録を作らないための材料。ハッシュは呼び出し側（Core）が計算する。
// 時計・暗号・DB はここで扱わない。

export const HOUSEHOLD_DIRECTIONS = ['expense', 'income', 'transfer'] as const;
export type HouseholdDirection = (typeof HOUSEHOLD_DIRECTIONS)[number];

export interface HouseholdCategory {
  readonly id: string;
  readonly label: string;
  readonly direction: HouseholdDirection;
}

// 表示の順。支出の 16 分類はマネーフォワード ME の公式ヘルプの大項目の順。
export const HOUSEHOLD_CATEGORIES: readonly HouseholdCategory[] = [
  { id: 'food', label: '食費', direction: 'expense' },
  { id: 'cash_card', label: '現金・カード', direction: 'expense' },
  { id: 'transport', label: '交通費', direction: 'expense' },
  { id: 'hobby', label: '趣味・娯楽', direction: 'expense' },
  { id: 'daily_goods', label: '日用品', direction: 'expense' },
  { id: 'clothing_beauty', label: '衣服・美容', direction: 'expense' },
  { id: 'special', label: '特別な支出', direction: 'expense' },
  { id: 'social', label: '交際費', direction: 'expense' },
  { id: 'housing', label: '住宅', direction: 'expense' },
  { id: 'utilities', label: '水道・光熱費', direction: 'expense' },
  { id: 'car', label: '自動車', direction: 'expense' },
  { id: 'insurance', label: '保険', direction: 'expense' },
  { id: 'tax_social', label: '税・社会保障', direction: 'expense' },
  { id: 'education', label: '教養・教育', direction: 'expense' },
  { id: 'communication', label: '通信費', direction: 'expense' },
  { id: 'health_medical', label: '健康・医療', direction: 'expense' },
  { id: 'other', label: 'その他', direction: 'expense' },
  { id: 'uncategorized', label: '未分類', direction: 'expense' },
  { id: 'income', label: '収入', direction: 'income' },
  { id: 'transfer', label: '振替', direction: 'transfer' },
];

export const HOUSEHOLD_CATEGORY_IDS: readonly string[] =
  HOUSEHOLD_CATEGORIES.map((category) => category.id);

const CATEGORY_BY_ID: ReadonlyMap<string, HouseholdCategory> = new Map(
  HOUSEHOLD_CATEGORIES.map((category) => [category.id, category]),
);

const CATEGORY_BY_LABEL: ReadonlyMap<string, HouseholdCategory> = new Map(
  HOUSEHOLD_CATEGORIES.map((category) => [category.label, category]),
);

export function householdCategory(id: string): HouseholdCategory | null {
  return CATEGORY_BY_ID.get(id) ?? null;
}

/** 分類の表示名（マネーフォワードの大項目の名前と同じ）から分類を引く。前後の空白は無視する。 */
export function householdCategoryByLabel(
  label: string,
): HouseholdCategory | null {
  return CATEGORY_BY_LABEL.get(label.trim()) ?? null;
}

/** 向きに対して既定の分類（支出は未分類・収入は収入・振替は振替）。 */
export function householdDefaultCategory(
  direction: HouseholdDirection,
): string {
  if (direction === 'income') return 'income';
  if (direction === 'transfer') return 'transfer';
  return 'uncategorized';
}

// 金額の上限（1 件 100 億円未満）。集計しても Number の安全な整数の範囲を超えない。
export const HOUSEHOLD_AMOUNT_MAX = 9_999_999_999;
export const HOUSEHOLD_MERCHANT_LIMIT = 100;
export const HOUSEHOLD_MEMO_LIMIT = 500;
export const HOUSEHOLD_PAYMENT_LIMIT = 40;

/** 記録の内容（暗号文の中身）。 */
export interface HouseholdEntryContent {
  readonly direction: HouseholdDirection;
  // 円の正の整数。向きで支出・収入を分ける（負の金額を使わない）。
  readonly amount_yen: number;
  // 利用した日（本人の地域の日付、YYYY-MM-DD）。
  readonly occurred_on: string;
  // 利用した時刻（HH:MM）。わからなければ null。
  readonly occurred_time: string | null;
  readonly category: string;
  // 店名・相手の名前。わからなければ null。
  readonly merchant: string | null;
  readonly memo: string | null;
  // 支払い手段の表示名（カードや口座の呼び名）。カード番号・口座番号は入れない。わからなければ null。
  readonly payment: string | null;
}

const CONTENT_KEYS = [
  'amount_yen',
  'category',
  'direction',
  'memo',
  'merchant',
  'occurred_on',
  'occurred_time',
  'payment',
].join(',');

const LOCAL_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/u;
const LOCAL_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;
const MONTH = /^([0-9]{4})-(0[1-9]|1[0-2])$/u;
// 制御文字（改行・タブを含む）。店名・支払い手段は 1 行にする。
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
// 改行とタブ以外の制御文字。メモは複数行を許す。
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_LINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
// 孤立したサロゲート。
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
// 数字が 12 桁以上続く並び（カード番号・口座番号の写し込みを拒否する）。区切りの空白・ハイフンも数字の並びとして数える。
const LONG_DIGITS = /[0-9０-９](?:[\s\-－]*[0-9０-９]){11,}/u;

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 暦に実在する YYYY-MM-DD か（年は 2000〜2099。家計の記録としてそれ以外を受けない）。 */
export function isHouseholdDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = LOCAL_DATE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1)
    return false;
  const days =
    month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] as number);
  return day <= days;
}

/** YYYY-MM（年は 2000〜2099）か。 */
export function isHouseholdMonth(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = MONTH.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  return year >= 2000 && year <= 2099;
}

/** 日付の月（YYYY-MM）。日付が正しくなければ null。 */
export function householdMonthOf(occurredOn: string): string | null {
  return isHouseholdDate(occurredOn) ? occurredOn.slice(0, 7) : null;
}

const codePointLength = (text: string): number => [...text].length;

function textErrors(
  value: unknown,
  name: string,
  limit: number,
  multiline: boolean,
): string[] {
  if (value === null) return [];
  if (typeof value !== 'string') return [`${name}_invalid`];
  if (value.trim().length === 0) return [`${name}_empty`];
  if (codePointLength(value) > limit) return [`${name}_too_long`];
  if (LONE_SURROGATE.test(value)) return [`${name}_invalid`];
  if ((multiline ? CONTROL_EXCEPT_LINES : CONTROL).test(value))
    return [`${name}_control_character`];
  if (LONG_DIGITS.test(value)) return [`${name}_long_digits`];
  return [];
}

/**
 * 店名だけの検査（householdContentErrors の店名の分と同じ規則）。理由が空なら正しい。会話の一言から店名を読んだとき、
 * 記録に入れられない店名（長すぎる・制御文字・12 桁以上の数字の並び）を入力欄に入れないために使う（ADR 0171）。
 */
export function householdMerchantErrors(value: string | null): string[] {
  return textErrors(value, 'merchant', HOUSEHOLD_MERCHANT_LIMIT, false);
}

/** 記録の内容の検査。理由が空なら正しい。 */
export function householdContentErrors(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return ['content_invalid'];
  if (Object.keys(value).sort().join(',') !== CONTENT_KEYS)
    return ['content_keys_invalid'];
  const content = value as Record<string, unknown>;
  const errors: string[] = [];
  const direction = content['direction'];
  const directionValid =
    typeof direction === 'string' &&
    (HOUSEHOLD_DIRECTIONS as readonly string[]).includes(direction);
  if (!directionValid) errors.push('direction_invalid');
  const amount = content['amount_yen'];
  if (
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > HOUSEHOLD_AMOUNT_MAX
  )
    errors.push('amount_invalid');
  if (!isHouseholdDate(content['occurred_on']))
    errors.push('occurred_on_invalid');
  const time = content['occurred_time'];
  if (time !== null && (typeof time !== 'string' || !LOCAL_TIME.test(time)))
    errors.push('occurred_time_invalid');
  const category =
    typeof content['category'] === 'string'
      ? householdCategory(content['category'])
      : null;
  if (category === null) errors.push('category_invalid');
  else if (directionValid && category.direction !== direction)
    errors.push('category_direction_mismatch');
  errors.push(
    ...textErrors(
      content['merchant'],
      'merchant',
      HOUSEHOLD_MERCHANT_LIMIT,
      false,
    ),
    ...textErrors(content['memo'], 'memo', HOUSEHOLD_MEMO_LIMIT, true),
    ...textErrors(
      content['payment'],
      'payment',
      HOUSEHOLD_PAYMENT_LIMIT,
      false,
    ),
  );
  return errors;
}

export function isHouseholdContent(
  value: unknown,
): value is HouseholdEntryContent {
  return householdContentErrors(value).length === 0;
}

// --- 月の集計 ---

export interface HouseholdCategoryTotal {
  readonly category: string;
  readonly total_yen: number;
  readonly count: number;
}

export interface HouseholdMonthSummary {
  readonly expense_yen: number;
  readonly income_yen: number;
  // 収入 − 支出（負にもなる）。
  readonly balance_yen: number;
  readonly entry_count: number;
  // 支出の分類ごとの合計。多い順、同じなら分類の表示の順。0 円の分類は入れない。
  readonly expense_by_category: readonly HouseholdCategoryTotal[];
  // 振替の合計（支出・収入には入れない）。
  readonly transfer_yen: number;
}

const CATEGORY_ORDER: ReadonlyMap<string, number> = new Map(
  HOUSEHOLD_CATEGORIES.map((category, index) => [category.id, index]),
);

/** 1 か月分の記録（形の検査済み）から合計を出す。 */
export function summarizeHouseholdMonth(
  entries: readonly Pick<
    HouseholdEntryContent,
    'direction' | 'amount_yen' | 'category'
  >[],
): HouseholdMonthSummary {
  let expense = 0;
  let income = 0;
  let transfer = 0;
  const byCategory = new Map<string, { total: number; count: number }>();
  for (const entry of entries) {
    if (entry.direction === 'income') income += entry.amount_yen;
    else if (entry.direction === 'transfer') transfer += entry.amount_yen;
    else {
      expense += entry.amount_yen;
      const current = byCategory.get(entry.category) ?? { total: 0, count: 0 };
      byCategory.set(entry.category, {
        total: current.total + entry.amount_yen,
        count: current.count + 1,
      });
    }
  }
  const expenseByCategory = [...byCategory.entries()]
    .map(([category, value]) => ({
      category,
      total_yen: value.total,
      count: value.count,
    }))
    .sort(
      (a, b) =>
        b.total_yen - a.total_yen ||
        (CATEGORY_ORDER.get(a.category) ?? 0) -
          (CATEGORY_ORDER.get(b.category) ?? 0),
    );
  return {
    expense_yen: expense,
    income_yen: income,
    balance_yen: income - expense,
    entry_count: entries.length,
    expense_by_category: expenseByCategory,
    transfer_yen: transfer,
  };
}

// --- 範囲 ---

// 一度に読む月の数の上限（2 年）。
export const HOUSEHOLD_MONTH_SPAN_MAX = 24;

/** from から to までの月の数（両端を含む）。逆順・形の誤りは null。 */
export function householdMonthSpan(from: string, to: string): number | null {
  if (!isHouseholdMonth(from) || !isHouseholdMonth(to)) return null;
  const index = (month: string): number =>
    Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
  const span = index(to) - index(from) + 1;
  return span >= 1 ? span : null;
}

/**
 * month から delta か月ずらした月（負ならさかのぼる）。形の誤り・2000〜2099 年の外に出るときは null。
 * 画面の「月ごとの合計」の範囲（今月から 11 か月前まで。ADR 0161）を決めるのに使う。
 */
export function householdMonthShift(
  month: string,
  delta: number,
): string | null {
  if (!isHouseholdMonth(month) || !Number.isSafeInteger(delta)) return null;
  const index =
    Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  const year = Math.floor(index / 12);
  const shifted = `${String(year)}-${String((index % 12) + 1).padStart(2, '0')}`;
  return isHouseholdMonth(shifted) ? shifted : null;
}

// --- 出所 ---

export type HouseholdSourceKind = 'mail_notice' | 'csv_import' | 'manual';

export type HouseholdSourceParts =
  | {
      readonly kind: 'mail_notice';
      readonly provider: 'google' | 'microsoft';
      readonly account_id: string;
      readonly remote_id: string;
      // 1 通のメールに複数の利用があるときの順番（0 から）。
      readonly index: number;
    }
  | {
      readonly kind: 'csv_import';
      // 書き出しの元（今はマネーフォワード ME だけ）。
      readonly origin: 'moneyforward';
      // 書き出しの行の ID（同じ行を二度取り込まない）。
      readonly row_id: string;
    }
  | { readonly kind: 'manual'; readonly entry_id: string };

const SOURCE_ID = /^[\x21-\x7e]{1,256}$/u;

export function householdSourceErrors(parts: HouseholdSourceParts): string[] {
  switch (parts.kind) {
    case 'mail_notice':
      return [
        ...(parts.provider === 'google' || parts.provider === 'microsoft'
          ? []
          : ['provider_invalid']),
        ...(SOURCE_ID.test(parts.account_id) ? [] : ['account_id_invalid']),
        ...(SOURCE_ID.test(parts.remote_id) ? [] : ['remote_id_invalid']),
        ...(Number.isSafeInteger(parts.index) &&
        parts.index >= 0 &&
        parts.index < 100
          ? []
          : ['index_invalid']),
      ];
    case 'csv_import':
      return [
        ...(parts.origin === 'moneyforward' ? [] : ['origin_invalid']),
        ...(SOURCE_ID.test(parts.row_id) ? [] : ['row_id_invalid']),
      ];
    case 'manual':
      return SOURCE_ID.test(parts.entry_id) ? [] : ['entry_id_invalid'];
    default:
      return ['source_kind_invalid'];
  }
}

/**
 * 出所の鍵の材料（項目の順を固定した JSON）。呼び出し側が SHA-256 にして DB の source_key に置く。
 * 形が正しくなければ null。
 */
export function householdSourceKeyMaterial(
  parts: HouseholdSourceParts,
): string | null {
  if (householdSourceErrors(parts).length > 0) return null;
  switch (parts.kind) {
    case 'mail_notice':
      return JSON.stringify([
        'buddy.household_source.v1',
        parts.kind,
        parts.provider,
        parts.account_id,
        parts.remote_id,
        parts.index,
      ]);
    case 'csv_import':
      return JSON.stringify([
        'buddy.household_source.v1',
        parts.kind,
        parts.origin,
        parts.row_id,
      ]);
    case 'manual':
      return JSON.stringify([
        'buddy.household_source.v1',
        parts.kind,
        parts.entry_id,
      ]);
  }
}

// --- 店名から分類を覚える ---

/**
 * 分類の規則の鍵にする店名の正規化。NFKC（全角英数・半角カナをそろえる）→ 英字を小文字 → 空白を 1 つにまとめて前後を除く。
 * 空になれば null。
 */
export function normalizeHouseholdMerchant(merchant: string): string | null {
  const normalized = merchant
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized.length === 0 ? null : normalized;
}

export type HouseholdRuleOrigin = 'user' | 'import';

/**
 * 分類の規則を書いてよいか。本人が決めた規則（user）は取込み（import）で上書きしない。
 * existing が null なら新しく書く。
 */
export function householdRuleWritable(
  existing: HouseholdRuleOrigin | null,
  incoming: HouseholdRuleOrigin,
): boolean {
  return !(existing === 'user' && incoming === 'import');
}

/** 覚えた分類を記録に当ててよいか（分類の向きが記録の向きと同じときだけ）。 */
export function householdRuleApplies(
  direction: HouseholdDirection,
  category: string,
): boolean {
  return householdCategory(category)?.direction === direction;
}

/**
 * 本人の記録から店名の規則として覚えてよいか（ADR 0175）。支出の記録で、分類が未分類でないときだけ。
 * 収入・振替の分類は向きごとに一つだけで、店名と結ぶと同じ店名の支出の規則を上書きして消すため、覚えない。
 */
export function householdRuleLearnable(
  direction: HouseholdDirection,
  category: string,
): boolean {
  return (
    direction === 'expense' &&
    category !== 'uncategorized' &&
    householdCategory(category)?.direction === 'expense'
  );
}
