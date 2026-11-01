// 入出力のモード・文字応答への切り替え・結果の届け先・発話開始の一時保留の純粋な規則（B05-05、ADR 0052。
// 設計 10 §1A・§5A・§6・§6A、07 §5、09 X27・X36・X47・X49・X58、QA35・QA43）。時計・乱数は呼び出し側が渡す。
// 端末・Core・OS には依存しない。ここで決めるのは「どちらへ返すか・何を保留するか」だけで、実行の許可ではない
// （実行の可否は readiness.ts と 08 の最終検査）。判別できないときは、外部へ送らない側・実行しない側・聞き返す側へ倒す。

import {
  acceptDelivery,
  resolveOutputMode,
  type DeviceEpochs,
  type InputKind,
} from './audio.js';
import type { SessionControlTable } from './voice-input.js';
import type { ConsentStatus } from './voice.js';

// ---- 会話の操作の照合表（コード。版管理。10 §5 v0.6、質問 126） --------------------------------------------------------

// 製品の照合表。言い回しは原本の例（実際の言い回しは B05・B10 の実測で足す。足すときは版を上げる）。
// 短い発話の全体がこの言い回しに一致したときだけ操作になり、依頼を含む発話・敬体・重ねた言い回しは一致しない。
// 試験は手書きの fixture（session-control-phrases.json の table）と同じ値であることを確かめる。
export const SESSION_CONTROL_TABLE: SessionControlTable = {
  version: '1',
  phrases: [
    { phrase: 'ちょっと待って', action: 'extend_silence' },
    { phrase: '少し待って', action: 'extend_silence' },
    { phrase: '読み上げを止めて', action: 'stop_playback' },
    { phrase: 'もう終わり', action: 'end_conversation' },
    { phrase: '会話を終わる', action: 'end_conversation' },
    { phrase: '記録しないで', action: 'start_private_conversation' },
    { phrase: '文字で返して', action: 'reply_in_text' },
  ],
};

// ---- 出力先の固定（07 §5 D15、10 §6・§6A、D14） -----------------------------------------------------------------

export interface OutputTargetValue {
  readonly mode: 'text' | 'voice';
  readonly device_id: string;
  readonly session_epoch: string | null;
}

// 入力ごとに出力先を固定する。出力先は入力の種類だけで決まり、音声の接続が開いているかを見ない（文字の依頼は、
// 音声の接続が開いていても文字で返す。④文字→音声は作らない）。声で返すのは Live の文字起こし（voice_live）だけで、
// そのときも接続の世代（session_epoch）が分からなければ声にしない（声は対象端末・接続世代・リースが有効なときだけ）。
export function fixOutputTarget(input: {
  readonly input_kind: InputKind;
  readonly device_id: string;
  readonly session_epoch: string | null;
}): OutputTargetValue {
  const wanted = resolveOutputMode(input.input_kind);
  const voice = wanted === 'voice' && input.session_epoch !== null;
  return {
    mode: voice ? 'voice' : 'text',
    device_id: input.device_id,
    session_epoch: voice ? input.session_epoch : null,
  };
}

// ---- 結果の届け先（10 §1A・§2A・§5 遅着・§6、X13・X29・X49） ---------------------------------------------------

export type ResultChannel = 'voice' | 'screen' | 'discard';

export interface ResultDeliveryInput {
  // 入力のときに固定した出力先。
  readonly output: OutputTargetValue;
  // 入力のときの音声・出力の世代（Core が委譲を受けた時点の値）。声のときだけ使う。
  readonly audio_epoch: string | null;
  readonly output_epoch: string | null;
  // 結果の依頼が今も現行の版か。訂正・取消で失効した旧版は読み上げず、画面にも出さない（10 §5A-7）。
  readonly revision_current: boolean;
  // 音声の接続が今も開いている（control が ready で、閉じ始めていない）。
  readonly live_open: boolean;
  // 文字へ切り替えた後（切り替えの後に届いた声の結果は、声に流さない）。
  readonly reply_text_requested: boolean;
  // 裏の処理へ切り替えた（8 秒を超えた）。完了は声でなく画面の気づきで伝える（10 §5 即時ジョブの上限）。
  readonly backgrounded: boolean;
}

