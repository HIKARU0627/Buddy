# ADR 0010: domain 境界と保存マイグレーション案

- 日付: 2026-10-20
- 状態: B00-09（#26）の判断。保存案 0001 は「案」で、本番 DB への適用・DB worker・KeyStore・暗号化処理・削除ジョブは未実装。耐久性（X60）は未検証。
- 根拠: 設計 03（データの分離・保存期限・今回選ぶ会話以外の運用データの扱い・忘却と再取り込み・バックアップ・取り消しと安全停止）、08 §1〜§9、11 §1A・§4・§5A・§5B・§9、02 保存と秘密情報・端末登録と接続、09 §6、決定事項 J12。下の 2 点は本人の回答（2026-10-20、いずれも推奨案）で決定。

## 決めたこと

| 対象                       | 決定                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U17 暗号化の配置           | 暗号文は `sealed_blobs` の 1 表にまとめ、各表は `*_blob_id` で参照する。形式版・key_id・nonce・暗号文・認証タグを別の列にし、所有者の表・ID・版・用途を追加認証データに使う（08 §5）。削除は行を消すだけで済む |
| U18 マイグレーションの検査 | 開発ツールの試験だけで Node 組み込みの `node:sqlite` を使う。製品で使う better-sqlite3 とは SQLite の版が違い得るため、製品の DB での確認は B02 に残す                                                         |

## 保存案 0001 の規約

`packages/storage/migrations/0001_initial.sql`（42 表）と `connection.sql`（接続ごとの PRAGMA）です。

- **表**: すべて STRICT。ID は UUID の TEXT、版・世代・epoch は 0 以上の INTEGER、時刻は UTC の Unix ミリ秒の INTEGER にしました。契約の 10 進文字列・RFC 3339 は境界で変換します（版を SQL の比較と一意制約に使うため。原本に定めのない点の判断）。
- **本文**: 本文・要約・変更内容・宛先・アカウントは `sealed_blobs` に暗号化して置きます。各表には平文の本文の列を作らず（列名の禁止表で検査）、`event_outbox`・`command_receipts`・`forget_ledger`・`intent_shadow`・`sync_staging`・`deliveries` は本文を持ちません。OAuth トークンは OS の KeyStore に置き、DB とバックアップに入れません（`connections.credential_ref`）。記録しない会話は保存しないので、`sessions.storage_mode` に private を置けません。
- **期限**: 期限は起点から一度だけ計算して保存します（`packages/domain/src/retention.ts`）。発言の期限・記憶の見直し日は trigger で延長を拒否し、記憶の見直し日を延ばせるのは見直し待ちからの明示継続だけです（ADR 0008 U14）。期限の定数は SQL の CHECK と domain の値が一致することを試験します。
- **NULL**: SQLite の CHECK は NULL で通るため、NULL になり得る列の比較は `coalesce` か `IS NOT NULL` で書きます（試験で見つけた 2 か所を修正）。
- **耐久性**: WAL・synchronous=FULL・fullfsync は接続ごとの設定なので `connection.sql` に置き、`pragmaReasons` で読み戻します。読み戻しの一致は電源断で記録が残ることの証明ではなく、X60 は未実施です。

## 規則と制約の対応

domain の判定と DB の制約が同じ結論になるようにしました。最終の保証は DB の制約と短い transaction で、domain の判定はその前に理由を示すためのものです。

| 規則                                           | domain                                             | DB の制約・trigger                                                                    | fixture                       |
| ---------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------- |
| 再要求の識別（接続範囲＋request_id）           | `replayDecision`（ADR 0009）                       | `command_receipts` の主キー、`command_id` の一意                                      | X04、storage x04              |
| 内容版ごとの有効な承認は一つ                   | `approvalDecision`（同じ内容なら既存を返す）       | `approvals_one_effective`（valid・consumed で一意）                                   | X02、boundary・storage x02    |
| 操作ごとの実行中の試行は一つ                   | `canTransition`（operations.ts）                   | `operation_attempts_one_active`・`_one_per_approval`、送出意図の CHECK                | storage one-active-attempt    |
| 版照合                                         | `commandGuard`（状態版・依頼版・許可版・忘却世代） | 確定 intent の不変 trigger、`expected_state_revision` は worker 内で照合              | boundary command              |
| 予算の精算は一度だけ・予算月は固定             | `settleReservation`（ADR 0006）                    | `request_id`・`provider_reconciliation_id` の一意、精算の合計 CHECK、予算月の trigger | storage budget                |
| 同期の有効な走査は一つ・watermark は戻さない   | `requestScan`・`publishScan`（ADR 0007）           | `sync_batches_one_active`、`active_scan_id` の一意、watermark の trigger              | QA44、storage qa44・watermark |
| 自動作成は一度だけ                             | `autoCreationReasons`（ADR 0007）                  | `request_entity_operations` の主キー                                                  | X65                           |
| 同じ内容の記憶は一つ・忘却台帳は連続・追記のみ | `memoryAdmission`（ADR 0008）                      | `memories_one_live_content`、`forget_ledger` の連続・追記の trigger                   | X15、X44                      |
| 通知は鍵ごとに一度・本人の再通知だけ別         | `deliveryDecision`・`deliveryAfterAck`             | `deliveries` の (notification_key, reminder_id) 一意                                  | X12                           |
| ペアリングとコードの期限                       | `checkPairingCode`・`tokenPickup`（ADR 0009）      | 有効 5 分の CHECK、一つのペアリングで確定は一つ、接続範囲は 24 時間以内               | storage pairing               |

## transaction の組

`TABLE_POLICIES`（`packages/storage/src/policy.ts`）に表ごとの transaction の組を書きました。主なものは次のとおりです。

- **operation**: 状態の更新・`event_outbox`・`command_receipts` を同じ transaction で書きます（08 §5）。自動実行では `auto_actions`・安全停止の件数も同じ transaction です（08 §3 H02）。
- **sync_publish**: 公開像・watermark／cursor・完了時刻・batch の published・解析計画の無効化・active_scan_id の解放を同じ commit にします（11 §1A）。
- **sync_page**: ページの仮置きと次の page_cursor を同じ短い transaction にします。
- **forget**: 忘却台帳の世代と項目を同じ transaction で追記します。

外部 HTTP は transaction の中で実行せず、送出意図の durable commit の後に一度だけ送ります（08 §3）。

## 読み取り（レビュー対象）

- `sync_batch` の削除は 24 時間にしました（03 の「本文 cache の 24 時間と batch の TTL 内」で、TTL の値がないため）。
- 気づきのキーは、抄録の削除（閉じてから 7 日）からさらに 90 日、つまり閉じてから 97 日で消します（11 §4）。
- 予算の予約・Live の接続は、精算と予算月の締めまで残します（期限の定めがないため）。
- 忘却台帳は DB の表と、03 の「本文なしの別ファイル」の両方で持ちます。別ファイルの世代管理と端末への複製は B06 です。

## 残ること

- DB worker、better-sqlite3 での適用、マイグレーションの適用順の管理、暗号化（AES-256-GCM）と KeyStore、削除ジョブ、バックアップは B02・B06 で実装します。
- 資源の優先度と受付（P0〜P3・provider 枠）、予定重複の判定、参照の再試行上限は、まだ規則にしていません（B01・B08〜B11）。
- 電源断・同時書込み・再起動を含む耐久性の試験（X60・T07）は未実施です。
