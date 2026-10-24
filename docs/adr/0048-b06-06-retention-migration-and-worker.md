# ADR 0048: B06-06a・b の保存（マイグレーション 0010・予算の記録の月ごとの削除・secure_delete・派生物の系譜・操作の記録の印）

- 日付: 2026-10-24
- 状態: B06-06a・b（Issue #142、親 #11）の判断と実装。`packages/storage/migrations/0010_retention.sql`、`packages/storage/migrations/connection.sql` の `PRAGMA secure_delete = ON`、`packages/storage/src/budget-store.ts` の `budget.purge_month` と精算・解放・確認の `delete_at`、`packages/storage/src/derivation-store.ts`、`packages/storage/src/policy.ts`、模擬の試験だけ。B06-06c（J5 の本文の削除・90 日の削除・用事の正本の分離）と B06-06d（`sweepPlan` の実行への配線・復元の適用・印を外す命令・checkpoint／VACUUM の実行）は未着手。実機の Mac mini・実際のバックアップからの復元・実データは未実施。
- 根拠: 設計 03（保存期限・今回選ぶ会話以外の運用データの扱い・忘却と再取り込み・バックアップ・復元・記録しない会話の境界）、08 §4〜§6、09（X15・X16・X17・X44・X59）、ADR 0008・0010・0016・0036・0040・0043・0044・0045、PR #148 の Codex のレビュー（P1 3 件・P2 3 件。ADR 0040 に反映済み）、#142 の依頼。
- 番号: ADR 0040 は計画の名前として「マイグレーション 0008 の案」と書いた。実際には 0008（B07-07、ADR 0042）と 0009（B05-03、ADR 0046）が先にマージされたため、この作業は **0010** を使う。0008・0009 は変えない。ADR 0040 の中身と判断は変えていない（番号と、SQL を書くときに決めた細部だけ）。
- 原本: Notion はこの作業では読めない。ADR 0040 に書かれていない判断は「原本に決めなし（ADR 0040 を根拠）」と書いた。ADR 0040 が「原本に決めなし」とした点を、この ADR で設計判断として閉じたものは `docs/b00/contract-map.md` の U79〜U83 に記録した。

## マイグレーション 0010 の中身

1 版にまとめた。0001〜0009 は変えていない。

| 対象                                  | 決定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 予算の記録の削除（J4）                | `budget_reservations.delete_at`（NULL 可の UTC ミリ秒）を足す。`BEFORE DELETE` の trigger で、`delete_at` が NULL の行の削除を拒否する（`budget_delete_at_missing`）。予算月の締めから 13 か月後の値は `budgetRecordDeleteAt` で求め、精算・解放・M 超過の確認の UPDATE と同じ文で書く                                                                                                                                                                                                                                     |
| `delete_at` を書ける条件              | `BEFORE INSERT`・`BEFORE UPDATE OF delete_at` の trigger で、`released`、または `settled` で M 超過の確認が済んでいる（`overrun_reviewed = 1`）か実費が M 以内の行だけに限る。値は作った時刻（`created_at`）から 364 日以上先に限る（月の締めから 13 か月後は、どの月でも 395 日以上ある）。一度書いた値は変えられず、NULL に戻せない（`budget_delete_at_invalid`）。DB の最終ガードを `BEFORE DELETE` だけに置くと、消してはいけない行に `delete_at` を書いてから消せてしまうため（ADR 0040 の「最後の保証は DB」の読み） |
| `INSERT OR REPLACE` の拒否            | 予約は `reservation_id`・`request_id`・`provider_reconciliation_id` のどれかが既存の行と衝突したら、挿入の前に拒否する（`budget_reservation_replace`）。操作は同じ `operation_id` があれば拒否する（`operation_replace`）。`recursive_triggers` が 0 なので、REPLACE の暗黙の削除は `BEFORE DELETE` の trigger を通らない（0008・0009 と同じ書き方）                                                                                                                                                                       |
| 予算の記録の月ごとの削除              | DB worker の `budget.purge_month`（下の「予算の記録の月ごとの削除」）                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| secure_delete                         | `connection.sql` に `PRAGMA secure_delete = ON` を足し、`ObservedPragmas`・`pragmaReasons`・`readConnectionPragmas` の読み戻しに `secure_delete` を足す。OFF なら `secure_delete_off` で接続を拒否する                                                                                                                                                                                                                                                                                                                     |
| 派生物の系譜                          | 表 `derivations`（`artifact_kind`・`artifact_id`・`source_kind`・`source_id`・`created_at`）。`artifact_kind` は `turn`・`memory` と domain の `FORGET_ARTIFACT_KINDS` の 9 種類、`source_kind` はそれに `source_item` を足したものに CHECK で限る。同じ組の UNIQUE と、由来から引く索引 `derivations_by_source`。自分自身を由来にする辺は CHECK で拒否し、`UPDATE` と `INSERT OR REPLACE` も拒否する（`derivation_fixed`）。削除は忘却で使うので許す。書き込み・読み出しは `derivation-store.ts`                          |
| 記録しない会話の最小の操作記録（U42） | `operations.record_kind`（`normal`・`private_minimal`、既定 `normal`）。`private_minimal` の行は `workflow_id` を持てず（INSERT・UPDATE の trigger、`operation_private_minimal_workflow`）、`normal` へ戻せない（`operation_record_kind_fixed`）。`private_minimal` の操作は `request_entity_operations` に結び付けられない（`operation_private_minimal_request_entity`）                                                                                                                                                  |
| 復元の後の未確認の印（J3）            | `operations.restore_unverified_at`（NULL 可）。印を付けられるのは `effect_route = 'remote_mutation'` の操作だけ（`operation_restore_unverified_route`）。NULL でない操作は、承認の作成・`approved`／`preparing`／`dispatching` への遷移・試行の作成と `dispatching` への更新を trigger で拒否する（`operation_restore_unverified`）。印を外す（NULL に戻す）更新は拒否しない（後の作業の命令が行う）                                                                                                                       |

