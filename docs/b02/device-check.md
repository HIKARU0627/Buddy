# B02 の実機確認（macOS）

B02 の完了条件のうち、実機でしか確かめられないもの（キーチェーンのデータ鍵・Core の起動での鍵保護と耐久設定の検査・再起動で同じ store_generation）の手順と記録の形式です。CI の試験は模擬の KeyStore だけで、実機のキーチェーンに書き込みません。結果は 09 §8 の形式（`tests/integration/test-evidence.schema.json`、`kind: real_device`）で `tests/integration/evidence-b02-macos.json` に残します（本人の確認の後に司令塔が作る）。

## 状況

| 確認                                    | 端末                 | 状態                                             | 記録                      |
| --------------------------------------- | -------------------- | ------------------------------------------------ | ------------------------- |
| キーチェーンへの鍵の作成・読み出し（A） | macOS（MacBook Air） | 期待どおり（2026-10-21）                         | `evidence-b02-macos.json` |
| Core の起動・DB の作成（B）             | macOS（MacBook Air） | 期待どおり（2026-10-21）                         | `evidence-b02-macos.json` |
| 再起動で同じ store_generation（C）      | macOS（MacBook Air） | 期待どおり（2026-10-21。強制終了の後の再起動も） | `evidence-b02-macos.json` |
| 後片付け（D・任意）                     | macOS                | 行っていない（DB と鍵は残してある）              | —                         |

中枢は初期版では macOS だけです（Windows・Linux の `start` は鍵保護が使えないとして拒否されるのが期待どおりの動作）。中枢の Mac mini での確認が済むまでは、開発機の結果は参考として扱います。

## 準備

リポジトリのルートで main を最新にし、ビルドします。

```sh
git switch main
git pull --ff-only
pnpm install --frozen-lockfile
pnpm run build
```

**B01 の確認で使ったデータディレクトリ（`~/Library/Application Support/Buddy/core`）をそのまま使います。** `core-state.json` が残っていれば、初回の起動でその store_generation が DB へ移り、状態ファイルは消えます。B01 の A2 で控えた `store_generation` があれば手元に用意してください（控えていなければ B の結果を基準にします）。

## A. キーチェーンのデータ鍵（ADR 0017）

手順は [packages/platform/README.md](../../packages/platform/README.md) の「実機での確認」の 1〜4 です。鍵の値は画面に出さず、記録にも写しません。

| #   | 操作                                                                                                          | 期待する結果                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A1  | `security find-generic-password -s dev.buddy.core -a data-key-v1 >/dev/null && echo exists \|\| echo missing` | 初めてなら `missing`（B01 以降に作っていれば `exists`）                                         |
| A2  | README の手順 3 の node のコマンド                                                                            | `{"ok":true,"created":...,"keyId":"data-key-v1","length":32}`（初めてなら `created` が `true`） |
| A3  | 同じコマンドをもう一度                                                                                        | `created` が `false`                                                                            |

## B. Core の起動と DB（ターミナルを 2 つ）

| #   | 操作                                                                 | 期待する結果                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | ターミナル 1: `node apps/core/dist/cli.js start`                     | `{"event":"store_opened",...}` の後に `{"event":"running",...}`。`schema_version` が 2、`data_key_check` が `stored`（初回）、`store_generation_source` が `state_file`（B01 の状態ファイルがあった）か `created`（なかった） |
| B2  | ターミナル 2: `node apps/core/dist/cli.js status`                    | `state: running`。`store_generation` が B1 と同じ（B01 の値を控えていれば、それとも同じ）                                                                                                                                     |
| B3  | ターミナル 2: `ls -l "$HOME/Library/Application Support/Buddy/core"` | `buddy.sqlite`（と `-wal`・`-shm`）が `-rw-------`、`core-state.json` がない                                                                                                                                                  |
| B4  | ターミナル 2: `node apps/core/dist/cli.js stop`                      | `{"ok":true,"state":"stopped",...}`。ターミナル 1 に `{"event":"stopped","ok":true,...}`                                                                                                                                      |

