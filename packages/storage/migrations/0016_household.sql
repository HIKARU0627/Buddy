-- 保存案 0016（家計簿の段階 1、ADR 0158）。家計の記録と、店名から覚えた分類の規則。
--
-- 1. sealed_blobs.purpose に household_entry（記録の内容。所有者は household_entries、版は内容版）を足す。
--    作り直しの方法は 0011 と同じ（外部キーの検査を transaction の終わりまで遅らせ、親を消して同じ名前で作り直し、
--    同じ行を入れ直す。子の表は作り直さない）。0011 の索引・trigger もそのまま作り直す。
-- 2. household_entries: 記録 1 件を 1 行。平文で持つのは出所の種類・出所の鍵（SHA-256）・月・状態・内容版・時刻だけで、
--    金額・日付・分類・店名・メモ・支払い手段は暗号文（household_entry）に入れる。月の集計は Core が復号して計算する。
--    削除は行を残して暗号文と月を消す（state = deleted）。出所の鍵が残るので、同じメール・同じ書き出しの行から作り直さない。
--    出所の種類と鍵・作成時刻は変えない。削除した行は変えない。
-- 3. household_category_rules: 店名（正規化して HMAC-SHA256。鍵はデータ鍵から作る）→ 分類。本人が決めた規則（user）は
--    取込み（import）で上書きしない（保存層が判定する）。店名の平文は持たない。
PRAGMA defer_foreign_keys = ON;

-- --- 1. sealed_blobs（purpose に household_entry を足す） ---
CREATE TABLE sealed_blobs_0016_copy AS SELECT * FROM sealed_blobs;
DROP TABLE sealed_blobs;
-- 0011 と同じ列・制約。用途に household_entry（家計の記録の内容。所有者は household_entries）を足す。
CREATE TABLE sealed_blobs (
  blob_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'operation_intent', 'turn_text', 'session_summary', 'source_body', 'candidate_title',
    'candidate_excerpt', 'memory_text', 'memory_target_key', 'directive_text',
    'connection_account', 'request_summary', 'proposal', 'task_content', 'household_entry')),
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
  SELECT blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at FROM sealed_blobs_0016_copy;
DROP TABLE sealed_blobs_0016_copy;
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

-- --- 2. household_entries ---
CREATE TABLE household_entries (
  entry_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('mail_notice', 'csv_import', 'manual')),
  -- 出所の材料（domain の householdSourceKeyMaterial）の SHA-256（小文字の 16 進）。
  source_key TEXT NOT NULL UNIQUE CHECK (length(source_key) = 64 AND source_key NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
  -- 利用した月（YYYY-MM）。集計の範囲を引くためだけに平文で持つ。削除したら NULL。
  month TEXT CHECK (month IS NULL OR (length(month) = 7 AND month GLOB '20[0-9][0-9]-[01][0-9]'
    AND substr(month, 6, 2) BETWEEN '01' AND '12')),
  content_revision INTEGER NOT NULL CHECK (content_revision >= 1),
  content_blob_id TEXT UNIQUE REFERENCES sealed_blobs (blob_id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CHECK ((state = 'active') = (content_blob_id IS NOT NULL AND month IS NOT NULL AND deleted_at IS NULL)),
  CHECK ((state = 'deleted') = (content_blob_id IS NULL AND month IS NULL AND deleted_at IS NOT NULL))
) STRICT;
CREATE INDEX household_entries_month ON household_entries (month) WHERE state = 'active';

-- 暗号文は自分の内容（用途 household_entry・持ち主は同じ記録・版は内容版）だけを指す。
CREATE TRIGGER household_entries_blob_owner_insert BEFORE INSERT ON household_entries
  WHEN NEW.content_blob_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sealed_blobs
     WHERE blob_id = NEW.content_blob_id AND purpose = 'household_entry'
       AND owner_table = 'household_entries' AND owner_id = NEW.entry_id
       AND owner_version = NEW.content_revision)
BEGIN
  SELECT RAISE(ABORT, 'household_blob_owner_mismatch');
END;

CREATE TRIGGER household_entries_blob_owner_update BEFORE UPDATE ON household_entries
  WHEN NEW.content_blob_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sealed_blobs
     WHERE blob_id = NEW.content_blob_id AND purpose = 'household_entry'
       AND owner_table = 'household_entries' AND owner_id = NEW.entry_id
       AND owner_version = NEW.content_revision)
BEGIN
  SELECT RAISE(ABORT, 'household_blob_owner_mismatch');
END;

-- 出所・作成時刻は変えない。内容版は 1 つずつ上げる（同じ版のままの書き換えと巻き戻しを拒否する）。
CREATE TRIGGER household_entries_fixed BEFORE UPDATE ON household_entries
  WHEN NEW.entry_id <> OLD.entry_id OR NEW.source_kind <> OLD.source_kind
    OR NEW.source_key <> OLD.source_key OR NEW.created_at <> OLD.created_at
    OR NEW.content_revision <> OLD.content_revision + 1
    OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'household_entry_fixed');
END;

-- 削除した行は変えない（作り直しを止める印として残す）。
CREATE TRIGGER household_entries_deleted_fixed BEFORE UPDATE ON household_entries
  WHEN OLD.state = 'deleted'
BEGIN
  SELECT RAISE(ABORT, 'household_entry_deleted');
END;

-- 行は消さない（削除は state で表す）。
CREATE TRIGGER household_entries_no_delete BEFORE DELETE ON household_entries
BEGIN
  SELECT RAISE(ABORT, 'household_entry_no_delete');
END;

-- --- 3. household_category_rules ---
CREATE TABLE household_category_rules (
  -- 正規化した店名の HMAC-SHA256（小文字の 16 進）。
  merchant_key TEXT PRIMARY KEY CHECK (length(merchant_key) = 64 AND merchant_key NOT GLOB '*[^0-9a-f]*'),
  category TEXT NOT NULL CHECK (category IN (
    'food', 'cash_card', 'transport', 'hobby', 'daily_goods', 'clothing_beauty', 'special', 'social',
    'housing', 'utilities', 'car', 'insurance', 'tax_social', 'education', 'communication',
    'health_medical', 'other', 'uncategorized', 'income', 'transfer')),
  origin TEXT NOT NULL CHECK (origin IN ('user', 'import')),
  updated_at INTEGER NOT NULL
) STRICT;

-- 本人が決めた規則を取込みの規則で置き換えない（保存層の判定の最後のガード）。
CREATE TRIGGER household_category_rules_user_kept BEFORE UPDATE ON household_category_rules
  WHEN OLD.origin = 'user' AND NEW.origin = 'import'
BEGIN
  SELECT RAISE(ABORT, 'household_rule_user_kept');
END;
