# ADR 0051: B06-06c の保存（マイグレーション 0011・用事の正本の分離・終わった操作の本文の削除・90 日の削除の順序）

- 日付: 2026-10-25
- 状態: B06-06c（Issue #142、親 #11）の判断と実装。`packages/storage/migrations/0011_operation_body_retention.sql`、`packages/storage/src/retention-store.ts`・`task-content.ts`、`operation-store.ts` の用事の暗号文と本文の削除の検査、`budget-store.ts` の `budget.backfill_delete_at`、`apps/core/src/task-content-migration.ts`（起動時のデータ移行）と `operation-runner.ts` の用事の暗号化、模擬の試験だけ。レビューの P2・P3（子の外部キーの索引・全体のゲートの廃止・`sealed_blobs` の不変・`completed_at` の穴埋め・置き換えの試験）を反映した。B06-06d（`sweepPlan` の実行への配線・知らせ・checkpoint／VACUUM）は未着手。実機の Mac mini・実データは未実施。
- 根拠: 設計 03（保存期限・本人が確定保存したメモ・用事・取り消しと安全停止）、08 §5、ADR 0010・0016・0017・0030・0040（J5 終わった操作の本文の削除）・0043・0047（安全停止の理由）・0048（引き継ぎ・U80）、#11 の本人の判断 J5 と司令塔の判断、#142 の 4 分割の方針。
- 番号: マイグレーションは仮に **0011**（B05-04 が先にマージされたら、司令塔が番号を繰り上げる）。ADR 0040 の「マイグレーション 0008 の案」の J5 の部分を、この版で SQL にした。
- 原本: Notion は読み取りで確かめた（03 の「完了後の本文なし操作レシートは 90 日」など）。外部キーの順序・作り直しの方法・用事の暗号文の形・起動時の移行の細部は **原本に決めなし**（ADR 0040 を根拠に、この ADR の設計判断として `docs/b00/contract-map.md` の U94〜U98 に記録した）。

## マイグレーション 0011 の中身

