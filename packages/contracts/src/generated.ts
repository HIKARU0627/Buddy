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
  | OperationPreview
  | OperationDisplay
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
  | PriceVersion
  | BudgetRuntimeConfig
  | BudgetUsageSummary
  | BudgetOverageApproval
  | BudgetOverageDecision
  | BudgetOverrunReview
  | BudgetManualSettlement
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
  | PairingClaimList
  | DeviceList
  | DeviceRevokeRequest
  | HomeFingerprint
  | HomeFingerprintReport
  | HomeNetworkStatus
  | HomeRegistrationRequest
  | HomeRegistration
  | HomeRegistrationState
  | ConnectionList
  | ConnectionSummary
  | OAuthStartRequest
  | OAuthStart
  | ConnectionTargetsRequest
  | ConnectionDisconnectRequest
  | DesktopIpcRequest
  | DesktopIpcResponse
  | DesktopIpcNotification
  | DesktopStatusBar
  | CanvasDocument
  | CanvasOpBatch
  | DesktopCanvasView
  | StreamTurnRequest
  | StreamTurnResponse
  | CanvasUserOpRequest
  | CanvasUserOpResponse
  | CanvasContent
  | CanvasContentRequest
  | CanvasContentResponse
  | DesktopCanvasDisplaySettings;
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
 * 承認対象として確定した変更内容。ラベル変更（H01）・返信の下書き・用事の登録（ADR 0027）。content_hash はこの確定 intent 全体の JCS+SHA-256。依頼ID・表示端末・state_revisionを混ぜない。
 */
export type OperationIntent =
  LabelOperationIntent | DraftReplyOperationIntent | TaskOperationIntent;
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
 * 操作の種類。確定 intent の action.kind と同じ値（ADR 0027）。経路（Read / LocalCommand / RemoteMutation）はコードの表が決める。
 */
export type OperationKind =
  'mail.labels.change' | 'mail.draft.create' | 'task.create';
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
 * モデル・endpoint 別の profile の ID（ModelProfile.profile_id、設計 05 P02）。予約・受付で同じ型を使う（ADR 0034）。
 */
export type ProfileId = string;
/**
 * 単価の版の ID（設計 05 費用の計算 D15）。設定で決める不透明な ID で、順序比較しない（ADR 0006・0034）。
 */
export type PriceVersionId = string;
/**
 * 暦月（予算月など）。
 */
export type YearMonth = string;
/**
 * 予算枠の ID（設定で決める。例: llm、llm.background）。個人の金額は設定の値に置き、契約には含めない。
 */
export type BudgetPoolId = string;
/**
 * 通貨単位の百万分の一を整数文字列で表す。通貨変換はしない。18 桁まで（SQLite の 64 ビット整数に収まる。ADR 0034）。合計の桁あふれは保存・集計の側で検査する。
 */
export type Amount = string;
/**
 * 付帯クレジットの更新周期の ID。provider と周期の開始日（UTC の日付）を : でつなぐ（例: anthropic:2030-10-01）。予算月とは別。メールアドレス・自由文・キーを入れない（ADR 0034）。
 */
export type CreditCycleId = string;
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
 * 同じ課金対象（provider・モデル・endpoint・課金の種類）の単価の系列。同じ price_key の版は適用期間が重ならない（ADR 0034）。
 */
export type PriceKey = string;
/**
 * 単価の適用期間の境目の時刻。UTC の RFC 3339 で、小数秒はミリ秒（3 桁）まで。期間の重なりと隣接をミリ秒で正確に比べるため（ADR 0034）。
 */
export type PriceTime = string;
/**
 * 課金区分（設計 05 費用の計算 D15・F02）。output_tokens は思考を含む。cached_input_tokens は精算だけに使い、M は非命中の input_tokens の単価で見積もる。search_requests は検索、live_seconds は会話の接続時間。
 */
export type PriceCategory =
  | 'input_tokens'
  | 'cached_input_tokens'
  | 'output_tokens'
  | 'tool_calls'
  | 'search_requests'
  | 'live_seconds';
/**
 * 課金量（token・秒・回）を表す負でない整数の文字列。18 桁まで（ADR 0034）。
 */
export type QuantityString = string;
/**
 * 負でない 10 進の小数（小数点以下 6 桁まで）。為替・安全係数に使う。浮動小数点数にしない（ADR 0034）。
 */
export type DecimalString = string;
/**
 * IANA タイムゾーン名。実在の確認は意味検査で行う（設計 07 §1）。
 */
export type TimeZone = string;
/**
 * 枠の予算保留の理由（01 いつも見える状態の「予算保留」）。limit_reached は精算済み額＋未精算の M が上限に達した、overrun_review_pending は M 超過の確認待ち、ancestor_held は祖先の枠の保留、config_invalid は設定の検査に失敗して有料処理を止めている。理由のコードを利用者に見せない。
 */
export type BudgetHoldReason =
  | 'limit_reached'
  | 'overrun_review_pending'
  | 'ancestor_held'
  | 'config_invalid';
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
 * 有料の受付全体を止めている理由（B07-04、ADR 0037）。config_invalid は実行時の設定ファイルが読めない・検査に通らない、clock_regressed は時計が今の予算月の始まりより前へ戻った、calendar_mismatch は記録した予算月の始まりと tz データで求め直した値が食い違う（U23）、reservation_pool_unknown は今の設定で経路を解けない予約がある、calendar_unavailable は予算月の状態を読めない。予算月の確かめ直しは本人の確認で行う。理由のコードを利用者に見せない。
 */
export type BudgetGateHoldReason =
  | 'config_invalid'
  | 'clock_regressed'
  | 'calendar_mismatch'
  | 'reservation_pool_unknown'
  | 'calendar_unavailable';
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
      type: 'canvas';
      canvas_revision: CanvasRevision;
    }
  | {
      type: 'resnapshot_required';
      reason: 'store_generation_changed' | 'history_expired' | 'scope_expired';
    };
/**
 * キャンバスの記述の版（ADR 0032）。Core が変更の束ごとに 1 進める。state_revision・request_revision とは別。
 */
export type CanvasRevision = string;
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
 * 申請の確認コード（B03-06、ADR 0026）。申請用の秘密の SHA-256（claim_secret_hash の小文字の 16 進）から、SHA-256("buddy/pairing-claim-check/v1" NUL claim_secret_hash) の先頭 4 バイトの小文字の 16 進として求める。端末の画面と中枢の画面に同じ値を出し、本人が承認する申請を見分ける。認証情報ではない（受取りには申請用の秘密が要る）。
 */
export type PairingClaimCheck = string;
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
    }
  | {
      channel: 'desktop.get_connection';
      request_id: Id;
      payload: null;
    }
  | {
      channel: 'desktop.pairing_begin';
      request_id: Id;
      payload: {
        /**
         * 中枢の宛先（Tailscale の IP アドレスか名前）。端末は名前ではなく証明書の指紋で中枢を確かめる（ADR 0020）。URL・パス・ポートを含めない。名前の形は domain の HUB_HOSTNAME_PATTERN と同じ一つの正規表現（末尾のドットを一つ許す）。main はペアリングの開始で正規化し（末尾のドットを除いて小文字にする）、ペアリングで受け付ける宛先を Tailscale のアドレス（100.64.0.0/10・fd7a:115c:a1e0::/48）・ループバック・*.ts.net の名前に限る（ADR 0025）。
         */
        host: DesktopHubHost & DesktopHubHost1;
        port: number;
      };
    }
  | {
      channel: 'desktop.pairing_confirm';
      request_id: Id;
      payload: {
        fingerprint: Hash;
        fingerprint_tail: string;
      };
    }
  | {
      channel: 'desktop.pairing_submit';
      request_id: Id;
      payload: {
        pairing_code: string;
        device_name: string;
      };
    }
  | {
      channel: 'desktop.pairing_cancel';
      request_id: Id;
      payload: null;
    }
  | {
      channel: 'desktop.claims_list';
      request_id: Id;
      payload: null;
    }
  | {
      channel: 'desktop.claim_decide';
      request_id: Id;
      payload: {
        ref: Id;
        decision: 'approve' | 'reject';
      };
    }
  | {
      channel: 'desktop.devices_list';
      request_id: Id;
      payload: null;
    }
  | {
      channel: 'desktop.device_revoke';
      request_id: Id;
      payload: {
        ref: Id;
      };
    }
  | {
      channel: 'desktop.pairing_open';
      request_id: Id;
      payload: null;
    }
  | {
      channel: 'desktop.home_status';
      request_id: Id;
      payload: null;
    }
  | {
      channel: 'desktop.home_register';
      request_id: Id;
      payload: {
        ref: Id;
        include_ssid: boolean;
      };
    }
  | {
      channel: 'desktop.turn_submit';
      request_id: Id;
      payload: {
        text: string;
      };
    }
  | {
      channel: 'desktop.operation_preview';
      request_id: Id;
      payload: {
        ref: Id;
      };
    }
  | {
      channel: 'desktop.operation_approve';
      request_id: Id;
      payload: {
        ref: Id;
      };
    }
  | {
      channel: 'desktop.operation_cancel';
      request_id: Id;
      payload: {
        ref: Id;
      };
    }
  | {
      channel: 'desktop.operation_reconcile';
      request_id: Id;
      payload: {
        ref: Id;
      };
    }
  | {
      channel: 'desktop.operation_retry';
      request_id: Id;
      payload: {
        ref: Id;
      };
    }
  | {
      channel: 'desktop.operation_check';
      request_id: Id;
      payload: {
        ref: Id;
      };
    }
  | {
      channel: 'desktop.canvas_summon';
      request_id: Id;
      payload: null;
    }
  | {
      channel: 'desktop.status_panel';
      request_id: Id;
      payload: {
        open: boolean;
      };
    }
  | {
      channel: 'desktop.canvas_user_op';
      request_id: Id;
      payload: {
        expected_canvas_revision: CanvasRevision;
        op: CanvasUserOp;
      };
    }
  | {
      channel: 'desktop.canvas_content';
      request_id: Id;
      payload: {
        item_id: CanvasItemId;
        expected_canvas_revision: CanvasRevision;
        open_ref: Id | null;
      };
    }
  | {
      channel: 'desktop.budget_overage_decide';
      request_id: Id;
      payload: {
        ref: Id;
        decision: 'approve' | 'reject';
      };
    }
  | {
      channel: 'desktop.budget_overrun_review';
      request_id: Id;
      payload: {
        ref: Id;
      };
    }
  | {
      channel: 'desktop.budget_manual_settle';
      request_id: Id;
      payload: {
        ref: Id;
        /**
         * 手で入力した照合 ID。manual: で始め、英数字と . _ - だけ（メールアドレス・氏名・自由文を入れない）。
         */
        reconciliation_id: string;
        /**
         * 通貨単位の百万分の一を整数文字列で表す。通貨変換はしない。18 桁まで（SQLite の 64 ビット整数に収まる。ADR 0034）。合計の桁あふれは保存・集計の側で検査する。
         */
        actual_amount: string;
      };
    };
