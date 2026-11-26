-- 家計簿の段階 1: 本人の家計簿の設定（ADR 0163）。
--
-- household_settings: 1 行だけの表。利用通知メールの取り込みの入・切（mail_intake）と、本人の変更の版。
-- 行がなければ取り込みは入（U326 の暫定: Gmail の接続があれば本人の操作なしに始める）で、版は 0。
-- 切から入へ戻すときは household_mail_baselines を消し、止めていた間に届いたメールを読まずに基準から作り直す（U334）。

CREATE TABLE household_settings (
  setting_id INTEGER PRIMARY KEY CHECK (setting_id = 1),
  mail_intake TEXT NOT NULL CHECK (mail_intake IN ('on', 'off')),
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 1),
  updated_at INTEGER NOT NULL
) STRICT;

-- 版は 1 ずつだけ進める（飛ばし・戻しを拒否する）。
CREATE TRIGGER household_settings_revision_step
BEFORE UPDATE ON household_settings
WHEN NEW.settings_revision <> OLD.settings_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'household_settings_revision_step');
END;
