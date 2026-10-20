-- Buddy 保存案 0001（B00-09 #26、ADR 0010）。設計 03 データ表・保存期限、08 §5、11 §1A・§4・§5A・§5B。
-- 案であり、本番 DB へ適用した記録ではない。接続ごとの PRAGMA（WAL・synchronous=FULL・fullfsync）は
-- connection.sql を接続の作成時に実行して読み戻す。耐久性（X60）は未検証。
-- CHECK は NULL で通ってしまうため、NULL になり得る列の比較は coalesce か IS NOT NULL で書く。
-- 規約: ID は UUID の TEXT、版・世代・epoch は 0 以上の INTEGER、時刻は UTC の Unix ミリ秒の INTEGER。
-- 本文・要約・変更内容・宛先は sealed_blobs に暗号化して置き、各表は *_blob_id で参照する。
-- 本文を持たない表（event_outbox・command_receipts・forget_ledger など）に本文の列を作らない。

PRAGMA foreign_keys = ON;

-- migration_sha256:NNNN は適用したマイグレーションの内容のハッシュ（ADR 0016）。
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY CHECK (
    key IN ('schema_version', 'store_generation')
    OR key GLOB 'migration_sha256:[0-9][0-9][0-9][0-9]'),
  value TEXT NOT NULL
) STRICT;

-- 暗号文（08 §5）。形式版・key_id・nonce・暗号文・認証タグを分け、所有者の表・ID・版・用途を追加認証データに使う。
CREATE TABLE sealed_blobs (
  blob_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'operation_intent', 'turn_text', 'session_summary', 'source_body', 'candidate_title',
    'candidate_excerpt', 'memory_text', 'memory_target_key', 'directive_text',
    'connection_account', 'request_summary', 'proposal')),
  owner_table TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_version INTEGER NOT NULL DEFAULT 0 CHECK (owner_version >= 0),
  format_version INTEGER NOT NULL CHECK (format_version >= 1),
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  ciphertext BLOB NOT NULL,
  tag BLOB NOT NULL CHECK (length(tag) = 16),
  created_at INTEGER NOT NULL,
  delete_at INTEGER CHECK (delete_at IS NULL OR delete_at > created_at),
  UNIQUE (owner_table, owner_id, owner_version, purpose),
  -- 同じ鍵で nonce を再利用しない。
  UNIQUE (key_id, nonce)
) STRICT;
CREATE INDEX sealed_blobs_delete_at ON sealed_blobs (delete_at) WHERE delete_at IS NOT NULL;

-- 端末と接続範囲（02 端末登録と接続、07 §2、ADR 0009）。
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL CHECK (length(device_name) BETWEEN 1 AND 40),
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'macos', 'linux')),
  hub_local INTEGER NOT NULL CHECK (hub_local IN (0, 1)),
  token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  registered_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE TABLE pairing_sessions (
  pairing_id TEXT PRIMARY KEY,
  code_hash BLOB NOT NULL CHECK (length(code_hash) = 32),
  certificate_fingerprint TEXT NOT NULL CHECK (length(certificate_fingerprint) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 300000),
  attempts_left INTEGER NOT NULL CHECK (attempts_left BETWEEN 0 AND 5),
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1))
) STRICT;

CREATE TABLE pairing_claims (
  claim_id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL REFERENCES pairing_sessions (pairing_id),
  device_name TEXT NOT NULL CHECK (length(device_name) BETWEEN 1 AND 40),
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'macos', 'linux')),
  claim_secret_hash BLOB NOT NULL UNIQUE CHECK (length(claim_secret_hash) = 32),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'consumed')),
  expires_at INTEGER NOT NULL,
  device_id TEXT REFERENCES devices (device_id),
  CHECK ((status = 'consumed') = (device_id IS NOT NULL))
) STRICT;
-- 一つのペアリングから確定できる申請は一つだけ。
CREATE UNIQUE INDEX pairing_claims_one_success ON pairing_claims (pairing_id)
  WHERE status IN ('approved', 'consumed');