B1 が鍵保護の検査（キーチェーンから鍵を取得できること）と、DB の耐久設定の検査（WAL・synchronous=FULL・fullfsync の読み戻し）に通ったことの確認です。通らなければ `{"event":"refused",...}` と理由（例 `key_protection_unavailable:keystore_read_failed`・`write_connection_rejected`）が出て、終了コードが 5 または 4 になります。その場合は理由をそのまま伝えてください。

## C. 再起動で同じ store_generation

| #   | 操作                                              | 期待する結果                                                                                                              |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| C1  | ターミナル 1: `node apps/core/dist/cli.js start`  | `store_opened` の `store_generation` が B1 と同じ、`store_generation_source` が `database`、`data_key_check` が `matched` |
| C2  | ターミナル 2: `node apps/core/dist/cli.js status` | `store_generation` が B1 と同じ。`core_instance_id` は B2 と違う                                                          |
| C3  | ターミナル 2: `node apps/core/dist/cli.js stop`   | 停止する                                                                                                                  |

任意: C1 の Core をターミナル 2 から `kill -9 <pid>`（`pid` は `status` の値）で強制終了した後にもう一度 `start` し、古いロックを片付けて起動できること、`store_generation` が同じことを確かめます。

## D. 後片付け（任意）

- 確認用のデータを残さない場合は、Core を止めてから `~/Library/Application Support/Buddy/core` の `buddy.sqlite`・`buddy.sqlite-wal`・`buddy.sqlite-shm` を消します。次の起動では新しい store_generation の DB が作られます（B01 の状態ファイルは B1 で消えているため、古い世代には戻りません）。
- キーチェーンのデータ鍵（`security delete-generic-password -s dev.buddy.core -a data-key-v1`）は、DB を消した後だけ消してください。DB を残したまま鍵を消すと、次の起動は鍵の照合値が合わず `data_key_mismatch` で拒否されます（新しい鍵で上書きされた DB を開かないための動作）。
- `--mock-key-protection` で起動した DB は模擬の鍵（公開の値）に結び付き、実機の鍵では開けません（逆も同じ）。実機の確認には模擬の指定を付けないでください。

## 記録の形式

各項目が期待どおりか、違った点を伝えてもらい、司令塔が `tests/integration/evidence-b02-macos.json` に写します。B01 の `evidence-b01-macos.json` と同じく、`{ "status": "recorded", "description": ..., "records": [...] }` の `records` に 1 項目 1 件で、09 §8 の項目をすべて埋めます。

| case_id                   | 対応   | `final_state` の例                                          |
| ------------------------- | ------ | ----------------------------------------------------------- |
| `B02-mac-keychain-create` | A1〜A2 | `created（キーチェーンにデータ鍵）`                         |
| `B02-mac-keychain-read`   | A3     | `read（created: false）`                                    |
| `B02-mac-core-start-db`   | B1〜B4 | `running（鍵保護・耐久設定の検査に通過、schema_version 2）` |
| `B02-mac-core-restart`    | C1〜C3 | `running（同じ store_generation、data_key_check matched）`  |

- `kind` は `real_device`、`commit` は確認したビルドのコミット、`db_version` は `2`、`environment.os` は macOS の版、`environment.hub` は機種（中枢の Mac mini か開発機か）、`provider_requests`・`provider_state_changes`・`approvals` は 0、`seed`・`fault_point`・`voice_stop_ms` は null。
- store_generation・core_instance_id・パス・鍵の値は記録しません（同じだったか違ったかだけを書く）。メール本文・音声・鍵は扱いません。
- 模擬の試験（CI）の結果をこのファイルに混ぜません（`scripts/test-map.test.mjs` が `kind: real_device` 以外を拒否する）。
