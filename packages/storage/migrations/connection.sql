-- 書込み接続の作成時に実行し、PRAGMA を読み戻して一致を確かめる（設計 08 §3、11 §9、ADR 0010）。
-- 一致しなければ外部変更を開始しない。性能のために synchronous を NORMAL へ下げない。
-- fullfsync は macOS で有効にする。WAL は中枢のローカルディスクだけで使い、共有フォルダーに DB を置かない。
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA fullfsync = ON;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 0;
-- 消した行の内容を空きページに残さない（ADR 0040・0048）。暗号文なので鍵がなければ読めないが、
-- 忘却・期限で消したことを言えるようにする。SSD の痕跡消去までは保証しない。
PRAGMA secure_delete = ON;
