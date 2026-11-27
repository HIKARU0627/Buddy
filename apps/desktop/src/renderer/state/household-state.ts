// 家計簿の画面の状態と、操作から送る要求（ADR 0162。API は ADR 0161）。React と DOM に依存しない純粋な関数と状態の
// 持ち主を置き、node:test で試験する。記録の ID・内容版は main が持つ。画面に来るのは main の参照（ref）と表示用の値だけ。
// - 今月は中枢が本人のタイムゾーンで決めた値を使う（端末の時計で決めない。U331）。月は合計の一覧から選ぶ。
// - 未取得・取得の失敗を「記録はありません」にしない。
// - 分類の変更は選んだらすぐ送る（直せるので確かめない）。中身の変更（ADR 0169）は行の中に入力欄（今の値を入れた状態）を出し、
//   送れたらしまう。拒否なら残して直させる。削除は同じ通知から作り直さないので、画面の中で一度確かめる。
// - 請求予定を消す（ADR 0179）も、同じメールから作り直さないので、画面の中で一度確かめる。請求予定を直す操作はない。
// 理由のコード・API の名前・記録の ID は画面に出さない。
import type {
  DesktopHouseholdBill,
  DesktopHouseholdEntry,
  DesktopHouseholdReceiptView,
  DesktopHouseholdView,
  DesktopIpcRequest,
  DesktopIpcResponse,
  HouseholdCategoryId,
} from '@buddy/contracts';
import {
  HOUSEHOLD_CATEGORIES,
  householdDuplicateGroups,
  householdMonthShift,
} from '@buddy/domain';
import { request } from '../desktop-api.js';
import { REJECT_MESSAGES } from '../labels.js';

type Rejected = Extract<DesktopIpcResponse, { outcome: 'rejected' }>;
type RejectReason = Rejected['reason'];

export const HOUSEHOLD_IPC_FAILURE_MESSAGE =
  '画面と Buddy の本体の間で通信できませんでした。Buddy を終了して、開き直してください。';

// --- 文言 ---

export const HOUSEHOLD_LABELS = {
  section: '家計簿',
  refresh: '読み直す',
  reading: '読み込んでいます…',
  lastFetched: '最終取得',
  months: '月ごとの合計',
  expense: '支出',
  income: '収入',
  balance: '収支',
  transfer: '振替',
  count: '件',
  byCategory: '分類ごとの支出',
  entries: '記録',
  empty: 'この月の記録はありません。',
  category: '分類',
  delete: '削除する',
  deleting: '削除しています…',
  deleteConfirm:
    'この記録を削除しますか。削除した記録は集計から外れ、同じ通知からは作り直しません。',
  deleteSubmit: '削除する',
  cancel: 'やめる',
  changing: '分類を変えています…',
  unknown: '変更の結果を確認できませんでした',
  thisMonth: '今月',
  truncated:
    '記録が多いため、一部の記録を読み込めていません。合計は読み込めた記録だけのものです。',
  intakeOn: 'カードの利用通知メールを取り込んでいます。',
  intakeOff: 'カードの利用通知メールの取り込みを止めています。',
  intakeStop: '取り込みを止める',
  intakeResume: '取り込みを再開する',
  intakeResumeNote:
    '再開すると、止めていた間に届いた通知は読みません。その分は書き出したファイルの取り込みで補ってください。',
  intakeChanging: '切り替えています…',
  importTitle: '書き出したファイルの取り込み',
  importNote:
    'マネーフォワード ME のアプリで書き出した入出金履歴の CSV を取り込みます。取り込み済みの行と、利用通知で記録済みの利用は二重に記録しません。',
  importButton: 'ファイルを選んで取り込む',
  importing: '取り込んでいます…',
  exportTitle: '記録の書き出し',
  exportNote:
    '家計簿の記録を CSV ファイルに書き出します。ファイルには金額・店名・メモがそのまま（暗号化せず）入ります。書くのは、選んだ場所だけです。書き出したファイルの保管は、ご自身で気をつけてください。',
  exportRange: '書き出す期間',
  exportButton: '保存先を選んで書き出す',
  exporting: '書き出しています…',
  recurringTitle: '定期の支出（固定費の目安）',
  recurringNote:
    '毎月決まって払っている支出です。直近 12 か月の記録から、3 か月以上続き、今月か先月にもある店を数えています。',
  recurringEmpty: 'まだ定期の支出は見つかっていません。',
  recurringTotal: '月の固定費の目安',
  billsTitle: '請求予定',
  billsNote:
    'カード会社の請求のお知らせメールから読んだ、この月に引き落とされる予定の金額です。利用の記録を後からまとめて知らせるものなので、支出の合計・予算・定期の支出には入れていません。',
  billsEmpty: 'この月に引き落とされる請求予定はありません。',
  billsTotal: '請求予定の合計',
  billsTruncated: '請求予定が多いため、一部だけを出しています。',
  billDelete: '消す',
  billDeleting: '消しています…',
  billDeleteConfirm:
    'この請求予定を消しますか。消した請求予定は請求予定の一覧と合計から外れ、同じメールからは作り直しません。',
  billDeleteSubmit: '消す',
  billUnknown: '消した結果を確認できませんでした',
  budgetTitle: '予算',
  budgetEmpty: 'まだ予算を決めていません。',
  budgetEdit: '予算を決める',
  budgetSave: '予算を保存する',
  budgetSaving: '保存しています…',
  budgetNote:
    '分類ごとの月の予算を円で入れてください。空のままの分類は予算なしにします。',
  budgetTotal: '予算の合計',
  budgetInvalid: '予算は 1\u00a0円以上の整数で入れてください。',
  editOpen: '中身を直す',
  editTitle: '記録の中身を直す',
  editNote:
    '金額・日付・時刻・店名・メモ・支払い手段・分類を直せます。向きは変えられません。向きを変えたいときは、削除して足し直してください。',
  editSubmit: '直す',
  editing: '直しています…',
  addTitle: '記録を足す',
  addOpen: '記録を手で足す',
  addNote:
    'メールにも書き出しにもない支出（現金など）や収入を足します。カード番号・口座番号は入れないでください。',
  addFromConversationNote:
    '会話の一言から読んだ値を入れました。まだ記録していません。金額・日付・店名を確かめ、分類を選んでから「足す」を押してください。',
  addFromConversationIncomeNote:
    '会話の一言から読んだ値を、収入として入れました。まだ記録していません。向き・金額・日付・メモを確かめてから「足す」を押してください。',
  addFromConversationTransferNote:
    '会話の一言から読んだ値を入れました。まだ記録していません。向きは振替です。金額・日付を確かめてから「足す」を押してください。',
  addSubmit: '足す',
  adding: '足しています…',
  addDirection: '向き',
  addAmount: '金額（円）',
  addDate: '日付',
  addTime: '時刻（なくてもよい）',
  addMerchant: '店名・相手',
  addMemo: 'メモ',
  addPayment: '支払い手段',
  duplicateNote:
    '同じ日・同じ金額の記録が別の出所からも入っています。同じ利用を二重に記録していないか確かめ、重なっていれば片方を削除してください。',
  duplicateMark: '重なっているかもしれません',
  addInvalid:
    '金額（1\u00a0円以上の整数）と日付（2000〜2099\u00a0年）を入れてください。時刻は HH:MM です。',
} as const;

