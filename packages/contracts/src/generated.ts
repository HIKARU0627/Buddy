// Generated from buddy.schema.json. Do not edit; run contracts:generate.

/**
 * B00 の契約（ADR 0002〜0011）。形式だけを表し、認可・状態遷移・意味の検査は domain と Core が行う。
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
  | SyncScopeState
  | MemoryCandidateWire
  | MemoryCandidate
  | MemoryRecord
  | ForgetLedgerEntry
  | UserDirective
  | DeploymentManifest
  | EvaluationResult
  | IntentShadowRecord
  | ShadowCampaignState
  | ShadowCampaignSummary
  | IntentEvalCase
  | Bootstrap
  | Snapshot
  | SessionCreateRequest
  | SessionReceipt
  | TurnRequest
  | TurnResponse
  | HandoffRequest
  | HandoffState
  | AutoActionList
  | SafetyResumeRequest
  | SafetyState
  | IoStopRequest
  | IoStopResult
  | IoResumeRequest
  | EventStreamMessage
  | PairingStartRequest
  | PairingSession
  | PairingClaimRequest
  | PairingClaim
  | PairingDecisionRequest
  | PairingTokenRequest
  | DeviceCredential
  | DeviceList
  | DeviceRevokeRequest
  | HomeFingerprint
  | HomeFingerprintReport
  | HomeNetworkStatus
  | HomeRegistrationRequest
  | HomeRegistration
  | ConnectionList
  | ConnectionSummary
  | OAuthStartRequest
  | OAuthStart
  | ConnectionTargetsRequest
  | ConnectionDisconnectRequest
  | DesktopIpcRequest
  | DesktopIpcResponse
  | DesktopIpcNotification
  | DesktopStatusBar;
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
 * OS のロック状態（設計 07 §2）。取得できなければ unknown とし、解除済みと扱わない。
 */
export type LockState = 'unlocked' | 'locked' | 'unknown';
/**
 * 入出力停止の範囲（設計 02 停止、07 §2・§5）。none は停止していない、local はこの端末、guest は来客モード、global は全体停止。来客モードと全体停止は全端末の入出力許可を止めるが、外部へ送った処理の取消ではない。
 */
export type IoStopScope = 'none' | 'local' | 'guest' | 'global';
/**
 * 状態欄の音声状態（設計 01 いつも見える状態）。呼びかけ待ち・会話中・読み上げ中・この端末では停止中・全体停止中・会話予算の上限で音声停止中・記録しない会話のため音声OFF・聞き取り中（文字で返す）。
 */
export type VoiceState =
  | 'waiting_wake_word'
  | 'conversation_live'
  | 'reading_aloud'
  | 'device_stopped'
  | 'global_stopped'
  | 'budget_voice_stopped'
  | 'private_voice_off'
  | 'listening_text_reply';
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
/**
 * 要約記憶の種類（設計 11 §7）。保存できるのは本人が初期設定で許可した種類だけ。
 */
export type MemoryKind =
  'preference' | 'goal' | 'person' | 'routine' | 'lexicon' | 'progress';
/**
 * 採否を決める用途（設計 05 評価の進め方）。全用途をまとめた値は置かない。memory_extraction は独立した用途で、正解付きセットができるまで未評価（ADR 0008）。
 */
export type EvaluationUse =
  | 'intent_args'
  | 'mail_extraction'
  | 'reply_draft'
  | 'research_summary'
  | 'consult_summary'
  | 'memory_extraction'
  | 'voice_conversation'
  | 'local_asr';
/**
 * 保存モード（設計 03 保存期限）。normal は発言から 7 日、extended は本人指定の継続相談で 30 日、private は記録しない会話。
 */
export type StorageMode = 'normal' | 'extended' | 'private';
/**
 * 会話の表示先の版（設計 07 §2 handoff の expected_route_revision）。
 */
export type RouteRevision = string;
/**
 * 自動実行の安全停止の状態の版（設計 03 取り消しと安全停止、07 §2）。
 */
export type SafetyRevision = string;
/**
 * WSS /v1/events/stream で流れるメッセージ（設計 07 §2・§4、ADR 0009）。本文・宛先・認証情報を含めない。秘密を URL クエリーに入れない。
 */
export type EventStreamMessage =
  | {
      type: 'event';
      event: EventEnvelope;
    }
  | {
      type: 'voice';
      event: VoiceEvent;
    }
  | {
      type: 'resnapshot_required';
      reason: 'store_generation_changed' | 'history_expired' | 'scope_expired';
    };