CREATE TABLE command_scopes (
  command_scope_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices (device_id),
  core_instance_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at AND expires_at <= issued_at + 86400000),
  revoked_at INTEGER
) STRICT;

-- 連携の接続（04 接続・権限・取得する対象）。OAuth トークンは OS の KeyStore に置き、DB とバックアップに入れない。
CREATE TABLE connections (
  connection_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  account_blob_id TEXT REFERENCES sealed_blobs (blob_id),
  credential_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'needs_reauth', 'needs_attention', 'disconnected')),
  access TEXT NOT NULL CHECK (access IN ('read', 'read_write')),
  granted_scopes TEXT NOT NULL CHECK (json_valid(granted_scopes)),
  targets TEXT NOT NULL CHECK (json_valid(targets)),
  permission_revision INTEGER NOT NULL CHECK (permission_revision >= 0),
  scope_revision INTEGER NOT NULL CHECK (scope_revision >= 0),
  CHECK (status <> 'disconnected' OR credential_ref IS NULL)
) STRICT;

-- 会話と入力（03 sessions / turns・InputSnapshot、10 §5A）。記録しない会話は保存しない。
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('normal', 'extended')),
  display_device_id TEXT REFERENCES devices (device_id),
  route_revision INTEGER NOT NULL CHECK (route_revision >= 0),
  summary_blob_id TEXT REFERENCES sealed_blobs (blob_id),
  created_at INTEGER NOT NULL,
  ended_at INTEGER
) STRICT;

CREATE TABLE turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (session_id),
  role TEXT NOT NULL CHECK (role IN ('user', 'buddy')),
  input_kind TEXT CHECK (input_kind IN ('voice_live', 'voice_local', 'text')),
  text_blob_id TEXT UNIQUE REFERENCES sealed_blobs (blob_id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  CHECK ((role = 'user') = (input_kind IS NOT NULL))
) STRICT;
CREATE INDEX turns_expires_at ON turns (expires_at);
-- 継続・再開で古い発言の期限を延ばさない（03 保存期限）。
CREATE TRIGGER turns_no_extension BEFORE UPDATE OF expires_at ON turns
  WHEN NEW.expires_at > OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'turn_expiry_extension');
END;

