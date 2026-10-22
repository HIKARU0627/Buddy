# 統合試験

B00 では期待遷移と故障点（`fault-points.json`）、証拠の形式（`test-evidence.schema.json`）を定義しました（ADR 0011）。実行器は対象の実装へ接続します。
まず B04 の X01〜X11。QA41〜QA45 は設計 09 の対応工程で実行します。
模擬 provider の受信記録を Core 再起動と一緒に消さないでください。

実機の記録は `evidence-<工程>-<端末>.json`（`kind: real_device` だけ）です。B01 は `evidence-b01-macos.json`、B02 は本人の確認の後に `evidence-b02-macos.json` を作ります（手順と case_id は [docs/b02/device-check.md](../../docs/b02/device-check.md)）。X60 相当の故障注入（プロセスの強制終了）は `packages/storage/src/crash-recovery.test.ts` にあり、電源断の試験ではありません。

## B04-06 の実行器

`pnpm run build` の後、`node --test tests/integration/b04.test.mjs` で X01〜X11 の全ケース（X10 は工程の仕組みだけ）と QA27 の実装済み 3 経路・QA28 を確認できます。`pnpm test` / `pnpm run check` にも含みます。17 ケース × 固定 seed 3 個 = 51 回を、関門と異なる順序で実行します。

`b04-cases.mjs` が故障を注入し、`b04-support.mjs` が provider の受信記録（操作・試行・step・回数）と DB の状態履歴・承認・試行・outbox を突き合わせます。期待値は `fault-points.json` の手書きの値だけです。実行器は失敗や未登録のケースを無視しません。

`evidence-b04-simulated.json` は `kind: simulated` の観測結果です。実機のファイルと区別し、`source_sha256` で基点コミットに加えた検査対象の差分も特定します。記録方法・完了条件・制限は [B04 の完了判定](../../docs/b04/README.md)、実機は [device-check.md](../../docs/b04/device-check.md) を参照してください。X10 全体は B14、QA27 の下書き保存は未実装・未実施、表示の移動は B05 です。
