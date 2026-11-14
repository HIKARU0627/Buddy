-- B11-03: 気づき（候補）の保存（設計 11 §4、設計 03、ADR 0073・0115〜0118）。
-- notification_candidates を作り直し、一覧・表示順・状態の遷移・保持に要る列を足す。0001 の列と CHECK は引き継ぐ。
-- 作り直す表を参照する外部キーはない（deliveries は notification_key を値として持つだけ）。0001〜0012 では
-- 候補を書く経路がないので、実データの行は無い。試験用に入れた行が残っていても列の既定値で引き継ぐ。
--
-- - 期限（Deadline）は列に展開する。種類ごとの組み合わせを CHECK で固定する。期限の原文は本文の断片なので列に置かず、
--   題の封筒（title_blob_id）の中に題と一緒に入れる（ADR 0118）。
-- - snooze_until は状態が snoozed のときだけ持つ（Core が保存する再通知の時刻。ADR 0073）。
-- - related_*（関連解析の版。設計 11 §5B）は 4 つそろって持つか、すべて持たない。
-- - content_deleted_at は、閉じた候補の題・抄録を消した時刻。消えたら封筒の参照も外す。
-- - 状態の遷移は trigger でも守る（閉じた候補は戻さない。識別・種類・識別子は変えない。許す遷移は domain の
--   candidateTransition と同じ。試験で食い違いを確かめる）。

-- 古い表を別の名前にして、新しい表を同じ名前で作る（表の作成は notification_candidates の 1 つだけ）。
ALTER TABLE notification_candidates RENAME TO notification_candidates_before_0013;

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
  -- 候補を作った時刻・受信（元情報の受信、予定の重複と調査では作った時刻）・最後に状態を変えた時刻。
  created_at INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL DEFAULT 0,
  state_changed_at INTEGER NOT NULL DEFAULT 0,
  deadline_kind TEXT NOT NULL DEFAULT 'none' CHECK (deadline_kind IN ('instant', 'date', 'unresolved', 'none')),
  -- instant は地域日時（YYYY-MM-DDTHH:MM[:SS]）、date は日付（YYYY-MM-DD）。
  deadline_local TEXT,
  deadline_zone TEXT,
  deadline_reason TEXT CHECK (deadline_reason IS NULL OR deadline_reason IN ('missing_year', 'missing_date', 'relative', 'conflict', 'missing_zone')),
  initial_import INTEGER NOT NULL DEFAULT 0 CHECK (initial_import IN (0, 1)),
  unread_partial INTEGER NOT NULL DEFAULT 0 CHECK (unread_partial IN (0, 1)),
  snooze_until INTEGER,
  related_group_id TEXT,
  related_analysis_revision INTEGER CHECK (related_analysis_revision IS NULL OR related_analysis_revision >= 1),
  related_source_set_hash TEXT CHECK (related_source_set_hash IS NULL OR length(related_source_set_hash) = 64),
  related_published_generation INTEGER CHECK (related_published_generation IS NULL OR related_published_generation >= 0),
  content_deleted_at INTEGER,
  CHECK ((state IN ('dismissed', 'resolved')) = (closed_at IS NOT NULL)),
  CHECK (closed_at IS NULL OR coalesce(key_delete_at, -1) = closed_at + 604800000 + 7776000000),
  CHECK ((request_entity_id IS NULL) = (request_revision IS NULL)),
  CHECK (
    (deadline_kind = 'instant' AND deadline_local IS NOT NULL AND deadline_zone IS NOT NULL AND deadline_reason IS NULL)
    OR (deadline_kind = 'date' AND deadline_local IS NOT NULL AND deadline_zone IS NULL AND deadline_reason IS NULL)
    OR (deadline_kind = 'unresolved' AND deadline_local IS NULL AND deadline_zone IS NULL AND deadline_reason IS NOT NULL)
    OR (deadline_kind = 'none' AND deadline_local IS NULL AND deadline_zone IS NULL AND deadline_reason IS NULL)
  ),
  CHECK ((state = 'snoozed') = (snooze_until IS NOT NULL)),
  CHECK (
    (related_group_id IS NULL) = (related_analysis_revision IS NULL)
    AND (related_group_id IS NULL) = (related_source_set_hash IS NULL)
    AND (related_group_id IS NULL) = (related_published_generation IS NULL)
  ),
  -- 題・抄録を消せるのは閉じた候補だけ。消したら封筒の参照も無い。
  CHECK (content_deleted_at IS NULL OR (closed_at IS NOT NULL AND title_blob_id IS NULL AND excerpt_blob_id IS NULL))
) STRICT;