CREATE TABLE workflows (
  workflow_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (session_id),
  current_request_revision INTEGER NOT NULL CHECK (current_request_revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('collecting', 'clarifying', 'ready', 'executing', 'done', 'cancelled', 'superseded')),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE input_snapshots (
  input_id TEXT NOT NULL,
  request_revision INTEGER NOT NULL CHECK (request_revision >= 1),
  workflow_id TEXT REFERENCES workflows (workflow_id),
  turn_id TEXT REFERENCES turns (turn_id),
  origin TEXT NOT NULL CHECK (origin IN ('typed', 'local_asr', 'live_fragment')),
  state TEXT NOT NULL CHECK (state IN ('collecting', 'end_candidate', 'sealed', 'superseded', 'blocked')),
  seal_reason TEXT CHECK (seal_reason IN ('submitted_text', 'local_asr_segment', 'user_corrected', 'live_transcript_policy')),
  input_evidence TEXT NOT NULL CHECK (input_evidence IN ('submitted_text', 'full_audio_segment', 'live_policy_observed', 'unverified')),
  policy_version INTEGER CHECK (policy_version >= 0),
  permission_revision INTEGER NOT NULL CHECK (permission_revision >= 0),
  forgetting_generation INTEGER NOT NULL CHECK (forgetting_generation >= 0),
  audio_epoch INTEGER CHECK (audio_epoch >= 0),
  PRIMARY KEY (input_id, request_revision),
  CHECK ((state = 'sealed') = (seal_reason IS NOT NULL)),
  CHECK (state <> 'sealed' OR input_evidence <> 'unverified'),
  CHECK (seal_reason <> 'live_transcript_policy' OR (input_evidence = 'live_policy_observed' AND policy_version IS NOT NULL))
) STRICT;

-- 操作・承認・試行（08 §1〜§5）。
CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  workflow_id TEXT REFERENCES workflows (workflow_id),
  kind TEXT NOT NULL,
  effect_route TEXT NOT NULL CHECK (effect_route IN ('local_command', 'remote_mutation')),
  current_content_version INTEGER NOT NULL CHECK (current_content_version >= 1),
  state TEXT NOT NULL CHECK (state IN ('awaiting_approval', 'approved', 'preparing', 'dispatching', 'reconciling', 'succeeded', 'unknown_held', 'not_executed', 'cancelled', 'superseded')),
  state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;

CREATE TABLE operation_versions (
  operation_id TEXT NOT NULL REFERENCES operations (operation_id),
  content_version INTEGER NOT NULL CHECK (content_version >= 1),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  intent_blob_id TEXT NOT NULL UNIQUE REFERENCES sealed_blobs (blob_id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, content_version)
) STRICT;
-- 確定 intent と hash は不変（08 §5）。
CREATE TRIGGER operation_versions_immutable BEFORE UPDATE ON operation_versions
BEGIN
  SELECT RAISE(ABORT, 'operation_version_immutable');
END;

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  content_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  route TEXT NOT NULL CHECK (route IN ('screen', 'policy_auto', 'extension_activation')),
  device_id TEXT REFERENCES devices (device_id),
  preview_id TEXT,
  policy_version INTEGER CHECK (policy_version >= 0),
  status TEXT NOT NULL CHECK (status IN ('valid', 'consumed', 'revoked', 'expired')),
  approved_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id, content_version) REFERENCES operation_versions (operation_id, content_version),
  CHECK (route <> 'screen' OR (device_id IS NOT NULL AND preview_id IS NOT NULL)),
  CHECK (route <> 'policy_auto' OR policy_version IS NOT NULL)
) STRICT;
-- 一つの内容版に有効な承認は一つ（08 §5、X02）。
CREATE UNIQUE INDEX approvals_one_effective ON approvals (operation_id, content_version)
  WHERE status IN ('valid', 'consumed');

CREATE TABLE operation_attempts (
  attempt_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations (operation_id),
  content_version INTEGER NOT NULL,
  approval_id TEXT NOT NULL REFERENCES approvals (approval_id),
  status TEXT NOT NULL CHECK (status IN ('preparing', 'dispatching', 'reconciling', 'succeeded', 'not_executed', 'unknown_held', 'cancelled')),
  dispatch_intent_at INTEGER,
  external_id TEXT,
  result_status TEXT CHECK (result_status IN ('confirmed_success', 'confirmed_not_executed', 'unknown')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id, content_version) REFERENCES operation_versions (operation_id, content_version),
  CHECK (status NOT IN ('dispatching', 'reconciling', 'succeeded', 'unknown_held') OR dispatch_intent_at IS NOT NULL),
  CHECK (status <> 'succeeded' OR coalesce(result_status, '') = 'confirmed_success')
) STRICT;
-- 操作ごとに実行中の試行は一つ（08 §3・§5）。
CREATE UNIQUE INDEX operation_attempts_one_active ON operation_attempts (operation_id)
  WHERE status IN ('preparing', 'dispatching', 'reconciling');
-- 一つの承認を二つの試行へ同時に貸し出さない（08 §4）。
CREATE UNIQUE INDEX operation_attempts_one_per_approval ON operation_attempts (approval_id)
  WHERE status IN ('preparing', 'dispatching', 'reconciling', 'succeeded', 'unknown_held');

