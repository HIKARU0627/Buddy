// 保存層: 表ごとの方針と PRAGMA の読み戻し（ADR 0010）、better-sqlite3 の書込み接続と
// マイグレーションの適用（ADR 0016）、DB worker と操作・承認・受付の保存（ADR 0018）。
// B02-04: 内容 hash（JCS＋SHA-256）と、DB と鍵・世代の結び付け（ADR 0019）。
// db-worker.js は worker の入口なので export しない。
export * from './policy.js';
export * from './errors.js';
export * from './connection.js';
export * from './migrations.js';
// B02-02: sealed_blobs の封筒の暗号化・復号（AES-256-GCM、ADR 0017）。nonce を渡す低水準の関数は出さない。
export * from './sealed-blob.js';
export * from './operation-commands.js';
export * from './operation-store.js';
export type * from './db-protocol.js';
export { DB_WORKER_STALL_MARKER } from './db-protocol.js';
export * from './db-client.js';
export * from './content-hash.js';
export * from './store-binding.js';
// B03-01: 端末と接続範囲（command_scope）の保存（ADR 0020）。
export * from './device-store.js';
