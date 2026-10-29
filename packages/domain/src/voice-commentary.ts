// 声で返す委譲の結果の定型文（B05-05、ADR 0052。設計 10 §5「事実文と定型文」・§6A「結果の表現」、ADR 0005）。
// 読み上げる文はコードの定型文だけから作り、モデルの自由文を入れない。1 回の追記は 400 トークン以内・最大 3 回で、
// 超える分は画面に出す。「実行した・保存した・送った」と言ってよいのは、実行を確認できた結果だけで、ここの文は
// 実行を告げない（変更は承認待ちの案内か、画面で確かめる案内だけ。音声の「はい」は承認にしない）。
// 結果を画面で見せるときの表示（ResultView）は別で、同じ事実の別の表現。

import type { ResultViewKind } from './conversation.js';

export const COMMENTARY_TEMPLATE_VERSION = '1';
// 1 回の追記に入れてよい文字数の上限（400 トークンに収まる安全側の値。日本語は 1 文字 1 トークン以下とは限らないので、
// 2 倍の余裕を見て 200 文字）。
export const COMMENTARY_PART_MAX_CHARS = 200;
export const COMMENTARY_MAX_PARTS = 3;

export type CommentaryTemplateId =
  | 'schedule.count'
  | 'schedule.none'
  | 'review.screen'
  | 'clarify.fixed'
  | 'input.say_again'
  | 'input.full_text'
  | 'input.hold_dropped'
  | 'result.screen';

export interface CommentaryFact {
  readonly kind: ResultViewKind;
  readonly ref_id: null;
  readonly title: null;
  readonly start: null;
  readonly end: null;
  readonly due: null;
  readonly count: number | null;
}

export interface Commentary {
  readonly template_id: CommentaryTemplateId;
  readonly template_version: string;
  readonly facts: readonly CommentaryFact[];
  readonly commentary_parts: readonly string[];
}

const fact = (kind: ResultViewKind, count: number | null): CommentaryFact => ({
  kind,
  ref_id: null,
  title: null,
  start: null,
  end: null,
  due: null,
  count,
});

const SAY_AGAIN = 'うまく聞き取れませんでした。もう一度言ってください。';
// 画面への表示が未対応（U120）の間でも、実際にできる操作（全文の入力のやり直し）へ案内する。
const FULL_TEXT =
  'この依頼はまだ実行していません。画面から全文を入力し直してください。';
// 保留を実行せずに捨てた通知。画面への表示が未対応（U120）の間は、声で届く文にする。
const HOLD_DROPPED =
  '実行前の依頼は実行していません。必要なら、もう一度お願いします。';
const SCREEN = '画面で確認してください。';

export interface ResultCommentaryInput {
  readonly kind: ResultViewKind;
  readonly event_count: number;
  readonly overlap: boolean;
  readonly more_count: number;
  // 聞き返しの文（Core の決まった文。モデルの文ではない）。それ以外の種類では使わない。
  readonly clarification_text: string | null;
}

const count = (value: number): number =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;

// 構造化した結果から、読み上げる定型文を作る。どの種類でも断定は事実の件数と画面への案内だけで、
// 本文・件名・宛先を読まない（本文は開いたときだけ取得する設計）。
export function resultCommentary(input: ResultCommentaryInput): Commentary {
  switch (input.kind) {
    case 'schedule_cards': {
      const events = count(input.event_count);
      const more = count(input.more_count);
      if (events === 0)
        return {
          template_id: 'schedule.none',
          template_version: COMMENTARY_TEMPLATE_VERSION,
          facts: [fact('schedule_cards', 0)],
          commentary_parts: ['予定はありません。'],
        };
      const parts = [`予定は${events}件です。`];
      if (input.overlap) parts.push('時間が重なっている予定があります。');
      if (more > 0) parts.push(`ほかに${more}件あります。画面に出しました。`);
      return {
        template_id: 'schedule.count',
        template_version: COMMENTARY_TEMPLATE_VERSION,
        facts: [fact('schedule_cards', events)],
        commentary_parts: parts,
      };
    }
    case 'approval_link':
      return {
        template_id: 'review.screen',
        template_version: COMMENTARY_TEMPLATE_VERSION,
        facts: [fact('approval_link', null)],
        commentary_parts: [SCREEN],
      };
    case 'clarification': {
      const text = input.clarification_text;
      if (
        text !== null &&
        text.length > 0 &&
        text.length <= COMMENTARY_PART_MAX_CHARS
      )
        return {
          template_id: 'clarify.fixed',
          template_version: COMMENTARY_TEMPLATE_VERSION,
          facts: [fact('clarification', null)],
          commentary_parts: [text],
        };
      return inputCommentary('say_again');
    }
    default:
      return {
        template_id: 'result.screen',
        template_version: COMMENTARY_TEMPLATE_VERSION,
        facts: [fact(input.kind, null)],
        commentary_parts: [SCREEN],
      };
  }
}

// 入力が確定しなかったとき（言い直し）・4 操作でないとき（全文の入力のやり直し）・保留を捨てたときの定型文。
export function inputCommentary(
  kind: 'say_again' | 'full_text' | 'hold_dropped',
): Commentary {
  if (kind === 'say_again')
    return {
      template_id: 'input.say_again',
      template_version: COMMENTARY_TEMPLATE_VERSION,
      facts: [fact('clarification', null)],
      commentary_parts: [SAY_AGAIN],
    };
  if (kind === 'hold_dropped')
    return {
      template_id: 'input.hold_dropped',
      template_version: COMMENTARY_TEMPLATE_VERSION,
      facts: [fact('clarification', null)],
      commentary_parts: [HOLD_DROPPED],
    };
  return {
    template_id: 'input.full_text',
    template_version: COMMENTARY_TEMPLATE_VERSION,
    facts: [fact('approval_link', null)],
    commentary_parts: [FULL_TEXT],
  };
}