/**
 * 出している月の記録のうち、重なっていそうな記録の参照（ADR 0168）。同じ日・同じ金額・同じ向きで出所の違う記録や、
 * 手入力の二つを、本人が確かめられるように印を付ける（自動では消さない）。
 */
export function duplicateRefs(
  entries: readonly DesktopHouseholdEntry[],
): ReadonlySet<string> {
  return new Set(
    householdDuplicateGroups(
      entries.map((entry) => ({
        key: entry.ref,
        source_kind: entry.source_kind,
        direction: entry.direction,
        occurred_on: entry.occurred_on,
        amount_yen: entry.amount_yen,
      })),
    ).flat(),
  );
}

// 手入力の知らせを出す場所。
export const ADD_PLACE = 'add';

export interface ManualEntryInput {
  readonly direction: DesktopHouseholdEntry['direction'];
  readonly amount: string;
  readonly date: string;
  readonly time: string;
  readonly category: HouseholdCategoryId;
  readonly merchant: string;
  readonly memo: string;
  readonly payment: string;
}

/**
 * 会話の一言の候補で開いた手入力の欄の頭の説明（ADR 0171・0174）。候補の向きではなく今の入力の向きで選ぶ。収入の候補で
 * 開いた後に本人が向きを支出へ変えたら、支出の説明（分類を選ぶ）に変える。
 */
export function addFromConversationNote(
  direction: ManualEntryInput['direction'],
): string {
  if (direction === 'income')
    return HOUSEHOLD_LABELS.addFromConversationIncomeNote;
  if (direction === 'transfer')
    return HOUSEHOLD_LABELS.addFromConversationTransferNote;
  return HOUSEHOLD_LABELS.addFromConversationNote;
}

type ManualEntry = Extract<
  DesktopIpcRequest,
  { channel: 'desktop.household_add' }
>['payload']['entry'];

/** 行の今の値を入力欄の文字にする（中身の変更の欄を開くとき。ADR 0169）。 */
export function inputFromEntry(entry: DesktopHouseholdEntry): ManualEntryInput {
  return {
    direction: entry.direction,
    amount: String(entry.amount_yen),
    date: entry.occurred_on,
    time: entry.occurred_time ?? '',
    category: entry.category as HouseholdCategoryId,
    merchant: entry.merchant ?? '',
    memo: entry.memo ?? '',
    payment: entry.payment ?? '',
  };
}

/**
 * 入力欄の文字から手入力の記録を作る。金額は全角数字とコンマを受ける。空の店名・メモ・支払い手段は null。形が
 * 違えば null（送らせない。長さ・長い数字の並びなどの中身の検査は中枢が行う）。
 */
export function manualEntryFromInput(
  input: ManualEntryInput,
): ManualEntry | null {
  const amount = input.amount.normalize('NFKC').replaceAll(',', '').trim();
  if (!/^[1-9][0-9]{0,9}$/u.test(amount)) return null;
  const date = input.date.normalize('NFKC').trim();
  const match = /^(20[0-9]{2})-([0-9]{2})-([0-9]{2})$/u.exec(date);
  if (match === null) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  )
    return null;
  const time = input.time.normalize('NFKC').trim();
  if (time !== '' && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/u.test(time))
    return null;
  const text = (value: string): string | null => {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  const allowed = categoryChoices(input.direction).map((choice) => choice.id);
  return {
    direction: input.direction,
    amount_yen: Number(amount),
    occurred_on: date,
    occurred_time: time === '' ? null : time,
    category: allowed.includes(input.category)
      ? input.category
      : (allowed[0] as HouseholdCategoryId),
    merchant: text(input.merchant),
    memo: text(input.memo),
    payment: text(input.payment),
  } as ManualEntry;
}

type BudgetPayload = Extract<
  DesktopIpcRequest,
  { channel: 'desktop.household_budget' }
>['payload'];

// 予算の知らせを出す場所。
export const BUDGET_PLACE = 'budget';

// 予算に対する使い方の文。「12,000 円 / 40,000 円（残り 28,000 円）」「42,000 円 / 40,000 円（2,000 円の超過）」。
export function budgetUseText(use: {
  readonly budget_yen: number;
  readonly spent_yen: number;
  readonly remaining_yen: number;
}): string {
  const head = `${yenText(use.spent_yen)} / ${yenText(use.budget_yen)}`;
  return use.remaining_yen >= 0
    ? `${head}（残り ${yenText(use.remaining_yen)}）`
    : `${head}（${yenText(-use.remaining_yen)}の超過）`;
}

/**
 * 入力欄の文字（分類 → 入れた文字）から予算の一覧を作る。空は予算なし。全角数字とコンマを受ける。正の整数で
 * なければ null（保存させない）。
 */
export function budgetItemsFromInput(
  input: Readonly<Record<string, string>>,
): { category: HouseholdCategoryId; budget_yen: number }[] | null {
  const items: { category: HouseholdCategoryId; budget_yen: number }[] = [];
  for (const choice of categoryChoices('expense')) {
    const raw = (input[choice.id] ?? '')
      .normalize('NFKC')
      .replaceAll(',', '')
      .trim();
    if (raw === '') continue;
    if (!/^[1-9][0-9]{0,9}$/u.test(raw)) return null;
    const value = Number(raw);
    if (value > 9_999_999_999) return null;
    items.push({ category: choice.id, budget_yen: value });
  }
  return items;
}

