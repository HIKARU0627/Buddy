-- 気づき（候補）の由来の位置（ADR 0201、Issue #271 の残り (1)）。根拠を許可範囲から取り直す先を、候補を作ったときに控える。
--
-- 候補の由来の辺（derivations）は元情報の remote_id だけで、予定のカレンダー・接続・口座・取得集合を持たない。元情報の行
-- （source_items）は取得から 24 時間の期限で行ごと消え（source_body）、カレンダーの ID も持たないので、根拠の取り直しの
-- 先にできない（ADR 0194、U545）。候補ごと・由来の元情報ごとに 1 行で、次を持つ。
-- - provider・connection_id・account_id・scope_id: 候補を作ったときの接続・口座・取得集合。取り直すときに、今の接続の口座・
--   取得集合と同じであることを確かめる（口座の付け替え・取得集合の作り直しでは取り直さず、取得範囲外とする）。
-- - resource・container_id: 予定（calendar）はカレンダーの ID、メール（mail）は空文字（メッセージは口座の中の ID で読む）。
-- - quote_part・quote_start・quote_end: メールの根拠の引用の位置（件名・本文、コードポイント、end は含まない）。抽出の根拠の
--   位置（SourceRef）をそのまま写す。引用そのものは保存しない（取り直した本文から切り出して応答に載せるだけ）。予定と、
--   位置を控えなかったメールは 3 つとも NULL。
-- 行は候補と一緒に消える: 候補の行を消すとき（97 日の掃除・忘却の削除）は外部キーの ON DELETE CASCADE、閉じた候補の題・
-- 抄録を消すとき（7 日の掃除）は trigger で消す。元情報の期限（source_items の 24 時間）では消えない（由来の辺と同じ。U280）。
-- 書いた後は変えない。由来の辺（derivations）がある元情報の行だけを書ける（候補の作成と同じ transaction で、辺の後に書く）。

CREATE TABLE candidate_origin_locations (
  candidate_id TEXT NOT NULL REFERENCES notification_candidates (candidate_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 256),
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  connection_id TEXT NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 256),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 256),
  scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 256),
  resource TEXT NOT NULL CHECK (resource IN ('calendar', 'mail')),
  container_id TEXT NOT NULL CHECK (length(container_id) <= 1024),
  quote_part TEXT CHECK (quote_part IS NULL OR quote_part IN ('subject', 'body')),
  quote_start INTEGER,
  quote_end INTEGER,
  PRIMARY KEY (candidate_id, source_id),
  -- 予定はカレンダーの ID を持ち、メールは持たない。
  CHECK ((resource = 'calendar') = (container_id <> '')),
  -- 引用の位置はメールだけで、3 つそろって持つか、すべて持たない。空の範囲は持たない。
  CHECK (
    (quote_part IS NULL AND quote_start IS NULL AND quote_end IS NULL)
    OR (
      resource = 'mail' AND quote_part IS NOT NULL AND quote_start IS NOT NULL AND quote_end IS NOT NULL
      AND quote_start >= 0 AND quote_end > quote_start
    )
  )
) STRICT;

-- 由来の辺がある元情報の行だけ（候補の由来でない元情報の位置を持たない）。
CREATE TRIGGER candidate_origin_locations_edge_required
BEFORE INSERT ON candidate_origin_locations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM derivations
  WHERE artifact_kind = 'notification_candidate'
    AND artifact_id = NEW.candidate_id
    AND source_kind = 'source_item'
    AND source_id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'candidate_origin_location_edge_missing');
END;

-- 書いた後は変えない（取り直す先を後から付け替えない）。
CREATE TRIGGER candidate_origin_locations_fixed
BEFORE UPDATE ON candidate_origin_locations
BEGIN
  SELECT RAISE(ABORT, 'candidate_origin_location_fixed');
END;

-- 閉じた候補の題・抄録を消すとき（7 日の掃除）に、取り直す先も消す（閉じた候補の根拠は取り直さない）。
CREATE TRIGGER candidate_origin_locations_leave_with_content
AFTER UPDATE OF content_deleted_at ON notification_candidates
FOR EACH ROW
WHEN NEW.content_deleted_at IS NOT NULL
BEGIN
  DELETE FROM candidate_origin_locations WHERE candidate_id = NEW.candidate_id;
END;
