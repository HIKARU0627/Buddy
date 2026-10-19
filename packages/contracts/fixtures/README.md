# 契約の検証データ

- `schema-cases.json`: スキーマ名・期待する正常／拒否と合成入力。`contracts:check` で実行します。
- `h01.json`: 設計 08 にある合成ラベル変更と独立した期待 SHA-256。期待値を実装から再生成しません。
- `content-hash-cases.json`: 内容 hash の差分ケース。正規形は手書き、SHA-256 は OS の shasum で計算し、実装から生成していません。
- `readiness-cases.json`: 変更を伴う意図の実行可否の期待値（QA41 ほか）。手書きの表で、domain の実装から生成していません。
- `operation-transitions.json`: X01〜X11 の操作の期待遷移。実行済みの記録ではありません。
- `audio-control-cases.json`: 停止理由ごとの動作と再開条件の期待値（設計 10 §1A）。
- `delivery-cases.json`: 古い世代・端末・出力先へ遅れて届いた結果の受け入れの期待値。
- `session-control-phrases.json`: 会話の操作の照合表の例と照合の期待値（X58）。
- `workflow-label.json`: 実行境界の期待結果。`specification_only` で、DB・外部処理の実行済み記録ではありません。

追加の生JSON・JCS・入力根拠・局所的な費用不変条件は `scripts/contracts.test.mjs` で確認します。実データ・認証情報・個人予算を置きません。
