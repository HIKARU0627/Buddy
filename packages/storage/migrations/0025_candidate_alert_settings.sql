-- 気づきの OS 通知の入・切の設定（ADR 0073 の「既定は OFF、本人が設定で ON」、ADR 0196）。
--
-- candidate_alert_settings: 1 行だけの表。新しい気づきの OS 通知（とトレイの new の件数）を出すか（on・off）と、本人の変更の版。
-- 行がなければ off（通知を出さない）で、版は 0。設定は中枢が正本で、本人の画面操作だけが変える。通知の送出意図（deliveries、
-- 0001）を書くときは、同じ transaction でこの行を読み、off なら・判定を始めた時点の版と今の版が違えば書かない（最後の保証）。
-- 作り方は保存してよい記憶の種類の設定（0024 の memory_settings）と同じ。版を戻さないため、行は作り直さず消さない。最初の
-- INSERT は版 1 だけ、行があれば INSERT（INSERT OR REPLACE を含む）を作る前に拒む、DELETE を拒む、UPDATE は版を 1 だけ進める。
-- 復元の後に通知を止めるとき（restore-aftermath-store.ts）も UPDATE で off にして版を進める。

CREATE TABLE candidate_alert_settings (
  setting_id INTEGER PRIMARY KEY CHECK (setting_id = 1),
  os_notification TEXT NOT NULL CHECK (os_notification IN ('on', 'off')),
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 1),
  updated_at INTEGER NOT NULL
) STRICT;

-- 行は 1 回だけ作る（置き換え・作り直しで版が 1 に戻らないように）。
CREATE TRIGGER candidate_alert_settings_no_replace
BEFORE INSERT ON candidate_alert_settings
WHEN EXISTS (SELECT 1 FROM candidate_alert_settings)
BEGIN
  SELECT RAISE(ABORT, 'candidate_alert_settings_no_replace');
END;

-- 最初の行の版は 1（行がない間の版 0 の次）。
CREATE TRIGGER candidate_alert_settings_insert_first
BEFORE INSERT ON candidate_alert_settings
WHEN NEW.settings_revision <> 1
BEGIN
  SELECT RAISE(ABORT, 'candidate_alert_settings_insert_first');
END;

-- 版は 1 ずつだけ進める（飛ばし・戻しを拒否する）。
CREATE TRIGGER candidate_alert_settings_revision_step
BEFORE UPDATE ON candidate_alert_settings
WHEN NEW.settings_revision <> OLD.settings_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'candidate_alert_settings_revision_step');
END;

-- 行は消さない（消すと版が 0 に戻る）。
CREATE TRIGGER candidate_alert_settings_no_delete
BEFORE DELETE ON candidate_alert_settings
BEGIN
  SELECT RAISE(ABORT, 'candidate_alert_settings_no_delete');
END;
