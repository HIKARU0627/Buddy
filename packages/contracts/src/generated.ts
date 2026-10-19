// Generated from buddy.schema.json. Do not edit; run contracts:generate.

/**
 * B00初回範囲。全24意図や全APIの完成を表さない。
 */
export type BuddyContract =
  | InputSnapshot
  | WireResponse
  | Interpretation
  | WorkflowRequest
  | WorkContext
  | ActionReadiness
  | OperationIntent
  | CommandContext
  | PreviewRequest
  | LabelPreview
  | ApprovalRequest
  | StateCommand
  | CommandReceipt
  | OperationSnapshot
  | EventEnvelope
  | EventPage
  | ApiError
  | BudgetReservation
  | CreditObservation
  | ModelEvaluationPlan;
/**
 * Coreが付与する入力根拠。LLMや端末の申告をそのまま信用しない。sealedだけでは実行許可にならない。
 */
export type InputSnapshot =
  | {
      schema: 'buddy.input.v1';
      input_id: Id;
      session_id: Id;
      workflow_id: Id;
      turn_id: Id;
      origin: 'typed';
      request_revision: RequestRevision;
      transcript_revision: TranscriptRevision | null;
      text: string;
      captured_at: UtcTime;
      state: 'sealed';
      seal_reason: 'submitted_text';
      input_evidence: 'submitted_text';
      audio: null;
      policy_version: null;
      permission_revision: PermissionRevision;
      forgetting_generation: ForgettingGeneration;
    }
  | {
      schema: 'buddy.input.v1';
      input_id: Id;
      session_id: Id;
      workflow_id: Id;
      turn_id: Id;
      origin: 'typed';
      request_revision: RequestRevision;
      transcript_revision: TranscriptRevision | null;
      text: string;
      captured_at: UtcTime;
      state: 'sealed';
      seal_reason: 'user_corrected';
      input_evidence: 'submitted_text';
      audio: null;
      policy_version: null;
      permission_revision: PermissionRevision;
      forgetting_generation: ForgettingGeneration;
    }
  | {
      schema: 'buddy.input.v1';
      input_id: Id;
      session_id: Id;
      workflow_id: Id;
      turn_id: Id;
      origin: 'local_asr';
      request_revision: RequestRevision;
      transcript_revision: TranscriptRevision;
      text: string;
      captured_at: UtcTime;
      state: 'sealed';
      seal_reason: 'local_asr_segment';
      input_evidence: 'full_audio_segment';
      audio: AudioRange;
      policy_version: null;
      permission_revision: PermissionRevision;
      forgetting_generation: ForgettingGeneration;
    }
  | {
      schema: 'buddy.input.v1';
      input_id: Id;
      session_id: Id;
      workflow_id: Id;
      turn_id: Id;
      origin: 'live_fragment';
      request_revision: RequestRevision;
      transcript_revision: TranscriptRevision;
      text: string;
      captured_at: UtcTime;
      state: 'sealed';
      seal_reason: 'live_transcript_policy';
      input_evidence: 'live_policy_observed';
      audio: AudioRange;
      policy_version: PolicyVersion;
      permission_revision: PermissionRevision;
      forgetting_generation: ForgettingGeneration;
    }
  | {
      schema: 'buddy.input.v1';
      input_id: Id;
      session_id: Id;
      workflow_id: Id;
      turn_id: Id;
      origin: 'typed' | 'local_asr' | 'live_fragment';
      request_revision: RequestRevision;
      transcript_revision: TranscriptRevision | null;
      text: string;
      captured_at: UtcTime;
      state: 'collecting' | 'end_candidate' | 'superseded' | 'blocked';
      seal_reason: null;
      input_evidence:
        | 'submitted_text'
        | 'full_audio_segment'
        | 'live_policy_observed'
        | 'unverified';
      audio: AudioRange | null;
      policy_version: PolicyVersion | null;
      permission_revision: PermissionRevision;
      forgetting_generation: ForgettingGeneration;
    };
/**
 * B00初版のランダムUUID v4。認証情報ではない。
 */
export type Id = string;
/**
 * 本人の依頼（入力）の版。訂正が一つの依頼に確定したときだけ上がる（設計 07 §1、10 §5A）。抽出した依頼の版とは別の型。
 */
export type RequestRevision = string;
/**
 * 文字起こしの版（設計 10 §5A）。
 */
export type TranscriptRevision = string;
/**
 * UTC の RFC 3339 表現。区切りは大文字の T と Z だけ。JavaScript の Date で扱えないうるう秒は拒否する。元の地域時間と終日は別に扱う。
 */
export type UtcTime = string;
/**
 * Buddy 側の許可設定の版（設計 07 §1、08 §1）。
 */