export type DesktopHubHost = string;
export type DesktopHubHost1 = string;
/**
 * ユーザーのキャンバスの操作（UI-06、ADR 0032）。move（動かす）・resize（大きさを変える）は置く先のマス（配置のエンジンの格子のマス）、close は閉じる、shelve は下の棚へ片付ける、unshelve は棚から出す。ピクセル・座標・本文を持たない。キャンバスが前に出ている間の本人の操作だけ。
 */
export type CanvasUserOp =
  | {
      kind: 'move' | 'resize';
      item_id: CanvasItemId;
      cell: CanvasCell;
    }
  | {
      kind: 'close' | 'shelve' | 'unshelve';
      item_id: CanvasItemId;
    };
/**
 * キャンバスの中の物の名前（ADR 0032）。同じキャンバスの中だけで一意。操作 ID・会話 ID などの内部の識別子を使わない。
 */
export type CanvasItemId = string;
/**
 * main から UI レンダラーへの応答（ADR 0014・0025）。どの拒否を返すかは domain の desktop.ts の規則と main のペアリングの手順が決める。
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
      channel:
        | 'desktop.window_hide'
        | 'desktop.client_quit'
        | 'desktop.canvas_summon'
        | 'desktop.status_panel';
      outcome: 'ok';
    }
  | {
      request_id: Id;
      channel:
        | 'desktop.get_connection'
        | 'desktop.pairing_begin'
        | 'desktop.pairing_confirm'
        | 'desktop.pairing_submit'
        | 'desktop.pairing_cancel';
      outcome: 'ok';
      connection: DesktopConnectionView;
    }
  | {
      request_id: Id;
      channel: 'desktop.claims_list' | 'desktop.claim_decide';
      outcome: 'ok';
      claims: DesktopClaimEntry[];
      /**
       * main が付ける一覧の通し番号（申請・端末ごとに増える）。画面は同じ種類の一覧でこれより小さい番号の応答を反映しない（届いた順ではなく main の順で比べる。ADR 0026）。
       */
      list_seq: number;
    }
  | {
      request_id: Id;
      channel: 'desktop.devices_list' | 'desktop.device_revoke';
      outcome: 'ok';
      devices: DesktopDeviceEntry[];
      /**
       * main が付ける一覧の通し番号（申請・端末ごとに増える）。画面は同じ種類の一覧でこれより小さい番号の応答を反映しない（届いた順ではなく main の順で比べる。ADR 0026）。
       */
      list_seq: number;
    }
  | {
      request_id: Id;
      channel: 'desktop.claim_decide' | 'desktop.device_revoke';
      outcome: 'ok';
      /**
       * 承認・拒否・失効は中枢に適用されたが、その後の一覧の取り直しだけが失敗した。画面は前の一覧からその行を除き、一覧の更新を促す（失敗として扱わない）。
       */
      list_refreshed: false;
      /**
       * 変更の結果が分かった時点の一覧の境目（main の通し番号）。画面はこれより小さい番号の一覧を反映しない（ADR 0026）。
       */
      list_seq: number;
    }
  | {
      request_id: Id;
      channel: 'desktop.pairing_open';
      outcome: 'ok';
      session: DesktopPairingSession;
    }
  | {
      request_id: Id;
      channel: 'desktop.home_status' | 'desktop.home_register';
      outcome: 'ok';
      home: DesktopHomeView;
      /**
       * main が付ける自宅の要求の通し番号（読み取りはその番号、登録は成功の後の境目）。画面はこれより小さい番号の自宅の応答を反映しない（届いた順ではなく main の順で比べる。ADR 0022・0026）。
       */
      list_seq: number;
    }
  | {
      request_id: Id;
      channel: 'desktop.turn_submit';
      outcome: 'ok';
      turn: DesktopTurnResult;
    }
  | {
      request_id: Id;
      channel: 'desktop.operation_preview';
      outcome: 'ok';
      preview: DesktopOperationPreview;
    }
  | {
      request_id: Id;
      channel:
        | 'desktop.operation_approve'
        | 'desktop.operation_cancel'
        | 'desktop.operation_reconcile'
        | 'desktop.operation_retry'
        | 'desktop.budget_overage_decide'
        | 'desktop.budget_overrun_review'
        | 'desktop.budget_manual_settle';
      outcome: 'ok';
      receipt: 'accepted' | 'durable';
    }
  | {
      request_id: Id;
      channel: 'desktop.operation_check';
      outcome: 'ok';
      /**
       * state_changed は読み取った状態が保留を付けたときより進んでいた。state_unchanged は変わっていなかった。どちらも読み取った事実だけで、命令が届いたかは断定しない（読み取った状態は一覧に反映する）。
       */
      resolved: 'state_changed' | 'state_unchanged';
    }
  | {
      request_id: Id;
      channel: 'desktop.canvas_user_op';
      outcome: 'ok';
      canvas_revision: CanvasRevision;
    }
  | {
      request_id: Id;
      channel: 'desktop.canvas_content';
      outcome: 'ok';
      canvas_revision: CanvasRevision;
      item_id: CanvasItemId;
      open_index: CanvasOpenIndex | null;
      content: CanvasContent;
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
        | 'io_epoch_mismatch'
        | 'pairing_step_mismatch'
        | 'secure_storage_unavailable'
        | 'hub_screen_required'
        | 'not_connected'
        | 'entry_not_found'
        | 'core_rejected'
        | 'outcome_unknown'
        | 'fingerprint_tail_mismatch'
        | 'pairing_host_not_allowed'
        | 'confirmation_declined'
        | 'confirmation_pending'
        | 'list_superseded'
        | 'home_network_changed'
        | 'preview_stale'
        | 'input_stopped'
        | 'content_unavailable'
        | 'canvas_conflict';
      /**
       * outcome_unknown のときだけ: 結果が分からなかった時点の一覧の通し番号（自宅の登録では自宅の要求の通し番号）。画面はこれより大きい番号の同じ種類の一覧・自宅の読み取りを受け取るまで、その行・登録を操作させない（ADR 0022・0026）。
       */
      list_seq?: number;
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
 * 中枢との接続・登録・ペアリングの状態（設計 02 端末登録と接続、07 §2〜§4、ADR 0025）。main が作り、UI レンダラーは表示するだけ。端末トークン・申請用の秘密・端末 ID・中枢の証明書の本体・自宅の指紋の値を含めない。
 */
export type DesktopConnectionView =
  | {
      visibility: 'hidden';
      lock_state: 'locked' | 'unknown';
    }
  | {
      visibility: 'shown';
      registration:
        | 'unregistered'
        | 'registered'
        | 'reregistration_required'
        | 'secure_storage_unavailable';
      link:
        | 'not_connected'
        | 'connecting'
        | 'connected'
        | 'waiting_retry'
        | 'upgrade_required'
        | 'reregistration_required';
      link_reason: DesktopLinkReason | null;
      last_confirmed_at: UtcTime | null;
      retry_at: UtcTime | null;
      pairing: {
        step:
          | 'fetching_certificate'
          | 'fingerprint_check'
          | 'code_entry'
          | 'claiming'
          | 'waiting_approval'
          | 'failed';
        /**
         * 中枢の宛先（Tailscale の IP アドレスか名前）。端末は名前ではなく証明書の指紋で中枢を確かめる（ADR 0020）。URL・パス・ポートを含めない。名前の形は domain の HUB_HOSTNAME_PATTERN と同じ一つの正規表現（末尾のドットを一つ許す）。main はペアリングの開始で正規化し（末尾のドットを除いて小文字にする）、ペアリングで受け付ける宛先を Tailscale のアドレス（100.64.0.0/10・fd7a:115c:a1e0::/48）・ループバック・*.ts.net の名前に限る（ADR 0025）。
         */
        host: DesktopHubHost & DesktopHubHost1;
        port: number;
        fingerprint: Hash | null;
        claim_expires_at: UtcTime | null;
        failure: DesktopPairingFailure | null;
        claim_check: PairingClaimCheck | null;
        /**
         * 今「やめる」をすぐに受け付けるか。受取りの要求が進んでいる間は false で、画面は「やめる」を押せなくする（main は受取りの結果を捨てず、トークンが届けば保存する。ADR 0025）。
         */
        cancelable: boolean;
      } | null;
      home_network: {
        allowed: boolean;
        exempt: boolean;
        reasons: HomeNetworkReason[];
        reported_at: UtcTime;
      } | null;
      operations: DesktopOperationEntry[];
      budget_items: DesktopBudgetEntry[];
      hub_screen: boolean;
      hub_target: {
        /**
         * 中枢の宛先（Tailscale の IP アドレスか名前）。端末は名前ではなく証明書の指紋で中枢を確かめる（ADR 0020）。URL・パス・ポートを含めない。名前の形は domain の HUB_HOSTNAME_PATTERN と同じ一つの正規表現（末尾のドットを一つ許す）。main はペアリングの開始で正規化し（末尾のドットを除いて小文字にする）、ペアリングで受け付ける宛先を Tailscale のアドレス（100.64.0.0/10・fd7a:115c:a1e0::/48）・ループバック・*.ts.net の名前に限る（ADR 0025）。
         */
        host: DesktopHubHost & DesktopHubHost1;
        port: number;
      } | null;
    };
/**
 * 中枢との接続が切れた・使えない理由（packages/client の LinkReason、ADR 0025）。値・宛先を含めない。
 */
export type DesktopLinkReason =
  | 'unreachable'
  | 'outside_home_network'
  | 'rate_limited'
  | 'dependency_unavailable'
  | 'protocol_error'
  | 'core_stopping'
  | 'slow_consumer'
  | 'stream_closed'
  | 'alive_timeout'
  | 'resnapshot'
  | 'unauthenticated'
  | 'device_revoked'
  | 'certificate_mismatch'
  | 'api_major_mismatch';
/**
 * ペアリングが失敗した理由（ADR 0025）。pickup_unknown は受取りの結果が分からない（自動で再送しない。中枢で失効してやり直す）。
 */
export type DesktopPairingFailure =
  | 'certificate_unavailable'
  | 'certificate_changed'
  | 'unreachable'
  | 'pairing_failed'
  | 'outside_home_network'
  | 'rate_limited'
  | 'claim_expired'
  | 'pickup_refused'
  | 'pickup_unknown'
  | 'secure_storage_unavailable'
  | 'storage_failed'
  | 'protocol_error';
/**
 * 有料処理の起点（本人の判断 2026-10-23）。owner_request は本人の依頼（本人が頼んだ背景の処理を含む）で本人の依頼の枠を使う。自発的な解析・自動実行・初回の読み込み・影モードは自発の枠を使う。
 */
export type BudgetOrigin =
  | 'owner_request'
  | 'autonomous_analysis'
  | 'auto_execution'
  | 'initial_import'
  | 'shadow_mode';
/**
 * 物のデータの参照（item_refs）の位置（UI-07）。メールの本文を開く行。
 */
export type CanvasOpenIndex = number;
/**
 * キャンバスの物の中身（UI-07、ADR 0032）。記述（CanvasDocument）は参照だけで本文を持たず、中身は物ごとに、描くときに許可範囲内で取る（postCanvasContent）。中枢の識別子を含まない（行は item_refs と同じ順の位置で参照に結び付ける）。端末に保存せず、イベントにも入れない。ロック・停止・切断・世代の変化で捨てる。
 */
export type CanvasContent =
  | CanvasContentList
  | CanvasContentTable
  | CanvasContentTimeline
  | CanvasContentMail
  | CanvasContentCompare
  | CanvasContentProgress
  | CanvasContentChart
  | CanvasContentSources
  | CanvasContentPlain;
/**
 * キャンバスの部品の本文の 1 行の文字列（UI-07、ADR 0032）。プレーンテキストとしてだけ描く（React の文字列の子。HTML として解釈せず、リンクにしない）。制御文字・改行・双方向の制御文字を拒否する。マークアップや URL の文字は文字として見えるだけ。
 */
export type CanvasContentText = string;
/**
 * 表・見比べるの値（UI-07）。空の文字列は値がないことを表す。1 行のプレーンテキスト。
 */
export type CanvasContentCell = string;
/**
 * キャンバスの部品の短い名前（ラベル・列の名前・軸の名前。UI-07）。24 文字まで、1 行のプレーンテキスト。
 */
export type CanvasContentLabel = string;
/**
 * 話の本体・メールの本文（UI-07）。改行（U+000A）だけを許すプレーンテキストで、2000 文字（UTF-16 の単位）まで。HTML として解釈せず、リンクにしない。
 */
export type CanvasContentBody = string;
/**
 * グラフの値（UI-07）。有限の数。
 */
export type CanvasChartValue = number;
/**
 * 出典の URL（UI-07）。https だけ。ユーザー名・パスワードを含まない。画面は外部のブラウザーで開く（main の window.open の規則。アプリの中では開かない）。
 */
export type CanvasContentUrl = string;
/**
 * UI レンダラーから main への限定 IPC のチャネル（設計 10 §1、07 §2、ADR 0014・0025）。端末トークン・端末 ID・中枢の停止・任意の URL や HTTP の実行を表すチャネルはない。中枢との接続・ペアリングは用途別のチャネルだけで、要求の宛先・本文を Renderer が決められない。音声レンダラーの IPC（B05）は別に定める。 発言・承認表示の準備・承認・取消・照合は用途別のチャネルで、操作は main が持つ参照（ref）で指す（B04-05、ADR 0031）。 キャンバスを前に出す（canvas_summon）は状態の層と入力バーからだけ使う（UI-02、ADR 0032）。状態の層のパネルを出す・しまう（status_panel）は状態の層からだけ使う（UI-04、ADR 0032）。キャンバスのユーザーの操作（canvas_user_op）はキャンバスの窓からだけ、キャンバスが前に出ている間だけ使う（UI-06、ADR 0032）。 予算の確認（超過枠の承認・見送り budget_overage_decide、M 超過の確認 budget_overrun_review、不明な費用の手での精算 budget_manual_settle）は状態の層からだけ使う。承認・確認・精算は main の OS の確認ダイアログを 1 回だけ挟み、画面が持つのは main が作る参照（ref）だけ（B07-05、ADR 0039）。
 */
export type DesktopIpcChannel =
  | 'desktop.get_state'
  | 'desktop.io_stop'
  | 'desktop.io_resume'
  | 'desktop.window_hide'
  | 'desktop.client_quit'
  | 'desktop.get_connection'
  | 'desktop.pairing_begin'
  | 'desktop.pairing_confirm'
  | 'desktop.pairing_submit'
  | 'desktop.pairing_cancel'
  | 'desktop.claims_list'
  | 'desktop.claim_decide'
  | 'desktop.devices_list'
  | 'desktop.device_revoke'
  | 'desktop.pairing_open'
  | 'desktop.home_status'
  | 'desktop.home_register'
  | 'desktop.turn_submit'
  | 'desktop.operation_preview'
  | 'desktop.operation_approve'
  | 'desktop.operation_cancel'
  | 'desktop.operation_reconcile'
  | 'desktop.operation_retry'
  | 'desktop.operation_check'
  | 'desktop.canvas_summon'
  | 'desktop.status_panel'
  | 'desktop.canvas_user_op'
  | 'desktop.canvas_content'
  | 'desktop.budget_overage_decide'
  | 'desktop.budget_overrun_review'
  | 'desktop.budget_manual_settle';
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
    }
  | {
      channel: 'desktop.connection_changed';
      connection: DesktopConnectionView;
    }
  | {
      channel: 'desktop.canvas_changed';
      canvas: DesktopCanvasView | null;
    }
  | {
      channel: 'desktop.canvas_work_area';
      insets: {
        top: number;
        right: number;
        bottom: number;
        left: number;
      };
    };