| 対象                                         | 決定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sealed_blobs.purpose`                       | `task_content`（用事の題名・期限・本文。所有者は `tasks`）を足す。CHECK を変えるため表を作り直す（下の「作り直しの方法」）。書いた暗号文は更新せず（`sealed_blobs_no_update`。0001〜0011 に UPDATE の経路はない）、`INSERT OR REPLACE` でも入れ替えない（`sealed_blobs_no_replace`。主キー・持ち主と用途・鍵と nonce のすべての衝突を見る）                                                                                                                                                                                                                                                                                                        |
| `tasks`                                      | 自分の暗号文の列 `content_blob_id`（`sealed_blobs` を参照・UNIQUE）を足し、`operation_versions` への外部キーを外す。`operation_id` の UNIQUE は残す（同じ操作から用事を二つ作らない最終の保証）。新しい用事は暗号文なしで作れない（`task_content_required`）。暗号文の持ち主は、その用事・版 0・用途 `task_content` でなければならない（`task_content_owner`）。外部キーの代わりに、操作と内容版が `operation_versions` にあることを挿入で確かめる（`task_operation_missing`）。暗号文の列は NULL から値へ一度だけ（`task_content_fixed`）。ID・操作・内容版・作成時刻は変えない（`task_fixed`）。`INSERT OR REPLACE` を拒否する（`task_replace`） |
| `operation_versions`                         | `intent_blob_id` を NULL 可にし、`body_deleted_at` と CHECK `(intent_blob_id IS NULL) = (body_deleted_at IS NOT NULL)` を足す。`content_hash` は NOT NULL のまま（90 日残す hash）                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 不変の trigger                               | `operation_versions_immutable` は、本文を消す更新（`intent_blob_id` が値から NULL、`body_deleted_at` が NULL から値、ほかの列は同じ）だけを許す。内容版・hash・作成時刻の更新、本文の消し直しは引き続き `operation_version_immutable`                                                                                                                                                                                                                                                                                                                                                                                                              |
| 本文を消せる条件（DB の最後の保証）          | 操作が完了（succeeded・not_executed・cancelled・superseded）していること（`operation_body_not_finished`）。暗号文を移していない用事が指す操作でないこと（`task_content_not_migrated`）。内容版の行・操作の行を消せるのも完了した操作だけ（`operation_not_finished`）、移していない用事が指す内容版の行は消せない。**全体のゲートは置かない**（1 件の移せない用事でほかの操作の削除を止めない）                                                                                                                                                                                                                                                     |
| 本文の消えた内容版                           | 承認・試行・試行の `dispatching` への更新・操作の `approved`／`preparing`／`dispatching` への遷移を拒否する（`operation_body_erased`）。本文のない内容版の挿入と、内容版の `INSERT OR REPLACE` も拒否する                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `request_entity_operations`                  | `REFERENCES operations` を外す（UNIQUE と主キーは残す）。0010 の `private_minimal` の 2 つの trigger を作り直す。外部キーの代わりに、挿入と `operation_id` の更新の時点で操作があることを確かめる（`request_entity_operation_missing`）。`INSERT OR REPLACE` を拒否する（`request_entity_operation_fixed`）。操作を 90 日で消した後も、依頼の期限まで残る（再作成の抑止。11 §5A・X65）                                                                                                                                                                                                                                                             |
| `safety_breaker.stop_reason`                 | `restored_from_backup` を足す（ADR 0047。CHECK の作り直し）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `budget_reservations_released_final`（0006） | 例外を 1 つ足す: `delete_at` を NULL から値にし、ほかの列がすべて同じ更新だけを許す。値の正しさ（消してよい状態・作った時刻から 364 日以上）は 0010 の trigger が確かめる。ADR 0048 の U80                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### 作り直しの方法（U95）

0005・0006 の前例は、親の表を作り直すときに子の表も新しい親を指す形で作り直し、子を先に消してから親を消した。`sealed_blobs` は 9 つの表（接続・会話・発言・内容版・元情報・依頼・気づき・記憶・本人の指示）から参照され、その子と孫まで含めるとほぼ全部の表を作り直すことになる。そこで 0011 は次の方法にした。

1. `PRAGMA defer_foreign_keys = ON`（外部キーの検査を transaction の終わりまで遅らせる。COMMIT・ROLLBACK で自動的に戻る）。
2. 親の表の行を写しの表へ写し、親の表を消し、同じ名前・新しい制約で作り直し、同じ行を入れ直して、写しを消す。
3. 子の表は作り直さない（外部キーは名前で親を指す）。

**子の外部キーの列の索引**（レビューの P2）: 親を消すとき、SQLite は子の外部キーを確かめるために子の列を引く。索引がないと親の 1 行ごとに子を全件走査し、適用の時間が件数の二乗で増える。操作・内容版・承認・試行を 6000 件ずつ入れた版 10 の DB で 22.9 秒かかり、8000 件前後で DB worker の起動の期限（30 秒）を超えた。0011 は作り直しの前に、`approvals (operation_id, content_version)`・`operation_attempts (operation_id, content_version)` と、`sealed_blobs` を参照する子の列（`connections.account_blob_id`・`sessions.summary_blob_id`・`request_entities.summary_blob_id`・`notification_candidates.title_blob_id`・`notification_candidates.excerpt_blob_id`・`memories.target_key_blob_id`）に恒久の索引を置く。UNIQUE が自動で作る索引（`turns.text_blob_id`・`source_items.body_blob_id`・`memories.text_blob_id`・`user_directives.text_blob_id`・`operation_versions.intent_blob_id`・`tasks.content_blob_id`）は重ねない。索引は子の表を作り直さないので 0011 の後も残り、90 日の削除と `sealed_blobs` の削除も速くする。試験は 6000 件の版 10 の DB を 10 秒以内に 11 へ移す（CI の遅い実行機でも通る上限）。

親を消したときに数えた違反は、同じ鍵の行を入れ直したときに数え直されて 0 に戻る。1 行でも入れ直さなければ、適用側の `PRAGMA foreign_key_check` と COMMIT が拒否し、版は進まない（試験 `a re-created parent row that is missing is caught` で、`sealed_blobs` の 1 行を落とした写しが適用されないことを確かめた）。`ALTER TABLE ... RENAME` は子の外部キーの参照先を書き換えるので、親の作り直しには使わない（0005 の「改名では数え直されない」と同じ理由）。`operation_versions` も同じ方法にした（承認・試行・工程を作り直さないので、0010 の trigger を落とす心配がない）。子のない `tasks` は 0005 と同じく作り直して改名し、0010 の trigger が名前で読む `request_entity_operations` は改名せずに写して作り直した（改名は schema 全体の参照を確かめ直すため）。

**司令塔の指示との違い**: 指示は「子の表（approvals・operation_attempts・tasks）を先に作り直し、0006 の前例どおりに値を移す」だった。上の理由で `sealed_blobs` には前例の方法を使えず、`operation_versions` も同じ方法にそろえた。判断を求める（「判断が要る点」）。

`scripts/storage.test.mjs`（Node 組み込みの SQLite で全版を適用する開発ツールの試験）は、これまで自動コミットで適用していた。製品の `applyMigrations` と同じく版ごとに 1 つの transaction で適用するように直した（自動コミットでは外部キーの検査を遅らせられない）。

## 用事の正本の分離（ADR 0040 の正式な案を採った）

見積もりの結果、`sealed_blobs` の作り直しは上の方法で 1 版に収まったので、ADR 0040 の代案（用事のある操作を J5 の対象から除く）は使わない。

- **新しい用事**: Core の実行担当（`operation-runner.ts` の `runLocal`）が確定 intent から題名・期限・本文を取り出し（`taskContentFromIntent`）、用事を所有者にして暗号化し（`sealTaskContent`）、書く前に復号して同じ内容に戻ることを確かめてから `operation.apply_local` に渡す（`content`）。DB worker は用事の行と暗号文を同じ transaction で書く。
- **平文の形**（U98）: `{"schema":"buddy.task_content.v1","title":…,"due":…,"body":…}` の固定の順の JSON。ワイヤ契約ではなく DB の中の暗号文の中身なので、`task-content.ts` だけが決める。題名は 1 文字以上、期限・本文は 1 文字以上か null（`TaskOperationIntent` の `action` と同じ）。孤立したサロゲートは拒否する。ワイヤの入力は `parseStrictJson`（RFC 8785 の正規化の前）が拒否するので境界は同じだが、JSON Schema の `minLength` だけを見る Ajv は通す。平文を UTF-8 の暗号文にすると Buffer が U+FFFD に置き換えて内容が変わるため、Schema の `minLength` だけには合わせない（試験とコメントに残した）。内容を編集する命令はまだない（暗号文の列は一度だけ）。
- **起動時のデータ移行**（`apps/core/src/task-content-migration.ts`）: 0010 までの用事は暗号文を持たない。追加認証データ（所有者の表・ID・版・用途。ADR 0017）が変わるので SQL では写せない。Core は DB worker の起動（マイグレーションの適用）と起動時の回復の後、次の順で 1 件ずつ移す。
  1. 確定 intent を復号し、保存した `content_hash` と照合して（`openOperationIntent`）、用事の内容だけを取り出す。
  2. 用事を所有者にして暗号化し、まだ結び付けずに書く（`task.stage_content`）。
  3. 書いた暗号文を DB から読み戻して復号し、1 の内容と一致することを確かめる。
  4. 一致したら用事に結び付ける（`task.link_content`。0011 の trigger が所有者・用途を照合する）。合わなければ書いた暗号文を消し（`task.discard_staged`）、その用事は移さずに残す。
  - 途中で落ちたとき: 書いて結び付ける前の暗号文は次の起動の `task.migration_next` に出てくる。読み戻して合えば結び付け、合わなければ消して書き直す（試験で、結び付けの成否不明で止めた後と、別の内容の暗号文が残っていた後に、次の起動で整合することを確かめた）。
  - 確定 intent を開けない用事（鍵の取り違え・破損）は移さずに残し、Core の起動は止めない（用事も本文も残るので失うものはない）。ログに件数だけを書く。成否不明・worker が使えないときは起動を拒否する（`store_recovery_failed`、理由 `task_content_migration_failed`）。
- **移せない用事の扱い**（U94）: 暗号文を持たない用事が 1 件でもある間も、DB worker は全体のゲートを置かず、本文の削除・90 日の削除を進める。移せない用事がある操作だけを、操作ごとの `taskNotMigrated` と 0011 の trigger（`task_content_not_migrated`）で残す。1 件の移せない用事でほかの全操作の削除が止まることを避ける（司令塔の判断）。移せない用事を本人が決着する命令と、本人への通知は B06-06d で作る。

**司令塔の指示との違い**（U94）: 指示と ADR 0040 は「移行の後で `tasks` の外部キーを外す」順序だった。マイグレーションは Core の起動の前に DB worker がまとめて適用し、暗号化し直しは鍵を持つ Core main にしかできないので、この順にするには適用の途中に Core のデータ移行の段を入れる仕組み（2 つの版の間で止める）が要る。0011 は外部キーを先に外し、代わりに本文と内容版の行を直接守る trigger と操作ごとの判定を置いた。外部キーは内容版の**行**を指すだけで、本文（暗号文）の削除は止めていなかったので、守る範囲は外部キーより広い。全体のゲートを置かないことはレビューで司令塔が決めた。

## 本文の削除と 90 日の削除（DB worker の命令）

新しい命令の組 `retention`（`executeRetentionOp`、DB worker のメッセージ `retention`、`DbWorkerClient.retention`）。

| 命令                                                                                                 | 内容                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retention.erase_body`                                                                               | 1 つの操作の、すべての内容版の確定 intent の暗号文を消す。内容版ごとに `intent_blob_id` を NULL・`body_deleted_at` を今にしてから（同じ transaction で）暗号文の行を消す。hash・行は残す。消す内容版がなければ 0 件（何度呼んでも同じ） |
| `retention.purge_operation`                                                                          | 1 つの操作のレシートを `OPERATION_PURGE_STEPS` の順（下）に、1 つの transaction で消す。既に消えていれば `purged: false`                                                                                                                |
| `retention.erase_due_bodies`・`retention.purge_due_operations`                                       | 期限の来た操作を完了の古い順に最大 50 件、**1 件ずつ別の transaction で**処理する。続きの位置（完了の時刻・操作 ID）で再開できる。拒否された操作は理由と一緒に飛ばして続け、成否不明・想定外の失敗・競合では止める                      |
| `retention.gate`                                                                                     | 暗号文を移していない用事の件数                                                                                                                                                                                                          |
| `task.read`・`task.migration_next`・`task.stage_content`・`task.link_content`・`task.discard_staged` | 用事の暗号文の読み出しと、起動時のデータ移行                                                                                                                                                                                            |