### 予算の記録の月ごとの削除（`budget.purge_month`）

ADR 0040 の J4 と司令塔の判断（月ごとにまとめて消す。使用額が部分的に少なく見えるのを防ぐ）を、DB worker の 1 つの命令にした。書込みは 1 つの `BEGIN IMMEDIATE` の transaction で行う。

- **入力**: 予算月と、今の時刻。タイムゾーンは受け取らず、`budget_months` のその月の記録を使う（呼び出し側が別の値を渡して期限を動かせない）。
- **前提**: その月の `budget_months` の記録があり、`budgetRecordDeleteAt` が求められること（`calendar_invalid`）。今がその月の締めから 13 か月後以降であること（`not_due`）。
- **今の時刻**: 呼び出し側が渡す `now` をそのまま信じる（DB は時計を持たない）。時計の巻き戻しの保留は `sweepPlan` が判定するので、B06-06d では必ずその判定を通してからこの命令を呼ぶ。
- **消してよい行**: domain の `budgetReservationDeletable` で全行をもう一度確かめる。1 行でも `reserved`・`usage_unknown`・M 超過の確認待ち・実費が読めない行があれば、何も消さずに `month_has_open_rows` で拒否する（ADR 0040・0043 と同じ規則。`delete_at` が書かれていても状態を信用しない）。
- **期限**: 全行の `delete_at` が NULL でなく、今以前であること。1 行でも未来・未設定なら `not_due` で何も消さない。0010 より前からある行は `delete_at` が NULL なので、この命令では消えない（下の「引き継ぎ」）。
- **外部キーの順序**: `live_sessions`（`reservation_id` で予約を参照）→ `budget_overage_approvals`（`consumed_reservation_id` で予約を参照。同じ月の使用済みの承認と、使われなかった `pending`・`rejected`・`expired` で期限の来たもの）→ `budget_reservations`。どの時点でも外部キーの違反を作らない（ADR 0040）。`budget_reservations.approval_id` には外部キーがないので、承認を先に消してよい。
- **消さないもの**: `budget_months`・`budget_month_confirmations`（追記だけの記録）、`budget_credit_observations`（採用した残高の観測）。予約の `credit_*` の列は行と一緒に消えるが、ほかの表を参照していないので外部キーの違反にならない（0008 の観測は予約を参照しない）。クレジットの割り当ては、周期が 13 か月を超えない前提（超える周期では、消した予約の分を台帳から引けなくなる）。
- **返す値**: 消した `live_sessions`・承認・予約の件数だけ。金額・ID・本文は返さない。
- **`approved` の扱い**: ADR 0040 は使われなかった承認を `pending`・`rejected`・`expired` と列挙している。`approved`（使う前）は期限が来ていても消さず、`expires_at <= now` の `pending` だけを消す。13 か月後の月では期限が来ているのが普通で、期限の来ていない `pending`・`approved` は消さない（生きている承認を消さない側）。原本に決めなし（ADR 0040 を根拠）。U81。