/**
 * 物の種類（ADR 0032）。card はキャンバスの格子に置くカード、float はキャンバスの窓の中に浮かぶフローティングウィンドウ。どちらもキャンバスの窓の外に出られない。
 */
export type CanvasItemKind = 'card' | 'float';
/**
 * 決まった部品の集合（ADR 0032）。描画は HeroUI で作った部品だけで行い、AI はコード・HTML・CSS を出さない。text は 1 回の答えにつき 1 つまで（意味の検査）。
 */
export type CanvasComponent =
  | 'list'
  | 'table'
  | 'schedule_timeline'
  | 'mail_card'
  | 'compare'
  | 'progress'
  | 'chart'
  | 'source_list'
  | 'text';
/**
 * 物の見出し（ADR 0032）。24 文字（コードポイント）まで・1 行。制御文字・改行・双方向の上書きと埋め込み・分離の文字（U+202A〜202E・U+2066〜2069）・方向の印（U+200E・200F・061C）を拒否する。マークアップ（閉じたタグ（空白なしの自己終了 <br/> を含む）・終わりのタグ・<! と <?・属性の形）と、URL のスキーム（http・https・javascript・vbscript・data・file・ftp・blob・mailto の後の :。直前が ASCII の英数字でないとき）、www. で始まる表現も拒否する。大文字・小文字は ASCII の文字集合で明示し、domain の検査と同じパターンを使う。描画はプレーンテキストだけ。空白だけの見出しは意味の検査で拒否する。
 */
