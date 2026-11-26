-- 家計簿の段階 1: 利用通知メールの取り込みで確かめたメール（ADR 0160）。
--
-- household_mail_checks: 同期で保存したメール（source_items）のうち、利用通知かを確かめ終えたもの。
-- 通知だったか・記録したかは持たない（どのメールがカードの通知かを DB に残さない）。メールの行が消えれば一緒に消える。
-- household_mail_baselines: 口座ごとに取り込みを始めた時刻。始めたときにあったメールは確かめ済みにして読まない
-- （過去のメールを一度に取りに行かない。過去の分は書き出しの取り込みで補う）。

CREATE TABLE household_mail_checks (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  account_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (provider, account_id, remote_id),
  FOREIGN KEY (provider, account_id, remote_id)
    REFERENCES source_items (provider, account_id, remote_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE household_mail_baselines (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  account_id TEXT NOT NULL,
  established_at INTEGER NOT NULL,
  PRIMARY KEY (provider, account_id)
) STRICT;