export type PermissionRevision = string;
/**
 * 忘却台帳の世代（設計 03、08 §1・§6）。
 */
export type ForgettingGeneration = string;
/**
 * 音声接続・収音区間の世代。再接続・端末交代で進める（設計 07 §1、10 §1A・§5A）。
 */
export type AudioEpoch = string;
/**
 * 連番・カウンタ（イベント連番、音声 frame 番号、sample 位置）。版ではない。
 */
export type Sequence = string;
/**
 * 自動実行などの方針の版（設計 08 §1）。
 */
export type PolicyVersion = string;
export type IntentName =
  | 'query_schedule'
  | 'query_mail'
  | 'query_tasks'
  | 'query_memory'
  | 'create_task'
  | 'create_note'
  | 'label_mail'
  | 'draft_reply'
  | 'create_event'
  | 'update_event'
  | 'send_mail'
  | 'trash_mail'
  | 'undo_action'
  | 'update_task'
  | 'research'
  | 'memory_save'
  | 'memory_forget'
  | 'memory_correct'
  | 'dev_status'
  | 'handoff_screen'
  | 'smalltalk'
  | 'general_question'
  | 'consult'
  | 'unclear';
/**
 * 日付だけ、または地域日時。日付だけの値を 23:59 などの時刻に変換しない（設計 11 §5 D15）。
 */
export type DateOrDateTime = LocalDate | LocalDateTime;
export type LocalDate = string;
/**
 * タイムゾーンなしの地域日時。タイムゾーンは本人の設定から Core が付ける（設計 11 §3）。実在の日時かは意味検査で確認する。
 */
export type LocalDateTime = string;
/**
 * 元サービスが返す対象の版（etag、履歴 ID など）。不透明な文字列で、大小比較しない（設計 07 §1、11 §3）。
 */
export type SourceRevision = string;
/**
 * 取得範囲（scope）の版（設計 11 §1A）。
 */
export type ScopeRevision = string;
/**
 * 同期の公開世代（設計 11 §1・§1A）。外部サービスの同時点 snapshot を意味しない。
 */
export type PublishedGeneration = string;
export type Hash = string;
/**
 * 結果の出力先とした会話接続の世代（設計 07 §5、08 §5）。
 */
export type SessionEpoch = string;
/**
 * 関連解析の判定の版（設計 11 §5B）。
 */
export type AnalysisRevision = string;
/**
 * 承認対象として確定した変更内容。B00 時点はラベル変更（H01）だけ。他の操作は後続で追加する。
 */
export type OperationIntent = LabelOperationIntent;
/**
 * 承認対象の内容版。宛先・本文・対象・影響・前提が変わったときだけ上がる（設計 07 §1、08 §1）。
 */
export type ContentVersion = string;
/**
 * 処理状態の更新番号。競合検査用で、内容が同じなら ContentVersion は変えない（設計 07 §1、08 §1）。
 */
export type StateRevision = string;
/**
 * 受付ACKとdurable ACK。どちらも外部変更の成功ではない。
 */
export type CommandReceipt =
  | {
      request_id: Id;
      command_id: Id;
      operation_id: Id;
      state_revision: StateRevision;
      status: 'accepted';
      committed_state_revision: null;
    }
  | {
      request_id: Id;
      command_id: Id;
      operation_id: Id;
      state_revision: StateRevision;
      status: 'durable';
      committed_state_revision: StateRevision;
    };
/**
 * DB の世代。通常の再起動では維持し、バックアップ復元・新規作成で新しい値にする。等値比較だけに使う（設計 07 §1・§4、ADR 0003）。
 */
export type StoreGeneration = string;
/**
 * 中枢が発行する不透明なイベント位置。認証の代わりにしない（設計 07 §4）。
 */
export type EventCursor = string;
/**
 * 暦月（予算月など）。
 */
export type YearMonth = string;
/**
 * 通貨単位の百万分の一を整数文字列で表す。通貨変換はしない。
 */
export type Amount = string;

export interface AudioRange {
  audio_epoch: AudioEpoch;
  first_frame_seq: Sequence;
  last_frame_seq: Sequence;
  start_sample: Sequence;
  end_sample: Sequence;
}
/**
 * モデルの生出力のローカル完全検証用（設計 10 §6A D15）。承認・effect_kind・実行経路・状態を持たない。provider へ送る wire schema は、ここから pattern・format を除いた部分集合を adapter が作る。confidence は観測値で、認可に使わない。
 */
export interface WireResponse {
  intent: IntentName;
  args: IntentArgs;
  relation: 'new' | 'clarification' | 'correction' | 'cancel';
  target_workflow_id: Id | null;
  reply_text: string | null;
  clarify_question: string | null;
  confidence: number;
}
/**
 * 24 意図共通の引数（ADR 0004）。全項目必須で、使わない項目は null。意図ごとの必須・許可は domain の意図表で検査する。対象 ID は Core が渡した候補から選ぶ。
 */
