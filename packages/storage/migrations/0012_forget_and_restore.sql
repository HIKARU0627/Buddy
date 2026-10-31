-- 保存案 0012（B06-06d2、ADR 0054）。番号はマージの順に決める（仮の 0012）。
-- 1. schema_meta に、忘却台帳の系譜（ledger_id。台帳の別ファイルと同じ値で、復元しても変えない）・台帳の HMAC の鍵の ID
--    （ledger_hmac_key_id。書くのは B06-08）・効いている復元の時刻（restore_restored_at・restore_backup_created_at。
--    予算の保留・付帯クレジット・候補起点の自動実行の検査が読む）のキーを足す。CHECK を変えるため 0002 と同じく作り直す。
--    ledger_id は一度書いたら変えない・消さない。
-- 2. forget_ledger に entry_hash（台帳の別ファイルと同じ連鎖の hash）と item_count（その世代の項目の数）を足す。新しい
--    世代は両方を持つ。forget_ledger_items は追記だけ（更新・削除・置き換えを拒否）で、世代ごとに item_count を超えて
--    足せない（書いた後に項目を足して連鎖の hash と食い違わせない）。INSERT OR REPLACE で台帳の行を入れ替えない。
-- 3. operations.send_blocked_generation（忘却の送出禁止の印。ADR 0044 の U61）。忘れた内容を含み得る進行中の操作の確定内容を
--    残すときに、その忘却の世代を付ける。印は一度だけ付き、外さない。印のある操作は、承認の作成・approved / preparing /
--    dispatching への遷移・LocalCommand の適用（succeeded への遷移）・試行の作成と dispatching への更新を拒否する。
--    送出済みの結果（reconciling → succeeded など）の記録と取消は止めない（再送もしない）。

-- --- A. schema_meta ---
CREATE TABLE schema_meta_0012 (
  key TEXT PRIMARY KEY CHECK (
    key IN ('schema_version', 'store_generation', 'ledger_id', 'ledger_hmac_key_id',
      'restore_restored_at', 'restore_backup_created_at')
    OR key GLOB 'migration_sha256:[0-9][0-9][0-9][0-9]'
    OR (key GLOB 'data_key_check:[A-Za-z0-9]*' AND length(key) <= 143)),
  value TEXT NOT NULL,
  CHECK (key NOT GLOB 'data_key_check:*'
    OR (length(value) = 64 AND value NOT GLOB '*[^0-9a-f]*')),
  -- 台帳の系譜は UUID v4 の小文字（契約の Id）。
  CHECK (key <> 'ledger_id'
    OR (value GLOB '????????-????-4???-????-????????????' AND value NOT GLOB '*[^0-9a-f-]*')),
  -- 鍵の ID は契約の BackupKeyWrap.key_id と同じ文字種。
  CHECK (key <> 'ledger_hmac_key_id'
    OR (length(value) BETWEEN 1 AND 64 AND value NOT GLOB '*[^a-z0-9._-]*' AND value GLOB '[a-z0-9]*')),
  -- 時刻は UTC の Unix ミリ秒の 10 進。
  CHECK (key NOT IN ('restore_restored_at', 'restore_backup_created_at')
    OR (length(value) BETWEEN 1 AND 16 AND value NOT GLOB '*[^0-9]*'))
) STRICT;

INSERT INTO schema_meta_0012 (key, value) SELECT key, value FROM schema_meta;

DROP TABLE schema_meta;

ALTER TABLE schema_meta_0012 RENAME TO schema_meta;

-- 台帳の系譜は変えない・消さない（復元しても同じ系譜。別の系譜の台帳を混ぜない。ADR 0040）。
CREATE TRIGGER schema_meta_ledger_id_fixed BEFORE UPDATE ON schema_meta
  WHEN OLD.key = 'ledger_id' AND (NEW.key <> OLD.key OR NEW.value <> OLD.value)
BEGIN
  SELECT RAISE(ABORT, 'ledger_id_fixed');
END;

CREATE TRIGGER schema_meta_ledger_id_no_delete BEFORE DELETE ON schema_meta
  WHEN OLD.key = 'ledger_id'
BEGIN
  SELECT RAISE(ABORT, 'ledger_id_fixed');
END;

CREATE TRIGGER schema_meta_ledger_id_no_replace BEFORE INSERT ON schema_meta
  WHEN NEW.key = 'ledger_id' AND EXISTS (SELECT 1 FROM schema_meta WHERE key = 'ledger_id')
BEGIN
  SELECT RAISE(ABORT, 'ledger_id_fixed');
END;

