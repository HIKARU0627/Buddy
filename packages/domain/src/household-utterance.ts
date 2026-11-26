// 会話の一言からの家計の記録の候補（家計簿 段階 3 の一部、ADR 0171・0174）。
//
// 本人が会話で言った一言（「コンビニで 500 円使った」「給料が 25 万円入った」）を、決まった規則だけで読み、手入力の欄
// （ADR 0167）に入れる値の候補を作る。LLM は使わない。候補は記録ではない。記録を作るのは、本人が家計簿の欄で中身を確かめて
// 「足す」を押したとき（POST /v1/household/entries）だけ。
// - 支出と収入を読む。支出を表す言い方（使った・払った・買った・かかった・購入した）か、収入を表す言い方（入った・
//   振り込まれた・もらった・売れた・売った・稼いだなど。ADR 0174）がなければ読まない（none）。問い（「使ったっけ」「？」で
//   終わる）と仮定（「使ったら」「もらったら」）も読まない。円・¥・通貨の言葉がなければ読まない。
// - 収入の言い方は、節の終わりにあり（「1000 円入った財布」「売ったお金」は数えない）、金額と同じ節にあるときだけ数える
//   （「500 円出したら、おまけをもらった」の金額は収入ではない）。金額が名詞にかかる形（「3000 円のチケット」）の後の言い方も
//   数えない。「〜てもらった」「〜んでもらった」（おごってもらった・包んでもらった）、「手に入った」「口座に入った」、
//   行き先・出どころ（「口座に」「ATM から」）や通知・メールのある節の「入った」は数えない。お釣り・立て替え・割り勘・精算・
//   貸し借り・返済・ポイント・商品券・振替・両替・値引きの言葉が一言にあれば、収入の候補にしない。支出と収入の話が両方ある
//   一言（お金を出す言い方「振り込んだ」「渡した」「おごった」「請求」なども支出の話に数える。お釣りなどの言葉と同じ節の
//   収入の話は数えない）と、「戻ってきた」「返ってきた」（返金か収入か決められない）は候補にせず、理由を返す
//   （direction_unclear）。振替は読まない。
// - 金額は円の正の整数を一つだけ読む（「500 円」「1,280 円」「¥500」「1 万 2000 円」「3 千円」）。取り消し・返金の言葉、
//   円以外の通貨、負の金額、複数の金額、0 円・桁の多すぎる金額・3 桁ごとでないコンマ、読めない金額（漢数字・小数）、
//   単価（「時給 1000 円」「1 個 200 円」）は候補にせず、理由を返す（unreadable）。返金・払い戻しは収入にもしない。
// - 日付は「今日」「昨日」「昨夜」「おととい」「さきおととい」だけを読み、日付の言葉がなければ今日にする。読めない日付の言葉
//   （「3 日」「先週」「去年」「明日」「ついたち」）や違う日付の言葉が二つあれば null（本人が入れる）。数の後の「円ショップ」
//   「円札」「円引き」などは金額にしない。
// - 支出の店名は金額のすぐ前の「〜で」の部分（読点か文の頭まで。頭の「今日は」などの時の言葉を除く）。収入の出どころは
//   金額のすぐ前の「〜で」「〜から」「〜が」「〜を」の部分で、店名・相手の欄ではなくメモに入れる（ADR 0174）。記録に
//   入れられない文字（長すぎる・制御文字・12 桁以上の数字の並び）、数と助数詞だけの言い方（「8 時間」「3 回」）、
//   「入った店」のような店を指すだけの言い方は入れない。支払い手段は「現金で」「カードで」などの決まった言葉だけを読む。
// - 分類は読まない（支出は未分類のまま。店名の規則は中枢が当てる。収入は向きの分類「収入」が一つだけ。ADR 0167）。
// 時計は呼び出し側が渡す今日の日付（YYYY-MM-DD）だけを使う。