共通の前提: 操作が完了していること（`unknown_held` は `unknown_held`、進行中は `operation_not_finished`）。`completed_at` が記録されていること（なければ `completed_at_missing`。下の U96）。期限（本文は完了から 7 日、レシートは 90 日。`RETENTION_RULES` の `operation_body`・`operation_receipt`）が来ていること（`not_due`）。時刻は呼び出し側の `now` を信じる（DB は時計を持たない）。B06-06d で必ず `sweepPlan`（時計の巻き戻しの保留）を通してから呼ぶ（`budget.purge_month` と同じ）。

バッチ（`retention.erase_due_bodies`・`retention.purge_due_operations`）は、結果の `next`（最後に処理した完了の時刻と操作 ID）を次の `after` に渡して続きを呼ぶ。毎回 `after = null` から呼ぶと、1 回の上限（50 件）より後ろに届かない。`next` が null になるまで繰り返す。

### 90 日の削除の順序（ADR 0040 の 7 つの手順）

| 手順 | 消す行                                                                                      | 理由                                  |
| ---- | ------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1    | `undo_records`（`operation_id = X` か `compensation_operation_id = X`）                     | `auto_actions` と補償の操作を参照する |
| 2    | `auto_actions`（`operation_id = X`）                                                        | 1 が参照している                      |
| 3    | `operation_steps`（X の試行の）                                                             | 4 を参照する                          |
| 4    | `operation_attempts`（`operation_id = X`）                                                  | 5 と 6 を参照する                     |
| 5    | `approvals`（`operation_id = X`）                                                           | 6 を参照する                          |
| 6    | `operation_versions`（`operation_id = X`）、続けて確定 intent の暗号文（持ち主が X のもの） | 内容版の行が暗号文を参照する          |
| 7    | `operations`（`operation_id = X`）                                                          | 2・4・6 が参照する                    |

