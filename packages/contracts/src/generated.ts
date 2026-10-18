// Generated from buddy.schema.json. Do not edit; run contracts:generate.

/**
 * B00初回範囲。全24意図や全APIの完成を表さない。
 */
export type BuddyContract =
  | InputSnapshot
  | LabelMailWireResponse
  | LabelMailInterpretation
  | ActionReadiness
  | LabelOperationIntent
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
      request_revision: Revision;
      transcript_revision: Revision | null;
      text: string;
      captured_at: UtcTime;
      state: 'sealed';
      sealReason: 'submitted_text';
      input_evidence: 'submitted_text';
      audio: null;
      policy_version: null;
    }
  | {
      schema: 'buddy.input.v1';
      input_id: Id;
      session_id: Id;
      workflow_id: Id;
      turn_id: Id;
      request_revision: Revision;
      transcript_revision: Revision | null;
      text: string;
      captured_at: UtcTime;
      state: 'sealed';
      sealReason: 'user_corrected';
      input_evidence: 'submitted_text';
      audio: null;
      policy_version: null;
    }
  | {
      schema: 'buddy.input.v1';
      input_id: Id;
      session_id: Id;
      workflow_id: Id;
      turn_id: Id;
      request_revision: Revision;
      transcript_revision: Revision;
      text: string;
      captured_at: UtcTime;
      state: 'sealed';
      sealReason: 'local_asr_segment';
      input_evidence: 'full_audio_segment';
      audio: AudioRange;
      policy_version: null;
    }
  | {
      schema: 'buddy.input.v1';
      input_id: Id;
      session_id: Id;
      workflow_id: Id;
      turn_id: Id;
      request_revision: Revision;
      transcript_revision: Revision;
      text: string;
      captured_at: UtcTime;
      state: 'sealed';
      sealReason: 'live_transcript_policy';
      input_evidence: 'live_policy_observed';
      audio: AudioRange;
      policy_version: Revision;
    }
  | {
      schema: 'buddy.input.v1';
      input_id: Id;
      session_id: Id;
      workflow_id: Id;
      turn_id: Id;
      request_revision: Revision;
      transcript_revision: Revision | null;
      text: string;
      captured_at: UtcTime;
      state: 'collecting' | 'end_candidate' | 'superseded' | 'blocked';
      sealReason: null;
      input_evidence:
        | 'submitted_text'
        | 'full_audio_segment'
        | 'live_policy_observed'
        | 'unverified';
      audio: AudioRange | null;
      policy_version: Revision | null;
    };
/**
 * B00初版のランダムUUID v4。認証情報ではない。
 */
export type Id = string;
/**
 * 非負整数の10進文字列。各フィールドの版の意味は互換ではない。
 */
export type Revision = string;
/**
 * UTC RFC 3339。元の地域時間と終日は別に扱う。
 */
export type UtcTime = string;
export type Hash = string;
/**
 * 受付ACKとdurable ACK。どちらも外部変更の成功ではない。
 */
export type CommandReceipt =
  | {
      request_id: Id;
      command_id: Id;
      operation_id: Id;
      state_revision: Revision;
      status: 'accepted';
      committed_state_revision: null;
    }
  | {
      request_id: Id;
      command_id: Id;
      operation_id: Id;
      state_revision: Revision;
      status: 'durable';
      committed_state_revision: Revision;
    };
/**
 * 通貨単位の百万分の一を整数文字列で表す。通貨変換はしない。
 */
export type Amount = string;

export interface AudioRange {
  audio_epoch: Id;
  first_frame_seq: Revision;
  last_frame_seq: Revision;
  start_sample: Revision;
  end_sample: Revision;
}
/**
 * 24意図のうち最初のlabel_mailプロファイルだけ。root object、全フィールド必須、欠落はnull。承認・effect_kind・状態・根拠をモデルに生成させない。
 */
export interface LabelMailWireResponse {
  intent: 'label_mail';
  target_candidate_id: Id | null;
  add_labels: string[] | null;
  remove_labels: string[] | null;
  relation: 'new' | 'clarification' | 'correction' | 'cancel';
  target_workflow_id: Id | null;
  reply_text: null;
  clarify_question: string | null;
  confidence: number;
}
/**
 * Coreの対象解決・意味検証後のみ作成可能。契約検証だけで検証済みにはならない。
 */
export interface LabelMailInterpretation {
  schema: 'buddy.interpretation.label-mail.v1';
  input_id: Id;
  workflow_id: Id;
  request_revision: Revision;
  intent: 'label_mail';
  relation: 'new' | 'clarification' | 'correction' | 'cancel';
  target_workflow_id: Id | null;
  args: {
    target_candidate_id: Id;
    add_labels: string[];
    remove_labels: string[];
  };
  /**
   * @minItems 1
   */
  evidence: [FieldEvidence, ...FieldEvidence[]];
}
export interface FieldEvidence {
  field: 'target_candidate_id' | 'add_labels' | 'remove_labels';
  input_id: Id;
  request_revision: Revision;
  quote: string;
  start_utf16: number;
  end_utf16: number;
}
/**
 * Core計算結果。auto_eligibleも最終transactionの再検査を省略しない。
 */
export interface ActionReadiness {
  workflow_id: Id;
  request_revision: Revision;
  state: 'blocked' | 'preview_only' | 'needs_approval' | 'auto_eligible';
  reason_codes: string[];
  policy_version: Revision;
  permission_revision: Revision;
}
/**
 * H01のラベル変更のみ。content_hashはこの確定intent全体のJCS+SHA-256。依頼ID・表示端末・state_revisionを混ぜない。
 */
export interface LabelOperationIntent {
  schema: 'buddy.operation.v1';
  operation_id: Id;
  content_version: Revision;
  permission_revision: Revision;
  provider: 'mock' | 'gmail' | 'microsoft_graph';
  account_id: Id;
  target: {
    remote_id: string;
    source_revision: string;
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
  state_revision: Revision;
}
export interface ApprovalRequest {
  request_id: Id;
  command_scope_id: Id;
  preview_id: Id;
  content_version: Revision;
  content_hash: Hash;
  expected_state_revision: Revision;
}
export interface StateCommand {
  request_id: Id;
  command_scope_id: Id;
  expected_state_revision: Revision;
}
/**
 * 最初のラベル変更用状態投影。allowed_actionsは表示補助であり、実行時の認可ではない。
 */
export interface OperationSnapshot {
  operation_id: Id;
  content_version: Revision;
  content_hash: Hash;
  state_revision: Revision;
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
  store_generation: Id;
  sequence: Revision;
  event_cursor: string;
  operation_id: Id;
  state_revision: Revision;
  event_type: 'operation.updated' | 'command.durable';
  occurred_at: UtcTime;
}
export interface EventPage {
  events: EventEnvelope[];
  event_cursor: string;
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
  budget_month: string;
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
