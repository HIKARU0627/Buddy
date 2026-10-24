// 無音の規則（B05-02、ADR 0041。設計 10 §3・§5・§1A、09 X25・X29・X55、質問 81・100・126）。
// 無音の判定は端末の main だけが行う（中枢は文字起こしの間隔だけでは閉じない）。時刻は呼び出し側が単調時計で渡す。
// 既定 10 秒、Buddy の直前の発話が質問で終わっていたら 20 秒、「ちょっと待って」で 1 回だけ 60 秒（どれも設計初期値）。

import { SILENCE_TIMEOUT_MS_RANGE } from './voice.js';

export const SILENCE_DEFAULT_MS = 10000;
export const SILENCE_AFTER_QUESTION_MS = 20000;
export const SILENCE_EXTENDED_MS = 60000;

// Buddy の直前の発話が質問で終わったか（コードでの判定。LLM は使わない。10 §3）。
// 文末の記号・空白・閉じ括弧を除いた末尾が、疑問符か次の言い回しのときだけ質問とする（初期の一覧。B05 で調整する）。
const QUESTION_ENDINGS = [
  '?',
  'ますか',
  'ませんか',
  'ですか',
  'でしょうか',
  'ますかね',
  'ですかね',
] as const;
const TRAILING = /[\s。．、，,.!！…」』）)]+$/u;

export function endsWithQuestion(utterance: string): boolean {
  const text = utterance.normalize('NFKC').replace(TRAILING, '');
  return QUESTION_ENDINGS.some((ending) => text.endsWith(ending));
}

// 委譲の状態。前面で待つ間だけ無音に数えない。8 秒で裏へ移したら通知を解除して通常の判定に戻る（10 §5A-7、X55）。
export type DelegationPhase = 'none' | 'foreground' | 'background';

export interface SilenceInput {
  // 端末の VAD が本人の発話を検知している。
  readonly user_speaking: boolean;
  // Buddy の音声を再生中（音声レンダラーが知らせる）。
  readonly playing: boolean;
  readonly delegation: DelegationPhase;
  // 画面の操作があった瞬間（そのとき無音の数え直しを始める）。
  readonly screen_event: boolean;
  // 画面の操作が続いている間（入力中など）。
  readonly screen_active: boolean;
}

export interface SilenceState {
  // 無音を数え始めた時刻。数えていなければ null（活動中）。
  readonly quiet_since_ms: number | null;
  // Buddy の直前の発話が質問で終わったか。
  readonly after_question: boolean;
  // 「ちょっと待って」を受けたが、まだ無音の区間が始まっていない（本人が話している最中）。
  readonly extension_pending: boolean;
  // 今の無音の区間が 60 秒に延びている。区間が活動で途切れると消える（1 回だけ）。
  readonly extension_active: boolean;
}

export const INITIAL_SILENCE_STATE: SilenceState = {
  quiet_since_ms: null,
  after_question: false,
  extension_pending: false,
  extension_active: false,
};

// 今の無音の猶予（ms）。set_silence_timeout の範囲に入る値だけを返す。
export function silenceTimeoutMs(state: SilenceState): number {
  const ms = state.extension_active
    ? SILENCE_EXTENDED_MS
    : state.after_question
      ? SILENCE_AFTER_QUESTION_MS
      : SILENCE_DEFAULT_MS;
  return Math.min(
    SILENCE_TIMEOUT_MS_RANGE.max,
    Math.max(SILENCE_TIMEOUT_MS_RANGE.min, ms),
  );
}

// 無音に数えない活動（委譲の処理中・再生中・画面の操作中・本人の発話中）。
export function silenceBlockers(input: SilenceInput): string[] {
  const blockers: string[] = [];
  if (input.user_speaking) blockers.push('user_speaking');
  if (input.playing) blockers.push('playing');
  if (input.delegation === 'foreground') blockers.push('delegation_foreground');
  if (input.screen_active) blockers.push('screen_active');
  return blockers;
}