// 「12 か月中 4 か月」（定期の支出が現れた月の数）。
export function monthsSeenText(months: number): string {
  return `12\u00a0か月中\u00a0${String(months)}\u00a0か月`;
}

// 取り込みの知らせを出す場所。
export const IMPORT_PLACE = 'import';

type LastImport = NonNullable<DesktopHouseholdView['last_import']>;

// 取り込みの結果の文。
export function importResultText(result: LastImport): string {
  if (result.outcome === 'unreadable')
    return 'ファイルを読めませんでした。マネーフォワード ME のアプリで書き出した入出金履歴の CSV か、16\u00a0MB 以下かを確かめてください。';
  const parts = [
    `新しく記録\u00a0${String(result.created)}\u00a0件`,
    `取り込み済み\u00a0${String(result.duplicate)}\u00a0件`,
    `利用通知と同じ\u00a0${String(result.matched)}\u00a0件`,
  ];
  if (result.skipped > 0)
    parts.push(`集計から外した行など\u00a0${String(result.skipped)}\u00a0件`);
  if (result.rejected > 0)
    parts.push(`記録できなかった行\u00a0${String(result.rejected)}\u00a0件`);
  const counts = `${parts.join('、')}。`;
  return result.outcome === 'stopped'
    ? `途中で中枢に送れなくなったため止めました（${counts}）もう一度取り込むと、残りの行を記録します（記録済みの行は増えません）。`
    : `取り込みました（${counts}）`;
}

// 書き出しの知らせを出す場所。
export const EXPORT_PLACE = 'export';

// 書き出す期間の選び方（今出している月だけ・今月までの 12 か月・36 か月・10 年）。
export const EXPORT_RANGES = [
  { id: 'shown', label: '今出している月だけ', months: 1 },
  { id: 'year', label: '直近 12\u00a0か月', months: 12 },
  { id: 'three_years', label: '直近 36\u00a0か月', months: 36 },
  { id: 'ten_years', label: '直近 10\u00a0年（120\u00a0か月）', months: 120 },
] as const;

export type ExportRangeId = (typeof EXPORT_RANGES)[number]['id'];

/**
 * 選んだ期間の始めと終わりの月。今月（中枢が決めた月）までをさかのぼる。「今出している月だけ」は出している月。
 * 2000 年より前になるときは 2000-01 から。決められなければ null。
 */
export function exportRangeOf(
  id: ExportRangeId,
  currentMonth: string | null,
  shownMonth: string | null,
): { readonly from: string; readonly to: string } | null {
  const choice = EXPORT_RANGES.find((range) => range.id === id);
  if (choice === undefined) return null;
  if (choice.id === 'shown')
    return shownMonth === null ? null : { from: shownMonth, to: shownMonth };
  if (currentMonth === null) return null;
  const from =
    householdMonthShift(currentMonth, 1 - choice.months) ?? '2000-01';
  return { from, to: currentMonth };
}

type LastExport = NonNullable<DesktopHouseholdView['last_export']>;

// 書き出しの結果の文。
export function exportResultText(result: LastExport): string {
  const months = `${String(result.months)}\u00a0か月分`;
  const entries = `${String(result.entries)}\u00a0件`;
  switch (result.outcome) {
    case 'saved':
      return `書き出しました（${months}、記録\u00a0${entries}）。ファイルには金額・店名・メモがそのまま入っています。`;
    case 'incomplete': {
      const reasons: string[] = [];
      if (result.truncated_months > 0)
        reasons.push(
          `件数が多くて一部しか読めなかった月が\u00a0${String(result.truncated_months)}\u00a0か月`,
        );
      if (result.unreadable > 0)
        reasons.push(
          `読めない記録が\u00a0${String(result.unreadable)}\u00a0件`,
        );
      const hint =
        result.truncated_months > 0
          ? '期間を狭めて、もう一度お試しください。'
          : '読めない記録が残る間は書き出せません。';
      return `${reasons.join('、')}あるため、欠けたファイルになるので書き出しませんでした。${hint}`;
    }
    case 'read_failed':
      return '記録を読めなかったため、書き出しませんでした。接続を確かめて、もう一度お試しください。';
    case 'write_failed':
      return '選んだ場所に書けなかったため、書き出せませんでした（書きかけのファイルは消しました）。空き容量と保存先を確かめて、もう一度お試しください。';
    case 'write_failed_unchanged':
      return '選んだ場所を開けなかったため、書き出せませんでした（ファイルは作らず、元のファイルも変えていません）。保存先の権限と空き容量を確かめて、もう一度お試しください。';
    case 'write_failed_left':
      return '選んだ場所に書けなかったため、書き出せませんでした。書きかけのファイルが残っているか、選んだファイルの中身が不完全になっている可能性があります。保存先のファイルを確かめてください。';
    case 'link_refused':
      return '選んだ場所はシンボリックリンクなので、何も書きませんでした。リンクではない場所を選んで、もう一度お試しください。';
  }
}

// 取り込みの入・切の知らせを出す場所（行の参照は main が作る UUID なので重ならない）。
export const INTAKE_PLACE = 'intake';

export const FETCH_LABELS: Readonly<
  Record<DesktopHouseholdView['fetch'], string>
> = {
  loaded: '取得できています',
  stale: '最新の取得に失敗しました。前回の内容を表示しています',
  unavailable: 'まだ取得できていません',
};

export const SOURCE_LABELS: Readonly<
  Record<DesktopHouseholdEntry['source_kind'], string>
> = {
  mail_notice: '利用通知メール',
  csv_import: '取り込み',
  manual: '手入力',
};

export const DIRECTION_LABELS: Readonly<
  Record<DesktopHouseholdEntry['direction'], string>
> = {
  expense: '支出',
  income: '収入',
  transfer: '振替',
};

const CATEGORY_LABELS: ReadonlyMap<string, string> = new Map(
  HOUSEHOLD_CATEGORIES.map((category) => [category.id, category.label]),
);