CREATE TABLE operation_steps (
  attempt_id TEXT NOT NULL REFERENCES operation_attempts (attempt_id),
  step_id TEXT NOT NULL,
  step_kind TEXT NOT NULL,
  external_id TEXT,
  dispatch_intent_at INTEGER,
  result_status TEXT CHECK (result_status IN ('confirmed_success', 'confirmed_not_executed', 'unknown')),
  PRIMARY KEY (attempt_id, step_id)
) STRICT;

-- 命令の受付（08 §5、07 §3）。要求の照合値・対象 ID・受付結果だけで、本文を複製しない。初期保存 7 日。
CREATE TABLE command_receipts (
  command_scope_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  command_id TEXT NOT NULL UNIQUE,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'durable')),
  committed_state_revision INTEGER CHECK (committed_state_revision >= 0),
  created_at INTEGER NOT NULL,
  delete_at INTEGER NOT NULL CHECK (delete_at = created_at + 604800000),
  PRIMARY KEY (command_scope_id, request_id),
  CHECK ((status = 'durable') = (committed_state_revision IS NOT NULL))
) STRICT;
CREATE INDEX command_receipts_delete_at ON command_receipts (delete_at);

-- イベントの送出記録（07 §4、08 §5）。状態更新と同じ transaction で追加。本文なし・7 日で削除。
CREATE TABLE event_outbox (
  store_generation TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_id TEXT NOT NULL UNIQUE,
  target_id TEXT NOT NULL,
  state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
  event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  delete_at INTEGER NOT NULL CHECK (delete_at = occurred_at + 604800000),
  PRIMARY KEY (store_generation, sequence)
) STRICT;

-- 非同期処理が参照した版（08 §5・§6、11 §5B、H06）。保存・表示・送信の直前に再検査する。
CREATE TABLE async_context_guards (
  guard_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  source_refs TEXT NOT NULL CHECK (json_valid(source_refs)),
  input_id TEXT,
  request_revision INTEGER CHECK (request_revision >= 1),
  permission_revision INTEGER NOT NULL CHECK (permission_revision >= 0),
  forgetting_generation INTEGER NOT NULL CHECK (forgetting_generation >= 0),
  query_scopes TEXT NOT NULL CHECK (json_valid(query_scopes)),
  output_mode TEXT CHECK (output_mode IN ('text', 'voice')),
  output_device_id TEXT,
  session_epoch INTEGER CHECK (session_epoch >= 0),
  related_group_id TEXT,
  analysis_revision INTEGER,
  source_set_hash TEXT,
  published_generation INTEGER,
  expires_at INTEGER NOT NULL,
  CHECK (output_mode <> 'voice' OR session_epoch IS NOT NULL),
  CHECK ((related_group_id IS NULL) = (analysis_revision IS NULL AND source_set_hash IS NULL AND published_generation IS NULL))
) STRICT;

-- 自動実行・取り消し・安全停止（03 取り消しと安全停止、08 §9、J12）。
CREATE TABLE auto_actions (
  operation_id TEXT PRIMARY KEY REFERENCES operations (operation_id),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('create_task', 'create_note', 'label_mail', 'draft_reply', 'create_event')),
  policy_version INTEGER NOT NULL CHECK (policy_version >= 0),
  completed_at INTEGER NOT NULL,
  undo_deadline INTEGER NOT NULL CHECK (undo_deadline = completed_at + 2592000000)
) STRICT;

CREATE TABLE undo_records (
  undo_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES auto_actions (operation_id),
  compensation_operation_id TEXT NOT NULL UNIQUE REFERENCES operations (operation_id),
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'undone', 'failed', 'unknown')),
  requested_at INTEGER NOT NULL
) STRICT;
-- 同じ自動実行の取り消しを並行させない。
CREATE UNIQUE INDEX undo_records_one_active ON undo_records (operation_id)
  WHERE status IN ('in_progress', 'undone', 'unknown');