export type DevicePlatform = 'windows' | 'macos' | 'linux';
/**
 * MAC アドレス（小文字の 16 進 2 桁をコロンでつないだ 6 組）。中枢は受け取った値を HMAC にしてから保存し、平文を DB に置かない（ADR 0022）。
 */
export type MacAddress = string;
/**
 * 自宅のサブネット（IPv4 の CIDR、接頭辞の長さは 8〜30）。ネットワークのアドレス（ホスト部が 0）でなければ中枢が 422 で拒否する（形式だけでは表せない検査、ADR 0022）。
 */
export type HomeSubnet = string;
/**
 * Wi-Fi の SSID。中枢は HMAC にしてから保存する（ADR 0022）。
 */
export type WifiSsid = string;
/**
 * 自宅判定が成り立たない理由（診断用、domain の homeNetworkDecision）。MAC・SSID・アドレスの値を含めない。
 */
export type HomeNetworkReason =
  | 'home_not_registered'
  | 'report_missing'
  | 'report_stale'
  | 'report_clock_inconsistent'
  | 'gateway_mac_unavailable'
  | 'gateway_mac_mismatch'
  | 'subnet_unavailable'
  | 'subnet_mismatch'
  | 'ssid_mismatch'
  | 'tailscale_unavailable'
  | 'tailscale_peer_not_found'
  | 'tailscale_derp'
  | 'tailscale_peer_relay'
  | 'direct_address_missing'
  | 'direct_address_invalid'
  | 'direct_address_outside_home';
/**
 * UI レンダラーから main への要求（設計 10 §1、07 §2、02 停止、ADR 0014）。main は受け取ったら最初にこの定義で検査し、未知のチャネル・未知の項目・型違いは invalid_request で拒否する。引数のない要求の payload は null。端末 ID は名乗れず、送信元は main が webContents から判定する。
 */
export type DesktopIpcRequest =
  | {
      channel: 'desktop.get_state';
      request_id: Id;
      payload: null;
    }
  | {
      channel: 'desktop.io_stop';
      request_id: Id;
      payload: null;
    }
  | {
      channel: 'desktop.io_resume';
      request_id: Id;
      payload: {
        expected_io_epoch: IoEpoch;
      };
    }
  | {
      channel: 'desktop.window_hide';
      request_id: Id;
      payload: null;
    }
  | {
      channel: 'desktop.client_quit';
      request_id: Id;
      payload: null;
    };
/**
 * main から UI レンダラーへの応答（ADR 0014）。どの拒否を返すかは domain の desktop.ts の規則が決める。
 */
export type DesktopIpcResponse =
  | {
      request_id: Id;
      channel: 'desktop.get_state' | 'desktop.io_stop' | 'desktop.io_resume';
      outcome: 'ok';
      status: DesktopStatusBar;
    }
  | {
      request_id: Id;
      channel: 'desktop.window_hide' | 'desktop.client_quit';
      outcome: 'ok';
    }
  | {
      request_id: Id | null;
      channel: DesktopIpcChannel | null;
      outcome: 'rejected';
      reason:
        | 'invalid_request'
        | 'untrusted_sender'
        | 'device_locked'
        | 'screen_operation_required'
        | 'not_stopped'
        | 'core_required'
        | 'io_epoch_mismatch';
    };
/**
 * 上部の状態欄の値（設計 01 いつも見える状態、07 §2）。main が端末状態から作り、UI レンダラーは表示するだけ。端末 ID・端末名・トークン・本文を含めない。
 */
export type DesktopStatusBar =
  | {
      visibility: 'hidden';
      lock_state: 'locked' | 'unknown';
    }
  | {
      visibility: 'shown';
      lock_state: 'unlocked';
      stop_scope: IoStopScope;
      input_permitted: boolean;
      io_epoch: IoEpoch;
      voice_state: VoiceState | null;
      hub_connection: 'not_connected' | 'connected' | 'unreachable';
      hub_last_confirmed_at: UtcTime | null;
      display_target: ('this_device' | 'other_device') | null;
      storage_mode: StorageMode | null;
      budget_held: boolean | null;
      safety_stopped: boolean | null;
    };
/**
 * UI レンダラーから main への限定 IPC のチャネル（設計 10 §1、07 §2、ADR 0014）。端末トークン・端末 ID・中枢の停止・任意の URL や HTTP の実行を表すチャネルはない。音声レンダラーの IPC（B05）は別に定める。
 */
export type DesktopIpcChannel =
  | 'desktop.get_state'
  | 'desktop.io_stop'
  | 'desktop.io_resume'
  | 'desktop.window_hide'
  | 'desktop.client_quit';
