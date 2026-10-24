-- 保存案 0011（B06-06c、ADR 0051）。ADR 0040 の「J5 終わった操作の本文の削除」の SQL と、0010 から残った
-- 予算の行の backfill・安全停止の理由。番号はマージの順に決める（仮の 0011）。
-- 1. 用事の正本を操作のレシートから分ける。sealed_blobs.purpose に task_content を足し、tasks に自分の暗号文の列
--    （content_blob_id）を持たせ、tasks から operation_versions への外部キーを外す（operation_id の UNIQUE は残す）。
--    0010 までの用事は暗号文を持たないので NULL のまま移し、Core の起動時のデータ移行が確定 intent を復号して
--    tasks を所有者に暗号化し直す（追加認証データが変わるので SQL では写せない）。sealed_blobs の行は書いた後に
--    更新せず、INSERT OR REPLACE でも入れ替えない。移行の済んでいない用事がある間は、
--    その用事の操作だけの本文の削除と内容版の行の削除を trigger で拒否する（task_content_not_migrated）。
-- 2. operation_versions の本文（確定 intent の暗号文）を消せるようにする。intent_blob_id を NULL にでき、
--    body_deleted_at と CHECK を足す。trigger は本文を消す更新だけを許し、内容版・hash・作成時刻の更新を拒否する。
--    本文を消せるのは完了した操作（succeeded・not_executed・cancelled・superseded）だけ。本文の消えた内容版には、
--    承認・試行・送出の手前への遷移を作れない（operation_body_erased）。0010 までに完了した操作の completed_at の
--    穴を埋める（後述）。
-- 3. request_entity_operations から operations への外部キーを外す（UNIQUE は残す）。依頼の一度だけの記録は、
--    操作の 90 日の削除の後も依頼の期限まで残す。
-- 4. safety_breaker.stop_reason に restored_from_backup を足す（ADR 0047）。
-- 5. 0006 の budget_reservations_released_final に、delete_at を NULL から値にする更新だけの例外を足す（ADR 0048 の U80）。
--
-- 表の作り直しの方法: sealed_blobs は 9 つの表から、operation_versions は承認・試行から参照されている。0005・0006 の
-- 前例（子の表を新しい親を指す形で作り直す）では、sealed_blobs の子と孫（会話・発言・記憶・同期・依頼など、ほぼ全部の表）
-- を作り直すことになる。ここでは外部キーの検査を transaction の終わりまで遅らせ（defer_foreign_keys。COMMIT か
-- ROLLBACK で自動的に戻る）、親の表を消して同じ名前で作り直し、同じ行を入れ直す。子の表の外部キーは名前で親を指すので
-- 子の表は作り直さない。親を消したときに数えた違反は、同じ鍵の行を入れ直したときに数え直されて 0 に戻る。1 行でも
-- 入れ直さなければ、COMMIT と適用側の PRAGMA foreign_key_check が拒否する（試験で確かめる）。ALTER TABLE の改名は、
-- 外部キーの参照先を書き換えるので使わない（0005 の「改名では数え直されない」と同じ理由）。
PRAGMA defer_foreign_keys = ON;

-- --- 0. 子の外部キーの列の索引（親を作り直す前に作る） ---
-- 親（sealed_blobs・operation_versions）を消して入れ直すとき、SQLite は子の外部キーを確かめるために子の列を引く。
-- 子の列に索引がないと、親の 1 行ごとに子を全件走査し、適用の時間が件数の二乗で増える（操作・内容版・承認・
-- 試行を 6000 件ずつ入れた DB で 22.9 秒。8000 件前後で DB worker の起動の期限 30 秒を超えた）。
-- 索引は子の表を作り直さないので 0011 の後も残り、90 日の削除と sealed_blobs の削除も同じ索引を使う。
-- 0001 の UNIQUE が自動で作る索引（turns.text_blob_id・source_items.body_blob_id・memories.text_blob_id・
-- user_directives.text_blob_id・operation_versions.intent_blob_id・tasks.content_blob_id）はここでは作らない。
CREATE INDEX connections_account_blob ON connections (account_blob_id);
CREATE INDEX sessions_summary_blob ON sessions (summary_blob_id);
CREATE INDEX request_entities_summary_blob ON request_entities (summary_blob_id);
CREATE INDEX notification_candidates_title_blob ON notification_candidates (title_blob_id);
CREATE INDEX notification_candidates_excerpt_blob ON notification_candidates (excerpt_blob_id);
CREATE INDEX memories_target_key_blob ON memories (target_key_blob_id);
-- operation_versions を参照する子（C の作り直しの前に作る）。
CREATE INDEX approvals_operation_version ON approvals (operation_id, content_version);
CREATE INDEX operation_attempts_operation_version ON operation_attempts (operation_id, content_version);

