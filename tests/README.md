# 試験

開発基盤の試験は scripts/tooling.test.mjs にあります。ここは製品試験の配置先です。
製品試験 X01〜X66 / QA01〜QA45 は未実装・未実施です。
Node.js の標準 test runner を使い、*.test.mjs またはビルド後の *.test.js を pnpm test で実行します。
結果には設計 09 §8 のコミット・契約版・DB 版・故障点・観測結果を記録します。
