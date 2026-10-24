# ADR 0053: B06-06d1 の掃除の job（計画から削除の命令への配線・ゲート・checkpoint／VACUUM・undo_records の掃除）

- 日付: 2026-10-25
- 状態: B06-06d1（Issue #142、親 #11）の判断と実装。`apps/core/src/retention-sweeper.ts`（掃除の job と DB worker への口）、`apps/core/src/core.ts`（起動と停止への組み込み・`CoreHandle.retention`）、`apps/core/src/api-turns.ts`（検索・クラウドへの送信の入口のゲート）、`packages/storage/src/retention-store.ts`（`retention.sweep_rows`・`retention.purge_undo_records`・`retention.checkpoint`・`retention.vacuum`）、`packages/domain/src/retention-sweep.ts`（U96 のそろえ直し）、模擬の試験だけ。B06-06d のうち、復元の適用・印を外す命令・発言・記憶・派生物の削除・知らせの運搬・復帰（スリープ明け）の検知・最終確認時刻の保存は未着手。実機の Mac mini・実際の時計の操作・実データ・実 API は未実施。
- 根拠: 設計 03（保存期限・今回選ぶ会話以外の運用データの扱い・忘却と再取り込み）、ADR 0016（マイグレーションで VACUUM をしない）・0040（J4・J5・secure_delete・隔離の印）・0043（`sweepPlan`・`checkClock`・`startupGate`・`sweepDue`）・0048（予算の月ごとの削除・checkpoint／VACUUM・印の試験）・0051（`retention` の命令・`completed_at`・90 日の削除・引き継ぎ）、#142 の依頼。
- 原本: Notion はこの作業では読めない。ADR 0040・0043・0048・0051 に書かれていない判断は「原本に決めなし（ADR を根拠）」と書き、`docs/b00/contract-map.md` の U104〜U108 に記録した。マイグレーションは足していない（0011 のまま）。

## 決めたこと