-- --- A. sealed_blobs（purpose に task_content を足す） ---
CREATE TABLE sealed_blobs_0011_copy AS SELECT * FROM sealed_blobs;
DROP TABLE sealed_blobs;
-- 0001 と同じ列・制約。用途に task_content（用事の題名・期限・本文。所有者は tasks）を足す。
CREATE TABLE sealed_blobs (
  blob_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'operation_intent', 'turn_text', 'session_summary', 'source_body', 'candidate_title',
    'candidate_excerpt', 'memory_text', 'memory_target_key', 'directive_text',
    'connection_account', 'request_summary', 'proposal', 'task_content')),
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
  UNIQUE (key_id, nonce)
) STRICT;
INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at)
  SELECT blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at FROM sealed_blobs_0011_copy;
DROP TABLE sealed_blobs_0011_copy;
-- 0001 と同じ索引。
CREATE INDEX sealed_blobs_delete_at ON sealed_blobs (delete_at) WHERE delete_at IS NOT NULL;

-- 書いた暗号文は変えない（本文・宛先・鍵の材料を書き換える経路を作らない）。0001〜0011 のコードに sealed_blobs を
-- UPDATE する経路はなく、delete_at も予約の INSERT で書く。更新が必要になったら、許す列をこの trigger に足す。
CREATE TRIGGER sealed_blobs_no_update BEFORE UPDATE ON sealed_blobs
BEGIN
  SELECT RAISE(ABORT, 'sealed_blob_immutable');
END;

-- INSERT OR REPLACE は、既存の行を消してから入れ直すので、BEFORE UPDATE・BEFORE DELETE の trigger をすり抜ける。
-- 衝突の相手（主キー・持ち主と用途の UNIQUE・鍵と nonce の UNIQUE）をすべて見て、置き換えを止める。
CREATE TRIGGER sealed_blobs_no_replace BEFORE INSERT ON sealed_blobs
  WHEN EXISTS (SELECT 1 FROM sealed_blobs WHERE blob_id = NEW.blob_id)
    OR EXISTS (
      SELECT 1 FROM sealed_blobs
       WHERE owner_table = NEW.owner_table AND owner_id = NEW.owner_id
         AND owner_version = NEW.owner_version AND purpose = NEW.purpose)
    OR EXISTS (
      SELECT 1 FROM sealed_blobs
       WHERE key_id = NEW.key_id AND nonce = NEW.nonce)
BEGIN
  SELECT RAISE(ABORT, 'sealed_blob_replace');
END;

-- --- B. tasks（自分の暗号文を持ち、operation_versions を参照しない） ---
-- 子の表がないので、0005 の前例どおり作り直して改名する。
CREATE TABLE tasks_0011 (
  task_id TEXT PRIMARY KEY,
  -- 一つの操作から作る用事は一つ（同じ命令の再要求で二つ目を作らない最終の保証。0005 から残す）。
  operation_id TEXT NOT NULL UNIQUE,
  content_version INTEGER NOT NULL CHECK (content_version >= 1),
  list_id TEXT NOT NULL CHECK (length(list_id) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('open', 'done')),
  created_at INTEGER NOT NULL,
  -- 用事の題名・期限・本文の暗号文（purpose = task_content、owner_table = tasks、owner_id = task_id、版 0）。
  -- 0010 までの用事だけが NULL を持ち、起動時のデータ移行で埋める。新しい用事は NULL で作れない（下の trigger）。
  content_blob_id TEXT UNIQUE REFERENCES sealed_blobs (blob_id)
) STRICT;
INSERT INTO tasks_0011 (task_id, operation_id, content_version, list_id, status, created_at, content_blob_id)
  SELECT task_id, operation_id, content_version, list_id, status, created_at, NULL FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_0011 RENAME TO tasks;

-- 外部キー（operation_versions）を外したので、結び付ける操作と内容版がまだあることを挿入の時点で確かめる。
-- 0005 の外部キーと同じ保証を trigger で残す（操作を 90 日で消した後も用事は残るが、その用事は 0011 より前に
-- 作られたものだけで、新しく作る用事は消えた操作を指さない）。
CREATE TRIGGER tasks_operation_exists BEFORE INSERT ON tasks
  WHEN NOT EXISTS (
    SELECT 1 FROM operation_versions
     WHERE operation_id = NEW.operation_id AND content_version = NEW.content_version)
