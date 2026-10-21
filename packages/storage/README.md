# @buddy/storage

Core 側の保存アダプターを置きます。B00 で保存案（マイグレーション案）と表ごとの方針を作り（[ADR 0010](../../docs/adr/0010-domain-boundary-and-storage-draft.md)）、B02-01 で better-sqlite3 の書込み接続とマイグレーションの適用を作りました（[ADR 0016](../../docs/adr/0016-b02-sqlite-connection-and-migrations.md)）。

- `migrations/0001_initial.sql`: 設計 03・08・11 の表、一意制約、CHECK、trigger。本番 DB へ適用した記録はありません。
- `migrations/connection.sql`: 書込み接続の PRAGMA（WAL・synchronous=FULL・fullfsync・外部キー・busy_timeout=0）。
- `src/policy.ts`: 表ごとの本文の置き場所・削除期限・transaction の組、平文の本文に使ってはいけない列名、PRAGMA の読み戻しの判定（`pragmaReasons`）。
- `src/connection.ts`: `openWriteConnection(path, { platform })`。DB のディレクトリ・ファイルの権限をそろえ、`connection.sql` を実行して読み戻し、一致しなければ接続を閉じて `StorageError` を投げる。
- `src/migrations.ts`: `applyMigrations(db)`（版の順に 1 版ずつ transaction で適用、新しい版・適用済みの版の内容の変更を拒否）、`readSchemaVersion`、`initStoreGeneration`・`readStoreGeneration`。
- `src/sealed-blob.ts`: sealed_blobs の封筒の暗号化・復号（[ADR 0017](../../docs/adr/0017-b02-keystore-and-encryption.md)）。`sealBlob(dataKey, plaintext, owner)` は AES-256-GCM（12 バイトの乱数の nonce・16 バイトのタグ）で暗号化し、形式版・key_id・nonce・暗号文・タグを分けて返します。所有者の表・ID・版・用途・形式版・key_id を長さ付きで連結した追加認証データに結び付け、`openBlob` は別の行・版・用途への差替え・改ざん・鍵の取り違え・形式版の不一致を理由を分けて拒否します。`sealWithDataKeyProvider` / `openWithDataKeyProvider` は KeyStore から鍵を取得できなければ暗号化・復号をしません。
- `src/aes-gcm.ts`: node:crypto の AES-256-GCM の薄い包み。nonce を呼び出し側が渡すため、公開出口には出しません。
- `fixtures/aes-256-gcm-cavp.json`: NIST CAVP の GCM のテストベクトル（出典・取得元の SHA-256 を記載）。

B02-03 で DB worker と操作・承認・受付の保存、送出の許可の境界を作りました（[ADR 0018](../../docs/adr/0018-b02-db-worker-and-operation-store.md)）。

- `src/operation-commands.ts`: DB worker へ渡す命令の約束（command_id・種類・expected_state_revision・依頼／許可／忘却の版・接続・端末の要求）と結果（durable・accepted・rejected・unknown）。
- `src/operation-store.ts`: worker の中で実行する同期の保存処理 `executeCommand`。1 命令を 1 つの BEGIN IMMEDIATE の transaction で処理し、状態の更新・`event_outbox`・`command_receipts` を同じ transaction で書く。domain の `approvalDecision`・`commandGuard`・`replayDecision`・`canTransition` を使う。照会（`readOperation` など）と大量書込みの区切り（`writeBulkSlice`、50 件または 20ms）。
- `src/db-worker.ts`: worker_threads の入口（index.ts からは export しない）。書込み接続を所有する単一 writer で、外部 HTTP を実行しない。
- `src/db-client.ts`: Core main 側の `DbWorkerClient`（受付 ACK と結果、成否不明の扱い、計測）と `DispatchPermit`（送出意図の COMMIT の成功の後にだけ作り、一度だけ使える）。

B02-04 で内容 hash と、DB と鍵・世代の結び付け、起動時の回復の命令を作りました（[ADR 0019](../../docs/adr/0019-b02-core-storage-integration.md)）。

- `migrations/0002_data_key_check.sql`: `schema_meta` を作り直し、鍵の照合値（`data_key_check:<key_id>`）を置けるようにした。
- `src/content-hash.ts`: 確定 intent の JCS（RFC 8785、canonicalize 5.1.0）の UTF-8 の SHA-256（`intentContentHash`）。JSON として表せない値は拒否する。`sealOperationIntent` は同じ正規形から content_hash と暗号文を作り、`operation.create` にそのまま渡せる。`openOperationIntent` は復号した平文が正規形で hash と一致するときだけ返す。
- `src/store-binding.ts`: `dataKeyCheckValue`（HMAC-SHA256(鍵, 固定の文脈＋key_id)）と `bindStore`（`quick_check`・鍵の照合値の保存／照合・store_generation の移行／照合を一つの transaction で）。DB worker は `binding` を渡されると受付の前にこれを行う。
- `operation.recover_after_restart`: 起動時に dispatching の試行を unknown_held へ回す命令（自動では再送しない）。照会 `interrupted` で preparing・dispatching の操作を読む。
- `src/crash-child.ts`: X60 相当の故障注入の子プロセス（試験専用、export しない）。

B03-01 で端末と接続範囲（command_scope）の命令と照会を作りました（[ADR 0020](../../docs/adr/0020-b03-https-tls-and-route-checks.md)）。

- `src/device-store.ts`: `executeDeviceOp`（worker の中で実行する同期関数）。`device.insert`（ペアリングと試験で端末を入れる）・`device.revoke`（端末と有効な接続範囲を同じ transaction で無効化）・`device.find_by_token_hash`（端末トークンの SHA-256 で引く。結果に hash を含めない）・`scope.issue`（最長 24 時間、同じ端末の有効な接続範囲を無効化）・`scope.find`。書込みは命令ごとに耐久設定を読み戻し、halted の worker は書かない。
- `DbWorkerClient.device(op)`: 操作の命令とは別のメッセージ（`type: 'device'`）で worker へ送る。書込みの応答を失えば成否不明（unknown）。マイグレーションは足していない（0001 の `devices`・`command_scopes`）。

依存は better-sqlite3 13.0.3（ビルド済みバイナリを同梱。pnpm のビルドの許可は不要）、canonicalize 5.1.0（開発ツールと同じ版）と、workspace の `@buddy/domain` です。KeyStore は `@buddy/platform` にあります。

試験は `src/*.test.ts`（一時ファイル・メモリ上の DB、worker_threads の故障注入、公開テストベクトルとの照合・改ざんの注入・鍵が取れないときの停止）と、開発ツールの `node:sqlite` で同じ保存案を検査する `scripts/storage.test.mjs` です。X60 相当（書込み中のプロセスの強制終了の後の整合）は `crash-recovery.test.ts` で確かめています。外部送出（B04）、削除ジョブ、電源断の耐久性（X60 の本体・T07）は未実装・未検証です。
