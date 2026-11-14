# ADR 0056: B06-08 段階 2 — 復元の CLI（段階 1〜2 の台帳の確認と鍵の取り出し）

- 日付: 2026-11-01
- 状態: B06-08 段階 2 の**一部**（Issue #144、親 #11）。復元の段階 1〜2 を確かめる `restore check` と、段階 3〜6（忘却の適用・DB の検証・作り直し・外部の照合）・鍵の導入・承認の失効（J3）・`store_generation` の更新・`installRestoredDatabase` による差し替えを行う `restore run` を実装した。U109 の手での復旧は ADR 0057（別 PR）。模擬の試験だけで、実機の Mac mini・実際のキーチェーン・実際のバックアップからの復元は未実施（B15）。
- 根拠: 設計 03（バックアップ・復元・忘却と再取り込み）、08 §4〜§6、09（X15〜X17・T06）、ADR 0016・0040・0047・0054（U109・U113）・0055、#11 の本人の判断 J1〜J6（2026-10-24）、本人の決定 U128〜U130（2026-10-31）、Issue #144 の分け方（段階 1・2・3）。原本は権限のある接続で読み取りだけ行い、全文は写していない。
- 番号: ADR 0056（この文書）、未決事項 U131〜U135。マイグレーションは足していない（0013 は未使用のまま。段階 3〜6 でもスキーマの変更は要らない見込み）。

## 段階 2 の分け方

