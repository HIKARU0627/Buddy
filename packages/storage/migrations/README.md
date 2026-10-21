# マイグレーション

| ファイル                  | 内容                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `0001_initial.sql`        | 保存案 0001（42 表）。設計 03 データ表・保存期限、08 §5、11 §1A・§4・§5A・§5B。適用順の 1 番目              |
| `0002_data_key_check.sql` | `schema_meta` を作り直し、鍵の照合値 `data_key_check:<key_id>`（16 進 64 桁）を置けるようにする（ADR 0019） |
| `0003_home_network.sql`   | 自宅の登録値（家ごとに 1 つ）と端末ごとの最新の報告。MAC・SSID は HMAC（32 バイト）だけを置く（ADR 0022）   |
| `connection.sql`          | 書込み接続の作成時に実行する PRAGMA。読み戻して一致しなければ外部変更を開始しない                           |

規約（[ADR 0010](../../../docs/adr/0010-domain-boundary-and-storage-draft.md)）:

- すべての表は STRICT。ID は UUID の TEXT、版・世代・epoch は INTEGER、時刻は UTC の Unix ミリ秒。
- 本文・要約・変更内容・宛先は `sealed_blobs` に暗号化して置き、各表は `*_blob_id` で参照する。OAuth トークンは DB に入れない。
- 期限は起点から一度だけ計算して保存し、延長を trigger で拒否する。NULL になり得る列の CHECK は `coalesce` か `IS NOT NULL` で書く。

適用の規則（[ADR 0016](../../../docs/adr/0016-b02-sqlite-connection-and-migrations.md)）:

- ファイル名は `NNNN_名前.sql`（4 桁の版、英小文字・数字・`_`）。版は 1 から欠番なく続ける。
- `applyMigrations` が版ごとに BEGIN IMMEDIATE の transaction を張り、`schema_meta` の `schema_version` と `migration_sha256:NNNN`（内容の SHA-256、改行は LF にそろえる）を同じ transaction で書く。ファイルに COMMIT・ROLLBACK・SAVEPOINT・BEGIN TRANSACTION・VACUUM・ATTACH・journal_mode を書かない。
- 適用済みの版のファイルは変更しない。変更すると内容のハッシュが合わず、DB を開けなくなる。直すときは新しい版を足す。
- DB の版がコードより新しい場合は開かない（ダウングレードしない）。

本番 DB を開発用の試験へ渡しません。制約の期待値は `tests/fixtures/storage-cases.json` に手で書いています。