export type CanvasHeading = string;
/**
 * 強調の度合い（ADR 0032）。色・大きさ・置き場所は部品と配置のエンジンが決める。
 */
export type CanvasEmphasis = 'low' | 'normal' | 'high';
/**
 * まとまりの名前（ADR 0032）。同じまとまりの物を近くに置く。
 */
export type CanvasGroupId = string;
/**
 * 置き場所（ADR 0032）。canvas は見える物、shelf は下の棚に片付けた物。
 */
export type CanvasPlacement = 'canvas' | 'shelf';
/**
 * キャンバスの 1 つの操作（ADR 0032）。add・update・move・close・relayout だけ。move は grid と placement の少なくとも 1 つを持つ（ピクセル・座標は持たない）。relayout は読む順とまとまりに沿って配置のエンジンに置き直させる。
 */
export type CanvasOp =
  | {
      op: 'add';
      item: CanvasItem;
    }
  | {
      op: 'update';
      item_id: CanvasItemId;
      changes: CanvasItemChanges;
    }
  | {
      op: 'move';
      item_id: CanvasItemId;
      grid?: CanvasGrid;
      placement?: CanvasPlacement;
    }
  | {
      op: 'close';
      item_id: CanvasItemId;
    }
  | {
      op: 'relayout';
    };
/**
 * 区切り（segment）を新しく始めた理由（ADR 0032）。Core だけが選ぶ。idle_timeout は 30 分やりとりがない、date_changed は本人の時間帯で日付が変わった、private_started・private_ended は記録しない会話（StorageMode private）に入った・出た、storage_mode_changed はそれ以外の保存モードの変更、user_requested は区切りの指示、forget_requested は忘却の指示。
 */
export type SegmentBoundaryReason =
  | 'stream_started'
  | 'idle_timeout'
  | 'date_changed'
  | 'private_started'
  | 'private_ended'
  | 'storage_mode_changed'
  | 'user_requested'
  | 'forget_requested';
/**
 * キャンバスを置く画面の設定（UI-06、ADR 0032）。端末に保存してよい配置の設定はこれだけで、キャンバスの本文・見出し・参照・置き場所を持たない。primary（既定）は主の画面、display は OS の画面の ID の画面（なければ主の画面）。キャンバス・状態の層・入力バーを同じ画面に置く。すべての画面を 1 枚につなぐ形はない。
 */
export type DesktopCanvasDisplaySettings =
  | {
      schema_version: 1;
      target: 'primary';
    }
  | {
      schema_version: 1;
      target: 'display';
      display_id: number;
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
/**
 * 返信の下書きの作成（draft_reply、RemoteMutation、ADR 0027）。target は返信元のメール。下書きは送らないので external_recipients は空。宛先は返信元から Core が決め、モデルに作らせない（ADR 0004）。結果不明は操作の目印（operation_id と content_version）でアカウント内を照合する。
 */
export interface DraftReplyOperationIntent {
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
    kind: 'mail.draft.create';
    /**
     * @minItems 1
     */
    to: [string, ...string[]];
    cc: string[];
    subject: string;
    body: string;
  };
  effects: {
    /**
     * @maxItems 0
     */
    external_recipients: [];
    reconcile_scope: 'operation_marker';
  };
}
/**
 * Buddy 内の用事の登録（create_task、LocalCommand、ADR 0027）。外部 HTTP を使わず、承認の後に一つの transaction で適用する。target.list_id は登録先の一覧、permission_revision は Buddy 内の用事の保存先の許可の版。
 */
