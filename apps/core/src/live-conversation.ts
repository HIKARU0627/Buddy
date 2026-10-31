// Live（声）の会話の処理（B05-05、ADR 0052。設計 10 §1A・§5・§5A・§6・§6A、07 §5、09 X27・X47・X49・X51・X58、QA05・QA35・QA41）。
//
// サイドバンドで受けた Live の文字起こし・発話の開始と終了候補・委譲（session.delegation.created。依頼の文字を含まない）から、
// 次を行う。
// - 文字起こしの断片を発話（ターン）ごとにため、委譲の対象のターンを 1 つに決める。欠落・時刻の対応が確かめられない・
//   対象が複数のときは、変更を進めず聞き返す（domain の voice-live-input.ts）。
// - 会話の操作（照合表に全体が一致した短い発話）は、LLM を呼ばず、依頼も作らずに接続の操作だけを行う（X58）。
// - それ以外は、解釈（差し込み口。副作用なし）→ 入力の受付と方式 C の限定（4 操作だけ。記憶の保存・画面承認の操作は全文が
//   確定するまで進めない）→ 共通の workflow（api-turns の commitLive。意図表・意味検証・readiness・承認待ちの操作）へ進める。
// - 新しい本人の発話の開始で、送出前の変更を一時保留する。訂正・別件・取消が一つの対象に確定したときだけ扱いを決め、
//   確定しなければ保留のまま聞き返す（勝手に再開しない）。保存の直前にも保留を再検査する（precommit）。
// - 結果の届け先は入力のときに固定した出力先と、今の世代から決める。声で返せない結果（接続が閉じた・文字へ切り替えた・
//   世代が違う・サイドバンドがない）は画面へ回し、失効した旧版だけ捨てる。文字の依頼（HTTP の発言）はここを通らず、
//   音声の接続が開いていても声には流れない。
// 実際の音声・実 API は使わない（模擬のサイドバンドの出来事で動かす）。時計・タイマーは注入する。

import { createHash, randomUUID } from 'node:crypto';
import type { DelegationResult, TurnResponse } from '@buddy/contracts';
import {
  EMPTY_HOLD,
  EMPTY_LIVE_TRANSCRIPT,
  HOLD_MAX_MS,
  LIVE_INPUT_WAIT_MS,
  SESSION_CONTROL_TABLE,
  admitLiveInput,
  fixOutputTarget,
  inputCommentary,
  isHeld,
  liveTranscriptFacts,
  observeEndCandidate,
  observeFragment,
  observeSpeechStart,
  resolveDelegationTarget,
  resolveHold,
  resolveSessionControl,
  resultCommentary,
  routeResultDelivery,
  startUtteranceHold,
  turnText,
  METHOD_C_STABLE_MS,
  INTENT_POLICIES,
} from '@buddy/domain';
import type {
  Commentary,
  DeviceEpochs,
  HoldEntry,
  HoldState,
  HoldTarget,
  InputCondition,
  IntentName,
  LiveFragment,
  LiveTranscript,
  OutputTargetValue,
  SessionControlAction,
} from '@buddy/domain';
import type { ApiContract } from './api-contract.js';
import { createApiContract } from './api-contract.js';
import type {
  InterpretedTurn,
  LiveCommitInput,
  LiveCommitResult,
} from './api-turns.js';
import type { VoiceTimers } from './voice-control.js';

// 方式 C の暫定方針の版（live_transcript_policy には必須。契約の PolicyVersion は先頭ゼロのない整数の文字列）。
export const LIVE_POLICY_VERSION = '1';
// 委譲の入力の確定を待つ間の見直しの間隔（ms）。
export const LIVE_INPUT_POLL_MS = 100;
// 追う依頼の数の上限（終わった依頼は捨てる。committed は直近の ID だけ覚える）。
const COMMITTED_KEPT = 16;
const SEEN_DELEGATIONS_KEPT = 64;

// Live を指す値（VoiceControl が作る）。
export interface LiveHandle {
  readonly live_session_id: string;
  readonly device_id: string;
  readonly session_id: string | null;
  readonly audio_epoch: string;
  readonly session_epoch: string;
  readonly command_scope_id: string;
}

// VoiceControl が LiveConversation に渡す口（Live の状態と、声への出力・接続の操作）。
export interface LiveConversationHost {
  // voice_live の入力の受付の条件（admitInputKind）。同意は外部の値なので非同期。
  conditions(
    liveSessionId: string,
  ): Promise<Readonly<Partial<Record<InputCondition, boolean>>>>;
  // 結果の届け先の判定に使う、Live と端末の今の状態。Live が開いていなければ open は false。
  delivery(liveSessionId: string): {
    readonly open: boolean;
    readonly epochs: DeviceEpochs | null;
  };
  // サイドバンドへ結果の追記（commentary）を送る。送れなければ false（接続がない・閉じ始めた）。
  appendCommentary(liveSessionId: string, parts: readonly string[]): boolean;
  // 会話の操作を、この Live の接続へ行う（再生停止・閉じる・無音の延長）。
  applySessionControl(
    liveSessionId: string,
    action: SessionControlAction,
  ): void;
}

// 画面へ回す結果（声で返せなかった結果）。画面のキャンバス・会話へ出す。
export interface ScreenResult {
  readonly reason: string;
  readonly session_id: string;
  readonly turn: TurnResponse;
}

export interface ScreenResultSink {
  show(result: ScreenResult): void;
  // 保留していた変更を実行せずに捨てた（上限・Live の終了・時計の異常。勝手に再開しない）。
  heldDropped(info: {
    readonly session_id: string;
    readonly workflow_id: string;
    readonly reason: string;
  }): void;
}

