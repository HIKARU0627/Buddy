-- 家計簿の段階 2: 分類ごとの予算（ADR 0166）。
--
-- 1. sealed_blobs.purpose に household_budget（分類ごとの予算の金額。所有者は household_budgets、版は予算の版）を足す。
--    作り直しの方法は 0011・0016 と同じ（外部キーの検査を transaction の終わりまで遅らせ、親を消して同じ名前で作り直し、
--    同じ行を入れ直す。子の表は作り直さない）。索引・trigger もそのまま作り直す。
-- 2. household_budgets: 1 行だけの表。平文で持つのは版と時刻だけで、分類ごとの予算の金額は暗号文（household_budget）に
--    入れる。行がなければ予算はなく、版は 0。版は 1 ずつだけ進める。
PRAGMA defer_foreign_keys = ON;

-- --- 1. sealed_blobs（purpose に household_budget を足す） ---
CREATE TABLE sealed_blobs_0019_copy AS SELECT * FROM sealed_blobs;
DROP TABLE sealed_blobs;
-- 0016 と同じ列・制約。用途に household_budget（分類ごとの予算。所有者は household_budgets）を足す。
CREATE TABLE sealed_blobs (
  blob_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'operation_intent', 'turn_text', 'session_summary', 'source_body', 'candidate_title',
    'candidate_excerpt', 'memory_text', 'memory_target_key', 'directive_text',
    'connection_account', 'request_summary', 'proposal', 'task_content', 'household_entry',
    'household_budget')),
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
  SELECT blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at FROM sealed_blobs_0019_copy;
DROP TABLE sealed_blobs_0019_copy;
CREATE INDEX sealed_blobs_delete_at ON sealed_blobs (delete_at) WHERE delete_at IS NOT NULL;

-- 0011 と同じ。書いた暗号文は変えない。
CREATE TRIGGER sealed_blobs_no_update BEFORE UPDATE ON sealed_blobs
BEGIN
  SELECT RAISE(ABORT, 'sealed_blob_immutable');
END;

-- 0011 と同じ。INSERT OR REPLACE による置き換えを止める。
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

-- --- 2. household_budgets ---
CREATE TABLE household_budgets (
  budget_id INTEGER PRIMARY KEY CHECK (budget_id = 1),
  budget_revision INTEGER NOT NULL CHECK (budget_revision >= 1),
  content_blob_id TEXT NOT NULL UNIQUE REFERENCES sealed_blobs (blob_id),
  updated_at INTEGER NOT NULL
) STRICT;

-- 暗号文は自分の内容（用途 household_budget・持ち主は予算の行・版は予算の版）だけを指す。
CREATE TRIGGER household_budgets_blob_owner_insert BEFORE INSERT ON household_budgets
  WHEN NOT EXISTS (
    SELECT 1 FROM sealed_blobs
     WHERE blob_id = NEW.content_blob_id AND purpose = 'household_budget'
       AND owner_table = 'household_budgets' AND owner_id = '1'
       AND owner_version = NEW.budget_revision)
BEGIN
  SELECT RAISE(ABORT, 'household_budget_blob_owner_mismatch');
END;

CREATE TRIGGER household_budgets_blob_owner_update BEFORE UPDATE ON household_budgets
  WHEN NOT EXISTS (
    SELECT 1 FROM sealed_blobs
     WHERE blob_id = NEW.content_blob_id AND purpose = 'household_budget'
       AND owner_table = 'household_budgets' AND owner_id = '1'
       AND owner_version = NEW.budget_revision)
BEGIN
  SELECT RAISE(ABORT, 'household_budget_blob_owner_mismatch');
END;

-- 版は 1 ずつだけ進める（飛ばし・戻しを拒否する）。
CREATE TRIGGER household_budgets_revision_step BEFORE UPDATE ON household_budgets
  WHEN NEW.budget_revision <> OLD.budget_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'household_budget_revision_step');
END;