CREATE TABLE safety_breaker (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (state IN ('running', 'stopped')),
  safety_revision INTEGER NOT NULL CHECK (safety_revision >= 0),
  stop_reason TEXT CHECK (stop_reason IN ('rate_exceeded', 'same_target_repeated', 'compensation_failures')),
  stopped_at INTEGER,
  resumed_by_device_id TEXT REFERENCES devices (device_id),
  CHECK ((state = 'stopped') = (stop_reason IS NOT NULL AND stopped_at IS NOT NULL))
) STRICT;

CREATE TABLE safety_window_counts (
  window_start INTEGER NOT NULL,
  scope_key TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (window_start, scope_key)
) STRICT;

-- 予算（05 予約と最大負担の区別 F02、ADR 0006）。金額は通貨単位の百万分の一。
CREATE TABLE budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  pool_id TEXT NOT NULL,
  budget_month TEXT NOT NULL CHECK (budget_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  price_version TEXT NOT NULL,
  reserved_amount INTEGER NOT NULL CHECK (reserved_amount >= 0),
  max_liability INTEGER NOT NULL CHECK (max_liability >= reserved_amount),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'usage_unknown', 'settled', 'released')),
  reservation_revision INTEGER NOT NULL CHECK (reservation_revision >= 1),
  approval_id TEXT,
  actual_gross INTEGER CHECK (actual_gross >= 0),
  credit_applied INTEGER CHECK (credit_applied >= 0),
  additional_spend INTEGER CHECK (additional_spend >= 0),
  provider_reconciliation_id TEXT UNIQUE,
  credit_cycle_id TEXT,
  overrun_reviewed INTEGER NOT NULL DEFAULT 0 CHECK (overrun_reviewed IN (0, 1)),
  created_at INTEGER NOT NULL,
  CHECK ((status = 'settled') = (actual_gross IS NOT NULL AND credit_applied IS NOT NULL AND additional_spend IS NOT NULL AND provider_reconciliation_id IS NOT NULL)),
  CHECK (status <> 'settled' OR actual_gross = credit_applied + additional_spend),
  -- 実費は精算でだけ記録する。usage 不明・予約中に推測の金額を入れない。
  CHECK (status = 'settled' OR (actual_gross IS NULL AND credit_applied IS NULL AND additional_spend IS NULL)),
  CHECK (status <> 'released' OR provider_reconciliation_id IS NULL),
  CHECK (overrun_reviewed = 0 OR status = 'settled')
) STRICT;
CREATE INDEX budget_reservations_open ON budget_reservations (pool_id, budget_month)
  WHERE status IN ('reserved', 'usage_unknown');
-- 予算月と枠は精算でも変えない（ADR 0006）。
CREATE TRIGGER budget_reservations_fixed_month BEFORE UPDATE OF budget_month, pool_id ON budget_reservations
  WHEN NEW.budget_month <> OLD.budget_month OR NEW.pool_id <> OLD.pool_id
BEGIN
  SELECT RAISE(ABORT, 'budget_month_fixed');
END;

