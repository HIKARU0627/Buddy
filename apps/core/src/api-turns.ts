// 会話の開始・発言（入力→解釈→意味検証→操作の作成）・preview の発行の経路（設計 07 §1〜3、08 §3、09 §1〜3、
// 10 §5・§6A、01 承認画面の必須内容、ADR 0004・0027・0029）。
//
// - 経路の検査（ROUTE_CHECKS: 端末トークン・自宅・接続範囲・ロック解除）は api-server.ts が先に行う。
// - 発言: 解釈（差し込み口。B04 は模擬）→ 意図表（checkIntentArgs）と契約（IntentArgs）の検査 → 意味検証
//   （provider の読み取りで対象を解決し、接続と許可の版を確かめる）→ 経路の分け。
//   - Read: 承認も試行も作らず ResultView を返す（予定の重なりはコードで計算する）。
//   - LocalCommand・RemoteMutation: assessReadiness を通し、確定 intent を暗号化して operation.create へ進む。
//     外部への変更はここでは行わない（実行は B04-04）。自動実行は試験用の方針表ですべて off。
//   - 知らない文・必須の不足・意味検証の失敗は聞き返し（操作を作らない）。
//   - 本人の明示の依頼の記憶（memory_save・memory_correct。ADR 0191）: 保存してよい種類の設定・台帳・今ある記憶で判定し
//     （memory-save.ts）、保存するなら発言と同じ transaction（turn.record の memory）で保存する。保存した・保存しなかった
//     （理由）を決まった文で返す。承認・操作は作らない（意図表の approval は none）。
// - 発言・依頼・入力スナップショット・受付は DB worker の turn.record で一つの transaction に書く。同じ request_id の
//   再送は保存済みの ID を返し、依頼に操作がまだなければ作り直す（再開）。照合値が違えば 409。
// - preview: 承認待ちの操作の確定 intent を復号し、hash を照合して返す。端末・接続範囲・内容版・hash（外部変更は
//   口座と許可の版）に結び付けて Core のメモリーに置く（previews.ts）。承認のときに previewValid で照合する。
// - 応答・ログに本文の平文・トークンを入れない（preview の応答の確定 intent は表示のための例外で、ログに出さない）。

import { createHash, randomUUID } from 'node:crypto';
import {
  INTENT_NAMES,
  INTENT_POLICIES,
  RETENTION_RULES,
  SESSION_CONTROL_TABLE,
  acceptedCommentary,
  assessReadiness,
  checkIntentArgs,
  REPLY_TEXT_INTENTS,
  admitReplyText,
  isRealLocalDateTime,
  resolveSessionControl,
} from '@buddy/domain';
import type {
  ArgValues,
  HoldRelation,
  InputEvidence,
  IntentName,
  SessionControlAction,
  StartupGateDecision,
  StorageModeName,
} from '@buddy/domain';
import {
  openOperationIntent,
  sealBlob,
  sealOperationIntent,
} from '@buddy/storage';
import type {
  ConversationOpResult,
  ConversationRequestRef,
  DataKeyMaterial,
  DataKeyProvider,
  DbCommand,
  DbSubmission,
  DbWorkerClient,
  MemoryKindName,
  TurnInputRecord,
  TurnMemoryInput,
  TurnOperationInput,
  WorkflowState,
} from '@buddy/storage';
import type { TurnResponse } from '@buddy/contracts';
import type { ApiContract } from './api-contract.js';
import { createApiContract } from './api-contract.js';
import { deviceCommandId, requestHash } from './api-operations.js';
import type { PreviewCheck } from './api-operations.js';
import { apiErrorResponse } from './api-server.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import type { EventQueryStore } from './event-feed.js';
import type { PreviewRegistry } from './previews.js';
import type { JsonObject } from './strict-json.js';
import { planExplicitMemory, storageRejectionReason } from './memory-save.js';
import type { MemoryNotSavedReason } from './memory-save.js';
import { PrivateConversationRam } from './private-turns.js';
import type { PrivateDiscardReason, PrivateHeld } from './private-turns.js';
import { canRead, canWrite, replyFields } from './turn-ports.js';
import type {
  BackgroundJobAcceptor,
  CandidateSource,
  InterpretationContext,
  Interpreter,
  InterpreterReply,
  OpenWorkflow,
  ProviderConnection,
  ProviderReader,
  TurnPolicy,
} from './turn-ports.js';

export interface TurnRouteStore extends EventQueryStore {
  submit(command: DbCommand): DbSubmission;
  conversation: DbWorkerClient['conversation'];
  // 記憶の保存の前の検査の材料を読む（memory.admission_facts。ADR 0191）。記憶の口（options.memory）を渡すときだけ使う。
  memory?: DbWorkerClient['memory'];
}

// 本人の明示の依頼の記憶の口（ADR 0191）。省略すると memory_save・memory_correct は「未対応」の聞き返しのまま。
export interface TurnMemoryOptions {
  // 台帳の HMAC の鍵（32 バイト）。バックアップの設定の前・読めなければ null（保存しない）。
  readonly ledgerKey: () => Promise<Uint8Array | null>;
  // 忘却の公開ゲート（memory_correct・食い違いの返事で、古い記憶を忘れる手順へ導けるかを言い分ける。読むだけ）。
  readonly forgetGate: () => boolean;
  readonly newId?: () => string;
}

// 今の区切りの世代を読む口（StorageModeGate.origin）。発言の由来の照合に使う（ADR 0045・0059）。
// mode は保存境界の保持者の今の保存モード。記録しない区切りの間は DB の sessions を引かない（ADR 0060 の 2b）。
export interface StorageOriginSource {
  // 今の保存モード。記録しない区切りの間は DB の sessions を引かない（ADR 0060 の 2b）。
  readonly mode: StorageModeName;
  origin(): {
    readonly segment_id: string;
    readonly segment_generation: string;
  };
}

export interface TurnRoutesOptions {
  readonly store: TurnRouteStore;
  readonly keyStore: DataKeyProvider;
  readonly interpreter: Interpreter;
  // 保存境界の保持者（記録しない会話のゲート）。今の区切りの世代を発言の由来と照合する。
  readonly storage: StorageOriginSource;
  // 連携の provider の読み取り。null は接続なし（Read・RemoteMutation は聞き返し）。
  readonly provider: ProviderReader | null;
  readonly candidates: CandidateSource;
  readonly policy: TurnPolicy;
  readonly previews: PreviewRegistry;
  // 今日の日付を決める時差（例: +09:00）。
  readonly utcOffset: string;
  readonly now?: () => number;
  readonly contract?: ApiContract;
  // 発言から操作を作った後に呼ぶ（イベントの配信を起こす。event-feed の notify）。
  readonly onOperationCreated?: () => void;
  // 会話の操作（照合表に当たった発言。LLM を呼ばない）を保存した後に呼ぶ（B05-05）。再送では呼ばない。
  // 音声の接続が開いていれば、同じ操作を接続へ行う（画面のボタンと同じ処理）。
  // 発言の解釈を保存した後に呼ぶ（影モードの比較の入口。再送・会話の操作・Live では呼ばない）。同期で戻り、本線の応答を
  // 待たせない。失敗しても発言の結果に影響しない。
  readonly onInterpreted?: (event: {
    readonly session_id: string;
    readonly storage_mode: string;
    readonly input_id: string;
    readonly request_revision: string;
    // 保存した発言の期限（UTC のミリ秒）。比較の記録は会話全文と同じ期限にそろえる。
    readonly turn_expires_at: number;
    readonly context: InterpretationContext;
    readonly primary: InterpreterReply;
  }) => void;
  readonly onSessionControl?: (event: {
    readonly device_id: string;
    readonly session_id: string;
    readonly action: SessionControlAction;
  }) => void;
  // 発言を保存した後に、保存した時点で確定した生成の時刻と期限を渡す（UI-05 の流れの区切り・要約の期限。ADR 0068）。
  // 応答を返す時点の時計ではなく、保存の命令に渡した値を使う（DB の待ちで期限が後ろへずれない）。再送では呼ばない。
  readonly onTurnRecorded?: (event: {
    readonly session_id: string;
    readonly turn_id: string;
    readonly created_at: string;
    readonly expires_at: string;
  }) => void;
  // 保存期限の掃除のゲート（ADR 0053）。Read・RemoteMutation の前に掃除が済むのを待ち、閉じていれば聞き返す。
  // 検索（予定の照会）とクラウドへの送信（下書き・ラベル）の入口は、今あるものだけをここにつなぐ。
  readonly retention?: {
    readonly ready: () => Promise<void>;
    readonly gate: () => StartupGateDecision;
    // ゲートの確認から検索・計画の終わりまでを掃除の本体と直列にする貸し出し（RetentionSweeper.lease）。
    // 掃除が動いている・待っている・ゲートが閉じているときは null。返された関数を呼ぶまで、新しい掃除は本体に入らない。
    readonly lease: () => (() => void) | null;
  };
  // 裏のジョブの受付（調査を最初から裏へ回す口。U254、ADR 0135）。省略は受付なしで、調査は従来どおり「未対応」の
  // 聞き返しになる。製品の起動（core.ts）は、検索・取得・要約の口が渡されたときだけ受付器をつなぐ（B12-05、ADR 0141）。
  readonly backgroundJobs?: BackgroundJobAcceptor;
  // 本人の明示の依頼の記憶（ADR 0191）。
  readonly memory?: TurnMemoryOptions;
}

const stringOf = (body: JsonObject | null, key: string): string => {
  const value = body?.[key];
  return typeof value === 'string' ? value : '';
};

// 決まった値から UUID v4 の形の ID を作る（予定の参照 ID。provider の ID を Buddy の Id の形にする）。
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

const OFFSET = /^([+-])([01][0-9]|2[0-3]):([0-5][0-9])$/u;
// 契約の Id（小文字の UUID）の形。差し込み口が返す ID を信用する前に確かめる。
const UUID_FORM =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// 契約の UtcTime（UTC の RFC 3339。端数の 0 は付けない。domain の deleteAt と同じ表し方）。
const utcTime = (ms: number): string =>
  new Date(ms).toISOString().replace('.000Z', 'Z');