| 対象                           | 決定                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 掃除の job                     | Core の `RetentionSweeper`。起動の直後に 1 回と、起動中は `sweepDue` に従って 5 分ごと（`SWEEP_INTERVAL_MS`。ADR 0043 の U55）に、DB を読む → `sweepPlan` → 命令の実行、の順で行う。`sweepDue` を通すので、前回の完了から間隔が過ぎていなければ何もしない                                                                                                                       |
| 時計と最終確認時刻             | `checkClock` の結果を使う。巻き戻っていたら、命令へ渡す now を最終確認の時刻（`effective_now`）にし、期限を延ばさない。予算の記録は `sweepPlan` の `clock_regression` の hold で消さない。次の最終確認時刻は戻さない                                                                                                                                                            |
| 最終確認時刻・epoch の置き場所 | Core のメモリーだけに置く（保存しない）。起動のたびに最終確認時刻は null から始め、`epoch` は起動ごとの `coreInstanceId` にする。保存・復帰（スリープ明け）の検知・epoch の発行は B06-07（ADR 0043 の引き継ぎ）。再起動の直後は前の起動の掃除を数えない（`startupGate` の `sweep_for_other_epoch`）                                                                             |
| 掃除の入力                     | DB worker の `retention.sweep_rows` が返す行は、**操作**（J5 の本文 7 日・レシート 90 日）と**予算の月の組**（J4）だけ。発言・元情報・記憶・派生物は、削除の命令がまだないので入力にしない（B06-06d2。U107）。入力にない行を `sweepPlan` が見ることはないので、計画と命令の結果が食い違わない                                                                                   |
| 実行する命令                   | 本文の削除は `retention.erase_due_bodies`、90 日の削除は `retention.purge_due_operations`、予算の月は `budget.purge_month`、取り消しの記録は `retention.purge_undo_records`。バッチは返る `next` を次の `after` に渡し、null になるまで続ける（毎回先頭から呼ばない）。同じ `next` が返ったら止める                                                                             |
| 期待する保留                   | 命令の拒否のうち、計画の側でも保留にしている理由（`not_due`・`compensation_open`・`month_has_open_rows`・`calendar_invalid`・`task_content_not_migrated`・`unknown_held`・`operation_not_finished`・`completed_at_missing`・`operation_not_found`）は失敗の件数に数えない（ゲートを閉じない）。それ以外の拒否・成否不明・例外は失敗に数え、記録を `failed` にしてゲートを閉じる |
| 掃除の記録とゲート             | 計画の `use_blocked` を `SweepRecord.use_blocked` へ必ず写し、`startupGate` に渡す。済むまでは検索・クラウドへの送信・自動利用を許さない。`CoreHandle.retention` の `gate()`・`record()`・`isRowUsable()` で引ける。実行中も `running` の記録でゲートを閉じる。読み取り・計画が読めないときは `failed` にして閉じる                                                             |
| ゲートの接続先                 | 今ある入口のうち、発言の Read（予定の照会）と RemoteMutation（下書き・ラベル）を `createTurnRoutes` の `retention` でつなぐ（掃除の完了を待ち、閉じていれば `blocked` の聞き返し）。ほかの検索・送信・自動利用は、入口ができたときに `CoreHandle.retention` を通す（U108）                                                                                                      |
| 削除の後の後始末               | 削除を 1 件以上行った掃除の後に `PRAGMA wal_checkpoint(TRUNCATE)` を実行する（`retention.checkpoint`）。VACUUM はマイグレーションの外の job として `retention.vacuum` で実行し、間隔は 1 日（24 時間）にする。原本に決めがないので仮の値（U106）。ADR 0016 のとおりマイグレーションの中では実行しない                                                                           |
| U96 のそろえ直し               | domain の `sweepPlan` を DB worker の側（起点のない行は消さない）に合わせる。完了した操作の `completed_at` が null・読めないときは、本文もレシートも `deadline_unreadable` の hold にして消さない。0011 が適用の時刻で埋めるので、通常の経路ではこの分岐に入らない（復元などの異常な行だけ）。計画と命令（`completed_at_missing`）が食い違わない                                |
| `undo_records` の掃除          | 取り消しの期限（30 日、`RETENTION_RULES.undo_window`。起点は `requested_at`）を過ぎた記録を消す。ただし補償の操作がまだ終わっていない記録は残す（ADR 0040）。補償のない（`compensation_operation_id` が NULL の）記録は 30 日で消す条件を書いたが、**0001 の表はこの列が NOT NULL なので、この版では NULL の行を作れない**（U105）。マイグレーションは足さない                  |
| 隔離の印の試験                 | ADR 0048 の引き継ぎの 3 件を storage の試験に足した。内容版を上げても印が残ること、印の解除と結果の確定を同じ UPDATE で行えること、印の有無によらず承認をすべて失効できること。印を外す命令はまだない（B06-06d）                                                                                                                                                                |

## 実行の順序

1. `retention.sweep_rows`（操作と予算の月）。
2. `sweepPlan`（時計・最終確認時刻・行）。
3. 90 日の削除の計画があれば `retention.purge_undo_records`（補償の記録を先に片付ける）。
4. 本文の削除の計画があれば `retention.erase_due_bodies`、90 日の削除の計画があれば `retention.purge_due_operations` を `next` で繰り返す。
5. 予算の月の計画があれば `budget.purge_month`（月ごとに 1 回）。
6. 削除が 1 件以上あれば `retention.checkpoint`、間隔を過ぎていれば `retention.vacuum`。
7. `SweepRecord` を作り、`startupGate` の結果を `CoreHandle.retention.gate()` に置く。

## 原本に書いてあること（ADR から）

- 03 保存期限: 期限処理は起動時・復帰時に検索やクラウド送信より先に行い、起動中も定期実行する。時計が巻き戻ったら期限を延ばさず、整合するまで自動利用を止める。
- J4: 予算の記録は月ごとにまとめて消し、不明は消さない。J5: 完了から 7 日で本文、90 日でレシート。ADR 0043 の `sweepPlan`・`startupGate` が判定を持つ。
- ADR 0040・0048: `secure_delete` に加えて `wal_checkpoint(TRUNCATE)` と定期の `VACUUM` を、マイグレーションの外の job で行う。

## 原本に決めがない項目