CREATE TABLE live_sessions (
  live_session_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices (device_id),
  session_id TEXT REFERENCES sessions (session_id),
  purpose TEXT NOT NULL CHECK (purpose IN ('conversation', 'notification')),
  control_state TEXT NOT NULL CHECK (control_state IN ('connecting', 'ready', 'lost', 'closing', 'closed')),
  control_epoch INTEGER NOT NULL CHECK (control_epoch >= 0),
  closure TEXT NOT NULL CHECK (closure IN ('open', 'close_requested', 'close_confirmed', 'close_unconfirmed')),
  usage_seconds INTEGER CHECK (usage_seconds >= 0),
  reservation_id TEXT NOT NULL UNIQUE REFERENCES budget_reservations (reservation_id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  CHECK (closure <> 'close_confirmed' OR usage_seconds IS NOT NULL)
) STRICT;

-- 同期の取得集合・走査・仮置き（11 §1A F04、ADR 0007）。
CREATE TABLE sync_scopes (
  scope_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections (connection_id),
  scope_revision INTEGER NOT NULL CHECK (scope_revision >= 0),
  active_scan_id TEXT UNIQUE,
  active_generation INTEGER NOT NULL CHECK (active_generation >= 0),
  committed_watermark INTEGER,
  provider_cursor TEXT,
  executor_generation INTEGER NOT NULL CHECK (executor_generation >= 0),
  last_incremental_completed_at INTEGER,
  last_full_reconciled_at INTEGER,
  pending_incremental INTEGER NOT NULL DEFAULT 0 CHECK (pending_incremental IN (0, 1)),
  pending_full INTEGER NOT NULL DEFAULT 0 CHECK (pending_full IN (0, 1)),
  analysis_plan_complete_generation INTEGER
) STRICT;
-- watermark は後退させない（11 §1A）。
CREATE TRIGGER sync_scopes_watermark_monotonic BEFORE UPDATE OF committed_watermark ON sync_scopes
  WHEN OLD.committed_watermark IS NOT NULL AND (NEW.committed_watermark IS NULL OR NEW.committed_watermark < OLD.committed_watermark)
BEGIN
  SELECT RAISE(ABORT, 'watermark_regression');
END;

CREATE TABLE sync_batches (
  scan_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES sync_scopes (scope_id),
  scope_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('incremental', 'full')),
  base_generation INTEGER NOT NULL,
  base_watermark INTEGER,
  base_provider_cursor TEXT,
  scan_started_at INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL CHECK (window_end > window_start),
  query_fingerprint TEXT NOT NULL,
  executor_generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('fetching', 'staged', 'validated', 'published', 'abandoned')),
  page_cursor TEXT,
  diff_count INTEGER CHECK (diff_count >= 0),
  delete_at INTEGER NOT NULL,
  CHECK (status <> 'published' OR diff_count IS NOT NULL)
) STRICT;
-- 同じ取得集合で有効な走査は一つだけ（11 §1A、QA44）。
CREATE UNIQUE INDEX sync_batches_one_active ON sync_batches (scope_id)
  WHERE status IN ('fetching', 'staged', 'validated');

CREATE TABLE sync_staging (
  scan_id TEXT NOT NULL REFERENCES sync_batches (scan_id),
  remote_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  page_no INTEGER NOT NULL CHECK (page_no >= 0),
  executor_generation INTEGER NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('upsert', 'delete', 'out_of_scope')),
  PRIMARY KEY (scan_id, remote_id)
) STRICT;

-- 元情報の短期キャッシュ（03 source_items）。本文は sealed_blobs に最大 24 時間。
CREATE TABLE source_items (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  account_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  scope_id TEXT NOT NULL REFERENCES sync_scopes (scope_id),
  published_generation INTEGER NOT NULL CHECK (published_generation >= 0),
  fetched_at INTEGER NOT NULL,
  body_blob_id TEXT UNIQUE REFERENCES sealed_blobs (blob_id),
  PRIMARY KEY (provider, account_id, remote_id)
) STRICT;

-- 抽出した依頼・気づき・配信（11 §4・§5A・§5B、08 §7）。
CREATE TABLE request_entities (
  request_entity_id TEXT PRIMARY KEY,
  source_account_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  origin_message_id TEXT NOT NULL,
  request_revision INTEGER NOT NULL CHECK (request_revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'cancelled', 'completed')),
  recreation_suppressed INTEGER NOT NULL DEFAULT 0 CHECK (recreation_suppressed IN (0, 1)),
  summary_blob_id TEXT REFERENCES sealed_blobs (blob_id),
  created_at INTEGER NOT NULL,
  delete_at INTEGER
) STRICT;

