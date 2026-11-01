// Live の文字起こしから委譲の入力を確定する規則（B05-05、ADR 0052。設計 10 §5・§5A、09 X51・QA05・QA41）。
// 文字起こしの断片を発話（ターン）ごとにため、委譲の対象のターンを 1 つに決め、方式 C の観測の条件を作り、
// 入力の受付（admitInputKind）と方式 C の限定（admitMethodC）を 1 つの判定にまとめる。時計は呼び出し側が渡す。
// ここで ready（proceed）になっても実行の許可ではない（readiness.ts と 08 の最終検査が別に決める）。
// 断片の欠落・時刻の対応・対象のターンが分からないときは、変更を進めず聞き返す側へ倒す。

import type { IntentName } from './intents.js';
import {
  admitMethodC,
  type MethodCAdmission,
  type MethodCFacts,
} from './voice-input.js';
import { admitInputKind, type InputCondition } from './voice.js';

// 委譲の対象のターンを探す窓（ms）。委譲の offset の手前この範囲に重なるターンを候補にする。原本に決めなし（U102）。
export const LIVE_DELEGATION_WINDOW_MS = 2000;
// 入力の確定を待つ上限（ms）。超えたら変更を進めずに聞き返す。原本に決めなし（U102）。
export const LIVE_INPUT_WAIT_MS = 5000;

export interface LiveFragment {
  // provider の断片の連番（0 から。欠落を見つけるため）。連番を持たない provider は null（欠落を確かめられない）。
  readonly index: number | null;
  readonly start_ms: number | null;
  readonly end_ms: number | null;
  readonly text: string;
}

export interface LiveTurn {
  // Core が付ける 1 から始まる連番（turn_id は発言として保存するときに別に作る）。
  readonly ordinal: number;
  readonly fragments: readonly LiveFragment[];
  // 発話の開始を観測した（なければターンの境界が分からない）。
  readonly speech_observed: boolean;
  // 発話終了候補（端末の VAD。無音 0.8 秒）を観測した。
  readonly end_candidate: boolean;
  // 最後の断片が届いた中枢の単調時計（断片がなければ null）。
  readonly last_fragment_mono_ms: number | null;
  // 既知の断片の欠落・重複の矛盾（連番の飛び・同じ連番で違う内容）。
  readonly gap: boolean;
  // 時刻の対応を確かめられない（連番・開始・終了がない・逆行している）。
  readonly mapping_unverified: boolean;
}

export interface LiveTranscript {
  readonly turns: readonly LiveTurn[];
  // 受け取った最後の断片の連番（なければ null）。
  readonly last_index: number | null;
}

export const EMPTY_LIVE_TRANSCRIPT: LiveTranscript = {
  turns: [],
  last_index: null,
};

const newTurn = (ordinal: number, speech_observed: boolean): LiveTurn => ({
  ordinal,
  fragments: [],
  speech_observed,
  end_candidate: false,
  last_fragment_mono_ms: null,
  gap: false,
  mapping_unverified: false,
});

const replaceLast = (
  transcript: LiveTranscript,
  turn: LiveTurn,
  last_index: number | null = transcript.last_index,
): LiveTranscript => ({
  turns: [...transcript.turns.slice(0, -1), turn],
  last_index,
});

// 新しい本人の発話の開始。直前のターンが終了候補を観測していれば新しいターン、まだ終わっていなければ同じターンの続き
// （発話の継続。終了候補は取り消す）。
export function observeSpeechStart(transcript: LiveTranscript): LiveTranscript {
  const last = transcript.turns.at(-1);
  if (last === undefined || last.end_candidate)
    return {
      ...transcript,
      turns: [...transcript.turns, newTurn((last?.ordinal ?? 0) + 1, true)],
    };
  return replaceLast(transcript, {
    ...last,
    speech_observed: true,
    end_candidate: false,
  });
}

// 発話終了候補。ターンがなければ何もしない（観測の欠け）。
export function observeEndCandidate(
  transcript: LiveTranscript,
): LiveTranscript {
  const last = transcript.turns.at(-1);
  if (last === undefined) return transcript;
  return replaceLast(transcript, { ...last, end_candidate: true });
}

