# ADR 0016: SQLite の接続・マイグレーション・耐久設定の検査

- 日付: 2026-10-20
- 状態: B02-01（#53）の判断と実装。`packages/storage` に better-sqlite3 の書込み接続（PRAGMA の設定と読み戻し）、マイグレーションの適用、store_generation の読み書きを作り、一時ファイルとメモリ上の DB で試験した（模擬。CI の 3 OS）。DB worker（B02-03）、暗号化と KeyStore（B02-02）、Core への組み込み（B02-04）、電源断の耐久性の試験（X60）は対象外で未実施。
- 根拠: 設計 08 §3・§5、11 §9、02 保存と秘密情報・技術比較、03 保存と秘密情報（DB スキーマの版）、06 B02、ADR 0010。better-sqlite3 を 13.0.3 で固定することは本人の決定。今回の作業環境では設計本文を `.local/design/notion/` に取得できなかったため、司令塔から受け取った要約に基づく。原本との照合はレビューで行う。

## 決めたこと

| 対象                 | 決定                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 書込み接続           | `openWriteConnection(path, { platform })` は DB ファイルを準備し、`migrations/connection.sql` を実行し、PRAGMA を読み戻す。一つでも違えば接続を閉じて `StorageError('write_connection_rejected')` を投げ、書込みを始めさせない                               |
| 読み戻す PRAGMA      | `pragmaReasons`（ADR 0010）の journal_mode=WAL・synchronous=FULL（2）・macOS の fullfsync=1・foreign_keys=1 に、busy_timeout=0（11 §9）を足した（`busy_timeout_not_zero`）。better-sqlite3 の既定の待ち時間（5 秒）は `timeout: 0` で使わない                |
| ファイルと権限       | DB のパスは絶対パスだけ（`file:` の URI・空文字は拒否）。POSIX ではディレクトリを 0700、DB・`-wal`・`-shm` を 0600 にそろえ、所有者が実行中の利用者と違えば拒否する。DB ファイルのシンボリックリンクは拒否する。Windows は既定の ACL に任せる（Core と同じ） |
| マイグレーションの形 | `migrations/NNNN_名前.sql`（4 桁、英小文字・数字・`_`）。版は 1 から欠番なく続く。`connection.sql`・README は対象外                                                                                                                                          |
| 適用                 | 版の順に 1 版ずつ BEGIN IMMEDIATE の transaction で実行し、同じ transaction で `schema_version` と `migration_sha256:NNNN` を書き、`PRAGMA foreign_key_check` が空であることを確かめる。失敗すれば transaction ごと巻き戻し、版を進めない                    |
| 版の拒否             | DB の版がコードの最新より新しければ何も変えずに拒否する（`schema_newer_than_code`、ダウングレードしない）。schema_meta のない既存の DB（`unknown_database`）・読めない版（`schema_version_invalid`）も拒否する                                               |
| 内容の変更の拒否     | 適用済みの版のファイルの SHA-256 が記録と違えば、未適用の版も含めて何も適用せずに拒否する（`migration_changed`）。記録がなければ `migration_hash_missing`。ハッシュは改行を LF にそろえてから計算する                                                        |
| transaction の制御   | マイグレーションに COMMIT・ROLLBACK・SAVEPOINT・RELEASE・BEGIN TRANSACTION など・VACUUM・ATTACH・journal_mode を書かない（読み込み時に拒否）。trigger の END と区別できない単独の END は、実行後に transaction が終わっていれば拒否して版を進めない          |
| store_generation     | `initStoreGeneration(db, initial?)` は値がなければ `initial`（既定は新しい UUID）で作り、あれば既存の値を返す（書き換えない）。`readStoreGeneration` は値がなければ null、形が壊れていれば拒否する                                                           |
| 0001 の変更          | `schema_meta.key` の CHECK に `migration_sha256:NNNN` を足した（下の「0001 の変更」）。ほかの表・制約は変えていない                                                                                                                                          |