BEGIN
  SELECT RAISE(ABORT, 'task_operation_missing');
END;

-- 新しい用事は自分の暗号文を持つ（用事の正本を操作の暗号文に置かない）。
CREATE TRIGGER tasks_content_required BEFORE INSERT ON tasks
  WHEN NEW.content_blob_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'task_content_required');
END;

-- 暗号文の持ち主は、その用事（表・ID・版 0・用途）。別の行の暗号文を指させない。
CREATE TRIGGER tasks_content_owner_insert BEFORE INSERT ON tasks
  WHEN NEW.content_blob_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sealed_blobs
     WHERE blob_id = NEW.content_blob_id AND purpose = 'task_content' AND owner_table = 'tasks'
       AND owner_id = NEW.task_id AND owner_version = 0)
BEGIN
  SELECT RAISE(ABORT, 'task_content_owner');
END;

-- 暗号文の列は NULL から値へ一度だけ（0010 までの用事の移行）。差し替え・NULL へ戻すことは拒否する
-- （内容を編集する命令は、まだない。作るときに版を持たせて決め直す）。
CREATE TRIGGER tasks_content_fixed BEFORE UPDATE OF content_blob_id ON tasks
  WHEN NEW.content_blob_id IS NOT OLD.content_blob_id
    AND (OLD.content_blob_id IS NOT NULL OR NEW.content_blob_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'task_content_fixed');
END;

CREATE TRIGGER tasks_content_owner_update BEFORE UPDATE OF content_blob_id ON tasks
  WHEN NEW.content_blob_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sealed_blobs
     WHERE blob_id = NEW.content_blob_id AND purpose = 'task_content' AND owner_table = 'tasks'
       AND owner_id = NEW.task_id AND owner_version = 0)
BEGIN
  SELECT RAISE(ABORT, 'task_content_owner');
END;

-- 用事の ID・作った操作・内容版・作成時刻は変えない。
CREATE TRIGGER tasks_fixed BEFORE UPDATE OF task_id, operation_id, content_version, created_at ON tasks
  WHEN NEW.task_id <> OLD.task_id OR NEW.operation_id <> OLD.operation_id
    OR NEW.content_version <> OLD.content_version OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'task_fixed');
END;

-- INSERT OR REPLACE で既存の用事を入れ替えない（0008〜0010 と同じ書き方。UNIQUE の相手をすべて見る）。
CREATE TRIGGER tasks_no_replace BEFORE INSERT ON tasks
  WHEN EXISTS (SELECT 1 FROM tasks WHERE task_id = NEW.task_id)
    OR EXISTS (SELECT 1 FROM tasks WHERE operation_id = NEW.operation_id)
    OR (NEW.content_blob_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM tasks WHERE content_blob_id = NEW.content_blob_id))
BEGIN
  SELECT RAISE(ABORT, 'task_replace');
END;

-- --- C. operation_versions（本文を消せるようにする） ---
CREATE TABLE operation_versions_0011_copy AS SELECT * FROM operation_versions;
DROP TABLE operation_versions;
CREATE TABLE operation_versions (
  operation_id TEXT NOT NULL REFERENCES operations (operation_id),
  content_version INTEGER NOT NULL CHECK (content_version >= 1),
  -- 本文を消した後も残す hash（同じ hash の再送・承認の照合・結果の表示。J5 の 90 日）。
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  intent_blob_id TEXT UNIQUE REFERENCES sealed_blobs (blob_id),
  created_at INTEGER NOT NULL,
  -- 本文（確定 intent の暗号文）を消した時刻。本文がある間は NULL。
  body_deleted_at INTEGER CHECK (body_deleted_at IS NULL OR body_deleted_at >= 0),
  PRIMARY KEY (operation_id, content_version),
  CHECK ((intent_blob_id IS NULL) = (body_deleted_at IS NOT NULL))
) STRICT;
INSERT INTO operation_versions (operation_id, content_version, content_hash, intent_blob_id, created_at, body_deleted_at)
  SELECT operation_id, content_version, content_hash, intent_blob_id, created_at, NULL FROM operation_versions_0011_copy;
DROP TABLE operation_versions_0011_copy;