export function categoryLabel(id: string): string {
  return CATEGORY_LABELS.get(id) ?? id;
}

// その記録に付けられる分類（向きが同じもの。表示の順）。支出は 18 個、収入・振替は 1 個。
export function categoryChoices(
  direction: DesktopHouseholdEntry['direction'],
): readonly { readonly id: HouseholdCategoryId; readonly label: string }[] {
  return HOUSEHOLD_CATEGORIES.filter(
    (category) => category.direction === direction,
  ).map((category) => ({
    id: category.id as HouseholdCategoryId,
    label: category.label,
  }));
}

// 「1,280 円」「-3,000 円」。区切りは端末の言語の設定によらず 3 桁ごとのコンマ。
export function yenText(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  const digits = String(Math.abs(Math.trunc(amount))).replace(
    /\B(?=(\d{3})+(?!\d))/gu,
    ',',
  );
  return `${sign}${digits}\u00a0円`;
}

// 「2030 年 11 月」。形が違えばそのまま。
export function monthText(month: string): string {
  const match = /^([0-9]{4})-([0-9]{2})$/u.exec(month);
  if (match === null) return month;
  return `${match[1] as string}\u00a0年\u00a0${String(Number(match[2]))}\u00a0月`;
}

// 請求予定の引き落とし日「引き落とし 12 月 10 日」（年は月の見出しにあるので出さない）。形が違えばそのまま。
export function billDueText(dueOn: string): string {
  const match = /^[0-9]{4}-([0-9]{2})-([0-9]{2})$/u.exec(dueOn);
  if (match === null) return dueOn;
  return `引き落とし\u00a0${String(Number(match[1]))}\u00a0月\u00a0${String(Number(match[2]))}\u00a0日`;
}

// 読めなかった請求予定の知らせ。
export function billsUnreadableText(count: number): string {
  return `読めない請求予定が\u00a0${String(count)}\u00a0件あります（合計には入れていません）。`;
}

// 「11 月 3 日 12:34」（年は月の見出しにあるので出さない）。
export function dayText(entry: DesktopHouseholdEntry): string {
  const [, month, day] = entry.occurred_on.split('-');
  const date = `${String(Number(month))}\u00a0月\u00a0${String(Number(day))}\u00a0日`;
  return entry.occurred_time === null ? date : `${date} ${entry.occurred_time}`;
}

// --- 時刻の経過（最終取得） ---

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function elapsedText(utc: string | null, now: number): string | null {
  if (utc === null) return null;
  const at = Date.parse(utc);
  if (!Number.isFinite(at)) return null;
  const elapsed = now - at;
  if (elapsed < MINUTE) return 'たった今';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}\u00a0分前`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}\u00a0時間前`;
  return `${Math.floor(elapsed / DAY)}\u00a0日前`;
}

// --- 状態 ---

export interface HouseholdNotice {
  readonly tone: 'warning' | 'success';
  readonly text: string;
  // 出す場所。null は欄の頭、それ以外は行の参照。
  readonly place: string | null;
}

export interface HouseholdViewState {
  // null はまだ受け取っていない。
  readonly view: DesktopHouseholdView | null;
  // 反映した値の main の通し番号（0 はまだ反映していない）。これより小さい番号の値は反映しない。
  readonly seq: number;
  readonly reading: boolean;
  // 変更・削除を送って結果を待っている行の参照（二重に押させない）。
  readonly busy: string | null;
  readonly notice: HouseholdNotice | null;
  // 削除の確かめを出している行の参照。
  readonly confirming: string | null;
  // 消す確かめを出している請求予定の行の参照（ADR 0179）。
  readonly confirmingBill: string | null;
  // 予算の入力欄を出しているか。
  readonly editingBudget: boolean;
  // 手入力の欄を出しているか。
  readonly adding: boolean;
  // 手入力の欄に入れておく値（会話の一言からの候補。ADR 0171）。null は空の欄。
  readonly addPrefill: ManualEntryInput | null;
  // 中身の変更の欄を出している行の参照（ADR 0169）。
  readonly editing: string | null;
  // レシートの写真の読み取りの最後の結果（ADR 0177）。候補か、送らなかった・候補にしなかった理由。画面のメモリーにだけ置き、
  // 閉じる・入力欄で開く・ロック・切断で捨てる。
  readonly receipt: DesktopHouseholdReceiptView | null;
  // 手入力の欄をレシートの候補で開いたか（欄の頭の説明を変える）。
  readonly addFromReceipt: boolean;
}

export const INITIAL_HOUSEHOLD_STATE: HouseholdViewState = {
  view: null,
  seq: 0,
  reading: false,
  busy: null,
  notice: null,
  confirming: null,
  confirmingBill: null,
  editingBudget: false,
  adding: false,
  addPrefill: null,
  editing: null,
  receipt: null,
  addFromReceipt: false,
};

// レシートの写真の読み取りの入・切と、読み取りの知らせを出す場所（ADR 0177）。
export const RECEIPT_SETTING_PLACE = 'receipt_setting';
export const RECEIPT_PLACE = 'receipt';

type Kind =
  | 'view'
  | 'category'
  | 'delete'
  | 'bill_delete'
  | 'intake'
  | 'import'
  | 'export'
  | 'budget'
  | 'add'
  | 'edit'
  | 'receipt'
  | 'receipt_setting';

