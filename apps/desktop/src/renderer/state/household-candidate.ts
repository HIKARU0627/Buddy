// 会話の一言からの家計の記録の候補（ADR 0171）。React と DOM に依存しない純粋な関数を置き、node:test で試験する。
// 候補は本人の一言を決まった規則で読んだ値（@buddy/domain の readHouseholdUtterance）で、記録ではない。画面のメモリーにだけ
// 置き（保存しない・中枢へ送らない）、本人が家計簿の欄の手入力の入力欄（ADR 0167）で確かめて「足す」を押したときだけ記録になる。
// ロック・切断で会話と一緒に捨てる。
import type {
  HouseholdUtteranceDraft,
  HouseholdUtteranceReading,
  HouseholdUtteranceUnreadable,
} from '@buddy/domain';
import type { ManualEntryInput } from './household-state.js';
import { yenText } from './household-state.js';

export type HouseholdCandidate = Exclude<
  HouseholdUtteranceReading,
  { readonly kind: 'none' }
>;

/** 読んだ結果から会話の下に出す候補を作る。支出の話でなければ null（何も出さない）。 */
export function householdCandidateFrom(
  reading: HouseholdUtteranceReading,
): HouseholdCandidate | null {
  return reading.kind === 'none' ? null : reading;
}

/** 端末の今日の日付（YYYY-MM-DD）。候補の「今日」「昨日」を数える基準（本人が入力欄で確かめて直せる。U344）。 */
export function localDateText(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const HOUSEHOLD_CANDIDATE_LABELS = {
  title: '家計簿の記録の候補',
  note: 'まだ記録していません。家計簿の入力欄で中身を確かめ、分類を選んでから「足す」を押すと記録します。',
  open: '家計簿の入力欄で開く',
  dismiss: '閉じる',
  cannotOpen:
    '家計簿を読み込めていないか、別の記録を足している途中のため、今は開けません。',
  noDate: '日付は入力欄で入れてください',
} as const;

export const HOUSEHOLD_UNREADABLE_TEXT: Readonly<
  Record<HouseholdUtteranceUnreadable, string>
> = {
  amount_missing:
    '金額を読めなかったため、家計簿の記録の候補にしていません。「500\u00a0円」のように円の数字で言うか、家計簿の欄の「記録を手で足す」から入れてください。',
  amount_invalid:
    '金額を読めなかったため、家計簿の記録の候補にしていません。金額は 1\u00a0円以上で 10\u00a0桁までです。家計簿の欄の「記録を手で足す」から入れてください。',
  several_amounts:
    '金額が二つ以上あるため、家計簿の記録の候補にしていません。一つずつ言うか、家計簿の欄の「記録を手で足す」から入れてください。',
  negative_amount:
    '負の金額は家計簿の記録の候補にしていません。収入や取り消しは、家計簿の欄から足すか直してください。',
  foreign_currency:
    '円以外の通貨の金額は家計簿の記録の候補にしていません。円に直した金額を、家計簿の欄の「記録を手で足す」から入れてください。',
  cancellation:
    '取り消し・返金の話は家計簿の記録の候補にしていません。記録を直すときや削除するときは、家計簿の欄から操作してください。',
};

// 「支出 500 円・コンビニ・現金・11 月 26 日」。日付がなければ入れるように書く。
export function householdCandidateText(draft: HouseholdUtteranceDraft): string {
  const parts = [`支出 ${yenText(draft.amount_yen)}`];
  if (draft.merchant !== null) parts.push(draft.merchant);
  if (draft.payment !== null) parts.push(draft.payment);
  if (draft.occurred_on === null) parts.push(HOUSEHOLD_CANDIDATE_LABELS.noDate);
  else {
    const [, month, day] = draft.occurred_on.split('-');
    parts.push(
      `${String(Number(month))}\u00a0月\u00a0${String(Number(day))}\u00a0日`,
    );
  }
  return parts.join('・');
}

/** 候補を手入力の入力欄の文字にする。向きは支出、分類は未分類（中枢が店名の規則を当てる）。 */
export function inputFromCandidate(
  draft: HouseholdUtteranceDraft,
): ManualEntryInput {
  return {
    direction: 'expense',
    amount: String(draft.amount_yen),
    date: draft.occurred_on ?? '',
    time: '',
    category: 'uncategorized',
    merchant: draft.merchant ?? '',
    memo: '',
    payment: draft.payment ?? '',
  };
}
