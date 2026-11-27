-- 保存してよい記憶の種類の設定（#180 の Q10・U432、ADR 0191）。
--
-- memory_settings: 1 行だけの表。6 種類（好み・目標・人・習慣・言葉の使い方・進み具合）ごとに、保存してよいか（on・off）と、
-- 本人の変更の版。行がなければ 6 種類とも off（何も保存しない）で、版は 0。設定は中枢が正本で、本人の画面操作だけが変える。
-- 記憶の保存（memory.save と、発言と同じ transaction の保存）は、同じ transaction でこの行を読み、種類が off なら・処理を
-- 始めた時点の版と今の版が違えば保存しない（最後の保証）。
-- 版を戻さないため、行は作り直さず消さない（0023 の household_entries_no_replace と同じ考え）。最初の INSERT は版 1 だけ、
-- 行があれば INSERT（INSERT OR REPLACE を含む）を作る前に拒む、DELETE を拒む、UPDATE は版を 1 だけ進める。復元の後に
-- 許可を取り消すとき（restore-aftermath-store.ts）も UPDATE で全部 off にして版を進める。

CREATE TABLE memory_settings (
  setting_id INTEGER PRIMARY KEY CHECK (setting_id = 1),
  preference TEXT NOT NULL CHECK (preference IN ('on', 'off')),
  goal TEXT NOT NULL CHECK (goal IN ('on', 'off')),
  person TEXT NOT NULL CHECK (person IN ('on', 'off')),
  routine TEXT NOT NULL CHECK (routine IN ('on', 'off')),
  lexicon TEXT NOT NULL CHECK (lexicon IN ('on', 'off')),
  progress TEXT NOT NULL CHECK (progress IN ('on', 'off')),
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 1),
  updated_at INTEGER NOT NULL
) STRICT;

-- 行は 1 回だけ作る（置き換え・作り直しで版が 1 に戻らないように）。
CREATE TRIGGER memory_settings_no_replace
BEFORE INSERT ON memory_settings
WHEN EXISTS (SELECT 1 FROM memory_settings)
BEGIN
  SELECT RAISE(ABORT, 'memory_settings_no_replace');
END;

-- 最初の行の版は 1（行がない間の版 0 の次）。
CREATE TRIGGER memory_settings_insert_first
BEFORE INSERT ON memory_settings
WHEN NEW.settings_revision <> 1
BEGIN
  SELECT RAISE(ABORT, 'memory_settings_insert_first');
END;

-- 版は 1 ずつだけ進める（飛ばし・戻しを拒否する）。
CREATE TRIGGER memory_settings_revision_step
BEFORE UPDATE ON memory_settings
WHEN NEW.settings_revision <> OLD.settings_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'memory_settings_revision_step');
END;

-- 行は消さない（消すと版が 0 に戻る）。
CREATE TRIGGER memory_settings_no_delete
BEFORE DELETE ON memory_settings
BEGIN
  SELECT RAISE(ABORT, 'memory_settings_no_delete');
END;