const validTime = (value: number | null): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// 文字起こしの断片。連番の飛び・同じ連番で違う内容・戻った連番は既知の欠落（gap）。同じ連番で同じ内容の再配送は
// 冪等に無視する。時刻（start_ms・end_ms）が欠けている・逆行している・連番がないときは、時刻の対応を確かめられない。
// 発話の開始を観測する前の断片は、境界の分からないターンへ入れる（speech_observed が false のまま）。
export function observeFragment(
  transcript: LiveTranscript,
  fragment: LiveFragment,
  now_mono_ms: number,
): LiveTranscript {
  let base = transcript;
  let last = base.turns.at(-1);
  if (last === undefined) {
    last = newTurn(1, false);
    base = { turns: [last], last_index: base.last_index };
  }
  // 終了候補の後に届いた断片は、遅れて届いた同じ発話の続き（認識の遅れ）として、最新のターンへ入れる。
  const turn = last;
  const index = fragment.index;
  let gap = turn.gap;
  let unverified = turn.mapping_unverified;
  let lastIndex = base.last_index;
  if (index === null || !Number.isSafeInteger(index) || index < 0)
    unverified = true;
  else if (lastIndex !== null && index <= lastIndex) {
    const same = turn.fragments.find((entry) => entry.index === index);
    if (
      same !== undefined &&
      same.text === fragment.text &&
      same.start_ms === fragment.start_ms &&
      same.end_ms === fragment.end_ms
    )
      return base;
    gap = true;
  } else {
    if (lastIndex !== null && index !== lastIndex + 1) gap = true;
    if (lastIndex === null && index !== 0) gap = true;
    lastIndex = index;
  }
  if (
    !validTime(fragment.start_ms) ||
    !validTime(fragment.end_ms) ||
    fragment.end_ms < fragment.start_ms
  )
    unverified = true;
  else {
    // 時刻は前へ戻らない（同じターンの前の断片・前のターンの断片より前から始まる断片は、別の発話の遅れた断片を
    // 取り違えているかもしれないので、対応を確かめられない側へ倒す）。
    const ends = base.turns
      .flatMap((entry) => entry.fragments)
      .map((entry) => entry.end_ms)
      .filter(validTime);
    if (ends.length > 0 && fragment.start_ms < Math.max(...ends))
      unverified = true;
  }
  const clock = Number.isFinite(now_mono_ms) ? now_mono_ms : null;
  return replaceLast(
    base,
    {
      ...turn,
      fragments: [...turn.fragments, fragment],
      last_fragment_mono_ms: clock,
      gap,
      mapping_unverified: unverified || clock === null,
    },
    lastIndex,
  );
}

// ターンの文字（断片を連番の順につなぐ。連番がない断片は届いた順）。
export function turnText(turn: LiveTurn): string {
  const ordered = turn.fragments
    .map((fragment, position) => ({ fragment, position }))
    .sort(
      (a, b) =>
        (a.fragment.index ?? a.position) - (b.fragment.index ?? b.position),
    );
  return ordered.map((entry) => entry.fragment.text).join('');
}

export interface DelegationTarget {
  // 候補のターンの数（1 でなければ対象が一意でない）。
  readonly count: number;
  readonly turn: LiveTurn | null;
}

// 委譲の対象のターン。offset（Live の音声内の時刻）の手前、窓の範囲に時間が重なるターンを候補にする。終わりの時刻が
// 分からないターン（まだ断片が届いていない）は、offset まで続いているものとして重ねる。offset が分からなければ
// 候補は 0（時刻の対応を確かめられない）。ちょうど 1 つのときだけ turn を返す。claimed は、先の委譲がすでに対象にした
// ターン（会話の操作に使ったターンは含めない）の連番で、候補から外す（先の依頼の処理中に始まった訂正の発話が、先の
// 発話と並んで「対象が複数」にならない。どの委譲にも使われていない発話が窓の中に複数あれば、対象が複数のまま）。
export function resolveDelegationTarget(
  transcript: LiveTranscript,
  offset_ms: number | null,
  claimed: ReadonlySet<number> | readonly number[] = [],
): DelegationTarget {
  if (!validTime(offset_ms)) return { count: 0, turn: null };
  const taken = new Set(claimed);
  const from = offset_ms - LIVE_DELEGATION_WINDOW_MS;
  const candidates = transcript.turns.filter((turn) => {
    if (taken.has(turn.ordinal)) return false;
    const starts = turn.fragments
      .map((fragment) => fragment.start_ms)
      .filter(validTime);
    const ends = turn.fragments
      .map((fragment) => fragment.end_ms)
      .filter(validTime);
    // 断片がまだないターンは、発話の開始だけを観測した最新のターン（まだ文字が届いていない）。
    if (starts.length === 0) return turn === transcript.turns.at(-1);
    const start = Math.min(...starts);
    const end = ends.length === 0 ? Infinity : Math.max(...ends);
    return start <= offset_ms && end >= from;
  });
  return {
    count: candidates.length,
    turn: candidates.length === 1 ? (candidates[0] as LiveTurn) : null,
  };
}

// 方式 C の観測の事実のうち、文字起こしから決まるもの（残りの事実は呼び出し側が渡す）。
export type LiveTranscriptFacts = Pick<
  MethodCFacts,
  | 'end_candidate_observed'
  | 'target_range_mapped'
  | 'stable_ms'
  | 'known_fragment_gap'
  | 'target_turn_unique'
>;