export interface IntentArgs {
  target_candidate_id: Id | null;
  start: DateOrDateTime | null;
  end: DateOrDateTime | null;
  due: DateOrDateTime | null;
  title: string | null;
  body: string | null;
  subject: string | null;
  add_labels: string[] | null;
  remove_labels: string[] | null;
  task_change: ('complete' | 'reschedule' | 'delete') | null;
  memory_kind:
    | ('preference' | 'goal' | 'person' | 'routine' | 'lexicon' | 'progress')
    | null;
  query: string | null;
  device_name: string | null;
}
/**
 * Core が対象解決と意味検証を終えた後だけ作る。schema に合格しただけでは検証済みにならない。
 */
export interface Interpretation {
  schema: 'buddy.interpretation.v1';
  input_id: Id;
  workflow_id: Id;
  request_revision: RequestRevision;
  intent: IntentName;
  relation: 'new' | 'clarification' | 'correction' | 'cancel';
  target_workflow_id: Id | null;
  args: IntentArgs;
  evidence: InputFieldEvidence[];
}
/**
 * 入力引数の根拠。位置は JavaScript の UTF-16 コード単位（ADR 0002）。抽出の根拠 FieldEvidence（設計 03・11、コードポイント）とは別の型（ADR 0003）。
 */
export interface InputFieldEvidence {
  field:
    | 'target_candidate_id'
    | 'start'
    | 'end'
    | 'due'
    | 'title'
    | 'body'
    | 'subject'
    | 'add_labels'
    | 'remove_labels'
    | 'task_change'
    | 'memory_kind'
    | 'query'
    | 'device_name';
  input_id: Id;
  request_revision: RequestRevision;
  quote: string;
  start_utf16: number;
  end_utf16: number;
}
/**
 * 一つの依頼の版（設計 10 §5A）。訂正・補足が一つの workflow に確定したときだけ版を上げ、別件は別の workflow にする。
 */
export interface WorkflowRequest {
  workflow_id: Id;
  request_revision: RequestRevision;
  supersedes_request_revision: RequestRevision | null;
  session_id: Id;
  turn_id: Id;
  input_id: Id;
  relation: 'new' | 'clarification' | 'correction' | 'cancel';
  state: 'active' | 'superseded' | 'cancelled' | 'completed';
  created_at: UtcTime;
}
/**
 * 非同期処理が参照した最小の集合（設計 08 §5 D15、11 §5B）。クラウド送信・保存・表示・commit の直前に共通の検査で現在値と照合する。
 */
export interface WorkContext {
  cause_id: Id;
  input: {
    input_id: Id;
    request_revision: RequestRevision;
  } | null;
  permission_revision: PermissionRevision;
  read_set: {
    source_id: string;
    source_revision: SourceRevision;
    expires_at: UtcTime;
    forgetting_generation: ForgettingGeneration;
  }[];
  query_scopes: {
    scope_id: Id;
    scope_revision: ScopeRevision;
    published_generation: PublishedGeneration;
    query_hash: Hash;
  }[];
  output: OutputTarget | null;
  related_analysis: {
    group_id: Id;
    analysis_revision: AnalysisRevision;
    source_set_hash: Hash;
    published_generation: PublishedGeneration;
  } | null;
}
/**
 * 入力時に固定した結果の出力先（設計 07 §5 D15）。音声は対象端末・接続世代・音声リースが有効なときだけ使う。
 */
export interface OutputTarget {
  mode: 'text' | 'voice';
  device_id: Id;
  session_epoch: SessionEpoch | null;
}
/**
 * 変更操作の実行可否を Core のコードが計算した結果（設計 10 §6A D15）。経路は意図表から決め、モデルや端末が指定しない。auto_eligible も最終 transaction の再検査を省略しない。
 */
export interface ActionReadiness {
  workflow_id: Id;
  request_revision: RequestRevision;
  reason_codes: string[];
  policy_version: PolicyVersion;
  permission_revision: PermissionRevision;
  route: 'local_command' | 'remote_mutation';
  state: 'blocked' | 'preview_only' | 'needs_approval' | 'auto_eligible';
}
/**
 * H01のラベル変更のみ。content_hashはこの確定intent全体のJCS+SHA-256。依頼ID・表示端末・state_revisionを混ぜない。
 */