// 製品の起動（core.ts）が使う画面への届け方。声で返せなかった結果は、発言の結果と同じ配置者の規則でキャンバスへ置く。
// 今の配置者が置けるのは予定のカードだけで、聞き返し・全文の確定の案内のような文字の結果と、保留を捨てた知らせを載せる
// 表示の部品・経路はまだない（ADR 0052、contract-map U120）。置けなかったことは、結果の中身を含めずに理由だけをログに残す。
export function createLiveScreenSink(options: {
  readonly placeLate: (turn: TurnResponse) => unknown;
  readonly log: (message: string) => void;
}): ScreenResultSink {
  return {
    show: (result) => {
      options.placeLate(result.turn);
      if (result.turn.result_view?.kind !== 'schedule_cards')
        options.log(`live_screen_text_not_shown:${result.reason}`);
    },
    heldDropped: (info) => options.log(`live_held_dropped:${info.reason}`),
  };
}

export interface LiveConversationTurns {
  interpret(text: string): Promise<InterpretedTurn>;
  commitLive(input: LiveCommitInput): Promise<LiveCommitResult>;
}

export interface LiveConversationOptions {
  readonly host: LiveConversationHost;
  readonly turns: LiveConversationTurns;
  readonly screen: ScreenResultSink;
  // 中枢の単調時計（ms）。
  readonly monoNow: () => number;
  readonly timers: VoiceTimers;
  readonly contract?: ApiContract;
  readonly newId?: () => string;
  readonly policyVersion?: string;
  readonly log?: (message: string) => void;
}

// VoiceControl が呼ぶ口。
export interface LiveConversationPort {
  opened(live: LiveHandle): void;
  closed(live: LiveHandle): void;
  fragment(live: LiveHandle, fragment: LiveFragment): void;
  speechStarted(live: LiveHandle): void;
  endCandidate(live: LiveHandle): void;
  delegation(
    live: LiveHandle,
    delegation: {
      readonly delegation_id: string;
      readonly offset_ms: number | null;
    },
  ): void;
  // 読み上げを止めた（Live の発話・文字の発言・画面の操作のどれから来ても、中枢が再生の停止を出したとき）。
  // 停止より前に受けた依頼の結果を、停止の後に声へ載せない（画面へ回す）。
  playbackStopped(live: LiveHandle): void;
}

// committing: 保存の準備中（まだ命令を送っていない。保留・破棄の対象）。
// dispatched: 保存の命令を DB へ送信済み（応答待ち。保留・破棄の対象にしない）。
type Phase =
  | 'waiting_input'
  | 'interpreting'
  | 'held'
  | 'committing'
  | 'dispatched'
  | 'done';

// 失効した依頼の終端状態。保留の破棄（上限・時計の異常・Live の終了）・訂正・取消のどれかで失効した依頼は、遅い非同期処理
// （解釈・保存の準備）が後から戻っても続けない。復帰のたびと保存の直前（precommit）に検査し、保存・声・画面のどこにも出さない。
type Terminal = 'dropped' | 'superseded' | 'cancelled';

interface Pending {
  readonly workflow_id: string;
  readonly delegation_id: string;
  readonly offset_ms: number | null;
  readonly accepted_at: number;
  readonly output: OutputTargetValue;
  readonly audio_epoch: string;
  // 入力のときの出力の世代（読み上げの停止の前に受けた依頼の結果は、停止の後に声にしない）。
  readonly output_gen: number;
  readonly conditions: Readonly<Partial<Record<InputCondition, boolean>>>;
  phase: Phase;
  timer: unknown;
  target_ordinal: number | null;
  // 対象のターンを決めたときの候補の数（解釈の間に新しい発話が始まっても、決めた対象を変えない）。
  target_count: number;
  text: string | null;
  interpreted: InterpretedTurn | null;
  decision: 'proceed' | 'read' | null;
  is_change: boolean | null;
  // 訂正・取消で失効した旧版は結果を読み上げず、画面にも出さない。
  revision_current: boolean;
  // 失効したら理由を持つ（null は生きている依頼）。一度入れたら戻さない。
  terminal: Terminal | null;
}

interface Context {
  readonly handle: LiveHandle;
  transcript: LiveTranscript;
  pending: Map<string, Pending>;
  hold: HoldState;
  committed: string[];
  delegations: string[];
  // 会話の操作として使った発話（この発話の委譲は依頼にしない）。
  controlled: Set<number>;
  // 先の委譲がすでに対象にした発話（次の委譲の対象の候補から外す。処理中に始まった訂正の発話が、先の発話と並んで
  // 「対象が複数」にならない）。
  claimed: Set<number>;
  checked: Set<number>;
  controlTimer: unknown;
  // 保留の上限を見る timer（保留が残っている間だけ）。
  holdTimer: unknown;
  output_gen: number;
  closed: boolean;
}

