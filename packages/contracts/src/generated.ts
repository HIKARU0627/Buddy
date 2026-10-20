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
  | ModelEvaluationPlan
  | InteractionMode
  | ConversationContext
  | DelegationIntent
  | DelegationResult
  | PendingClarification
  | ResultView
  | AudioControl
  | Lease
  | LiveSessionRequest
  | LiveSessionAnswer
  | LiveSessionClose
  | LiveControlState
  | DeviceIOState
  | VoiceEvent
  | SessionControlPhrases
  | BudgetConfig
  | BudgetAdmissionRequest
  | BudgetAdmissionResult
  | BudgetTopUp
  | BudgetSettlement
  | ExtractionWire
  | ExtractionResult
  | RequestEntity
  | RelatedAnalysis
  | CandidateSnapshot
  | SyncBatch
  | SyncScopeState;
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
 * 予約行の版。追加予約（top-up）ごとに上がる（ADR 0006）。
 */
export type ReservationRevision = string;
/**
 * 暦月（予算月など）。
 */
export type YearMonth = string;
/**
 * 予算枠の ID（設定で決める。例: llm、llm.background）。個人の金額は設定の値に置き、契約には含めない。
 */
export type BudgetPoolId = string;
/**
 * 通貨単位の百万分の一を整数文字列で表す。通貨変換はしない。
 */
export type Amount = string;
/**
 * 入力と出力の組み合わせ（設計 10 §6A、D14）。④文字→音声は作らない。
 */
export type InteractionMode =
  | {
      input_kind: 'voice_live';
      output_mode: 'voice';
    }
  | {
      input_kind: 'text';
      output_mode: 'text';
    }
  | {
      input_kind: 'voice_local';
      output_mode: 'text';
    };
/**
 * 発言の入力の種類（設計 10 §4）。voice_live は GPT-Live-1 の文字起こし、voice_local は端末内の音声認識（③）、text は文字入力。
 */
export type InputKind = 'voice_live' | 'voice_local' | 'text';
/**
 * サイドバンド制御経路の世代（設計 10 §2A）。
 */
export type ControlEpoch = string;
/**
 * 結果の種類と画面部品（設計 10 §6A、ADR 0005）。
 */
export type ResultViewKind =
  | 'schedule_cards'
  | 'task_rows'
  | 'insight_rows'
  | 'mail_rows'
  | 'memory_rows'
  | 'completion_line'
  | 'approval_link'
  | 'clarification'
  | 'speech_bubble'
  | 'accepted_line'
  | 'status_line'
  | 'undo_list_link';
/**
 * 定型文の版。定型文はコードの部品として版管理する（設計 10 §5、§6A）。
 */
export type TemplateVersion = string;
/**
 * 停止命令（設計 10 §1A F03、02 停止）。現在の世代にだけ作用し、古い世代の開始・再生・ASR 結果・遅着 ACK では解除しない。理由ごとの再開条件は domain の表（ADR 0005）。会話の終了と処理の取消は別の命令。
 */
export type AudioControl =
  | {
      action: 'stop_playback';
      reason: 'user_stop' | 'barge_in';
      device_id: Id;
      scope: null;
      io_epoch: IoEpoch;
      audio_epoch: AudioEpoch | null;
      output_epoch: OutputEpoch;
      issued_by: 'device' | 'core';
      issued_at: UtcTime;
    }
  | {
      action: 'close_voice_session';
      reason:
        | 'silence'
        | 'output_mode_text'
        | 'budget_reached'
        | 'private_conversation'
        | 'conversation_ended'
        | 'device_move'
        | 'provider_failure'
        | 'sideband_lost';
      device_id: Id;
      scope: null;
      io_epoch: IoEpoch;
      audio_epoch: AudioEpoch;
      output_epoch: OutputEpoch;
      issued_by: 'device' | 'core';
      issued_at: UtcTime;
    }
  | {
      action: 'suspend_io';
      reason:
        | 'device_io_stop'
        | 'os_lock'
        | 'guest_mode'
        | 'global_stop'
        | 'device_revoked'
        | 'core_lease_lost';
      device_id: Id;
      scope: 'local' | 'guest' | 'global';
      io_epoch: IoEpoch;
      audio_epoch: AudioEpoch | null;
      output_epoch: OutputEpoch;
      issued_by: 'device' | 'core';
      issued_at: UtcTime;
    };