### `delete_at` を書く場所（budget-store）

- **精算**（`budget.settle`・`budget.settle_manual`）: 実費が M 以内なら、精算の UPDATE と同じ文で `delete_at` を書く。M を超えたら書かない（確認待ち）。
- **解放**（`budget.release_unsent`）: `status = 'released'` と同じ UPDATE で書く。解放済みの行は変えられない trigger があるため、別の UPDATE にしない。
- **M 超過の確認**（`budget.review_overrun`）: `overrun_reviewed = 1` と同じ UPDATE で `coalesce(delete_at, ?)` を書く。0010 より前からある確認済みの行も、この命令の再適用で `delete_at` を得る（`delete_at` が NULL の行だけを更新する）。
- 予算月の記録がない・タイムゾーンが求められないときは `delete_at` を書かない（推測の時刻を入れない。ADR 0010 の「期限は起点から一度だけ計算して保存」）。その行は削除されず、`budget.purge_month` は `calendar_invalid` か `not_due` で止まる（安全側）。

## secure_delete

`PRAGMA secure_delete = ON` は、消した行の内容を空きページで上書きする。暗号文なので鍵がなければ読めないが、忘却・期限で消したことを「消した」と言えるようにする（ADR 0040）。接続の作成のたびに設定し、`pragmaReasons` で読み戻す（ADR 0016 のほかの PRAGMA と同じ）。OFF の接続では書込みを始めない。

- `PRAGMA wal_checkpoint(TRUNCATE)` と一定の間隔の `VACUUM` は、マイグレーションの外の実行時の job（ADR 0016 はマイグレーションでの VACUUM を禁じている）。B06-06d で `sweepPlan` の実行に足す。この ADR では実行しない。
- SSD の痕跡消去までは保証しない（設計 03）。原本に決めなし（ADR 0040 を根拠）。U79。

## 派生物の系譜（`derivations`）

ADR 0040 U47・ADR 0044 の `planForget` が使う辺を、そのまま表にした。

- **列**: `artifact_kind`・`artifact_id`・`source_kind`・`source_id`・`created_at`。ID は 1〜256 文字（元情報の ID の上限に合わせる。ADR 0040 の `OriginalSourceId`）。時刻は UTC のミリ秒。
- **種類**: `artifact_kind` は domain の `ForgetNodeKind` のうち `session` を除いたもの（`turn`・`memory`・`session_summary`・`carried_summary`・`notification_candidate`・`request_entity`・`related_analysis`・`canvas_item`・`intent_shadow`・`operation_content`・`async_guard`）。`source_kind` はこれに `source_item` を足したもの。`session` は「由来を引けない派生物が属する範囲」を表すだけで、辺には現れない（domain の `sourceOk` と同じ）。原本に決めなし（ADR 0040・0044 を根拠）。U82。
- **UNIQUE**: 同じ派生物・同じ由来の組は 1 つ。`derivation-store.ts` の `writeDerivation` は重複を黙って置き換えず、UNIQUE で失敗する。
- **索引**: `derivations_by_source (source_kind, source_id)`。忘却の閉包・復元の忘却の適用が由来から引く。
- **書き込みの時機**: 派生物を作る transaction で必ず書く（ADR 0040）。どの処理が書くか（要約・気づき・抽出・キャンバス・影モード・操作の確定内容・非同期の参照）の配線は B06-06c 以降。この作業では関数と表だけを作り、使っていない。

## 操作の記録の印（`record_kind`・`restore_unverified_at`）