- 取り消しの相手の補償の操作（`undo_records.compensation_operation_id`）が完了していない間は、X を消さない（`compensation_open`）。補償の操作そのものは、完了から 90 日で同じ順に消せる（取り消しの記録は手順 1 で先に消える）。
- 補償の操作がない（`compensation_operation_id` が NULL の）取り消しの記録があると、`compensation_open` で X の 90 日の削除が止まり続ける。B06-06d で、取り消しの期限（30 日）の後に `undo_records` を消す掃除をつなぐ（レビューで ADR に残すことになった）。
- `tasks` と `request_entity_operations` は 0011 で操作を参照しなくなったので消さない（用事は本人の削除、結び付けは依頼の期限）。
- 試験は、`tasks`・`request_entity_operations`・`auto_actions`・`undo_records`・承認・試行・工程の行をすべて持つ DB で、この順が外部キーの違反なしに通ることと、互いに参照する隣どうしの手順を入れ替えると外部キーの違反で失敗することを確かめた（`auto_actions` と `operation_steps` は互いに参照しないので、入れ替えても通る。手で書いた期待値）。

### 旧内容版の本文と `proposal`・`request_summary`（U97）

- 内容が変わった旧い内容版の本文は、その操作が完了するまで残す（ADR 0040 の案どおり）。完了の後は、すべての内容版の本文を一緒に消す。
- ADR 0040 は同じ依頼の `proposal`・`request_summary` の暗号文も 7 日で消すとした。どちらもまだどの処理も書いていないので、この命令は消さない。書く処理を作るときに、本文の削除へ足す（未解決）。

