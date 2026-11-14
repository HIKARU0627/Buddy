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
  | 'result.screen'
  | 'bridge.checking'
  | 'background.moved'
  | 'accepted.background'
  | 'completion.done';

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
// 設計 10 §5 の言い回し。つなぎ（1.5 秒で結果がないとき 1 回だけ）・背景化（8 秒を超えたとき）・調査と相談の受付・追記の上限を超えた分。
const BRIDGE = '確認しますね。';
const BACKGROUND = '少し時間がかかるので、できたら知らせます。';
const ACCEPTED = '受け付けました。終わったら知らせます。';
const OVERFLOW = 'ほかは画面に出しました。';

export interface ResultCommentaryInput {
  readonly kind: ResultViewKind;
  readonly event_count: number;
  readonly overlap: boolean;
  readonly more_count: number;
  // 聞き返しの文（Core の決まった文。モデルの文ではない）。それ以外の種類では使わない。
  readonly clarification_text: string | null;
  // 残りの件数を画面にも置いたか（置いたときだけ「画面に出しました」と言う。置いていないものを出したと言わない）。省略は置いていない。
  readonly more_on_screen?: boolean;
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
      // 声で返すときは、画面へ置いていない（画面への配信は U120）。置いていないものを「画面に出した」と言わず、件数だけ伝える。
      if (more > 0)
        parts.push(
          input.more_on_screen === true
            ? `ほかに${more}件。画面に出しました。`
            : `ほかに${more}件あります。`,
        );
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

const simple = (
  template_id: CommentaryTemplateId,
  kind: ResultViewKind,
  text: string,
): Commentary => ({
  template_id,
  template_version: COMMENTARY_TEMPLATE_VERSION,
  facts: [fact(kind, null)],
  commentary_parts: [text],
});

// 委譲を受けて 1.5 秒以内に結果が出ないときの、1 回だけのつなぎ（設計 10 §5「つなぎ」）。結果ではないので事実を含まない。
export function bridgeCommentary(): Commentary {
  return simple('bridge.checking', 'status_line', BRIDGE);
}

// 8 秒を超えて裏のジョブへ移すときの 1 回だけの発話（設計 10 §5「即時ジョブの上限」）。完了は気づきと次回の文脈で伝える。
export function backgroundCommentary(): Commentary {
  return simple('background.moved', 'accepted_line', BACKGROUND);
}

// 調査（research）・思考レベル high の相談を最初から裏へ回すときの受付（設計 10 §5「裏のジョブ」）。受け付けた事実だけで、
// 結果の内容は含めない。受け付けていない依頼には使わない（呼び出し側が、裏のジョブが受け付けたときだけ使う）。
export function acceptedCommentary(): Commentary {
  return simple('accepted.background', 'accepted_line', ACCEPTED);
}

export type CompletionKind =
  | 'task_created'
  | 'note_created'
  | 'event_created'
  | 'label_applied'
  | 'draft_saved';

const COMPLETION_TEXT: Readonly<Record<CompletionKind, string>> = {
  task_created: '用事を登録しました。',
  note_created: 'メモを残しました。',
  event_created: '予定を登録しました。',
  label_applied: 'ラベルを付けました。',
  draft_saved: '下書きを保存しました。',
};

// 実行を確認できたときだけ「登録しました」と言う（設計 10 §5「変更を伴う依頼」）。executed が true でなければ、
// 完了を告げず、承認待ちの案内（画面で確認してください）にする。音声の「はい」は承認にしない。今の経路には、実行の完了を
// 確認して呼ぶ所はまだない（自動実行は B13）。ここは、完了を言ってよい条件をコードで固定するための規則。
export function completionCommentary(input: {
  readonly kind: CompletionKind;
  readonly executed: boolean;
}): Commentary {
  if (input.executed !== true)
    return resultCommentary({
      kind: 'approval_link',
      event_count: 0,
      overlap: false,
      more_count: 0,
      clarification_text: null,
    });
  return simple(
    'completion.done',
    'completion_line',
    COMPLETION_TEXT[input.kind],
  );
}

export interface FittedCommentary {
  // 1 回の追記に入れる部分（3 つ以内・各 200 文字以内・空でない）。超えた分を除いたもの（案内の文は含まない）。
  readonly parts: readonly string[];
  // 超えた分（3 つを超える部分・200 文字を超える部分）があった。あれば呼び出し側が画面へ出し、出せたときだけ
  // withOverflowNotice で案内の文を足す。
  readonly overflow: boolean;
}

// 追記の上限（1 回 400 トークン以内を 200 文字で近似・最大 3 部）を守る。切って意味を変えず、超えた部分は捨てて画面へ回す。
export function fitCommentary(commentary: Commentary): FittedCommentary {
  const parts: string[] = [];
  let overflow = false;
  for (const part of commentary.commentary_parts) {
    if (part.length === 0) continue;
    if ([...part].length > COMMENTARY_PART_MAX_CHARS) overflow = true;
    else if (parts.length >= COMMENTARY_MAX_PARTS) overflow = true;
    else parts.push(part);
  }
  return { parts, overflow };
}

// 超えた分を画面に出せたときだけ、案内の文を末尾に足す。3 部を超えないよう、満杯なら最後の部分を案内に置き換える。
export function withOverflowNotice(parts: readonly string[]): string[] {
  const kept = [...parts];
  if (kept.length >= COMMENTARY_MAX_PARTS)
    kept.splice(COMMENTARY_MAX_PARTS - 1, kept.length, OVERFLOW);
  else kept.push(OVERFLOW);
  return kept;
}
