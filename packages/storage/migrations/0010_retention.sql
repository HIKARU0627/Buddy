-- 保存案 0010（B06-06a・b、ADR 0048）。ADR 0040 が「マイグレーション 0008 の案」として書いた内容のうち、
-- 番号に依存しない部分を 1 版にまとめる。実際の番号は、0008（B07-07）・0009（B05-03）が先にマージされたため 0010。
-- 1. 予算の記録の削除（J4）。予約に delete_at を足し、消してよい状態になった時点で期限を書く。DB の最終ガードは
--    BEFORE DELETE の trigger（delete_at が NULL の行を消さない）。月ごとにまとめて消すのは DB worker の命令
--    （budget.purge_month）が行う（ADR 0040・0043）。
-- 2. 派生物の系譜（derivations）。要約・抄録・抽出結果などの派生物と、その由来（発言・元情報・記憶・派生物）を結ぶ。
--    同じ組は 1 つだけ。由来から引く索引を付ける。書き込み・読み出しは storage の関数（B06-06b）。
-- 3. 記録しない会話の最小の操作記録（U42）と、復元の後の未確認の印（J3）。operations.record_kind が
--    private_minimal の行は workflow_id を持てない。restore_unverified_at が NULL でない操作は、承認の作成・
--    approved / preparing への遷移・試行の作成を拒否する。印を外す更新は許す（後の作業の命令が行う）。

-- --- A. 予算の記録の削除（J4） ---
-- 期限は予算月の締めから 13 か月後（domain の budgetRecordDeleteAt）。精算・解放・M 超過の確認で消してよい状態に
-- なった時点で書く。0010 より前からある行は NULL のまま（推測の時刻を入れない。ADR 0048）。
ALTER TABLE budget_reservations ADD COLUMN delete_at INTEGER CHECK (delete_at IS NULL OR delete_at >= 0);

-- delete_at は「消してよい状態」にだけ書く。一度書いた値を変えない・消さない。
CREATE TRIGGER budget_reservations_delete_at_valid BEFORE UPDATE OF delete_at ON budget_reservations
  WHEN NEW.delete_at IS NOT OLD.delete_at
    AND (OLD.delete_at IS NOT NULL
      OR NEW.delete_at IS NULL
      OR NOT (NEW.status = 'released'
        OR (NEW.status = 'settled'
          AND (NEW.overrun_reviewed = 1
            OR (NEW.actual_gross IS NOT NULL AND NEW.actual_gross <= NEW.max_liability)))))
BEGIN
  SELECT RAISE(ABORT, 'budget_delete_at_invalid');
END;

-- 挿入の時点でも、消してよい状態でなければ delete_at を持てない（受付は NULL で挿入する）。
CREATE TRIGGER budget_reservations_delete_at_insert BEFORE INSERT ON budget_reservations
  WHEN NEW.delete_at IS NOT NULL
    AND NOT (NEW.status = 'released'
      OR (NEW.status = 'settled'
        AND (NEW.overrun_reviewed = 1
          OR (NEW.actual_gross IS NOT NULL AND NEW.actual_gross <= NEW.max_liability))))
BEGIN
  SELECT RAISE(ABORT, 'budget_delete_at_invalid');
END;

-- DB の最終ガード: delete_at のない行（消してはいけない行）は消せない。時刻との比較は DB worker が持つ。
CREATE TRIGGER budget_reservations_delete_requires_delete_at BEFORE DELETE ON budget_reservations
  WHEN OLD.delete_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'budget_delete_at_missing');
END;

-- 月ごとの削除（budget.purge_month）と、期限の到来の確認に使う。
CREATE INDEX budget_reservations_delete_at ON budget_reservations (budget_month, delete_at);

-- --- B. 派生物の系譜 ---
-- artifact_kind: domain の forget-plan.ts の ForgetNodeKind のうち、派生物になれる種類（turn・memory と
-- FORGET_ARTIFACT_KINDS の 9 種類）。source_kind: 根の由来（turn・source_item・memory）と派生物の種類。
-- session は「由来を引けない派生物の範囲」を表すだけで、系譜の辺には現れない（domain の sourceOk と同じ）。
CREATE TABLE derivations (
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN (
    'turn', 'memory',
    'session_summary', 'carried_summary', 'notification_candidate', 'request_entity',
    'related_analysis', 'canvas_item', 'intent_shadow', 'operation_content', 'async_guard'
  )),
  artifact_id TEXT NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 256),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'turn', 'source_item', 'memory',
    'session_summary', 'carried_summary', 'notification_candidate', 'request_entity',
    'related_analysis', 'canvas_item', 'intent_shadow', 'operation_content', 'async_guard'
  )),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (artifact_kind, artifact_id, source_kind, source_id)
) STRICT;

-- 由来（source_kind, source_id）から、そこから作った派生物を引く（忘却の閉包・復元の適用）。
CREATE INDEX derivations_by_source ON derivations (source_kind, source_id);

-- --- C. 記録しない会話の最小の操作記録（U42） ---
-- private_minimal の操作は会話（workflow）へのつながりを持たない。0001 の操作は normal。
ALTER TABLE operations ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'normal' CHECK (record_kind IN ('normal', 'private_minimal'));

CREATE TRIGGER operations_private_minimal_workflow_insert BEFORE INSERT ON operations
  WHEN NEW.record_kind = 'private_minimal' AND NEW.workflow_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'operation_private_minimal_workflow');
END;

CREATE TRIGGER operations_private_minimal_workflow_update BEFORE UPDATE OF record_kind, workflow_id ON operations
  WHEN NEW.record_kind = 'private_minimal' AND NEW.workflow_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'operation_private_minimal_workflow');
END;

-- --- D. 復元の後の未確認の印（J3） ---
-- 古いバックアップからの復元で隔離した操作。印がある間は、承認・approved / preparing への遷移・試行を作れない
-- （最後の保証は DB）。印を外す（NULL に戻す）更新は、後の作業の命令が行うので拒否しない。
ALTER TABLE operations ADD COLUMN restore_unverified_at INTEGER CHECK (restore_unverified_at IS NULL OR restore_unverified_at >= 0);

CREATE INDEX operations_restore_unverified ON operations (restore_unverified_at)
  WHERE restore_unverified_at IS NOT NULL;

CREATE TRIGGER approvals_restore_unverified BEFORE INSERT ON approvals
  WHEN EXISTS (
    SELECT 1 FROM operations
     WHERE operation_id = NEW.operation_id AND restore_unverified_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'operation_restore_unverified');
END;

CREATE TRIGGER operations_restore_unverified_transition BEFORE UPDATE OF state ON operations
  WHEN NEW.restore_unverified_at IS NOT NULL
    AND NEW.state IN ('approved', 'preparing')
    AND NEW.state <> OLD.state
BEGIN
  SELECT RAISE(ABORT, 'operation_restore_unverified');
END;

CREATE TRIGGER operation_attempts_restore_unverified BEFORE INSERT ON operation_attempts
  WHEN EXISTS (
    SELECT 1 FROM operations
     WHERE operation_id = NEW.operation_id AND restore_unverified_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'operation_restore_unverified');
END;