### 完了の時刻（U96）

ADR 0040 は完了を succeeded・not_executed・cancelled・superseded とし、起点を `completed_at` とした。0001〜0010 の保存（`advance`）は succeeded・cancelled でだけ `completed_at` を書いていた。0011 から、4 つの完了の状態に入った時刻を書き、本人の再試行（not_executed → preparing）などで完了でない状態へ戻れば NULL に戻す。0011 より前に未実行（not_executed）・superseded で終わった操作は `completed_at` が NULL のままで、そのままだと本文が永久に残る。0011 は適用の時刻を起点として、4 つの完了の状態で NULL の行を埋める（`UPDATE operations SET completed_at = … WHERE state IN (…) AND completed_at IS NULL`）。実際の完了より後になるので、早く消しすぎる側には倒れない。succeeded・cancelled で NULL の行は 0001〜0010 の経路では作られないが、復元などの異常な行も同じ扱いにした。domain の `sweepPlan` は起点の読めない完了済みの本文を「消す側」に倒すが、DB worker の最後の保証は閉じる側にした。B06-06d でつなぐときに、どちらに合わせるかを決める。

## 本文を消した後にできること・できないこと

- **できる**: 同じ命令の再送（`command_receipts` で保存済みの結果を返す）。承認の照合（承認の `content_hash` と内容版の hash は残る）。結果の表示（`readOperation`・`operation_view`。`readOperation` は今の内容版の `body_erased` も返す）。用事の内容の読み出し（用事の暗号文は別）。
- **できない**: 本文の消えた内容版からの承認・準備・送出意図・LocalCommand の適用（`operation_body_erased`。DB の trigger も拒否する）。preview・送出の材料の読み出し（`operation.intent` は null を返す）。

## 0010 より前の予算の行（ADR 0048 の U80）

`budget.backfill_delete_at`（予算月ごと）: その月の行のうち、消してよい状態（`budgetReservationDeletable`）で `delete_at` が NULL の行に、予算月の記録から求めた期限（`budgetRecordDeleteAt`。精算・解放・確認のときと同じ）を書く。月の記録がなければ書かない（`calendar_invalid`。推測の時刻を入れない）。消してよい状態でない行は NULL のまま残す（精算・確認の命令が書く）。解放済みの行は 0011 の `released_final` の例外で書け、ほかの列と 2 回目の書き換えは引き続き拒否する。