-- 確定 intent と hash は不変（08 §5）。許す更新は、本文を消す更新（intent_blob_id が値から NULL、body_deleted_at が
-- NULL から値、ほかの列は同じ）だけ。0001 の operation_versions_immutable と同じ理由を返す。
CREATE TRIGGER operation_versions_immutable BEFORE UPDATE ON operation_versions
  WHEN NOT (OLD.intent_blob_id IS NOT NULL AND NEW.intent_blob_id IS NULL
    AND OLD.body_deleted_at IS NULL AND NEW.body_deleted_at IS NOT NULL
    AND NEW.operation_id = OLD.operation_id AND NEW.content_version = OLD.content_version
    AND NEW.content_hash = OLD.content_hash AND NEW.created_at = OLD.created_at)
BEGIN
  SELECT RAISE(ABORT, 'operation_version_immutable');
END;

-- 本文を消せるのは、完了した操作だけ（unknown_held・進行中は照合・実行のために残す。ADR 0040）。
CREATE TRIGGER operation_versions_body_erase_finished BEFORE UPDATE OF intent_blob_id ON operation_versions
  WHEN NEW.intent_blob_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM operations
     WHERE operation_id = NEW.operation_id
       AND state IN ('succeeded', 'not_executed', 'cancelled', 'superseded'))
BEGIN
  SELECT RAISE(ABORT, 'operation_body_not_finished');
END;

-- 0010 までの用事の暗号文を移す前は、その用事の正本がこの本文なので消さない（操作ごとの DB の最後の保証）。
CREATE TRIGGER operation_versions_body_erase_task BEFORE UPDATE OF intent_blob_id ON operation_versions
  WHEN NEW.intent_blob_id IS NULL AND EXISTS (
    SELECT 1 FROM tasks WHERE operation_id = NEW.operation_id AND content_blob_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'task_content_not_migrated');
END;

-- 内容版の行を消せるのは完了した操作（90 日の削除）だけ。移行前の用事が指す操作の行も消さない。
CREATE TRIGGER operation_versions_delete_finished BEFORE DELETE ON operation_versions
  WHEN NOT EXISTS (
    SELECT 1 FROM operations
     WHERE operation_id = OLD.operation_id
       AND state IN ('succeeded', 'not_executed', 'cancelled', 'superseded'))
BEGIN
  SELECT RAISE(ABORT, 'operation_not_finished');
END;

CREATE TRIGGER operation_versions_delete_task BEFORE DELETE ON operation_versions
  WHEN EXISTS (
    SELECT 1 FROM tasks WHERE operation_id = OLD.operation_id AND content_blob_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'task_content_not_migrated');
END;

-- 本文のない内容版は作らない。INSERT OR REPLACE で内容版を入れ替えない（hash の不変を挿入でも守る）。
CREATE TRIGGER operation_versions_body_required BEFORE INSERT ON operation_versions
  WHEN NEW.intent_blob_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'operation_body_required');
END;

CREATE TRIGGER operation_versions_no_replace BEFORE INSERT ON operation_versions
  WHEN EXISTS (
    SELECT 1 FROM operation_versions
     WHERE operation_id = NEW.operation_id AND content_version = NEW.content_version)
    OR EXISTS (SELECT 1 FROM operation_versions WHERE intent_blob_id = NEW.intent_blob_id)
BEGIN
  SELECT RAISE(ABORT, 'operation_version_immutable');
END;

-- 本文の消えた内容版から実行を始めない（承認・試行・送出意図・送出の手前への遷移を作らない）。
CREATE TRIGGER approvals_body_erased BEFORE INSERT ON approvals
  WHEN EXISTS (
    SELECT 1 FROM operation_versions
     WHERE operation_id = NEW.operation_id AND content_version = NEW.content_version
       AND intent_blob_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'operation_body_erased');
END;

CREATE TRIGGER operation_attempts_body_erased BEFORE INSERT ON operation_attempts
  WHEN EXISTS (
    SELECT 1 FROM operation_versions
     WHERE operation_id = NEW.operation_id AND content_version = NEW.content_version
       AND intent_blob_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'operation_body_erased');
END;

CREATE TRIGGER operation_attempts_body_erased_dispatch BEFORE UPDATE OF status ON operation_attempts
  WHEN NEW.status = 'dispatching' AND NEW.status <> OLD.status
    AND EXISTS (
      SELECT 1 FROM operation_versions
       WHERE operation_id = NEW.operation_id AND content_version = NEW.content_version
         AND intent_blob_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'operation_body_erased');
