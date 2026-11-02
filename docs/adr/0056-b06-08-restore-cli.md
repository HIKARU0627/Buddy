# ADR 0056: B06-08 段階 2 — 復元の CLI（段階 1〜2 の台帳の確認と鍵の取り出し）

- 日付: 2026-11-01
- 状態: B06-08 段階 2 の**一部**（Issue #144、親 #11）。復元の段階 1〜2 を確かめる `restore check` だけを実装した。段階 3〜6（忘却の適用・DB の検証・作り直し・外部の照合）・`applyRestoreAftermath` の実行（J3 の保留）・`installRestoredDatabase` による差し替え・`store_generation` の更新・U109 の手での復旧は、同じ ADR の続き（次の PR）と ADR 0057 で足す。模擬の試験だけで、実機の Mac mini・実際のキーチェーン・実際のバックアップからの復元は未実施（B15）。
- 根拠: 設計 03（バックアップ・復元・忘却と再取り込み）、08 §4〜§6、09（X15〜X17・T06）、ADR 0016・0040・0047・0054（U109・U113）・0055、#11 の本人の判断 J1〜J6（2026-10-24）、本人の決定 U128〜U130（2026-10-31）、Issue #144 の分け方（段階 1・2・3）。原本は権限のある接続で読み取りだけ行い、全文は写していない。
- 番号: ADR 0056（この文書）、未決事項 U131〜U135。マイグレーションは足していない（0013 は未使用のまま。段階 3〜6 でもスキーマの変更は要らない見込み）。

## 段階 2 の分け方

| 段階 2 の範囲                                                               | PR      | 状態               |
| --------------------------------------------------------------------------- | ------- | ------------------ |
| 段階 1〜2 の確認（`restore check`）・鍵の取り出し・作業用 DB の作成         | この PR | 実装（模擬の試験） |
| 段階 3〜6・J3 の保留の書き込み・DB の差し替え・`store_generation` の更新    | 次の PR | 未着手             |
| U109 の手での復旧（壊れた・進んだ台帳のファイルを退避して DB から作り直す） | 次の PR | 未着手（ADR 0057） |

`restore check` は、復元を始める前に「この封筒・鍵・台帳で記憶と会話を戻してよいか」を本人が確かめるための読み取り中心の確認である。記憶と会話はまだ戻さない。

## 決めたこと

| ID   | 対象                    | 決定                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 根拠                                                                                                                             |
| ---- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| U131 | 復旧キーの入力          | 端末の標準入力（TTY）からのみ読む。生モードで 1 文字ずつ読み、画面には出さない。TTY でない（パイプ・リダイレクト）ときは読まずに理由 `not_a_tty` を返し、復元を始めない。引数・環境変数・ファイルからは読まない。読んだ値は CLI のメモリーの中だけで使い、Core・制御チャネル・ログ・DB・作業用のファイルに残さない。Crockford base32（52 文字）として読めない値は `invalid_code`。打ち間違いは `backup-keys.json` の確認値で先に見つける（記録がなければ確認しない） | 本人の決定 U128（2026-10-31）。復旧キーを履歴・ログ・プロセスの一覧に残さない                                                    |
| U132 | 作業用の DB の置き場所  | データディレクトリの中の `restore-work/restore-<restore_id>/buddy.sqlite`（ディレクトリ 0700・ファイル 0600・fsync）。封筒の本体を復号した平文はここにだけ置き、確認が終わったら（成功・失敗によらず）ディレクトリごと消す。バックアップの置き場所・リポジトリ・ログには置かない                                                                                                                                                                                     | 平文の写しを残さない（ADR 0047 の「復元は別の場所で行い、最後に差し替える」の手前）                                              |
| U133 | CLI の出力と終了コード  | `restore check` は `buddy.restore-check.v1` の JSON を標準出力に 1 行で出し、段階 1・2 の合否と理由コード・選んだ台帳の持ち主と世代・`settings_only_eligible` を返す。パス・鍵・復旧キー・本文は返さない。ready は終了コード 0、続けられないときは 12（`restore_refused`）。復旧キーを読めないときは `{ ok: false, state: 'recovery_key', reason }` を出して 12                                                                                                      | 復元の結果の契約（`RestoreResult`）は段階 1〜6 がそろったときに使う。途中の確認は CLI の中だけの形にして、ワイヤ契約を増やさない |
| U134 | データ鍵の導入          | 封筒の `data_key` の包みは、KeyStore にデータ鍵がないときだけ `data-key-v1` に置く（上書きしない）。あるときは素材が同じことを確かめ、違えば復元を続けない。封筒のデータ鍵の ID が `data-key-v1` でなければ続けない                                                                                                                                                                                                                                                  | 本人の決定 U130（2026-10-31）。鍵の導入の実行は段階 3〜6 の PR（この PR は `keyInstallPlan` を通すところまで）                   |
| U135 | 段階 2 の期限切れの削除 | 作業用の DB に対して、既存の保存期限の掃除（`RetentionSweeper`）を 1 回だけ動かす。時計の最終確認時刻と epoch は作業用のディレクトリに新しく作り、中枢の記録は変えない。掃除が完了し、失敗した操作が 0 件のときだけ「削除を当てた時刻」を記録して `restoreOpenCheck` に渡す。中枢の DB には書かない                                                                                                                                                                  | ADR 0043・0053・0058 の掃除を再利用する（別の削除の実装を作らない）。段階 2 の判定は ADR 0047 の `restoreOpenCheck`              |