/**
 * 端末入出力の世代。進めた後は古い世代の要求・結果を拒否する（設計 10 §1A）。
 */
export type IoEpoch = string;
/**
 * 再生出力の世代。読み上げ停止で進める（設計 10 §1A）。
 */
export type OutputEpoch = string;
/**
 * 期限（設計 11 §3 D15、§5 D15、修正案 R03）。
 */
export type Deadline =
  | {
      kind: 'instant';
      local_datetime: LocalDateTime;
      zone: TimeZone;
      original_text: string;
    }
  | {
      kind: 'date';
      date: LocalDate;
      original_text: string;
    }
  | {
      kind: 'unresolved';
      reason:
        | 'missing_year'
        | 'missing_date'
        | 'relative'
        | 'conflict'
        | 'missing_zone';
      original_text: string;
    }
  | {
      kind: 'none';
    };
/**
 * IANA タイムゾーン名。実在の確認は意味検査で行う（設計 07 §1）。
 */
export type TimeZone = string;
/**
 * 抽出した依頼（request_entity）の版（設計 11 §5A）。本人の依頼の版 RequestRevision と同じ object に並べない。
 */
export type RequestEntityRevision = string;
/**
 * 同期の実行担当の世代（設計 11 §1A）。再起動で新しい担当になると上がり、旧担当の遅着ページ・公開要求を拒否する。
 */
export type ExecutorGeneration = string;

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
 * 予約 R と最大負担 M（設計 05 予約と最大負担の区別 F02、ADR 0006）。R と M は加算しない。予算月は受付時の元の月で、月替わりでも変えない。usage が不明なら R と M を保持する。released は provider へ送っていないことが記録上確実な場合だけ。実費が M を超えても切り捨てずに記録し、確認（overrun_reviewed）まで同じ枠の新規受付を止める。
 */