export interface ResultDelivery {
  readonly channel: ResultChannel;
  // voice のときは null。
  readonly reason: string | null;
}

// 結果をどこへ出すか。声で返せるのは、声で依頼され、接続が開いたままで、文字へ切り替えておらず、世代・端末・リースが
// 今も有効なときだけ。それ以外は画面（一覧）へ回す（結果を捨てない）。失効した旧版だけ捨てる。判定は呼び出し側が
// 渡した今の世代（current）と、入力のときの世代の照合（acceptDelivery）で行う。
export function routeResultDelivery(
  input: ResultDeliveryInput,
  current: DeviceEpochs,
): ResultDelivery {
  const screen = (reason: string): ResultDelivery => ({
    channel: 'screen',
    reason,
  });
  if (!input.revision_current)
    return { channel: 'discard', reason: 'revision_superseded' };
  if (input.output.mode !== 'voice') return screen('text_request');
  if (input.reply_text_requested) return screen('reply_mode_text');
  if (!input.live_open) return screen('live_closed');
  if (input.backgrounded) return screen('backgrounded');
  if (input.audio_epoch === null || input.output_epoch === null)
    return screen('no_current_epoch');
  const decision = acceptDelivery(
    {
      kind: 'voice_output',
      deviceId: input.output.device_id,
      mode: input.output.mode,
      audioEpoch: input.audio_epoch,
      outputEpoch: input.output_epoch,
      ...(input.output.session_epoch === null
        ? {}
        : { sessionEpoch: input.output.session_epoch }),
    },
    current,
  );
  return decision.decision === 'accept'
    ? { channel: 'voice', reason: null }
    : screen(decision.reason);
}

// ---- 呼びかけを検知したときの ① か ③ の選び方（10 §2 t0・§6A 組み合わせの決め方） -----------------------------------

export type ReplyMode = 'voice' | 'text';

export interface WakeContext {
  // 端末の入出力が許可されている（ロック・停止・来客・全体停止でない）。
  readonly io_permitted: boolean;
  readonly reply_mode: ReplyMode;
  readonly private_conversation: boolean;
  readonly consent: ConsentStatus;
  // 会話予算の残り秒数。分からなければ null。
  readonly budget_seconds_left: number | null;
  // 直近の OpenAI への接続の失敗（端末が覚えている）。
  readonly recent_live_failure: boolean;
  // 中枢が Live の接続を拒否した（予算・障害）。
  readonly core_refused: boolean;
}

export type WakeInteraction =
  | { readonly mode: 'live' }
  | {
      readonly mode: 'local_text';
      readonly reason:
        | 'private_conversation'
        | 'reply_mode_text'
        | 'consent_missing'
        | 'budget_short'
        | 'recent_live_failure'
        | 'core_refused';
    }
  | { readonly mode: 'refuse'; readonly reason: 'io_not_permitted' };

// Live の最低課金の秒数（予約に必ず含める）。残りがこれに足りなければ ① を開かない。
export const LIVE_MIN_SECONDS_LEFT = 15;

// 呼びかけの瞬間に、端末が手元の状態だけで ① か ③ かを決める。外部へ音声を送るのは ① だけなので、判別できない値
// （同意が確かでない・予算が分からない）は ③ へ倒す。入出力が許可されていなければ何も始めない（低い効果音だけ）。
// 理由の優先は、記録しない会話・返し方・同意・予算・直近の失敗・中枢の拒否の順（状態欄にはいちばん強い理由を出す）。
export function chooseWakeInteraction(context: WakeContext): WakeInteraction {
  if (!context.io_permitted)
    return { mode: 'refuse', reason: 'io_not_permitted' };
  const text = (
    reason: Extract<WakeInteraction, { mode: 'local_text' }>['reason'],
  ): WakeInteraction => ({ mode: 'local_text', reason });
  if (context.private_conversation) return text('private_conversation');
  // 知らない値は文字（声と確かに分かるときだけ、外へ音声を送る側へ進む）。
  if (context.reply_mode !== 'voice') return text('reply_mode_text');
  if (context.consent !== 'granted') return text('consent_missing');
  if (
    context.budget_seconds_left === null ||
    !Number.isFinite(context.budget_seconds_left) ||
    context.budget_seconds_left < LIVE_MIN_SECONDS_LEFT
  )
    return text('budget_short');
  if (context.recent_live_failure) return text('recent_live_failure');
  if (context.core_refused) return text('core_refused');
  return { mode: 'live' };
}

