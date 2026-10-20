-- 保存案 0002（B02-04、ADR 0019）。schema_meta に DB を作ったときのデータ鍵の照合値を置けるようにする。
-- 照合値は鍵そのものではなく、鍵から導いた HMAC-SHA256（小文字の 16 進 64 桁）。キーは data_key_check:<key_id>。
-- 0001 の CHECK は変えられないため、同じ列の表を作り直して値を移す。ほかの表は参照していない。
CREATE TABLE schema_meta_0002 (
  key TEXT PRIMARY KEY CHECK (
    key IN ('schema_version', 'store_generation')
    OR key GLOB 'migration_sha256:[0-9][0-9][0-9][0-9]'
    OR (key GLOB 'data_key_check:[A-Za-z0-9]*' AND length(key) <= 143)),
  value TEXT NOT NULL,
  CHECK (key NOT GLOB 'data_key_check:*'
    OR (length(value) = 64 AND value NOT GLOB '*[^0-9a-f]*'))
) STRICT;

INSERT INTO schema_meta_0002 (key, value) SELECT key, value FROM schema_meta;

DROP TABLE schema_meta;

ALTER TABLE schema_meta_0002 RENAME TO schema_meta;