import {
  HOUSEHOLD_AMOUNT_MAX,
  householdMerchantErrors,
  isHouseholdDate,
} from './household.js';
import type { HouseholdDirection } from './household.js';

export interface HouseholdUtteranceDraft {
  // 支出か収入か。振替は読まない。
  readonly direction: Exclude<HouseholdDirection, 'transfer'>;
  readonly amount_yen: number;
  // 利用した日（収入は受け取った日）。読めない日付の言葉があれば null。
  readonly occurred_on: string | null;
  // 支出の店名。収入では null（出どころはメモに入れる）。
  readonly merchant: string | null;
  // 収入の出どころ（「給料」「フリマ」）。支出では null。
  readonly memo: string | null;
  readonly payment: string | null;
}

export type HouseholdUtteranceUnreadable =
  | 'amount_missing'
  | 'amount_invalid'
  | 'several_amounts'
  | 'negative_amount'
  | 'foreign_currency'
  | 'cancellation'
  | 'direction_unclear'
  | 'unit_price';

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
// 節の終わり（文の終わり・句読点・空白・終助詞・「けど」「から」「ので」など）。収入の言い方の後がこれでなければ、
// 物の説明（「1000 円入った財布」「売ったお金」）か仮定（「もらったら」「入ったなら」）なので数えない。
const CLAUSE_END =
  '(?=$|[\\s。、,.!?…~〜ー♪]|よ|ね|わ|ぞ|ぜ|な(?!い|ら)|けど|けれど|から|ので|のに|んだ|んです|の(?=$|[\\s。、,.!?])|し(?=[\\s、,]))';
// 収入を表す言い方（ADR 0174）。「〜てもらった」「〜んでもらった」（おごってもらった・返してもらった・包んでもらった・
// 振り込んでもらった）は、本人のお金が増えた話か決められないので数えない。すぐ前が「に」の「入った」（手に入った・気に入った・
// 口座に入った）も数えない。
const INCOME = new RegExp(
  `(?:(?<!て|んで)(?:もらった|もらいました|もらえた|もらえました|貰った|貰いました|いただいた|いただきました|頂いた|頂きました)|(?<!に\\s*)(?:入った|入りました)|振り込まれた|振り込まれました|振込まれた|振込まれました|売れた|売れました|売った|売りました|稼いだ|稼ぎました)${CLAUSE_END}`,
  'gu',
);
// 収入の言い方があっても収入として数えない言葉（お釣り・立て替えの精算・貸し借りの返済・ポイントなどお金でないもの・
// 口座の間の振替・両替・値引き）。
const NOT_INCOME =
  /お釣り|おつり|釣り銭|つり銭|立て替|立替|割り勘|割勘|精算|清算|貸し|借り|返済|ポイント|商品券|ギフト券|ギフトカード|クーポン|振替|振り替|移した|移し替|おろした|下ろした|引き出|入金した|入金して|チャージ|預けた|預け入|両替|割引|割り引|値引|ディスカウント/u;
// 「入った」と同じ節の頭からの部分にこれがあれば、行き先・出どころ（「口座に」「Suica に」「ATM から」「貯金から」）への
// 振替か、知らせ（「通知が入った」「メールが入った」）の話なので、収入として数えない。
const INCOME_INTO = /に|から/u;
const NOTICE =
  /通知|連絡|メール|メッセージ|知らせ|電話|予約|予定|注文|LINE|ライン/iu;
// 節の切れ目。読点・句点などと、「たら」「ので」「けど」のような前後の話を分ける言い方。数の中のコンマ・小数点
// （「3,000」「12.5」）は切れ目にしない。
const CLAUSE_BREAK =
  /[、。!?;:\n]|,(?![0-9])|\.(?![0-9])|たら|ので|のに|けれど|けど|たから|だから|ながら/gu;
