// モデルの返答文 reply_text を、画面の吹き出しに出してよいかの規則（B10-04、ADR 0105。contract-map U217 の本人決定 (b)）。
// 設計 10 §6A: 雑談・一般の質問の返答文は判定と同じ呼出しで出させ、文字で返す入力に限って表示する。ADR 0005・0070: 応答文を
// モデルに作らせない原則の例外は、実行に関わらない 2 つの意図の文字表示だけに閉じる。モデルの文は信用しない平文として扱い、
// 操作指示・URL・リンクを実行や遷移にしない。実行を告げる根拠にもしない（実行の結果は定型文だけが告げる）。
// 読み上げ（①音声→音声）にはモデルの文を使わない。聞き返しの文 clarify_question はコードの決まった文のまま（この規則の対象外）。
// Electron・DOM・Node 専用 API には依存しない。

import { resolveOutputMode, type InputKind } from './audio.js';
import type { IntentName } from './intents.js';

// 表示してよい意図。どちらも読み取りで、実行も承認の対象も作らない。
export const REPLY_TEXT_INTENTS: readonly IntentName[] = [
  'smalltalk',
  'general_question',
];

// 吹き出しに出す文字数の上限（制御文字の除去の後で数える）。超えたら切らずに表示しない（切ると意味が変わる）。
// 値は初期値で、変えるときは版を上げて ADR に記録する。
export const REPLY_TEXT_MAX_CHARS = 400;
export const REPLY_TEXT_POLICY_VERSION = '1';

export type ReplyTextHideReason =
  'intent_not_allowed' | 'voice_output' | 'empty' | 'too_long' | 'link_in_text';

export type ReplyTextDecision =
  | { readonly decision: 'show'; readonly text: string }
  | { readonly decision: 'hide'; readonly reason: ReplyTextHideReason };

// 除く文字: 改行以外の制御文字（C0・DEL・C1）、方向を変える制御・ゼロ幅・行区切り・BOM・隔離制御（見た目を偽る文字）。
// 改行は 1 つの形（\n）にそろえ、3 つ以上続く改行は 2 つにする。
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const INVISIBLE =
  /[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/gu;

// リンクに見える形（URL・autolink・Markdown のリンク・HTML のリンク・実行や遷移になりうる scheme）。
// 見つけたら表示しない（リンクの形のまま画面へ出さない。本文から消して残りを出すと意味が変わる）。
const LINK =
  /(?:[a-z][a-z0-9+.-]{1,15}:\/\/|\bwww\.|\b(?:mailto|javascript|data|file|tel|sms|vbscript|blob):|\]\s*\(|<\s*\/?\s*(?:a|script|iframe|img|link|form)\b)/iu;

// 入力の種類と意図に当てはまるときだけ、平文として表示してよい文を返す。当てはまらない・空・長すぎ・リンクの形を含む
// ときは表示しない（呼び出し側は決まった文・画面への案内にする）。モデルの値は信用しないので、毎回ここで検査する。
export function admitReplyText(input: {
  readonly intent: IntentName;
  readonly input_kind: InputKind;
  readonly reply_text: string | null;
}): ReplyTextDecision {
  if (!REPLY_TEXT_INTENTS.includes(input.intent))
    return { decision: 'hide', reason: 'intent_not_allowed' };
  // 声で返す入力（①）には、モデルの文を使わない。出力先は入力の種類だけで決まる（D14）。
  if (resolveOutputMode(input.input_kind) !== 'text')
    return { decision: 'hide', reason: 'voice_output' };
  if (typeof input.reply_text !== 'string')
    return { decision: 'hide', reason: 'empty' };
  const text = input.reply_text
    .replace(/\r\n?/gu, '\n')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (text.length === 0) return { decision: 'hide', reason: 'empty' };
  if ([...text].length > REPLY_TEXT_MAX_CHARS)
    return { decision: 'hide', reason: 'too_long' };
  if (LINK.test(text)) return { decision: 'hide', reason: 'link_in_text' };
  return { decision: 'show', text };
}
