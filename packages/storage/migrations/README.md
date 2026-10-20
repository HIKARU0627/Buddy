# マイグレーション案

| ファイル           | 内容                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `0001_initial.sql` | 保存案 0001（42 表）。設計 03 データ表・保存期限、08 §5、11 §1A・§4・§5A・§5B。適用順の 1 番目 |
| `connection.sql`   | 書込み接続の作成時に実行する PRAGMA。読み戻して一致しなければ外部変更を開始しない              |

規約（[ADR 0010](../../../docs/adr/0010-domain-boundary-and-storage-draft.md)）:

- すべての表は STRICT。ID は UUID の TEXT、版・世代・epoch は INTEGER、時刻は UTC の Unix ミリ秒。
- 本文・要約・変更内容・宛先は `sealed_blobs` に暗号化して置き、各表は `*_blob_id` で参照する。OAuth トークンは DB に入れない。
- 期限は起点から一度だけ計算して保存し、延長を trigger で拒否する。NULL になり得る列の CHECK は `coalesce` か `IS NOT NULL` で書く。

案であり、本番 DB へ適用した記録ではありません。本番 DB を開発用の試験へ渡しません。期待値は `tests/fixtures/storage-cases.json` に手で書いています。