// 決まった値から UUID v4 の形の ID を作る（同じ委譲の再送が同じ request_id になる）。
function derivedId(...parts: readonly string[]): string {
  const bytes = createHash('sha256')
    .update(parts.join('\0'), 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const HOLD_ASK_BACK: Commentary = {
  template_id: 'clarify.fixed',
  template_version: '1',
  facts: [
    {
      kind: 'clarification',
      ref_id: null,
      title: null,
      start: null,
      end: null,
      due: null,
      count: null,
    },
  ],
  commentary_parts: [
    'どの依頼のことか分かりませんでした。もう一度言ってください。',
  ],
};

const HOLD_CANCELLED: Commentary = {
  template_id: 'clarify.fixed',
  template_version: '1',
  facts: HOLD_ASK_BACK.facts,
  commentary_parts: ['実行前の依頼を取り消しました。'],
};

export class LiveConversation implements LiveConversationPort {
  readonly #options: LiveConversationOptions;
  readonly #contract: ApiContract;
  readonly #contexts = new Map<string, Context>();
  readonly #policyVersion: string;
  readonly #newId: () => string;

  constructor(options: LiveConversationOptions) {
    this.#options = options;
    this.#contract = options.contract ?? createApiContract();
    this.#policyVersion = options.policyVersion ?? LIVE_POLICY_VERSION;
    this.#newId = options.newId ?? randomUUID;
  }

  #log(message: string): void {
    this.#options.log?.(message);
  }

  // 試験用: 追っている依頼の数と保留の数。
  get pendingCount(): number {
    let count = 0;
    for (const context of this.#contexts.values())
      for (const entry of context.pending.values())
        if (entry.phase !== 'done') count += 1;
    return count;
  }

  heldCount(liveSessionId: string): number {
    return this.#contexts.get(liveSessionId)?.hold.entries.length ?? 0;
  }

  // ---- VoiceControl からの出来事 ---------------------------------------------------------------------------

  opened(live: LiveHandle): void {
    if (this.#contexts.has(live.live_session_id)) return;
    this.#contexts.set(live.live_session_id, {
      handle: live,
      transcript: EMPTY_LIVE_TRANSCRIPT,
      pending: new Map(),
      hold: EMPTY_HOLD,
      committed: [],
      delegations: [],
      controlled: new Set(),
      claimed: new Set(),
      checked: new Set(),
      controlTimer: null,
      holdTimer: null,
      output_gen: 0,
      closed: false,
    });
  }

  // Live が閉じた・失われた。まだ解釈に入っていない依頼は捨て、保存の途中のものは続けて結果を画面へ回す。
  // 保留中の変更は、対象を確定できないので実行せずに捨てる（勝手に再開しない）。
  closed(live: LiveHandle): void {
    const context = this.#contexts.get(live.live_session_id);
    if (context === undefined || context.closed) return;
    context.closed = true;
    if (context.controlTimer !== null)
      this.#options.timers.clear(context.controlTimer);
    context.controlTimer = null;
    if (context.holdTimer !== null)
      this.#options.timers.clear(context.holdTimer);
    context.holdTimer = null;
    // 保留の集合にある依頼は、解釈中・保存の準備中でも失効させる（遅れて戻っても保存しない）。保留されていない依頼は続ける。
    const heldIds = new Set(context.hold.entries.map((e) => e.workflow_id));
    for (const entry of [...context.pending.values()]) {
      // 保存の命令を送信済みの依頼は、応答を待って保存結果をそのまま扱う（破棄しない）。
      if (entry.phase === 'dispatched') continue;
      if (entry.phase === 'waiting_input' && !heldIds.has(entry.workflow_id))
        this.#finish(context, entry);
      else if (entry.phase === 'held' || heldIds.has(entry.workflow_id)) {
        this.#dropHeld(context, entry, 'live_closed');
      }
    }
    context.hold = EMPTY_HOLD;
    // 終わった Live の記録は、保存の途中の依頼が片づいた後に外す。
    this.#sweep(context);
  }

  fragment(live: LiveHandle, fragment: LiveFragment): void {
    const context = this.#contexts.get(live.live_session_id);
    if (context === undefined || context.closed) return;
    context.transcript = observeFragment(
      context.transcript,
      fragment,
      this.#options.monoNow(),
    );
    this.#armControl(context);
  }

  speechStarted(live: LiveHandle): void {
    const context = this.#contexts.get(live.live_session_id);
    if (context === undefined || context.closed) return;
    context.transcript = observeSpeechStart(context.transcript);
    // 送出前の変更を一時保留する。解釈の前の依頼は変更かどうか分からないので変更として保留する（参照と分かれば、
    // 保存のときに保留は掛けない）。
    const inFlight = [...context.pending.values()]
      .filter((entry) => entry.phase !== 'done' && entry.phase !== 'dispatched')
      .map((entry) => ({
        workflow_id: entry.workflow_id,
        request_revision: '1',
        phase: 'pre_dispatch' as const,
        is_change: entry.is_change ?? true,
      }));
    const next = startUtteranceHold(
      context.hold,
      inFlight,
      this.#options.monoNow(),
    );
    if (next === null) {
      // 時計を読めない: 保留の時刻を数えられないので、進めずに捨てる（実行しない側）。
      for (const entry of context.pending.values())
        if (entry.phase !== 'done' && (entry.is_change ?? true))
          this.#dropHeld(context, entry, 'clock_unusable');
      return;
    }
    context.hold = next;
    // 保存の途中（解釈済み・保存の命令の前）の依頼は、precommit が保留を見て保存を止める。
    this.#armHold(context);
  }

  // 保留の上限（HOLD_MAX_MS）を過ぎた変更は、実行せずに捨てる（新しい発話が依頼にならず、関係が確定しないまま残る場合）。
  #armHold(context: Context): void {
    if (context.holdTimer !== null)
      this.#options.timers.clear(context.holdTimer);
    context.holdTimer = null;
    if (context.closed || context.hold.entries.length === 0) return;
    // 期限は最も早い保留の開始から数える（後の発話で保留が増えても、先の保留の期限を延ばさない）。
    const earliest = Math.min(
      ...context.hold.entries.map((entry) => entry.held_at_mono_ms),
    );
    const wait = Math.max(
      0,
      earliest + HOLD_MAX_MS + 1 - this.#options.monoNow(),
    );
    context.holdTimer = this.#options.timers.set(wait, () => {
      context.holdTimer = null;
      if (context.closed) return;
      // 関係が分からないものとして解く。上限を過ぎたものだけが expire になり、残りは保留のまま（聞き返しは出さない）。
      const result = resolveHold(
        context.hold,
        { relation: 'unknown', targets: [] },
        this.#options.monoNow(),
      );
      const expired = new Set(
        result.decisions
          .filter((decision) => decision.action === 'expire')
          .map((decision) => decision.workflow_id),
      );
      context.hold = result.state;
      for (const id of expired) {
        const entry = context.pending.get(id);
        if (entry !== undefined) this.#dropHeld(context, entry, 'hold_expired');
      }
      this.#armHold(context);
    });
  }

  endCandidate(live: LiveHandle): void {
    const context = this.#contexts.get(live.live_session_id);
    if (context === undefined || context.closed) return;
    context.transcript = observeEndCandidate(context.transcript);
    this.#armControl(context);
  }

  playbackStopped(live: LiveHandle): void {
    const context = this.#contexts.get(live.live_session_id);
    if (context === undefined || context.closed) return;
    context.output_gen += 1;
  }

  delegation(
    live: LiveHandle,
    delegation: {
      readonly delegation_id: string;
      readonly offset_ms: number | null;
    },
  ): void {
    const context = this.#contexts.get(live.live_session_id);
    if (context === undefined || context.closed) return;
    // 同じ委譲の再送は 1 回だけ扱う。
    if (context.delegations.includes(delegation.delegation_id)) return;
    context.delegations.push(delegation.delegation_id);
    while (context.delegations.length > SEEN_DELEGATIONS_KEPT)
      context.delegations.shift();
    const sessionId = live.session_id;
    if (sessionId === null) {
      this.#log('live_delegation_without_session');
      return;
    }
    void this.#accept(context, delegation, sessionId).catch(() =>
      this.#log('live_delegation_failed'),
    );
  }

  // ---- 委譲の受付 ---------------------------------------------------------------------------------------

  async #accept(
    context: Context,
    delegation: {
      readonly delegation_id: string;
      readonly offset_ms: number | null;
    },
    sessionId: string,
  ): Promise<void> {
    // 出力の世代は、最初の await の前（委譲を受けた時点）で固定する。条件の照会（同意の非同期の確認）を待つ間に
    // 読み上げの停止が来ても、停止の前に受けた依頼として扱い、結果を停止の後の世代の声に載せない。
    const outputGen = context.output_gen;
    const conditions = await this.#options.host.conditions(
      context.handle.live_session_id,
    );
    // 受付の条件（入力の種類 voice_live。返し方が文字・Live が使えない・同意がない・予算がないなど）。満たさなければ
    // 何も処理しない（声で返さず、変更も作らない）。
    const admission = admitLiveInput({
      intent: 'unclear',
      transcript: {
        end_candidate_observed: true,
        target_range_mapped: true,
        stable_ms: METHOD_C_STABLE_MS,
        known_fragment_gap: false,
        target_turn_unique: true,
      },
      conditions,
      unresolved_correction: false,
      missing_args: false,
      utterance_hold: false,
      policy_version: this.#policyVersion,
      own_event_only: false,
    });
    if (admission.decision === 'reject') {
      this.#log(`live_input_rejected:${admission.reasons.join('+')}`);
      return;
    }
    if (context.closed) return;
    const pending: Pending = {
      workflow_id: this.#newId(),
      delegation_id: delegation.delegation_id,
      offset_ms: delegation.offset_ms,
      accepted_at: this.#options.monoNow(),
      output: fixOutputTarget({
        input_kind: 'voice_live',
        device_id: context.handle.device_id,
        session_epoch: context.handle.session_epoch,
      }),
      audio_epoch: context.handle.audio_epoch,
      output_gen: outputGen,
      conditions,
      phase: 'waiting_input',
      timer: null,
      target_ordinal: null,
      target_count: 0,
      text: null,
      interpreted: null,
      decision: null,
      is_change: null,
      revision_current: true,
      terminal: null,
    };
    context.pending.set(pending.workflow_id, pending);
    // 会話の操作として使われた発話・保留の開始は、見直しの中で扱う。
    this.#await(context, pending, sessionId);
  }

  // 入力の確定を待つ。終了候補・断片の安定（300 ms）・時刻の対応・対象が 1 つ、がそろったら解釈へ進む。時間で
  // 解決しない欠け（欠落・対応不明・対象が複数）は待たず、待っても上限（5 秒）で、そのまま解釈へ進む（参照だけ進められ、
  // 変更は聞き返しになる）。時間の経過だけでは確定にしない。
  #await(context: Context, pending: Pending, sessionId: string): void {
    pending.timer = null;
    if (pending.phase !== 'waiting_input' || context.closed) return;
    const now = this.#options.monoNow();
    const target = resolveDelegationTarget(
      context.transcript,
      pending.offset_ms,
      context.claimed,
    );
    const facts = liveTranscriptFacts(target, now);
    pending.target_ordinal = target.turn?.ordinal ?? null;
    pending.target_count = target.count;
    if (
      pending.target_ordinal !== null &&
      context.controlled.has(pending.target_ordinal)
    ) {
      // 会話の操作として使った発話は依頼にしない。
      this.#finish(context, pending);
      return;
    }
    const turn = target.turn;
    const ready =
      turn !== null &&
      turn.fragments.length > 0 &&
      facts.end_candidate_observed &&
      facts.stable_ms >= METHOD_C_STABLE_MS &&
      facts.target_range_mapped &&
      !facts.known_fragment_gap;
    // 待っても改善しないもの: 対象を 1 つに決められない・断片の欠落・時刻の対応を確かめられない・offset が不明。
    const hopeless =
      pending.offset_ms === null ||
      (turn === null && target.count > 1) ||
      (turn !== null &&
        (turn.gap || turn.mapping_unverified || !turn.speech_observed));
    const expired = !(now - pending.accepted_at < LIVE_INPUT_WAIT_MS);
    // 確定した発話が会話の操作の言い回しなら、解釈に回さず、操作として扱う（見直しと照合の timer の順に左右されない）。
    if (ready && turn !== null) {
      this.#checkControl(context, turn.ordinal);
      if (context.controlled.has(turn.ordinal)) {
        this.#finish(context, pending);
        return;
      }
    }
    if (ready || hopeless || expired || now < pending.accepted_at) {
      void this.#interpret(context, pending, sessionId, turn).catch(() => {
        this.#log('live_interpret_failed');
        this.#finish(context, pending);
      });
      return;
    }
    pending.timer = this.#options.timers.set(LIVE_INPUT_POLL_MS, () =>
      this.#await(context, pending, sessionId),
    );
  }

  async #interpret(
    context: Context,
    pending: Pending,
    sessionId: string,
    turn: ReturnType<typeof resolveDelegationTarget>['turn'],
  ): Promise<void> {
    pending.phase = 'interpreting';
    const text = turn === null ? '' : turnText(turn);
    pending.text = text;
    // この発話は、この委譲が対象にした（次の委譲の候補から外す）。
    if (turn !== null) context.claimed.add(turn.ordinal);
    if (text.length === 0) {
      // 文字がない（対象が決まらない・まだ断片がない）: 発言として残せないので、解釈も保存もせず、声で言い直しを頼む。
      this.#sayOnly(context, pending, inputCommentary('say_again'));
      return;
    }
    let interpreted: InterpretedTurn;
    try {
      interpreted = await this.#options.turns.interpret(text);
    } catch {
      interpreted = { kind: 'plan', plan: this.#unclearPlan() };
    }
    // 解釈を待つ間に失効した依頼は、結果が戻っても続けない（保存も聞き返しもしない）。
    if (pending.terminal !== null) return;
    pending.interpreted = interpreted;
    pending.is_change =
      interpreted.kind === 'intent'
        ? INTENT_POLICIES[interpreted.intent].route !== 'read'
        : interpreted.plan.kind === 'clarify' &&
            interpreted.plan.intent !== null
          ? INTENT_POLICIES[interpreted.plan.intent].route !== 'read'
          : false;
    // 参照・聞き返しは保留しない（解釈の前は変更かどうか分からないので保留に入れていた。参照と分かったら外す。外さないと、
    // 参照の依頼が「保留中の変更」として、次の発話の関係の解決を聞き返しにしてしまう）。
    if (!pending.is_change)
      context.hold = {
        entries: context.hold.entries.filter(
          (entry) => entry.workflow_id !== pending.workflow_id,
        ),
      };
    await this.#decide(context, pending, sessionId);
  }

  #unclearPlan() {
    return {
      kind: 'clarify' as const,
      reason: 'unclear' as const,
      intent: null,
    };
  }

  // 解釈の後。保留の解決（新しい発話の関係）→ 入力の受付と方式 C の限定 → 保存・結果の配信。
  async #decide(
    context: Context,
    pending: Pending,
    sessionId: string,
  ): Promise<void> {
    if (pending.terminal !== null) return;
    const interpreted = pending.interpreted as InterpretedTurn;
    // 対象のターンは解釈の前に決めた発話のまま（新しい発話が始まっても対象を取り違えない）。発話が解釈の間に変わっていた
    // （同じ発話に断片が追加された）ときは、訂正が到着中なので変更を進めない。
    const target = {
      count: pending.target_count,
      turn:
        context.transcript.turns.find(
          (entry) => entry.ordinal === pending.target_ordinal,
        ) ?? null,
    };
    const now = this.#options.monoNow();
    const textNow = target.turn === null ? '' : turnText(target.turn);
    const changed = textNow !== (pending.text ?? '');
    const facts = liveTranscriptFacts(target, now);
    // この発話の入力が確定しているか（観測の条件がそろい、解釈の間に文字が変わっていない）。
    const confirmed =
      facts.end_candidate_observed &&
      facts.stable_ms >= METHOD_C_STABLE_MS &&
      facts.target_range_mapped &&
      !facts.known_fragment_gap &&
      facts.target_turn_unique &&
      !changed;
    // 他の保留を、この新しい発話の関係で解決する。入力が確定していない発話の関係は信用できない（欠落した断片の解釈が
    // 訂正・取消を返しても、先の依頼を失効させない）。保留はそのまま維持し、取消・訂正は言い直しを頼む。
    const resolution = confirmed
      ? this.#resolveHolds(context, pending, interpreted)
      : this.#unconfirmedRelation(interpreted);
    if (resolution === 'ask_back') {
      await this.#answerWithout(
        context,
        pending,
        sessionId,
        HOLD_ASK_BACK,
        'blocked',
      );
      return;
    }
    if (resolution === 'cancelled' || resolution === 'reconcile_only') {
      await this.#answerWithout(
        context,
        pending,
        sessionId,
        resolution === 'cancelled'
          ? HOLD_CANCELLED
          : inputCommentary('say_again'),
        'blocked',
      );
      return;
    }
    const intent: IntentName =
      interpreted.kind === 'intent'
        ? interpreted.intent
        : interpreted.plan.kind === 'clarify' &&
            interpreted.plan.intent !== null
          ? interpreted.plan.intent
          : 'unclear';
    const missingArgs =
      interpreted.kind === 'plan' &&
      interpreted.plan.kind === 'clarify' &&
      interpreted.plan.intent !== null &&
      interpreted.plan.reason.startsWith('missing_');
    const decision = admitLiveInput({
      intent,
      transcript: facts,
      conditions: pending.conditions,
      unresolved_correction: changed,
      missing_args: missingArgs,
      utterance_hold: false,
      policy_version: this.#policyVersion,
      own_event_only: intent === 'create_event',
    });
    pending.decision =
      decision.decision === 'read'
        ? 'read'
        : decision.decision === 'proceed'
          ? 'proceed'
          : null;
    if (decision.decision === 'reject') {
      this.#log(`live_input_rejected:${decision.reasons.join('+')}`);
      this.#finish(context, pending);
      return;
    }
    if (decision.decision === 'ask_again') {
      await this.#answerWithout(
        context,
        pending,
        sessionId,
        inputCommentary('say_again'),
        'blocked',
      );
      return;
    }
    if (decision.decision === 'full_text_required') {
      await this.#answerWithout(
        context,
        pending,
        sessionId,
        inputCommentary('full_text'),
        'blocked',
      );
      return;
    }
    // read・proceed。参照は保留を掛けず、確定前でも進める（確定していなければ partial として記録する）。
    const sealed = decision.decision === 'proceed' || confirmed;
    if (
      decision.decision === 'proceed' &&
      isHeld(context.hold, pending.workflow_id)
    ) {
      pending.phase = 'held';
      return;
    }
    await this.#commit(
      context,
      pending,
      sessionId,
      sealed ? 'sealed' : 'partial',
    );
  }

  // 入力が確定していない発話の関係。保留も保存済みの依頼も変えない。取消・訂正（対象の有無にかかわらず）は新しい実行へ
  // 流さず言い直しを頼み、別件・分からないはそのまま通常の入力として確かめる（確定するまで変更は進まない）。
  #unconfirmedRelation(
    interpreted: InterpretedTurn,
  ): 'none' | 'reconcile_only' {
    const relation =
      interpreted.kind === 'intent' ? interpreted.relation : 'unknown';
    return relation === 'cancel' ||
      relation === 'correction' ||
      relation === 'clarification'
      ? 'reconcile_only'
      : 'none';
  }

  // 他の保留の解決。新しい発話が訂正・別件・取消のどれかを、解釈の関係と対象から決める。対象は、この会話の保留中の依頼か、
  // 保存済み・送信済みの依頼のうち一意に決まるものだけ。保留がなくても、送信済み・保存済みの対象への取消・訂正は判定する。
  #resolveHolds(
    context: Context,
    pending: Pending,
    interpreted: InterpretedTurn,
  ): 'none' | 'resolved' | 'ask_back' | 'cancelled' | 'reconcile_only' {
    // この依頼自身の保留（解釈の間に新しい発話が始まった）は、他の保留の解決の対象にしない。
    const others = context.hold.entries.filter(
      (entry) => entry.workflow_id !== pending.workflow_id,
    );
    const relation =
      interpreted.kind === 'intent' ? interpreted.relation : 'unknown';
    const targetId =
      interpreted.kind === 'intent' ? interpreted.target_workflow_id : null;
    const targets: HoldTarget[] = [];
    if (targetId !== null) {
      const held = others.some((entry) => entry.workflow_id === targetId);
      if (held) targets.push({ workflow_id: targetId, phase: 'pre_dispatch' });
      else if (context.committed.includes(targetId))
        targets.push({ workflow_id: targetId, phase: 'dispatched' });
      else {
        // 保存の命令を送信済みで応答待ちの依頼は、保存後の操作として扱う（送出前の取消・訂正にしない）。
        const inFlight = context.pending.get(targetId);
        if (inFlight?.phase === 'dispatched')
          targets.push({ workflow_id: targetId, phase: 'dispatched' });
      }
    }
    // 保留集合が空でも、送信済み・保存済みの対象への関係（取消・訂正）は保存後の操作として判定する。
    // 明示的な取消は、対象を解決できてもできなくても通常の依頼へ流さない（新しい実行を作らず聞き返す）。
    // 通常の新しい依頼（new）は、対象の ID の有無にかかわらず従来どおり進める。
    if (others.length === 0 && targets.length === 0) {
      if (relation === 'cancel') return 'reconcile_only';
      return 'none';
    }
    const own = context.hold.entries.find(
      (entry) => entry.workflow_id === pending.workflow_id,
    );
    const result = resolveHold(
      { entries: others },
      { relation, targets },
      this.#options.monoNow(),
    );
    return this.#applyHold(context, result, own === undefined ? [] : [own]);
  }

  // 保留の解決の結果を、追っている依頼へ当てる。再開は再検査して続け、訂正・取消は保存前の旧い依頼を作らない。
  #applyHold(
    context: Context,
    result: ReturnType<typeof resolveHold>,
    keep: readonly HoldEntry[] = [],
  ): 'resolved' | 'ask_back' | 'cancelled' | 'reconcile_only' {
    // 解けた保留を状態から外してから、再開・訂正・取消を当てる（再開した依頼の保存の直前の再検査が、解けた保留を見ない）。
    context.hold = { entries: [...result.state.entries, ...keep] };
    let outcome: 'resolved' | 'cancelled' | 'reconcile_only' = 'resolved';
    for (const decision of result.decisions) {
      const entry = context.pending.get(decision.workflow_id);
      switch (decision.action) {
        case 'resume':
          if (entry !== undefined && entry.phase === 'held')
            void this.#resume(context, entry);
          break;
        case 'supersede':
          // 訂正・補足が確定した: 保存前の旧い依頼は作らず（旧結果もない）、この発話が新しい依頼になる。
          if (entry !== undefined) {
            this.#revoke(entry, 'superseded');
            this.#finish(context, entry);
          }
          break;
        case 'cancel':
          if (entry !== undefined) {
            this.#revoke(entry, 'cancelled');
            this.#finish(context, entry);
          }
          outcome = 'cancelled';
          break;
        case 'expire':
          if (entry !== undefined)
            this.#dropHeld(context, entry, 'hold_expired');
          break;
        case 'reconcile_only':
          outcome = 'reconcile_only';
          break;
        case 'keep_held':
        case 'propose_after_reconcile':
          break;
      }
    }
    if (result.ask_back) return 'ask_back';
    return outcome;
  }

  // 保留を解いた依頼を、再検査して続ける（再計画。保存の直前にも保留を見る）。
  async #resume(context: Context, pending: Pending): Promise<void> {
    if (pending.phase !== 'held') return;
    const sessionId = context.handle.session_id;
    if (sessionId === null || pending.interpreted === null) return;
    // 保留の間に発話が変わった可能性は、新しい発話が訂正なら supersede になる。別件（new）は元の入力のまま続ける。
    try {
      await this.#commit(context, pending, sessionId, 'sealed');
    } catch {
      this.#log('live_resume_failed');
      this.#finish(context, pending);
    }
  }

  // 保存して結果を届ける。
  async #commit(
    context: Context,
    pending: Pending,
    sessionId: string,
    outcome: 'sealed' | 'partial' | 'blocked',
    override: Commentary | null = null,
  ): Promise<void> {
    if (pending.terminal !== null) return;
    pending.phase = 'committing';
    const interpreted = pending.interpreted as InterpretedTurn;
    const change = outcome === 'sealed' && (pending.is_change ?? true);
    const result = await this.#options.turns.commitLive({
      session_id: sessionId,
      command_scope_id: context.handle.command_scope_id,
      request_id: derivedId(
        'buddy/live-delegation/v1',
        context.handle.live_session_id,
        pending.delegation_id,
      ),
      identity: `${context.handle.live_session_id}/${pending.delegation_id}`,
      text: pending.text ?? '',
      audio_epoch: context.handle.audio_epoch,
      policy_version: this.#policyVersion,
      interpreted,
      outcome,
      workflow_id: pending.workflow_id,
      // 保存の直前の再検査: 変更は、新しい発話の保留の間は保存しない。
      // 失効した依頼は、変更でなくても保存しない。
      precommit: () => {
        if (pending.terminal !== null) return false;
        if (change && isHeld(context.hold, pending.workflow_id)) return false;
        // ここから先は保存の命令を DB へ送る（応答待ち）。送信済みの依頼は、新しい発話の保留でも
        // Live の終了でも破棄せず、保存の結果をそのまま扱う。
        pending.phase = 'dispatched';
        return true;
      },
    });
    if (result.kind === 'held') {
      // 保存の準備の間に失効した依頼は、保留へ戻さない（すでに終わっている）。
      if (pending.terminal === null) pending.phase = 'held';
      return;
    }
    if (result.kind === 'failed') {
      this.#log(`live_commit_failed:${result.status}`);
      this.#finish(context, pending);
      return;
    }
    // 保存できた依頼は、以後の保留の対象にならない（承認待ちの操作は画面の承認で進む）。
    context.hold = {
      entries: context.hold.entries.filter(
        (entry) => entry.workflow_id !== pending.workflow_id,
      ),
    };
    if (result.turn.workflow_id !== null) {
      context.committed.push(result.turn.workflow_id);
      while (context.committed.length > COMMITTED_KEPT)
        context.committed.shift();
    }
    await this.#deliver(
      context,
      pending,
      sessionId,
      result.turn,
      override ?? this.#commentaryOf(result.turn, result.full_text),
    );
  }

  // 解釈の結果を保存せずに答える（聞き返し・全文の確定の案内・取消）。確定できなかった入力として記録し、依頼を作らない。
  async #answerWithout(
    context: Context,
    pending: Pending,
    sessionId: string,
    commentary: Commentary,
    outcome: 'blocked',
  ): Promise<void> {
    await this.#commit(context, pending, sessionId, outcome, commentary);
  }

  #commentaryOf(turn: TurnResponse, fullText: boolean): Commentary {
    if (fullText) return inputCommentary('full_text');
    const view = turn.result_view;
    if (turn.status === 'clarification' || view === null)
      return resultCommentary({
        kind: 'clarification',
        event_count: 0,
        overlap: false,
        more_count: 0,
        clarification_text: turn.reply_text,
      });
    return resultCommentary({
      kind: view.kind,
      event_count: view.item_refs.filter(
        (entry) => entry.kind === 'calendar_event',
      ).length,
      overlap: view.status === 'needs_review' && view.kind === 'schedule_cards',
      more_count: view.more_count,
      clarification_text: null,
    });
  }

  // 結果の届け先。声で返せるのは入力のときに声に固定した依頼だけで、世代・接続・端末が今も有効なとき。
  #route(context: Context, pending: Pending) {
    // 失効した依頼（保留の破棄・訂正・取消）は、Live の情報が既に外れていても画面へ出さない
    // （世代を読めない分岐より先に確かめる）。
    if (!pending.revision_current)
      return { channel: 'discard', reason: 'revision_superseded' } as const;
    const view = this.#options.host.delivery(context.handle.live_session_id);
    if (view.epochs === null)
      return { channel: 'screen', reason: 'no_current_epoch' } as const;
    return routeResultDelivery(
      {
        output: pending.output,
        audio_epoch: pending.audio_epoch,
        output_epoch: String(pending.output_gen),
        revision_current: pending.revision_current,
        live_open: view.open && !context.closed,
        reply_text_requested: false,
        backgrounded: false,
      },
      { ...view.epochs, outputEpoch: String(context.output_gen) },
    );
  }

  // 結果の届け先を決めて届ける。
  async #deliver(
    context: Context,
    pending: Pending,
    sessionId: string,
    turn: TurnResponse,
    commentary: Commentary,
  ): Promise<void> {
    const handle = context.handle;
    const route = this.#route(context, pending);
    this.#finish(context, pending);
    if (route.channel === 'discard') return;
    if (route.channel === 'voice') {
      const result: DelegationResult = {
        delegation_id: pending.delegation_id,
        workflow_id: pending.workflow_id,
        request_revision: '1',
        live_session_id: handle.live_session_id,
        audio_epoch: pending.audio_epoch,
        output: pending.output as DelegationResult['output'],
        facts: commentary.facts as DelegationResult['facts'],
        more_count: turn.result_view?.more_count ?? 0,
        template_id: commentary.template_id,
        template_version: commentary.template_version,
        commentary_parts:
          commentary.commentary_parts as DelegationResult['commentary_parts'],
      };
      if (
        this.#contract.valid('DelegationResult', result) &&
        this.#options.host.appendCommentary(
          handle.live_session_id,
          result.commentary_parts,
        )
      )
        return;
      this.#options.screen.show({
        reason: 'sideband_unavailable',
        session_id: sessionId,
        turn,
      });
      return;
    }
    this.#options.screen.show({
      reason: route.reason ?? 'screen',
      session_id: sessionId,
      turn,
    });
  }

  // 発言として残せないとき（文字がない）の声だけの返事。声で返せなければ何も出さない（見せる結果がない）。
  #sayOnly(context: Context, pending: Pending, commentary: Commentary): void {
    const route = this.#route(context, pending);
    this.#finish(context, pending);
    if (route.channel === 'voice')
      this.#options.host.appendCommentary(
        context.handle.live_session_id,
        commentary.commentary_parts,
      );
  }

  // 保留中の変更を実行せずに捨てる（画面へ知らせる）。
  #dropHeld(context: Context, pending: Pending, reason: string): void {
    // 保存の命令を送信済みの依頼は破棄しない（応答を待ち、保存結果をそのまま扱う）。
    if (pending.phase === 'dispatched') return;
    const sessionId = context.handle.session_id;
    // 画面への表示は未対応（U120）なので、声で届けられるなら破棄の事実を声でも伝える。
    const route = this.#route(context, pending);
    this.#revoke(pending, 'dropped');
    context.hold = {
      entries: context.hold.entries.filter(
        (entry) => entry.workflow_id !== pending.workflow_id,
      ),
    };
    this.#finish(context, pending);
    if (route.channel === 'voice')
      this.#options.host.appendCommentary(
        context.handle.live_session_id,
        inputCommentary('hold_dropped').commentary_parts,
      );
    if (sessionId !== null)
      this.#options.screen.heldDropped({
        session_id: sessionId,
        workflow_id: pending.workflow_id,
        reason,
      });
  }

  // 依頼を失効させる（終端状態。結果を読み上げず、画面にも出さない）。
  #revoke(pending: Pending, terminal: Terminal): void {
    pending.terminal ??= terminal;
    pending.revision_current = false;
  }

  #finish(context: Context, pending: Pending): void {
    if (pending.timer !== null) this.#options.timers.clear(pending.timer);
    pending.timer = null;
    pending.phase = 'done';
    context.pending.delete(pending.workflow_id);
    context.hold = {
      entries: context.hold.entries.filter(
        (entry) => entry.workflow_id !== pending.workflow_id,
      ),
    };
    this.#sweep(context);
  }

  // 閉じた Live で追う依頼がなくなったら記録を外す。
  #sweep(context: Context): void {
    if (context.closed && context.pending.size === 0)
      this.#contexts.delete(context.handle.live_session_id);
  }

  // ---- 会話の操作（LLM を呼ばない。X58） ----------------------------------------------------------------------

  // 発話終了候補を観測し、断片が 300 ms 変化しなくなった発話の全体が照合表に一致したら、接続の操作を行う。
  // 1 つの発話につき 1 回だけ見る。
  #armControl(context: Context): void {
    if (context.closed) return;
    const turn = context.transcript.turns.at(-1);
    if (
      turn === undefined ||
      !turn.end_candidate ||
      context.checked.has(turn.ordinal) ||
      turn.fragments.length === 0
    )
      return;
    if (context.controlTimer !== null)
      this.#options.timers.clear(context.controlTimer);
    const now = this.#options.monoNow();
    const last = turn.last_fragment_mono_ms;
    const wait =
      last === null || now < last
        ? METHOD_C_STABLE_MS
        : Math.max(0, last + METHOD_C_STABLE_MS - now);
    context.controlTimer = this.#options.timers.set(wait, () => {
      context.controlTimer = null;
      this.#checkControl(context, turn.ordinal);
    });
  }

  #checkControl(context: Context, ordinal: number): void {
    if (context.closed || context.checked.has(ordinal)) return;
    const turn = context.transcript.turns.find(
      (entry) => entry.ordinal === ordinal,
    );
    if (turn === undefined || !turn.end_candidate) return;
    const now = this.#options.monoNow();
    const stable =
      turn.last_fragment_mono_ms !== null &&
      now >= turn.last_fragment_mono_ms &&
      now - turn.last_fragment_mono_ms >= METHOD_C_STABLE_MS;
    if (!stable) {
      this.#armControl(context);
      return;
    }
    context.checked.add(ordinal);
    const resolution = resolveSessionControl(
      turnText(turn),
      SESSION_CONTROL_TABLE,
      'voice_live',
    );
    if (resolution === null) return;
    context.controlled.add(ordinal);
    // この発話の委譲は依頼にしない。解釈中のものは、解釈が遅れて戻っても保存・返答しないよう失効させてから片づける。
    for (const entry of [...context.pending.values()])
      if (
        entry.target_ordinal === ordinal &&
        (entry.phase === 'waiting_input' || entry.phase === 'interpreting')
      ) {
        this.#revoke(entry, 'cancelled');
        this.#finish(context, entry);
      }
    // 読み上げの停止による出力の世代の更新は、接続の操作（host.applySessionControl → playbackStopped）で行う。
    // 会話の操作は、保留中の変更への訂正ではない（別の発話）。保留を解いて、元の依頼を再検査して続ける。
    // 接続を閉じる操作（終了・記録しない・文字へ切り替え）では、閉じた時点で保留を捨てる（closed）。
    if (context.hold.entries.length > 0)
      this.#applyHold(
        context,
        resolveHold(
          context.hold,
          { relation: 'new', targets: [] },
          this.#options.monoNow(),
        ),
      );
    this.#options.host.applySessionControl(
      context.handle.live_session_id,
      resolution.action,
    );
  }
}