// 金額の後がこれなら、金額は後ろの名詞にかかる（「3000 円のチケット」「500 円分の」）。後ろの収入の言い方は金額の話ではない。
const MODIFIES_NOUN = /^\s*(?:分|ぶん|相当)?\s*の/u;
// 収入の言い方の後に言い足した金額（「給料が入った、25 万円」）。言い方と金額の間は読点だけ、金額の後は文の終わりだけ。
const BETWEEN_ADDED = /^[\s、,]*$/u;
const AFTER_ADDED = /^[\s。.!…♪~〜ー]*$/u;
// 支出と収入の取り違えを防ぐための、広い言い方の一覧。片方の向きの言い方で読めても、もう片方の向きの話が一言の中に
// あれば（「3000 円で売った後、本を買った」「メルカリで買った服が 2000 円で売れた」）、金額がどちらの話か決められない。
// 支出の側には、支出の候補としては読まないお金を出す言い方（振り込んだ・渡した・出した・あげた・おごった・寄付した・
// 包んだ・返した・引き落とし・請求）も入れる（「500 円出したら、おまけをもらった」は候補にしない）。
// 収入の側の「入っ」は、前が「円」「が」「は」「も」のときだけ数える（「店に入って 500 円使った」は支出のまま）。
// 「売って」の後に「た」「い」「る」が続く「売ってた」（店で売っていた）と「売れ残り」は数えない。
const SPENDING_MENTION =
  /使[っい]|つか[っい]|払[っい]|はら[っい]|買[っい]|かか[っり]|購入|振り?込ん|渡[しっ]|出し|あげ[たてま]|差し上げ|おご[っらりる]|奢[っらりる]|寄付|寄附|募金|包ん|返し[たま]|引き?落と|請求/u;
const INCOME_MENTION =
  /(?<!て|んで)(?:もら[っいえ]|貰|いただ[いき]|頂[いき])|売っ(?!て[たいる])|売れ(?!残)|稼[いぎ]|振り?込まれ|(?:円|が|は|も)\s*入[っり]/u;
// 金額のすぐ前がこれなら、金額は単価（「時給 1000 円」「1 個 200 円」「一人あたり 3000 円」）で、受け取った・払った額ではない。
const UNIT_PRICE_BEFORE =
  /(?:時給|日給|月給|週給|単価|(?:(?<![0-9])1|(?<![一二三四五六七八九十百千])一|ひと)\s*(?:個|本|枚|つ|冊|杯|点|袋|箱|人|名|回|時間|泊|台|着|足|部|食|皿|kg|キロ|グラム)|あたり|当たり|につき)\s*(?:あたり|当たり|につき)?\s*(?:は|:)?\s*$/u;
// 店名・メモに入れない言い方: 数と助数詞だけ（「8 時間」「3 回」）、店を指すだけ（「入った店」「行ったお店」）。
const COUNT_PHRASE =
  /^(?:[0-9]+|[一二三四五六七八九十]+)\s*(?:時間|分間?|秒|日間?|週間?|か月|ヶ月|カ月|ヵ月|年間?|回|度|個|本|枚|人|名|件|冊|杯|着|台|つ)(?:半|ほど|くらい|ぐらい|だけ)?$/u;
const POINTER_PHRASE = /た(?:店|お店|ところ|所|とこ|場所)$/u;
// 返金か収入か決められない言い方。
const DIRECTION_UNCLEAR =
  /(?:戻|返|もど)って(?:き|来)(?:た|ました)|(?:戻|もど)(?:った|りました)/u;
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
// 「円」の直後がこれなら、その数は金額ではない（店の種類・紙幣や硬貨・値引き）。「円」の前の空白は金額の形で読む。
const NOT_MONEY_AFTER_YEN = /^\s*(?:ショップ|均|札|玉|引き|off|オフ)/iu;
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
  さきおととい: -3,
  // 昨夜・昨晩は、夜中の 0 時を過ぎた話でも昨日の日付にする（本人が入力欄で確かめて直せる）。
  昨夜: -1,
  昨晩: -1,
};
// 長い言葉を先に（「さきおととい」を「おととい」と読まない）。
const RELATIVE_WORD =
  /さきおととい|一昨日|おととい|昨日|昨夜|昨晩|きのう|今日|きょう|本日/gu;