export interface SilenceDecision {
  readonly state: SilenceState;
  readonly decision: 'keep' | 'close';
  readonly timeout_ms: number;
  // 閉じるまでの残り（ms）。活動中は null。
  readonly remaining_ms: number | null;
  readonly blockers: readonly string[];
}

// 観測のたびに呼ぶ（活動が変わったとき・時間の経過の確認のとき）。閉じる判定は、直前までの状態に対して now で行い
// （数え始めから猶予ちょうどで閉じる）、その後に今の活動を反映する。閉じる理由は silence（close_voice_session）。
// now が数え始めより前（時計の戻り）なら、閉じずに数え直す（戻った時計で閉じない・閉じ損ねない側へ倒すため、
// 数え始めを now に置き直す）。
export function observeSilence(
  state: SilenceState,
  input: SilenceInput,
  now_ms: number,
): SilenceDecision {
  const blockers = silenceBlockers(input);
  let current = state;
  if (current.quiet_since_ms !== null && now_ms < current.quiet_since_ms)
    current = { ...current, quiet_since_ms: now_ms };
  if (
    current.quiet_since_ms !== null &&
    now_ms - current.quiet_since_ms >= silenceTimeoutMs(current)
  )
    return {
      state: current,
      decision: 'close',
      timeout_ms: silenceTimeoutMs(current),
      remaining_ms: 0,
      blockers,
    };
  let next: SilenceState;
  if (blockers.length > 0) {
    // 活動で区間が途切れる。60 秒の延長は、その区間だけで消える（1 回だけ）。
    next = {
      ...current,
      quiet_since_ms: null,
      extension_active: false,
    };
  } else if (input.screen_event || current.quiet_since_ms === null) {
    next = {
      ...current,
      quiet_since_ms: now_ms,
      // 画面の操作での数え直しも活動による途切れで、前の区間の延長は持ち越さない。
      extension_active: current.extension_pending,
      extension_pending: false,
    };
  } else next = current;
  const timeout = silenceTimeoutMs(next);
  return {
    state: next,
    decision: 'keep',
    timeout_ms: timeout,
    remaining_ms:
      next.quiet_since_ms === null
        ? null
        : timeout - (now_ms - next.quiet_since_ms),
    blockers,
  };
}

// Buddy の発話が終わった・質問で終わったかを反映する（文字起こしの末尾から endsWithQuestion で判定した結果）。
export function withBuddyUtterance(
  state: SilenceState,
  endedWithQuestion: boolean,
): SilenceState {
  return { ...state, after_question: endedWithQuestion };
}

export type SilenceExtension =
  | { readonly granted: true; readonly state: SilenceState }
  | {
      readonly granted: false;
      readonly state: SilenceState;
      readonly reason: 'already_extended' | 'too_late';
    };

// 「ちょっと待って」「少し待って」を受けたとき（SessionControlPhrases の extend_silence）。1 回だけ 60 秒に延ばす。
// - 無音を数え始めていれば、その区間を 60 秒にする（発話の終わりの直後に文字起こしが届く場合）。
// - まだ数え始めていなければ（本人が話している最中）、次の区間を 60 秒にする。
// - すでに延びている・延ばす予約がある間は重ねない（何度言っても 60 秒のまま）。
// - 猶予をすでに使い切っていれば（閉じる判定の後）延ばせない。
export function grantSilenceExtension(
  state: SilenceState,
  now_ms: number,
): SilenceExtension {
  if (state.extension_active || state.extension_pending)
    return { granted: false, state, reason: 'already_extended' };
  if (state.quiet_since_ms === null)
    return { granted: true, state: { ...state, extension_pending: true } };
  if (now_ms - state.quiet_since_ms >= silenceTimeoutMs(state))
    return { granted: false, state, reason: 'too_late' };
  return { granted: true, state: { ...state, extension_active: true } };
}
