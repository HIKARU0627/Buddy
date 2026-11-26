// レシートの写真からの家計の記録の候補（家計簿 段階 3 の一部、ADR 0177）。
//
// 本人が選んだレシートの写真 1 枚を、本人が家計簿の欄で外部への送信を入にしているときだけ、外部のモデルの画像の読み取りへ
// 送る（送るのは中枢。ここは送らない）。ここに置くのは純粋な規則だけ:
// - 画像の検査: 形式（JPEG・PNG）と縦横の大きさを、画像を開く前にバイト列の頭から読む。本人が選んだファイルの上限
//   （端末の main が縮める前）と、外部へ送る画像の上限（JPEG だけ・バイト数・長い辺）を分けて持つ。
// - 応答の読み直し: 外部のモデルの応答は信用しない入力として扱い、決まった形かを確かめ、金額・日付・店名・支払い手段を
//   家計の記録の検査（householdContentErrors・12 桁以上の数字の並びの拒否）で確かめ直す。読めない・矛盾する結果
//   （円でない・合計と品目の和が違う・レシートが二枚以上・カード番号らしい数字の並び）は候補にしない。
// 候補は記録ではない。記録を作るのは、本人が手入力の欄（ADR 0167）で中身を確かめて「足す」を押したときだけ。
// 品目は合計との突き合わせにだけ使い、候補に入れない（端末へ返さない）。

import {
  HOUSEHOLD_AMOUNT_MAX,
  householdContentErrors,
  householdHasLongDigits,
  householdMerchantErrors,
  isHouseholdDate,
} from './household.js';

// --- 画像の検査 ---

/** 本人が選ぶファイルのバイト数の上限（端末の main が読む前に確かめる）。 */
export const RECEIPT_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
/** 本人が選ぶ画像の 1 辺の上限（開く前に確かめ、大きすぎる画像を開かない）。 */
export const RECEIPT_SOURCE_MAX_SIDE = 12_000;
/** 本人が選ぶ画像の画素の数の上限。 */
export const RECEIPT_SOURCE_MAX_PIXELS = 50_000_000;
/** 外部へ送る画像（端末の main が縮めて JPEG にし直したもの）のバイト数の上限。中枢への要求の本文の上限に収める。 */
export const RECEIPT_SEND_MAX_BYTES = 180 * 1024;
/** 外部へ送る画像の長い辺の上限。 */
export const RECEIPT_SEND_MAX_SIDE = 1600;
/** 画像の短い辺の下限（これより小さい画像は文字を読めない）。 */
export const RECEIPT_MIN_SIDE = 64;

export type ReceiptImageFormat = 'jpeg' | 'png';

export interface ReceiptImageInfo {
  readonly format: ReceiptImageFormat;
  readonly width: number;
  readonly height: number;
}

export const RECEIPT_IMAGE_PROBLEMS = [
  // JPEG・PNG のどちらでもない。
  'image_format_unsupported',
  // 形式の頭はあるが、縦横の大きさを読めない（壊れている）。
  'image_unreadable',
  // バイト数が上限を超える。
  'image_too_large',
  // 縦横・画素の数が上限を超える。
  'image_dimensions_too_large',
  // 短い辺が下限より小さい。
  'image_too_small',
] as const;

export type ReceiptImageProblem = (typeof RECEIPT_IMAGE_PROBLEMS)[number];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const readUint32 = (bytes: Uint8Array, at: number): number =>
  (((bytes[at] as number) << 24) >>> 0) +
  ((bytes[at + 1] as number) << 16) +
  ((bytes[at + 2] as number) << 8) +
  (bytes[at + 3] as number);

const readUint16 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] as number) << 8) + (bytes[at + 1] as number);

function pngInfo(bytes: Uint8Array): ReceiptImageInfo | null {
  // 署名 8 バイト、最初の塊の長さ 4 バイト、種類 IHDR 4 バイト、幅 4 バイト、高さ 4 バイト。
  if (bytes.length < 24) return null;
  const type = String.fromCharCode(...bytes.subarray(12, 16));
  if (type !== 'IHDR') return null;
  return {
    format: 'png',
    width: readUint32(bytes, 16),
    height: readUint32(bytes, 20),
  };
}

// 大きさを持つ JPEG の区切り（SOF0〜SOF15 のうち、DHT・JPG・DAC を除く）。
const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc;

function jpegInfo(bytes: Uint8Array): ReceiptImageInfo | null {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    // 区切りの前の埋めの 0xFF を飛ばす。
    let markerAt = at + 1;
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt += 1;
    if (markerAt >= bytes.length) return null;
    const marker = bytes[markerAt] as number;
    // 長さを持たない区切り。
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at = markerAt + 1;
      continue;
    }
    // 画像の終わり・走査の始まりまでに大きさがなければ読めない。
    if (marker === 0xd9 || marker === 0xda) return null;
    if (markerAt + 3 > bytes.length) return null;
    const length = readUint16(bytes, markerAt + 1);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      if (length < 7 || markerAt + 8 > bytes.length) return null;
      return {
        format: 'jpeg',
        height: readUint16(bytes, markerAt + 4),
        width: readUint16(bytes, markerAt + 6),
      };
    }
    at = markerAt + 1 + length;
  }
  return null;
}

