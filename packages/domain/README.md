# @buddy/domain

承認・状態遷移・通知・忘却・予算などの規則と境界仕様を置きます。
storage / Core / Electron / OS 固有 API に依存しません。

B00 時点の内容（[ADR 0004](../../docs/adr/0004-intent-table-and-readiness.md)）:

- `intents.ts`: 24 意図ごとの経路（Read / LocalCommand / RemoteMutation）・承認・方式 C の可否・必須と許可の引数
- `readiness.ts`: 変更を伴う意図の実行可否（blocked / needs_approval / auto_eligible）を決める純粋関数
- `operations.ts`: 操作の内部状態と許される遷移（設計 08 §3・§4）

contracts の生成型は import せず、意図名・引数名の一覧が schema と一致することを `scripts/domain.test.mjs` で検査します。試験はビルド後の `dist` を対象にします。DB の transaction・最終検査・外部送出は未実装です。