拒否の理由コード（`StorageError.reason`）にはパス・SQL・本文を入れません。

## 版とビルドの許可

| パッケージ            | 版     | 備考                                                                                                                                          |
| --------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| better-sqlite3        | 13.0.3 | 本人の決定。2026-08-05 公開で pnpm 12 の公開後の経過期間の方針を満たす。同梱の SQLite は 3.53.4                                               |
| @types/better-sqlite3 | 9.6.0  | 2026-08-01 公開の最新。13 系の API（`Database`・`prepare`・`transaction().immediate()`・`pragma(…, { simple: true })`）の範囲で型が合っている |
| node-addon-api        | 8.9.2  | better-sqlite3 の依存（lockfile で固定）                                                                                                      |

**ビルドの許可は設定していません。** better-sqlite3 13 は Node-API のビルド済みバイナリ（`prebuilds/` の linux・linuxmusl・darwin・win32 の x64 / arm64）を npm パッケージに同梱し、`gypfile: false` で install 時のスクリプトを持ちません。pnpm 12.11.2 で確かめたこと:

- `pnpm install` は better-sqlite3 をビルドが必要なパッケージとして扱わず（`.modules.yaml` の `pendingBuilds` が空）、ビルドも警告もしない。
- pnpm 12 のビルドの許可の設定項目は `pnpm-workspace.yaml` の `allowBuilds`（パッケージ名 → true / false）。許可していないパッケージに install 時のスクリプトがあると、install が `Ignored build scripts` で失敗する（install スクリプトを持つ別のパッケージで確かめた）。

そのため最小の許可は「何も許可しない」です。`allowBuilds: { better-sqlite3: true }` を書くと、将来の版が install 時のスクリプトを持ったときに黙って実行されるため書きません。`false` も書きません（将来スクリプトが加わったときに install が失敗し、レビューの対象になるようにするため）。公開後の経過期間の方針を弱める設定（`minimumReleaseAgeExclude` など）も足していません。

CI の 3 OS（ubuntu-latest の x64・windows-latest の x64・macos-latest の arm64）は同梱のバイナリを読み込むだけで、コンパイラ・Python・ネットワークからの取得は要りません。linux-x64 のバイナリは glibc 2.34 以上を要求します（ubuntu-latest は満たす）。ローカル（macOS arm64、Node.js 24.19.0）ではクリーンな状態からの `pnpm install --frozen-lockfile` と試験を確かめました。Windows・Linux は CI で確かめます。CI の設定（.github/workflows/ci.yml）の変更は不要です。

## 耐久設定の検査

- `connection.sql` の順（journal_mode=WAL → synchronous=FULL → fullfsync=ON → foreign_keys=ON → busy_timeout=0）で設定し、接続ごとに読み戻します。
- この SQLite は `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` でビルドされています。WAL のファイルを開き直すと、synchronous を明示しない限り NORMAL になります（試験で確認）。接続の作成のたびに設定と読み戻しが要る理由で、`connection.sql` から synchronous を外したり NORMAL へ下げたりしないでください。
- 試験では、設定の後に synchronous を NORMAL・OFF に、fullfsync・foreign_keys を OFF に、busy_timeout を 5000 に、journal_mode を DELETE に変えた接続、WAL だけを設定して開き直した接続、`:memory:`（journal_mode が memory）を注入し、拒否と理由を確かめます。拒否した接続は閉じ、DB に何も書かれていないことも確かめます。
- 読み戻しの一致は、OS・VFS・ストレージの同期が正しいことを前提にした設定の確認です。電源断で記録が残ることの証明ではなく、X60（電源断相当の試験）は未実施です。

## 0001 の変更

