# ADR 0019: Core への DB の組み込みと再起動の復元・内容 hash の照合

- 日付: 2026-10-20
- 状態: B02-04（#56）の判断と実装。Core の起動に DB worker を組み込み、鍵の照合値・store_generation の状態ファイルからの移行・起動時の回復を作り、内容 hash（JCS＋SHA-256）の製品の関数を H01 などの独立した期待値と照合した。X60 相当の故障注入（プロセスの強制終了）も足した。試験は模擬（模擬の KeyStore・一時ディレクトリの DB・子プロセス）だけで、macOS 実機のキーチェーン・耐久設定の確認は未実施（[docs/b02/device-check.md](../b02/device-check.md)）。電源断（X60 の本体・T07）も未実施。
- 根拠: 設計 06 B02、08 §2・§4、07 §1・§4、02（保存と秘密情報）、09 §8、ADR 0012・0016・0017・0018、PR #58 のレビュー点（初回起動の鍵の競合）。設計本文は今回の作業環境に取得できず、司令塔から受け取った要約に基づく。原本との照合はレビューで行う。

## 決めたこと

| 対象                    | 決定                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 起動の順序              | 起動前検査（鍵保護。初回は鍵を作る）→ データディレクトリ → 単一起動のロック → データ鍵の読み直し（`loadDataKey`、作成しない）→ B01 の状態ファイルの読み取り → DB worker の起動（書込み接続・耐久設定の読み戻し・マイグレーション・健全性・鍵の照合値・store_generation）→ 状態ファイルの片付け → 起動時の回復 → 制御チャネル → running |
| 失敗時                  | どこで失敗しても書込みを始めない。起動した DB worker を閉じ、ロックを返し、`CoreStartError` の理由コードを出して起動を拒否する（下の「拒否と終了コード」）                                                                                                                                                                             |
| 鍵の照合値              | `HMAC-SHA256(データ鍵, "buddy/data-key-check/v1" + NUL + key_id)` の小文字の 16 進。鍵そのものは DB にも DB worker にも渡さない。`schema_meta` のキー `data_key_check:<key_id>`（今は `data_key_check:data-key-v1`）に保存する                                                                                                         |
| 照合                    | 初回（照合値がない）は保存、以後は一致を確かめる（`timingSafeEqual`）。違う値・別の key_id の照合値だけがある・照合値がないのに sealed_blobs に行がある、のどれも書込みを始めない                                                                                                                                                      |
| 0002                    | `migrations/0002_data_key_check.sql` で `schema_meta` を同じ列のまま作り直し、CHECK に `data_key_check:<key_id>`（値は 16 進 64 桁）を足した。0001 は変えていない                                                                                                                                                                      |
| store_generation の移行 | DB に世代があれば DB を正とする。状態ファイル（`core-state.json`）があって DB になければ、その値を DB へ移す。両方にあって違えば、どちらも書き換えずに拒否する。どちらにもなければ新しい UUID                                                                                                                                          |
| 移行後の状態ファイル    | DB へ移した（または DB の値と一致した）後に消し、ディレクトリを fsync する。消せなければ起動しない。Core は状態ファイルを新しく作らない                                                                                                                                                                                                |
| DB の健全性             | DB worker の起動で `PRAGMA quick_check` を行い、ok でなければ起動しない（`database_integrity_failed`）                                                                                                                                                                                                                                 |
| 起動時の回復            | dispatching の操作を新しい命令 `operation.recover_after_restart` で unknown_held へ回す（試行も unknown_held・result_status は unknown）。イベント・内部の受付と同じ transaction。preparing・reconciling・unknown_held はそのまま                                                                                                      |
| 内容 hash               | `packages/storage/src/content-hash.ts`。canonicalize 5.1.0（scripts と同じ版）と node:crypto で、確定 intent の JCS の UTF-8 の SHA-256。`sealOperationIntent` が同じ正規形から content_hash と暗号文（平文は正規形）を作る                                                                                                            |
| content_hash を作る場所 | 呼び出し側（Core main）で作って `operation.create` に渡す。worker の中では作らない（下の「内容 hash の置き場所」）                                                                                                                                                                                                                     |
| DB のファイル           | データディレクトリの `buddy.sqlite`（`-wal`・`-shm` が並ぶ）                                                                                                                                                                                                                                                                           |
| 模擬起動の鍵            | `--mock-key-protection` は公開の固定文字列の SHA-256 を鍵にする模擬の KeyStore を使う（再起動で同じ鍵になる）。模擬起動の DB は保護されない。実機の鍵で作った DB を模擬起動で開くと照合値が合わずに拒否する（逆も同じ）                                                                                                                |

