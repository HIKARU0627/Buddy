# @buddy/storage

Core 側の保存アダプターを置きます。B00 で保存案（マイグレーション案）と表ごとの方針を作り（[ADR 0010](../../docs/adr/0010-domain-boundary-and-storage-draft.md)）、B02-01 で better-sqlite3 の書込み接続とマイグレーションの適用を作りました（[ADR 0016](../../docs/adr/0016-b02-sqlite-connection-and-migrations.md)）。

- `migrations/0001_initial.sql`: 設計 03・08・11 の表、一意制約、CHECK、trigger。本番 DB へ適用した記録はありません。
- `migrations/connection.sql`: 書込み接続の PRAGMA（WAL・synchronous=FULL・fullfsync・外部キー・busy_timeout=0）。
- `src/policy.ts`: 表ごとの本文の置き場所・削除期限・transaction の組、平文の本文に使ってはいけない列名、PRAGMA の読み戻しの判定（`pragmaReasons`）。
- `src/connection.ts`: `openWriteConnection(path, { platform })`。DB のディレクトリ・ファイルの権限をそろえ、`connection.sql` を実行して読み戻し、一致しなければ接続を閉じて `StorageError` を投げる。
- `src/migrations.ts`: `applyMigrations(db)`（版の順に 1 版ずつ transaction で適用、新しい版・適用済みの版の内容の変更を拒否）、`readSchemaVersion`、`initStoreGeneration`・`readStoreGeneration`。

B02-03 で DB worker と操作・承認・受付の保存、送出の許可の境界を作りました（[ADR 0018](../../docs/adr/0018-b02-db-worker-and-operation-store.md)）。

- `src/operation-commands.ts`: DB worker へ渡す命令の約束（command_id・種類・expected_state_revision・依頼／許可／忘却の版・接続・端末の要求）と結果（durable・accepted・rejected・unknown）。
- `src/operation-store.ts`: worker の中で実行する同期の保存処理 `executeCommand`。1 命令を 1 つの BEGIN IMMEDIATE の transaction で処理し、状態の更新・`event_outbox`・`command_receipts` を同じ transaction で書く。domain の `approvalDecision`・`commandGuard`・`replayDecision`・`canTransition` を使う。照会（`readOperation` など）と大量書込みの区切り（`writeBulkSlice`、50 件または 20ms）。
- `src/db-worker.ts`: worker_threads の入口（index.ts からは export しない）。書込み接続を所有する単一 writer で、外部 HTTP を実行しない。
- `src/db-client.ts`: Core main 側の `DbWorkerClient`（受付 ACK と結果、成否不明の扱い、計測）と `DispatchPermit`（送出意図の COMMIT の成功の後にだけ作り、一度だけ使える）。

依存は better-sqlite3 13.0.3（ビルド済みバイナリを同梱。pnpm のビルドの許可は不要）と、workspace の `@buddy/domain` です。

試験は `src/*.test.ts`（一時ファイル・メモリ上の DB、worker_threads の故障注入）と、開発ツールの `node:sqlite` で同じ保存案を検査する `scripts/storage.test.mjs` です。Core への組み込みと再起動の復元（B02-04）、暗号化と OS の KeyStore（B02-02）、外部送出（B04）、削除ジョブ、電源断の耐久性（X60）は未実装・未検証です。