// ---- 返し方の切り替え（10 §1A close_voice_session・§6A 切り替え、質問 107） ----------------------------------------

export interface ReplyModeChangeInput {
  readonly current: ReplyMode;
  readonly next: ReplyMode;
  // 音声の接続が開いている、または開き始めている（外部へ送っているかもしれない）。
  readonly live_active: boolean;
}

export interface ReplyModeChange {
  readonly reply_mode: ReplyMode;
  // ① から ③ へ切り替えたら、接続をすぐ閉じる（待たない）。理由は output_mode_text。
  readonly close_live: { readonly reason: 'output_mode_text' } | null;
  // 同じ会話（session_id）と文脈を引き継ぐ。切り替えで会話を終えない。
  readonly keeps_session: true;
  // 文字から声へ戻すときは、新しい接続を本人の次の呼びかけか「続ける」で作る（同じ接続・閉じた接続を復活させない）。
  readonly opens_live_now: false;
}

// 返し方を切り替える。声から文字は、開いている接続を閉じてから文字で返す。文字から声へは設定を戻すだけで、接続は
// 次の呼びかけで新しく作る。同じ値への切り替えでも、接続が開いていれば閉じない（何も変えない）。
export function planReplyModeChange(
  input: ReplyModeChangeInput,
): ReplyModeChange {
  const closes =
    input.next === 'text' && input.live_active && input.current === 'voice';
  return {
    reply_mode: input.next,
    close_live: closes ? { reason: 'output_mode_text' } : null,
    keeps_session: true,
    opens_live_now: false,
  };
}

// ---- 新しい発話の開始による一時保留と、訂正・別件の確定（10 §5A-3・§5A-4・§5A-6、修正案 v1.2 P03 §5.2、QA35・X27） ----

// 保留の上限（ms）。原本に決めなし（U103）。超えたら、実行せずに破棄して画面で確かめる（勝手に再開しない側）。
export const HOLD_MAX_MS = 30_000;

export interface InFlightWorkflow {
  readonly workflow_id: string;
  readonly request_revision: string;
  // 送出前（解釈中・操作の作成前・承認待ち）か、dispatching 以降か。以降は保留せず照合を続ける（5A-6）。
  readonly phase: 'pre_dispatch' | 'dispatched';
  // 変更を伴う依頼か。参照は保留しない（保留するのは送出前の変更だけ）。
  readonly is_change: boolean;
}

export interface HoldEntry {
  readonly workflow_id: string;
  readonly request_revision: string;
  readonly held_at_mono_ms: number;
}

export interface HoldState {
  readonly entries: readonly HoldEntry[];
}

export const EMPTY_HOLD: HoldState = { entries: [] };

const clockUsable = (now: number): boolean =>
  typeof now === 'number' && Number.isFinite(now);

// 新しい本人の発話の開始。送出前の変更を保留する。すでに保留中のものは保留の時刻を保つ（重ねて延ばさない）。
// 時計を読めないときは保留の時刻を数えられないので、保留に入れず null を返す（呼び出し側は変更を進めない）。
export function startUtteranceHold(
  state: HoldState,
  inFlight: readonly InFlightWorkflow[],
  now_mono_ms: number,
): HoldState | null {
  if (!clockUsable(now_mono_ms)) return null;
  const known = new Set(state.entries.map((entry) => entry.workflow_id));
  const added: HoldEntry[] = [];
  for (const item of inFlight)
    if (
      item.is_change &&
      item.phase === 'pre_dispatch' &&
      !known.has(item.workflow_id)
    )
      added.push({
        workflow_id: item.workflow_id,
        request_revision: item.request_revision,
        held_at_mono_ms: now_mono_ms,
      });
  return { entries: [...state.entries, ...added] };
}

