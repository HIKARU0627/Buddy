-- B13-04: 候補を起点にした方針による自動承認の、判定に使った候補と版（設計 11 §5A・§5B、08 §1・§9、ADR 0103・0148）。
--
-- 方針による自動承認（approvals.route = 'policy_auto'）のうち、気づきの候補を起点にしたものは、判定に使った候補・依頼の版・
-- 関連解析の版を承認の行に持つ。LocalCommand の適用と RemoteMutation の送出意図の直前に、この版と DB の現在値を照らし、
-- 依頼の取消・完了・版の変化、関連解析の新しい版・未完了があれば送出しない（最終ガード）。
--
-- - 承認の行は操作と一緒に 90 日で消える（ADR 0040 の手順 5）。依頼が期限で先に消えても承認の行は残るので、
--   最終ガードは「依頼が見つからない」として拒否できる（版を持つ行が消えて照合を素通りすることがない）。
-- - 本人の依頼を起点にした自動承認と画面での承認は、これらの列を持たない（すべて NULL）。
-- - 列は 7 つそろって持つか、すべて持たない。持つのは policy_auto だけ。記録の後は変えない（trigger で守る）。
--   ALTER TABLE では表の CHECK を足せないので、組み合わせは trigger で検査する。

ALTER TABLE approvals ADD COLUMN candidate_id TEXT;
ALTER TABLE approvals ADD COLUMN request_entity_id TEXT;
ALTER TABLE approvals ADD COLUMN request_revision INTEGER CHECK (request_revision IS NULL OR request_revision >= 1);
ALTER TABLE approvals ADD COLUMN related_group_id TEXT;
ALTER TABLE approvals ADD COLUMN analysis_revision INTEGER CHECK (analysis_revision IS NULL OR analysis_revision >= 1);
ALTER TABLE approvals ADD COLUMN source_set_hash TEXT CHECK (source_set_hash IS NULL OR length(source_set_hash) = 64);
ALTER TABLE approvals ADD COLUMN published_generation INTEGER CHECK (published_generation IS NULL OR published_generation >= 0);

CREATE TRIGGER approvals_candidate_guard_shape BEFORE INSERT ON approvals
  WHEN NOT (
    (NEW.candidate_id IS NULL AND NEW.request_entity_id IS NULL AND NEW.request_revision IS NULL
      AND NEW.related_group_id IS NULL AND NEW.analysis_revision IS NULL AND NEW.source_set_hash IS NULL
      AND NEW.published_generation IS NULL)
    OR (NEW.route = 'policy_auto' AND NEW.candidate_id IS NOT NULL AND NEW.request_entity_id IS NOT NULL
      AND NEW.request_revision IS NOT NULL AND NEW.related_group_id IS NOT NULL
      AND NEW.analysis_revision IS NOT NULL AND NEW.source_set_hash IS NOT NULL
      AND NEW.published_generation IS NOT NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'approval_candidate_guard_invalid');
END;

CREATE TRIGGER approvals_candidate_guard_fixed BEFORE UPDATE OF candidate_id, request_entity_id, request_revision,
  related_group_id, analysis_revision, source_set_hash, published_generation ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approval_candidate_guard_fixed');
END;