// 日付を決められない言葉。見つかれば日付を空にして本人に入れさせる。「明日」「あさって」は、まだ来ていない日の話か
// 言い違いか決められないので、日付を空にする。
const OTHER_DATE =
  /[0-9]+\s*(?:月|日)|先々週|先々月|先週|先月|先日|今週|今月|来週|来月|再来週|去年|昨年|今年|来年|この前|こないだ|週末|[0-9]+\/[0-9]+|曜|明後日|明日|あした|あさって|ついたち/u;
// 店名の頭から除く時と日付の言葉。「おとといと昨日」のように「と」「や」でつないだ次の言葉も続けて除く（「昨日とんかつ屋」の
// 「と」は次が時の言葉でないので除かない）。「朝・昼・夜」は、助詞がなくても次がカタカナ・英数字（「朝コンビニ」）なら除く。
// 次が漢字（「朝日食堂」「夜景」）の店名は残す。
const TIME_WORD =
  '今日|きょう|本日|昨日|きのう|一昨日|おととい|さきおととい|昨夜|昨晩|今朝|けさ|今夜|今晩|夕方|さっき|先ほど|お昼|明後日|明日|あした|あさって|ついたち|先々週|先々月|先週|先月|先日|今週|今月|来週|来月|再来週|去年|昨年|今年|来年|この前|こないだ|週末|(?:[0-9]+\\s*月\\s*)?[0-9]+\\s*日';
const LEADING_TIME = new RegExp(
  `^(?:(?:${TIME_WORD})(?:は|に|の|(?:と|や)(?=(?:${TIME_WORD})))?|(?:朝|昼|夜)(?:は|に|の)|(?:朝|昼|夜)(?=[ァ-ヶー A-Za-z0-9]))\\s*`,
  'u',
);
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
    // 「100 円ショップ」「1000 円札」「500 円引き」の数は金額ではない。
    if (NOT_MONEY_AFTER_YEN.test(text.slice(match.index + whole.length)))
      continue;
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

// 金額のすぐ前の「〜で」（収入では「〜から」「〜が」「〜を」も）の部分（読点か文の頭まで）。助詞で終わらなければ null。
function phraseBefore(
  prefix: string,
  particles: readonly string[],
): { readonly phrase: string; readonly particle: string } | null {
  const trimmed = prefix.replace(/[\s、,]+$/u, '');
  const particle = particles.find((word) => trimmed.endsWith(word));
  if (particle === undefined) return null;
  const body = trimmed.slice(0, -particle.length);
  return {
    phrase: withoutLeadingTime(/[^、,。.!]*$/u.exec(body)?.[0] ?? ''),
    particle,
  };
}

// 記録の店名・メモに入れられる文字か（長すぎる・制御文字・12 桁以上の数字の並びは入れない）。メモにも店名と同じ検査を
// 使う（メモの上限 500 文字より短い 100 文字までにそろう）。数と助数詞だけの言い方（「8 時間」）と、店を指すだけの言い方
// （「入った店」）は、店名・出どころではないので入れない。
const placeText = (text: string | null): string | null =>
  text === null ||
  text === '' ||
  COUNT_PHRASE.test(text) ||
  POINTER_PHRASE.test(text) ||
  householdMerchantErrors(text).length > 0
    ? null
    : text;

