-- 家計簿: 家計の記録（household_entries）の INSERT OR REPLACE による置き換えを DB で拒む（ADR 0179 の追補）。
--
-- SQLite は INSERT OR REPLACE で衝突した行を削除してから入れるが、recursive_triggers が 0 のとき削除の trigger は動かない。
-- そのため 0016 の household_entries_no_delete は置き換えでは働かず、消した印の行（state = 'deleted'。出所の鍵を残して同じ
-- メールや書き出しから作り直さない印）を、新しい有効な行で置き換えられてしまう。保存層は普通の INSERT しか使わないので
-- 今の経路では起きないが、DB の最終ガードとして、sealed_blobs_no_replace や 0022 の household_bills_no_replace と同じ形で、
-- ID か出所の鍵が既にある行の INSERT を作る前に拒む。
-- 表は作り直さず trigger を足すだけにする（既存の行は変えない。表の数も分類も変わらない）。
CREATE TRIGGER household_entries_no_replace BEFORE INSERT ON household_entries
  WHEN EXISTS (SELECT 1 FROM household_entries WHERE entry_id = NEW.entry_id)
    OR EXISTS (SELECT 1 FROM household_entries WHERE source_key = NEW.source_key)
BEGIN
  SELECT RAISE(ABORT, 'household_entry_no_replace');
END;