function offsetMinutes(offset: string): number {
  const match = OFFSET.exec(offset);
  if (match === null) throw new Error('utc_offset_invalid');
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

// 聞き返しの文（決まった文。モデルに作らせない）。
const CLARIFY = {
  unclear: 'すみません、どうしたいのか分かりませんでした。言い換えてください。',
  missing_target: 'どのメールのことか教えてください。',
  missing_title: '用事の題名を教えてください。',
  missing_body: '下書きの本文を教えてください。',
  missing_other: '足りない情報があります。もう少し詳しく教えてください。',
  invalid: 'その内容では進められません。言い換えてください。',
  target_not_found: '対象が見つかりませんでした。もう一度指定してください。',
  connection: '連携の接続が使えません。接続を確かめてください。',
  no_change: 'すでにその状態です。変更はありません。',
  blocked: '今は進められません。少し待ってからもう一度お願いします。',
  unsupported: 'その依頼にはまだ対応していません。',
  // 判定の失敗（モデルが分からないと答えたのではない）。実行へは進まない（QA02・QA03）。
  model_invalid:
    'うまく読み取れませんでした。もう一度、言い換えてお願いします。',
  model_unavailable:
    '今は判定できませんでした。少し待ってから、もう一度お願いします。',
  // 声（方式 C）の入力は 4 操作だけを進める。それ以外は画面で全文を確かめてから（B05-05）。
  full_text:
    'この操作は、画面で内容を確かめてからにします。画面から送ってください。',
  // 記録しない会話では、保存を伴う依頼（用事・記憶・外部の変更の承認待ち・裏の調査など）を作らない（ADR 0045 の許可表・
  // U64。独立した確認は B06-07a-2 の 2d）。参照・雑談・会話の操作だけを答える（ADR 0190）。
  private_unsupported:
    '記録しない会話では、この依頼はまだ受け付けられません。記録しない会話を終えてから、もう一度お願いします。',
} as const;

type ClarifyReason = keyof typeof CLARIFY;

// 記憶の種類の言い方（画面の忘却の欄と同じ）。
const MEMORY_KIND_LABELS: Readonly<Record<MemoryKindName, string>> = {
  preference: '好み',
  goal: '目標',
  person: '人',
  routine: '習慣',
  lexicon: '言葉の使い方',
  progress: '進み具合',
};

// 記憶の判定の結果の文（決まった文。モデルに作らせない。記憶の本文は入れない。ADR 0191）。gateOpen は忘却の公開ゲート。
// memory_correct（古い記憶を直す）と、同じ対象の食い違い（U111）は、古い記憶を忘れる手順へ導く。ゲートが閉じている間は、
// 忘れる操作がまだ使えないことを言う（本人の決定 Q3: 訂正も忘却の確認の画面を使う）。
export function memoryReplyText(
  plan: Extract<TurnPlan, { kind: 'memory_done' }>,
  gateOpen: boolean,
): string {
  const label =
    plan.memory_kind === null ? null : MEMORY_KIND_LABELS[plan.memory_kind];
  const oldMemory = gateOpen
    ? '古い記憶は「記憶と忘却」の欄で選び、忘却の計画を確かめてから忘れてください。'
    : '古い記憶を忘れる操作は、まだ使えません（「記憶と忘却」の欄で記憶を見ることはできます）。';
  switch (plan.outcome) {
    case 'saved':
      return plan.intent === 'memory_correct'
        ? `新しい内容を「${label ?? ''}」の記憶として覚えました。古い記憶は残っています。${oldMemory}`
        : `「${label ?? ''}」の記憶として覚えました。「記憶と忘却」の欄で確かめられます。`;
    case 'duplicate':
      return '同じ内容をすでに覚えています。新しくは保存しませんでした。';
    case 'conflict':
      return `覚えませんでした。同じことについて、内容の違う記憶がすでにあります。${oldMemory}`;
    case 'kind_not_allowed':
      return `覚えませんでした。「${label ?? ''}」の記憶は、保存してよい記憶の種類で許可されていません。「保存してよい記憶の種類」の欄で変えられます。`;
    case 'kind_missing':
      return '覚えませんでした。どの種類の記憶か分かりませんでした。好み・目標・人・習慣・言葉の使い方・進み具合のどれに当たるかが分かるように、言い換えてください。';
    case 'text_empty':
      return '覚えませんでした。覚える内容が分かりませんでした。';
    case 'text_too_long':
      return '覚えませんでした。覚える内容は 80 文字までにしてください。';
    case 'text_control_character':
      return '覚えませんでした。覚える内容に、画面に見えない文字が含まれています。';
    case 'settings_changed':
      return '覚えませんでした。保存してよい記憶の種類の設定が、受け付けている間に変わりました。もう一度お願いします。';
    case 'private_conversation':
      return '覚えませんでした。記録しない会話では記憶を保存しません。';
    case 'forgotten':
      return '覚えませんでした。忘却の記録と照らし合わせられませんでした。少し待ってから、もう一度お願いします。';
    case 'not_ready':
      return '覚えませんでした。中枢が今は記憶を保存できません（バックアップの設定がまだのときも保存しません）。';
  }
}

interface ScheduleItem {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

// 予定の重なり（コードで計算する。モデルに判定させない）。開始の順に並べ、区間が重なる予定を返す。
// 端がちょうど接する（前の終了＝次の開始）予定は重ならない。
export function scheduleOverlaps(
  items: readonly ScheduleItem[],
): ReadonlySet<string> {
  const sorted = [...items].sort(
    (a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const overlapping = new Set<string>();
  for (let i = 0; i < sorted.length; i += 1)
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i] as ScheduleItem;
      const b = sorted[j] as ScheduleItem;
      if (b.start >= a.end) continue;
      overlapping.add(a.id);
      overlapping.add(b.id);
    }
  return overlapping;
}

// 予定の照会で返す予定の上限。予定 1 件の参照は重なりの参照を含めて高々 2 件（1 件は約 70 文字）なので、
// 上限まで返しても応答は turn_responses の上限（16,384 文字）に十分収まる。
export const MAX_SCHEDULE_ITEMS = 50;

// 掃除の本体との直列化の貸し出しを取る試行の上限（取れないのは、掃除が済むのを待った直後にも別の掃除が始まったとき）。
const LEASE_ATTEMPTS = 3;

export type TurnPlan =
  | {
      readonly kind: 'session_control';
      readonly action: SessionControlAction;
    }
  | {
      readonly kind: 'clarify';
      readonly reason: ClarifyReason;
      // 意図が分かった聞き返しは依頼（workflow）を作る。知らない文は作らない。
      readonly intent: IntentName | null;
    }
  | {
      readonly kind: 'read';
      readonly intent: IntentName;
      readonly items: readonly { readonly kind: string; readonly id: string }[];
      readonly overlaps: boolean;
      // 上限で切って返さなかった予定の件数（ResultView の more_count）。
      readonly more: number;
    }
  // 雑談・一般の質問への返答文（B10-04、U217）。実行も承認の対象も作らない。text は admitReplyText を通った平文で、
  // 応答には載せるが DB には保存しない（turn_responses は平文の列で、モデルの文を平文のまま残さない）。
  | {
      readonly kind: 'reply';
      readonly intent: IntentName;
      readonly text: string;
    }
  | {
      readonly kind: 'operation';
      readonly intent: IntentName;
      readonly route: 'local_command' | 'remote_mutation';
      readonly operation_id: string;
      readonly operation_kind: string;
      readonly content: Readonly<Record<string, unknown>>;
      readonly permission_revision: string;
    }
  // 裏のジョブが受け付けた調査（U254、ADR 0135）。workflow_id は受付器が返した値（同じ要求の再送では最初の受付の ID）。
  // 実行・承認の対象は作らない。結果は後続（B12 の実行器・B11 の気づき）が届ける。
  | {
      readonly kind: 'accepted';
      readonly intent: 'research';
      readonly workflow_id: string;
    }
  // 本人の明示の依頼の記憶（ADR 0191）。発言を保存する直前（発言の ID が決まった後）に判定し、memory_done にする。
  | {
      readonly kind: 'memory';
      readonly intent: 'memory_save' | 'memory_correct';
      readonly memory_kind: MemoryKindName | null;
      readonly body: string;
    }
  // 記憶の判定の結果（保存した・保存しなかった理由）。応答は決まった文。
  | {
      readonly kind: 'memory_done';
      readonly intent: 'memory_save' | 'memory_correct';
      readonly memory_kind: MemoryKindName | null;
      readonly outcome: 'saved' | MemoryNotSavedReason;
    };

// 裏のジョブの受付の文脈（planFrom に渡す）。dedupe_key は要求の command_id、workflow_id は Core が提案する依頼の ID。
interface IntakeContext {
  readonly dedupe_key: string;
  readonly session_id: string;
  readonly workflow_id: string;
}

// 受付の文（コードの定型文。domain の acceptedCommentary と同じ文で、モデルの文ではない）。
const ACCEPTED_TEXT = acceptedCommentary().commentary_parts.join('');

// 発言の入力の時点に控える、連携の口座と許可の版（Core のメモリーにある最後に確かめた値）。
type InputPermission = {
  readonly account_id: string;
  readonly permission_revision: string;
} | null;

const clarify = (
  reason: ClarifyReason,
  intent: IntentName | null,
): TurnPlan => ({ kind: 'clarify', reason, intent });

// 解釈の結果（意図表・契約で検査済み）。Live の委譲は、解釈の後・保存の前に入力の受付（方式 C の限定）を挟むので、
// 解釈と保存を分けて呼ぶ（解釈を 2 回しない）。
export type InterpretedTurn =
  | {
      readonly kind: 'plan';
      readonly plan: TurnPlan;
      // 意図は分からないが、直前の依頼への取消・訂正・補足だと分かった発話の関係（B05-05、5A-4）。実行はせず、
      // 保留中の依頼の解決（取消・訂正の確定、対象不明なら聞き返し）にだけ使う。
      readonly relation?: HoldRelation;
      readonly target_workflow_id?: string | null;
    }
  | {
      readonly kind: 'intent';
      readonly intent: IntentName;
      readonly args: ArgValues;
      // 直前の依頼との関係（5A-4）。モデルの値は信用せず、分からなければ unknown（保留中の変更を再開しない側）。
      readonly relation: HoldRelation;
      readonly target_workflow_id: string | null;
      // モデルの返答文（smalltalk・general_question のときだけ持つ。信用しない平文で、表示の前に admitReplyText で検査する。
      // 保存しない）。
      readonly reply_text?: string | null;
    };

// Live の委譲から保存する発言（B05-05）。共通の workflow（意図表・意味検証・readiness・承認待ちの操作）を通す。
export interface LiveCommitInput {
  readonly session_id: string;
  // 接続範囲（Live を開いた端末のリースの接続範囲）と、委譲ごとに決まる request_id（同じ委譲の再送は同じ値）。
  readonly command_scope_id: string;
  readonly request_id: string;
  // 要求の照合値に入れる値（live_session_id と委譲の ID）。同じ request_id で違う委譲なら 409。
  readonly identity: string;
  readonly text: string;
  readonly audio_epoch: string;
  readonly policy_version: string;
  readonly interpreted: InterpretedTurn;
  // sealed: 方式 C の暫定入力として進める。partial: 確定前の入力から参照だけ答える（変更は作らない）。
  // blocked: 確定できなかった入力として記録し、依頼・操作を作らない。
  readonly outcome: 'sealed' | 'partial' | 'blocked';
  // 依頼の ID（保留の間も同じ値で追う）。
  readonly workflow_id: string;
  // 保存の直前の確認。false なら保存せず held を返す（新しい発話の開始による保留。送出の直前の再検査）。
  readonly precommit: () => boolean;
  // Live の受付を始めた時点の保存の区切りの由来（VoiceControl が Live に持たせた値。ADR 0190）。あれば保存の由来にし、今の区切りと
  // 違えば DB に触れずに断る（Live を開いた後に記録しない会話へ入った・出た）。省略は保存を始めた時点の区切り。
  readonly origin?: {
    readonly segment_id: string;
    readonly segment_generation: string;
  };
}

export type LiveCommitResult =
  | {
      readonly kind: 'ok';
      readonly turn: TurnResponse;
      readonly replayed: boolean;
      // 4 操作でも画面承認・全文の確定が要るため進めなかった（readiness の requires_full_text）。
      readonly full_text: boolean;
    }
  | { readonly kind: 'held' }
  | { readonly kind: 'failed'; readonly status: number };

export interface TurnRoutes {
  readonly handlers: Readonly<Record<string, ApiRouteHandler>>;
  // 記録しない区切りの RAM（ADR 0190）。discard は記録しない会話の終わり・ロック・忘却・停止で呼ぶ。held は試験・診断用
  // （件数だけで本文を返さない）。
  readonly privateConversation: {
    discard(reason: PrivateDiscardReason): void;
    held(): PrivateHeld;
  };
  readonly previewValid: PreviewCheck;
  readonly previewCurrent: (previewId: string) => boolean;
  readonly prime: () => Promise<void>;
  // 発言の解釈（外部へは送らない。副作用なし）。
  readonly interpret: (
    text: string,
    options?: { readonly open_workflows?: readonly OpenWorkflow[] },
  ) => Promise<InterpretedTurn>;
  // Live の委譲から発言・依頼・操作（承認待ち）を保存する。
  readonly commitLive: (input: LiveCommitInput) => Promise<LiveCommitResult>;
}

export function createTurnRoutes(options: TurnRoutesOptions): TurnRoutes {
  const { store, previews, policy } = options;
  const now = options.now ?? (() => Date.now());
  const contract = options.contract ?? createApiContract();
  const offset = offsetMinutes(options.utcOffset);

  // 端末が見ていた区切り（会話の ID と世代）が今のものかを確かめる（ADR 0045 の P2-1・ADR 0059）。
  // 形が違う・古い世代・別の会話は、発言を保存せずに 409 で断る。
  const originMatches = (
    origin: unknown,
    sessionId: string,
    generation: string,
  ): boolean => {
    if (typeof origin !== 'object' || origin === null || Array.isArray(origin))
      return false;
    const value = origin as Record<string, unknown>;
    return (
      Object.keys(value).every(
        (key) => key === 'segment_id' || key === 'segment_generation',
      ) &&
      value['segment_id'] === sessionId &&
      value['segment_generation'] === generation
    );
  };

  // 処理を始めたときの区切りが今も同じか（保存境界の保持者の区切りの ID と世代。ADR 0190）。記録しない区切りに入る・出ると
  // 区切りの ID と世代が変わる（domain の storageOriginRejection が null を返すのは、この 2 つが今と同じときだけ）。
  const originCurrent = (origin: {
    readonly segment_id: string;
    readonly segment_generation: string;
  }): boolean => {
    const present = options.storage.origin();
    return (
      present.segment_id === origin.segment_id &&
      present.segment_generation === origin.segment_generation
    );
  };

  const loadKey = async (): Promise<DataKeyMaterial | null> => {
    try {
      const result = await options.keyStore.loadDataKey();
      return result.ok ? result.dataKey : null;
    } catch {
      return null;
    }
  };

  const today = (): string =>
    new Date(now() + offset * 60_000).toISOString().slice(0, 10);

  // 会話の命令の拒否を応答へ写す。照合値の違い・対象の不在は 409、他は中枢側の保留（503）。
  const conversationError = (
    result: Extract<ConversationOpResult, { ok: false }>,
    requestId: string,
  ) =>
    result.outcome === 'rejected' &&
    result.reasons.some((reason) =>
      ['request_conflict', 'session_not_found', 'device_not_active'].includes(
        reason,
      ),
    )
      ? apiErrorResponse(409, 'conflict', requestId)
      : apiErrorResponse(503, 'dependency_unavailable', requestId);

  const requestRef = (request: ApiHandlerRequest, targetId: string) => {
    const body = request.body as JsonObject;
    const scope = stringOf(body, 'command_scope_id');
    const requestId = stringOf(body, 'request_id');
    return {
      command_scope_id: scope,
      request_id: requestId,
      request_hash: requestHash(request.route.operationId, targetId, body),
      command_id: deviceCommandId(scope, requestId),
    };
  };

  // 会話ごとの由来の控え（会話の ID → 作成したときの区切りと世代）。保存境界の保持者の状態は書き換えない。
  // 再送ではこの控えの世代を返し、発言は控えと今の区切りの両方に一致するときだけ通す。
  // 再起動で失われるが、そのときは '0'（今の世代と一致しない）を返して最初の発言を 409 にし、会話を作り直させる。
  const sessionOrigins = new Map<
    string,
    { readonly gate_segment_id: string; readonly generation: string }
  >();

  const createSession: ApiRouteHandler = async (request) => {
    const device = request.device;
    const requestId = stringOf(request.body, 'request_id');
    if (device === null) return apiErrorResponse(401, 'unauthenticated');
    const mode = stringOf(request.body, 'storage_mode');
    // 記録しない会話（private）は流れの経路（POST /v1/stream/storage-mode）が持つ。画面からの会話の作成では
    // normal／extended だけを作り、private は受け付けない（ADR 0060 の入口の整理。503）。
    if (mode !== 'normal' && mode !== 'extended')
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const origin = options.storage.origin();
    const newSessionId = randomUUID();
    const result = await store.conversation({
      kind: 'session.create',
      session_id: newSessionId,
      storage_mode: mode,
      display_device_id: device.device_id,
      created_at: now(),
      request: requestRef(request, ''),
    });
    if (!result.ok) return conversationError(result, requestId);
    const session = result.value;
    if (session === null)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    // 再送では最初の受付の世代を返す（今の世代に付け替えない）。再起動で控えが無ければ '0' を返す。
    let responseGeneration = origin.segment_generation;
    if (session.session_id === newSessionId) {
      sessionOrigins.set(newSessionId, {
        gate_segment_id: origin.segment_id,
        generation: origin.segment_generation,
      });
    } else {
      responseGeneration =
        sessionOrigins.get(session.session_id)?.generation ?? '0';
    }
    return {
      status: 201,
      body: {
        request_id: requestId,
        session_id: session.session_id,
        storage_mode: session.storage_mode,
        segment_generation: responseGeneration,
        route_revision: session.route_revision,
      },
    };
  };

  // 連携の接続を読む。読めなければ null（接続なしの扱い）。
  const readConnection = async () => {
    if (options.provider === null) return null;
    try {
      return await options.provider.connection();
    } catch {
      return null;
    }
  };

  // 対象のメールの表示用の値（件名・差出人・受信日時）。読めなければ null（承認画面は対象を確認できないと言う）。
  // 今の接続先（アカウント）が確定 intent の口座と同じときだけ読む。違えば（接続先を替えた後に、同じ remote_id で別の
  // アカウントのメールを読んでしまう）null を返す。
  const readTargetDisplay = async (
    intent: Record<string, unknown>,
    connection: Pick<
      ProviderConnection,
      'account_id' | 'status' | 'readable_kinds'
    > | null,
  ): Promise<{
    subject: string | null;
    sender: string | null;
    received_at: string | null;
  } | null> => {
    const target = intent['target'];
    if (
      options.provider === null ||
      connection === null ||
      connection.account_id !== intent['account_id'] ||
      // メールの読み取りが許可に含まれなければ、件名・差出人を読まない。
      !canRead(connection, 'mail.message') ||
      typeof target !== 'object' ||
      target === null
    )
      return null;
    const remoteId = (target as Record<string, unknown>)['remote_id'];
    if (typeof remoteId !== 'string') return null;
    try {
      const mail = await options.provider.readTarget(remoteId);
      if (mail === null) return null;
      return {
        subject: mail.subject ?? null,
        sender: mail.sender ?? null,
        received_at: mail.received_at ?? null,
      };
    } catch {
      return null;
    }
  };

  // Core が最後に確かめた連携の口座と許可の版（メモリーだけ）。provider から読むたびに更新する。
  // 発言の入力の時点の許可の版は、外部へ問い合わせずにこの値から取る（解釈の前に控える。QA27 の LocalCommand に
  // 外部の HTTP を作らないため。PR #107 のレビュー）。起動時に一度読んでおく（prime）。
  let observedPermission: InputPermission = null;

  const readPermission = async (accountId: string): Promise<string | null> => {
    if (options.provider === null) return null;
    try {
      const permission = await options.provider.readPermission(accountId);
      if (permission === null || permission.account_id !== accountId)
        return null;
      observedPermission = {
        account_id: accountId,
        permission_revision: permission.permission_revision,
      };
      return permission.permission_revision;
    } catch {
      return null;
    }
  };

  const planRead = async (
    intent: IntentName,
    args: ArgValues,
  ): Promise<TurnPlan> => {
    if (intent !== 'query_schedule') return clarify('unsupported', intent);
    const connection = await readConnection();
    // Read も権限を確かめる（QA27）: 接続が active で、予定の読み取りが許可に含まれること。
    if (
      options.provider === null ||
      connection === null ||
      !canRead(connection, 'calendar.events')
    )
      return clarify('connection', intent);
    const date = typeof args.start === 'string' ? args.start : today();
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(date))
      return clarify('invalid', intent);
    const dayStart = Date.parse(`${date}T00:00:00${options.utcOffset}`);
    if (!Number.isFinite(dayStart)) return clarify('invalid', intent);
    const dayEnd = dayStart + 86_400_000;
    let events;
    try {
      events = await options.provider.listEvents();
    } catch {
      return clarify('connection', intent);
    }
    const items: ScheduleItem[] = [];
    for (const event of events) {
      const start = Date.parse(event.start);
      const end = Date.parse(event.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        continue;
      if (start >= dayEnd || end <= dayStart) continue;
      items.push({
        id: derivedId(
          'buddy/calendar-event/v1',
          connection.provider,
          connection.account_id,
          event.event_id,
        ),
        start,
        end,
      });
    }
    items.sort(
      (a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    // 重なりは全件で計算し、返す参照は開始の順に上限まで（残りは more_count）。
    const overlapping = scheduleOverlaps(items);
    const shown = items.slice(0, MAX_SCHEDULE_ITEMS);
    return {
      kind: 'read',
      intent,
      items: [
        ...shown.map((item) => ({ kind: 'calendar_event', id: item.id })),
        ...shown
          .filter((item) => overlapping.has(item.id))
          .map((item) => ({ kind: 'calendar_overlap', id: item.id })),
      ],
      overlaps: overlapping.size > 0,
      more: items.length - shown.length,
    };
  };

  const readiness = (
    intent: IntentName,
    permissionCurrent: boolean,
    evidence: InputEvidence,
  ): { readonly state: 'blocked' | 'ok'; readonly full_text: boolean } => {
    const result = assessReadiness(
      { state: 'sealed', inputEvidence: evidence },
      intent,
      {
        utteranceHold: false,
        targetResolved: true,
        evidenceVerified: true,
        permissionCurrent,
        policyCurrent: true,
        // 安全停止の最終の判定は DB worker（送出意図の transaction）。作成では止めない。
        safetyStopped: false,
        autoPolicyAllows: policy.auto_execution[intent],
      },
    );
    // auto_eligible は方針表がすべて off なので起きない。起きても自動承認せず承認待ちで作る（B04-04）。
    // 方式 C（live_policy_observed）は、画面承認が要る・方針が自動実行を許さない操作を requires_full_text でここで止める
    // （承認待ちへ昇格させない。全文を画面で確かめてから。10 §5A）。
    return {
      state: result.state === 'blocked' ? 'blocked' : 'ok',
      full_text: result.reasonCodes.includes('requires_full_text'),
    };
  };

  const blocked = (
    result: { readonly full_text: boolean },
    intent: IntentName,
  ): TurnPlan => clarify(result.full_text ? 'full_text' : 'blocked', intent);

  // 入力の時点に控えた口座と許可の版から、今の接続の口座の入力の時点の版を取る（口座が違えば null）。
  const permissionOf = (
    input: InputPermission,
    accountId: string,
  ): string | null =>
    input !== null && input.account_id === accountId
      ? input.permission_revision
      : null;

  const planLabel = async (
    args: ArgValues,
    input: InputPermission,
    evidence: InputEvidence,
  ): Promise<TurnPlan> => {
    const intent: IntentName = 'label_mail';
    const add = (args.add_labels as readonly string[] | null) ?? [];
    const remove = (args.remove_labels as readonly string[] | null) ?? [];
    if (add.some((label) => remove.includes(label)))
      return clarify('invalid', intent);
    let candidates;
    try {
      candidates = await options.candidates.mailCandidates();
    } catch {
      candidates = [];
    }
    const candidate = candidates.find(
      (item) => item.candidate_id === args.target_candidate_id,
    );
    if (candidate === undefined || options.provider === null)
      return clarify('target_not_found', intent);
    const connection = await readConnection();
    if (
      connection === null ||
      connection.status !== 'active' ||
      !canWrite(connection, 'mail.labels.change') ||
      // 対象のメールを読む前に、メールの読み取りが許可に含まれることを確かめる。
      !canRead(connection, 'mail.message')
    )
      return clarify('connection', intent);
    let target;
    try {
      target = await options.provider.readTarget(candidate.remote_id);
    } catch {
      return clarify('connection', intent);
    }
    if (target === null || target.remote_id !== candidate.remote_id)
      return clarify('target_not_found', intent);
    const addEffective = add.filter((label) => !target.labels.includes(label));
    const removeEffective = remove.filter((label) =>
      target.labels.includes(label),
    );
    if (addEffective.length === 0 && removeEffective.length === 0)
      return clarify('no_change', intent);
    const permission = await readPermission(connection.account_id);
    if (permission === null) return clarify('connection', intent);
    // 入力の時点の許可の版と、確定の直前に読み直した許可の版が同じであること（10 §5A、ADR 0029）。
    // 入力の時点の版が分からない（起動の後にまだ確かめていない）ときも進めない。
    const ready = readiness(
      intent,
      permission === permissionOf(input, connection.account_id),
      evidence,
    );
    if (ready.state === 'blocked') return blocked(ready, intent);
    const operationId = randomUUID();
    return {
      kind: 'operation',
      intent,
      route: 'remote_mutation',
      operation_id: operationId,
      operation_kind: 'mail.labels.change',
      permission_revision: permission,
      content: {
        schema: 'buddy.operation.v1',
        operation_id: operationId,
        content_version: '1',
        permission_revision: permission,
        provider: connection.provider,
        account_id: connection.account_id,
        target: {
          remote_id: target.remote_id,
          source_revision: target.source_revision,
        },
        action: {
          kind: 'mail.labels.change',
          add: addEffective,
          remove: removeEffective,
        },
        effects: { external_recipients: [], reconcile_scope: 'exact_target' },
      },
    };
  };

  // 返信の下書きの保存（RemoteMutation、B04-07）。宛先は返信元の差出人、件名は返信元の件名に「Re: 」を付けた値で、
  // どちらも Core が provider の読み取りから決める（モデルに作らせない。ADR 0004）。本文だけを発言から取る。
  // CC は空。下書きは送らないので external_recipients は空で、照合は作成物の目印（operation_marker）。
  const planDraft = async (
    args: ArgValues,
    input: InputPermission,
    evidence: InputEvidence,
  ): Promise<TurnPlan> => {
    const intent: IntentName = 'draft_reply';
    const body = typeof args.body === 'string' ? args.body.trim() : '';
    if (body.length === 0) return clarify('missing_body', intent);
    let candidates;
    try {
      candidates = await options.candidates.mailCandidates();
    } catch {
      candidates = [];
    }
    const candidate = candidates.find(
      (item) => item.candidate_id === args.target_candidate_id,
    );
    if (candidate === undefined || options.provider === null)
      return clarify('target_not_found', intent);
    const connection = await readConnection();
    if (
      connection === null ||
      connection.status !== 'active' ||
      !canWrite(connection, 'mail.draft.create') ||
      // 返信元を読む前に、メールの読み取りが許可に含まれることを確かめる。
      !canRead(connection, 'mail.message')
    )
      return clarify('connection', intent);
    let target;
    try {
      target = await options.provider.readTarget(candidate.remote_id);
    } catch {
      return clarify('connection', intent);
    }
    if (target === null || target.remote_id !== candidate.remote_id)
      return clarify('target_not_found', intent);
    // 返信先（差出人）と件名が読めなければ、宛先と件名を決められないので作らない。
    const reply = replyFields(target);
    if (reply === null) return clarify('invalid', intent);
    const permission = await readPermission(connection.account_id);
    if (permission === null) return clarify('connection', intent);
    const ready = readiness(
      intent,
      permission === permissionOf(input, connection.account_id),
      evidence,
    );
    if (ready.state === 'blocked') return blocked(ready, intent);
    const operationId = randomUUID();
    return {
      kind: 'operation',
      intent,
      route: 'remote_mutation',
      operation_id: operationId,
      operation_kind: 'mail.draft.create',
      permission_revision: permission,
      content: {
        schema: 'buddy.operation.v1',
        operation_id: operationId,
        content_version: '1',
        permission_revision: permission,
        provider: connection.provider,
        account_id: connection.account_id,
        target: {
          remote_id: target.remote_id,
          source_revision: target.source_revision,
        },
        action: {
          kind: 'mail.draft.create',
          to: reply.to,
          cc: [],
          subject: reply.subject,
          body,
        },
        effects: {
          external_recipients: [],
          reconcile_scope: 'operation_marker',
        },
      },
    };
  };

  const planTask = (args: ArgValues, evidence: InputEvidence): TurnPlan => {
    const intent: IntentName = 'create_task';
    if (args.target_candidate_id !== null)
      return clarify('unsupported', intent);
    // 期限の地域日時は実在の日時に限る（契約の Schema は形だけを見る。日付だけの値は format: date で検査済み）。
    if (
      typeof args.due === 'string' &&
      args.due.includes('T') &&
      !isRealLocalDateTime(args.due)
    )
      return clarify('invalid', intent);
    const ready = readiness(intent, true, evidence);
    if (ready.state === 'blocked') return blocked(ready, intent);
    const operationId = randomUUID();
    return {
      kind: 'operation',
      intent,
      route: 'local_command',
      operation_id: operationId,
      operation_kind: 'task.create',
      permission_revision: policy.task_permission_revision,
      content: {
        schema: 'buddy.operation.v1',
        operation_id: operationId,
        content_version: '1',
        permission_revision: policy.task_permission_revision,
        target: { list_id: policy.task_list_id },
        action: {
          kind: 'task.create',
          title: args.title,
          due: args.due ?? null,
          body: args.body ?? null,
        },
        effects: {
          external_recipients: [],
          reconcile_scope: 'local_transaction',
        },
      },
    };
  };

  // 連携の provider を使う意図（Read と RemoteMutation）。これ以外（LocalCommand・聞き返し）では接続を照会しない
  // （QA27: LocalCommand に外部の HTTP がない。B04-07）。
  const PROVIDER_INTENTS: readonly IntentName[] = [
    'query_schedule',
    'label_mail',
    'draft_reply',
  ];

  // input: 発言を受けた時点（解釈の前）に控えた口座と許可の版。解釈の間に許可の版が変わっても、確定の直前の
  // 読み直しとの比較で気づける。evidence は入力の確かさ（文字入力は submitted_text、Live の方式 C は
  // live_policy_observed）。方式 C の入力は 4 操作でも readiness が全文の確定へ戻す。
  // 調査（research）を裏のジョブへ回す（U254、ADR 0135）。受付器が受け付けたときだけ accepted にする。受付器がない
  // 製品の起動では従来どおり「未対応」。確定前の入力（unverified）からは受け付けない（費用のかかる裏のジョブを、確定して
  // いない文字起こしから始めない）。保存期限の掃除のゲートが閉じている間も受け付けない（検索の入口。ADR 0053）。
  const planResearch = async (
    args: ArgValues,
    evidence: InputEvidence,
    intake: IntakeContext,
  ): Promise<TurnPlan> => {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (query.length === 0) return clarify('missing_other', 'research');
    const acceptor = options.backgroundJobs;
    if (acceptor === undefined) return clarify('unsupported', 'research');
    if (evidence === 'unverified') return clarify('blocked', 'research');
    if (options.retention !== undefined) {
      await options.retention.ready();
      const gate = options.retention.gate();
      if (!gate.search || !gate.cloud_send || !gate.auto_use)
        return clarify('blocked', 'research');
    }
    // 受付器の返す値は差し込み口の値なので、形を確かめるまで信用しない。
    let reply: unknown;
    try {
      reply = await acceptor.acceptResearch({
        workflow_id: intake.workflow_id,
        intent: 'research',
        query,
        session_id: intake.session_id,
        dedupe_key: intake.dedupe_key,
      });
    } catch {
      // 例外は受け付けていない側に倒す（受付の文を出さない。自動で再送しない）。
      return clarify('blocked', 'research');
    }
    // accepted で、ID が契約の Id の形のときだけ受け付けたと扱う。
    const acceptedId =
      typeof reply === 'object' &&
      reply !== null &&
      (reply as { readonly kind?: unknown }).kind === 'accepted'
        ? (reply as { readonly workflow_id?: unknown }).workflow_id
        : null;
    if (typeof acceptedId !== 'string' || !UUID_FORM.test(acceptedId))
      return clarify('blocked', 'research');
    return { kind: 'accepted', intent: 'research', workflow_id: acceptedId };
  };

  const planFrom = async (
    result: InterpretedTurn,
    input: InputPermission,
    evidence: InputEvidence,
    intake: IntakeContext,
  ): Promise<{
    readonly plan: TurnPlan;
    readonly permissionAtInput: string | null;
  }> => {
    if (result.kind === 'plan')
      return { plan: result.plan, permissionAtInput: null };
    const { intent, args } = result;
    // 方式 C（live_policy_observed）の全文の確定の判定は、対応する操作の分岐より前に行う。create_note・create_event のように
    // まだ作成に対応していない操作でも、既定では承認の対象を作らず全文の確定へ戻す（「未対応」と食い違わせない）。
    // 参照・文字入力・確定前の入力はここでは見ない。
    if (
      evidence === 'live_policy_observed' &&
      INTENT_POLICIES[intent].route !== 'read'
    ) {
      const early = readiness(intent, true, evidence);
      if (early.full_text)
        return { plan: blocked(early, intent), permissionAtInput: null };
    }
    // 雑談・一般の質問の返答文（U217）。文字で返す入力（submitted_text）だけ、検査を通った平文を答えにする。声の入力・
    // 検査に通らない文は、従来の「未対応」の聞き返しのまま（モデルの文を出さない）。実行・承認・読み取りの経路には入らない。
    if ((REPLY_TEXT_INTENTS as readonly string[]).includes(intent)) {
      const admitted = admitReplyText({
        intent,
        input_kind: evidence === 'submitted_text' ? 'text' : 'voice_live',
        reply_text: result.reply_text ?? null,
      });
      if (admitted.decision === 'show')
        return {
          plan: { kind: 'reply', intent, text: admitted.text },
          permissionAtInput: null,
        };
    }
    // 本人の明示の依頼の記憶（ADR 0191）。記憶の口がなければ従来どおり「未対応」。文字で確定した入力（submitted_text）だけ
    // 進める（memory_save・memory_correct は方式 C の対象外。確定前の入力からは保存しない）。保存の判定は発言の ID が決まる
    // recordTurn で行う。
    if (intent === 'memory_save' || intent === 'memory_correct') {
      if (options.memory === undefined || options.store.memory === undefined)
        return {
          plan: clarify('unsupported', intent),
          permissionAtInput: null,
        };
      if (evidence !== 'submitted_text')
        return { plan: clarify('full_text', intent), permissionAtInput: null };
      return {
        plan: {
          kind: 'memory',
          intent,
          memory_kind:
            typeof args.memory_kind === 'string'
              ? (args.memory_kind as MemoryKindName)
              : null,
          body: typeof args.body === 'string' ? args.body : '',
        },
        permissionAtInput: null,
      };
    }
    // 調査は参照（route: read）なので、上の方式 C の全文の確定の判定には当たらない。
    if (intent === 'research')
      return {
        plan: await planResearch(args, evidence, intake),
        permissionAtInput: null,
      };
    if (!PROVIDER_INTENTS.includes(intent))
      return {
        plan:
          intent === 'create_task'
            ? planTask(args, evidence)
            : clarify('unsupported', intent),
        permissionAtInput: null,
      };
    // 掃除が済むまで、検索（予定の照会）とクラウドへの送信（下書き・ラベル）を行わない（ADR 0043・0053）。
    // ゲートの確認と貸し出しの取得は同じ同期の区間で行い、検索・計画が終わるまで貸し出しを持つ。接続の確認や検索を
    // 待つ間に定期の掃除が始まっても、掃除の本体は貸し出しの返却を待つので、閉じたゲートを越えて検索しない。
    let release: (() => void) | null = null;
    if (options.retention !== undefined) {
      for (
        let attempt = 0;
        release === null && attempt < LEASE_ATTEMPTS;
        attempt += 1
      ) {
        await options.retention.ready();
        const gate = options.retention.gate();
        if (!gate.search || !gate.cloud_send || !gate.auto_use)
          return { plan: clarify('blocked', intent), permissionAtInput: null };
        // 取れないのは、ready の後に別の掃除が始まったとき。その掃除が済むのを待って確かめ直す。
        release = options.retention.lease();
      }
      if (release === null)
        return { plan: clarify('blocked', intent), permissionAtInput: null };
    }
    try {
      const plan =
        intent === 'query_schedule'
          ? await planRead(intent, args)
          : intent === 'label_mail'
            ? await planLabel(args, input, evidence)
            : await planDraft(args, input, evidence);
      return { plan, permissionAtInput: input?.permission_revision ?? null };
    } finally {
      release?.();
    }
  };

  // 解釈と、意図表・契約での引数の検査。聞き返しなら plan、通れば意図と引数を返す。
  // 解釈に渡した入力と本線の返答（影モードの比較用）。解釈の結果の object ごとに控える。
  const bases = new WeakMap<
    object,
    { context: InterpretationContext; reply: InterpreterReply }
  >();

  const interpretTurn = async (
    text: string,
    interpretOptions: {
      readonly open_workflows?: readonly OpenWorkflow[];
      readonly recent_turns?: InterpretationContext['recent_turns'];
    } = {},
  ): Promise<InterpretedTurn> => {
    const basis: {
      context?: InterpretationContext;
      reply?: InterpreterReply;
    } = {};
    const result = await interpretInner(text, interpretOptions, basis);
    if (basis.context !== undefined && basis.reply !== undefined)
      bases.set(result, { context: basis.context, reply: basis.reply });
    return result;
  };

  const interpretInner = async (
    text: string,
    interpretOptions: {
      readonly open_workflows?: readonly OpenWorkflow[];
      readonly recent_turns?: InterpretationContext['recent_turns'];
      readonly private?: true;
    },
    basis: { context?: InterpretationContext; reply?: InterpreterReply },
  ): Promise<InterpretedTurn> => {
    const done = (plan: TurnPlan) => ({ kind: 'plan' as const, plan });
    let candidates;
    try {
      candidates = await options.candidates.mailCandidates();
    } catch {
      candidates = [];
    }
    let reply;
    const context: InterpretationContext = {
      text,
      today: today(),
      mail_candidates: candidates,
      ...(interpretOptions.open_workflows === undefined
        ? {}
        : { open_workflows: interpretOptions.open_workflows }),
      ...(interpretOptions.recent_turns === undefined
        ? {}
        : { recent_turns: interpretOptions.recent_turns }),
      ...(interpretOptions.private === true ? { private: true as const } : {}),
    };
    try {
      reply = await options.interpreter.interpret(context);
    } catch {
      return done(clarify('unclear', null));
    }
    basis.context = context;
    basis.reply = reply;
    // 判定の失敗は「意図が不明」と混ぜず、別の聞き返しにする（実行へは進まない。QA02・QA03）。
    if (reply !== null && typeof reply === 'object' && reply.kind === 'failed')
      return done(
        clarify(
          [
            'timeout',
            'unavailable',
            'budget_denied',
            'cancelled',
            'stale',
          ].includes(reply.failure)
            ? 'model_unavailable'
            : 'model_invalid',
          null,
        ),
      );
    // 意図は分からないが、直前の依頼の取消・訂正・補足だと答えた: 意図は作らず、関係だけを保つ（実行へは進まない）。
    if (
      reply !== null &&
      typeof reply === 'object' &&
      reply.kind === 'unclear' &&
      (['clarification', 'correction', 'cancel'] as const).some(
        (value) => value === reply.relation,
      )
    )
      return {
        kind: 'plan',
        plan: clarify('unclear', null),
        relation: reply.relation as HoldRelation,
        target_workflow_id:
          typeof reply.target_workflow_id === 'string' &&
          reply.target_workflow_id.length > 0
            ? reply.target_workflow_id
            : null,
      };
    // 解釈の結果を信用しない: 意図表にない意図・契約に合わない引数は知らない文と同じ扱い。
    if (
      reply === null ||
      typeof reply !== 'object' ||
      reply.kind !== 'intent' ||
      !(INTENT_NAMES as readonly string[]).includes(reply.intent) ||
      reply.intent === 'unclear' ||
      !contract.valid('IntentArgs', reply.args)
    )
      return done(clarify('unclear', null));
    const intent = reply.intent as IntentName;
    const args = reply.args as unknown as ArgValues;
    const checked = checkIntentArgs(intent, args);
    if (checked.missing.length > 0)
      return done(
        clarify(
          checked.missing.includes('target_candidate_id')
            ? 'missing_target'
            : checked.missing.includes('title')
              ? 'missing_title'
              : 'missing_other',
          intent,
        ),
      );
    if (checked.unexpected.length > 0) return done(clarify('invalid', intent));
    // 直前の依頼との関係は信用しない。知っている値で、対象の ID が文字のときだけ使う（なければ unknown）。
    const relation: HoldRelation =
      (['new', 'clarification', 'correction', 'cancel'] as const).find(
        (value) => value === reply.relation,
      ) ?? 'unknown';
    const target =
      typeof reply.target_workflow_id === 'string' &&
      reply.target_workflow_id.length > 0
        ? reply.target_workflow_id
        : null;
    return {
      kind: 'intent',
      intent,
      args,
      relation,
      target_workflow_id: target,
      // 返答文は表示の対象の意図だけ持つ（他の意図の値は捨てる）。
      reply_text:
        (REPLY_TEXT_INTENTS as readonly string[]).includes(intent) &&
        typeof reply.reply_text === 'string'
          ? reply.reply_text
          : null,
    };
  };

  const workflowState = (plan: TurnPlan): WorkflowState | null => {
    // 会話の操作は依頼ではない（workflow を作らない）。
    if (plan.kind === 'session_control') return null;
    if (
      plan.kind === 'read' ||
      plan.kind === 'reply' ||
      plan.kind === 'memory' ||
      plan.kind === 'memory_done'
    )
      return 'done';
    if (plan.kind === 'operation') return 'ready';
    // 裏のジョブが受け付けた依頼は実行中（表の executing。ADR 0135）。
    if (plan.kind === 'accepted') return 'executing';
    return plan.intent === null ? null : 'clarifying';
  };

  // 確定 intent を契約で確かめて暗号化する。操作は発言と同じ transaction（turn.record）で作る。
  const sealOperation = (
    plan: Extract<TurnPlan, { kind: 'operation' }>,
    key: DataKeyMaterial,
  ): TurnOperationInput | null => {
    if (!contract.valid('OperationIntent', plan.content)) return null;
    const sealed = sealOperationIntent(
      key,
      { operationId: plan.operation_id, contentVersion: 1 },
      plan.content,
    );
    if (!sealed.ok) return null;
    return {
      operation_id: plan.operation_id,
      operation_kind: plan.operation_kind,
      effect_route: plan.route,
      content_hash: sealed.content_hash,
      intent: sealed.intent,
    };
  };

  // 発言の応答の本文（保存する発言と、記録しない区切りの RAM の発言で共通。ADR 0190）。
  const turnResponseBody = (args: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly inputId: string;
    readonly workflowId: string | null;
    readonly plan: TurnPlan;
  }) => {
    const { requestId, sessionId, turnId, inputId, workflowId, plan } = args;
    const view = (
      intent: IntentName,
      kind: string,
      status: string,
      itemRefs: readonly object[],
      moreCount = 0,
    ) =>
      workflowId === null
        ? null
        : {
            workflow_id: workflowId,
            request_revision: '1',
            intent,
            kind,
            status,
            item_refs: itemRefs,
            more_count: moreCount,
            template_id: null,
            template_version: null,
          };
    const responseOf = (
      status: 'answered' | 'clarification' | 'session_control' | 'background',
      resultView: object | null,
      replyText: string | null,
      sessionControl: SessionControlAction | null = null,
    ) => ({
      request_id: requestId,
      session_id: sessionId,
      turn_id: turnId,
      input_id: inputId,
      workflow_id: workflowId,
      status,
      result_view: resultView,
      reply_text: replyText,
      // 会話の操作のときだけ（それ以外は項目を持たない）。
      ...(sessionControl === null ? {} : { session_control: sessionControl }),
    });
    // 記憶の判定の結果（ADR 0191）。文は決まった文で、記憶の本文・ID を含めない（応答は平文の列に残る）。保存した・同じ内容が
    // あったは ready、保存しなかった（本人の対応が要る）は needs_review。判定の前の計画（memory）が届いたら保存していない。
    const memoryResponse = (
      memoryPlan: Extract<TurnPlan, { kind: 'memory' | 'memory_done' }>,
    ) => {
      const done: Extract<TurnPlan, { kind: 'memory_done' }> =
        memoryPlan.kind === 'memory_done'
          ? memoryPlan
          : {
              kind: 'memory_done',
              intent: memoryPlan.intent,
              memory_kind: memoryPlan.memory_kind,
              outcome: 'not_ready',
            };
      return responseOf(
        'answered',
        view(
          done.intent,
          'completion_line',
          done.outcome === 'saved' || done.outcome === 'duplicate'
            ? 'ready'
            : 'needs_review',
          [],
        ),
        memoryReplyText(done, options.memory?.forgetGate() ?? false),
      );
    };
    // 受け付けた調査の受付の文はコードの定型文（acceptedCommentary と同じ文）で、モデルの文ではないので、保存する応答にも
    // 残す（同じ要求の再送でも同じ応答）。
    return plan.kind === 'session_control'
      ? responseOf('session_control', null, null, plan.action)
      : plan.kind === 'clarify'
        ? responseOf(
            'clarification',
            plan.intent === null
              ? null
              : view(plan.intent, 'clarification', 'confirming_input', []),
            CLARIFY[plan.reason],
          )
        : plan.kind === 'reply'
          ? responseOf(
              'answered',
              view(plan.intent, 'speech_bubble', 'ready', []),
              plan.text,
            )
          : plan.kind === 'accepted'
            ? responseOf(
                'background',
                view(plan.intent, 'accepted_line', 'preparing', []),
                ACCEPTED_TEXT,
              )
            : plan.kind === 'memory' || plan.kind === 'memory_done'
              ? memoryResponse(plan)
              : plan.kind === 'read'
                ? responseOf(
                    'answered',
                    view(
                      plan.intent,
                      'schedule_cards',
                      plan.overlaps ? 'needs_review' : 'ready',
                      plan.items,
                      plan.more,
                    ),
                    null,
                  )
                : responseOf(
                    'answered',
                    view(plan.intent, 'approval_link', 'needs_review', [
                      { kind: 'operation', id: plan.operation_id },
                    ]),
                    null,
                  );
  };

  // 保存した応答を返す（同じ要求の再送）。読めなければ中枢側の保留。
  const storedResponse = (json: string, requestId: string) => {
    try {
      return { status: 200, body: JSON.parse(json) as object };
    } catch {
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    }
  };

  // 発言を保存して応答を作る（文字入力と Live の委譲の共通部）。計画（plan）はすでに作ってある。
  // 発言・依頼・入力スナップショット・受付・応答は DB worker の turn.record で一つの transaction に書く。
  // precommit が false を返したら保存せず held を返す（送出の直前の再検査。新しい発話の開始による保留）。
  const recordTurn = async (args: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly storageMode: 'normal' | 'extended';
    readonly ref: ConversationRequestRef;
    readonly text: string;
    readonly plan: TurnPlan;
    readonly permissionAtInput: string | null;
    readonly input?: TurnInputRecord;
    readonly workflowId?: string;
    readonly precommit?: () => boolean;
    // 処理を始めたときの区切りの由来（保存境界の保持者の区切りの ID と世代）。保存の直前に今の区切りと照合し、違えば
    // 保存しない（記録しない会話に入った・出た後に遅れて届いた結果。ADR 0045 の origin_stale・origin_private、ADR 0190）。
    readonly origin?: {
      readonly segment_id: string;
      readonly segment_generation: string;
    };
  }): Promise<
    | {
        readonly kind: 'done';
        readonly status: number;
        readonly body: object;
        readonly replayed: boolean;
        readonly plan: TurnPlan;
        // 保存した時点で確定した値（再送では null。保存していないものを新しい期限として扱わない）。
        readonly created_at: string | null;
        readonly expires_at: string | null;
        // 発言を保存したときの期限（UTC のミリ秒。影モードの比較に使う。保存した場合だけ）。
        readonly expires_at_ms?: number;
      }
    | { readonly kind: 'held' }
  > => {
    const { requestId, sessionId, ref, text } = args;
    let plan = args.plan;
    const fail = (status: number, body: object) =>
      ({
        kind: 'done',
        status,
        body,
        replayed: false,
        plan,
        created_at: null,
        expires_at: null,
      }) as const;
    const key = await loadKey();
    if (key === null) {
      const response = apiErrorResponse(
        503,
        'dependency_unavailable',
        requestId,
      );
      return fail(response.status, response.body);
    }
    let operation: TurnOperationInput | null = null;
    if (plan.kind === 'operation') {
      operation = sealOperation(plan, key);
      if (operation === null) plan = clarify('invalid', plan.intent);
    }
    const turnId = randomUUID();
    const inputId = randomUUID();
    const createdAt = now();
    const rule =
      RETENTION_RULES[
        args.storageMode === 'extended' ? 'turn_extended' : 'turn_normal'
      ];
    const sealed = sealBlob(key, Buffer.from(text, 'utf8'), {
      ownerTable: 'turns',
      ownerId: turnId,
      ownerVersion: 0,
      purpose: 'turn_text',
    });
    if (!sealed.ok || rule === undefined) {
      const response = apiErrorResponse(
        503,
        'dependency_unavailable',
        requestId,
      );
      return fail(response.status, response.body);
    }
    const expiresAt = createdAt + rule.ms;
    // 保存した時点で確定した値（応答の時点の時計では作り直さない）。
    const savedTimes = {
      created_at: utcTime(createdAt),
      expires_at: utcTime(expiresAt),
    };
    // 本人の明示の依頼の記憶（ADR 0191）。発言の ID が決まったここで判定し、保存するなら発言と同じ transaction へ渡す。
    let memory: TurnMemoryInput | undefined;
    if (plan.kind === 'memory') {
      const memoryOptions = options.memory;
      // 保存層の口は this を保ったまま渡す（DbWorkerClient のメソッドは私的なフィールドを使う）。
      const memoryStore = options.store.memory?.bind(options.store);
      if (memoryOptions === undefined || memoryStore === undefined)
        plan = clarify('unsupported', plan.intent);
      else {
        const decided = await planExplicitMemory(
          {
            store: { memory: memoryStore },
            ledgerKey: memoryOptions.ledgerKey,
            ...(memoryOptions.newId === undefined
              ? {}
              : { newId: memoryOptions.newId }),
          },
          {
            body: plan.body,
            memory_kind: plan.memory_kind,
            turn_id: turnId,
            private_conversation: options.storage.mode === 'private',
            data_key: key,
          },
        );
        if (decided.kind === 'save') memory = decided.memory;
        plan = {
          kind: 'memory_done',
          intent: plan.intent,
          memory_kind: plan.memory_kind,
          outcome: decided.kind === 'save' ? 'saved' : decided.reason,
        };
      }
    }
    const state = workflowState(plan);
    // 受け付けた調査は、受付器が返した ID で依頼を記録する（受付器と Core の依頼の ID を一致させる）。Live では提案した
    // ID（args.workflowId）と同じ値が返る想定だが、受付器の返した ID を正とする（同じ dedupe_key の最初の受付の ID）。
    const workflowId =
      state === null
        ? null
        : plan.kind === 'accepted'
          ? plan.workflow_id
          : (args.workflowId ?? randomUUID());
    let responseBody = turnResponseBody({
      requestId,
      sessionId,
      turnId,
      inputId,
      workflowId,
      plan,
    });
    // 送出の直前の再検査（新しい発話の開始による保留）。保存の直前に同期で確かめる（この後に await があるのは DB への
    // 送信だけで、保留は保存の命令を送る前に決める）。
    if (args.precommit !== undefined && !args.precommit())
      return { kind: 'held' };
    // 由来の照合（保存の直前に同期で行う。この後の await は DB への送信だけ）。処理の間に区切りが変わっていれば、結果を
    // 保存せず 409 にする（記録しない区切りに入った後に、通常の区切りの発言を保存しない）。
    if (args.origin !== undefined && !originCurrent(args.origin)) {
      const response = apiErrorResponse(409, 'conflict', requestId);
      return fail(response.status, response.body);
    }
    const record = (body: object, saving: TurnMemoryInput | undefined) =>
      store.conversation({
        kind: 'turn.record',
        session_id: sessionId,
        turn_id: turnId,
        input_id: inputId,
        text: {
          blob_id: randomUUID(),
          format_version: sealed.envelope.formatVersion,
          key_id: sealed.envelope.keyId,
          nonce: sealed.envelope.nonce,
          ciphertext: sealed.envelope.ciphertext,
          tag: sealed.envelope.tag,
        },
        created_at: createdAt,
        expires_at: createdAt + rule.ms,
        workflow:
          state === null || workflowId === null
            ? null
            : { workflow_id: workflowId, state },
        permission_revision: args.permissionAtInput ?? '0',
        request: ref,
        ...(args.input === undefined ? {} : { input: args.input }),
        operation,
        // 返答文はモデルの文なので、平文の列には残さない（再送の応答は返答文なしの同じ結果になる）。
        response_json: JSON.stringify(
          plan.kind === 'reply' ? { ...body, reply_text: null } : body,
        ),
        ...(saving === undefined ? {} : { memory: saving }),
      });
    let recorded = await record(responseBody, memory);
    // 保存層が記憶を拒否した（処理の間に設定・台帳・記憶が変わった。最後の保証）: 発言も書かれていないので、保存しなかった
    // 理由の応答で発言だけを記録し直す（記憶は保存しない）。
    if (
      !recorded.ok &&
      recorded.outcome === 'rejected' &&
      recorded.reasons[0] === 'memory_rejected' &&
      plan.kind === 'memory_done'
    ) {
      plan = {
        ...plan,
        outcome: storageRejectionReason(recorded.reasons.slice(1)),
      };
      responseBody = turnResponseBody({
        requestId,
        sessionId,
        turnId,
        inputId,
        workflowId,
        plan,
      });
      if (args.origin !== undefined && !originCurrent(args.origin)) {
        const response = apiErrorResponse(409, 'conflict', requestId);
        return fail(response.status, response.body);
      }
      recorded = await record(responseBody, undefined);
    }
    if (!recorded.ok) {
      const response = conversationError(recorded, requestId);
      return fail(response.status, response.body);
    }
    // 同時の再送で先に保存された発言があった: その応答を返す（この要求の計画は捨てる。操作は作っていない）。
    if (recorded.value.replayed) {
      const response = storedResponse(recorded.value.response_json, requestId);
      return {
        kind: 'done',
        status: response.status,
        body: response.body,
        replayed: true,
        plan,
        created_at: null,
        expires_at: null,
      };
    }
    if (operation !== null) options.onOperationCreated?.();
    return {
      kind: 'done',
      status: 200,
      body: responseBody,
      replayed: false,
      plan,
      ...savedTimes,
      expires_at_ms: createdAt + rule.ms,
    };
  };

  // 記録しない区切りの発言・応答・直前のやりとり（RAM だけ。B06-07a-2 の 2c、ADR 0190）。
  const privateRam = new PrivateConversationRam({
    utcOffset: options.utcOffset,
  });

  // 記録しない区切りの計画。参照（予定の照会など）・雑談の返事・聞き返しだけを作る。保存を伴う依頼（用事・記憶・承認待ちの
  // 外部の変更・裏の調査）は作らず、決まった文で断る（許可表の persist_workflow・save_memory・record_full_operation は
  // 禁止。外部の変更の独立した確認は 2d）。外部へは、意図の解釈と参照の読み取りだけを送る（通常の会話と同じ）。
  const privatePlan = async (
    interpreted: InterpretedTurn,
    intake: IntakeContext,
  ): Promise<TurnPlan> => {
    const refused = (intent: IntentName | null): boolean =>
      intent !== null &&
      (intent === 'research' || INTENT_POLICIES[intent].route !== 'read');
    // 解釈の段階の聞き返し（対象・題名の不足など）でも、保存を伴う依頼なら聞き返さずに断る（答えても進められない）。
    if (interpreted.kind === 'plan')
      return interpreted.plan.kind === 'clarify' &&
        refused(interpreted.plan.intent)
        ? clarify('private_unsupported', null)
        : interpreted.plan;
    if (refused(interpreted.intent))
      return clarify('private_unsupported', null);
    const planned = await planFrom(
      interpreted,
      observedPermission,
      'submitted_text',
      intake,
    );
    // 参照の経路から操作・裏の受付は作られないが、作られた場合も RAM の経路では持たない（安全側）。
    return planned.plan.kind === 'operation' ||
      planned.plan.kind === 'accepted' ||
      planned.plan.kind === 'memory' ||
      planned.plan.kind === 'memory_done'
      ? clarify('private_unsupported', null)
      : planned.plan;
  };

  const postPrivateTurn = async (
    request: ApiHandlerRequest,
    device: NonNullable<ApiHandlerRequest['device']>,
  ): Promise<{ status: number; body: object }> => {
    const body = request.body as JsonObject;
    const requestId = stringOf(body, 'request_id');
    // 端末内の音声認識・Live の文字起こしは、通常の区切りと同じくこの経路では受けない。
    if (stringOf(body, 'input_kind') !== 'text')
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    // 端末（流れの経路）が見ていた区切りが、今の記録しない区切り（保存境界の保持者の区切りの ID と世代）か。
    // 区切りの ID は保持者が作った値で、DB の会話ではない。
    const sessionId = request.params['session_id'] ?? '';
    const started = options.storage.origin();
    if (
      sessionId !== started.segment_id ||
      !originMatches(body['origin'], sessionId, started.segment_generation)
    )
      return apiErrorResponse(409, 'conflict', requestId);
    const segment = {
      segment_id: started.segment_id,
      segment_generation: started.segment_generation,
    };
    // 捨てた回数を控える（処理の間にロック・忘却・終了で捨てたら、結果を持たない）。
    const epoch = privateRam.epoch;
    privateRam.bind(segment, utcTime(now()));
    // 発言のたびに、期限（最後のやりとりから 30 分・日付の変更）を過ぎた直前のやりとりをメモリーから捨てる。
    privateRam.expire(segment, utcTime(now()));
    // 同じ要求の再送は RAM の控えの応答を返す（照合値が違えば 409）。受付レシート・応答は DB に書かない。
    const ref = requestRef(request, sessionId);
    const replay = privateRam.replay(segment, ref.command_id, ref.request_hash);
    if (replay.kind === 'same') return { status: 200, body: replay.body };
    if (replay.kind === 'conflict')
      return apiErrorResponse(409, 'conflict', requestId);
    // 同じ要求が処理中なら、その結果を待って同じ応答を返す（解釈・読み取りを外部へ 2 回送らない）。
    const running = privateRam.running(
      segment,
      ref.command_id,
      ref.request_hash,
    );
    if (running.kind === 'conflict')
      return apiErrorResponse(409, 'conflict', requestId);
    if (running.kind === 'same')
      return (await running.promise) as { status: number; body: object };
    const processing = processPrivateTurn({
      request,
      device,
      requestId,
      sessionId,
      segment,
      epoch,
      ref,
    });
    privateRam.track(ref.command_id, ref.request_hash, processing);
    return processing;
  };

  const processPrivateTurn = async (args: {
    readonly request: ApiHandlerRequest;
    readonly device: NonNullable<ApiHandlerRequest['device']>;
    readonly requestId: string;
    readonly sessionId: string;
    readonly segment: {
      readonly segment_id: string;
      readonly segment_generation: string;
    };
    readonly epoch: number;
    readonly ref: ConversationRequestRef;
  }): Promise<{ status: number; body: object }> => {
    const { request, device, requestId, sessionId, segment, epoch, ref } = args;
    const body = request.body as JsonObject;
    const text = stringOf(body, 'text');
    const control = resolveSessionControl(text, SESSION_CONTROL_TABLE, 'text');
    let plan: TurnPlan;
    if (control !== null)
      plan = { kind: 'session_control', action: control.action };
    else {
      // 直前のやりとり（30 分・日付の変更を過ぎていれば空）を解釈の入力に添える。影モードの比較の控え（bases）には入れない
      // （記録しない会話では影モードの記録を作らない。X48）。
      // 外部へ送る入力には「記録しない会話」の目印を付ける（provider 側の保持の設定は B10 でこの目印を使う。ADR 0190）。
      const interpreted = await interpretInner(
        text,
        {
          recent_turns: privateRam.recent(segment, utcTime(now())),
          private: true,
        },
        {},
      );
      plan = await privatePlan(interpreted, {
        dedupe_key: ref.command_id,
        session_id: sessionId,
        workflow_id: randomUUID(),
      });
    }
    // 処理の間に記録しない区切りを出た・入り直した・RAM を捨てた（ロック・忘却）なら、結果を持たずに断る（遅れて届いた結果を
    // 次の区切りへ持ち込まない。ADR 0045 の origin_private）。
    if (
      options.storage.mode !== 'private' ||
      !originCurrent(segment) ||
      privateRam.epoch !== epoch
    )
      return apiErrorResponse(409, 'conflict', requestId);
    const state = workflowState(plan);
    const response = turnResponseBody({
      requestId,
      sessionId,
      turnId: randomUUID(),
      inputId: randomUUID(),
      workflowId: state === null ? null : randomUUID(),
      plan,
    });
    const held = privateRam.hold({
      segment,
      epoch,
      key: ref.command_id,
      hash: ref.request_hash,
      body: response,
      user_text: text,
      buddy_text: response.reply_text,
      at: utcTime(now()),
    });
    if (!held) return apiErrorResponse(409, 'conflict', requestId);
    // 会話の操作は、その端末の開いている Live へも行う（記録しない間は Live を開かないので、多くは何もしない）。
    if (control !== null)
      options.onSessionControl?.({
        device_id: device.device_id,
        session_id: sessionId,
        action: control.action,
      });
    return { status: 200, body: response };
  };

  const postTurn: ApiRouteHandler = async (request) => {
    // 入力の時点の口座と許可の版は、最初の await より前に Core のメモリーから控える（外部へ問い合わせない）。
    // DB の照会を待つ間に別の要求が値を更新しても、発言を受けた時点の値で比べる（PR #107 の再々レビュー）。
    const input = observedPermission;
    const device = request.device;
    const body = request.body as JsonObject;
    const requestId = stringOf(body, 'request_id');
    if (device === null) return apiErrorResponse(401, 'unauthenticated');
    // 記録しない区切りの間は DB の sessions を引かず、RAM の経路で受けて答える（流れの経路は private の会話を作らない。
    // ADR 0060。RAM の保持は B06-07a-2 の 2c、ADR 0190）。
    if (options.storage.mode === 'private')
      return postPrivateTurn(request, device);
    // 端末内の音声認識（local_asr）の入力は音声の区間と世代の照合が要る（B06）。B04-03 は文字入力だけ。
    // Live の文字起こし（voice_live）は端末のこの経路では受け付けない（中枢がサイドバンドで受ける。X49）。
    if (stringOf(body, 'input_kind') !== 'text')
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const sessionId = request.params['session_id'] ?? '';
    const session = await store.conversation({
      kind: 'session.get',
      session_id: sessionId,
    });
    if (!session.ok) return conversationError(session, requestId);
    if (session.value === null || session.value.ended_at !== null)
      return apiErrorResponse(409, 'conflict', requestId);
    // 再送の判定は解釈より先（保存済みの応答をそのまま返し、解釈・意味検証をやり直さない）。
    // 保存済みの受付は、区切りの世代が進んだ後（private の出入り）でも同じ要求なら返せるよう、由来の照合より先に見る。
    // 新しい要求（保存済みの受付がない）は、下の由来の照合を通らないと進めない。
    const ref = requestRef(request, sessionId);
    const found = await store.conversation({ kind: 'turn.find', request: ref });
    if (!found.ok) return conversationError(found, requestId);
    if (found.value !== null)
      return storedResponse(found.value.response_json, requestId);
    // 端末が見ていた区切りが今のものか（会話の ID と世代）。会話ごとの控えと、今の区切りの両方に
    // 一致するときだけ保存する。再起動・壊れた境界からの復旧で区切りが変わると、前の会話の控えは
    // 今の区切りと一致しない（世代が 1 に戻っても通らない）。
    const expected = sessionOrigins.get(sessionId);
    const current = options.storage.origin();
    if (
      expected === undefined ||
      expected.gate_segment_id !== current.segment_id ||
      expected.generation !== current.segment_generation ||
      !originMatches(body['origin'], sessionId, current.segment_generation)
    )
      return apiErrorResponse(409, 'conflict', requestId);
    const text = stringOf(body, 'text');
    // 会話の操作（照合表に全体が一致した短い発話）は、LLM を呼ばず、依頼も作らない（10 §5、X58）。
    const control = resolveSessionControl(text, SESSION_CONTROL_TABLE, 'text');
    // 記録する入力の時点の許可の版は provider を使う意図だけで、連携の接続がない・使わないなら 0 として記録する。
    const interpreted = control === null ? await interpretTurn(text) : null;
    const planned: {
      readonly plan: TurnPlan;
      readonly permissionAtInput: string | null;
    } =
      control !== null
        ? {
            plan: { kind: 'session_control', action: control.action },
            permissionAtInput: null,
          }
        : await planFrom(
            interpreted ?? { kind: 'plan', plan: clarify('unclear', null) },
            input,
            'submitted_text',
            // 裏のジョブの受付は要求の command_id で重複を見分ける（同じ request_id の同時の再送でもジョブは 1 つ）。
            {
              dedupe_key: ref.command_id,
              session_id: sessionId,
              workflow_id: randomUUID(),
            },
          );
    const done = await recordTurn({
      requestId,
      sessionId,
      storageMode: session.value.storage_mode,
      ref,
      text,
      plan: planned.plan,
      permissionAtInput: planned.permissionAtInput,
      origin: {
        segment_id: current.segment_id,
        segment_generation: current.segment_generation,
      },
    });
    if (done.kind === 'held')
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    // 保存した時点で確定した生成の時刻と期限を、流れの区切りへ渡す（UI-05。再送では渡さない）。
    if (done.status === 200 && !done.replayed && done.expires_at !== null)
      options.onTurnRecorded?.({
        session_id: sessionId,
        turn_id: (done.body as TurnResponse).turn_id,
        created_at: done.created_at as string,
        expires_at: done.expires_at,
      });
    if (
      control !== null &&
      done.status === 200 &&
      !done.replayed &&
      done.plan.kind === 'session_control'
    )
      options.onSessionControl?.({
        device_id: device.device_id,
        session_id: sessionId,
        action: done.plan.action,
      });
    // 影モードの比較の入口。保存した発言（再送でない）の解釈だけを渡し、本線の応答を待たせない。
    const basis = interpreted === null ? undefined : bases.get(interpreted);
    if (
      options.onInterpreted !== undefined &&
      basis !== undefined &&
      done.status === 200 &&
      !done.replayed &&
      done.expires_at_ms !== undefined
    ) {
      try {
        options.onInterpreted({
          session_id: sessionId,
          storage_mode: session.value.storage_mode,
          input_id: stringOf(done.body as JsonObject, 'input_id'),
          request_revision: '1',
          turn_expires_at: done.expires_at_ms,
          context: basis.context,
          primary: basis.reply,
        });
      } catch {
        // 比較の失敗で発言の結果を変えない。
      }
    }
    return { status: done.status, body: done.body };
  };

  // Live の委譲（声）から、共通の workflow へ保存する（B05-05、ADR 0052）。入力の受付と方式 C の限定は呼び出し側
  // （LiveConversation）が先に済ませている。ここでも readiness が方式 C（live_policy_observed）を再検査し、4 操作でも
  // 画面承認・方針が自動実行を許さない操作は進めない（requires_full_text）。
  const commitLive = async (
    live: LiveCommitInput,
  ): Promise<LiveCommitResult> => {
    // 入力の時点の許可の版は、最初の await より前に控える（postTurn と同じ）。
    const permission = observedPermission;
    // 記録しない区切りの間は Live を開かない（ADR 0059）。開く前に始めた委譲が入った後に届いても保存しない。区切りの由来も
    // ここで控え、保存の直前に照合する（処理の間に入った・出たら保存しない。ADR 0190）。
    if (options.storage.mode === 'private')
      return { kind: 'failed', status: 409 };
    const liveOrigin = live.origin ?? options.storage.origin();
    if (!originCurrent(liveOrigin)) return { kind: 'failed', status: 409 };
    const session = await store.conversation({
      kind: 'session.get',
      session_id: live.session_id,
    });
    if (!session.ok) return { kind: 'failed', status: 503 };
    if (session.value === null || session.value.ended_at !== null)
      return { kind: 'failed', status: 409 };
    const ref: ConversationRequestRef = {
      command_scope_id: live.command_scope_id,
      request_id: live.request_id,
      request_hash: requestHash('liveDelegation', live.session_id, {
        identity: live.identity,
      }),
      command_id: deviceCommandId(live.command_scope_id, live.request_id),
    };
    const found = await store.conversation({ kind: 'turn.find', request: ref });
    if (!found.ok)
      return {
        kind: 'failed',
        status: found.reasons.includes('request_conflict') ? 409 : 503,
      };
    if (found.value !== null) {
      const stored = storedResponse(found.value.response_json, live.request_id);
      return stored.status === 200
        ? {
            kind: 'ok',
            turn: stored.body as TurnResponse,
            replayed: true,
            full_text: false,
          }
        : { kind: 'failed', status: stored.status };
    }
    let planned: {
      readonly plan: TurnPlan;
      readonly permissionAtInput: string | null;
    };
    const interpreted = live.interpreted;
    if (live.outcome === 'blocked')
      planned = { plan: clarify('blocked', null), permissionAtInput: null };
    else if (
      live.outcome === 'partial' &&
      interpreted.kind === 'intent' &&
      INTENT_POLICIES[interpreted.intent].route !== 'read'
    )
      // 確定前の入力から変更は進めない（外部へも問い合わせない）。
      planned = {
        plan: clarify('blocked', interpreted.intent),
        permissionAtInput: null,
      };
    else
      planned = await planFrom(
        interpreted,
        permission,
        live.outcome === 'sealed' ? 'live_policy_observed' : 'unverified',
        // Live が選んだ依頼の ID を提案し、記録する依頼と裏のジョブの ID をそろえる。
        {
          dedupe_key: ref.command_id,
          session_id: live.session_id,
          workflow_id: live.workflow_id,
        },
      );
    const outcome: TurnInputRecord = {
      kind: 'voice_live',
      audio_epoch: live.audio_epoch,
      outcome:
        live.outcome === 'sealed'
          ? { state: 'sealed', policy_version: live.policy_version }
          : { state: live.outcome },
    };
    const done = await recordTurn({
      requestId: live.request_id,
      sessionId: live.session_id,
      storageMode: session.value.storage_mode,
      ref,
      text: live.text,
      plan: planned.plan,
      permissionAtInput: planned.permissionAtInput,
      input: outcome,
      workflowId: live.workflow_id,
      precommit: live.precommit,
      origin: {
        segment_id: liveOrigin.segment_id,
        segment_generation: liveOrigin.segment_generation,
      },
    });
    if (done.kind === 'held') return { kind: 'held' };
    if (done.status !== 200) return { kind: 'failed', status: done.status };
    return {
      kind: 'ok',
      turn: done.body as TurnResponse,
      replayed: done.replayed,
      full_text:
        done.plan.kind === 'clarify' && done.plan.reason === 'full_text',
    };
  };

  // 操作の確定 intent を読んで開く（preview と display の共通部）。ない・内容が合わない・開けないときは応答を返す。
  const loadIntent = async (
    operationId: string,
    requestId: string,
    states: readonly string[] | null,
  ) => {
    const operation = await store.query({
      kind: 'operation_view',
      operation_id: operationId,
    });
    if (
      operation === null ||
      (states !== null && !states.includes(operation.state))
    )
      return { error: apiErrorResponse(409, 'conflict', requestId) } as const;
    const blob = await store.conversation({
      kind: 'operation.intent',
      operation_id: operationId,
      content_version: operation.current_content_version,
    });
    if (!blob.ok) return { error: conversationError(blob, requestId) } as const;
    if (
      blob.value === null ||
      blob.value.content_hash !== operation.content_hash
    )
      return { error: apiErrorResponse(409, 'conflict', requestId) } as const;
    const key = await loadKey();
    if (key === null)
      return {
        error: apiErrorResponse(503, 'dependency_unavailable', requestId),
      } as const;
    const opened = openOperationIntent(
      key,
      {
        operationId,
        contentVersion: Number(operation.current_content_version),
      },
      {
        formatVersion: blob.value.format_version,
        keyId: blob.value.key_id,
        nonce: blob.value.nonce,
        ciphertext: blob.value.ciphertext,
        tag: blob.value.tag,
      },
      operation.content_hash,
    );
    if (!opened.ok)
      return {
        error: apiErrorResponse(503, 'dependency_unavailable', requestId),
      } as const;
    const intent = JSON.parse(opened.canonical) as Record<string, unknown>;
    if (!contract.valid('OperationIntent', intent))
      return {
        error: apiErrorResponse(503, 'dependency_unavailable', requestId),
      } as const;
    return { operation, intent } as const;
  };

  const previewOperation: ApiRouteHandler = async (request) => {
    const device = request.device;
    const requestId = stringOf(request.body, 'request_id');
    if (device === null) return apiErrorResponse(401, 'unauthenticated');
    const operationId = request.params['id'] ?? '';
    // 承認待ちの操作だけ（承認の表示の準備）。それ以外は状態が変わった扱い。
    const loaded = await loadIntent(operationId, requestId, [
      'awaiting_approval',
    ]);
    if ('error' in loaded) return loaded.error;
    const { operation, intent } = loaded;
    // 外部変更は、今の接続が書込み可で、許可の版が確定 intent と同じときだけ preview を出す。
    let account: {
      account_id: string;
      permission_revision: string;
      operation_kind: string;
    } | null = null;
    // 承認画面で口座と対象のメールを見分ける表示用の値（provider から読む。読めない項目は null）。
    let display: {
      account_label: string | null;
      target: {
        subject: string | null;
        sender: string | null;
        received_at: string | null;
      } | null;
    } = { account_label: null, target: null };
    if (typeof intent['account_id'] === 'string') {
      const accountId = intent['account_id'];
      const connection = await readConnection();
      const permission = await readPermission(accountId);
      const actionKind = (intent['action'] as Record<string, unknown>)['kind'];
      if (
        connection === null ||
        connection.status !== 'active' ||
        typeof actionKind !== 'string' ||
        !canWrite(connection, actionKind) ||
        // 対象のメールを確かめられない（読み取りの範囲がない）なら、承認の表示を出さない。
        !canRead(connection, 'mail.message') ||
        connection.account_id !== accountId ||
        permission === null ||
        permission !== intent['permission_revision']
      )
        return apiErrorResponse(409, 'conflict', requestId);
      account = {
        account_id: accountId,
        permission_revision: permission,
        operation_kind: actionKind,
      };
      display = {
        account_label: connection.account_label ?? null,
        target: await readTargetDisplay(intent, connection),
      };
    }
    const previewId = randomUUID();
    previews.issue({
      preview_id: previewId,
      device_id: device.device_id,
      command_scope_id: stringOf(request.body, 'command_scope_id'),
      operation_id: operationId,
      content_version: operation.current_content_version,
      content_hash: operation.content_hash,
      account,
      issued_at: now(),
    });
    return {
      status: 200,
      body: {
        preview_id: previewId,
        intent,
        content_hash: operation.content_hash,
        state_revision: operation.state_revision,
        display,
      },
    };
  };

  // 操作の内容の表示用の読み取り（B04-05、ADR 0031）。取消・再試行の確認に出す見出しを、承認待ち以外の状態でも取り直せる
  // ようにする。読み取りだけで、preview は発行せず（古い preview を失効させない）、承認にも使えない。認可は preview と同じ
  // （端末トークン・自宅・接続範囲・ロック解除）。外部変更の口座の表示名・対象のメールは provider から読み、読めない項目は
  // null（接続が使えなくても内容は返す）。内容はこの応答だけで、イベント・スナップショットには入れない。
  const displayOperation: ApiRouteHandler = async (request) => {
    const device = request.device;
    const requestId = stringOf(request.body, 'request_id');
    if (device === null) return apiErrorResponse(401, 'unauthenticated');
    const loaded = await loadIntent(
      request.params['id'] ?? '',
      requestId,
      null,
    );
    if ('error' in loaded) return loaded.error;
    const { operation, intent } = loaded;
    let display: {
      account_label: string | null;
      target: {
        subject: string | null;
        sender: string | null;
        received_at: string | null;
      } | null;
    } = { account_label: null, target: null };
    if (typeof intent['account_id'] === 'string') {
      const connection = await readConnection();
      display = {
        account_label:
          connection !== null && connection.account_id === intent['account_id']
            ? (connection.account_label ?? null)
            : null,
        target: await readTargetDisplay(intent, connection),
      };
    }
    return {
      status: 200,
      body: {
        content_version: operation.current_content_version,
        content_hash: operation.content_hash,
        state_revision: operation.state_revision,
        intent,
        display,
      },
    };
  };

  // 承認のときの preview の照合（07 §3）。端末・接続範囲・操作・内容版・hash が発行したときと同じで、操作の今の
  // 内容版・hash とも同じこと。外部変更は、今の接続が書込み可で、許可の版が変わっていないこと。
  const previewValid: PreviewCheck = async (input) => {
    const binding = previews.get(input.preview_id);
    if (
      binding === null ||
      binding.device_id !== input.device_id ||
      binding.command_scope_id !== input.command_scope_id ||
      binding.operation_id !== input.operation_id ||
      binding.content_version !== input.content_version ||
      binding.content_hash !== input.content_hash
    )
      return false;
    // 非同期の照会の間に無効化（ロック・接続の終了・置き換え）されていないこと。登録は同じ値のまま残る
    // 限り有効で、消されたら同じ ID で戻ることはない（ID は使い捨て）。
    const alive = () => previews.get(input.preview_id) === binding;
    const operation = await store.query({
      kind: 'operation_view',
      operation_id: input.operation_id,
    });
    if (
      !alive() ||
      operation === null ||
      operation.current_content_version !== binding.content_version ||
      operation.content_hash !== binding.content_hash
    )
      return false;
    if (binding.account !== null) {
      const connection = await readConnection();
      // 書込み・読み取りの範囲は種類ごとに見る（許可の版が同じでも、その種類の範囲だけが外れうる）。
      if (
        connection === null ||
        connection.status !== 'active' ||
        !canWrite(connection, binding.account.operation_kind) ||
        !canRead(connection, 'mail.message') ||
        connection.account_id !== binding.account.account_id ||
        (await readPermission(binding.account.account_id)) !==
          binding.account.permission_revision
      )
        return false;
    }
    return alive();
  };

  return {
    handlers: { createSession, postTurn, previewOperation, displayOperation },
    privateConversation: {
      discard: (reason) => privateRam.discard(reason),
      held: () => privateRam.held(),
    },
    interpret: interpretTurn,
    commitLive,
    previewValid,
    previewCurrent: (previewId) => previews.get(previewId) !== null,
    // 起動の後に一度、連携の口座と許可の版を確かめておく（入力の時点の版を外部へ問い合わせずに持つため）。
    // 読めなくても起動は止めない（最初の外部変更の発言は聞き返しになり、そのときの読み取りで控え直す）。
    async prime() {
      const connection = await readConnection();
      if (connection !== null) await readPermission(connection.account_id);
    },
  };
}