-- 自動作成は同じ依頼・操作種別・アカウント・カレンダーにつき一度だけ（11 §5A）。カレンダーなしは空文字。
CREATE TABLE request_entity_operations (
  request_entity_id TEXT NOT NULL REFERENCES request_entities (request_entity_id),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create_task', 'create_event', 'label_mail', 'draft_reply')),
  account_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT '',
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations (operation_id),
  PRIMARY KEY (request_entity_id, operation_kind, account_id, calendar_id)
) STRICT;

CREATE TABLE related_analyses (
  group_id TEXT NOT NULL,
  analysis_revision INTEGER NOT NULL CHECK (analysis_revision >= 1),
  source_set_hash TEXT NOT NULL CHECK (length(source_set_hash) = 64),
  published_generation INTEGER NOT NULL,
  plan_complete INTEGER NOT NULL CHECK (plan_complete IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('ready', 'pending', 'blocked')),
  PRIMARY KEY (group_id, analysis_revision),
  CHECK (status <> 'ready' OR plan_complete = 1)
) STRICT;

CREATE TABLE notification_candidates (
  candidate_id TEXT PRIMARY KEY,
  request_entity_id TEXT REFERENCES request_entities (request_entity_id),
  request_revision INTEGER,
  source_revision TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('schedule_overlap', 'mail_deadline', 'mail_reply', 'research_done')),
  notification_key TEXT NOT NULL UNIQUE,
  title_blob_id TEXT REFERENCES sealed_blobs (blob_id),
  excerpt_blob_id TEXT REFERENCES sealed_blobs (blob_id),
  state TEXT NOT NULL CHECK (state IN ('new', 'seen', 'acted', 'dismissed', 'snoozed', 'resolved')),
  closed_at INTEGER,
  key_delete_at INTEGER,
  CHECK ((state IN ('dismissed', 'resolved')) = (closed_at IS NOT NULL)),
  CHECK (closed_at IS NULL OR coalesce(key_delete_at, -1) = closed_at + 604800000 + 7776000000),
  CHECK ((request_entity_id IS NULL) = (request_revision IS NULL))
) STRICT;

-- ポップアップ・読み上げは配信開始前に送出意図を保存し、ACK 喪失は delivery_unknown（08 §7）。
CREATE TABLE deliveries (
  delivery_id TEXT PRIMARY KEY,
  notification_key TEXT NOT NULL,
  reminder_id TEXT NOT NULL DEFAULT '',
  device_id TEXT REFERENCES devices (device_id),
  channel TEXT NOT NULL CHECK (channel IN ('os_notification', 'voice')),
  status TEXT NOT NULL CHECK (status IN ('intent_saved', 'delivered', 'delivery_unknown')),
  intent_at INTEGER NOT NULL,
  -- 再取得・再接続・端末移動では新しいアラートを作らない。本人の再通知の指定だけが別の reminder_id。
  UNIQUE (notification_key, reminder_id)
) STRICT;

-- 記憶・忘却・本人の指示（03、11 §7、ADR 0008）。
CREATE TABLE memories (
  memory_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin IN ('auto_extraction', 'explicit_request')),
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'goal', 'person', 'routine', 'lexicon', 'progress')),
  text_blob_id TEXT NOT NULL UNIQUE REFERENCES sealed_blobs (blob_id),
  target_key_blob_id TEXT NOT NULL REFERENCES sealed_blobs (blob_id),
  target_key_hash TEXT NOT NULL CHECK (length(target_key_hash) = 64),
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) = 64),
  status TEXT NOT NULL CHECK (status IN ('active', 'review_pending', 'deleted')),
  created_at INTEGER NOT NULL,
  review_at INTEGER NOT NULL CHECK (review_at > created_at),
  delete_at INTEGER,
  CHECK ((status = 'active') = (delete_at IS NULL)),
  CHECK (delete_at IS NULL OR delete_at > review_at)
) STRICT;
-- 同じ内容は二重に保存しない（削除済みは除く）。
CREATE UNIQUE INDEX memories_one_live_content ON memories (dedupe_key) WHERE status <> 'deleted';
-- 見直し日は延ばさない。延ばせるのは見直し待ちからの明示継続だけ（ADR 0008 U14）。
CREATE TRIGGER memories_no_extension BEFORE UPDATE OF review_at ON memories
  WHEN NEW.review_at > OLD.review_at AND NOT (OLD.status = 'review_pending' AND NEW.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'memory_review_extension');