## 何をするか（`restore check`）

1. **Core が止まっていることを確かめる**: データディレクトリの排他ロックを取る（Core が動いていれば `core_running` で止める）。中枢の DB を直接開くため。
2. **封筒を読む**: `readBackupFileHeader` で封筒を取り出し、契約の `BackupManifest` と domain の `backupManifestProblems`（生音声・記録しない会話・OAuth トークン・API キーを `excluded_data` に持つ・`private` を含めない・鍵の包みが 3 つ・台帳の hash ほか）に通す。通らなければ `manifest_invalid`。
3. **鍵を取り出す**: `backup-keys.json` の確認値で復旧キーの打ち間違いを先に見つけ（記録がなければ確認しない）、封筒の 3 つの包み（`backup_file`・`data_key`・`ledger_hmac_key`）を `unwrapBackupKey` で開く。`keyInstallPlan` で、KeyStore の既存の鍵と衝突しないこと（同じ ID で素材が違う・台帳の鍵が別の ID である・同じ ID が別の用途にある）を確かめる。
4. **本体を確かめて復号する**: 本体の長さと SHA-256 を封筒と照合し（`verifyBackupPayload`）、`backup_file` の鍵で復号する（`decryptBackupPayload`）。復号した DB は U132 の場所にだけ書く。
5. **段階 1（台帳の確認）**: 中枢の DB（正本）の台帳と、`forget-ledger.json`（別ファイル）から候補を作り、`restoreLedgerCheck` に渡す。DB が読めない・台帳の連鎖が壊れているときは候補にしない。別ファイルが DB より進んでいれば、その世代も「知っている最新」に含める。最新の台帳を確認できないときは記憶と会話を戻さない（`settings_only_eligible` を報告するだけ）。
6. **段階 2（期限切れの削除の前提）**: U135 の掃除を作業用の DB に当て、`restoreOpenCheck` で、開けたこと・復旧キーの確認値・鍵の導入の計画・本体の一致・時計（保存期限の掃除の時計の記録（`clock-state.json`）とバックアップの掃除の記録のうち新しい方の最終確認時刻・復元の開始・バックアップの作成より前でない。時計の記録が読めないときは期限を判定できない）・削除を当てた時刻を確かめる。
7. 作業用の DB を消し、ロックを返す。出力は U133。

## 止まったときに何を戻さないか

- 段階 1 で止まったときは、記憶・会話・承認・端末を何も戻さない。`latest_ledger_unconfirmed`・`latest_ledger_missing`・`backup_newer_than_ledger` だけは「非機密の設定だけを戻せる候補」として `settings_only_eligible: true` を返す（実行は段階 3〜6 の PR）。系譜・連鎖・hash・封筒の不一致は設定も戻さない（U75）。
- 段階 2 で止まったとき（`backup_unreadable`・`clock_regression`・`expiry_purge_failed`）は何も戻さない。
- 作業用の DB は成功・失敗によらず消す。確認の途中で止まったときはプロセスの終了で残り得るが、次の `restore check` は新しい `restore_id` のディレクトリを使い、`restore-work` の下の古いディレクトリには触れない（手で消せる。自動の回収は段階 3〜6 の PR で、Core の起動時に `backup-work` と同じように扱うかを決める）。

## 含めないデータ・J3

- 封筒は生音声・記録しない会話・OAuth トークン・API キーを含めない（`excluded_data` の 4 つ）。復号した DB には、含めない 10 表の行と、その表が持つ `sealed_blobs` の暗号文がない（試験で行数を 0 と確かめる）。`private` を含む封筒は `manifest_invalid` で拒否する。
- 承認の失効（J3）は段階 3〜6 の PR で `applyRestoreAftermath` を実行するときに確かめる。この PR は何も戻さないので、承認も状態も変えない。