export interface BudgetReservation {
  reservation_id: Id;
  reservation_revision: ReservationRevision;
  request_id: Id;
  profile_id: Id;
  price_version: string;
  budget_month: YearMonth;
  pool_id: BudgetPoolId;
  reserved_amount: Money;
  max_liability: Money;
  status: 'reserved' | 'usage_unknown' | 'settled' | 'released';
  provider_reconciliation_id: string | null;
  actual_gross: Money | null;
  credit_applied: Money | null;
  additional_spend: Money | null;
  credit_cycle_id: string | null;
  approval_id: Id | null;
  overrun_reviewed: boolean;
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
/**
 * GPT-Live-1 の接続作成時に渡す会話文脈（設計 10 §4）。メール本文・予定の詳細・記憶の全文、個人のメールアドレスを入れない。記録しない会話では RAM だけに置く。
 */
export interface ConversationContext {
  schema: 'buddy.context.v1';
  session_id: Id;
  store_generation: StoreGeneration;
  summary: string | null;
  /**
   * @maxItems 6
   *
   * Items: 直近の発言。本人の発言は入力の種類を持ち、Buddy の発言は null。
   */
  recent_turns:
    | []
    | [
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
      ]
    | [
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
      ]
    | [
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
      ]
    | [
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
      ]
    | [
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
      ]
    | [
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
        {
          role: 'user' | 'buddy';
          text: string;
          at: UtcTime;
          input_kind: InputKind | null;
        },
      ];
  /**
   * @maxItems 10
   *
   * Items: 承認待ち・結果不明・新しい気づきの順に並べる。
   */
  active_items:
    | []
    | [
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
      ]
    | [
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
      ]
    | [
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
      ]
    | [
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
      ]
    | [
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
      ]
    | [
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
      ]
    | [
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
      ]
    | [
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
      ]
    | [
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
      ]
    | [
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
        {
          kind: 'candidate' | 'operation';
          id: Id;
          title: string;
          state: string;
        },
      ];
  directives_temporary: string[];
  directives_persistent: string[];
  /**
   * 会話中の端末。
   */
  device: {
    name: string;
    screen_available: boolean;
  };
  /**
   * 予算の目安。実際の予約・受付は Core が別に検査する。
   */
  budget_hint: {
    conversation_minutes_left: number | null;
    llm_state: 'normal' | 'saving' | 'stopped';
  };
}
/**
 * Live からの委譲の受付（設計 10 §5）。依頼の文字は含まない。対象の発話・文字起こしの版は Core が 5A 節の手順で確定する。delegation_id は provider の不透明な ID。
 */
export interface DelegationIntent {
  delegation_id: string;
  live_session_id: Id;
  session_id: Id;
  audio_epoch: AudioEpoch;
  control_epoch: ControlEpoch;
  offset_ms: number | null;
  received_at: UtcTime;
}
/**
 * 音声で返す委譲の結果（設計 10 §5・§6A、ADR 0005）。読み上げ文はコードの定型文だけから作る。1 回の追記は 400 トークン以内、最大 3 回で、超える分は画面に出す。出力先は音声に固定され、文字の依頼の結果には使わない。
 */
export interface DelegationResult {
  delegation_id: string;
  workflow_id: Id;
  request_revision: RequestRevision;
  live_session_id: Id;
  audio_epoch: AudioEpoch;
  output: OutputTarget;
  facts: ResultFact[];
  more_count: number;
  template_id: string;
  template_version: TemplateVersion;
  /**
   * @minItems 1
   * @maxItems 3
   */
  commentary_parts: [string] | [string, string] | [string, string, string];
}
/**
 * 構造化した事実の 1 項目。モデルが作った自由文を入れない。
 */
export interface ResultFact {
  kind: ResultViewKind;
  ref_id: Id | null;
  title: string | null;
  start: DateOrDateTime | null;
  end: DateOrDateTime | null;
  due: DateOrDateTime | null;
  count: number | null;
}
/**
 * 聞き返しの保留（設計 10 §5A-5）。回答は対象が一意な場合だけ元の依頼へ補完する。期限切れ・複数対象・話題転換では自動補完しない。記録しない会話では ram_only。
 */
export interface PendingClarification {
  workflow_id: Id;
  request_revision: RequestRevision;
  session_id: Id;
  intent: IntentName;
  /**
   * @minItems 1
   */
  missing_fields: [
    (
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
      | 'device_name'
    ),
    ...(
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
      | 'device_name'
    )[],
  ];
  original_args: IntentArgs;
  question: string;
  created_at: UtcTime;
  expires_at: UtcTime;
  persistence: 'session' | 'ram_only';
}
/**
 * 文字で返すときの結果表示。本文を複製しない。
 */
export interface ResultView {
  workflow_id: Id;
  request_revision: RequestRevision;
  intent: IntentName;
  kind: ResultViewKind;
  /**
   * 利用者に見せる状態（設計 01 いつも見える状態 D15）。内部の理由コードや API 名は見せない。
   */
  status:
    | 'ready'
    | 'needs_review'
    | 'confirming_input'
    | 'budget_held'
    | 'preparing'
    | 'reconciling'
    | 'unknown_result'
    | 'partial_success';
  /**
   * Items: 表示する対象の参照。本文は開いたときに許可範囲内で取得する。
   */
  item_refs: {
    kind: string;
    id: Id;
  }[];
  more_count: number;
  template_id: string | null;
  template_version: TemplateVersion | null;
}
/**
 * 音声・機密表示のリース（設計 07 §5、10 §2A）。端末は要求送信時の単調時計から期限を計算し、遅れた応答の受信時刻から足し直さない。heartbeat 2 秒・期限 6 秒は設計初期値。
 */
export interface Lease {
  lease_id: Id;
  kind: 'audio' | 'display';
  device_id: Id;
  core_instance_id: Id;
  command_scope_id: Id;
  io_epoch: IoEpoch;
  nonce: string;
  heartbeat_ms: number;
  ttl_ms: number;
}
/**
 * 端末の SDP offer で Live の接続を求める（設計 07 §2、10 §2）。音声所有権のある端末だけが呼べる。予算不足は 422、記録しない会話中は 409。
 */
export interface LiveSessionRequest {
  request_id: Id;
  command_scope_id: Id;
  session_id: Id;
  purpose: 'conversation' | 'notification';
  sdp_offer: string;
}
/**
 * 中枢が返す SDP answer。端末はサイドバンド接続済みのイベントを受けるまで送信トラックを無効にする（設計 10 §2）。OpenAI の資格情報は含めない。
 */
export interface LiveSessionAnswer {
  live_session_id: Id;
  purpose: 'conversation' | 'notification';
  sdp_answer: string;
  audio_epoch: AudioEpoch;
  control_epoch: ControlEpoch;
  session_epoch: SessionEpoch;
}
/**
 * 端末からの Live 終了の通知（設計 07 §2）。使用秒数が確認できるまで予約を精算済みにしない。
 */
export interface LiveSessionClose {
  request_id: Id;
  command_scope_id: Id;
  reason:
    | 'silence'
    | 'output_mode_text'
    | 'budget_reached'
    | 'private_conversation'
    | 'conversation_ended'
    | 'device_move'
    | 'provider_failure'
    | 'sideband_lost'
    | 'device_io_stop'
    | 'os_lock'
    | 'guest_mode'
    | 'global_stop'
    | 'device_revoked'
    | 'core_lease_lost';
  audio_epoch: AudioEpoch;
}
/**
 * Live のサイドバンド制御の状態（設計 10 §2A）。lost では新規委譲・読み上げ・送出前の変更を止める。終了や使用量が確認できなければ予約を保持する。
 */
export interface LiveControlState {
  live_session_id: Id;
  control_state: 'connecting' | 'ready' | 'lost' | 'closing' | 'closed';
  control_epoch: ControlEpoch;
  closure: 'open' | 'close_requested' | 'close_confirmed' | 'close_unconfirmed';
  usage_seconds: number | null;
  reservation_state: 'reserved' | 'held' | 'settled';
}
/**
 * 端末の入出力状態（設計 07 §2・§5、01 いつも見える状態）。ロック状態が取得できなければ解除済みと扱わない。
 */
export interface DeviceIOState {
  device_id: Id;
  io_epoch: IoEpoch;
  output_epoch: OutputEpoch;
  lock_state: 'unlocked' | 'locked' | 'unknown';
  stop_scope: 'none' | 'local' | 'guest' | 'global';
  input_permitted: boolean;
  voice_state:
    | 'waiting_wake_word'
    | 'conversation_live'
    | 'reading_aloud'
    | 'device_stopped'
    | 'global_stopped'
    | 'budget_voice_stopped'
    | 'private_voice_off'
    | 'listening_text_reply';
  output_mode: 'voice' | 'text';
  private_conversation: boolean;
  audio_lease_valid: boolean;
}
/**
 * 音声の制御イベント（設計 10 §2・§3・§7）。本文・文字起こし・認証情報を含めない。読み上げ要求は候補 ID だけを最大 5 件。
 */
export interface VoiceEvent {
  schema: 'buddy.voice-event.v1';
  event_id: Id;
  event_type:
    | 'sideband_connected'
    | 'delegation_processing'
    | 'delegation_backgrounded'
    | 'read_aloud_requested'
    | 'audio_control';
  device_id: Id;
  session_id: Id | null;
  live_session_id: Id | null;
  audio_epoch: AudioEpoch | null;
  control_epoch: ControlEpoch | null;
  /**
   * @maxItems 5
   */
  candidate_ids:
    | []
    | [Id]
    | [Id, Id]
    | [Id, Id, Id]
    | [Id, Id, Id, Id]
    | [Id, Id, Id, Id, Id];
  audio_control: AudioControl | null;
  occurred_at: UtcTime;
}
/**
 * 会話そのものの操作の照合表（設計 10 §5 v0.6、質問 126）。意図判定（LLM）に入れず、画面のボタンと同じ処理をする。版を管理する。
 */
export interface SessionControlPhrases {
  version: TemplateVersion;
  /**
   * @minItems 1
   *
   * Items: 短い発話の全体がこの言い回しに一致したときだけ使う。
   */
  phrases: [
    {
      phrase: string;
      action:
        | 'extend_silence'
        | 'stop_playback'
        | 'end_conversation'
        | 'start_private_conversation'
        | 'reply_in_text';
    },
    ...{
      phrase: string;
      action:
        | 'extend_silence'
        | 'stop_playback'
        | 'end_conversation'
        | 'start_private_conversation'
        | 'reply_in_text';
    }[],
  ];
}
/**
 * 実行時の予算設定（設計 05 F02、J17 の構造）。金額は本人の設定で、公開する契約・試験には合成値だけを使う。価格が確認されていない版の profile は受け付けない。
 */
export interface BudgetConfig {
  schema: 'buddy.budget-config.v1';
  currency: string;
  /**
   * @minItems 1
   */
  pools: [BudgetPool, ...BudgetPool[]];
  verified_price_versions: string[];
}
/**
 * 予算の枠。予約は葉の枠に計上し、受付時は祖先の枠もすべて検査する。requires_approval の枠（個別承認の超過枠）は承認 ID のある予約だけが使う。
 */
export interface BudgetPool {
  pool_id: BudgetPoolId;
  parent_pool_id: BudgetPoolId | null;
  limit: Money;
  requires_approval: boolean;
}
/**
 * 有料処理の受付要求。精算済み額＋未精算の R＋今回の R と、精算済み額＋未精算の M＋今回の M の両方が、経路上のすべての枠で上限以下のときだけ受け付ける。
 */
export interface BudgetAdmissionRequest {
  request_id: Id;
  pool_id: BudgetPoolId;
  budget_month: YearMonth;
  profile_id: Id;
  price_version: string;
  reserved_amount: Money;
  max_liability: Money;
  approval_id: Id | null;
}
/**
 * 受付の結果。予算不足のときに出力上限を無断で削らない。
 */
export interface BudgetAdmissionResult {
  request_id: Id;
  admitted: boolean;
  reason_codes: string[];
  reservation_id: Id | null;
}
/**
 * 追加予約。同じ予約行の R と M を増やし、追加分だけを受付検査する（ADR 0006）。
 */
export interface BudgetTopUp {
  reservation_id: Id;
  expected_reservation_revision: ReservationRevision;
  delta_reserved: Money;
  delta_max_liability: Money;
}
/**
 * 確定した usage による精算。request_id と provider の照合 ID で一度だけ適用し、元の月・元の枠に計上する。同じ値の再適用は変化なし、異なる値は競合。
 */
export interface BudgetSettlement {
  reservation_id: Id;
  request_id: Id;
  provider_reconciliation_id: string;
  actual_gross: Money;
  credit_applied: Money;
  additional_spend: Money;
  credit_cycle_id: string | null;
}
/**
 * メール 1 通の抽出でモデルが返す生の出力（設計 11 §3・§5B）。未読・切り詰め・位置・依頼 ID を持たない。依頼 0 件だけで取消・完了の解析を省かない。
 */
export interface ExtractionWire {
  language: 'ja' | 'en' | 'other';
  /**
   * Items: 依頼の候補。
   */
  requests: {
    kind: 'reply_required' | 'action_required' | 'fyi';
    summary: string;
    /**
     * モデルが返す期限。年が書かれていない日付は relative_unresolved とし、日時は null にする。
     */
    deadline: {
      resolution:
        'exact_datetime' | 'date_only' | 'relative_unresolved' | 'none';
      local_datetime: LocalDateTime | null;
      local_date: LocalDate | null;
      original_text: string | null;
      unresolved_reason:
        | (
            | 'missing_year'
            | 'missing_date'
            | 'relative'
            | 'conflict'
            | 'missing_zone'
          )
        | null;
    };
    evidence: SourceQuote[];
    in_quoted_text: boolean;
    confidence: 'low' | 'medium' | 'high';
  }[];
  /**
   * Items: 既存の依頼への変更の候補。request_entity_id をモデルに作らせない。
   */
  changes: {
    relation: 'new' | 'correction' | 'cancel' | 'complete' | 'uncertain';
    target_evidence: SourceQuote[];
    change_evidence: SourceQuote[];
    new_deadline: {
      resolution:
        'exact_datetime' | 'date_only' | 'relative_unresolved' | 'none';
      local_datetime: LocalDateTime | null;
      local_date: LocalDate | null;
      original_text: string | null;
      unresolved_reason:
        | (
            | 'missing_year'
            | 'missing_date'
            | 'relative'
            | 'conflict'
            | 'missing_zone'
          )
        | null;
    } | null;
  }[];
}
/**
 * モデルが返す根拠の引用（設計 11 §3）。位置はモデルに返させず、コードが該当版の抽出テキストで検索して付ける。
 */
export interface SourceQuote {
  part: 'subject' | 'body' | 'attachment';
  source_id: string;
  source_revision: SourceRevision;
  quote: string;
}
/**
 * Core が検証した抽出結果 v2（設計 11 §3 D15・§5B、ADR 0007）。同じ source_revision・profile・prompt・schema の結果は再利用できる。v1 の例を現行契約にしない。
 */
export interface ExtractionResult {
  schema: 'buddy.extraction.v2';
  source_account_id: Id;
  thread_id: string;
  message_id: string;
  source_revision: SourceRevision;
  profile_id: Id;
  prompt_hash: Hash;
  schema_hash: Hash;
  requests: ExtractedRequest[];
  changes: RequestChange[];
  completeness: SourceCompleteness;
}
/**
 * Core が検証した依頼。宛先と自動配信の判定はヘッダーからコードが決め、モデルに判定させない（設計 11 §3）。request_entity_id は 5A 節の規則で Core が解決し、一意に対応しなければ null。
 */
export interface ExtractedRequest {
  request_index: number;
  kind: 'reply_required' | 'action_required' | 'fyi';
  summary: string;
  deadline: Deadline;
  fields: FieldEvidence[];
  in_quoted_text: boolean;
  confidence_observed: 'low' | 'medium' | 'high';
  addressed_to_me: boolean;
  from_automated_sender: boolean;
  request_entity_id: Id | null;
  request_revision: RequestEntityRevision | null;
}
/**
 * 抽出の項目ごとの根拠（設計 03 データ表、11 §3 D15、ADR 0007）。入力引数の根拠 InputFieldEvidence とは別の型。モデルの自己申告 confidence を正答確率や承認権限に変換しない。
 */
export interface FieldEvidence {
  field: 'summary' | 'kind' | 'target' | 'deadline' | 'change';
  status: 'explicit' | 'derived' | 'missing' | 'conflicting' | 'unread';
  refs: SourceRef[];
  rule_id: string | null;
}
/**
 * Core が一意に照合できた根拠の位置。Unicode コードポイント単位で end は含まない（設計 11 §3、QA11）。位置を一意に決められない引用は照合未確定とし、ここには入れない。
 */
export interface SourceRef {
  source_id: string;
  source_revision: SourceRevision;
  quote: string;
  start: number;
  end: number;
}
/**
 * 既存の依頼への変更（設計 11 §5B F05）。取消・完了は期限なしでも表現できる。対象は根拠と一意性で Core が解決し、類似度だけで結び付けない。
 */
export interface RequestChange {
  relation: 'new' | 'correction' | 'cancel' | 'complete' | 'uncertain';
  target_request_entity_id: Id | null;
  resolution: 'resolved' | 'ambiguous' | 'unresolved';
  fields: FieldEvidence[];
  new_deadline: Deadline | null;
}
/**
 * 入力の完全性。モデルではなく入力を組み立てるコードが確定し、モデルに変更させない（設計 11 §3 D15）。
 */
export interface SourceCompleteness {
  /**
   * Items: 入力に使った根拠の版。
   */
  source_revisions: {
    source_id: string;
    source_revision: SourceRevision;
  }[];
  unread_source_ids: string[];
  truncated_source_ids: string[];
}
/**
 * 抽出した依頼の固定 ID と版（設計 11 §5A）。期限の変更は同じ ID で版を上げる。本人が取消を選んだ時点で再作成を抑止し、補償操作の結果不明中も再解析から作り直さない。
 */
export interface RequestEntity {
  request_entity_id: Id;
  request_revision: RequestEntityRevision;
  source_account_id: Id;
  thread_id: string;
  origin_message_id: string;
  anchor: SourceRef;
  state: 'active' | 'cancelled' | 'completed';
  recreation_suppressed: boolean;
  /**
   * Items: 自動作成した操作。同じ依頼・操作種別・対象につき一度だけ。
   */
  created_operations: {
    operation_kind:
      'create_task' | 'create_event' | 'label_mail' | 'draft_reply';
    operation_id: Id;
    account_id: Id;
    calendar_id: string | null;
  }[];
}
/**
 * 関連集合（同じ provider・アカウント・thread）の解析状態（設計 11 §5B F05）。列挙と必要な解析と関係の解決が揃うまで ready にしない。
 */
export interface RelatedAnalysis {
  group_id: Id;
  analysis_revision: AnalysisRevision;
  source_set_hash: Hash;
  published_generation: PublishedGeneration;
  plan_complete: boolean;
  status: 'ready' | 'pending' | 'blocked';
  /**
   * Items: 関連集合の必要ソース。除外は規則 ID 付きのときだけ。
   */
  sources: {
    source_id: string;
    source_revision: SourceRevision;
    state: 'analyzed' | 'pending' | 'unread' | 'failed' | 'excluded';
    rule_id: string | null;
  }[];
  unresolved_change_count: number;
}
/**
 * 気づきの候補（設計 11 §4・§5B）。メールの候補は対応済みかを断定しない。本文は持たず、抄録は暗号化した別の保存に置く。
 */
export interface CandidateSnapshot {
  candidate_id: Id;
  kind: 'schedule_overlap' | 'mail_deadline' | 'mail_reply' | 'research_done';
  state: 'new' | 'seen' | 'acted' | 'dismissed' | 'snoozed' | 'resolved';
  request_entity_id: Id | null;
  request_revision: RequestEntityRevision | null;
  source_revision: SourceRevision | null;
  notification_key: Hash;
  title: string;
  deadline: Deadline;
  initial_import: boolean;
  unread_partial: boolean;
  related_analysis: {
    group_id: Id;
    analysis_revision: AnalysisRevision;
    source_set_hash: Hash;
    published_generation: PublishedGeneration;
  } | null;
  operation_ids: Id[];
}
/**
 * 同期の 1 回の走査（設計 11 §1・§1A F04、03 データ表）。最初のページ取得から公開または abandoned まで、同じ取得集合で有効な走査は 1 件だけ。開始時の世代・watermark・cursor・担当世代を公開時に照合する。
 */
export interface SyncBatch {
  scan_id: Id;
  scope_id: Id;
  scope_revision: ScopeRevision;
  kind: 'incremental' | 'full';
  status: 'fetching' | 'staged' | 'validated' | 'published' | 'abandoned';
  scan_started_at: UtcTime;
  window_start: UtcTime;
  window_end: UtcTime;
  query_fingerprint: Hash;
  base_generation: PublishedGeneration;
  base_watermark: UtcTime | null;
  base_provider_cursor: string | null;
  executor_generation: ExecutorGeneration;
  page_cursor: string | null;
  diff_count: number | null;
}
/**
 * 取得集合（scope）ごとの同期状態（設計 11 §1・§1A）。watermark は走査の開始時刻で、後退させない。差分ゼロの公開では active_generation を進めない。
 */
export interface SyncScopeState {
  scope_id: Id;
  scope_revision: ScopeRevision;
  active_scan_id: Id | null;
  active_generation: PublishedGeneration;
  committed_watermark: UtcTime | null;
  provider_cursor: string | null;
  executor_generation: ExecutorGeneration;
  last_incremental_completed_at: UtcTime | null;
  last_full_reconciled_at: UtcTime | null;
  pending_incremental: boolean;
  pending_full: boolean;
  analysis_plan_complete_generation: PublishedGeneration | null;
}
