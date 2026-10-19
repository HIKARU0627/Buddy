# 契約の検証データ

- `schema-cases.json`: スキーマ名・期待する正常／拒否と合成入力。`contracts:check` で実行します。
- `h01.json`: 設計 08 にある合成ラベル変更と独立した期待 SHA-256。期待値を実装から再生成しません。
- `content-hash-cases.json`: 内容 hash の差分ケース。正規形は手書き、SHA-256 は OS の shasum で計算し、実装から生成していません。
- `workflow-label.json`: 実行境界の期待結果。`specification_only` で、DB・外部処理の実行済み記録ではありません。

追加の生JSON・JCS・入力根拠・局所的な費用不変条件は `scripts/contracts.test.mjs` で確認します。実データ・認証情報・個人予算を置きません。