export function householdFailureText(kind: Kind, reason: RejectReason): string {
  if (kind === 'receipt')
    switch (reason) {
      case 'outcome_unknown':
        return '写真を外部へ送ったかどうか、結果を確かめられませんでした。送っていれば費用がかかっています。自動では送り直しません。読み直すときは、もう一度写真を選んでください（もう一度費用がかかります）。';
      case 'core_rejected':
        return '中枢が読み取りを受け付けませんでした。少し待ってから、もう一度写真を選んでください。';
      case 'input_stopped':
        return '入出力を止めている間は、写真を外部へ送りません。再開してから、もう一度押してください。';
      default:
        break;
    }
  if (kind === 'receipt_setting')
    switch (reason) {
      case 'confirmation_declined':
        return '送る設定にしませんでした。写真は外部へ送りません。';
      case 'outcome_unknown':
        return '設定の変更の結果を確かめられませんでした。自動では送り直しません。「読み直す」で今の設定を確かめてください。';
      case 'core_rejected':
        return '設定を変えられませんでした。読み直したので、今の設定を確かめてください。';
      default:
        break;
    }
  if (kind === 'bill_delete')
    switch (reason) {
      case 'preview_stale':
        return 'この請求予定はすでに消されていたか、その後に変わっていました。読み直したので、今の請求予定を確かめてください。';
      case 'outcome_unknown':
        return '消した結果を確かめられませんでした。自動では送り直しません。「読み直す」で今の請求予定を確かめてください。';
      case 'core_rejected':
        return '中枢が受け付けませんでした。読み直したので、今の請求予定を確かめてください。';
      default:
        break;
    }
  if (kind === 'receipt_setting' && reason === 'preview_stale')
    return '家計簿の設定はその後に変わっていました。読み直したので、今の設定を確かめてから、もう一度押してください。';
  switch (reason) {
    case 'preview_stale':
      return kind === 'intake'
        ? '取り込みの設定はその後に変わっていました。読み直したので、今の設定を確かめてください。'
        : kind === 'budget'
          ? '予算はその後に変わっていました。読み直したので、今の予算を確かめてから、もう一度保存してください。'
          : kind === 'add'
            ? 'この記録は足せませんでした（同じ要求で足した記録を消していた）。もう一度入れ直してください。'
            : 'この記録はその後に変わっていました。読み直したので、今の内容を確かめてから、もう一度操作してください。';
    case 'outcome_unknown':
      return '結果を確かめられませんでした。自動では送り直しません。「読み直す」で今の内容を確かめてください。';
    case 'core_rejected':
      if (kind === 'edit')
        return '中身を受け付けませんでした。金額・日付・分類と、店名やメモにカード番号・口座番号のような長い数字が入っていないかを確かめてください。向きは変えられません。';
      if (kind === 'add')
        return '中身を受け付けませんでした。金額・日付・分類と、店名やメモにカード番号・口座番号のような長い数字が入っていないかを確かめてください。';
      return kind === 'category'
        ? 'この分類には変えられませんでした。読み直したので、もう一度選んでください。'
        : '中枢が受け付けませんでした。読み直したので、もう一度操作してください。';
    case 'entry_not_found':
      return '表示が古くなっています。「読み直す」を押してから、もう一度操作してください。';
    case 'list_superseded':
      return '別の月を読み込んでいます。';
    case 'not_connected':
      return '中枢に接続していないため、家計簿を読めません。接続してから「読み直す」を押してください。';
    default:
      return REJECT_MESSAGES[reason];
  }
}

function withView(
  state: HouseholdViewState,
  view: DesktopHouseholdView,
): HouseholdViewState {
  if (view.list_seq < state.seq) return state;
  const refs = new Set(view.entries.map((entry) => entry.ref));
  const billRefs = new Set(view.bills?.items.map((bill) => bill.ref) ?? []);
  const place = state.notice?.place ?? null;
  return {
    ...state,
    view,
    seq: view.list_seq,
    // 確かめている行が消えたら確かめをしまう。
    confirming:
      state.confirming !== null && refs.has(state.confirming)
        ? state.confirming
        : null,
    // 消す確かめを出している請求予定が消えた・結果が分からなくなったら、確かめをしまう。
    confirmingBill:
      state.confirmingBill !== null &&
      (view.bills?.items ?? []).some(
        (bill) => bill.ref === state.confirmingBill && !bill.delivery_unknown,
      )
        ? state.confirmingBill
        : null,
    // 直している行が消えた・結果が分からなくなったら、入力欄をしまう（古い値のまま送らせない）。
    editing:
      state.editing !== null &&
      view.entries.some(
        (entry) => entry.ref === state.editing && !entry.delivery_unknown,
      )
        ? state.editing
        : null,
    // 消えた行の警告は捨てる（削除の成功の知らせは欄の頭に出す）。
    notice:
      state.notice !== null &&
      place !== null &&
      !refs.has(place) &&
      !billRefs.has(place) &&
      state.notice.tone === 'warning'
        ? null
        : state.notice,
  };
}

export function applyViewResponse(
  state: HouseholdViewState,
  response: DesktopIpcResponse,
): HouseholdViewState {
  const reading = { ...state, reading: false };
  if (response.outcome === 'rejected') {
    // 後から始めた読み取りに追い越された: その読み取りの結果を待つ（知らせを出さず、読み込み中のまま）。
    if (response.reason === 'list_superseded') return state;
    return {
      ...reading,
      notice: {
        tone: 'warning',
        text: householdFailureText('view', response.reason),
        place: null,
      },
    };
  }
  if (!('household' in response)) return reading;
  return withView(reading, response.household);
}

type ChangeKind =
  | 'category'
  | 'delete'
  | 'bill_delete'
  | 'intake'
  | 'budget'
  | 'add'
  | 'edit'
  | 'receipt_setting';

const SUCCESS_TEXT: Readonly<Record<ChangeKind, string>> = {
  edit: '記録の中身を直しました。店名と分類のある記録は、同じ店の次の未分類の利用にもその分類を使います。',
  budget: '予算を保存しました。',
  add: '記録を足しました。',
  intake: '取り込みの設定を変えました。',
  receipt_setting: 'レシートの写真を外部へ送る設定を変えました。',
  category:
    '分類を変えました。店名のある記録は、同じ店の次の未分類の利用にもこの分類を使います。',
  delete: '記録を削除しました。',
  bill_delete: '請求予定を消しました。',
};

export function applyChangeResponse(
  state: HouseholdViewState,
  kind: ChangeKind,
  place: string,
  response: DesktopIpcResponse,
): HouseholdViewState {
  const idle = {
    ...state,
    busy: state.busy === place ? null : state.busy,
    confirming: kind === 'delete' ? null : state.confirming,
    confirmingBill: kind === 'bill_delete' ? null : state.confirmingBill,
  };
  if (response.outcome === 'rejected')
    return {
      ...idle,
      notice: {
        tone: 'warning',
        text: householdFailureText(kind, response.reason),
        place,
      },
    };
  if (!('household' in response)) return idle;
  return withView(
    {
      ...idle,
      notice: {
        tone: 'success',
        text: SUCCESS_TEXT[kind],
        // 削除した行・消した請求予定は消える。直した行も、日付を直すと別の月へ移るので、欄の頭に出す。
        place:
          kind === 'delete' || kind === 'bill_delete' || kind === 'edit'
            ? null
            : place,
      },
    },
    response.household,
  );
}