// 保留している変更があるか（送出の直前の検査で「保留中なら送出しない」に使う）。
export function isHeld(state: HoldState, workflow_id: string): boolean {
  return state.entries.some((entry) => entry.workflow_id === workflow_id);
}

export type HoldRelation =
  'new' | 'clarification' | 'correction' | 'cancel' | 'unknown';

export interface HoldTarget {
  readonly workflow_id: string;
  readonly phase: 'pre_dispatch' | 'dispatched';
}

export type HoldAction =
  // 元の依頼を再検査して再開する（元の結果は保持）。
  | 'resume'
  // 訂正・補足が一つの対象に確定した: 対象の版を更新し、旧結果を失効させる。
  | 'supersede'
  // 取消が一つの対象に確定した: 送出前の処理を中止する。
  | 'cancel'
  // 対象が確定しない: 保留のまま、聞き返す。
  | 'keep_held'
  // 保留の上限・時計の異常: 実行せずに破棄する。
  | 'expire'
  // 送出済み（dispatching 以降）への訂正: 元の状態が確定してから、別の変更案として扱う。
  | 'propose_after_reconcile'
  // 送出済みへの取消: 取消成功と見せず、照合だけを続ける。
  | 'reconcile_only';

export interface HoldDecision {
  readonly workflow_id: string;
  readonly action: HoldAction;
}

export interface HoldResolution {
  readonly state: HoldState;
  readonly decisions: readonly HoldDecision[];
  // 対象が確定しない（複数・なし・分からない関係）。聞き返して、保留中の変更を勝手に再開しない。
  readonly ask_back: boolean;
}

// 新しい発話の関係（relation）と対象が確定したときの扱い。対象が一意に確定しないものは保留のまま聞き返す。
// 保留の上限を過ぎた・時計が戻った保留は、先に expire にして状態から外す（実行しない）。
export function resolveHold(
  state: HoldState,
  resolution: {
    readonly relation: HoldRelation;
    readonly targets: readonly HoldTarget[];
  },
  now_mono_ms: number,
): HoldResolution {
  const decisions: HoldDecision[] = [];
  const live: HoldEntry[] = [];
  for (const entry of state.entries) {
    const expired =
      !clockUsable(now_mono_ms) ||
      now_mono_ms < entry.held_at_mono_ms ||
      now_mono_ms - entry.held_at_mono_ms > HOLD_MAX_MS;
    if (expired)
      decisions.push({ workflow_id: entry.workflow_id, action: 'expire' });
    else live.push(entry);
  }
  const keepAll = (): HoldResolution => ({
    state: { entries: live },
    decisions: [
      ...decisions,
      ...live.map((entry) => ({
        workflow_id: entry.workflow_id,
        action: 'keep_held' as const,
      })),
    ],
    ask_back: true,
  });
  const resumeOthers = (
    targetId: string | null,
    targetAction: HoldAction | null,
  ): HoldResolution => {
    const out: HoldDecision[] = [...decisions];
    for (const entry of live)
      out.push({
        workflow_id: entry.workflow_id,
        action:
          entry.workflow_id === targetId && targetAction !== null
            ? targetAction
            : 'resume',
      });
    if (
      targetId !== null &&
      targetAction !== null &&
      !live.some((entry) => entry.workflow_id === targetId)
    )
      out.push({ workflow_id: targetId, action: targetAction });
    return { state: EMPTY_HOLD, decisions: out, ask_back: false };
  };
  if (resolution.relation === 'unknown') return keepAll();
  if (resolution.relation === 'new') return resumeOthers(null, null);
  if (resolution.targets.length !== 1) return keepAll();
  const target = resolution.targets[0] as HoldTarget;
  const heldTarget = live.some(
    (entry) => entry.workflow_id === target.workflow_id,
  );
  const correcting = resolution.relation !== 'cancel';
  if (heldTarget)
    return resumeOthers(
      target.workflow_id,
      correcting ? 'supersede' : 'cancel',
    );
  if (target.phase === 'dispatched')
    return resumeOthers(
      target.workflow_id,
      correcting ? 'propose_after_reconcile' : 'reconcile_only',
    );
  // 送出前だが保留の中にない（保留の上限で外れた・別の会話の ID）。対象を確定できないので聞き返す。
  return keepAll();
}