適用済みの版の内容の変更を検出するには、版ごとのハッシュを DB に残す必要があります。保存案 0001 の `schema_meta.key` は CHECK で `schema_version`・`store_generation` だけを受け付けていたため、`key GLOB 'migration_sha256:[0-9][0-9][0-9][0-9]'` を足しました。別の表を足す案は、表ごとの方針（`TABLE_POLICIES`）と 0001 の表の一致の検査にも手を入れることになるため採りませんでした。0001 はまだどの DB にも適用した記録がない案なので、内容を変えても既存の DB は壊れません。今後、0001 を含む適用済みの版は変更せず、新しい版を足します。

## 試験

`packages/storage/src/*.test.ts`（ビルド後の `dist/*.test.js` を `pnpm test` で実行）。

- `connection.test.ts`: 読み戻しの一致、不一致の注入（上記）、`:memory:` の拒否、パスの形、POSIX の権限（0700・0600、`-wal`・`-shm` を含む）、シンボリックリンクの拒否、OS 名の写し方。
- `migrations.test.ts`: 一時ファイルの DB に 0001 を適用（42 表がすべて STRICT、版 1、内容のハッシュ、`foreign_key_check`・`integrity_check`）、開き直しと二重適用で何も変わらない（定義・schema cookie・schema_meta）、新しい版の拒否、途中失敗（壊れた SQL を注入）の巻き戻し、内容の変更・ハッシュの欠落の拒否、CRLF の扱い、ファイル名と欠番、transaction の制御文、store_generation。
- `storage-cases.test.ts`: `tests/fixtures/storage-cases.json` の制約のシナリオ（20 件）を better-sqlite3 で実行する。`scripts/storage.test.mjs`（node:sqlite）は残し、同じ fixture を二つの SQLite で確かめる。

期待値（表の数・版・PRAGMA の値・理由・合成のマイグレーションのハッシュ）は手で書きました。0001 のハッシュは試験側でファイルの生のバイトから計算し、適用の実装から生成していません。DB は一時ディレクトリかメモリ上に作り、試験の終わりに消します。

## 読み取り（レビュー対象）

- **busy_timeout の読み戻し**: 11 §9 の busy_timeout=0 は耐久設定ではありませんが、better-sqlite3 の既定（5 秒）が残ると書込みが SQLITE_BUSY を待ってしまうため、読み戻しの対象に足しました。
- **既存の権限を直す**: 既存のディレクトリ・ファイルの権限が広ければ拒否せずに 0700・0600 へ直します（Core のデータディレクトリと同じ扱い）。所有者が違う場合とシンボリックリンクは拒否します。
- **CRLF の扱い**: `.gitattributes` で LF にそろえていますが、改行だけが違う checkout を内容の変更と扱わないよう、ハッシュは LF にそろえてから計算します。改行以外の 1 バイトの違いは変更として拒否します。
- **単独の END**: trigger の `BEGIN … END;` と区別できないため、読み込み時には拒否できません。実行後に transaction が終わっていれば拒否して版を進めませんが、END より前の文は確定してしまいます（次の適用は失敗し、手で直す必要がある）。マイグレーションはレビューで確認します。
- **store_generation の書き換え**: 復元・新規作成での世代の更新は B06 の担当なので、既存の値を書き換える関数は作っていません。
- **`:memory:`**: 試験のため `openWriteConnection(':memory:')` はファイルの準備を飛ばし、journal_mode の読み戻しで拒否されます。

## 残ること

- 電源断・同時書込み・再起動を含む耐久性の試験（X60・T07）は未実施です。
- 非同期の DB worker と単一 writer のキュー、SQLITE_BUSY のキューへの差し戻しは B02-03 です。
- Core への組み込み（起動時の接続・適用・store_generation の `core-state.json` からの移行）と再起動の復元は B02-04 です。起動時の PRAGMA の不一致で外部変更を開始しない扱いも B02-04 で Core に組み込みます。
- 暗号化（sealed_blobs）と KeyStore は B02-02 です。
- Windows の DB ファイルの ACL の検査、共有フォルダー・ネットワークドライブ上の DB の検出はしていません。