export function applyFailure(
  state: HouseholdViewState,
  place: string | null,
): HouseholdViewState {
  return {
    ...state,
    reading: place === null ? false : state.reading,
    busy: place !== null && state.busy === place ? null : state.busy,
    notice: { tone: 'warning', text: HOUSEHOLD_IPC_FAILURE_MESSAGE, place },
  };
}

// 会話の一言からの候補で手入力の欄を開けるか（ADR 0171）。家計簿を読めていて、送り中でなく、手入力の欄を開いていない
// （本人が入れている途中の値を候補で書き換えない）とき。
export function canStartAddFrom(state: HouseholdViewState): boolean {
  return (
    state.view !== null &&
    state.view.fetch !== 'unavailable' &&
    state.busy === null &&
    !state.adding
  );
}

// 中身を直す欄を開けるか（送り中・結果不明の行は開けない）。
export function canEdit(
  state: HouseholdViewState,
  entry: DesktopHouseholdEntry,
): boolean {
  return canChange(state, entry);
}

export function canChange(
  state: HouseholdViewState,
  entry: DesktopHouseholdEntry | DesktopHouseholdBill,
): boolean {
  return state.busy === null && !entry.delivery_unknown;
}

// --- 操作 ---

export interface HouseholdActions {
  // 今出している月を読み直す（まだ出していなければ今月）。
  readonly refresh: () => void;
  readonly selectMonth: (month: string) => void;
  readonly changeCategory: (ref: string, category: HouseholdCategoryId) => void;
  readonly startDelete: (ref: string) => void;
  readonly cancelDelete: () => void;
  readonly confirmDelete: () => void;
  // 請求予定を消す（ADR 0179）。画面の中で一度確かめてから送る。
  readonly startBillDelete: (ref: string) => void;
  readonly cancelBillDelete: () => void;
  readonly confirmBillDelete: () => void;
  // 利用通知の取り込みを止める・再開する（ADR 0163）。
  readonly setIntake: (mailIntake: 'on' | 'off') => void;
  // 書き出しを取り込む（ADR 0164）。ファイルは main が OS のファイル選択で本人に選ばせる。
  readonly importExport: () => void;
  // 記録を月の範囲（from から to まで）で CSV に書き出す（ADR 0172）。保存先は main が OS の保存先の選択で本人に選ばせる。
  readonly exportCsv: (from: string, to: string) => void;
  // 予算の入力欄を出す・しまう・保存する（ADR 0166）。
  readonly startBudget: () => void;
  readonly cancelBudget: () => void;
  readonly saveBudget: (
    items: readonly { category: HouseholdCategoryId; budget_yen: number }[],
  ) => void;
  // 手入力の欄を出す・しまう・足す（ADR 0167）。
  readonly startAdd: () => void;
  // 会話の一言からの候補を入れた手入力の欄を出す（ADR 0171）。開けたら true。記録はまだ作らない。
  readonly startAddFrom: (input: ManualEntryInput) => boolean;
  readonly cancelAdd: () => void;
  readonly addEntry: (entry: ManualEntry) => void;
  // 行の中身の入力欄を出す・しまう・直す（ADR 0169）。
  readonly startEdit: (ref: string) => void;
  readonly cancelEdit: () => void;
  readonly editEntry: (ref: string, entry: ManualEntry) => void;
  // レシートの写真の読み取り（ADR 0177）。入・切（入にするときは main が OS の確認ダイアログを出す）、写真を選んで読む
  // （写真は main が OS のファイル選択で選ばせる）、候補を手入力の欄で開く（開けたら true。記録はまだ作らない）、閉じる。
  readonly setReceiptReading: (value: 'on' | 'off') => void;
  readonly readReceipt: () => void;
  readonly openReceipt: (input: ManualEntryInput) => boolean;
  readonly dismissReceipt: () => void;
}

export interface HouseholdApi {
  invoke(request: DesktopIpcRequest): Promise<DesktopIpcResponse>;
}

// 読み直しで今の値を見せる拒否（main も読み直しを始めている）。
const REREAD: ReadonlySet<RejectReason> = new Set([
  'preview_stale',
  'entry_not_found',
  'outcome_unknown',
  'core_rejected',
]);

// 表示の権限の世代を持ち、世代をまたいだ応答（ロック・切断の前に送った要求の遅い応答）は反映しない。
export class HouseholdStore {
  readonly #api: HouseholdApi;
  readonly #listeners = new Set<() => void>();
  #state: HouseholdViewState = INITIAL_HOUSEHOLD_STATE;
  #epoch = 0;
  readonly actions: HouseholdActions;

