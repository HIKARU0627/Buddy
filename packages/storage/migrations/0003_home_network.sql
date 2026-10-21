-- 保存案 0003（B03-03、ADR 0022）。自宅の登録値と、端末ごとの最新の自宅の指紋の報告を置く。
-- MAC と SSID は平文を置かず、データ鍵から導いた鍵の HMAC-SHA256（32 バイト）だけを置く。
-- サブネットは Tailscale の直接のアドレスと比べるため、正準の IPv4 の CIDR の平文で置く。
-- 自宅は家ごとに 1 つ（初期版は自宅だけ）。登録し直すと置き換える。
CREATE TABLE home_networks (
  home_id INTEGER PRIMARY KEY CHECK (home_id = 1),
  gateway_mac_hmac BLOB NOT NULL CHECK (length(gateway_mac_hmac) = 32),
  subnet TEXT NOT NULL CHECK (length(subnet) BETWEEN 9 AND 18 AND subnet GLOB '*/*'),
  ssid_hmac BLOB CHECK (ssid_hmac IS NULL OR length(ssid_hmac) = 32),
  registered_at INTEGER NOT NULL,
  registered_by_device_id TEXT NOT NULL REFERENCES devices (device_id)
) STRICT;

-- 端末ごとの最新の報告だけを置く（受け取るたびに置き換える）。received_at は中枢の時計。
CREATE TABLE home_network_reports (
  device_id TEXT PRIMARY KEY REFERENCES devices (device_id),
  gateway_mac_hmac BLOB CHECK (gateway_mac_hmac IS NULL OR length(gateway_mac_hmac) = 32),
  subnet TEXT CHECK (subnet IS NULL OR (length(subnet) BETWEEN 9 AND 18 AND subnet GLOB '*/*')),
  ssid_hmac BLOB CHECK (ssid_hmac IS NULL OR length(ssid_hmac) = 32),
  received_at INTEGER NOT NULL
) STRICT;