-- --- B. 忘却台帳の連鎖の hash と項目の数 ---
-- 0012 より前の行（台帳を書く経路がなかったので、ふつうはない）は NULL のまま。新しい世代は両方を持つ。
ALTER TABLE forget_ledger ADD COLUMN entry_hash TEXT
  CHECK (entry_hash IS NULL OR (length(entry_hash) = 64 AND entry_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE forget_ledger ADD COLUMN item_count INTEGER CHECK (item_count IS NULL OR item_count >= 1);

CREATE TRIGGER forget_ledger_hash_required BEFORE INSERT ON forget_ledger
  WHEN NEW.entry_hash IS NULL OR NEW.item_count IS NULL
BEGIN
  SELECT RAISE(ABORT, 'forget_ledger_hash_required');
END;

-- INSERT OR REPLACE は、既存の行を消してから入れ直すので、追記だけの trigger をすり抜ける（recursive_triggers は 0）。
-- 同じ entry_id への挿入を拒否する（世代の衝突は forget_ledger_contiguous が拒否する）。
CREATE TRIGGER forget_ledger_no_replace BEFORE INSERT ON forget_ledger
  WHEN EXISTS (SELECT 1 FROM forget_ledger WHERE entry_id = NEW.entry_id)
BEGIN
  SELECT RAISE(ABORT, 'forget_ledger_append_only');
END;

CREATE TRIGGER forget_ledger_items_append_only BEFORE UPDATE ON forget_ledger_items
BEGIN
  SELECT RAISE(ABORT, 'forget_ledger_append_only');
END;

CREATE TRIGGER forget_ledger_items_no_delete BEFORE DELETE ON forget_ledger_items
BEGIN
  SELECT RAISE(ABORT, 'forget_ledger_append_only');
END;

CREATE TRIGGER forget_ledger_items_no_replace BEFORE INSERT ON forget_ledger_items
  WHEN EXISTS (
    SELECT 1 FROM forget_ledger_items
     WHERE forgetting_generation = NEW.forgetting_generation AND item_kind = NEW.item_kind
       AND item_id = NEW.item_id)
BEGIN
  SELECT RAISE(ABORT, 'forget_ledger_append_only');
END;

-- 項目は、その世代の item_count まで（0012 より前の世代は item_count が NULL なので、もう足せない）。
CREATE TRIGGER forget_ledger_items_bounded BEFORE INSERT ON forget_ledger_items
  WHEN (SELECT count(*) FROM forget_ledger_items WHERE forgetting_generation = NEW.forgetting_generation)
    >= coalesce((SELECT item_count FROM forget_ledger WHERE forgetting_generation = NEW.forgetting_generation), 0)
BEGIN
  SELECT RAISE(ABORT, 'forget_ledger_items_sealed');
END;

-- 本文を台帳の欄に入れない形の最低限: 発言・記憶は UUID、元情報と再登録の禁止・内容の禁止は HMAC（64 桁の小文字 16 進）。
CREATE TRIGGER forget_ledger_items_shape BEFORE INSERT ON forget_ledger_items
  WHEN (NEW.item_kind IN ('turn', 'memory')
      AND NOT (NEW.item_id GLOB '????????-????-4???-????-????????????' AND NEW.item_id NOT GLOB '*[^0-9a-f-]*'))
    OR (NEW.item_kind IN ('source_item', 'blocked_source', 'blocked_content')
      AND NOT (length(NEW.item_id) = 64 AND NEW.item_id NOT GLOB '*[^0-9a-f]*'))
BEGIN
  SELECT RAISE(ABORT, 'forget_ledger_item_shape');
END;

-- --- C. 忘却の送出禁止の印（U61） ---
ALTER TABLE operations ADD COLUMN send_blocked_generation INTEGER
  CHECK (send_blocked_generation IS NULL OR send_blocked_generation >= 1);

CREATE INDEX operations_send_blocked ON operations (send_blocked_generation)
  WHERE send_blocked_generation IS NOT NULL;

-- 作るときに印を持たせない（印は忘却の transaction だけが付ける）。
CREATE TRIGGER operations_send_blocked_insert BEFORE INSERT ON operations
  WHEN NEW.send_blocked_generation IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'operation_send_blocked_fixed');
END;

-- 印は一度だけ付き、外さない・変えない。付ける世代は台帳にある世代。
CREATE TRIGGER operations_send_blocked_fixed BEFORE UPDATE OF send_blocked_generation ON operations
  WHEN NEW.send_blocked_generation IS NOT OLD.send_blocked_generation
    AND (OLD.send_blocked_generation IS NOT NULL
      OR NEW.send_blocked_generation > coalesce((SELECT max(forgetting_generation) FROM forget_ledger), 0))
BEGIN
  SELECT RAISE(ABORT, 'operation_send_blocked_fixed');
END;

CREATE TRIGGER approvals_send_blocked BEFORE INSERT ON approvals
  WHEN EXISTS (
    SELECT 1 FROM operations
     WHERE operation_id = NEW.operation_id AND send_blocked_generation IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'operation_send_blocked');
END;

-- 送出の手前へ進めない。LocalCommand は approved から succeeded へ直接進む（適用）ので、それも止める。
CREATE TRIGGER operations_send_blocked_transition BEFORE UPDATE OF state ON operations
  WHEN NEW.send_blocked_generation IS NOT NULL AND NEW.state <> OLD.state
    AND (NEW.state IN ('approved', 'preparing', 'dispatching')
      OR (NEW.effect_route = 'local_command' AND NEW.state = 'succeeded'))
BEGIN
  SELECT RAISE(ABORT, 'operation_send_blocked');
END;

CREATE TRIGGER operation_attempts_send_blocked BEFORE INSERT ON operation_attempts
  WHEN EXISTS (
    SELECT 1 FROM operations
     WHERE operation_id = NEW.operation_id AND send_blocked_generation IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'operation_send_blocked');
END;

CREATE TRIGGER operation_attempts_send_blocked_dispatch BEFORE UPDATE OF status ON operation_attempts
  WHEN NEW.status = 'dispatching' AND NEW.status <> OLD.status
    AND EXISTS (
      SELECT 1 FROM operations
       WHERE operation_id = NEW.operation_id AND send_blocked_generation IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'operation_send_blocked');
END;