## 起動の順序と鍵の競合

ADR 0017 の読み取りのとおり、起動前検査はロックより前にキーチェーンへ鍵を作ります。初回に二つの Core を同時に起動すると、両方が鍵を作って一方が上書きし得ます。B02-04 では次のようにしました。

1. 起動前検査（`loadOrCreateDataKey`）は鍵保護の可否の判定にだけ使い、取得した鍵は捨てる（ADR 0017 のまま）。
2. ロックを取った後に、同じ KeyStore から `loadDataKey`（作成しない）で読み直した鍵だけを使う。ロックの後はもう一つの Core は起動できないので、この時点のキーチェーンの値が以後使われる鍵になる。
3. その鍵の照合値を DB と比べる。初回は保存する。以後の起動で、キーチェーンの鍵が入れ替わっていれば照合が合わず、書込みを始めない。

試験（`apps/core/src/restore.test.ts`）では、起動前検査で鍵 A を返した後にキーチェーンの値が鍵 B に替わる KeyStore を使い、DB の照合値が B になること、以後 B では起動でき A では拒否されることを確かめています。

## 拒否と終了コード

終了コードの約束（ADR 0012）は変えず、新しい拒否を次のように割り当てました。

| 理由（`code`）              | 内容                                                                             | 終了コード |
| --------------------------- | -------------------------------------------------------------------------------- | ---------- |
| `data_key_unavailable`      | ロックの後にデータ鍵を読めない（`data_key_unavailable:<KeyStore の理由>`）       | 5          |
| `data_key_mismatch`         | 鍵の照合値が合わない・照合値がないのに暗号文がある・保存値が壊れている           | 5          |
| `store_generation_mismatch` | 状態ファイルと DB の store_generation が違う                                     | 4          |
| `store_open_failed`         | 耐久設定の読み戻し・版（新しすぎる DB など）・健全性・権限・状態ファイルの片付け | 4          |
| `store_recovery_failed`     | 起動時の回復を記録できない                                                       | 4          |

5 は鍵保護・鍵に関する拒否、4 は排他と保存の検査による拒否（既存の `state_file_invalid` と同じ扱い）です。理由には理由コードだけを入れ、パス・SQL・鍵の値・照合値は出しません。

CLI の `start` は `running` の前に `{"event":"store_opened", schema_version, store_generation, store_generation_source, data_key_check, held_after_restart, resumable_preparing}` を 1 行出します（操作 ID は個人情報ではない）。`status` の応答の形（ADR 0012）は変えていません。

## 起動時の回復（08 §4）

| 状態        | 扱い                                                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dispatching | 送出意図の COMMIT の後、送信の前後のどこで止まったか記録にない。unknown_held へ回し、自動では再送しない。承認は使い終えない（valid のまま）。照合（reconciling）と本人の判断は B04 以降 |
| preparing   | 送出意図の前で、変更要求をまだ送っていないことが記録上確か。そのまま残し、参照確認からの再開を B04 に任せる。`resumable_preparing` として出す                                           |
| その他      | reconciling・unknown_held・終端の状態は変えない                                                                                                                                         |

- 回復は Core main が DB worker の照会（`interrupted`）で対象を読み、操作ごとに `operation.recover_after_restart` を送ります。状態版で照合し、依頼・許可・忘却の版では拒否しません（送出済みかもしれない結果を失わないため。`record_result` と同じ）。受付は内部の接続範囲（`core-internal`）で残り、同じ命令の再到着は二度適用しません。
- 回復は制御チャネルを開く前に終わります。回復の途中で中枢が落ちても、次の起動で残りの dispatching だけを回します。
- 「preparing を未送出と判断してよい前提」（耐久設定が守られていた・DB が壊れていない）は、DB worker の起動で耐久設定を読み戻し、`quick_check` に通ったときだけ Core が起動することで担保します。通らなければ Core が起動しないので、preparing を含めて何も進みません。古いバックアップからの復元の検出は B06 の担当で、ここでは扱っていません（下の「読み取り」）。
- 送出意図の許可（`DispatchPermit`）は worker の世代に結び付き、再起動の後は使えません（ADR 0018）。同じ送出意図の命令を送り直しても再到着として版を返すだけで、許可は出ません（試験で確認）。