END;

CREATE TABLE memory_sources (
  memory_id TEXT NOT NULL REFERENCES memories (memory_id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('turn', 'source_item', 'memory')),
  source_id TEXT NOT NULL,
  PRIMARY KEY (memory_id, source_kind, source_id)
) STRICT;

-- 忘却台帳（03 忘却と再取り込み・バックアップ）。本文を持たず、世代は 1 件ごとに 1 つ進む。
-- 03 の「本文なしの別ファイル」としての世代管理と端末への複製は、この表とは別に B06 で行う。
CREATE TABLE forget_ledger (
  forgetting_generation INTEGER PRIMARY KEY CHECK (forgetting_generation >= 1),
  entry_id TEXT NOT NULL UNIQUE,
  recorded_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER forget_ledger_contiguous BEFORE INSERT ON forget_ledger
  WHEN NEW.forgetting_generation <> coalesce((SELECT max(forgetting_generation) FROM forget_ledger), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'forget_ledger_gap');
END;
CREATE TRIGGER forget_ledger_append_only BEFORE UPDATE ON forget_ledger
BEGIN
  SELECT RAISE(ABORT, 'forget_ledger_append_only');
END;
CREATE TRIGGER forget_ledger_no_delete BEFORE DELETE ON forget_ledger
BEGIN
  SELECT RAISE(ABORT, 'forget_ledger_append_only');
END;

CREATE TABLE forget_ledger_items (
  forgetting_generation INTEGER NOT NULL REFERENCES forget_ledger (forgetting_generation),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('turn', 'source_item', 'memory', 'blocked_source', 'blocked_content')),
  item_id TEXT NOT NULL,
  PRIMARY KEY (forgetting_generation, item_kind, item_id)
) STRICT;

CREATE TABLE user_directives (
  directive_id TEXT PRIMARY KEY,
  text_blob_id TEXT NOT NULL UNIQUE REFERENCES sealed_blobs (blob_id),
  scope TEXT NOT NULL CHECK (scope IN ('this_time', 'from_now_on')),
  session_id TEXT REFERENCES sessions (session_id),
  turn_id TEXT REFERENCES turns (turn_id),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  -- 「今回は」は会話に結び付け、会話の明示終了で破棄する。
  CHECK (scope <> 'this_time' OR session_id IS NOT NULL)
) STRICT;

-- 影モードとモデル配備（03 intent_shadow・DeploymentManifest、ADR 0008）。
CREATE TABLE intent_shadow (
  record_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  request_revision INTEGER NOT NULL CHECK (request_revision >= 1),
  judgments TEXT NOT NULL CHECK (json_valid(judgments)),
  recorded_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > recorded_at),
  UNIQUE (campaign_id, input_id, request_revision)
) STRICT;

CREATE TABLE deployments (
  deployment_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('downloaded', 'integrity_checked', 'contract_tested', 'evaluated', 'active', 'suspended', 'retired')),
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  recorded_at INTEGER NOT NULL
) STRICT;
-- 一つの profile で active な配備は一つ。
CREATE UNIQUE INDEX deployments_one_active ON deployments (profile_id) WHERE stage = 'active';

CREATE TABLE evaluation_results (
  evaluation_id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments (deployment_id),
  use TEXT NOT NULL CHECK (use IN ('intent_args', 'mail_extraction', 'reply_draft', 'research_summary', 'consult_summary', 'memory_extraction', 'voice_conversation', 'local_asr')),
  result TEXT NOT NULL CHECK (json_valid(result)),
  recorded_at INTEGER NOT NULL
) STRICT;

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1');