/**
 * main から UI レンダラーへの通知（設計 10 §1、07 §2、ADR 0014）。本文・端末 ID・認証情報を含めない。
 */
export type DesktopIpcNotification =
  | {
      channel: 'desktop.state_changed';
      status: DesktopStatusBar;
    }
  | {
      channel: 'desktop.power_event';
      event:
        'lock_screen' | 'unlock_screen' | 'suspend' | 'resume' | 'shutdown';
      source: 'os_event' | 'os_query';
      observed_at: UtcTime;
    };

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
/**
 * HTTP の拒否（設計 07 §3）。対象の本文を返さない。どのコードを返すかは domain の経路ごとの検査表（ADR 0009）が決め、形式の不正は invalid_input にする。
 */
export interface ApiError {
  code:
    | 'unauthenticated'
    | 'forbidden'
    | 'conflict'
    | 'expired_scope'
    | 'invalid_input'
    | 'budget_held'
    | 'rate_limited'
    | 'dependency_unavailable'
    | 'device_locked'
    | 'screen_operation_required'
    | 'hub_screen_required'
    | 'outside_home_network'
    | 'audio_owned_elsewhere'
    | 'audio_ownership_required'
    | 'payload_too_large'
    | 'private_conversation'
    | 'target_changed'
    | 'undo_expired'
    | 'pairing_failed'
    | 'unsupported_api_version';
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
  lock_state: LockState;
  stop_scope: IoStopScope;
  input_permitted: boolean;
  voice_state: VoiceState;
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
/**
 * モデルが返す記憶の候補（設計 11 §7）。文は 80 文字以内（コードポイント）。忘却世代・許可・重複の判定はモデルに返させず Core が付ける。
 */
export interface MemoryCandidateWire {
  kind: MemoryKind;
  text: string;
  /**
   * @minItems 1
   */
  source_turn_ids: [string, ...string[]];
  target_key: string;
}
/**
 * Core が検証した記憶の候補（設計 11 §7、03 memories / memory_sources）。forgetting_generation と permission_revision は処理開始時の値で、保存直前に現在値と照合する（08 §6）。dedupe_key は種類と正規化した文の HMAC で、Core が計算する。explicit_request は本人がはっきり頼んだ保存（memory_save）。
 */
export interface MemoryCandidate {
  schema: 'buddy.memory-candidate.v1';
  memory_candidate_id: Id;
  origin: 'auto_extraction' | 'explicit_request';
  session_id: Id;
  kind: MemoryKind;
  text: string;
  target_key: string;
  /**
   * @minItems 1
   */
  sources: [MemorySourceRef, ...MemorySourceRef[]];
  dedupe_key: Hash;
  forgetting_generation: ForgettingGeneration;
  permission_revision: PermissionRevision;
  created_at: UtcTime;
}
/**
 * 記憶の由来（発言・元情報・別の記憶）。本文は持たない（設計 03 忘却と再取り込み）。
 */
export interface MemorySourceRef {
  source_kind: 'turn' | 'source_item' | 'memory';
  source_id: string;
}
/**
 * 保存した要約記憶（設計 03 保存期限）。保存から 90 日で見直し待ち、見直し待ちは自動提案の根拠から外し 30 日未応答で削除する。利用・再要約・重複の再抽出で期限を延ばさない。
 */
export interface MemoryRecord {
  memory_id: Id;
  origin: 'auto_extraction' | 'explicit_request';
  kind: MemoryKind;
  text: string;
  target_key: string;
  /**
   * @minItems 1
   */
  sources: [MemorySourceRef, ...MemorySourceRef[]];
  dedupe_key: Hash;
  status: 'active' | 'review_pending' | 'deleted';
  created_at: UtcTime;
  review_at: UtcTime;
  delete_at: UtcTime | null;
}
/**
 * 忘却台帳の 1 件（設計 03 forget_ledger、忘却と再取り込み・バックアップ）。本文を持たず、忘れた対象と派生した記憶、再登録を禁止する元の由来 ID、同じ内容の自動記憶化を止める HMAC だけを記録する。世代は 1 件ごとに 1 つ進む。
 */
export interface ForgetLedgerEntry {
  schema: 'buddy.forget-ledger.v1';
  entry_id: Id;
  forgetting_generation: ForgettingGeneration;
  recorded_at: UtcTime;
  /**
   * @minItems 1
   */
  forgotten: [MemorySourceRef, ...MemorySourceRef[]];
  blocked_source_ids: string[];
  blocked_content_keys: Hash[];
}
/**
 * 本人の指示（設計 03 user_directives、10 §4）。this_time（今回は）は会話の明示終了で破棄し、from_now_on（今後は）は設定として保存して設定画面で確認・取り消しできる。
 */
export interface UserDirective {
  directive_id: Id;
  text: string;
  scope: 'this_time' | 'from_now_on';
  session_id: Id;
  turn_id: Id;
  active: boolean;
  created_at: UtcTime;
}
/**
 * モデル配備の記録（設計 05 再選定する条件 P09、03 データ表）。downloaded→integrity_checked→contract_tested→evaluated→active の順に進め、可変名の変化を検知したら suspended にして新規の自動処理を止める。モデルの思考全文や元本文は持たない。
 */
export interface DeploymentManifest {
  schema: 'buddy.deployment.v1';
  deployment_id: Id;
  profile: ModelProfile;
  version_kind: 'immutable_snapshot' | 'mutable_alias' | 'local_digest';
  response_model_id: string | null;
  artifacts: ModelArtifact[];
  quantization: string | null;
  tokenizer_hash: Hash | null;
  chat_template_hash: Hash | null;
  runtime_version: string | null;
  schema_hash: Hash | null;
  prompt_hash: Hash | null;
  stage:
    | 'downloaded'
    | 'integrity_checked'
    | 'contract_tested'
    | 'evaluated'
    | 'active'
    | 'suspended'
    | 'retired';
  adoptions: DeploymentAdoption[];
  rollback_deployment_id: Id | null;
  recorded_at: UtcTime;
}
/**
 * モデル・endpoint 別の profile（設計 05 P02）。変更の単位はモデル名ではなく profile。verified_capabilities は endpoint ごとに試験で確かめた能力だけで、schema の記載から登録しない。measured_p95 は意図判定の比較 profile だけに使う（05 質問132）。
 */
export interface ModelProfile {
  profile_id: string;
  role:
    'voice' | 'intent' | 'background_text' | 'advanced_consult' | 'local_asr';
  provider: string;
  endpoint: string;
  api_version: string | null;
  sdk_version: string | null;
  model_request_id: string;
  reasoning: string | null;
  structured_output: 'json_schema_strict' | 'json_mode' | 'none';
  output_limit_tokens: number | null;
  timeout_ms: number;
  max_concurrency: number;
  price_version: string | null;
  reservation_method: 'max_liability' | 'measured_p95';
  verified_capabilities: string[];
}
/**
 * ローカル一式の成果物（設計 05 P09）。
 */
export interface ModelArtifact {
  path: string;
  bytes: number;
  sha256: Hash;
}
/**
 * 用途ごとの採否（設計 05 評価の進め方）。結果を本人に示して決める。判断のない用途は未評価として扱い、ここに書かない。根拠にできるのは同じ配備・同じ用途の EvaluationResult だけで、影モードの集計は参照できない。
 */
export interface DeploymentAdoption {
  use: EvaluationUse;
  decision: 'adopted' | 'rejected';
  /**
   * @minItems 1
   */
  evaluation_ids: [Id, ...Id[]];
  decided_by: 'user';
  decided_at: UtcTime;
}
/**
 * 用途別の評価結果（設計 05 評価の進め方、09 X57・X66・MA01・MA02）。1 件は 1 つの配備・1 つの用途だけを表す。必須境界例の違反が 1 件でもあれば pass にできない。
 */
export interface EvaluationResult {
  schema: 'buddy.evaluation-result.v1';
  evaluation_id: Id;
  deployment_id: Id;
  use: EvaluationUse;
  suite: {
    suite_id: string;
    suite_version: string;
    split: 'tuning' | 'judgment';
  };
  /**
   * 評価したときの条件。配備の現在値と一つでも違えば、その配備の評価として使わない。
   */
  conditions: {
    base_time: UtcTime;
    model_request_id: string;
    response_model_id: string | null;
    schema_hash: Hash | null;
    prompt_hash: Hash | null;
    artifact_digest: Hash | null;
    reasoning: string | null;
    output_limit_tokens: number | null;
    warm_state: 'cold' | 'warm' | 'not_applicable';
  };
  /**
   * 証拠の種類。模擬・実 API・実機を分ける（設計 09 §8）。
   */
  evidence: {
    kind: 'mock_provider' | 'real_api' | 'real_device';
    run_id: string;
    commit: string;
    executed_at: UtcTime;
  };
  /**
   * 本人が確認済みの例だけを集計する。未確認・保留・対象外は除外数として残す。
   */
  samples: {
    confirmed: number;
    excluded_unconfirmed: number;
    excluded_out_of_scope: number;
  };
  latency_ms: {
    p50: number;
    p95: number;
  } | null;
  cost_per_case: Money | null;
  metrics: {
    name: string;
    value: string;
  }[];
  mandatory_violations: number;
  verdict: 'pass' | 'fail' | 'incomplete';
}
/**
 * 影モードの比較記録（設計 03 intent_shadow、10 §5）。発話の本文は持たず input_id で参照し、会話全文と同じ期限で削除する。記録しない会話では作らない。影の判定は実行に使わない。
 */
export interface IntentShadowRecord {
  schema: 'buddy.intent-shadow.v1';
  record_id: Id;
  campaign_id: Id;
  input_id: Id;
  request_revision: RequestRevision;
  primary: ShadowJudgment;
  /**
   * @minItems 1
   */
  shadows: [ShadowJudgment, ...ShadowJudgment[]];
  recorded_at: UtcTime;
  expires_at: UtcTime;
  used_for_execution: false;
}
/**
 * 1 つのモデルの判定。空・途中・拒否の出力を「意図なし」と読み替えず outcome で分ける。
 */
export interface ShadowJudgment {
  deployment_id: Id;
  outcome:
    | 'ok'
    | 'needs_clarification'
    | 'refused'
    | 'truncated'
    | 'invalid_output'
    | 'timeout'
    | 'unavailable'
    | 'skipped';
  intent: IntentName | null;
  args: IntentArgs | null;
  probability: string | null;
  latency_ms: number | null;
}
/**
 * 比較 campaign の状態（設計 05・11 §9 P05）。確定した入力の件数・比較実費・開始からの日数の最初の到達で止める。費用の受付は予算の枠（ADR 0006）でも検査する。
 */
export interface ShadowCampaignState {
  campaign_id: Id;
  budget_pool_id: BudgetPoolId;
  started_at: UtcTime;
  confirmed_inputs: number;
  spent: Money;
  /**
   * 停止条件。金額は設定の値で、契約に本人の金額を含めない。
   */
  limits: {
    max_inputs: number;
    max_spend: Money;
    max_days: number;
  };
  status: 'running' | 'stopped';
  stop_reason:
    ('max_inputs' | 'max_spend' | 'max_days' | 'user_stopped') | null;
}
/**
 * 影モードの集計（ADR 0008）。本番モデルとの一致率と遅延だけで、正答率・合否・採用の欄を持たない。採否の根拠（DeploymentAdoption）にできない。
 */
export interface ShadowCampaignSummary {
  campaign_id: Id;
  primary_deployment_id: Id;
  shadow_deployment_id: Id;
  compared: number;
  intent_agreement: string | null;
  args_agreement: string | null;
  latency_ms: {
    p50: number;
    p95: number;
  } | null;
  cost_total: Money;
}
/**
 * 意図判定の評価の 1 例（tests/eval の書き出し形式。設計 10 §10、05 評価の進め方）。採否の集計に使えるのは review_status が confirmed で split が judgment の例だけ。同じ元例の言い換えは同じ group_id にし、調整用と判定用へまたがらせない。
 */
export interface IntentEvalCase {
  schema: 'buddy.eval-case.v1';
  case_id: string;
  use: 'intent_args';
  split: 'tuning' | 'judgment';
  group_id: string;
  review_status: 'confirmed' | 'unconfirmed' | 'needs_fix' | 'on_hold';
  input: {
    text: string;
    input_kind: InputKind;
    base_time: UtcTime;
    zone: TimeZone;
    context: string | null;
  };
  categories: (
    | 'basic'
    | 'datetime'
    | 'deixis'
    | 'clarification'
    | 'boundary'
    | 'recognition_error'
    | 'casual'
    | 'multiple_requests'
    | 'honorific'
  )[];
  expected: {
    intent: IntentName;
    args: ExpectedIntentArgs;
  };
}
/**
 * 評価の正解の引数。IntentArgs の項目名だけを使い、書いた項目だけを比べる。評価セットの「キー=値」は対応表で変換し、表にないキーは変換の失敗にする（ADR 0008）。
 */
export interface ExpectedIntentArgs {
  target_candidate_id?: Id;
  start?: DateOrDateTime;
  end?: DateOrDateTime;
  due?: DateOrDateTime;
  title?: string;
  body?: string;
  subject?: string;
  add_labels?: string[];
  remove_labels?: string[];
  task_change?: 'complete' | 'reschedule' | 'delete';
  memory_kind?:
    'preference' | 'goal' | 'person' | 'routine' | 'lexicon' | 'progress';
  query?: string;
  device_name?: string;
}
/**
 * 認証後の接続情報（設計 07 §2）。本文を含めない。device_id は認証結果から中枢が決める。command_scope_id は再接続・失効・中枢の再起動で無効になり、最長 24 時間。api_version は major が一致する端末だけが使う。
 */
export interface Bootstrap {
  api_version: string;
  core_instance_id: Id;
  store_generation: StoreGeneration;
  device_id: Id;
  command_scope_id: Id;
  command_scope_expires_at: UtcTime;
  capabilities: string[];
  io_state: DeviceIOState;
}
/**
 * 一つの整合した DB 読取りで得た現在の表示状態と、その境界のイベント位置（設計 07 §4）。表示権限に応じて返し、ロック中・停止中は再開用の管理情報だけ（management_only）にする。
 */
export interface Snapshot {
  store_generation: StoreGeneration;
  core_instance_id: Id;
  event_cursor: EventCursor;
  view: 'full' | 'management_only';
  io_state: DeviceIOState;
  sessions: {
    session_id: Id;
    storage_mode: StorageMode;
    display_device_id: Id | null;
    route_revision: RouteRevision;
    turns: SnapshotTurn[];
  }[];
  candidates: CandidateSnapshot[];
  operations: OperationSnapshot[];
}
/**
 * 表示用の発言。保存期限を過ぎた発言と記録しない会話の発言は返さない。
 */
export interface SnapshotTurn {
  turn_id: Id;
  role: 'user' | 'buddy';
  text: string;
  at: UtcTime;
  input_kind: InputKind | null;
}
export interface SessionCreateRequest {
  request_id: Id;
  command_scope_id: Id;
  storage_mode: StorageMode;
}
export interface SessionReceipt {
  request_id: Id;
  session_id: Id;
  storage_mode: StorageMode;
  route_revision: RouteRevision;
}
/**
 * 画面からの発言（設計 07 §2、10 §6）。文字入力と、端末内で文字にした声（③）だけ。Live の文字起こしはこの経路で送らない。発言から外部変更を直接実行しない。
 */
export interface TurnRequest {
  request_id: Id;
  command_scope_id: Id;
  text: string;
  input_kind: 'text' | 'voice_local';
}
/**
 * 文字で返す結果（設計 10 §6A）。結果は構造化した事実の表示で、文章は雑談・相談・調査のまとめだけ。外部変更の完了は操作の状態で別に示す。
 */
export interface TurnResponse {
  request_id: Id;
  session_id: Id;
  turn_id: Id;
  input_id: Id;
  workflow_id: Id | null;
  status: 'answered' | 'clarification' | 'background' | 'session_control';
  result_view: ResultView | null;
  reply_text: string | null;
}
/**
 * 表示の移動（設計 07 §2・§5、01 流れ C）。呼び出した端末の画面操作だけ。音声の移動は次の呼びかけで別に行う。承認は取り直さない。
 */
export interface HandoffRequest {
  request_id: Id;
  command_scope_id: Id;
  target_device_id: Id;
  expected_route_revision: RouteRevision;
}
/**
 * 旧端末の表示退避か期限切れを確認するまで moving のまま。
 */
export interface HandoffState {
  session_id: Id;
  route_revision: RouteRevision;
  display_device_id: Id;
  state: 'moving' | 'completed';
}
export interface AutoActionList {
  safety: SafetyState;
  items: AutoActionItem[];
}
/**
 * 安全停止の状態（設計 03 取り消しと安全停止）。解除は登録済み・ロック解除済み端末の画面操作だけ。
 */
export interface SafetyState {
  state: 'running' | 'stopped';
  safety_revision: SafetyRevision;
  stop_reason:
    ('rate_exceeded' | 'same_target_repeated' | 'compensation_failures') | null;
  stopped_at: UtcTime | null;
}
/**
 * 自動実行した操作（設計 03 auto_actions / undo_records、J12）。本文を含めない。取り消しは完了から 30 日まで。
 */
export interface AutoActionItem {
  operation_id: Id;
  action_kind:
    | 'create_task'
    | 'create_note'
    | 'label_mail'
    | 'draft_reply'
    | 'create_event';
  policy_version: PolicyVersion;
  state_revision: StateRevision;
  completed_at: UtcTime;
  undo_state:
    | 'available'
    | 'target_changed'
    | 'expired'
    | 'in_progress'
    | 'undone'
    | 'unavailable';
  undo_deadline: UtcTime;
}
export interface SafetyResumeRequest {
  request_id: Id;
  command_scope_id: Id;
  expected_safety_revision: SafetyRevision;
}
/**
 * 端末単位・来客・全体の入出力停止（設計 07 §2）。停止は版の一致を求めず常に受け付ける。外部操作の取消とは別。
 */
export interface IoStopRequest {
  request_id: Id;
  command_scope_id: Id;
  scope: 'local' | 'guest' | 'global';
}
/**
 * 停止の到達状況（設計 07 §5）。停止確認済みと端末の応答待ちを分ける。リースの失効は端末が自分で止まる期限で、停止の確認ではない。
 */
export interface IoStopResult {
  scope: 'local' | 'guest' | 'global';
  io_epoch: IoEpoch;
  /**
   * @minItems 1
   */
  devices: [
    {
      device_id: Id;
      stop_state: 'confirmed' | 'awaiting_ack' | 'lease_expired';
    },
    ...{
      device_id: Id;
      stop_state: 'confirmed' | 'awaiting_ack' | 'lease_expired';
    }[],
  ];
  all_confirmed: boolean;
}
/**
 * 入出力の再開（設計 07 §2、10 §1A）。登録済み・ロック解除済み端末の画面操作だけ。接続復帰・ロック解除・呼びかけだけでは再開しない。
 */
export interface IoResumeRequest {
  request_id: Id;
  command_scope_id: Id;
  scope: 'local' | 'guest' | 'global';
  expected_io_epoch: IoEpoch;
}
export interface PairingStartRequest {
  request_id: Id;
  command_scope_id: Id;
}
/**
 * 中枢の画面に出すワンタイムコードと中枢の証明書の指紋（設計 02 端末登録と接続）。certificate_fingerprint は中枢の TLS 証明書の DER 全体の SHA-256 を小文字の 16 進 64 桁にした値で、端末は TLS で見えた証明書から同じ方法で求めて比べ、以後の接続でピン留めする（ADR 0020）。有効 5 分・連続 5 回失敗で無効は設計初期値。中枢の画面の端末だけが受け取る。
 */
export interface PairingSession {
  pairing_id: Id;
  pairing_code: string;
  certificate_fingerprint: Hash;
  expires_at: UtcTime;
  attempts_left: number;
}
/**
 * 登録する端末の申請（認証前）。端末が作った申請用の秘密の SHA-256 だけを送る。claim_secret_hash は PairingTokenRequest.claim_secret の ASCII の 43 文字の SHA-256 を小文字の 16 進 64 桁にした値（ADR 0021）。指紋の照合は端末の画面で本人が行い、この要求の前に済ませる（ADR 0009）。 home_fingerprint は申請する端末が見た自宅の指紋で、中枢は申請の自宅判定（home_network）に使う（ADR 0022）。
 */
export interface PairingClaimRequest {
  request_id: Id;
  pairing_code: string;
  device_name: string;
  platform: DevicePlatform;
  claim_secret_hash: Hash;
  home_fingerprint: HomeFingerprint;
}
/**
 * 端末が見た自宅の指紋（設計 11 §10、ADR 0022）。既定のゲートウェイの MAC・端末のサブネット・Wi-Fi の SSID。取得できない要素は null（推測で埋めない）。ゲートウェイの MAC とサブネットは自宅判定に必須で、SSID は登録値と報告の両方にあるときだけ比べる。指紋だけでは許可せず、Tailscale の直接経路が自宅 LAN の中にあることも求める。
 */
export interface HomeFingerprint {
  gateway_mac: MacAddress | null;
  subnet: HomeSubnet | null;
  ssid: WifiSsid | null;
}
/**
 * 登録の申請。expires_at は申請の期限（申請を受け付けた時刻から 5 分、ADR 0021）で、承認とトークンの受取りはこの前だけ。
 */
export interface PairingClaim {
  claim_id: Id;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
  device_name: string;
  platform: DevicePlatform;
  expires_at: UtcTime;
}
/**
 * 中枢の画面での承認・拒否。
 */
export interface PairingDecisionRequest {
  request_id: Id;
  command_scope_id: Id;
  decision: 'approve' | 'reject';
}
/**
 * 申請用の秘密（256 ビット、base64url）。承認後に 1 回だけトークンと交換できる。URL に入れない。 home_fingerprint は受取りの時点の自宅の指紋（登録前の端末は報告を持たないため、受取りの自宅判定に使う。ADR 0022）。
 */
export interface PairingTokenRequest {
  claim_secret: string;
  home_fingerprint: HomeFingerprint;
}
/**
 * 端末別トークン（256 ビット）。端末は OS の保護領域に保存し、中枢は照合用の hash（device_token の ASCII の 43 文字の SHA-256、ADR 0020）と失効状態だけを持つ。この応答は 1 回だけ返す。
 */
export interface DeviceCredential {
  device_id: Id;
  device_token: string;
  issued_at: UtcTime;
}
export interface DeviceList {
  devices: DeviceSummary[];
}
/**
 * 登録済みの端末。hub_local は中枢と同じマシンのクライアント（自宅判定だけ免除）。
 */
export interface DeviceSummary {
  device_id: Id;
  device_name: string;
  platform: DevicePlatform;
  hub_local: boolean;
  registered_at: UtcTime;
  last_seen_at: UtcTime | null;
  revoked_at: UtcTime | null;
}
export interface DeviceRevokeRequest {
  request_id: Id;
  command_scope_id: Id;
}
/**
 * 端末からの自宅の指紋の報告。中枢は受け取った時刻から 6 分の間だけ使い、端末の時計は使わない（ADR 0022）。
 */
export interface HomeFingerprintReport {
  request_id: Id;
  fingerprint: HomeFingerprint;
}
/**
 * 報告を受け取った後の自宅判定（ADR 0022）。allowed は理由が一つもないときだけ true。exempt は中枢と同じマシンのクライアントの免除。不成立のとき、中枢はその端末の接続範囲を失効させ、WSS を閉じる。report_expires_at は報告を使わなくなる時刻（免除のときは null）。
 */
export interface HomeNetworkStatus {
  allowed: boolean;
  exempt: boolean;
  reasons: HomeNetworkReason[];
  report_expires_at: UtcTime | null;
}
/**
 * 自宅の登録（中枢の画面だけ、家ごとに 1 つで登録し直すと置き換える。ADR 0022）。ゲートウェイの MAC とサブネットは必須、SSID は取れなければ null。
 */
export interface HomeRegistrationRequest {
  request_id: Id;
  command_scope_id: Id;
  gateway_mac: MacAddress;
  subnet: HomeSubnet;
  ssid: WifiSsid | null;
}
/**
 * 登録した自宅（ADR 0022）。MAC と SSID は HMAC だけを保存するので返さない。
 */
export interface HomeRegistration {
  subnet: HomeSubnet;
  ssid_registered: boolean;
  registered_at: UtcTime;
}
export interface ConnectionList {
  connections: ConnectionSummary[];
}
/**
 * 連携の接続（設計 04 接続・権限）。OAuth トークンは返さない。
 */
export interface ConnectionSummary {
  connection_id: Id;
  provider: 'google' | 'microsoft';
  status: 'active' | 'needs_reauth' | 'needs_attention' | 'disconnected';
  access: 'read' | 'read_write';
  granted_scopes: string[];
  targets: ConnectionTargets;
  permission_revision: PermissionRevision;
  scope_revision: ScopeRevision;
}
/**
 * 本人が選んだ取得対象（設計 04 取得する対象、J13・J16）。新しいカレンダー・フォルダーを見つけても自動で追加しない。OAuth の権限より狭い範囲を Buddy 側で検査する。
 */
export interface ConnectionTargets {
  calendar_ids: string[];
  mail_container_ids: string[];
  attachment_kinds: ('pdf' | 'text')[];
}
/**
 * OAuth の開始（設計 04 接続・権限）。中枢の画面だけ。PKCE と loopback の戻り先は中枢内で処理し、/v1 の経路にしない。
 */
export interface OAuthStartRequest {
  request_id: Id;
  command_scope_id: Id;
  provider: 'google' | 'microsoft';
  access: 'read' | 'read_write';
}
/**
 * システムブラウザーで開く認可 URL。PKCE の challenge と state だけを含み、秘密を含めない。
 */
export interface OAuthStart {
  authorization_url: string;
  expires_at: UtcTime;
}
/**
 * 取得対象の変更。許可版と取得範囲の版を上げ、旧範囲の走査を無効にする（設計 11 §1A）。
 */
export interface ConnectionTargetsRequest {
  request_id: Id;
  command_scope_id: Id;
  expected_permission_revision: PermissionRevision;
  targets: ConnectionTargets;
}
/**
 * 接続解除。進行中の操作の照合に必要な最小情報は残し、取得と自動処理を止める。
 */
export interface ConnectionDisconnectRequest {
  request_id: Id;
  command_scope_id: Id;
  expected_permission_revision: PermissionRevision;
}