## 内容 hash の置き場所

- DB worker は平文を受け取らない（ADR 0018）ため、worker の中では確定 intent から hash を作れません。そこで呼び出し側が `sealOperationIntent(dataKey, { operationId, contentVersion }, intent)` で、正規形（JCS）の UTF-8 のバイト列から content_hash と暗号文を同時に作り、`operation.create` にそのまま渡します。hash と暗号文が別の処理から作られてずれることを防ぎます。
- `openOperationIntent` は復号した平文が正規形であること（正規化し直して同じ文字列になること）と、保存した content_hash と一致することを確かめ、違えば平文を返しません。送出の直前の照合（B04）で使う想定です。
- JSON として表せない値（undefined・関数・BigInt・Date などのオブジェクト・toJSON を持つ値・孤立したサロゲート・有限でない数・疎な配列・65 段以上の入れ子）は黙って落とさずに拒否します。`JSON.stringify` のように落とすと、承認した内容と hash の対象がずれるためです。Unicode の正規化はしません（content-hash-cases.json の label-nfc / label-nfd）。
- canonicalize 5.1.0 を `@buddy/storage` の dependencies に足しました（開発ツールと同じ版で、新しい外部の版は増えていない）。

照合の結果: `content-hash-cases.json` の 11 件すべてで、正規形が手書きの `expected_canonical` と、SHA-256 が shasum で計算した `expected_sha256` と一致しました。H01 は設計 08 §2 の `72c8a8c172bda32f8df7933dca1c490198a0f3670ce03adc40445d55a68b00bf` と一致します。`operation.create` で保存した `operation_versions.content_hash`、承認の hash、再起動の後の照会の hash も同じ値です（`content-hash.test.ts`・`restore.test.ts`）。

## X60 相当の試験の範囲

`packages/storage/src/crash-recovery.test.ts` は、DB を書いているプロセスを書込み transaction の途中で強制終了します（POSIX は SIGKILL、Windows は TerminateProcess。後始末の処理は動かない）。

| 場面               | 内容                                                                                                                                       | 確かめること                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| DB worker          | 子プロセスの DB worker で作成・承認・準備をコミットし、送出意図の transaction の COMMIT の前で止める（試験専用の故障 `stallBeforeCommit`） | `integrity_check` が ok、外部キーの違反なし、準備までの 3 版は残り、送出意図（4 版目）は残らない |
| 大きな transaction | 20 行をコミットし、続く transaction で 64 KiB の行を 60 行書いて（キャッシュを小さくし、ページを WAL へあふれさせる）COMMIT の前で止める   | WAL が伸びていたこと、`integrity_check` が ok、コミット済みの 20 行だけが残り、途中の行は 0 行   |

Core 全体の強制終了は `restore.test.ts` で、起動時の回復の後に CLI の Core を SIGKILL し、古いロックを片付けて再起動できること、DB の記録と store_generation が同じことを確かめます。

**これは電源断の試験ではありません。** プロセスの強制終了では OS のページキャッシュ・ストレージの書込みキャッシュは失われないため、`synchronous=FULL`・`fullfsync` の効き目は確かめていません。電源断・OS の停止（X60 の本体、T07）は本人の環境で別に判断します。

## 読み取り（レビュー対象）

原本に明記がなく、実装で決めた点です。