// 「〜で」の部分の店名と支払い手段。「コンビニで現金で」「現金でコンビニで」「コンビニで」「現金で」を読む。
function readPlace(phrase: string): {
  readonly place: string | null;
  readonly payment: string | null;
} {
  if (phrase === '') return { place: null, payment: null };
  let place: string | null = phrase;
  let payment: string | null = null;
  for (const word of PAYMENT_WORDS) {
    if (phrase === word) {
      payment = word;
      place = null;
    } else if (phrase.endsWith(`で${word}`)) {
      payment = word;
      place = withoutLeadingTime(phrase.slice(0, -(word.length + 1)));
    } else if (phrase.startsWith(`${word}で`)) {
      payment = word;
      place = withoutLeadingTime(phrase.slice(word.length + 1));
    } else continue;
    break;
  }
  return { place: placeText(place), payment };
}

// 支出は店名と支払い手段、収入は出どころ（メモ）と支払い手段を読む。
function readSource(
  prefix: string,
  direction: HouseholdUtteranceDraft['direction'],
): Pick<HouseholdUtteranceDraft, 'merchant' | 'memo' | 'payment'> {
  const nothing = { merchant: null, memo: null, payment: null };
  if (direction === 'expense') {
    const found = phraseBefore(prefix, ['で']);
    if (found === null) return nothing;
    const read = readPlace(found.phrase);
    return { merchant: read.place, memo: null, payment: read.payment };
  }
  // 収入の出どころは、店名・相手の欄に入れるとその名前の規則（分類「収入」）を中枢が覚え、同じ名前の支出の規則を
  // 上書きするので、メモに入れる（ADR 0174、U353）。
  const found = phraseBefore(prefix, ['で', 'から', 'が', 'を']);
  if (found === null) return nothing;
  if (found.particle === 'で') {
    const read = readPlace(found.phrase);
    return { merchant: null, memo: read.place, payment: read.payment };
  }
  return { merchant: null, memo: placeText(found.phrase), payment: null };
}

interface Span {
  readonly start: number;
  readonly end: number;
}

// 一言を節に分ける（CLAUSE_BREAK の切れ目の後ろで分ける。切れ目の言葉は前の節に含める）。
function clausesOf(text: string): Span[] {
  const clauses: Span[] = [];
  let start = 0;
  for (const match of text.matchAll(CLAUSE_BREAK)) {
    const end = match.index + match[0].length;
    clauses.push({ start, end });
    start = end;
  }
  clauses.push({ start, end: text.length });
  return clauses;
}

// 位置を含む節の番号。一言の終わりの位置は最後の節にする。
function clauseAt(clauses: readonly Span[], position: number): number {
  const index = clauses.findIndex((clause) => position < clause.end);
  return index === -1 ? clauses.length - 1 : index;
}

// 収入として数える言い方の位置。「入った」は、同じ節の頭からの部分（頭の時の言葉を除く）に行き先・出どころ（「に」
// 「から」）か知らせの言葉があれば数えない（振替・通知の話。「25日に」のような頭の日付は除いてから見る）。
function incomeExpressions(text: string, clauses: readonly Span[]): Span[] {
  const found: Span[] = [];
  for (const match of text.matchAll(INCOME)) {
    if (match[0].startsWith('入')) {
      const clause = clauses[clauseAt(clauses, match.index)] as Span;
      const head = withoutLeadingTime(text.slice(clause.start, match.index));
      if (INCOME_INTO.test(head) || NOTICE.test(head)) continue;
    }
    found.push({ start: match.index, end: match.index + match[0].length });
  }
  return found;
}

// 収入の言い方が、この金額の話か。金額と同じ節で金額より後にあり、金額が名詞にかかっていない（「3000 円のチケット」）か、
// 言い方の後に金額を言い足した形（「給料が入った、25 万円」）のときだけ、金額の話とする。
function incomeOfAmount(
  text: string,
  clauses: readonly Span[],
  amount: Span,
  expression: Span,
): boolean {
  if (
    expression.start >= amount.end &&
    clauseAt(clauses, amount.start) === clauseAt(clauses, expression.start)
  )
    return !MODIFIES_NOUN.test(text.slice(amount.end, expression.start));
  return (
    expression.end <= amount.start &&
    BETWEEN_ADDED.test(text.slice(expression.end, amount.start)) &&
    AFTER_ADDED.test(text.slice(amount.end))
  );
}