/** 画像の形式（JPEG・PNG）と縦横の大きさを頭から読む。どちらの形式でもない・読めなければ null。 */
export function receiptImageInfo(bytes: Uint8Array): ReceiptImageInfo | null {
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value))
    return pngInfo(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return jpegInfo(bytes);
  return null;
}

const isKnownFormat = (bytes: Uint8Array): boolean =>
  PNG_SIGNATURE.every((value, index) => bytes[index] === value) ||
  (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff);

function imageErrors(
  bytes: Uint8Array,
  limits: {
    readonly maxBytes: number;
    readonly maxSide: number;
    readonly maxPixels: number;
    readonly formats: readonly ReceiptImageFormat[];
  },
): ReceiptImageProblem[] {
  if (bytes.length > limits.maxBytes) return ['image_too_large'];
  if (!isKnownFormat(bytes)) return ['image_format_unsupported'];
  const info = receiptImageInfo(bytes);
  if (info === null) return ['image_unreadable'];
  if (!limits.formats.includes(info.format))
    return ['image_format_unsupported'];
  if (info.width === 0 || info.height === 0) return ['image_unreadable'];
  if (
    Math.max(info.width, info.height) > limits.maxSide ||
    info.width * info.height > limits.maxPixels
  )
    return ['image_dimensions_too_large'];
  if (Math.min(info.width, info.height) < RECEIPT_MIN_SIDE)
    return ['image_too_small'];
  return [];
}

/** 本人が選んだファイルの検査（端末の main が画像を開く前）。JPEG と PNG を受ける。空なら開いてよい。 */
export function receiptSourceImageErrors(
  bytes: Uint8Array,
): ReceiptImageProblem[] {
  return imageErrors(bytes, {
    maxBytes: RECEIPT_SOURCE_MAX_BYTES,
    maxSide: RECEIPT_SOURCE_MAX_SIDE,
    maxPixels: RECEIPT_SOURCE_MAX_PIXELS,
    formats: ['jpeg', 'png'],
  });
}

/** 外部へ送る画像の検査（端末の main が縮めた後と、中枢が受け取った後）。JPEG だけを受ける。空なら送ってよい。 */
export function receiptSendImageErrors(
  bytes: Uint8Array,
): ReceiptImageProblem[] {
  return imageErrors(bytes, {
    maxBytes: RECEIPT_SEND_MAX_BYTES,
    maxSide: RECEIPT_SEND_MAX_SIDE,
    maxPixels: RECEIPT_SEND_MAX_SIDE * RECEIPT_SEND_MAX_SIDE,
    formats: ['jpeg'],
  });
}

// --- 応答の読み直し ---

/** 外部のモデルの応答の品目の数の上限（これを超える応答は形が違うとみなす）。 */
export const RECEIPT_REPLY_ITEMS_MAX = 100;

export const HOUSEHOLD_RECEIPT_REASONS = [
  // 写真から読めなかった（レシートでない・ぼやけている・切れている）。
  'unreadable',
  // 一枚の写真にレシートが二枚以上ある。
  'several_receipts',
  // 円の金額と確かめられなかった（外貨・通貨が分からない）。
  'currency_not_yen',
  // 合計の金額を読めなかった（ない・0 以下・上限を超える）。
  'total_unreadable',
  // 品目の金額の和が合計と合わない。
  'items_total_mismatch',
  // カード番号・口座番号らしい 12 桁以上の数字の並びがある。
  'long_digits',
  // 応答が決まった形でない・記録の検査に合わない。
  'reply_invalid',
  // 外部のモデルが読み取りを断った。
  'refused',
] as const;

export type HouseholdReceiptReason = (typeof HOUSEHOLD_RECEIPT_REASONS)[number];

/** 手入力の欄に入れる値の候補。向きは支出、分類は未分類（中枢が店名の規則を当てる）で固定。 */
export interface HouseholdReceiptDraft {
  readonly amount_yen: number;
  // 読めない・今日より後なら null（本人が入れる）。
  readonly occurred_on: string | null;
  readonly occurred_time: string | null;
  readonly merchant: string | null;
  readonly payment: string | null;
}

export type HouseholdReceiptReading =
  | { readonly kind: 'candidate'; readonly draft: HouseholdReceiptDraft }
  | {
      readonly kind: 'not_candidate';
      readonly reasons: readonly HouseholdReceiptReason[];
    };

// 応答の形（外部のモデルに求める JSON。キーはちょうどこれだけ）。
const REPLY_KEYS = [
  'currency',
  'date',
  'items',
  'merchant',
  'payment',
  'readable',
  'receipt_count',
  'time',
  'total',
].join(',');
const ITEM_KEYS = ['amount', 'name'].join(',');
const LOCAL_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;
// 品目名・店名・支払い手段の文字の長さの上限（応答の形の検査。記録に入れる店名・支払い手段は記録の検査でさらに絞る）。
const REPLY_TEXT_LIMIT = 200;

