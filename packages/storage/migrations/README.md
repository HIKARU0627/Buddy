# マイグレーション

| ファイル                  | 内容                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_initial.sql`        | 保存案 0001（42 表）。設計 03 データ表・保存期限、08 §5、11 §1A・§4・§5A・§5B。適用順の 1 番目                                                                                                           |
| `0002_data_key_check.sql` | `schema_meta` を作り直し、鍵の照合値 `data_key_check:<key_id>`（16 進 64 桁）を置けるようにする（ADR 0019）                                                                                              |
| `0003_home_network.sql`   | 自宅の登録値（家ごとに 1 つ）と端末ごとの最新の報告。MAC・SSID は HMAC（32 バイト）だけを置く（ADR 0022）                                                                                                |
| `0004_turn_responses.sql` | 発言への応答（ID・状態・決まった文の聞き返しだけ）。同じ要求の再送に解釈し直さずに返す。発言と同じ期限（ADR 0029）                                                                                       |
| `0005_runner.sql`         | 試行の状態に superseded（送出意図の前の置き換え）を足すため operation_attempts を作り直す。用事の表 tasks（本文は確定 intent を参照）（ADR 0030）                                                        |
| `0006_budget.sql`         | 予算の予約を作り直し（profile_id・精算の時刻・手での精算の印・M 超過の確認の時刻と、状態の流れ・固定の項目の trigger）、live_sessions も作り直す。超過枠の承認の表と予算月の表（ADR 0036）               |
| `0007_budget_gate.sql`    | 予約の送出意図（`dispatch_intent_at`、一度だけ・送った予約は解放しない）と、本人による予算月の確かめ直し（`budget_month_confirmations`、書き換えない）（ADR 0037）                                       |
| `0008_voice_epochs.sql`   | 端末ごとの音声の世代（io・output・audio・session、戻さない・消さない）と端末単位の停止、来客モード・全体停止（再起動で解除しない）、`live_sessions` の世代の列と制御の状態を戻さない trigger（ADR 0046） |
| `connection.sql`          | 書込み接続の作成時に実行する PRAGMA。読み戻して一致しなければ外部変更を開始しない                                                                                                                        |

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
