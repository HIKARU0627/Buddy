# @buddy/storage

Core 側の保存アダプターを置きます。B00 では保存案（マイグレーション案）と表ごとの方針だけを作りました（[ADR 0010](../../docs/adr/0010-domain-boundary-and-storage-draft.md)）。

- `migrations/0001_initial.sql`: 設計 03・08・11 の表、一意制約、CHECK、trigger。案であり、本番 DB へ適用した記録ではありません。
- `migrations/connection.sql`: 書込み接続の PRAGMA（WAL・synchronous=FULL・fullfsync）。読み戻しは `pragmaReasons`。
- `src/policy.ts`: 表ごとの本文の置き場所・削除期限・transaction の組と、平文の本文に使ってはいけない列名。

検査は `scripts/storage.test.mjs` が開発ツールとして Node 組み込みの `node:sqlite` で行います。DB worker、better-sqlite3 での適用、暗号化と OS の KeyStore、削除ジョブ、電源断の耐久性（X60）は未実装・未検証です。
