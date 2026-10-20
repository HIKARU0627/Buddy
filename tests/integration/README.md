# 統合試験

B00 では期待遷移と故障点（`fault-points.json`）、証拠の形式（`test-evidence.schema.json`）を定義しました（ADR 0011）。実行器は対象の実装へ接続します。
まず B04 の X01〜X11。QA41〜QA45 は設計 09 の対応工程で実行します。
模擬 provider の受信記録を Core 再起動と一緒に消さないでください。

実機の記録は `evidence-<工程>-<端末>.json`（`kind: real_device` だけ）です。B01 は `evidence-b01-macos.json`、B02 は本人の確認の後に `evidence-b02-macos.json` を作ります（手順と case_id は [docs/b02/device-check.md](../../docs/b02/device-check.md)）。X60 相当の故障注入（プロセスの強制終了）は `packages/storage/src/crash-recovery.test.ts` にあり、電源断の試験ではありません。