// 文字起こしの観測。最後の断片からの変化のない時間は、発話終了候補を観測した後だけ数える。時計が戻ったときは 0
// （経過を数えられない）。時刻の対応は、ターンに断片があり、境界（発話の開始）を観測でき、時刻・連番を確かめられたときだけ。
export function liveTranscriptFacts(
  target: DelegationTarget,
  now_mono_ms: number,
): LiveTranscriptFacts {
  const turn = target.turn;
  if (turn === null)
    return {
      end_candidate_observed: false,
      target_range_mapped: false,
      stable_ms: 0,
      known_fragment_gap: false,
      target_turn_unique: false,
    };
  const stable =
    turn.end_candidate &&
    turn.last_fragment_mono_ms !== null &&
    Number.isFinite(now_mono_ms) &&
    now_mono_ms >= turn.last_fragment_mono_ms
      ? now_mono_ms - turn.last_fragment_mono_ms
      : 0;
  return {
    end_candidate_observed: turn.end_candidate,
    target_range_mapped:
      turn.fragments.length > 0 &&
      turn.speech_observed &&
      !turn.mapping_unverified,
    stable_ms: stable,
    known_fragment_gap: turn.gap,
    target_turn_unique: target.count === 1,
  };
}

export interface LiveInputRequest {
  readonly intent: IntentName;
  readonly transcript: LiveTranscriptFacts;
  // 入力の受付の条件（voice_live の条件。渡さなかった条件は満たされていないものとして扱う）。
  readonly conditions: Readonly<Partial<Record<InputCondition, boolean>>>;
  readonly unresolved_correction: boolean;
  readonly missing_args: boolean;
  // 新しい本人の発話の開始による保留中（10 §5A-3）。
  readonly utterance_hold: boolean;
  readonly policy_version: string | null;
  readonly own_event_only: boolean;
}

export type LiveInputDecision =
  // 入力の条件を満たさない: 何も処理しない（声で返さない・変更も作らない）。
  | {
      readonly decision: 'reject';
      readonly reasons: readonly string[];
    }
  // 参照と聞き返しは、確定前でも進めてよい。
  | { readonly decision: 'read' }
  // 4 操作の変更。実行の許可ではなく、共通の workflow へ進める資格（入力は方式 C の暫定入力として記録する）。
  | {
      readonly decision: 'proceed';
      readonly operation: Extract<
        MethodCAdmission,
        { decision: 'proceed' }
      >['operation'];
      readonly input_evidence: 'live_policy_observed';
      readonly seal_reason: 'live_transcript_policy';
    }
  // 観測の条件が欠けた（欠落・時刻の対応・対象・安定・訂正・引数・保留）。変更を始めず、言い直してもらう。
  | {
      readonly decision: 'ask_again';
      readonly reasons: readonly string[];
      // 確定の待ちを続けてよいか（安定・終了候補など、時間が解決するもの）。欠落・対応不明は待たない。
      readonly wait: boolean;
    }
  // 4 操作でない変更（画面承認が要る操作・記憶の保存・表示先の移動・他の参加者がいる予定）。全文を確定してから。
  | {
      readonly decision: 'full_text_required';
      readonly reasons: readonly string[];
    };

// 時間で解決するもの（待てば満たされるかもしれない）。それ以外の欠け（欠落・対応不明・対象が複数・未解決の訂正・
// 引数の不足・方針の版）は、待っても満たされないので聞き返す。
const WAITABLE: readonly string[] = [
  'end_candidate_missing',
  'not_stable',
  'utterance_hold',
];

// Live の文字起こしから進めてよいか。入力の受付（admitInputKind）を先に見て、条件を満たさなければ何も進めない。
// 次に方式 C の限定（admitMethodC）。参照は条件なしで可、変更は観測の条件がすべて成立し 4 操作に当たるときだけ proceed。
export function admitLiveInput(request: LiveInputRequest): LiveInputDecision {
  const admission = admitInputKind(
    'voice_live',
    'sideband_transcript',
    request.conditions,
  );
  if (admission.decision === 'reject')
    return { decision: 'reject', reasons: admission.missing };
  const result = admitMethodC(request.intent, {
    ...request.transcript,
    unresolved_correction: request.unresolved_correction,
    missing_args: request.missing_args,
    utterance_hold: request.utterance_hold,
    policy_version: request.policy_version,
    own_event_only: request.own_event_only,
  });
  switch (result.decision) {
    case 'read_allowed':
      return { decision: 'read' };
    case 'proceed':
      return {
        decision: 'proceed',
        operation: result.operation,
        input_evidence: result.input_evidence,
        seal_reason: result.seal_reason,
      };
    case 'requires_full_text':
      return { decision: 'full_text_required', reasons: result.reasons };
    case 'blocked':
      return {
        decision: 'ask_again',
        reasons: result.reasons,
        wait: result.reasons.every((reason) => WAITABLE.includes(reason)),
      };
  }
}
