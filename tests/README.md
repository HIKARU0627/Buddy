# 試験

開発基盤の試験は scripts/tooling.test.mjs、契約と domain の規則の試験は scripts/*.test.mjs にあります。ここは製品試験の配置先です。

- `test-map.json`: X01〜X66・QA01〜QA45・MA01〜MA06 の担当工程・契約 fixture・実施状態（[ADR 0011](../docs/adr/0011-b00-completion-review.md)）。製品試験の実施状態は `product_test`（`not_run`・`deferred`・`simulated`・`simulated_partial`）で区別し、`not_run` と `contract_fixture` は合格扱いにしません。`contract_fixture` は契約 fixture で期待値を検査しただけで、`simulated` も記載した範囲の模擬だけです（実機・実 API・実請求は含みません）。証拠は `integration/evidence-*.json` にあります。
- `fixtures/`: 合成データと保存案の期待値。
- `integration/`: B04 へ渡す故障点（`fault-points.json`）と証拠の形式（`test-evidence.schema.json`）。

Node.js の標準 test runner を使い、*.test.mjs またはビルド後の *.test.js を pnpm test で実行します。
結果には設計 09 §8 のコミット・契約版・DB 版・故障点・観測結果を記録し、模擬・実機・実 API・実請求を分けます。