| 段階 2 の範囲                                                               | PR       | 状態               |
| --------------------------------------------------------------------------- | -------- | ------------------ |
| 段階 1〜2 の確認（`restore check`）・鍵の取り出し・作業用 DB の作成         | 前の PR  | 実装（模擬の試験） |
| 段階 3〜6・J3 の保留の書き込み・DB の差し替え・`store_generation` の更新    | この ADR | 実装（模擬の試験） |
| U109 の手での復旧（壊れた・進んだ台帳のファイルを退避して DB から作り直す） | 次の PR  | 未着手（ADR 0057） |

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
- 拒否: 復旧キーが違う（`backup_unreadable`）、本体を 1 バイト書き換えた（`backup_unreadable`）、封筒が `private` を含む（`manifest_invalid`）、封筒の系譜が中枢と違う（`ledger_lineage_mismatch`）、書きかけの台帳の一時ファイルがある（`latest_ledger_unconfirmed`・`settings_only_eligible: true`）、台帳の別ファイルが壊れている（`ledger_chain_invalid`）、中枢の DB の台帳の連鎖が壊れている（`ledger_chain_invalid`・設定だけの復元もしない）、中枢の DB があるのに読めない（`latest_ledger_unconfirmed`・`settings_only_eligible: true`。別ファイルだけで最新を確定しない）、中枢の DB と台帳のファイルをどちらも失った（`latest_ledger_unconfirmed`・`settings_only_eligible: true`）、Core が動いている（`core_running`・封筒を読まない）。
- 鍵: `backup-keys.json` を失っても、KeyStore に封筒と同じ ID で違う素材の鍵があれば、`keyInstallPlan` の衝突として止める（`backup_unreadable`）。封筒の鍵の ID（データ鍵の ID を含む）は、宣言された用途だけでなく両方の用途の KeyStore の項目でも読み、同じ ID が別の用途にある衝突（`key_material_conflict`）も見つける。KeyStore の読み取り障害・不正な保存値は「鍵がない」と区別し、`backup_key_missing`・`data_key_missing` 以外は `backup_unreadable` で止める（衝突を確かめられないため）。
- 台帳の分岐: 同じ系譜の DB と別ファイルの共通の世代で `entry_hash` が食い違うときは `ledger_chain_invalid`（`ledgerHistoriesDiverge` の単体試験と、破損したファイルの試験）。
- 期限の時計: 保存期限の掃除の時計の記録（`clock-state.json`）の最終確認時刻が復元の「今」より先（`clock_regression`）・記録が読めない（`clock_regression`）。既存の中枢 DB があるのに記録がない場合も、新規の機器への復元と違って以前の最終確認時刻を失っているので `clock_regression`。バックアップの状態（`backup-state.json`）が壊れているときも、より新しい最終確認時刻を失っているかもしれないので同じく `clock_regression`（正常な `clock-state.json` だけを信じない）。
- 作業用の DB を開けない: 復号した本体が SQLite として開けない（壊れた・未対応の形）ときは、例外で CLI 全体を抜けず、`buddy.restore-check.v1` の拒否レポートを返して `backup_unreadable` で止める。平文は残さない。
- データディレクトリ: ロックを取る前に用意する（新しい機器への復元ではまだない）。用意できない（場所がファイル・権限がない）ときは `core_running` と区別して `data_dir_unavailable` で止める。
- 平文の後始末: 成功の経路だけでなく、台帳の確認などで拒否した経路でも、作業用のディレクトリを消せなければ `plaintext_delete_failed` を最後の段階に付けて拒否を返す（消えたことを確かめずに拒否だけを返さない）。
- 平文を残さない: 作業用の DB の書き込みが途中で失敗しても、`restore-work/restore-<restore_id>/` に平文が残らない。削除（`rm`）が失敗したときは成功（終了コード 0）を返さず、`plaintext_delete_failed` で止める。
- 復旧キーの入力: TTY でない（`not_a_tty`）、空（`input_empty`）、形が違う（`invalid_code`）、Ctrl-C（`interrupted`）。区切りと小文字を受け付け、値が案内の文に出ない。
- 段階 3（`applyRestoreLedger` の単体）: 忘却の後の台帳を、忘却の前の DB に当てると、忘れた記憶・そこから作った記憶・気づき・指示の発言が消え、台帳の連鎖の世代と `entry_hash` は与えられた値のまま（`packages/storage/src/forget-store.test.ts`）。台帳の「除外する由来」の HMAC から、その由来を持つ派生物（バックアップの後に作られた記憶を忘れた場合の気づき）も消え、由来の発言自体は残る。派生して消えた記憶を新しい起点にしない（T1→M1、T1/T2→M2、T2→M3 で M1 を忘れたとき、復元後も M3 は残る）。
- 段階 1〜6 と差し替え（`restore run`）: 本物の Core の設定とバックアップから、承認付きの操作を含む封筒を作り、復元した後に承認がすべて失効していること（`approvals_revoked_count` と DB の `revoked`）・`store_generation` が新しくなっていること・`restore_restored_at` が入っていること・台帳の別ファイルが復元した DB から作り直されること・作業用の平文が残らないこと・鍵が KeyStore にあることを確かめる（`apps/core/src/restore-run.test.ts`）。差し替えの記録が残った失敗では、作業用の DB を消さず、`installed: false`・`plaintext_deleted: false` を返し、中枢の DB が差し替わっていないことを確かめる。check の後に封筒の `backup_id` を書き換えると、認証済み manifest の digest と違うため `manifest_changed` で差し替えない。

**模擬の期待値だけ**。`tests/test-map.json` の X15〜X17 の `product_test` は `not_run` のまま（段階 1〜6 の模擬の統合試験 X15〜X17 は未実施）。実機のキーチェーン・実際のバックアップからの復元・Mac mini は B15 で未実施。

## 段階 3〜6 の実行（`restore run`）

`restore check` が ready を返した後、作業用の DB に対して次を行う（`apps/core/src/restore-run.ts`）。