## 試験（模擬だけ）

`packages/storage/src/operation-retention.test.ts`（14 件）、`packages/storage/src/task-content.test.ts`（2 件）、`apps/core/src/task-content-migration.test.ts`（2 件。実際の AES-256-GCM で暗号化・復号する）、`tests/fixtures/storage-cases.json` のシナリオ `0011-operation-body-erase-task-content-and-safety-reason`・`0011-replace-update-and-delete-guards` ほか（better-sqlite3 と Node 組み込みの SQLite の両方）、既存の試験の版・表の期待値の更新。期待値は手で書いた（期限は `DONE + 7 * DAY` の形で、`RETENTION_RULES` を呼んでいない。予算の期限は 2031-12-01 を手で計算した）。

- 版 10 の DB を 11 へ移せる。行がすべて残り、古い用事は暗号文なし・内容版は本文ありのまま、`tasks`・`request_entity_operations` は操作を参照しない。外部キーと `integrity_check` が通る。移していない用事がある操作（op-1）だけが `task_content_not_migrated` で残り、ほかの操作（op-2）の本文の削除と 90 日の削除は進む。バッチも移せない操作を飛ばして続ける。直接の UPDATE・DELETE は trigger で拒否される。
- 版 10 の DB に操作・内容版・承認・試行と `sealed_blobs` の子を 6000 件ずつ入れ、0011 を 10 秒以内に適用できる（索引のない版は 22.9 秒。CI の遅い実行機でも通る上限）。`completed_at` が NULL の not_executed・superseded・異常な succeeded・cancelled は適用の時刻で埋まり、既に値のある行は変わらない。
- 作り直しで親の 1 行を落とした 0011 は適用されず、版は 10 のまま。正しい 0011 はその後に適用できる。
- 置き換え・変更の拒否: `tasks` の `INSERT OR REPLACE`（ID・操作・暗号文の 3 つの衝突）、`operation_versions` の `INSERT OR REPLACE`（主キー・暗号文）、`request_entity_operations` の `INSERT OR REPLACE`（主キー・操作）と操作の差し替えの不存在、`operations` の `INSERT OR REPLACE`、`sealed_blobs` の `INSERT OR REPLACE`・更新、`task_fixed`（ID・操作・内容版・作成時刻）、完了していない操作の削除（`operations_delete_finished`）を拒否する。`tasks` の操作と内容版の不存在（`task_operation_missing`）も拒否する。平文は孤立したサロゲートを拒否する（ワイヤの `parseStrictJson` と同じ境界）。
- 本文の削除: 7 日の 1 ms 前は `not_due`。消した後も hash・承認・試行・表示が残り、同じ命令の再送は保存済みの結果を返し、確定 intent の読み出しは null。本文の消えた内容版への本人の再試行は `operation_body_erased`、DB の試行の挿入・遷移も拒否。再試行で `completed_at` が NULL に戻り、進行中・`unknown_held` の操作は消さない。
- 用事: LocalCommand の適用で用事が自分の暗号文（用途・所有者・版）を持つ。操作の本文を消した後も、90 日の削除の後も、用事の暗号文は同じまま読める。
- 90 日の削除: 7 種類の行をすべて消し、用事と依頼の結び付けは残る。補償の操作が終わっていない間は `compensation_open`。手順の入れ替え（隣どうし 6 通りと手順 6 の中）。
- 小さな transaction と再開: 3 件の期限の来た操作を 2 件ずつ処理し、3 件目の COMMIT の前で故障を入れると書込みを止めて何も消さず、続きの位置から呼び直すと残りを消す。最初から呼び直しても消した操作は選ばない。90 日のバッチは補償の終わっていない操作を飛ばして続ける。
- 起動時のデータ移行（実際の暗号）: 移せる用事は題名・期限・本文が手書きの値と一致し、確定 intent を開けない用事は `authentication_failed` で残る。移せた用事の操作の本文は消せて、移せない用事の操作だけが `task_content_not_migrated` で残る。結び付けの成否不明で止めた後、別の内容の暗号文が残っていた後も、次の起動で整合し、暗号文は 1 つだけ。移行の後に操作の本文を消しても用事の内容は読める。
- 予算の backfill: 解放済みの行だけが 2031-12-01 を得て、予約中の行は NULL のまま。2 回目は何もしない。解放済みの行のほかの列・2 回目の書き換えは拒否。月の記録がなければ `calendar_invalid`。
- 安全停止の理由 `restored_from_backup` を受け付け、知らない理由は CHECK で拒否する。

