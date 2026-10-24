-- 保存案 0008（B05-03、ADR 0046。案は ADR 0038）。音声の世代（epoch）の永続と、入出力の停止の状態。
-- 1. device_epochs: 端末ごとの io・output・audio・session の epoch と、端末単位の停止（local_stop）。
--    どの epoch も戻さない（BEFORE UPDATE）・行を消さない（BEFORE DELETE）。中枢の再起動で巻き戻さない（ADR 0005）。
--    既存の端末の行はここで作り、以後の端末は中枢が最初の書込みの transaction で作る（INSERT OR IGNORE）。
--    io_epoch・output_epoch は停止（/v1/io/stop）で中枢が進める。audio_epoch・session_epoch は Live の開始・再接続・
--    端末の交代で中枢が発行する（live_sessions の挿入と同じ transaction）。
-- 2. io_stop_state: 来客モードと全体停止（家ごとに 1 行）。中枢の再起動で自動解除しない（07 §5）。
-- 3. live_sessions: その接続に発行した audio_epoch・session_epoch の列（挿入の後は変えない）。control_epoch を戻さない、
--    lost・closing・closed から connecting・ready へ戻さない、closed から他へ戻さない、確認済みの終了の使用秒数を変えない
--    （nextLiveControl の表と同じ。10 §2A）。
-- 外部への送信の同意の表（ADR 0038 の案の voice_consents）は、同意の経路（HTTP・OS の確認ダイアログ）と一緒に足す。
CREATE TABLE device_epochs (
  device_id TEXT PRIMARY KEY REFERENCES devices (device_id),
  io_epoch INTEGER NOT NULL DEFAULT 0 CHECK (io_epoch >= 0),
  output_epoch INTEGER NOT NULL DEFAULT 0 CHECK (output_epoch >= 0),
  audio_epoch INTEGER NOT NULL DEFAULT 0 CHECK (audio_epoch >= 0),
  session_epoch INTEGER NOT NULL DEFAULT 0 CHECK (session_epoch >= 0),
  local_stop INTEGER NOT NULL DEFAULT 0 CHECK (local_stop IN (0, 1)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO device_epochs (device_id, updated_at)
  SELECT device_id, registered_at FROM devices;

CREATE TRIGGER device_epochs_no_regress BEFORE UPDATE ON device_epochs
  WHEN NEW.io_epoch < OLD.io_epoch OR NEW.output_epoch < OLD.output_epoch
    OR NEW.audio_epoch < OLD.audio_epoch OR NEW.session_epoch < OLD.session_epoch
    OR NEW.device_id <> OLD.device_id
BEGIN
  SELECT RAISE(ABORT, 'device_epoch_regressed');
END;

CREATE TRIGGER device_epochs_permanent BEFORE DELETE ON device_epochs
BEGIN
  SELECT RAISE(ABORT, 'device_epochs_permanent');
END;

CREATE TABLE io_stop_state (
  stop_id INTEGER PRIMARY KEY CHECK (stop_id = 1),
  guest_mode INTEGER NOT NULL CHECK (guest_mode IN (0, 1)),
  global_stop INTEGER NOT NULL CHECK (global_stop IN (0, 1)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO io_stop_state (stop_id, guest_mode, global_stop, updated_at) VALUES (1, 0, 0, 0);

CREATE TRIGGER io_stop_state_permanent BEFORE DELETE ON io_stop_state
BEGIN
  SELECT RAISE(ABORT, 'io_stop_state_permanent');
END;

ALTER TABLE live_sessions ADD COLUMN audio_epoch INTEGER NOT NULL DEFAULT 0 CHECK (audio_epoch >= 0);
ALTER TABLE live_sessions ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0 CHECK (session_epoch >= 0);

CREATE TRIGGER live_sessions_issued_fixed BEFORE UPDATE OF device_id, audio_epoch, session_epoch, reservation_id ON live_sessions
  WHEN NEW.device_id <> OLD.device_id OR NEW.audio_epoch <> OLD.audio_epoch
    OR NEW.session_epoch <> OLD.session_epoch OR NEW.reservation_id <> OLD.reservation_id
BEGIN
  SELECT RAISE(ABORT, 'live_session_issued_fixed');
END;

CREATE TRIGGER live_sessions_control_epoch_no_regress BEFORE UPDATE OF control_epoch ON live_sessions
  WHEN NEW.control_epoch < OLD.control_epoch
BEGIN
  SELECT RAISE(ABORT, 'live_control_epoch_regressed');
END;

CREATE TRIGGER live_sessions_no_return BEFORE UPDATE OF control_state ON live_sessions
  WHEN (OLD.control_state IN ('lost', 'closing', 'closed') AND NEW.control_state IN ('connecting', 'ready'))
    OR (OLD.control_state = 'ready' AND NEW.control_state = 'connecting')
    OR (OLD.control_state = 'closed' AND NEW.control_state <> 'closed')
BEGIN
  SELECT RAISE(ABORT, 'live_control_state_regressed');
END;

CREATE TRIGGER live_sessions_close_confirmed_final BEFORE UPDATE OF closure, usage_seconds ON live_sessions
  WHEN OLD.closure = 'close_confirmed'
    AND (NEW.closure <> OLD.closure OR NEW.usage_seconds IS NOT OLD.usage_seconds)
BEGIN
  SELECT RAISE(ABORT, 'live_close_confirmed_final');
END;
