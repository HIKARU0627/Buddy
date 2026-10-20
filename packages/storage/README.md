# @buddy/storage

Core 側の保存アダプターを置きます。B00 で保存案（マイグレーション案）と表ごとの方針を作り（[ADR 0010](../../docs/adr/0010-domain-boundary-and-storage-draft.md)）、B02-01 で better-sqlite3 の書込み接続とマイグレーションの適用を作りました（[ADR 0016](../../docs/adr/0016-b02-sqlite-connection-and-migrations.md)）。

- `migrations/0001_initial.sql`: 設計 03・08・11 の表、一意制約、CHECK、trigger。本番 DB へ適用した記録はありません。
- `migrations/connection.sql`: 書込み接続の PRAGMA（WAL・synchronous=FULL・fullfsync・外部キー・busy_timeout=0）。
- `src/policy.ts`: 表ごとの本文の置き場所・削除期限・transaction の組、平文の本文に使ってはいけない列名、PRAGMA の読み戻しの判定（`pragmaReasons`）。
- `src/connection.ts`: `openWriteConnection(path, { platform })`。DB のディレクトリ・ファイルの権限をそろえ、`connection.sql` を実行して読み戻し、一致しなければ接続を閉じて `StorageError` を投げる。
- `src/migrations.ts`: `applyMigrations(db)`（版の順に 1 版ずつ transaction で適用、新しい版・適用済みの版の内容の変更を拒否）、`readSchemaVersion`、`initStoreGeneration`・`readStoreGeneration`。

依存は better-sqlite3 13.0.3（ビルド済みバイナリを同梱。pnpm のビルドの許可は不要）です。

試験は `src/*.test.ts`（一時ファイル・メモリ上の DB）と、開発ツールの `node:sqlite` で同じ保存案を検査する `scripts/storage.test.mjs` です。DB worker（B02-03）、Core への組み込み（B02-04）、暗号化と OS の KeyStore（B02-02）、削除ジョブ、電源断の耐久性（X60）は未実装・未検証です。