- **`record_kind`**: `normal` か `private_minimal`。既定は `normal`（0001〜0009 の行は normal）。`private_minimal` は `workflow_id` を持てない（`operation_private_minimal_workflow`）。`normal` → `private_minimal` の変更だけを許し、`private_minimal` → `normal` は拒否する（`operation_record_kind_fixed`。戻すと、記録しない会話の操作が通常の記録になる）。`private_minimal` の操作は `request_entity_operations` に結び付けられない（`operation_private_minimal_request_entity`）。判定そのものは StorageModeGate（B06-04・B06-07）が持ち、DB は「記録しない会話の行がない」形で最後の保証をする（ADR 0040 U42）。
- **`restore_unverified_at`**: 古いバックアップからの復元で隔離した操作の印（ADR 0040 J3）。印を付けられるのは `effect_route = 'remote_mutation'` の操作だけ（`operation_restore_unverified_route`）。印がある操作は、承認の作成・`approved` と `preparing` と `dispatching` への遷移・試行の作成・試行の `dispatching` への更新を拒否する（`operation_restore_unverified`）。内容の更新（`awaiting_approval` のままの内容版の更新）は外に出ないので拒否しない。印は内容版を上げても外れない（この migration では `operations` の列なので、内容版とは独立）。印を外すのは、実行済みの積極的な証拠か本人の決着の後（ADR 0040）。命令は B06-06d。
- **印を外す更新を許す理由**: 復元の直後の差し替えでは印を付けるだけで、照合の後に外す命令が別に要る。migration で「NULL に戻す更新」まで拒否すると、後の作業が印を外せなくなる。ADR 0040 の「ここでは更新を許してよい」に従った。DB は「印を外せるのは、積極的な証拠か本人の決着のときだけ」までは強制しない（印を外す UPDATE の条件は命令の側が守る）。
- **`record_kind` の変更**: この migration で方向（`normal` → `private_minimal` だけ）を強制した。`private_minimal` の操作の内容版・承認の扱いは StorageModeGate（B06-04・B06-07）と一緒に決める。原本に決めなし（ADR 0040 を根拠）。U83。

## 試験（模擬だけ）

`packages/storage/src/migrations.test.ts`・`retention-store.test.ts`・`connection.test.ts`・`voice-store.test.ts`、`scripts/storage.test.mjs`。期待値は手で書いた（時刻は `Date.parse('2031-12-01T00:00:00Z')` の形で、実装の `budgetRecordDeleteAt` を呼んでいない）。

- **移行**: 版 9 の DB を 10 へ移せる。操作・承認・予算の行が残り、`record_kind = 'normal'`・`restore_unverified_at IS NULL`・予算の `delete_at IS NULL` になる。表は 53（+`derivations`）、全表 STRICT、外部キーと `integrity_check` が通る。内容のハッシュを `schema_meta` に記録する。
- **予算の記録**: 精算（M 以内）・解放・M 超過の確認が `delete_at` を書く。M 超過の精算では書かず、確認で書く。`delete_at` が NULL の予約の削除を拒否する。期限は Asia/Tokyo の 2030-10 が `2031-11-30T15:00:00Z`、America/New_York の 2030-03 が `2031-05-01T04:00:00Z`（手書きの期待値）。作った時刻から 364 日より前の値を拒否する。`INSERT OR REPLACE` が予約 ID・要求 ID・照合 ID の衝突で置き換えない。
- **月ごとの削除**: 消せる月は会話の接続・使用済み／未使用の承認・予約を 1 つの transaction で消す。1 行でも `reserved` がある月は何も消さない。1 行でも `delete_at` が未来なら何も消さない。`usage_unknown` の行・M 超過の確認待ちの行がある月、`budget_months` の記録がない月、期限の 1 ms 前も、何も消さない。外部キーの違反が出ない。`budget_months` とクレジットの観測は残る。
- **secure_delete**: 読み戻しが ON でないと `secure_delete_off` で拒否する（接続の試験と `pragmaReasons` の試験）。
- **派生物**: 同じ組の重複を拒否する。由来から 2 件を読める。自分自身を由来にする辺を CHECK で拒否し、`UPDATE` と `INSERT OR REPLACE` を拒否する（削除は通る）。CHECK の種類が domain の `FORGET_ARTIFACT_KINDS` と `turn`・`memory` に一致することを、SQL の一覧と手書きの期待値で確かめる。知らない種類を CHECK で拒否する。
- **操作の印**: `private_minimal` と `workflow_id` の同時指定、`private_minimal` → `normal` の変更、`private_minimal` の操作の `request_entity_operations` への結び付けを拒否する。`restore_unverified_at` がある操作で、承認の作成・`approved`／`preparing`／`dispatching` への遷移・試行の作成・試行の `dispatching` への更新を拒否し、印を外す更新は通る。`INSERT OR REPLACE` で印を消せない。`local_command` の操作には印を付けられない。

