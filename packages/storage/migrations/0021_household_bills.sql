-- 家計簿の段階 2: 請求予定（ADR 0176）。
--
-- 1. sealed_blobs.purpose に household_bill（請求予定の中身。所有者は household_bills、版は 1）を足す。
--    作り直しの方法は 0011・0016・0019 と同じ（外部キーの検査を transaction の終わりまで遅らせ、親を消して同じ名前で作り直し、
--    同じ行を入れ直す。子の表は作り直さない）。索引・trigger もそのまま作り直す。
-- 2. household_bills: カード会社の請求のお知らせから読んだ請求予定を 1 件 1 行。家計の記録（household_entries）とは別の表に
--    置き、月の集計・予算・定期の支出の計算に入れない（利用の記録と二重に数えない）。平文で持つのは出所の種類・出所の鍵
--    （SHA-256）・月（引き落とし日の月）・作成時刻だけで、会社・金額・引き落とし日は暗号文（household_bill）に入れる。
--    画面からの変更・削除はまだないので、行は書いたら変えず、消さない（出所の鍵で同じメールから作り直さない）。
PRAGMA defer_foreign_keys = ON;

-- --- 1. sealed_blobs（purpose に household_bill を足す） ---
CREATE TABLE sealed_blobs_0021_copy AS SELECT * FROM sealed_blobs;
DROP TABLE sealed_blobs;
-- 0019 と同じ列・制約。用途に household_bill（請求予定の中身。所有者は household_bills）を足す。
CREATE TABLE sealed_blobs (
  blob_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'operation_intent', 'turn_text', 'session_summary', 'source_body', 'candidate_title',
    'candidate_excerpt', 'memory_text', 'memory_target_key', 'directive_text',
    'connection_account', 'request_summary', 'proposal', 'task_content', 'household_entry',
    'household_budget', 'household_bill')),
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
  SELECT blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at FROM sealed_blobs_0021_copy;
DROP TABLE sealed_blobs_0021_copy;
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

-- --- 2. household_bills ---
CREATE TABLE household_bills (
  bill_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('mail_bill')),
  -- 出所の材料（domain の householdBillSourceKeyMaterial）の SHA-256（小文字の 16 進）。
  source_key TEXT NOT NULL UNIQUE CHECK (length(source_key) = 64 AND source_key NOT GLOB '*[^0-9a-f]*'),
  -- 引き落とし日の月（YYYY-MM）。月の請求予定を引くためだけに平文で持つ。
  month TEXT NOT NULL CHECK (length(month) = 7 AND month GLOB '20[0-9][0-9]-[01][0-9]'
    AND substr(month, 6, 2) BETWEEN '01' AND '12'),
  content_blob_id TEXT NOT NULL UNIQUE REFERENCES sealed_blobs (blob_id),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX household_bills_month ON household_bills (month);

-- 暗号文は自分の中身（用途 household_bill・持ち主は同じ請求予定・版は 1）だけを指す。
CREATE TRIGGER household_bills_blob_owner BEFORE INSERT ON household_bills
  WHEN NOT EXISTS (
    SELECT 1 FROM sealed_blobs
     WHERE blob_id = NEW.content_blob_id AND purpose = 'household_bill'
       AND owner_table = 'household_bills' AND owner_id = NEW.bill_id
       AND owner_version = 1)
BEGIN
  SELECT RAISE(ABORT, 'household_bill_blob_owner_mismatch');
END;

-- 書いた請求予定は変えない。
CREATE TRIGGER household_bills_no_update BEFORE UPDATE ON household_bills
BEGIN
  SELECT RAISE(ABORT, 'household_bill_fixed');
END;

-- 行は消さない（出所の鍵で同じメールから作り直さないための印にもなる）。
CREATE TRIGGER household_bills_no_delete BEFORE DELETE ON household_bills
BEGIN
  SELECT RAISE(ABORT, 'household_bill_no_delete');
END;
