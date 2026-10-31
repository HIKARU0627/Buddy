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
// B03-02: ペアリング・端末の一覧・証明書の変更による失効（ADR 0021）。
export * from './pairing-store.js';
// B03-04: スナップショット・イベントの照会（ADR 0023）。
export * from './snapshot-store.js';
export * from './event-store.js';
// B03-03: 自宅の登録値と端末ごとの最新の報告（ADR 0022）。
export * from './home-network-store.js';
export * from './conversation-store.js';
// B07-03: 予算の受付・精算・超過の承認・利用状況・予算月の保存（ADR 0036、マイグレーション 0006）。
export * from './budget-store.js';
export * from './voice-store.js';
// B06-06b: 派生物の系譜（ADR 0048、マイグレーション 0010）。
export * from './derivation-store.js';
// B06-06c: 終わった操作の本文の削除・90 日の削除・用事の正本の分離（ADR 0051、マイグレーション 0011）。
export * from './retention-store.js';
export * from './task-content.js';
// B06-06d2: 忘却の transaction・台帳の別ファイル・記憶の命令・復元の後の保留の書き込み（ADR 0054、マイグレーション 0012）。
export * from './forget-store.js';
export * from './forget-ledger-file.js';
export * from './memory-store.js';
export * from './restore-aftermath-store.js';