- **鍵の照合値の置き場所**: 新しい表を足すと表ごとの方針（`TABLE_POLICIES`）と 0001 の表の一致の検査にも手が入るため、`schema_meta` の CHECK を広げる 0002（表の作り直し）にしました。照合値は鍵から一方向に導いた値で、DB から鍵は分かりません。
- **照合値の入力に key_id を含めた**: 同じ鍵でも key_id が違えば別の値になり、key_id の付け替えも検出できます。
- **照合値がないのに暗号文がある DB を拒否**: どの鍵で作った DB か確かめられないため。B02-04 より前に Core が DB を開いた経路はないので、通常は起きません。
- **状態ファイルを消す**: 残すと、DB を消して作り直したときに古い世代を新しい DB へ移してしまいます（設計 07: 新規 DB 作成では世代を更新する）。移行の記録は DB の `store_generation_source`（起動時の出力）とログに残ります。
- **quick_check にした**: `integrity_check` より速く、ページ・b-tree の破損を検出できます。索引と表の内容の食い違いは見ません。DB が大きくなったときの起動時間は未計測です。
- **回復の命令の版**: 回復の命令の依頼・許可・忘却の版は照合しないため、`permission_revision`・`forgetting_generation` に `0` を入れています。受付の照合値（内部の命令の SHA-256）にはそのまま含まれます。
- **承認を使い終えない**: unknown_held へ回した試行の承認は valid のままです。一つの承認を二つの試行に貸し出さない一意制約（0001）は unknown_held を含むため、同じ承認で新しい試行は作れません。
- **Core は鍵を保持しない**: ロックの後に読み直した鍵は照合値の計算にだけ使い、Core の中に残しません。B03 以降で確定 intent を封じるときは、KeyStore から読んだ鍵の照合値が DB と一致することを確かめてから使う必要があります（未実装）。
- **古いバックアップからの復元**: 古い DB のファイルをそのまま戻すと store_generation は変わらず、dispatching が preparing に戻って見える可能性があります。08 §4 はこの場合 preparing を未送出と判断しないことを求めますが、検出（バックアップの世代の更新・復元の手順）は B06 の担当で、今回は検出していません。
- **status の形**: 制御チャネルの status に schema_version・DB の状態を足すと desktop の IPC の契約（ADR 0014）に影響するため、足していません。起動時の `store_opened` の行で確認できます。

## 試験

- `packages/storage/src/content-hash.test.ts`: fixture の全件と H01 の照合、表せない値の拒否、封と復号（別の hash・操作・内容版・鍵・正規形でない平文の拒否）、`operation.create` での保存と読み戻し。
- `packages/storage/src/store-binding.test.ts`: 照合値の期待値（OpenSSL の CLI で別に計算）、初回の保存と以後の一致、別の鍵・key_id・世代・壊れた値の拒否（何も書かない）、状態ファイルの世代の移行と食い違い、暗号文のある照合値なしの DB・0001 だけの DB・0002 の CHECK、壊した DB の健全性の拒否、DB worker の起動での結び付け。
- `packages/storage/src/operation-store.test.ts`: 回復の命令（dispatching だけを unknown_held へ、イベントと受付、再到着、他の状態・試行・版の拒否）。
- `packages/storage/src/crash-recovery.test.ts`（子プロセス `crash-child.ts`）: 上の X60 相当。
- `apps/core/src/restore.test.ts`: 同じプロセスの再起動（操作 ID・内容版・状態版・承認・受付・イベント・store_generation が同じ、dispatching の保留、古い許可・再送で許可が出ないこと、確定 intent の復号）、鍵の拒否と競合、状態ファイルの移行、耐久設定・新しい版の拒否、CLI の強制終了と再起動。
- 既存の `core.test.ts`・`cli.test.ts` は、状態ファイルの代わりに DB が残ることへ合わせた。

期待値は手で書いた値か、契約 fixture・OpenSSL の CLI で別に求めた値で、検査対象の関数から生成していません。

## 残ること

- macOS 実機のキーチェーンでの鍵の作成・読み出しと、Core の起動（鍵保護・耐久設定の検査・再起動で同じ世代）の確認（[docs/b02/device-check.md](../b02/device-check.md)）。記録は本人の確認の後に `tests/integration/evidence-b02-macos.json` へ残す。
- 電源断（X60 の本体・T07）、OS の停止、ストレージの書込みキャッシュの確認。
- preparing の参照確認からの再開・unknown_held の照合・本人の判断（B04）。古いバックアップからの復元の検出（B06）。
- 実行中の DB worker の異常終了で Core をどうするか（今は書込みを止めた状態のまま動き続ける。B03 で受付を拒否する扱いを決める）。
- Core が封じるための鍵の持ち方（上の「Core は鍵を保持しない」）。
- `tests/test-map.json` の product_test は not_run のまま（X60 相当は X60 の合格ではない）。