  constructor(api: HouseholdApi) {
    this.#api = api;
    this.actions = {
      refresh: () => this.#show(this.#state.view?.month ?? null),
      selectMonth: (month) => this.#show(month),
      changeCategory: (ref, category) => this.#category(ref, category),
      startDelete: (ref) => {
        if (this.#state.busy !== null) return;
        this.#set({
          ...this.#state,
          confirming: ref,
          confirmingBill: null,
          editing: null,
          notice: null,
        });
      },
      cancelDelete: () => this.#set({ ...this.#state, confirming: null }),
      confirmDelete: () => this.#delete(),
      startBillDelete: (ref) => {
        const bill = this.#state.view?.bills?.items.find(
          (item) => item.ref === ref,
        );
        if (bill === undefined || !canChange(this.#state, bill)) return;
        this.#set({
          ...this.#state,
          confirmingBill: ref,
          confirming: null,
          editing: null,
          notice: null,
        });
      },
      cancelBillDelete: () =>
        this.#set({ ...this.#state, confirmingBill: null }),
      confirmBillDelete: () => this.#deleteBill(),
      setIntake: (mailIntake) => this.#intake(mailIntake),
      importExport: () => this.#importExport(),
      exportCsv: (from, to) => this.#exportCsv(from, to),
      startBudget: () => {
        if ((this.#state.view?.budget ?? null) === null) return;
        this.#set({ ...this.#state, editingBudget: true, notice: null });
      },
      cancelBudget: () => this.#set({ ...this.#state, editingBudget: false }),
      saveBudget: (items) => this.#saveBudget(items),
      startAdd: () => {
        if (this.#state.view === null) return;
        this.#set({
          ...this.#state,
          adding: true,
          addPrefill: null,
          addFromReceipt: false,
          notice: null,
        });
      },
      startAddFrom: (input) => {
        if (!canStartAddFrom(this.#state)) return false;
        this.#set({
          ...this.#state,
          adding: true,
          addPrefill: input,
          addFromReceipt: false,
          confirming: null,
          editing: null,
          notice: null,
        });
        return true;
      },
      cancelAdd: () =>
        this.#set({
          ...this.#state,
          adding: false,
          addPrefill: null,
          addFromReceipt: false,
        }),
      addEntry: (entry) => this.#addEntry(entry),
      startEdit: (ref) => {
        const entry = this.#state.view?.entries.find(
          (item) => item.ref === ref,
        );
        if (entry === undefined || !canEdit(this.#state, entry)) return;
        this.#set({
          ...this.#state,
          editing: ref,
          confirming: null,
          notice: null,
        });
      },
      cancelEdit: () => {
        if (this.#state.busy !== null) return;
        this.#set({ ...this.#state, editing: null });
      },
      editEntry: (ref, entry) => this.#editEntry(ref, entry),
      setReceiptReading: (value) => this.#receiptSetting(value),
      readReceipt: () => this.#readReceipt(),
      openReceipt: (input) => {
        // 候補があり、手入力の欄を開ける（本人が入れている途中の値を書き換えない）ときだけ。開けたら候補はしまう。
        if (
          this.#state.receipt?.outcome !== 'candidate' ||
          !canStartAddFrom(this.#state)
        )
          return false;
        this.#set({
          ...this.#state,
          adding: true,
          addPrefill: input,
          addFromReceipt: true,
          receipt: null,
          confirming: null,
          editing: null,
          notice: null,
        });
        return true;
      },
      dismissReceipt: () => this.#set({ ...this.#state, receipt: null }),
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly snapshot = (): HouseholdViewState => this.#state;

  #set(next: HouseholdViewState): void {
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #send(
    built: DesktopIpcRequest,
    onResponse: (
      state: HouseholdViewState,
      response: DesktopIpcResponse,
    ) => HouseholdViewState,
    onFailure: (state: HouseholdViewState) => HouseholdViewState,
  ): Promise<void> {
    const epoch = this.#epoch;
    const apply = (
      change: (prev: HouseholdViewState) => HouseholdViewState,
    ) => {
      if (epoch !== this.#epoch) return;
      this.#set(change(this.#state));
    };
    return this.#api.invoke(built).then(
      (response) => apply((prev) => onResponse(prev, response)),
      () => apply(onFailure),
    );
  }

  #show(month: string | null): void {
    this.#set({
      ...this.#state,
      reading: true,
      notice: null,
      confirming: null,
    });
    void this.#send(
      request('desktop.household_view', { month }),
      applyViewResponse,
      (state) => applyFailure(state, null),
    );
  }

  #category(ref: string, category: HouseholdCategoryId): void {
    const entry = this.#state.view?.entries.find((item) => item.ref === ref);
    if (entry === undefined || !canChange(this.#state, entry)) return;
    if (entry.category === category) return;
    this.#set({ ...this.#state, busy: ref, notice: null, confirming: null });
    this.#change(
      'category',
      ref,
      request('desktop.household_category', { ref, category }),
    );
  }

  #intake(mailIntake: 'on' | 'off'): void {
    const current = this.#state.view?.mail_intake ?? null;
    if (this.#state.busy !== null || current === null || current === mailIntake)
      return;
    this.#set({
      ...this.#state,
      busy: INTAKE_PLACE,
      notice: null,
      confirming: null,
    });
    this.#change(
      'intake',
      INTAKE_PLACE,
      request('desktop.household_intake', { mail_intake: mailIntake }),
    );
  }

  #receiptSetting(value: 'on' | 'off'): void {
    const current = this.#state.view?.receipt_reading ?? null;
    if (
      this.#state.busy !== null ||
      current === null ||
      current === 'unavailable' ||
      current === value
    )
      return;
    this.#set({
      ...this.#state,
      busy: RECEIPT_SETTING_PLACE,
      notice: null,
      confirming: null,
    });
    this.#change(
      'receipt_setting',
      RECEIPT_SETTING_PLACE,
      request('desktop.household_receipt_setting', { receipt_reading: value }),
    );
  }

  // レシートの写真を 1 枚読む（ADR 0177）。結果（候補か理由）は画面のメモリーにだけ置く。記録は作らない。結果不明は送り直さない。
  #readReceipt(): void {
    if (this.#state.busy !== null || this.#state.view?.receipt_reading !== 'on')
      return;
    this.#set({
      ...this.#state,
      busy: RECEIPT_PLACE,
      receipt: null,
      notice: null,
      confirming: null,
    });
    void this.#send(
      request('desktop.household_receipt_read', null),
      (state, response) => {
        const idle = {
          ...state,
          busy: state.busy === RECEIPT_PLACE ? null : state.busy,
        };
        if (response.outcome === 'rejected')
          return {
            ...idle,
            notice: {
              tone: 'warning' as const,
              text: householdFailureText('receipt', response.reason),
              place: RECEIPT_PLACE,
            },
          };
        if (
          response.channel !== 'desktop.household_receipt_read' ||
          !('receipt' in response)
        )
          return idle;
        const receipt = response.receipt as DesktopHouseholdReceiptView;
        // 本人が写真を選ばなかった: 何も出さない。
        return receipt.outcome === 'cancelled' ? idle : { ...idle, receipt };
      },
      (state) => applyFailure(state, RECEIPT_PLACE),
    ).then(() => {
      // 中枢の設定が切だった: 今の設定を読み直して見せる（main も読み直している）。
      if (this.#state.receipt?.outcome === 'setting_off') this.#reread();
    });
  }

  #saveBudget(
    items: readonly { category: HouseholdCategoryId; budget_yen: number }[],
  ): void {
    if (this.#state.busy !== null || !this.#state.editingBudget) return;
    this.#set({ ...this.#state, busy: BUDGET_PLACE, notice: null });
    const epoch = this.#epoch;
    let reread = false;
    void this.#send(
      request('desktop.household_budget', {
        // 契約の上限（18 個）は生成型では組の型になるので、分類の数で守っている一覧をその型として渡す。
        items: [...items] as BudgetPayload['items'],
      }),
      (state, response) => {
        reread = response.outcome === 'rejected' && REREAD.has(response.reason);
        const next = applyChangeResponse(
          state,
          'budget',
          BUDGET_PLACE,
          response,
        );
        // 保存できたら入力欄をしまう。拒否なら残して直させる。
        return response.outcome === 'ok'
          ? { ...next, editingBudget: false }
          : next;
      },
      (state) => applyFailure(state, BUDGET_PLACE),
    ).then(() => {
      if (reread && epoch === this.#epoch) this.#reread();
    });
  }

  #addEntry(entry: ManualEntry): void {
    if (this.#state.busy !== null || !this.#state.adding) return;
    this.#set({ ...this.#state, busy: ADD_PLACE, notice: null });
    const epoch = this.#epoch;
    let reread = false;
    void this.#send(
      request('desktop.household_add', { entry }),
      (state, response) => {
        reread = response.outcome === 'rejected' && REREAD.has(response.reason);
        const next = applyChangeResponse(state, 'add', ADD_PLACE, response);
        // 足せたら欄をしまう。拒否なら残して直させる。
        return response.outcome === 'ok'
          ? { ...next, adding: false, addPrefill: null, addFromReceipt: false }
          : next;
      },
      (state) => applyFailure(state, ADD_PLACE),
    ).then(() => {
      if (reread && epoch === this.#epoch) this.#reread();
    });
  }

  // 行の中身を直す（ADR 0169）。送れたら入力欄をしまう。拒否なら残して直させる（main が読み直した値は受け取る）。
  #editEntry(ref: string, entry: ManualEntry): void {
    const row = this.#state.view?.entries.find((item) => item.ref === ref);
    if (
      row === undefined ||
      this.#state.editing !== ref ||
      !canChange(this.#state, row)
    )
      return;
    this.#set({ ...this.#state, busy: ref, notice: null });
    const epoch = this.#epoch;
    let reread = false;
    void this.#send(
      request('desktop.household_edit', { ref, entry }),
      (state, response) => {
        reread = response.outcome === 'rejected' && REREAD.has(response.reason);
        const next = applyChangeResponse(state, 'edit', ref, response);
        return response.outcome === 'ok' ? { ...next, editing: null } : next;
      },
      (state) => applyFailure(state, ref),
    ).then(() => {
      if (reread && epoch === this.#epoch) this.#reread();
    });
  }

  #importExport(): void {
    if (this.#state.busy !== null || this.#state.view === null) return;
    this.#set({
      ...this.#state,
      busy: IMPORT_PLACE,
      notice: null,
      confirming: null,
    });
    void this.#send(
      request('desktop.household_import', null),
      (state, response) => {
        const idle = {
          ...state,
          busy: state.busy === IMPORT_PLACE ? null : state.busy,
        };
        if (response.outcome === 'rejected')
          return {
            ...idle,
            notice: {
              tone: 'warning' as const,
              text: householdFailureText('import', response.reason),
              place: IMPORT_PLACE,
            },
          };
        return 'household' in response
          ? withView(idle, response.household)
          : idle;
      },
      (state) => applyFailure(state, IMPORT_PLACE),
    );
  }

  #exportCsv(from: string, to: string): void {
    if (this.#state.busy !== null || this.#state.view === null) return;
    this.#set({
      ...this.#state,
      busy: EXPORT_PLACE,
      notice: null,
      confirming: null,
    });
    void this.#send(
      request('desktop.household_export', { from, to }),
      (state, response) => {
        const idle = {
          ...state,
          busy: state.busy === EXPORT_PLACE ? null : state.busy,
        };
        if (response.outcome === 'rejected')
          return {
            ...idle,
            notice: {
              tone: 'warning' as const,
              text: householdFailureText('export', response.reason),
              place: EXPORT_PLACE,
            },
          };
        return 'household' in response
          ? withView(idle, response.household)
          : idle;
      },
      (state) => applyFailure(state, EXPORT_PLACE),
    );
  }

  // 送った変更・削除の結果を反映し、拒否なら（main が読み直した）値を受け取る。
  #change(kind: ChangeKind, ref: string, built: DesktopIpcRequest) {
    const epoch = this.#epoch;
    let reread = false;
    void this.#send(
      built,
      (state, response) => {
        reread = response.outcome === 'rejected' && REREAD.has(response.reason);
        return applyChangeResponse(state, kind, ref, response);
      },
      (state) => applyFailure(state, ref),
    ).then(() => {
      if (reread && epoch === this.#epoch) this.#reread();
    });
  }

  // 知らせを残したまま、今出している月だけを読み直す。
  #reread(): void {
    void this.#send(
      request('desktop.household_view', {
        month: this.#state.view?.month ?? null,
      }),
      (state, response) =>
        response.outcome === 'ok' && 'household' in response
          ? withView(state, response.household)
          : state,
      (state) => state,
    );
  }

  #delete(): void {
    const ref = this.#state.confirming;
    if (ref === null || this.#state.busy !== null) return;
    this.#set({ ...this.#state, busy: ref, notice: null });
    this.#change('delete', ref, request('desktop.household_delete', { ref }));
  }

  #deleteBill(): void {
    const ref = this.#state.confirmingBill;
    if (ref === null || this.#state.busy !== null) return;
    this.#set({ ...this.#state, busy: ref, notice: null });
    this.#change(
      'bill_delete',
      ref,
      request('desktop.household_bill_delete', { ref }),
    );
  }

  // 出せなくなった（ロック・切断）: 世代を進めて内容を捨てる。
  hide(): void {
    this.#epoch += 1;
    this.#set(INITIAL_HOUSEHOLD_STATE);
  }
}
