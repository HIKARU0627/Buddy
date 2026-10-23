// 金額（契約の Money。通貨単位の百万分の一を整数の文字列で持つ）の表示と、小数の入力の変換（B07-05、ADR 0038）。
// 画面と main の確認ダイアログが同じ書き方で金額を見せるため、純粋な関数として domain に置く（Electron・DOM に依存しない）。
// 浮動小数点数を使わず、BigInt と文字列だけで変換する（丸めない。小数点以下 6 桁を超える入力は受け付けない）。

import { BUDGET_AMOUNT_MAX } from './budget-rules.js';

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
