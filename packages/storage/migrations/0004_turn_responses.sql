-- 保存案 0004（B04-03、ADR 0029）。発言への応答を、発言・依頼・操作と同じ transaction で記録する。
-- 同じ接続範囲・request_id の再送には、解釈し直さずにこの応答を返す（07 §3）。
-- 応答は ID・状態・決まった文の聞き返しだけ（契約の TurnResponse）で、発言の本文・対象の本文・宛先を含めない。
-- 発言と同じ期限で消す（delete_at は発言の expires_at と同じ値を Core が渡す）。
CREATE TABLE turn_responses (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id),
  response_json TEXT NOT NULL CHECK (json_valid(response_json) AND length(response_json) <= 16384),
  created_at INTEGER NOT NULL,
  delete_at INTEGER NOT NULL CHECK (delete_at > created_at)
) STRICT;
CREATE INDEX turn_responses_delete_at ON turn_responses (delete_at);