**模擬の期待値だけ**。`tests/test-map.json` の X15・X16・X17・X44 の `product_test` は `not_run` のまま（storage の試験の合格を製品試験の合格として扱わない）。実際の Core の起動での移行（実データ・実鍵）・実機は未実施。

## 判断が要る点

1. **外部キーを外す時点**（U94）: 指示の順序（移行の後に外す）ではなく、0011 で先に外し、trigger と操作ごとの判定で本文と内容版の行を守った。指示どおりにするなら、マイグレーションの適用の途中に Core のデータ移行の段を入れる仕組みが要る。全体のゲートを置かないことはレビューで司令塔が決めた。
2. **表の作り直しの方法**（U95）: 子の表を作り直す前例ではなく、外部キーの検査を遅らせて親を同じ名前で作り直した。`sealed_blobs` では前例の方法が使えない（ほぼ全表の作り直しになる）ため。子の外部キーの索引はこの方法の前提（上の「作り直しの方法」）。
3. **`completed_at` の意味**（U96）: 未実行・superseded でも書き、完了でない状態へ戻れば NULL に戻す。0011 より前の NULL は適用の時刻で埋める（早く消しすぎない側）。domain の `sweepPlan`（起点が読めなければ消す）と DB worker（起点がなければ消さない）の食い違いは B06-06d で決める。

## 引き継ぎ（B06-06d）

- `sweepPlan` の `erase_body`・`delete_row`（`operation_receipt`）を `retention.erase_due_bodies`・`retention.purge_due_operations`（または 1 件ずつの命令）へつなぐ。`now` は `sweepPlan` の判定（時計の巻き戻しの保留）を通してから渡す。バッチの `next` を次の `after` に渡し、null になるまで続ける。`task_depends` は 0011 の後は常に false（移せない用事の操作は 0011 の trigger と操作ごとの判定が残す）。
- 移せない用事を本人が決着する命令と、本人への知らせ（UI-05）を作る。全体のゲートは置かないので、移せない用事の操作だけが残る。
- 補償の操作がない（`compensation_operation_id` が NULL の）`undo_records` を、取り消しの期限（30 日）の後に消す掃除をつなぐ（上の 90 日の削除）。
- 本文の削除・90 日の削除の後の `PRAGMA wal_checkpoint(TRUNCATE)` と定期の `VACUUM`（ADR 0048 から引き継ぎ）。
- `derivations` の `operation_content` の辺は、本文の削除・90 日の削除で消していない（系譜の書き込みがまだない。ADR 0048）。
- `proposal`・`request_summary` の暗号文を書く処理を作るときに、本文の削除へ足す（U97）。
- 0010 より前の予算の行は `budget.backfill_delete_at` を月ごとに呼ぶ（`sweepPlan` の配線と一緒に、起動時か掃除の最初に）。
- 用事の削除（本人の削除操作）と内容の編集の命令は、まだない（`tasks_content_fixed` を決め直す）。

## 未解決

- U94・U96 はレビューと司令塔の判断で決めた（全体のゲートを外す・`completed_at` を 0011 で埋める）。U95 の作り直しの方法は引き続き判断を求める（上の「判断が要る点」）。
- 起動時の移行は、確定 intent を開けない用事を残すだけで、本人に見せる経路がない（B06-06d・UI-05）。移せない用事を決着する命令もまだない。
- 本文の削除・90 日の削除は `now` を信じる。時計の巻き戻しの判定は B06-06d。
- 実データ・実鍵での移行と、Mac mini の実機は未実施（B15）。