## 試験（模擬だけ）

`apps/core/src/restore-check.test.ts`。バックアップはテストの中で本物の Core の設定（`runBackupSetup`）と作成（`backup.run`）で作り、復旧キーは画面に出した値から `decodeRecoveryCode` で独立に戻す。期待値は手で書いた。

- ready: 段階 1・2 が通り、選んだ台帳が中枢（`hub`）で、作業用の DB が残らない。封筒の `excluded_data` が 4 つ・`included_storage_modes` が `normal`・`extended` だけで、復号した DB の含めない表の行と `sealed_blobs` が 0 件。
- 拒否: 復旧キーが違う（`backup_unreadable`）、本体を 1 バイト書き換えた（`backup_unreadable`）、封筒が `private` を含む（`manifest_invalid`）、封筒の系譜が中枢と違う（`ledger_lineage_mismatch`）、書きかけの台帳の一時ファイルがある（`latest_ledger_unconfirmed`・`settings_only_eligible: true`）、台帳の別ファイルが壊れている（`ledger_chain_invalid`）、中枢の DB があるのに読めない（`latest_ledger_unconfirmed`・`settings_only_eligible: true`。別ファイルだけで最新を確定しない）、中枢の DB と台帳のファイルをどちらも失った（`latest_ledger_unconfirmed`・`settings_only_eligible: true`）、Core が動いている（`core_running`・封筒を読まない）。
- 鍵: `backup-keys.json` を失っても、KeyStore に封筒と同じ ID で違う素材の鍵があれば、`keyInstallPlan` の衝突として止める（`backup_unreadable`）。KeyStore の読み取り障害・不正な保存値は「鍵がない」と区別し、`backup_key_missing`・`data_key_missing` 以外は `backup_unreadable` で止める（衝突を確かめられないため）。
- 台帳の分岐: 同じ系譜の DB と別ファイルの共通の世代で `entry_hash` が食い違うときは `ledger_chain_invalid`（`ledgerHistoriesDiverge` の単体試験と、破損したファイルの試験）。
- 期限の時計: 保存期限の掃除の時計の記録（`clock-state.json`）の最終確認時刻が復元の「今」より先（`clock_regression`）・記録が読めない（`clock_regression`）。既存の中枢 DB があるのに記録がない場合も、新規の機器への復元と違って以前の最終確認時刻を失っているので `clock_regression`。バックアップの状態（`backup-state.json`）が壊れているときも、より新しい最終確認時刻を失っているかもしれないので同じく `clock_regression`（正常な `clock-state.json` だけを信じない）。
- 作業用の DB を開けない: 復号した本体が SQLite として開けない（壊れた・未対応の形）ときは、例外で CLI 全体を抜けず、`buddy.restore-check.v1` の拒否レポートを返して `backup_unreadable` で止める。平文は残さない。
- 平文を残さない: 作業用の DB の書き込みが途中で失敗しても、`restore-work/restore-<restore_id>/` に平文が残らない。削除（`rm`）が失敗したときは成功（終了コード 0）を返さず、`plaintext_delete_failed` で止める。
- 復旧キーの入力: TTY でない（`not_a_tty`）、空（`input_empty`）、形が違う（`invalid_code`）、Ctrl-C（`interrupted`）。区切りと小文字を受け付け、値が案内の文に出ない。

**模擬の期待値だけ**。`tests/test-map.json` の X15〜X17 の `product_test` は `not_run` のまま（復元の段階 3〜6 がそろうまで変えない）。実機のキーチェーン・実際のバックアップからの復元・Mac mini は B15 で未実施。

## 次の PR への引き継ぎ

- 段階 3〜6: 段階 1 で選んだ台帳の head まで忘却を適用し（`restoreForgetCheck`）、DB の検証（`restoreDbVerifyCheck`）・作り直し（`restoreRebuildCheck`）・外部の照合（`restoreReconcileCheck`、`pending`）を行う。`buildRestoreResult` で契約の `RestoreResult` を組み立てる。
- J3: 差し替える前の作業用の DB に `applyRestoreAftermath` を 1 つの transaction で書き、`installRestoredDatabase` で差し替える。`store_generation` の更新・鍵の導入（U134 の実行）・`ledger_hmac_key_id` の記録も同じ transaction の側で行う。承認がすべて失効することを試験で確かめる。
- U109 の手での復旧: 壊れた・DB より進んだ `forget-ledger.json` を退避し、DB の台帳から作り直す CLI（ADR 0057）。台帳の確認（この PR の段階 1）を使う。
