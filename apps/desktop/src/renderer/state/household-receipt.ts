// レシートの写真からの家計の記録の候補（ADR 0177）の画面の文と値。React と DOM に依存しない純粋な関数を置き、node:test で
// 試験する。候補は記録ではない。画面のメモリーにだけ置き（保存しない）、本人が手入力の欄（ADR 0167）で確かめて「足す」を
// 押したときだけ記録になる。ロック・切断で捨てる。写真・ファイルのパスは画面に来ない。
import type {
  DesktopHouseholdReceiptView,
  HouseholdReceiptCandidate,
  HouseholdReceiptReadingState,
} from '@buddy/contracts';
import type { ManualEntryInput } from './household-state.js';
import { yenText } from './household-state.js';

export const RECEIPT_LABELS = {
  title: 'レシートの写真から読む',
  stateOn: 'レシートの写真を外部のモデルへ送る設定: 入',
  stateOff:
    'レシートの写真を外部のモデルへ送る設定: 切（写真を外部へ送りません）',
  stateUnavailable:
    'この中枢には写真の読み取りの口がないため、レシートの写真からは読めません。',
  turnOn: '送る設定にする',
  turnOff: '送らない設定にする',
  changing: '切り替えています…',
  noteOff:
    '入にすると、選んだレシートの写真 1\u00a0枚を、その都度、外部のモデルの提供元へ送って金額・日付・店名を読み取ります。読み取りのたびに外部のモデルの利用料がかかります。入にするときに確かめのダイアログを出します。',
  noteOn:
    '「写真を選んで読む」を押すと、選んだ写真 1\u00a0枚だけを外部のモデルへ送ります。写真と読み取りの結果は保存しません。読んだ値は記録にせず、入力欄に入れるだけです。',
  read: '写真を選んで読む',
  reading: '読み取っています…',
  candidateTitle: 'レシートから読んだ値',
  candidateNote:
    'まだ記録していません。家計簿の入力欄で中身を確かめ、分類を選んでから「足す」を押すと記録します。',
  open: '家計簿の入力欄で開く',
  dismiss: '閉じる',
  cannotOpen:
    '家計簿を読み込めていないか、別の記録を足している途中のため、今は開けません。',
  noDate: '日付は入力欄で入れてください',
  addNote:
    'レシートの写真から読んだ値を入れました。まだ記録していません。金額・日付・店名を確かめ、分類を選んでから「足す」を押してください。',
} as const;

export function receiptStateText(state: HouseholdReceiptReadingState): string {
  if (state === 'on') return RECEIPT_LABELS.stateOn;
  if (state === 'off') return RECEIPT_LABELS.stateOff;
  return RECEIPT_LABELS.stateUnavailable;
}

const REASON_TEXT: Readonly<
  Record<DesktopHouseholdReceiptView['reasons'][number], string>
> = {
  unreadable:
    '写真からレシートを読めませんでした。明るい場所で、レシート全体が入るように撮り直してください。',
  several_receipts:
    '一枚の写真にレシートが二枚以上写っていました。一枚ずつ撮ってください。',
  currency_not_yen:
    '円の金額と確かめられませんでした。円に直した金額を、家計簿の欄の「記録を手で足す」から入れてください。',
  total_unreadable:
    '合計の金額を読めませんでした。家計簿の欄の「記録を手で足す」から入れてください。',
  items_total_mismatch:
    '品目の金額の和が合計と合わなかったため、読み違いのおそれがあります。家計簿の欄の「記録を手で足す」から入れてください。',
  long_digits:
    'カード番号や口座番号のような長い数字が読み取られたため、候補にしていません。家計簿の欄の「記録を手で足す」から入れてください。',
  reply_invalid:
    '読み取りの結果を確かめられませんでした。家計簿の欄の「記録を手で足す」から入れてください。',
  refused:
    '読み取りを断られました。家計簿の欄の「記録を手で足す」から入れてください。',
  image_format_unsupported:
    'JPEG か PNG の写真を選んでください（HEIC などは JPEG に書き出してから選んでください）。',
  image_unreadable:
    '写真を開けませんでした。別の写真を選んでください。何も送っていません。',
  image_too_large:
    '写真が大きすぎるため、送っていません（20\u00a0MB まで。縮めても 180\u00a0KB に収まらない写真は送りません）。',
  image_dimensions_too_large:
    '写真の縦横が大きすぎるため、送っていません（1\u00a0辺 12,000\u00a0画素・5,000\u00a0万画素まで）。',
  image_too_small:
    '写真が小さすぎるため、送っていません（短い辺が 64\u00a0画素以上の写真を選んでください）。',
  image_aspect_ratio_too_large:
    '写真が細長すぎるため、送っていません（長い辺が短い辺の 16\u00a0倍までの写真を選んでください。長いレシートは、上と下に分けて撮ってください）。',
  image_metadata_present:
    '写真の付帯情報（撮影の日時・位置など）を取り除けなかったため、送っていません。別の写真を選んでください。',
};

const OUTCOME_TEXT: Readonly<
  Record<
    Exclude<
      DesktopHouseholdReceiptView['outcome'],
      'candidate' | 'not_candidate' | 'image_rejected' | 'cancelled'
    >,
    string
  >
> = {
  setting_off:
    'レシートの写真を外部へ送る設定が切になっていたため、送っていません。',
  budget_held:
    '予算を予約できなかったため、写真を送っていません。予算の状態を確かめてください。',
  not_sent:
    '中枢が外部へ送る前に止めたため、写真は送っておらず、費用もかかっていません。少し待ってから、もう一度写真を選んでください。',
};

/** 候補にしなかった・送らなかったときの文（候補のときと、本人が選ばなかったときは null）。 */
export function receiptMessage(
  result: DesktopHouseholdReceiptView,
): string | null {
  if (result.outcome === 'candidate' || result.outcome === 'cancelled')
    return null;
  if (
    result.outcome === 'setting_off' ||
    result.outcome === 'budget_held' ||
    result.outcome === 'not_sent'
  )
    return OUTCOME_TEXT[result.outcome];
  const first = result.reasons[0];
  return first === undefined ? REASON_TEXT.reply_invalid : REASON_TEXT[first];
}

// 「支出 1,280 円・合成の商店・現金・11 月 4 日」。日付がなければ入れるように書く。
export function receiptCandidateText(
  candidate: HouseholdReceiptCandidate,
): string {
  const parts = [`支出 ${yenText(candidate.amount_yen)}`];
  if (candidate.merchant !== null) parts.push(candidate.merchant);
  if (candidate.payment !== null) parts.push(candidate.payment);
  if (candidate.occurred_on === null) parts.push(RECEIPT_LABELS.noDate);
  else {
    const [, month, day] = candidate.occurred_on.split('-');
    parts.push(
      `${String(Number(month))}\u00a0月\u00a0${String(Number(day))}\u00a0日`,
    );
  }
  return parts.join('・');
}

/** 候補を手入力の欄の文字にする。向きは支出、分類は未分類（中枢が店名の規則を当てる）。メモは空。 */
export function inputFromReceipt(
  candidate: HouseholdReceiptCandidate,
): ManualEntryInput {
  return {
    direction: 'expense',
    amount: String(candidate.amount_yen),
    date: candidate.occurred_on ?? '',
    time: candidate.occurred_time ?? '',
    category: 'uncategorized',
    merchant: candidate.merchant ?? '',
    memo: '',
    payment: candidate.payment ?? '',
  };
}
