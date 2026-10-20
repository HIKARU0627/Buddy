# @buddy/storage

Core 側の保存アダプターを置きます。B00 では保存案（マイグレーション案）と表ごとの方針だけを作りました（[ADR 0010](../../docs/adr/0010-domain-boundary-and-storage-draft.md)）。

- `migrations/0001_initial.sql`: 設計 03・08・11 の表、一意制約、CHECK、trigger。案であり、本番 DB へ適用した記録ではありません。
- `migrations/connection.sql`: 書込み接続の PRAGMA（WAL・synchronous=FULL・fullfsync）。読み戻しは `pragmaReasons`。
- `src/policy.ts`: 表ごとの本文の置き場所・削除期限・transaction の組と、平文の本文に使ってはいけない列名。
- `src/sealed-blob.ts`: sealed_blobs の封筒の暗号化・復号（[ADR 0017](../../docs/adr/0017-b02-keystore-and-encryption.md)）。`sealBlob(dataKey, plaintext, owner)` は AES-256-GCM（12 バイトの乱数の nonce・16 バイトのタグ）で暗号化し、形式版・key_id・nonce・暗号文・タグを分けて返します。所有者の表・ID・版・用途・形式版・key_id を長さ付きで連結した追加認証データに結び付け、`openBlob` は別の行・版・用途への差替え・改ざん・鍵の取り違え・形式版の不一致を理由を分けて拒否します。`sealWithDataKeyProvider` / `openWithDataKeyProvider` は KeyStore から鍵を取得できなければ暗号化・復号をしません。
- `src/aes-gcm.ts`: node:crypto の AES-256-GCM の薄い包み。nonce を呼び出し側が渡すため、公開出口には出しません。
- `fixtures/aes-256-gcm-cavp.json`: NIST CAVP の GCM のテストベクトル（出典・取得元の SHA-256 を記載）。

検査は `scripts/storage.test.mjs` が開発ツールとして Node 組み込みの `node:sqlite` で行います。封筒の暗号化は `src/*.test.ts`（公開テストベクトルとの照合、改ざんの注入、鍵が取れないときの停止）で試験します。DB worker、better-sqlite3 での適用、sealed_blobs への保存の組み込み（B02-03・04）、削除ジョブ、電源断の耐久性（X60）は未実装・未検証です。KeyStore は `@buddy/platform` にあります。