INSERT INTO notification_candidates (
  candidate_id, request_entity_id, request_revision, source_revision, kind, notification_key,
  title_blob_id, excerpt_blob_id, state, closed_at, key_delete_at, state_changed_at,
  created_at, received_at
)
SELECT
  candidate_id, request_entity_id, request_revision, source_revision, kind, notification_key,
  title_blob_id, excerpt_blob_id, state, closed_at, key_delete_at, coalesce(closed_at, 0),
  coalesce(closed_at, 0), coalesce(closed_at, 0)
FROM notification_candidates_before_0013;

DROP TABLE notification_candidates_before_0013;

CREATE INDEX notification_candidates_title_blob ON notification_candidates (title_blob_id);
CREATE INDEX notification_candidates_excerpt_blob ON notification_candidates (excerpt_blob_id);
CREATE INDEX notification_candidates_state ON notification_candidates (state, received_at);
CREATE INDEX notification_candidates_closed ON notification_candidates (closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX notification_candidates_snooze ON notification_candidates (snooze_until) WHERE snooze_until IS NOT NULL;

-- 識別・種類・識別子は変えない（同じ識別子の候補を作り直さないための前提）。
CREATE TRIGGER notification_candidates_identity_fixed
BEFORE UPDATE OF candidate_id, kind, notification_key, created_at ON notification_candidates
FOR EACH ROW
WHEN NEW.candidate_id IS NOT OLD.candidate_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.notification_key IS NOT OLD.notification_key
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'candidate_identity_fixed');
END;

-- 閉じた候補（dismissed・resolved）は終端で、状態も閉じた時刻も期限も変えない。内容を消す更新だけを許す。
CREATE TRIGGER notification_candidates_closed_is_final
BEFORE UPDATE ON notification_candidates
FOR EACH ROW
WHEN OLD.state IN ('dismissed', 'resolved')
  AND (
    NEW.state IS NOT OLD.state
    OR NEW.closed_at IS NOT OLD.closed_at
    OR NEW.key_delete_at IS NOT OLD.key_delete_at
    OR NEW.state_changed_at IS NOT OLD.state_changed_at
    OR NEW.snooze_until IS NOT OLD.snooze_until
  )
BEGIN
  SELECT RAISE(ABORT, 'candidate_closed_is_final');
END;

-- 許す遷移だけ（domain の candidateTransition と同じ）。同じ状態への更新は遷移ではないので通す。
CREATE TRIGGER notification_candidates_transition_allowed
BEFORE UPDATE OF state ON notification_candidates
FOR EACH ROW
WHEN NEW.state IS NOT OLD.state
  AND NOT (
    (OLD.state = 'new' AND NEW.state IN ('seen', 'acted', 'dismissed', 'snoozed', 'resolved'))
    OR (OLD.state = 'seen' AND NEW.state IN ('acted', 'dismissed', 'snoozed', 'resolved'))
    OR (OLD.state = 'acted' AND NEW.state = 'resolved')
    OR (OLD.state = 'snoozed' AND NEW.state IN ('new', 'seen', 'acted', 'dismissed', 'resolved'))
  )
BEGIN
  SELECT RAISE(ABORT, 'candidate_transition_not_allowed');
END;

-- 状態を変えた時刻は戻さない。
CREATE TRIGGER notification_candidates_time_forward
BEFORE UPDATE OF state_changed_at ON notification_candidates
FOR EACH ROW
WHEN NEW.state_changed_at < OLD.state_changed_at
BEGIN
  SELECT RAISE(ABORT, 'candidate_time_backwards');
END;
