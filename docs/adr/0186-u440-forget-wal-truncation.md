# ADR 0186: 忘却の COMMIT の後に WAL を切り詰める（U440）

- 日付: 2026-11-27
- 状態: U440 の暫定の判断と実装。`apps/core` の `forget-service.ts`（COMMIT の後に切り詰めを頼む）・`retention-sweeper.ts`（`truncateLogAfterForget`）・`core.ts`（配線）、`packages/storage` の試験（`forget-log-truncation.test.ts`）、B06 の統合の期待値と証拠の作り直し。保存層の命令・マイグレーション・契約は変えていない（DB の版は 23 のまま）。**忘却の公開ゲートは閉じたまま**（`FORGET_PUBLIC_GATE_OPEN = false`）。実機の Mac mini・実データ・SSD の痕跡・実 API・実請求は**未実施**。
- 根拠: B06-09 の観測（`docs/b06/README.md` の既知の未了、`X15-forget-and-late-result-order` の `after_forget`）、U79・U115（`docs/b00/contract-map.md`）、ADR 0040（secure_delete・削除の後の `wal_checkpoint(TRUNCATE)`・VACUUM の案）、ADR 0048（secure_delete の設定と読み戻し）、ADR 0053（掃除の後始末の checkpoint・VACUUM と再試行）、ADR 0054（忘却の後の checkpoint を掃除の job に任せた）、ADR 0180（忘却の Core の経路）。非公開の原本（設計 03・08）はこの環境になく、参照していない。原本に決めがないので、本人の「試験と見直しは後でまとめて行う」に従い、聞かずに暫定で進めた。新しい未決事項は U463・U464。
- 触っていないもの: `docs/handoff.md`、公開ゲートの値、B04・B05・B07 の証拠。

## 確かめた今の扱い（コードを読んで確認）

- **secure_delete**: 書込みの接続を作るたびに `connection.sql` の `PRAGMA secure_delete = ON` を実行し、`pragmaReasons` が読み戻す（ADR 0048、`secure_delete_off` で拒否）。消した行の内容は、消したときに書くページの上で 0 になる。ただし、行を書き込んだときの WAL のフレームは、そのまま WAL のファイルに残る。
- **掃除の後の checkpoint**: 掃除の job（`RetentionSweeper`）が、削除を 1 件以上行った掃除の記録を確定した後に、`retention.checkpoint`（DB worker が transaction の外で `PRAGMA wal_checkpoint(TRUNCATE)` を実行し、`busy` を返す）→（間隔を過ぎていれば）`retention.vacuum` → `retention.checkpoint` を行う（ADR 0053）。`busy` が 1・命令の失敗のときは保留を残し、次の掃除（削除がなくても）の後にもう一度試す。`SQLITE_FULL` は書込みを止めない拒否（`database_full`）、I/O の失敗・成否不明は書込みを止める（U115、ADR 0018）。
- **忘却の命令**（`forget.apply`）: 行と暗号文を 1 つの transaction で消すが、checkpoint はしない（ADR 0054 が掃除の job に任せた）。そのため、次に削除を伴う掃除か Core の停止（最後の接続を閉じると WAL は書き戻されて消える）まで、忘れた記憶の暗号文が WAL に残った（B06-09 の観測）。自動の checkpoint（PASSIVE）は WAL を切り詰めないので、書き戻した後も古いフレームはファイルの中に残る。
- **復元のときの忘却の適用**: `restore-run.ts` の段階 3 で、作業用の DB（復元の処理だけが開いている）に台帳を当て、段階 5 で `VACUUM` と `wal_checkpoint(TRUNCATE)` をしてから閉じる。差し替えの前に作業用の DB の `-wal` が残っていれば拒否する（`restore-install.ts`）。作業用の接続も `connection.sql` を通るので secure_delete は ON。B06-09 の `X16-old-backup-restore-applies-ledger` の `restore.ciphertext_in_db_files` は、忘れた記憶の暗号文が復元した DB・WAL にないことを観測している。**復元の経路は変えなかった**。

## 決めたこと（暫定）

### 切り詰めの時機と方式（U440 の (b) に (c) の再試行を合わせる）

- 忘却の Core の経路（`ForgetService.execute`）は、`forget.apply` が COMMIT した後に、WAL の切り詰めを 1 回頼み、その結果を待ってから応答する。成否不明（`outcome: 'unknown'`）のときも COMMIT した可能性があるので頼む（切り詰めは何も消さないので害がない）。拒否された忘却（計画の取り直しなど。何も消していない）では頼まない。同じ計画の再送（控えた結果を返すだけ）でも頼まない。
- 頼む先は掃除の job の `truncateLogAfterForget()`。中身は掃除の後始末と**同じ命令**（`retention.checkpoint`、`wal_checkpoint(TRUNCATE)`）で、新しい命令・PRAGMA は足していない。忘却は VACUUM の保留を立てない（消した内容は secure_delete で 0 になり、切り詰めの後は DB のファイルにも残らないことを試験で確かめた。空きページを詰めるのは今までどおり削除を伴う掃除の後の VACUUM）。
- 製品の組み立て（`core.ts`）は `truncateLog` に `retention.truncateLogAfterForget()` を渡す。`ForgetServiceOptions.truncateLog` は必須にして、配線の書き忘れを型で止める。