| 項目                                         | この ADR の扱い                                                | 記録 |
| -------------------------------------------- | -------------------------------------------------------------- | ---- |
| 最終確認時刻・epoch の保存と復帰の検知       | この作業ではメモリーだけ。保存と復帰は B06-07                  | U104 |
| 補償のない（NULL の）`undo_records` の作り方 | 0001 の NOT NULL のため作れない。マイグレーションを足さない    | U105 |
| VACUUM の間隔                                | 1 日（24 時間）の仮の値                                        | U106 |
| 掃除の入力に含める行の範囲                   | 操作と予算の月だけ。発言・記憶・派生物は B06-06d2              | U107 |
| ゲートを接続する検索・送信の入口             | 今ある発言の Read・RemoteMutation だけ。ほかは入口ができたとき | U108 |

## 試験（模擬だけ）

期待値は手で書いた。時計と DB worker の口は注入し、実データ・実機は使っていない。

- `apps/core/src/retention-sweeper.test.ts`
  - 起動の直後はゲートが閉じており（`sweep_not_started`）、最初の掃除が済むと開く。
  - 時計が巻き戻ったとき、命令へ渡す now は最終確認の時刻（戻した時刻ではない）。予算の記録は消さず、ゲートは `clock_regression` で閉じたまま。
  - バッチは `next` を次の `after` に渡し、50 件を超える消せない行の後ろ（3 回目）まで届く。
  - 削除の後に checkpoint・VACUUM がこの順で呼ばれる。
  - `undo_records` の掃除が 90 日の削除より先に呼ばれ、止まっていた削除が進む。
- `packages/storage/src/operation-retention.test.ts`
  - `retention.sweep_rows` が操作の状態・`completed_at`・本文の有無・補償の有無を返す（時刻は手書きの UTC）。
  - `retention.purge_undo_records` は 30 日の 1 ms 前と補償が終わっていない記録を残し、補償が終わった記録を消す。その後に 90 日の削除が進む。
  - `retention.checkpoint`・`retention.vacuum` が動き、外部キーと行が保たれる。
  - 隔離の印: 内容版を上げても残る・解除と結果の確定を同じ UPDATE で行える・印の有無によらず承認をすべて失効できる。
- `tests/fixtures/retention-sweep-cases.json`: U96 の期待値を「起点が読めない完了済みの操作は本文もレシートも hold」に直した（`j5-operation-completed-time-unreadable-is-held-and-row-kept`）。

**模擬の期待値だけ**。`tests/test-map.json` の X15・X16・X44 の `product_test` は `not_run` のまま。実 DB の削除・実機の時計の操作・`VACUUM` の実測は B06-06d の残りと B15。

## 引き継ぎ（B06-06d の残り）

- 発言・元情報・記憶・派生物の `delete_row`・`start_review`（`turns`・`source_items`・`memories`・`derivations`）と、`sweep_rows` への追加。知らせ（`notice_drafts`）の運搬は UI-05。
- 復元の適用と `restore_unverified_at` を外す命令。印について、DB は「積極的な証拠か本人の決着だけ」を強制していないので、命令の側で守る。
- 復帰（スリープ明け）の検知・新しい epoch・最終確認時刻の保存（U104）。
- 0010 より前の予算の行の `budget.backfill_delete_at` を、掃除の最初か起動時に月ごとに呼ぶ。
- `undo_records.compensation_operation_id` を NULL 可にするか（U105）。必要なら 0012 のマイグレーションになる（この作業では足していない）。

## 未解決

- U105: 依頼の「補償がない（NULL）記録」は 0001 の NOT NULL のため作れない。この作業は「30 日 + 補償が終わっている（または NULL）」で消す。NULL を作るにはマイグレーションが要る（指示により足していない）。
- U108: ゲートは発言の Read・RemoteMutation だけにつないだ。検索の経路・実行担当の送出・Live の自動利用は、それぞれの入口で `CoreHandle.retention` を通す作業が残る。
- 最終確認時刻・epoch はメモリーだけなので、再起動すると時計の巻き戻りの判定は最初の掃除まで効かない（B06-07）。
