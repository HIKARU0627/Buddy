-- 家計簿: 請求予定を消す操作と、レシートの写真の読み取りの設定の保存（ADR 0179）。
--
-- 1. household_bills に状態（state）・内容版（content_revision）・消した時刻（deleted_at）を足す。月と暗号文を消すので
--    NULL を許す形にする必要があり、列の追加ではできないため、表を作り直す（同じ行を入れ直す。子の表はない）。
--    消し方は家計の記録（household_entries、0016）と同じで、行は残して状態を deleted にし、月と暗号文を消す。出所の鍵が
--    残るので、同じメールから作り直さない。0021 の trigger（変更の拒否・削除の拒否）を、有効から消したへの変更だけを許す
--    形に作り直す。既存の請求予定は有効・内容版 1 にする。
-- 2. household_settings にレシートの写真の読み取りの入・切（receipt_reading）を足す。既定は切。版は利用通知の取り込みの
--    入・切と同じ settings_revision を使う（1 ずつだけ進む trigger は 0018 のまま）。
PRAGMA defer_foreign_keys = ON;

-- --- 1. household_bills ---
CREATE TABLE household_bills_0022_copy AS SELECT * FROM household_bills;
DROP TABLE household_bills;
CREATE TABLE household_bills (
  bill_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('mail_bill')),
  -- 出所の材料（domain の householdBillSourceKeyMaterial）の SHA-256（小文字の 16 進）。
  source_key TEXT NOT NULL UNIQUE CHECK (length(source_key) = 64 AND source_key NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
  -- 引き落とし日の月（YYYY-MM）。月の請求予定を引くためだけに平文で持つ。消したら NULL。
  month TEXT CHECK (month IS NULL OR (length(month) = 7 AND month GLOB '20[0-9][0-9]-[01][0-9]'
    AND substr(month, 6, 2) BETWEEN '01' AND '12')),
  -- 内容版。作ったときは 1、消すと 1 進む（中身を直す操作はない）。
  content_revision INTEGER NOT NULL CHECK (content_revision >= 1),
  content_blob_id TEXT UNIQUE REFERENCES sealed_blobs (blob_id),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CHECK ((state = 'active') = (content_blob_id IS NOT NULL AND month IS NOT NULL AND deleted_at IS NULL)),
  CHECK ((state = 'deleted') = (content_blob_id IS NULL AND month IS NULL AND deleted_at IS NOT NULL))
) STRICT;
INSERT INTO household_bills (bill_id, source_kind, source_key, state, month, content_revision, content_blob_id, created_at, deleted_at)
  SELECT bill_id, source_kind, source_key, 'active', month, 1, content_blob_id, created_at, NULL FROM household_bills_0022_copy;
DROP TABLE household_bills_0022_copy;
CREATE INDEX household_bills_month ON household_bills (month) WHERE state = 'active';

-- 作るときは有効・内容版 1 だけ。
CREATE TRIGGER household_bills_insert_active BEFORE INSERT ON household_bills
  WHEN NEW.state <> 'active' OR NEW.content_revision <> 1
BEGIN
  SELECT RAISE(ABORT, 'household_bill_insert_active');
END;

-- 暗号文は自分の中身（用途 household_bill・持ち主は同じ請求予定・版は 1）だけを指す（0021 と同じ。暗号文のない行は
-- 上の trigger と表の CHECK が拒否する）。
CREATE TRIGGER household_bills_blob_owner BEFORE INSERT ON household_bills
  WHEN NEW.content_blob_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sealed_blobs
     WHERE blob_id = NEW.content_blob_id AND purpose = 'household_bill'
       AND owner_table = 'household_bills' AND owner_id = NEW.bill_id
       AND owner_version = 1)
BEGIN
  SELECT RAISE(ABORT, 'household_bill_blob_owner_mismatch');
END;

-- 変更は、有効から消したへの変更だけ。ID・出所・作成時刻は変えず、内容版は 1 だけ進める。月・暗号文・消した時刻は
-- 表の CHECK が状態に合わせて確かめる。消した行は変えない（作り直しを止める印として残す）。
CREATE TRIGGER household_bills_delete_only BEFORE UPDATE ON household_bills
  WHEN NOT (OLD.state = 'active' AND NEW.state = 'deleted'
    AND NEW.bill_id = OLD.bill_id AND NEW.source_kind = OLD.source_kind
    AND NEW.source_key = OLD.source_key AND NEW.created_at = OLD.created_at
    AND NEW.content_revision = OLD.content_revision + 1)
BEGIN
  SELECT RAISE(ABORT, 'household_bill_fixed');
END;

-- 行は消さない（消したことは state で表す。出所の鍵で同じメールから作り直さないための印にもなる）。
CREATE TRIGGER household_bills_no_delete BEFORE DELETE ON household_bills
BEGIN
  SELECT RAISE(ABORT, 'household_bill_no_delete');
END;

-- --- 2. household_settings ---
-- レシートの写真を外部のモデルの画像の読み取りへ送るか（ADR 0177 の U363）。既定は切。中枢に読み取りの口がないときは、
-- 保存した値によらず Core が unavailable として扱う。
ALTER TABLE household_settings ADD COLUMN receipt_reading TEXT NOT NULL DEFAULT 'off'
  CHECK (receipt_reading IN ('on', 'off'));