export interface LabelOperationIntent {
  schema: 'buddy.operation.v1';
  operation_id: Id;
  content_version: ContentVersion;
  permission_revision: PermissionRevision;
  provider: 'mock' | 'gmail' | 'microsoft_graph';
  account_id: Id;
  target: {
    remote_id: string;
    source_revision: SourceRevision;
  };
  action: {
    kind: 'mail.labels.change';
    add: string[];
    remove: string[];
  };
  effects: {
    /**
     * @maxItems 0
     */
    external_recipients: [];
    reconcile_scope: 'exact_target';
  };
}
export interface CommandContext {
  request_id: Id;
  command_scope_id: Id;
}
export interface PreviewRequest {
  request_id: Id;
  command_scope_id: Id;
}
export interface LabelPreview {
  preview_id: Id;
  intent: LabelOperationIntent;
  content_hash: Hash;
  state_revision: StateRevision;
}
export interface ApprovalRequest {
  request_id: Id;
  command_scope_id: Id;
  preview_id: Id;
  content_version: ContentVersion;
  content_hash: Hash;
  expected_state_revision: StateRevision;
}
export interface StateCommand {
  request_id: Id;
  command_scope_id: Id;
  expected_state_revision: StateRevision;
}
/**
 * 最初のラベル変更用状態投影。allowed_actionsは表示補助であり、実行時の認可ではない。
 */
export interface OperationSnapshot {
  operation_id: Id;
  content_version: ContentVersion;
  content_hash: Hash;
  state_revision: StateRevision;
  state:
    | 'awaiting_approval'
    | 'approved'
    | 'preparing'
    | 'dispatching'
    | 'reconciling'
    | 'succeeded'
    | 'unknown_held'
    | 'not_executed'
    | 'cancelled'
    | 'superseded';
  approval_state: 'none' | 'valid' | 'revoked' | 'expired';
  allowed_actions: ('preview' | 'approve' | 'cancel' | 'reconcile' | 'retry')[];
  result: {
    status: 'confirmed_success' | 'confirmed_not_executed' | 'unknown';
    provider_receipt_id: string | null;
  } | null;
}
/**
 * 最初の操作通知のみ。本文、宛先、認証情報を含めない。カーソルは認証の代わりではない。
 */
export interface EventEnvelope {
  schema: 'buddy.event.v1';
  event_id: Id;
  store_generation: StoreGeneration;
  sequence: Sequence;
  event_cursor: EventCursor;
  operation_id: Id;
  state_revision: StateRevision;
  event_type: 'operation.updated' | 'command.durable';
  occurred_at: UtcTime;
}
export interface EventPage {
  events: EventEnvelope[];
  event_cursor: EventCursor;
  resnapshot_required: boolean;
}
export interface ApiError {
  code:
    | 'unauthenticated'
    | 'forbidden'
    | 'conflict'
    | 'expired_scope'
    | 'invalid_input'
    | 'budget_held'
    | 'rate_limited'
    | 'dependency_unavailable';
  message: string;
  request_id: Id | null;
}
/**
 * RとMは加算しない。R<=M、同一通貨、gross=credit+spend、未精算の保持は意味検査で確認。通常料金枠とクレジットは別。実費M超過も切り捨てず記録する。
 */
export interface BudgetReservation {
  reservation_id: Id;
  request_id: Id;
  profile_id: Id;
  price_version: string;
  budget_month: YearMonth;
  budget_scope:
    'conversation' | 'background' | 'search' | 'voice' | 'approved_overage';
  reserved_amount: Money;
  max_liability: Money;
  status: 'reserved' | 'usage_unknown' | 'settled';
  provider_reconciliation_id: string | null;
  actual_gross: Money | null;
  credit_applied: Money | null;
  additional_spend: Money | null;
  credit_cycle_id: string | null;
}
export interface Money {
  currency: string;
  amount: Amount;
}
/**
 * 残高の観測であり将来の利用保証ではない。取得APIや認証を規定しない。組織内共有消費・失効を別検査する。
 */
export interface CreditObservation {
  provider: 'anthropic';
  organization_ref: string;
  cycle_id: string;
  observed_at: UtcTime;
  expires_at: UtcTime;
  balance: Money | null;
  status: 'observed' | 'unknown' | 'expired';
  shared: boolean;
}
export interface ModelEvaluationPlan {
  schema: 'buddy.model-evaluation.v1';
  candidates: ModelCandidate[];
  automatic_upgrade: false;
  automatic_paid_fallback: false;
  prices_verified_at: UtcTime | null;
}
export interface ModelCandidate {
  candidate_id: string;
  provider: 'openai' | 'anthropic' | 'local';
  model: string;
  role:
    'voice' | 'intent' | 'background_text' | 'advanced_consult' | 'local_asr';
  priority: 'primary' | 'comparison';
  status: 'candidate';
  requires_explicit_request: boolean;
  activation: 'requires_evaluation';
}