**模擬の期待値だけ**。`tests/test-map.json` の X15・X16・X17・X44 の `product_test` は `not_run` のまま（契約 fixture・storage の試験の合格を製品試験の合格として扱わない）。実際の DB の削除・`VACUUM`・実機は B06-06c・d・B15。

## 引き継ぎ

### B06-06c（J5 と、0010 より前の行）

- **J5 の本文の削除・90 日の削除**: ADR 0040 の「J5 終わった操作の本文の削除」の SQL。`operation_versions.intent_blob_id` を NULL 可にし、`body_deleted_at` と trigger を足す。`tasks` の正本の分離（`tasks.content_blob_id`・`sealed_blobs.purpose` の `task_content`）と、`request_entity_operations` の外部キーを外す表の作り直し。`operation_body` 7 日・`operation_receipt` 90 日の定数は `RETENTION_RULES` と一致させる（ADR 0043）。
- **0010 より前の予算の行**: `delete_at` が NULL のまま。確認済み（`overrun_reviewed = 1`）の行は `budget.review_overrun` の再適用で書ける。**backfill を塞いでいるのは `released` の行だけ**（0006 の `budget_reservations_released_final` が、解放済みの行へのすべての UPDATE を拒否する）。`settled` の行は、0006 の `budget_reservations_settlement_fixed` が精算の項目だけを固定し、`delete_at` は列挙していないので、普通の UPDATE で `delete_at` を書ける（実費が M 以内の行も含む）。専用の命令を足すか、手で確認するかは B06-06c で決める。**推測の時刻を入れない**方針（ADR 0010）を守るため、migration で一括の backfill はしない。必要なら「期限を計算して書く」専用の命令を B06-06c で足す（原本に決めなし。ADR 0040 を根拠）。U80。

### B06-06d（実行への配線）

- `sweepPlan` の `delete_row`（`budget_month` は `budget.purge_month` へ）、`erase_body`、`start_review` を DB worker の命令にする。`use_blocked` を掃除の記録へ写す。
- `budget.purge_month` は呼び出し側が渡す `now` を信じるので、必ず `sweepPlan` の判定（時計の巻き戻しでは保留）を通してから呼ぶ。
- 復元の差し替えで `restore_unverified_at` を付け、照合の後に外す命令。`record_kind` の方向は 0010 の trigger が守るので、StorageModeGate は `private_minimal` の操作の扱い（内容版・承認）を決める。
- 印について次の試験を足す。内容の更新の後も印が残ること。印の解除と結果の確定を同じ UPDATE で行うこと。全承認の失効を、印の有無に関係なく検査すること。DB は「印を外せるのは、積極的な証拠か本人の決着だけ」を強制しておらず、それは命令の側が守る。
- `derivations` を、要約・気づき・抽出・キャンバス・影モード・操作の確定内容・非同期の参照の作成 transaction で書く。忘却の閉包と復元の忘却の適用で、由来から引く。
- `PRAGMA wal_checkpoint(TRUNCATE)` と定期の `VACUUM` を、削除の後に実行する job に足す（ADR 0040・0016）。

## 未解決

- 0010 より前の予算の行の `delete_at`（上の U80）。`released` の行は 0006 の `budget_reservations_released_final` が塞ぎ、`settled` の行は普通の UPDATE で backfill できる。専用の命令を作るか、手で確認するかを B06-06c で決める。
- 月ごとの削除で `approved` の承認をどう扱うか（U81）。今は期限の来た `pending` だけを消し、`approved` は残す。13 か月後に残った `approved` は、期限切れにする命令（B07-04 の照合）がなければ残り続ける。
- `derivations` に書く派生物の範囲と、`artifact_kind` に `turn`・`memory` を含めたことの影響（U82）。`planForget` の閉包は B06-03 で試験済みだが、実際の作成処理との結び付けは未実施。
- `private_minimal` の操作の内容版・承認の扱い（U83）。`record_kind` の方向（`normal` → `private_minimal` だけ）は 0010 の trigger で確定した。StorageModeGate（B06-04・B06-07）と一緒に決める。
- `secure_delete` は空きページの上書きだけで、WAL の checkpoint・VACUUM・SSD の痕跡消去は未実施（B06-06d・B15）。原本に決めなし（ADR 0040 を根拠）。