END;

CREATE TRIGGER operations_body_erased_transition BEFORE UPDATE OF state ON operations
  WHEN NEW.state IN ('approved', 'preparing', 'dispatching') AND NEW.state <> OLD.state
    AND EXISTS (
      SELECT 1 FROM operation_versions
       WHERE operation_id = NEW.operation_id AND content_version = NEW.current_content_version
         AND intent_blob_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'operation_body_erased');
END;

-- 操作の行を消せるのは完了した操作（90 日の削除）だけ。
CREATE TRIGGER operations_delete_finished BEFORE DELETE ON operations
  WHEN OLD.state NOT IN ('succeeded', 'not_executed', 'cancelled', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'operation_not_finished');
END;

-- 0010 までは succeeded・cancelled でだけ completed_at を書いていた。not_executed・superseded で終わった操作は
-- NULL のままで、そのままだと本文が永久に残る（DB worker は起点のない完了を消さない）。0011 の適用の時刻を
-- 起点として埋める（実際の完了より後になるので、早く消しすぎる側には倒れない）。succeeded・cancelled で NULL の
-- 行は、0001〜0010 の経路では作られないが、復元などの異常な行も同じ扱いにする。
UPDATE operations SET completed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE state IN ('succeeded', 'not_executed', 'cancelled', 'superseded')
  AND completed_at IS NULL;

-- --- D. request_entity_operations（operations への外部キーを外す） ---
-- 0010 の trigger（operations_record_kind_forward）がこの表を名前で読むので、改名ではなく、写して消して同じ名前で
-- 作り直す（改名は schema 全体の参照を確かめ直すため）。
CREATE TABLE request_entity_operations_0011_copy AS SELECT * FROM request_entity_operations;
DROP TABLE request_entity_operations;
-- 0001 と同じ列・制約。operation_id の REFERENCES operations だけを外す（UNIQUE は残す。ADR 0040）。
CREATE TABLE request_entity_operations (
  request_entity_id TEXT NOT NULL REFERENCES request_entities (request_entity_id),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create_task', 'create_event', 'label_mail', 'draft_reply')),
  account_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT '',
  operation_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (request_entity_id, operation_kind, account_id, calendar_id)
) STRICT;
INSERT INTO request_entity_operations (request_entity_id, operation_kind, account_id, calendar_id, operation_id)
  SELECT request_entity_id, operation_kind, account_id, calendar_id, operation_id FROM request_entity_operations_0011_copy;
DROP TABLE request_entity_operations_0011_copy;

-- 0010 と同じ trigger（表の作り直しで消えるため作り直す）。
CREATE TRIGGER request_entity_operations_private_minimal_insert BEFORE INSERT ON request_entity_operations
  WHEN EXISTS (
    SELECT 1 FROM operations
     WHERE operation_id = NEW.operation_id AND record_kind = 'private_minimal')
BEGIN
  SELECT RAISE(ABORT, 'operation_private_minimal_request_entity');
END;

CREATE TRIGGER request_entity_operations_private_minimal_update BEFORE UPDATE OF operation_id ON request_entity_operations
  WHEN EXISTS (
    SELECT 1 FROM operations
     WHERE operation_id = NEW.operation_id AND record_kind = 'private_minimal')
BEGIN
  SELECT RAISE(ABORT, 'operation_private_minimal_request_entity');
END;

-- 外部キーを外したので、結び付ける操作がまだあることを挿入の時点で確かめる（作る時点の保証は 0001 と同じ）。
-- 操作を 90 日で消した後も、結び付けの行は依頼の期限まで残る（再作成の抑止）。
CREATE TRIGGER request_entity_operations_operation_exists BEFORE INSERT ON request_entity_operations
  WHEN NOT EXISTS (SELECT 1 FROM operations WHERE operation_id = NEW.operation_id)
BEGIN
  SELECT RAISE(ABORT, 'request_entity_operation_missing');
END;

-- 操作を差し替える更新でも、結び付ける操作がまだあることを確かめる（外部キーを外した代わりの保証）。
CREATE TRIGGER request_entity_operations_operation_exists_update BEFORE UPDATE OF operation_id ON request_entity_operations
  WHEN NOT EXISTS (SELECT 1 FROM operations WHERE operation_id = NEW.operation_id)
BEGIN
  SELECT RAISE(ABORT, 'request_entity_operation_missing');
END;

