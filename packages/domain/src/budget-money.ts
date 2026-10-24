// 金額（契約の Money。通貨単位の百万分の一を整数の文字列で持つ）の表示と、小数の入力の変換（B07-05、ADR 0039）。
// 画面と main の確認ダイアログが同じ書き方で金額を見せるため、純粋な関数として domain に置く（Electron・DOM に依存しない）。
// 浮動小数点数を使わず、BigInt と文字列だけで変換する（丸めない。小数点以下 6 桁を超える入力は受け付けない）。

import { BUDGET_AMOUNT_MAX } from './budget-rules.js';
import type { BudgetOrigin } from './budget-rules.js';

const MICRO = 1_000_000n;
// 数と単位の間は改行しない空白（U+00A0。画面の文言の約束）。
const NBSP = ' ';

export interface MoneyValue {
  readonly currency: string;
  readonly amount: string;
}

// 整数部は 3 桁ごとに区切る。小数部は 2 桁を最低に、末尾の 0 を省く（0.5 → 0.50、0.000040 → 0.00004）。
export function formatAmount(amount: string): string {
  if (!/^(0|[1-9][0-9]{0,17})$/u.test(amount)) return amount;
  const value = BigInt(amount);
  const whole = (value / MICRO)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const fraction = (value % MICRO).toString().padStart(6, '0');
  const trimmed = fraction.replace(/0+$/u, '').padEnd(2, '0');
  return `${whole}.${trimmed}`;
}

// 「XTS 40.00」の形。通貨のコードは契約の値そのまま（記号に変えない）。
export function formatMoney(money: MoneyValue): string {
  return `${money.currency}${NBSP}${formatAmount(money.amount)}`;
}

// 本人が入力した小数（例 3、3.5、0.000040）を、通貨単位の百万分の一の整数の文字列にする。数字と 1 つの小数点だけ
// （符号・桁区切り・指数・空白は受け付けない。前後の空白だけ除く）。小数点以下は 6 桁まで。契約の Amount の上限
// （18 桁）を超える・空の入力は null。
export function amountFromDecimal(text: string): string | null {
  const match = /^([0-9]{1,18})(?:\.([0-9]{1,6}))?$/u.exec(text.trim());
  if (match === null) return null;
  const whole = BigInt(match[1] as string);
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0') || '0');
  const value = whole * MICRO + fraction;
  return value > BUDGET_AMOUNT_MAX ? null : value.toString();
}

// 枠の表示名（B07-05、ADR 0039）。枠の ID は設定で決める内部の名前（llm・llm.background など）で、本人に見せる名前では
// ない。枠の木（ADR 0006）の枠を、決まった対応表で用途の名前にする。対応表にない枠（設定で足した枠）は、内部の ID を
// 出さずに「別の枠」と言う（設定に表示名を持たせるのは、設定の編集の画面ができてから）。
export const BUDGET_POOL_LABELS: Readonly<Record<string, string>> = {
  total: '全体',
  llm_search: '会話と検索の合計',
  llm: '会話',
  'llm.background': '自動の解析',
  search: '検索',
  voice: '音声',
  overage: '超過枠',
};

export const BUDGET_POOL_UNKNOWN_LABEL = '別の枠';

export function budgetPoolLabel(poolId: string): string {
  return Object.hasOwn(BUDGET_POOL_LABELS, poolId)
    ? (BUDGET_POOL_LABELS[poolId] as string)
    : BUDGET_POOL_UNKNOWN_LABEL;
}

// 処理の起点の表示名（用途）。
export const BUDGET_ORIGIN_LABELS: Readonly<Record<BudgetOrigin, string>> = {
  owner_request: '本人の依頼',
  autonomous_analysis: '自動の解析',
  auto_execution: '自動の実行',
  initial_import: '初回の読み込み',
  shadow_mode: '影モード',
};

export function budgetOriginLabel(origin: BudgetOrigin): string {
  return BUDGET_ORIGIN_LABELS[origin];
}

// 表示が重なる項目の順番の言い方（「同じ時刻の 2 件のうち 1 件目」）。一覧・読み上げの名前・確認のダイアログで同じ
// 言い方にする（B07-05、ADR 0039）。数と単位の間は改行しない空白。
export function budgetOrdinalLabel(position: number, of: number): string {
  return `同じ時刻の ${of} 件のうち ${position} 件目`.replace(
    /(\d) 件/gu,
    `$1${NBSP}件`,
  );
}
