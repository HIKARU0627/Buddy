-- 保存案 0004（B04-04、ADR 0030）。実行担当のための変更。
-- 1. 試行の状態に superseded を足す（D1: 送出意図の前に内容版が変わった試行。送出意図を持たない）。
--    0001 の CHECK は変えられないため、同じ列の表を作り直して値を移す。operation_steps が参照しているので、
--    外部キーの検査は COMMIT まで遅らせる（作り直した表を同じ名前にした後で、参照は満たされる）。
-- 2. 用事（LocalCommand の task.create）の表。題名・期限・本文は確定 intent（operation_versions の暗号文）を
--    参照し、複製しない。用事の行・受付・最終状態・イベントは一つの transaction で書く。
PRAGMA defer_foreign_keys = ON;

CREATE TABLE operation_attempts_0004 (
  attempt_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations (operation_id),
  content_version INTEGER NOT NULL,
  approval_id TEXT NOT NULL REFERENCES approvals (approval_id),
  status TEXT NOT NULL CHECK (status IN ('preparing', 'dispatching', 'reconciling', 'succeeded', 'not_executed', 'unknown_held', 'cancelled', 'superseded')),
  dispatch_intent_at INTEGER,
  external_id TEXT,
  result_status TEXT CHECK (result_status IN ('confirmed_success', 'confirmed_not_executed', 'unknown')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id, content_version) REFERENCES operation_versions (operation_id, content_version),
  -- 送出境界を越えた状態と成功は送出意図（LocalCommand では適用の時刻）を持つ。
  CHECK (status NOT IN ('dispatching', 'reconciling', 'succeeded', 'unknown_held') OR dispatch_intent_at IS NOT NULL),
  CHECK (status <> 'succeeded' OR coalesce(result_status, '') = 'confirmed_success'),
  -- 置き換えは送出意図の前だけ（D1。送出境界を越えた試行の内容は変えない）。
  CHECK (status <> 'superseded' OR (dispatch_intent_at IS NULL AND result_status IS NULL))
) STRICT;

INSERT INTO operation_attempts_0004 (attempt_id, operation_id, content_version, approval_id, status, dispatch_intent_at, external_id, result_status, created_at)
  SELECT attempt_id, operation_id, content_version, approval_id, status, dispatch_intent_at, external_id, result_status, created_at FROM operation_attempts;

DROP TABLE operation_attempts;

ALTER TABLE operation_attempts_0004 RENAME TO operation_attempts;

-- 0001 と同じ索引（表の作り直しで消えるため作り直す）。
CREATE UNIQUE INDEX operation_attempts_one_active ON operation_attempts (operation_id)
  WHERE status IN ('preparing', 'dispatching', 'reconciling');
CREATE UNIQUE INDEX operation_attempts_one_per_approval ON operation_attempts (approval_id)
  WHERE status IN ('preparing', 'dispatching', 'reconciling', 'succeeded', 'unknown_held');

-- 用事。一つの操作から作る用事は一つ（同じ命令の再要求で二つ目を作らない最終の保証）。
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  content_version INTEGER NOT NULL,
  list_id TEXT NOT NULL CHECK (length(list_id) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('open', 'done')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id, content_version) REFERENCES operation_versions (operation_id, content_version)
) STRICT;
