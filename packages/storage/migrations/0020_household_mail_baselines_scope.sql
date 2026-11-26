-- 家計簿の利用通知メールの取り込み: 基準を取得集合ごとにする（ADR 0170）。
--
-- 0017 の household_mail_baselines は口座ごとに基準を持っていたため、口座の基準ができた後に足した取得集合の過去のメールを
-- すべて「未確認」として読んでしまった（初めて取り込むときに過去のメールを読まない、という U327 に反する）。
-- (provider, account_id, scope_id) ごとの主キーで作り直す。この表はバックアップに含めない source_cache で、
-- 古い中身は引き継がず捨てる。捨てると次の取り込みで全部の取得集合の基準を作り直し、過去のメールは読まない（安全側）。
-- 確かめ済みのメール（household_mail_checks）は変えない。
DROP TABLE household_mail_baselines;

CREATE TABLE household_mail_baselines (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  account_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  established_at INTEGER NOT NULL,
  PRIMARY KEY (provider, account_id, scope_id)
) STRICT;