/**
 * 会話の一言を決まった規則で読み、家計の記録（支出か収入）の候補を返す。today は呼び出し側の今日の日付（YYYY-MM-DD）。
 * 候補は手入力の欄に入れる値で、記録ではない（本人が確かめて足すまで何も保存しない）。
 */
export function readHouseholdUtterance(
  utterance: string,
  today: string,
): HouseholdUtteranceReading {
  const text = utterance.normalize('NFKC').trim();
  const clauses = clausesOf(text);
  const expressions = incomeExpressions(text, clauses);
  const spending = SPENDING.test(text);
  // お釣り・立て替えなどの言葉が一言のどこかにあれば、収入の候補にはしない（どの節の話か決まった規則で決めきれないため、
  // 取りこぼしの側に倒す。U352・U354）。
  const income = expressions.length > 0 && !NOT_INCOME.test(text);
  const unclear = DIRECTION_UNCLEAR.test(text);
  if (
    !(spending || income || unclear) ||
    QUESTION.test(text) ||
    !(YEN_MONEY.test(text) || FOREIGN.test(text))
  )
    return { kind: 'none' };
  const unreadable = (
    reason: HouseholdUtteranceUnreadable,
  ): HouseholdUtteranceReading => ({ kind: 'unreadable', reason });
  // 返金・払い戻し・取り消しは、支出にも収入にもしない。
  if (CANCELLATION.test(text)) return unreadable('cancellation');
  // 収入の話があるか。お釣り・立て替えなどの言葉と同じ節の収入の話（「お釣りももらった」）だけは数えない。別の節の
  // 言葉（「給料が 25 万円入った。立て替えてた分を払った」）では、収入の話を消さない。
  const incomeHeard = clauses.some((clause) => {
    const part = text.slice(clause.start, clause.end);
    return (
      !NOT_INCOME.test(part) &&
      (INCOME_MENTION.test(part) ||
        expressions.some(
          (expression) =>
            clause.start <= expression.start && expression.start < clause.end,
        ))
    );
  });
  // 支出の言い方（お金を出す言い方を含む）と収入の話が両方あれば、金額がどちらの話か決められない。
  if (unclear || (incomeHeard && SPENDING_MENTION.test(text)))
    return unreadable('direction_unclear');
  if (FOREIGN.test(text)) return unreadable('foreign_currency');
  const amounts = amountMatches(text);
  if (amounts.length === 0) return unreadable('amount_missing');
  if (amounts.length > 1) return unreadable('several_amounts');
  const amount = amounts[0] as AmountMatch;
  // ここまで来た一言は、支出の言い方か収入の言い方のどちらか一方だけを持つ。
  const direction = spending ? 'expense' : 'income';
  // 収入の言い方が金額と別の節にある（「500 円出したら、おまけをもらった」）・金額が名詞にかかる一言は読まない。
  if (
    direction === 'income' &&
    !expressions.some((expression) =>
      incomeOfAmount(text, clauses, amount, expression),
    )
  )
    return { kind: 'none' };
  if (UNIT_PRICE_BEFORE.test(text.slice(0, amount.start)))
    return unreadable('unit_price');
  if (NEGATIVE_BEFORE.test(text.slice(0, amount.start)))
    return unreadable('negative_amount');
  if (
    amount.value === null ||
    amount.value < 1 ||
    amount.value > HOUSEHOLD_AMOUNT_MAX
  )
    return unreadable('amount_invalid');
  return {
    kind: 'draft',
    draft: {
      direction,
      amount_yen: amount.value,
      occurred_on: readDate(text, today),
      ...readSource(text.slice(0, amount.start), direction),
    },
  };
}
