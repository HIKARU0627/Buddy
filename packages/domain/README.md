# @buddy/domain

承認・状態遷移・通知・忘却・予算などの規則と境界仕様を置きます。
storage / Core / Electron / OS 固有 API に依存しません。

B00 時点の内容（[ADR 0004](../../docs/adr/0004-intent-table-and-readiness.md)）:

- `intents.ts`: 24 意図ごとの経路（Read / LocalCommand / RemoteMutation）・承認・方式 C の可否・必須と許可の引数
- `readiness.ts`: 変更を伴う意図の実行可否（blocked / needs_approval / auto_eligible）を決める純粋関数
- `operations.ts`: 操作の内部状態と許される遷移（設計 08 §3・§4）
- `audio.ts`: 停止理由ごとの動作と再開条件、遅着した結果の受け入れ、出力先の決定（[ADR 0005](../../docs/adr/0005-conversation-and-voice-control.md)）
- `conversation.ts`: 意図ごとの結果表示、会話の操作の照合
- `sync.ts`: 同期の走査の排他、公開前の compare-and-swap、時計の後退の保留（[ADR 0007](../../docs/adr/0007-sync-extraction-and-related-analysis.md)）
- `extraction.ts`: モデル出力の期限の変換、候補起点の自動実行の共通検査と操作ごとの検査
- `analysis.ts`: 関連集合の ready 判定、取消・完了の順序に依存しない解決、自動作成の一度だけの制限
- `budget.ts`: 予約 R・最大負担 M による受付、追加予約、一度だけの精算、usage 不明の保持、未送信の解放（[ADR 0006](../../docs/adr/0006-budget-reservation-and-liability.md)）

contracts の生成型は import せず、意図名・引数名の一覧が schema と一致することを `scripts/domain.test.mjs`・`scripts/voice.test.mjs`・`scripts/budget.test.mjs`・`scripts/sync-analysis.test.mjs` で検査します。試験はビルド後の `dist` を対象にします。DB の transaction・最終検査・外部送出は未実装です。
