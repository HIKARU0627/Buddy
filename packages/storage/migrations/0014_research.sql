-- B12-05: 公開 Web 調査の受付・状態・試行・出典の保存（設計 05・10 §5、ADR 0077・0125〜0129・0135・0141）。
--
-- - research_jobs: 調査 1 件の状態（WebResearchStatus の保存の行）。transient_links は保存の形に含めない（ADR 0126）。
--   dedupe_key は受付の冪等（同じ要求の再送・同時の重複で、ジョブは 1 つ。ADR 0135）。
--   delete_at は完了から workflow_result の保持（7 日。domain の RETENTION_RULES）で、保存層が回復のときに使う。
-- - research_screenings: 検索語の検査の記録（ADR 0127）。passed の記録だけを保存する（拒否した検索語は保存しない）。
-- - research_attempts: 試行の記録（WebResearchAttempts）を JSON で 1 行に持つ。検索結果・URL・本文は持たない。
-- - research_sources: 永続の出典（WebSourceRecord）。URL の列は持たない（保存しない。本人の決定 A、ADR 0126）。
--   抜粋と要約は公開ページの引用とその要約で、本人の私的な本文ではない（検査済みの検索語・ページの題と同じ扱い）。
--   そのため封筒（sealed_blobs）には入れず、列名も excerpt_text / summary_text として本文の列と区別する（ADR 0141）。
-- - 状態の遷移・試行・出典の整合は domain の規則（web-research-status.ts / web-research-limits.ts）が正本で、
--   保存層（research-store.ts）が保存のたびに検査する。ここでは形の最低限だけを CHECK で守る。

CREATE TABLE research_jobs (
  workflow_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  query_id TEXT NOT NULL,
  -- 検査を通った検索語（本人の質問から作った一般語。ADR 0127 の検査の記録と同じ値）。
  query TEXT NOT NULL CHECK (length(query) BETWEEN 1 AND 512),
  request_revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'accepted', 'searching', 'reading', 'summarizing',
      'completed', 'no_results', 'held', 'failed', 'canceled'
    )
  ),
  state_revision INTEGER NOT NULL CHECK (state_revision >= 1),
  stop_kind TEXT CHECK (
    stop_kind IS NULL OR stop_kind IN ('no_results', 'held', 'failed', 'canceled')
  ),
  stop_reason TEXT CHECK (
    stop_reason IS NULL OR stop_reason IN (
      'zero_hits', 'budget_held', 'query_rejected', 'search_failed',
      'no_readable_page', 'summary_failed', 'user_canceled', 'superseded'
    )
  ),
  -- 完了の結果（completed のときだけ）。出典は research_sources に分ける。
  result_summary TEXT,
  result_unread_count INTEGER CHECK (
    result_unread_count IS NULL OR result_unread_count BETWEEN 0 AND 5
  ),
  result_scope_reduced INTEGER CHECK (
    result_scope_reduced IS NULL OR result_scope_reduced IN (0, 1)
  ),
  -- 要約が作れた時点で先に保存する完了文（状態を completed へ進める前に落ちても、再開で同じ文を使う）。
  pending_summary TEXT,
  -- 完了の気づき（候補 research_done）を作り終えた時刻。NULL の完了は回復のときにもう一度知らせる。
  notified_at INTEGER,
  accepted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  delete_at INTEGER,
  CHECK ((state IN ('completed', 'no_results', 'failed', 'canceled')) = (finished_at IS NOT NULL)),
  CHECK ((stop_kind IS NULL) = (stop_reason IS NULL)),
  CHECK (stop_kind IS NULL OR stop_kind = state),
  CHECK (
    (state = 'completed' AND result_summary IS NOT NULL AND result_unread_count IS NOT NULL AND result_scope_reduced IS NOT NULL AND stop_kind IS NULL)
    OR (state <> 'completed' AND result_summary IS NULL AND result_unread_count IS NULL AND result_scope_reduced IS NULL)
  ),
  CHECK (updated_at >= accepted_at),
  CHECK (finished_at IS NULL OR finished_at >= accepted_at)
) STRICT;

CREATE INDEX research_jobs_state ON research_jobs (state);

CREATE TABLE research_screenings (
  query_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES research_jobs (workflow_id),
  -- passed の記録だけを持つので、検索語は常にある（拒否した検索語は保存しない。ADR 0127）。
  screened_query TEXT NOT NULL CHECK (length(screened_query) BETWEEN 1 AND 512),
  input_sources TEXT NOT NULL,
  rules_version INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome = 'passed'),
  rejected_reasons TEXT NOT NULL,
  screened_at INTEGER NOT NULL
) STRICT;

CREATE TABLE research_attempts (
  workflow_id TEXT PRIMARY KEY REFERENCES research_jobs (workflow_id),
  attempts_json TEXT NOT NULL
) STRICT;

CREATE TABLE research_sources (
  source_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES research_jobs (workflow_id),
  query_id TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  page_title TEXT CHECK (page_title IS NULL OR length(page_title) BETWEEN 1 AND 200),
  excerpt_text TEXT CHECK (excerpt_text IS NULL OR length(excerpt_text) BETWEEN 1 AND 500),
  summary_text TEXT CHECK (summary_text IS NULL OR length(summary_text) BETWEEN 1 AND 4000),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  CHECK (excerpt_text IS NOT NULL OR summary_text IS NOT NULL)
) STRICT;

CREATE INDEX research_sources_workflow ON research_sources (workflow_id);