1. **段階 3（忘却の適用）**: 段階 1 で選んだ台帳（中枢の DB か台帳の別ファイル）の連鎖のうち、バックアップの世代より後のものを `applyRestoreLedger` で当てる。台帳の 1 件は当時の削除対象（`forgotten`）と除外する由来の HMAC（`blocked_source_hmacs`）を持ち、派生物は持たない。台帳の `forgotten` を「削除済み（非 core）」、blocked を「除外する由来」として、domain の閉包の規則 A・C・D をそのまま再適用する（`forgotten` の全件を新しい core にしない。通常の忘却が広げなかった由来まで規則 B で辿らない）。範囲の展開は、core に触れた範囲の全体を除外する分を blocked の一覧がすでに持っているので、新たな由来を足さず、範囲が削除する物・除外する由来に触れるときだけ派生物を消す。元情報は HMAC しか台帳にないので、今の DB の元情報の ID を同じ鍵で HMAC にして照合する。発言・記憶も、実体が期限切れで消えて系譜の辺にだけ残っている ID を照合の対象に含める。由来そのものは残し、その由来を持つ派生物を消す（バックアップの後に作られた記憶を忘れた場合、記憶から由来へ遡れないため）。台帳の `entry_hash` は与えられた値を保ち、連鎖を書き換えない。系譜がなければ封筒の `ledger_id` を付ける。当てた後の世代が段階 1 の head 以上であることを `restoreForgetCheck` で確かめる。
2. **段階 4（DB の検証）**: 整合性・外部キー・版・表の一覧・`store_generation`・`ledger_id`・忘却の世代を読み、`restoreDbVerifyCheck` に渡す。操作の隔離の計画が立つことも確かめる（読めない状態・経路があれば `db_integrity_failed`）。
3. **段階 5（作り直し）**: `VACUUM` と WAL の checkpoint で空き領域を戻し、索引を作り直す（失敗は `rebuild_failed`）。
4. **段階 6（外部の照合）**: OAuth トークンは封筒にないので、再認証が済むまで `pending`（`restoreReconcileCheck`）。
5. **鍵の導入（U134）**: 封筒の `backup_file`・`ledger_hmac_key` を KeyStore に足し（同じ ID に同じ素材があれば何もしない。違えば止める）、データ鍵は KeyStore にないときだけ `data-key-v1` に置く。読み戻して素材を確かめる。
6. **J3・`store_generation`**: 差し替える前の作業用の DB に `applyRestoreAftermath` を 1 つの transaction で書き、承認をすべて失効させ、操作を隔離し、`store_generation` を新しい UUID にし、使う台帳の鍵の ID を `schema_meta` に記録する。
7. **結果**: `buildRestoreResult` で契約の `RestoreResult` を組み立てる（段階 6 は `pending` のまま `restored`）。
8. **差し替え**: `installRestoredDatabase` で作業用の DB を今の DB と入れ替える（Core のロックは `restore check` の前から差し替えと台帳の別ファイルの作り直しまで連続して持ち、途中で Core が起動して忘却を進めないようにする）。check は本体を認証した manifest の正準化 SHA-256 を返し、run は読み直した封筒の digest と照合する（確認と後段の間に封筒が変わったら `manifest_changed` で止める）。差し替えた後、台帳の別ファイルを復元した DB から作り直す（Core の起動時の照合で止まらないように）。作業用の平文は、拒否・例外の経路でも DB を閉じてから消し、消せないときは `plaintext_delete_failed` として報告する。差し替えの記録（`restore-install.json`）が残った失敗では、次の起動・差し替えの復旧が参照する作業用の DB を消さない。差し替えの前に止まった拒否と、差し替えた後に台帳の別ファイルだけを作れなかった拒否を、`installed` で区別する。

設定だけを戻す `settings_only` の実行は、この PR では行わない（`restore check` が候補を報告するところまで。次の PR で扱う）。

## 次の PR への引き継ぎ（U109）

- 壊れた・DB より進んだ `forget-ledger.json` を退避し、DB の台帳から作り直す CLI（ADR 0057）。台帳の確認（この ADR の段階 1）を使う。DB が古い（封筒の台帳が進んでいる）ときは復元（`restore run`）に進ませる。