const notCandidate = (
  ...reasons: HouseholdReceiptReason[]
): HouseholdReceiptReading => ({ kind: 'not_candidate', reasons });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isTextOrNull = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === 'string' && [...value].length <= REPLY_TEXT_LIMIT);

const isSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

// 前後の空白を除き、NFC にそろえる。空なら null。
const cleanText = (value: string | null): string | null => {
  if (value === null) return null;
  const text = value.normalize('NFC').trim();
  return text === '' ? null : text;
};

interface ReplyItem {
  readonly name: string | null;
  readonly amount: number;
}

interface Reply {
  readonly readable: boolean;
  readonly receipt_count: number;
  readonly currency: string | null;
  readonly total: number | null;
  readonly date: string | null;
  readonly time: string | null;
  readonly merchant: string | null;
  readonly payment: string | null;
  readonly items: readonly ReplyItem[];
}

function replyOf(value: unknown): Reply | null {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).sort().join(',') !== REPLY_KEYS) return null;
  const {
    readable,
    receipt_count: count,
    currency,
    total,
    date,
    time,
    merchant,
    payment,
    items,
  } = value;
  if (typeof readable !== 'boolean') return null;
  if (!isSafeInteger(count) || count < 0) return null;
  if (!isTextOrNull(currency)) return null;
  if (total !== null && !isSafeInteger(total)) return null;
  if (!isTextOrNull(date) || !isTextOrNull(time)) return null;
  if (!isTextOrNull(merchant) || !isTextOrNull(payment)) return null;
  if (!Array.isArray(items) || items.length > RECEIPT_REPLY_ITEMS_MAX)
    return null;
  const parsed: ReplyItem[] = [];
  for (const item of items as unknown[]) {
    if (!isPlainObject(item)) return null;
    if (Object.keys(item).sort().join(',') !== ITEM_KEYS) return null;
    const { name, amount } = item;
    if (!isTextOrNull(name) || !isSafeInteger(amount)) return null;
    // 値引きは負の金額で受ける。1 品目の大きさは記録の上限まで。
    if (Math.abs(amount) > HOUSEHOLD_AMOUNT_MAX) return null;
    parsed.push({ name, amount });
  }
  return {
    readable,
    receipt_count: count,
    currency,
    total: total as number | null,
    date,
    time,
    merchant,
    payment,
    items: parsed,
  };
}

/**
 * 外部のモデルの応答（JSON を読んだ値）を、手入力の欄に入れる候補にする。today は中枢が本人のタイムゾーンで決めた今日
 * （YYYY-MM-DD）で、これより後の日付は読めなかったものとして空にする。読めない・矛盾する結果は候補にせず、理由を返す。
 */
export function readHouseholdReceiptReply(
  value: unknown,
  today: string,
): HouseholdReceiptReading {
  const reply = replyOf(value);
  if (reply === null) return notCandidate('reply_invalid');
  if (!reply.readable || reply.receipt_count === 0)
    return notCandidate('unreadable');
  if (reply.receipt_count > 1) return notCandidate('several_receipts');
  // 文字のどこかにカード番号らしい数字の並びがあれば、候補にしない（品目名も含めて、端末へ写さない）。
  const texts = [
    reply.merchant,
    reply.payment,
    ...reply.items.map((item) => item.name),
  ].filter((text): text is string => text !== null);
  if (texts.some((text) => householdHasLongDigits(text.normalize('NFKC'))))
    return notCandidate('long_digits');
  if (reply.currency !== 'JPY') return notCandidate('currency_not_yen');
  const total = reply.total;
  if (total === null || total < 1 || total > HOUSEHOLD_AMOUNT_MAX)
    return notCandidate('total_unreadable');
  if (reply.items.length > 0) {
    const sum = reply.items.reduce((acc, item) => acc + item.amount, 0);
    if (sum !== total) return notCandidate('items_total_mismatch');
  }
  const date =
    reply.date !== null && isHouseholdDate(reply.date) && reply.date <= today
      ? reply.date
      : null;
  const time =
    reply.time !== null && LOCAL_TIME.test(reply.time) ? reply.time : null;
  const merchantText = cleanText(reply.merchant);
  const merchant =
    householdMerchantErrors(merchantText).length === 0 ? merchantText : null;
  const paymentText = cleanText(reply.payment);
  const draft: HouseholdReceiptDraft = {
    amount_yen: total,
    occurred_on: date,
    occurred_time: time,
    merchant,
    payment: paymentText,
  };
  // 記録の検査で確かめ直す（日付が空なら今日で埋めて確かめる。支払い手段が合わなければ空にしてもう一度）。
  const contentOf = (payment: string | null) => ({
    direction: 'expense',
    amount_yen: draft.amount_yen,
    occurred_on: draft.occurred_on ?? today,
    occurred_time: draft.occurred_time,
    category: 'uncategorized',
    merchant: draft.merchant,
    memo: null,
    payment,
  });
  if (householdContentErrors(contentOf(draft.payment)).length === 0)
    return { kind: 'candidate', draft };
  if (householdContentErrors(contentOf(null)).length === 0)
    return { kind: 'candidate', draft: { ...draft, payment: null } };
  return notCandidate('reply_invalid');
}