export interface TaskOperationIntent {
  schema: 'buddy.operation.v1';
  operation_id: Id;
  content_version: ContentVersion;
  permission_revision: PermissionRevision;
  target: {
    list_id: string;
  };
  action: {
    kind: 'task.create';
    title: string;
    due: DateOrDateTime | null;
    body: string | null;
  };
  effects: {
    /**
     * @maxItems 0
     */
    external_recipients: [];
    reconcile_scope: 'local_transaction';
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
/**
 * 承認表示の準備の応答。確定 intent（種類は action.kind）と content_hash。承認ではない（ADR 0027 で LabelPreview を一般化）。
 */
export interface OperationPreview {
  preview_id: Id;
  intent: OperationIntent;
  content_hash: Hash;
  state_revision: StateRevision;
  /**
   * 承認画面で口座と対象のメールを見分ける表示用の値（B04-05、ADR 0031）。外部変更の preview で Core が provider から読む。読めない項目は null で、画面は対象を確認できないと言い、承認へ進ませない。LocalCommand は両方 null。確定 intent の一部ではなく、content_hash に含めない。
   */
  display?: {
    account_label: string | null;
    target: {
      subject: string | null;
      sender: string | null;
      received_at: string | null;
    } | null;
  };
}
/**
 * 操作の内容の表示用の読み取り（B04-05、ADR 0031）。取消・再試行の確認に出す見出しを、承認待ち以外の状態でも取り直すための応答。preview と同じ確定 intent と表示用の値を、preview_id なしで返す（preview は発行せず、承認にも使えない）。content_version と content_hash は、画面が今の操作の内容版・hash と照合するための値。認可は preview と同じ。内容はこの応答だけで、イベント・スナップショットには入れない。
 */
export interface OperationDisplay {
  content_version: ContentVersion;
  content_hash: Hash;
  state_revision: StateRevision;
  intent: OperationIntent;
  /**
   * 承認画面で口座と対象のメールを見分ける表示用の値（B04-05、ADR 0031）。外部変更の preview で Core が provider から読む。読めない項目は null で、画面は対象を確認できないと言い、承認へ進ませない。LocalCommand は両方 null。確定 intent の一部ではなく、content_hash に含めない。
   */
  display: {
    account_label: string | null;
    target: {
      subject: string | null;
      sender: string | null;
      received_at: string | null;
    } | null;
  };
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
 * 操作の状態投影。operation_kind は確定 intent の action.kind（ADR 0027）。allowed_actionsは表示補助であり、実行時の認可ではない。
 */
export interface OperationSnapshot {
  operation_id: Id;
  operation_kind: OperationKind;
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
  profile_id: ProfileId;
  price_version: PriceVersionId;
  budget_month: YearMonth;
  pool_id: BudgetPoolId;
  reserved_amount: Money;
  max_liability: Money;
  status: 'reserved' | 'usage_unknown' | 'settled' | 'released';
  provider_reconciliation_id: string | null;
  actual_gross: Money | null;
  credit_applied: Money | null;
  additional_spend: Money | null;
  credit_cycle_id: CreditCycleId | null;
  approval_id: Id | null;
  overrun_reviewed: boolean;
  /**
   * UTC の RFC 3339 表現。区切りは大文字の T と Z だけ。JavaScript の Date で扱えないうるう秒は拒否する。元の地域時間と終日は別に扱う。
   */
  created_at?: string;
  /**
   * 予約の処理の起点（本人の依頼か、自発の処理か。表示用）。記録のない古い行では省く。
   */
  origin?:
    | 'owner_request'
    | 'autonomous_analysis'
    | 'auto_execution'
    | 'initial_import'
    | 'shadow_mode';
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
  cycle_id: CreditCycleId;
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
  verified_price_versions: PriceVersionId[];
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
  profile_id: ProfileId;
  price_version: PriceVersionId;
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
 * 確定した usage による精算。request_id と provider の照合 ID で一度だけ適用し、元の月・元の枠に計上する。同じ値の再適用は変化なし、異なる値は競合。 provider_reconciliation_id は manual: で始めない（手での精算と区別する、ADR 0034）。
 */
export interface BudgetSettlement {
  reservation_id: Id;
  request_id: Id;
  provider_reconciliation_id: string;
  actual_gross: Money;
  credit_applied: Money;
  additional_spend: Money;
  credit_cycle_id: CreditCycleId | null;
}
/**
 * 単価の版（設計 05 費用の計算 D15・F02、ADR 0034）。適用期間は effective_from 以上 effective_to 未満（null は終わりを決めていない）。適用期間の境界を跨ぐ要求は、跨ぐ版のうち高い方の単価で M を出す。価格が確認されていない版（BudgetConfig.verified_price_versions にない版）の profile は受け付けない。単価は実行時の設定ファイルに置き、リポジトリに置かない。
 */
export interface PriceVersion {
  price_version: PriceVersionId;
  price_key: PriceKey;
  currency: string;
  effective_from: PriceTime;
  effective_to: PriceTime | null;
  /**
   * @minItems 1
   */
  rates: [PriceRate, ...PriceRate[]];
  conversion: CurrencyConversion;
}
/**
 * 課金区分ごとの単価。unit_price は版の通貨の百万分の一で、per_quantity 単位あたり。minimum_quantity は 1 回の最低課金量（会話の接続の 15 秒など。なければ 0）。max_quantity_per_request は 1 要求で課金され得る最大量で、M の算出に使う。null は入力（送る量が要求の時点で決まる）だけに許し、他の区分で null なら M を有限にできないので profile を有効にしない（設計 05 F02）。
 */
export interface PriceRate {
  category: PriceCategory;
  unit_price: Amount;
  /**
   * unit_price が何単位あたりか（例: 1000000 token）。
   */
  per_quantity: string;
  minimum_quantity: QuantityString;
  max_quantity_per_request: QuantityString | null;
}
/**
 * 単価の通貨から予算の通貨への換算（設計 05 費用の計算）。rate は 1 単位あたりの予算の通貨の量、safety_factor は換算・税・見積りの誤差の係数で 1 以上。値は本人の設定で、契約・試験には合成値だけを使う。同じ通貨なら rate は 1。
 */
export interface CurrencyConversion {
  /**
   * 為替と安全係数の版の ID。
   */
  conversion_version: string;
  to_currency: string;
  rate: DecimalString;
  safety_factor: DecimalString;
}
/**
 * 予算の実行時の設定ファイル（本人の判断 2026-10-23、ADR 0034）。リポジトリの外に置き、中枢の起動時にこの定義と意味検査で確かめてから読み込む。検査に通らなければ有料処理を始めない。time_zone は予算月の境目を決める IANA タイムゾーンで、null は中枢の OS の設定。変えた値は翌月から反映し、その月に使ったタイムゾーンは Core が記録する。routing は起点から計上する枠と超過枠（B07-04）。秘密情報（API キーなど）を含めない。
 */
export interface BudgetRuntimeConfig {
  schema: 'buddy.budget-runtime.v1';
  time_zone: TimeZone | null;
  budget: BudgetConfig;
  price_versions: PriceVersion[];
  routing: BudgetRouting;
}
/**
 * 起点から計上する葉の枠と、個別承認の超過枠（B07-04、ADR 0037）。超過枠へ回せる通常の枠の許可リストは、本人の依頼（owner_request）の LLM・検索の枠から Core が作る（音声は入れない）。overage_pool_id が null なら超過枠へ回さない。枠の木（ADR 0006）の形は変えない。
 */
export interface BudgetRouting {
  routes: {
    owner_request: BudgetServiceRoutes;
    autonomous_analysis: BudgetServiceRoutes;
    auto_execution: BudgetServiceRoutes;
    initial_import: BudgetServiceRoutes;
    shadow_mode: BudgetServiceRoutes;
  };
  overage_pool_id: BudgetPoolId | null;
}
/**
 * ひとつの起点の処理を、サービス（LLM・検索・音声）ごとにどの葉の枠へ計上するか（B07-04、ADR 0037）。null はその起点でそのサービスの有料処理を受け付けない。
 */
export interface BudgetServiceRoutes {
  llm: BudgetPoolId | null;
  search: BudgetPoolId | null;
  voice: BudgetPoolId | null;
}
/**
 * 予算の利用状況（GET /v1/budget/usage、ADR 0034）。months は今月と、未精算・usage 不明・M 超過の確認待ちが残る前の月。time_zone は今月の予算月の境目に使っているタイムゾーン。overage_approvals は承認待ちの超過枠の承認。pending_reservations は本人の操作を待つ予約（usage 不明で手での精算を待つものと、M 超過の確認を待つもの）で、手での精算・M 超過の確認の要求に使う reservation_id・予約の版・個別の R と M・実費・月・枠を持つ。表示はキャンバス UI で作る。
 */
export interface BudgetUsageSummary {
  currency: string;
  time_zone: TimeZone;
  current_month: YearMonth;
  generated_at: UtcTime;
  /**
   * @minItems 1
   */
  months: [BudgetMonthUsage, ...BudgetMonthUsage[]];
  overage_approvals: BudgetOverageApproval[];
  pending_reservations: BudgetReservation[];
}
/**
 * 予算月ごとの利用状況。
 */
export interface BudgetMonthUsage {
  budget_month: YearMonth;
  /**
   * @minItems 1
   */
  pools: [BudgetPoolUsage, ...BudgetPoolUsage[]];
}
/**
 * 月と枠ごとの利用状況。settled は精算済みの実費（クレジット適用前の通常料金）、unsettled_reserved と unsettled_max_liability は reserved と usage_unknown の R と M の合計。子孫の枠の分を含む（ADR 0006 の数え方）。usage_unknown_count は手で精算するまで保持している件数。
 */
export interface BudgetPoolUsage {
  pool_id: BudgetPoolId;
  parent_pool_id: BudgetPoolId | null;
  limit: Money;
  settled: Money;
  unsettled_reserved: Money;
  unsettled_max_liability: Money;
  usage_unknown_count: number;
  overrun_review_count: number;
  hold_reasons: BudgetHoldReason[];
}
/**
 * 超過枠の個別の承認（設計 05 F02、01 承認画面、本人の判断 2026-10-23、ADR 0034）。1 つの request_id（予算の要求）と M に固定し、承認は main の OS の確認ダイアログで 1 回だけ行う。overage_remaining は承認を求めた時点の超過枠の残り（画面に M と並べて見せる値）。consumed はその承認で予約を受け付けた後。期限を過ぎた承認・別の M の予約には使わない。自発的な解析・自動実行には作らない。
 */
export interface BudgetOverageApproval {
  approval_id: Id;
  request_id: Id;
  pool_id: BudgetPoolId;
  budget_month: YearMonth;
  max_liability: Money;
  overage_remaining: Money;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
  requested_at: UtcTime;
  expires_at: UtcTime;
  decided_at: UtcTime | null;
}
/**
 * 超過枠の承認・拒否（POST /v1/budget/overage-approvals/{approval_id}/decision、ADR 0034）。request_id はこの命令の ID で、budget_request_id は承認する予算の要求（BudgetOverageApproval.request_id）。budget_request_id と M が承認待ちの記録と一致しなければ拒否する。同じ命令の再送は同じ結果を返し、二度押しで承認を 2 件にしない。
 */
export interface BudgetOverageDecision {
  request_id: Id;
  command_scope_id: Id;
  budget_request_id: Id;
  max_liability: Money;
  decision: 'approve' | 'reject';
}
/**
 * M 超過の確認（POST /v1/budget/reservations/{reservation_id}/overrun-review、設計 05 F02、ADR 0006・0034）。本人が見た実費と M を送り、記録と一致して実費が M を超えるときだけ overrun_reviewed にする。確認しても実費は変えず、他の枠へ振り替えない。
 */
export interface BudgetOverrunReview {
  request_id: Id;
  command_scope_id: Id;
  expected_reservation_revision: ReservationRevision;
  actual_gross: Money;
  max_liability: Money;
}
/**
 * 不明な費用の手での精算（POST /v1/budget/reservations/{reservation_id}/manual-settlement、本人の判断 2026-10-23、ADR 0034）。usage_unknown の予約だけに、元の月・元の枠のまま一度だけ適用する。推測の値を実費として記録しない。請求の照合（B15）で結び付けた実額を入れる。
 */
export interface BudgetManualSettlement {
  request_id: Id;
  command_scope_id: Id;
  expected_reservation_revision: ReservationRevision;
  /**
   * 手で入力した照合 ID。manual: で始め、provider の照合 ID と区別する。英数字と . _ - だけで、メールアドレス・氏名・自由文を入れない。
   */
  manual_reconciliation_id: string;
  actual_gross: Money;
  credit_applied: Money;
  additional_spend: Money;
  credit_cycle_id: CreditCycleId | null;
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
  profile_id: ProfileId;
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
  price_version: PriceVersionId | null;
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
 * 一つの整合した DB 読取りで得た現在の表示状態と、その境界のイベント位置（設計 07 §4）。表示権限に応じて返し、ロック中・停止中は再開用の管理情報だけ（management_only）にする。budget_hold は予算保留（ADR 0037）で、management_only では null。
 */
export interface Snapshot {
  store_generation: StoreGeneration;
  core_instance_id: Id;
  event_cursor: EventCursor;
  view: 'full' | 'management_only';
  io_state: DeviceIOState;
  budget_hold: BudgetHoldState | null;
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
 * 状態欄の「予算保留」（設計 01 いつも見える状態、B07-04、ADR 0037）。reasons は有料の受付全体を止めている理由、held_pools は今月に保留している枠とその理由。held はどちらかがあるとき true。金額を含めない。
 */
export interface BudgetHoldState {
  held: boolean;
  reasons: BudgetGateHoldReason[];
  held_pools: {
    pool_id: BudgetPoolId;
    /**
     * @minItems 1
     */
    hold_reasons: [BudgetHoldReason, ...BudgetHoldReason[]];
  }[];
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
  hub_endpoint: HubEndpoint;
}
/**
 * 中枢の HTTPS の待ち受けのアドレスとポート（Core の設定の値。待ち受けは具体的な IP アドレスで、0.0.0.0 などは使わない。ADR 0020）。登録する端末で入力する宛先として、中枢の画面に表示する（ADR 0026）。秘密ではない。
 */
export interface HubEndpoint {
  host: string;
  port: number;
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
/**
 * 承認待ちの申請の一覧（B03-06、ADR 0026）。今の中枢の証明書で始めたペアリングの、期限の前の pending の申請だけを、申請の時刻の順に返す。
 */
export interface PairingClaimList {
  claims: PendingPairingClaim[];
}
/**
 * 承認待ちの申請（B03-06、ADR 0026）。中枢の画面で承認・拒否するための最小限の値で、コード・申請用の秘密・その hash・トークンを含めない。claimed_at は申請を受け付けた時刻（期限の 5 分前）。
 */
export interface PendingPairingClaim {
  claim_id: Id;
  device_name: string;
  platform: DevicePlatform;
  claimed_at: UtcTime;
  expires_at: UtcTime;
  claim_check: PairingClaimCheck;
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
/**
 * 自宅の登録の状態（中枢の画面だけ。B03-08、ADR 0022）。未登録なら registration は null。登録済みならサブネット・SSID を登録したか・最終更新の時刻だけを返し、MAC・SSID・その HMAC・登録した端末は返さない。
 */
export interface HomeRegistrationState {
  registration: HomeRegistration | null;
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
/**
 * 配置のエンジンの格子のマス（UI-06、ADR 0032）。12 列で、列・行は 1 から。column + span − 1 が 12 を超えないこと（意味の検査）。ピクセル・座標は持たない。ユーザーの置き場所と、ユーザーの操作の置く先に使う。
 */
export interface CanvasCell {
  column: number;
  row: number;
  span: number;
  rows: number;
}
/**
 * 画面に出す操作（B04-05、ADR 0031）。ref は main が操作ごとに作る参照で、操作 ID・内容版・hash・provider の受領 ID を含めない。allowed_actions は表示補助で、実行時の認可ではない。
 */
export interface DesktopOperationEntry {
  ref: Id;
  operation_kind: OperationKind;
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
  result: ('confirmed_success' | 'confirmed_not_executed' | 'unknown') | null;
  state_revision: StateRevision;
  /**
   * 承認・取消の命令を送ったが、中枢に届いたか確かめられていない（結果不明）。操作の状態が進むまで、同じ命令を自動で送り直さず、画面からも送らせない。
   */
  delivery_unknown: boolean;
  /**
   * 一覧の行の見出しにする内容の 1 行（用事の題名・メールの件名など）。main が承認表示の準備で読んだ値で、イベント・スナップショットには入れない。読めていなければ null（画面は操作の種類を見出しにする）。
   */
  headline: string | null;
  /**
   * 見出しの補足（期限・宛先・ラベルの変更など）。
   */
  detail: string | null;
}
/**
 * 状態の層の確認の一覧に出す予算の確認（B07-05、ADR 0039）。ref は main が項目ごとに作る参照で、承認 ID・予算の要求 ID・予約 ID・予約の版・照合値を含めない。kind: overage_approval は超過枠の個別の承認（max_liability は承認する依頼の M、overage_remaining は承認を求めた時点の超過枠の残り、expires_at は承認の期限。actual_gross は null）、overrun_review は M 超過の確認（actual_gross は記録した実費、max_liability は M。overage_remaining・expires_at は null）、manual_settlement は不明な費用の手での精算（max_liability は保持している M。actual_gross・overage_remaining・expires_at は null で、本人が実費を入力する）。金額は本人の設定に基づく実行時の値で、契約・fixture・撮影には合成の通貨 XTS だけを使う。 origin・profile_id・occurred_at は、同じ月・枠・金額の項目を本人が見分けるための表示用の値で、依頼の本文は含めない。
 */
export interface DesktopBudgetEntry {
  ref: Id;
  kind: 'overage_approval' | 'overrun_review' | 'manual_settlement';
  pool_id: BudgetPoolId;
  budget_month: YearMonth;
  /**
   * 処理の起点（本人の依頼・自動の解析など。表示の用途）。中枢が記録していなければ null。
   */
  origin: BudgetOrigin | null;
  /**
   * 予約したモデルの名前（profile の ID。表示用）。承認待ちには記録がないので null。
   */
  profile_id: ProfileId | null;
  /**
   * 対象が発生した日時（承認は求めた時刻、予約は受け付けた時刻）。本人が同じ金額・同じ枠の項目を見分けるために出す。中枢が記録していなければ null。
   */
  occurred_at: UtcTime | null;
  max_liability: Money;
  overage_remaining: Money | null;
  actual_gross: Money | null;
  expires_at: UtcTime | null;
  /**
   * 決定・確認・精算の命令を送ったが、中枢に届いたか確かめられていない（結果不明）。次の利用状況の読み取りで解くまで、同じ命令を自動で送り直さず、画面からも送らせない。
   */
  delivery_unknown: boolean;
}
/**
 * 画面に出す承認待ちの申請（B03-06、ADR 0026）。ref は main が一覧ごとに作る参照で、申請 ID・コード・秘密を含めない。
 */
export interface DesktopClaimEntry {
  ref: Id;
  device_name: string;
  platform: DevicePlatform;
  claimed_at: UtcTime;
  expires_at: UtcTime;
  claim_check: PairingClaimCheck;
}
/**
 * 画面に出す登録済みの端末（B03-06、ADR 0026）。ref は失効できる端末（この端末・失効済みでない）だけにある main の参照で、端末 ID・トークンを含めない。
 */
export interface DesktopDeviceEntry {
  ref: Id | null;
  device_name: string;
  platform: DevicePlatform;
  hub_local: boolean;
  this_device: boolean;
  registered_at: UtcTime;
  last_seen_at: UtcTime | null;
  revoked_at: UtcTime | null;
}
/**
 * 中枢の画面に出すワンタイムコードと中枢の証明書の指紋（B03-06、ADR 0026）。コードは本人が登録する端末に入力するための表示で、中枢の画面の端末の画面にだけ返す（申請の一覧・端末の一覧・ログには出さない）。hub_endpoint は端末で入力する中枢の宛先（表示用）。
 */
export interface DesktopPairingSession {
  pairing_code: string;
  certificate_fingerprint: Hash;
  expires_at: UtcTime;
  hub_endpoint: HubEndpoint;
}
/**
 * 中枢の画面の「自宅のネットワーク」（B03-08、ADR 0022）。registration は中枢の登録（未登録は null）。observation はこのマシンが今つながっているネットワークの伏せた表示で、読み取れなかった（失敗・時間切れ・どの要素も取れない）ときは null。MAC・SSID の生の値とその HMAC を含めない。
 */
export interface DesktopHomeView {
  registration: HomeRegistration | null;
  observation: DesktopHomeObservation | null;
}
/**
 * このマシン（中枢）が今つながっているネットワークの指紋の伏せた表示（B03-08）。ゲートウェイの MAC は最後の 2 組だけ、サブネットはそのまま、SSID は先頭の 1 文字と文字数だけ。取れない要素は null。ref は登録に使う main の参照で、ゲートウェイの MAC とサブネットの両方が取れたときだけある。ssid_unavailable_reason は SSID が取れない理由（redacted は OS の位置情報の許可がなく伏せられた、ambiguous は無線の接続口が複数、unavailable はそれ以外・有線）で、SSID が取れたときは null。
 */
export interface DesktopHomeObservation {
  ref: Id | null;
  collected_at: UtcTime;
  gateway_mac_tail: string | null;
  subnet: HomeSubnet | null;
  ssid_hint: DesktopSsidHint | null;
  ssid_unavailable_reason: ('redacted' | 'ambiguous' | 'unavailable') | null;
}
/**
 * SSID の伏せた表示（B03-08）。length は文字数（Unicode のコードポイントの数）。first は先頭の 1 文字で、SSID が 3 文字以下なら null（短い SSID は先頭の文字で大半が分かるため、文字数だけを出す）。
 */
export interface DesktopSsidHint {
  first: string | null;
  length: number;
}
/**
 * 発言への文字の結果（B04-05、ADR 0031）。main が中枢の TurnResponse から作る表示用の値で、会話・発言・依頼・入力の ID と item_refs の ID を含めない。予定の照会は件数だけ（本文は開いたときに許可範囲内で取得する設計で、B04 にその経路はない）、承認が要る操作は operation_ref（desktop.operation_preview に渡す参照）で指す。
 */
export interface DesktopTurnResult {
  status: 'answered' | 'clarification' | 'background' | 'session_control';
  reply_text: string | null;
  result: {
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
    intent: IntentName;
    event_count: number;
    overlap_count: number;
    more_count: number;
    operation_ref: Id | null;
  } | null;
}
/**
 * 承認画面に出す確定した変更の内容（設計 01 承認画面の必須内容。B04-05、ADR 0031）。main が中枢の OperationPreview から作る表示用の値で、preview_id・content_hash・state_revision・アカウント ID・操作 ID を含めない（main が preview_ref の裏に持つ）。service は変更先（buddy は Buddy 内の用事）、target は対象（メールの ID・用事の一覧）。
 */
export interface DesktopOperationPreview {
  preview_ref: Id;
  operation_kind: OperationKind;
  service: 'mock' | 'gmail' | 'microsoft_graph' | 'buddy';
  target: string | null;
  fields: {
    field:
      | 'labels_add'
      | 'labels_remove'
      | 'draft_to'
      | 'draft_cc'
      | 'draft_subject'
      | 'draft_body'
      | 'task_title'
      | 'task_due'
      | 'task_body';
    values: string[];
  }[];
  /**
   * 口座の表示名（メールアドレスなど）。Buddy 内の用事は null。
   */
  account_label: string | null;
  /**
   * 対象のメールの件名・差出人・受信日時。読めない項目は null。
   */
  target_detail: {
    subject: string | null;
    sender: string | null;
    received_at: string | null;
  } | null;
  /**
   * 承認へ進めてよいか。外部変更で、口座の表示名と対象のメールの件名・差出人・受信日時がすべてそろわないときは false で、画面は承認を出さず、main も承認を送らない。
   */
  approvable: boolean;
}
/**
 * list の中身（UI-07）。rows は物のデータの参照（item_refs）と同じ順・同じ件数（意味の検査）。
 */
export interface CanvasContentList {
  component: 'list';
  /**
   * @maxItems 50
   */
  rows: CanvasContentListRow[];
}
/**
 * 用事・気づきの行（UI-07）。題名・期限・状態（open は未了、done は済み、attention は気づき）。
 */
export interface CanvasContentListRow {
  title: CanvasContentText;
  due_at: UtcTime | null;
  state: 'open' | 'done' | 'attention';
}
/**
 * table の中身（UI-07）。列は 8 まで、行は 50 まで。rows は item_refs と同じ順・同じ件数で、各行の cells の数は columns と同じ（意味の検査）。
 */
export interface CanvasContentTable {
  component: 'table';
  /**
   * @maxItems 8
   */
  columns:
    | []
    | [CanvasContentText]
    | [CanvasContentText, CanvasContentText]
    | [CanvasContentText, CanvasContentText, CanvasContentText]
    | [
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
      ]
    | [
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
      ]
    | [
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
      ]
    | [
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
      ]
    | [
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
        CanvasContentText,
      ];
  /**
   * @maxItems 50
   */
  rows: CanvasContentTableRow[];
}
/**
 * 表の 1 行（UI-07）。cells の数は columns と同じ（意味の検査）。
 */
export interface CanvasContentTableRow {
  /**
   * @maxItems 8
   */
  cells:
    | []
    | [CanvasContentCell]
    | [CanvasContentCell, CanvasContentCell]
    | [CanvasContentCell, CanvasContentCell, CanvasContentCell]
    | [
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
      ]
    | [
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
      ]
    | [
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
      ]
    | [
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
      ]
    | [
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
        CanvasContentCell,
      ];
}
/**
 * schedule_timeline の中身（UI-07）。時間の軸は 0 時からの分で day_start_minute から day_end_minute まで。events は item_refs と同じ順・同じ件数で、軸の範囲の中・開始が終了より前（意味の検査）。重なりは画面が位置で示す（決まった順に列を割り当てる）。
 */
export interface CanvasContentTimeline {
  component: 'schedule_timeline';
  day_start_minute: number;
  day_end_minute: number;
  /**
   * @maxItems 50
   */
  events: CanvasContentEvent[];
}
/**
 * 予定の 1 件（UI-07）。0 時からの分で開始と終了（開始が終了より前。意味の検査）。
 */
export interface CanvasContentEvent {
  title: CanvasContentText;
  start_minute: number;
  end_minute: number;
}
/**
 * mail_card の中身（UI-07）。差出人・件名・受信の時刻・ラベル。本文（body）は開いたときだけ（open_index の 1 通だけが非 null。ほかは null。意味の検査）。mails は item_refs と同じ順・同じ件数。
 */
export interface CanvasContentMail {
  component: 'mail_card';
  /**
   * @maxItems 50
   */
  mails: CanvasContentMailEntry[];
}
/**
 * メールの 1 通（UI-07）。差出人・件名・受信の時刻・ラベル。本文は開いた 1 通だけ（それ以外は null）。
 */
export interface CanvasContentMailEntry {
  from: CanvasContentText;
  subject: CanvasContentText;
  received_at: UtcTime;
  /**
   * @maxItems 5
   */
  labels:
    | []
    | [CanvasContentLabel]
    | [CanvasContentLabel, CanvasContentLabel]
    | [CanvasContentLabel, CanvasContentLabel, CanvasContentLabel]
    | [
        CanvasContentLabel,
        CanvasContentLabel,
        CanvasContentLabel,
        CanvasContentLabel,
      ]
    | [
        CanvasContentLabel,
        CanvasContentLabel,
        CanvasContentLabel,
        CanvasContentLabel,
        CanvasContentLabel,
      ];
  body: CanvasContentBody | null;
}
/**
 * compare の中身（UI-07）。2〜3 列を横に並べ、行ごとの値を比べる。各行の values の数は columns と同じ（意味の検査。参照の数とは結び付けない）。違いは画面が位置で示す（同じ値は 1 つにまとめ、違う値は列ごとに分ける）。
 */
export interface CanvasContentCompare {
  component: 'compare';
  /**
   * @maxItems 3
   */
  columns:
    | []
    | [CanvasContentText]
    | [CanvasContentText, CanvasContentText]
    | [CanvasContentText, CanvasContentText, CanvasContentText];
  /**
   * @maxItems 12
   */
  rows:
    | []
    | [CanvasContentCompareRow]
    | [CanvasContentCompareRow, CanvasContentCompareRow]
    | [
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
      ]
    | [
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
      ]
    | [
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
      ]
    | [
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
      ]
    | [
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
      ]
    | [
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
      ]
    | [
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
      ]
    | [
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
      ]
    | [
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
      ]
    | [
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
        CanvasContentCompareRow,
      ];
}
/**
 * 見比べるの 1 行（UI-07）。values の数は columns と同じ（意味の検査）。
 */
export interface CanvasContentCompareRow {
  label: CanvasContentLabel;
  /**
   * @maxItems 3
   */
  values:
    | []
    | [CanvasContentCell]
    | [CanvasContentCell, CanvasContentCell]
    | [CanvasContentCell, CanvasContentCell, CanvasContentCell];
}
/**
 * progress の中身（UI-07）。進み具合（done / total）。done が total を超えない（意味の検査。参照の数とは結び付けない）。
 */
export interface CanvasContentProgress {
  component: 'progress';
  /**
   * @maxItems 12
   */
  steps:
    | []
    | [CanvasContentStep]
    | [CanvasContentStep, CanvasContentStep]
    | [CanvasContentStep, CanvasContentStep, CanvasContentStep]
    | [
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
      ]
    | [
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
      ]
    | [
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
      ]
    | [
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
      ]
    | [
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
      ]
    | [
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
      ]
    | [
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
      ]
    | [
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
      ]
    | [
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
        CanvasContentStep,
      ];
}
/**
 * 進み具合の 1 つ（UI-07）。done が total を超えない（意味の検査）。
 */
export interface CanvasContentStep {
  label: CanvasContentText;
  done: number;
  total: number;
}
/**
 * chart の中身（UI-07）。棒（bar）と折れ線（line）の系列。値の数は x_labels と同じ（意味の検査）。画面は SVG を React で描き、系列を色だけでなく形（棒の模様・線の種類・印）と直接のラベルで分ける。
 */
export interface CanvasContentChart {
  component: 'chart';
  /**
   * @maxItems 24
   */
  x_labels: CanvasContentLabel[];
  /**
   * @maxItems 3
   */
  series:
    | []
    | [CanvasContentSeries]
    | [CanvasContentSeries, CanvasContentSeries]
    | [CanvasContentSeries, CanvasContentSeries, CanvasContentSeries];
}
/**
 * グラフの系列（UI-07）。棒（bar）か折れ線（line）。values の数は x_labels と同じ（意味の検査）。
 */
export interface CanvasContentSeries {
  label: CanvasContentLabel;
  mark: 'bar' | 'line';
  /**
   * @maxItems 24
   */
  values: CanvasChartValue[];
}
/**
 * source_list の中身（UI-07）。出典の題名と https の URL。sources は item_refs と同じ順・同じ件数。
 */
export interface CanvasContentSources {
  component: 'source_list';
  /**
   * @maxItems 50
   */
  sources: CanvasContentSource[];
}
/**
 * 出典の 1 件（UI-07）。題名と https の URL。
 */
export interface CanvasContentSource {
  title: CanvasContentText;
  url: CanvasContentUrl;
}
/**
 * text の中身（UI-07）。話の本体（プレーンテキスト）。1 回の答えにつき 1 つまで（キャンバスの意味の検査）。
 */
export interface CanvasContentPlain {
  component: 'text';
  text: CanvasContentBody;
}
/**
 * 画面へ渡すキャンバスの今の記述（ADR 0032）。main が中枢から取り、形式（CanvasDocument）と意味（domain）の検査を通してから、参照を不透明な参照に置き換えて渡す。ロック・切断・世代の変化では渡した記述を捨てる（canvas を null にして通知する）。
 */
export interface DesktopCanvasView {
  canvas_revision: CanvasRevision;
  /**
   * @maxItems 48
   */
  items: DesktopCanvasItem[];
  /**
   * @maxItems 24
   */
  reading_order: CanvasItemId[];
  /**
   * ユーザーの置き場所（UI-06）。省略は空と同じ（UI-05 までの記述との互換）。
   *
   * @maxItems 24
   */
  user_pins?: CanvasUserPin[];
}
/**
 * 画面へ渡すキャンバスの物（ADR 0032）。CanvasItem と同じ項目で、データの参照だけを不透明な参照にする。説明文の項目・承認・停止・取消の操作を持たない。見出しはプレーンテキストとしてだけ描く。
 */
export interface DesktopCanvasItem {
  item_id: CanvasItemId;
  kind: CanvasItemKind;
  component: CanvasComponent;
  heading: CanvasHeading;
  emphasis: CanvasEmphasis;
  group: CanvasGroupId | null;
  /**
   * @maxItems 4
   */
  relations:
    | []
    | [CanvasRelation]
    | [CanvasRelation, CanvasRelation]
    | [CanvasRelation, CanvasRelation, CanvasRelation]
    | [CanvasRelation, CanvasRelation, CanvasRelation, CanvasRelation];
  grid: CanvasGrid;
  placement: CanvasPlacement;
  data: DesktopCanvasData;
}
/**
 * ほかの物との関係（ADR 0032）。compare は見比べる、sequence は target の次、detail_of は target の詳細。関係はレイアウトで見せ、説明文にしない。
 */
export interface CanvasRelation {
  kind: 'compare' | 'sequence' | 'detail_of';
  target: CanvasItemId;
}
/**
 * 12 列の格子のヒント（ADR 0032）。column + span − 1 が 12 を超えないこと（意味の検査）。ピクセル・座標・画面の大きさは持たない。最後の配置は配置のエンジンが決める。
 */
export interface CanvasGrid {
  column: number;
  span: number;
  rows: number;
}
/**
 * 画面へ渡す物のデータ（ADR 0032）。CanvasData と同じ上限で、参照の ID だけを不透明な参照にする。本文・説明文を持たない。
 */
export interface DesktopCanvasData {
  /**
   * @maxItems 50
   */
  item_refs: DesktopCanvasRef[];
  more_count: number;
}
/**
 * 画面へ渡す表示対象の参照（ADR 0032）。中枢の識別子（予定・メールの ID など）を main の中に持ち、画面には main が作った不透明な参照だけを渡す。ref は中枢の識別子から作らず、同じ世代の中では同じ物の同じ対象に同じ参照を保ち（配置だけが変わった版で画面の本文を取り直さないため）、世代が進むと作り直す。
 */
export interface DesktopCanvasRef {
  kind: string;
  ref: Id;
}
/**
 * ユーザーが動かした・大きさを変えた物の置き場所（UI-06、ADR 0032）。配置のエンジンはこのマスにそのまま置く。AI の束がその物を動かす（move）・閉じる・置き直す（relayout）・棚へ移すと消える（AI が優先）。見える物だけが持ち、1 つの物に 1 つ（意味の検査）。
 */
export interface CanvasUserPin {
  item_id: CanvasItemId;
  cell: CanvasCell;
}
/**
 * キャンバスの今の記述（ADR 0032）。見える物（placement が canvas）は 24 個まで、棚を含めて 48 個まで。reading_order は見える物をちょうど 1 回ずつ含む（意味の検査）。 user_pins はユーザーの置き場所（UI-06）。
 */
export interface CanvasDocument {
  canvas_revision: CanvasRevision;
  /**
   * @maxItems 48
   */
  items: CanvasItem[];
  /**
   * @maxItems 24
   */
  reading_order: CanvasItemId[];
  /**
   * ユーザーの置き場所（UI-06）。省略は空と同じ（UI-05 までの記述との互換）。
   *
   * @maxItems 24
   */
  user_pins?: CanvasUserPin[];
}
/**
 * キャンバスに置く物（ADR 0032）。宣言的な記述だけで、説明文の項目（description・note・caption など）を持たない。承認・停止・取消の操作を持たない。
 */
export interface CanvasItem {
  item_id: CanvasItemId;
  kind: CanvasItemKind;
  component: CanvasComponent;
  heading: CanvasHeading;
  emphasis: CanvasEmphasis;
  group: CanvasGroupId | null;
  /**
   * @maxItems 4
   */
  relations:
    | []
    | [CanvasRelation]
    | [CanvasRelation, CanvasRelation]
    | [CanvasRelation, CanvasRelation, CanvasRelation]
    | [CanvasRelation, CanvasRelation, CanvasRelation, CanvasRelation];
  grid: CanvasGrid;
  placement: CanvasPlacement;
  data: CanvasData;
}
/**
 * 物が見せるデータの参照（ADR 0032）。50 件まで、残りは more_count（50 件に満たないときは 0。意味の検査）。本文・説明文を持たない。
 */
export interface CanvasData {
  /**
   * @maxItems 50
   */
  item_refs: CanvasDataRef[];
  more_count: number;
}
/**
 * 表示する対象の参照（ResultView の item_refs と同じ考え）。本文は開いたときに許可範囲内で取得する。
 */
export interface CanvasDataRef {
  kind: string;
  id: Id;
}
/**
 * 1 回の答えのキャンバスの変更（ADR 0032）。操作は 12 個まで。reading_order は適用した後の見える物の読む順で、見える物をちょうど 1 回ずつ含む（意味の検査）。canvas_revision は base_canvas_revision + 1。
 */
export interface CanvasOpBatch {
  base_canvas_revision: CanvasRevision;
  canvas_revision: CanvasRevision;
  /**
   * @minItems 1
   * @maxItems 12
   */
  ops:
    | [CanvasOp]
    | [CanvasOp, CanvasOp]
    | [CanvasOp, CanvasOp, CanvasOp]
    | [CanvasOp, CanvasOp, CanvasOp, CanvasOp]
    | [CanvasOp, CanvasOp, CanvasOp, CanvasOp, CanvasOp]
    | [CanvasOp, CanvasOp, CanvasOp, CanvasOp, CanvasOp, CanvasOp]
    | [CanvasOp, CanvasOp, CanvasOp, CanvasOp, CanvasOp, CanvasOp, CanvasOp]
    | [
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
      ]
    | [
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
      ]
    | [
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
      ]
    | [
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
      ]
    | [
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
        CanvasOp,
      ];
  /**
   * @maxItems 24
   */
  reading_order: CanvasItemId[];
}
/**
 * update で変える項目（ADR 0032）。種類・部品・置き場所は変えない（部品を変えるなら close と add、置き場所は move）。
 */
export interface CanvasItemChanges {
  heading?: CanvasHeading;
  emphasis?: CanvasEmphasis;
  group?: CanvasGroupId | null;
  /**
   * @maxItems 4
   */
  relations?:
    | []
    | [CanvasRelation]
    | [CanvasRelation, CanvasRelation]
    | [CanvasRelation, CanvasRelation, CanvasRelation]
    | [CanvasRelation, CanvasRelation, CanvasRelation, CanvasRelation];
  data?: CanvasData;
}
/**
 * 流れへの発言（ADR 0032）。会話の ID・区切りの ID・保存モードを送らない（区切りは Core が選ぶ）。expected_canvas_revision は端末が今描いているキャンバスの版。
 */
export interface StreamTurnRequest {
  request_id: Id;
  command_scope_id: Id;
  text: string;
  input_kind: 'text' | 'voice_local';
  expected_canvas_revision: CanvasRevision;
}
/**
 * 流れへの発言の結果（ADR 0032）。segment は発言を受けた区切り。canvas は Core が意味の検査を通したキャンバスの変更（なければ null）。外部変更の完了は操作の状態で別に示し、承認・停止はキャンバスに置かない。
 */
export interface StreamTurnResponse {
  request_id: Id;
  segment: StreamSegment;
  turn_id: Id;
  input_id: Id;
  workflow_id: Id | null;
  status: 'answered' | 'clarification' | 'background' | 'session_control';
  result_view: ResultView | null;
  reply_text: string | null;
  canvas: CanvasOpBatch | null;
}
/**
 * 流れ（stream）の中の今の区切り（ADR 0032）。画面には区切りとして見せず、保存モードの表示と表示の権限の判定に使う。carried_summary は前の区切りからつないだ要約の由来と期限。記録しない区切り・記録しない会話から出た区切り・流れの最初・忘却の指示で始めた区切りはつながない。期限が区切りの始まり以前の要約・自分を由来に含む要約は持たない（意味の検査）。
 */
export interface StreamSegment {
  segment_id: Id;
  storage_mode: StorageMode;
  opened_at: UtcTime;
  open_reason: SegmentBoundaryReason;
  carried_summary: CarriedSummary | null;
}
/**
 * 区切りにつないだ要約の由来と期限（ADR 0032）。source_segment_ids は要約の材料になった区切り（要約し直しても前の由来を引き継ぐ）。expires_at は由来の発言のうち最も早い期限で、その時に要約全体を捨てる。本文は持たない。
 */
export interface CarriedSummary {
  /**
   * @minItems 1
   * @maxItems 256
   */
  source_segment_ids: [Id, ...Id[]];
  expires_at: UtcTime;
}
/**
 * ユーザーのキャンバスの操作の記録（UI-06、ADR 0032）。expected_canvas_revision は端末が描いている版。版が今と同じか、古くてもその物の置き場所・存在がその版より後に変わっていなければ当てる。それ以外は 409（conflict）で捨てる（自動では送り直さない）。
 */
export interface CanvasUserOpRequest {
  request_id: Id;
  command_scope_id: Id;
  expected_canvas_revision: CanvasRevision;
  op: CanvasUserOp;
}
/**
 * ユーザーの操作を当てた後のキャンバスの版（UI-06、ADR 0032）。記述そのものは getCanvas で取る（購読の canvas の知らせも届く）。
 */
export interface CanvasUserOpResponse {
  request_id: Id;
  canvas_revision: CanvasRevision;
}
/**
 * 物の中身の読み取り（UI-07、ADR 0032）。expected_canvas_revision は端末が描いている版で、今と同じでなければ 409（中身と参照の位置がずれるため）。open_index は mail_card の本文を開く行（item_refs の位置）。null は本文を開かない。
 */
export interface CanvasContentRequest {
  request_id: Id;
  command_scope_id: Id;
  expected_canvas_revision: CanvasRevision;
  item_id: CanvasItemId;
  open_index: CanvasOpenIndex | null;
}
/**
 * 物の中身（UI-07、ADR 0032）。canvas_revision は中身を作ったときの版（要求の版と同じ）。
 */
export interface CanvasContentResponse {
  request_id: Id;
  canvas_revision: CanvasRevision;
  item_id: CanvasItemId;
  open_index: CanvasOpenIndex | null;
  content: CanvasContent;
}