### 切り詰められないとき

- 忘却の結果は**変えない**。忘却は COMMIT で確定しているので、応答は成功（`ForgetExecuteResult`）のまま、台帳のファイルの同期・知らせも続ける。`truncateLog` が例外を投げても、忘却の経路はログ（本文なし）を出して成功を返す。
- 他の接続が読みの transaction を開いている（`busy` が 1。例: バックアップの写しの読み）・命令が失敗した（`database_full` など）ときは、掃除の job が checkpoint の保留を立て、**次の掃除の後**（削除がなくても。周期は 5 分）にもう一度試す。済むまで毎回の掃除の後に試す。I/O の失敗のときは、DB worker が今までどおり書込みを止める（ADR 0018）。
- 本人への知らせは出さず、ログ（「忘却の後に、ログを切り詰められませんでした（他の接続が使用中）。次の掃除の後にもう一度試します。」など。本文・ID を含めない）だけにする（U464）。
- 停止の後（掃除の job を閉じた後）は頼まない。DB を閉じると WAL は書き戻されて消える。
- 保留は RAM にだけ持つ。Core が異常終了したときは失われ、起動の後は次の削除を伴う掃除・正常な停止まで残りうる（U463）。

## 試験（模擬だけ。期待値は手で書いた）

- `packages/storage/src/forget-log-truncation.test.ts`（新規。一時ディレクトリのファイルの DB と書込みの接続）
  - 忘却の命令だけでは忘れた記憶（M・M2）の暗号文が WAL に残り、`retention.checkpoint` の後は DB のファイルにも WAL にもなく、WAL の大きさは 0。消していない記憶（M_OTHER）の暗号文は DB にある（陽性の対照）。
  - 別の接続が読みの transaction を開いていると `busy` が 1 で、忘却は確定したまま（台帳の 1 件・消えた記憶）、WAL に暗号文が残る。読みが終わった後の次の切り詰めで消える（読む接続は開いたまま。閉じるとその接続の後始末で WAL が書き戻され、再試行を確かめられないため）。
  - 切り詰めの PRAGMA が `SQLITE_FULL` で落ちると、書込みを止めない拒否（`database_full`）で、忘却は確定したまま。次の切り詰めで消える。
- `apps/core/src/retention-sweeper.test.ts`（模擬の口）: 切り詰められたときは保留を残さない・VACUUM をしない。`busy` のときはログを 1 行出し、次の掃除（削除なし）の後に 1 回試して済む。失敗（`database_full`・例外）は投げず、済むまで次の掃除の後に試す。閉じた後は頼まない。
- `apps/core/src/forget-service.test.ts`: COMMIT の後（M・M2 が消えた時点）に 1 回だけ頼む。拒否・再送では頼まない。成否不明では頼む。切り詰めの例外・失敗でも成功（世代 1・台帳のファイル・知らせ）。製品と同じ掃除の job を本物の DB の命令につないだ試験で、読みの transaction があると忘却は成功のまま暗号文が WAL に残り、削除のない次の掃除の後に消えること、読みがなければ忘却の直後に消えることを確かめた。
- B06 の統合（`tests/integration/b06-cases.mjs`）: X15 で忘却の経路に掃除の job の `truncateLogAfterForget` を渡し、`b06-expectations.json` の `after_forget` を手で直した（両方の順序で `["L2", "M_OTHER", "T_OTHER", "T_SRC"]`。忘れた M と、忘却の前に届いて同じ忘却で消えた L1 がない。忘却の後に届いた L1 は保存されないので元からない）。証拠 `evidence-b06-simulated.json` は `BUDDY_B06_EVIDENCE_PATH` を指定した実行器で作り直した。
- 試験の感度: 次の欠陥を一時的に入れ（コミットしていない）、落ちることを確かめた。忘却の経路が切り詰めを頼まない → `forget-service.test.ts` の 3 件と X15。掃除の job が checkpoint を送らずに成功を返す → `retention-sweeper.test.ts` の 3 件と `forget-service.test.ts` の 1 件。busy・失敗のときに保留を立てない → `retention-sweeper.test.ts` の 2 件と `forget-service.test.ts` の 1 件。`retention.checkpoint` を PASSIVE にする → `forget-log-truncation.test.ts` の 3 件。

## 残り

- 実機の Mac mini での忘却の応答の時間（切り詰めの分だけ遅くなる）は未測定。WAL が大きいときの時間も未確認。
- SSD の痕跡・OS のファイルシステムの古いブロックは保証しない（設計 03・U79。B15）。
- U463（異常終了で保留が失われるとき）・U464（切り詰めが続けて失敗するときの知らせ）は未決。
- 忘却の公開ゲートを開く判断（U431）は本人の判断待ち。U440 は暫定で決めたので、開く前の見直しで本人に確かめる。