-- 結び付けの記録を INSERT OR REPLACE で入れ替えない（一度だけの記録。消すのは依頼の期限の掃除）。
CREATE TRIGGER request_entity_operations_no_replace BEFORE INSERT ON request_entity_operations
  WHEN EXISTS (
    SELECT 1 FROM request_entity_operations
     WHERE request_entity_id = NEW.request_entity_id AND operation_kind = NEW.operation_kind
       AND account_id = NEW.account_id AND calendar_id = NEW.calendar_id)
    OR EXISTS (SELECT 1 FROM request_entity_operations WHERE operation_id = NEW.operation_id)
BEGIN
  SELECT RAISE(ABORT, 'request_entity_operation_fixed');
END;

-- --- E. safety_breaker（stop_reason に restored_from_backup を足す） ---
CREATE TABLE safety_breaker_0011_copy AS SELECT * FROM safety_breaker;
DROP TABLE safety_breaker;
-- 0001 と同じ列・制約。理由に restored_from_backup（古いバックアップからの復元の後の安全停止。ADR 0047）を足す。
CREATE TABLE safety_breaker (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (state IN ('running', 'stopped')),
  safety_revision INTEGER NOT NULL CHECK (safety_revision >= 0),
  stop_reason TEXT CHECK (stop_reason IN ('rate_exceeded', 'same_target_repeated', 'compensation_failures', 'restored_from_backup')),
  stopped_at INTEGER,
  resumed_by_device_id TEXT REFERENCES devices (device_id),
  CHECK ((state = 'stopped') = (stop_reason IS NOT NULL AND stopped_at IS NOT NULL))
) STRICT;
INSERT INTO safety_breaker (singleton, state, safety_revision, stop_reason, stopped_at, resumed_by_device_id)
  SELECT singleton, state, safety_revision, stop_reason, stopped_at, resumed_by_device_id FROM safety_breaker_0011_copy;
DROP TABLE safety_breaker_0011_copy;

-- --- F. 0006 の released_final の例外（0010 より前の予算の行の delete_at を埋める） ---
-- 解放した予約は変えない（0006）。例外は delete_at を NULL から値にする更新だけで、ほかの列は同じでなければならない。
-- 値の正しさ（消してよい状態・作った時刻から 364 日以上）は 0010 の budget_reservations_delete_at_valid が確かめる。
DROP TRIGGER budget_reservations_released_final;
CREATE TRIGGER budget_reservations_released_final BEFORE UPDATE ON budget_reservations
  WHEN OLD.status = 'released'
    AND NOT (OLD.delete_at IS NULL AND NEW.delete_at IS NOT NULL
      AND NEW.reservation_id IS OLD.reservation_id AND NEW.request_id IS OLD.request_id
      AND NEW.profile_id IS OLD.profile_id AND NEW.pool_id IS OLD.pool_id
      AND NEW.requested_pool_id IS OLD.requested_pool_id AND NEW.origin IS OLD.origin
      AND NEW.budget_month IS OLD.budget_month AND NEW.currency IS OLD.currency
      AND NEW.price_version IS OLD.price_version AND NEW.reserved_amount IS OLD.reserved_amount
      AND NEW.max_liability IS OLD.max_liability AND NEW.status IS OLD.status
      AND NEW.reservation_revision IS OLD.reservation_revision AND NEW.approval_id IS OLD.approval_id
      AND NEW.actual_gross IS OLD.actual_gross AND NEW.credit_applied IS OLD.credit_applied
      AND NEW.additional_spend IS OLD.additional_spend
      AND NEW.provider_reconciliation_id IS OLD.provider_reconciliation_id
      AND NEW.settlement_kind IS OLD.settlement_kind AND NEW.credit_cycle_id IS OLD.credit_cycle_id
      AND NEW.settled_at IS OLD.settled_at AND NEW.overrun_reviewed IS OLD.overrun_reviewed
      AND NEW.overrun_reviewed_at IS OLD.overrun_reviewed_at AND NEW.created_at IS OLD.created_at
      AND NEW.dispatch_intent_at IS OLD.dispatch_intent_at AND NEW.credit_estimate IS OLD.credit_estimate
      AND NEW.credit_expires_at IS OLD.credit_expires_at
      AND NEW.credit_observation_seq IS OLD.credit_observation_seq
      AND NEW.credit_settled_seq IS OLD.credit_settled_seq)
BEGIN
  SELECT RAISE(ABORT, 'budget_reservation_released');
END;
