# 統合試験

B00 では期待遷移と故障点（`fault-points.json`）、証拠の形式（`test-evidence.schema.json`）を定義しました（ADR 0011）。実行器は対象の実装へ接続します。
まず B04 の X01〜X11。次に B07 の予算（X18・QA42・QA20・X53 と同時予約・月替わり・失敗・精算の重複）。QA41〜QA45 は設計 09 の対応工程で実行します。
模擬 provider の受信記録を Core 再起動と一緒に消さないでください。

実機の記録は `evidence-<工程>-<端末>.json`（`kind: real_device` だけ）です。B01 は `evidence-b01-macos.json`、B02 は本人の確認の後に `evidence-b02-macos.json` を作ります（手順と case_id は [docs/b02/device-check.md](../../docs/b02/device-check.md)）。X60 相当の故障注入（プロセスの強制終了）は `packages/storage/src/crash-recovery.test.ts` にあり、電源断の試験ではありません。

## B04-06・07 の実行器

`pnpm run build` の後、`node --test tests/integration/b04.test.mjs` で X01〜X11 の全ケース（X10 は工程の仕組みだけ）、外部の下書きの保存の X05（送出の後）・X06・X07・X08、QA27 の 3 経路（予定・用事・下書き）と全経路の権限・期限、QA28 を確認できます。`pnpm test` / `pnpm run check` にも含みます。23 ケース × 固定 seed 3 個 = 69 回を、関門と異なる順序で実行します。

`b04-cases.mjs` が故障を注入し、`b04-support.mjs` が provider の受信記録（操作・試行・step・回数）と DB の状態履歴・承認・試行・outbox を突き合わせます。下書きの保存のケースは、provider の真の下書き（宛先・件名・本文・返信元・目印）と確定 intent の hash も照合します。期待値は `fault-points.json` の手書きの値だけです。実行器は失敗や未登録のケースを無視しません。

`evidence-b04-simulated.json` は `kind: simulated` の観測結果です。実機のファイルと区別し、`source_sha256` で基点コミットに加えた検査対象の差分も特定します。対象は実行器（`b04*.mjs`）が実際に読み込むファイル・解決に使った package.json・期待値と fixture だけで、import を機械的に辿って集めます（`scripts/b04-evidence-sources.mjs`）。記録方法・完了条件・制限は [B04 の完了判定](../../docs/b04/README.md)、実機は [device-check.md](../../docs/b04/device-check.md) を参照してください。X10 全体は B14、表示の移動は B05 です。QA27 の下書きの保存は B04-07 で模擬で実施しました（実機・本物の OS 確認ダイアログ・Electron の画面の操作は未実施）。

## B07-06 の実行器

`pnpm run build` の後、`node --test tests/integration/b07.test.mjs` で、予算の門（`apps/core` の `BudgetGate`）・DB worker・一時ディレクトリの DB・模擬の有料 provider をつないだ 18 ケース（X18 の同時の予約・超過枠・追加予約、QA42 の受付の上限・usage の重複と欠落・timeout・月替わり・M 超過の保留・承認のない超過枠・音声の予算から融通しない、QA20 の単価の境界と上限が不明、X53 の自発の枠、設定ファイルの実行時の読み込み、失敗・精算の重複・再起動の照合）を確認できます。`pnpm test` / `pnpm run check` にも含みます。18 ケース × 固定 seed 3 個 = 54 回を、関門と異なる順序で実行します。

`b07-cases.mjs` が各ケースを実行し、`b07-support.mjs` が予約の行（SQL で直接読む）と provider の受信の記録・真の usage を突き合わせます。期待値は `b07-expectations.json` の手書きの値だけで、合成の通貨 XTS と縮めた上限だけを使います（個人の金額・単価・為替は入れない）。実行器は失敗や未登録のケースを無視しません。

`evidence-b07-simulated.json` は `kind: simulated` の観測結果で、`source_sha256` の対象は実行器が読み込むファイルだけです（`scripts/b07-evidence-sources.mjs`。B04 と共通の集め方は `scripts/evidence-sources.mjs`）。記録方法・完了条件・制限は [B07 の完了判定](../../docs/b07/README.md) を参照してください。実 API・実請求・実機・HTTP の経路・画面は未実施で、実請求の照合は B15 です。

## B05-07 の実行器

`pnpm run build` の後、`node --test tests/integration/b05.test.mjs` で、端末側（デスクトップの `VoiceController`・`DesktopDeviceController`・模擬の音声レンダラーと合成の PCM）と中枢側（`VoiceControl`・DB worker・予算の門・模擬の Live の provider・会話の処理）を、1 本の手で進める時計でつないだ 16 ケース（X13・X14・X25・X27・X30・X49・X51・X58・QA24・QA41・QA43）を確認できます。`pnpm test` / `pnpm run check` にも含みます。16 ケース × 固定 seed 3 個 = 48 回を、関門と異なる順序で実行します。

`b05-world.mjs` が世界（端末と中枢のつなぎ。HTTP・WSS・Electron・マイク・WebRTC・実 API は通さず、中枢の入口を直接呼ぶ）、`b05-conversation.mjs` が会話の処理のつなぎ、`b05-cases*.mjs` がケース、`b05-observe.mjs` が観測の共通部品、`b05-support.mjs` が突き合わせの規則（端末が送った命令の世代の後退・存在しない Live の開始・provider 自身の真の使用時間と精算の食い違い・送出意図のある予約の解放・音声の枠の上限）です。期待値は `b05-expectations.json` の手書きの値だけで、実装の処理から作りません。実行器は失敗や未登録のケースを無視しません。

`evidence-b05-simulated.json` は `kind: simulated` の観測結果で、`source_sha256` の対象は実行器が読み込むファイルだけです（`scripts/b05-evidence-sources.mjs`。B04・B07 と共通の集め方は `scripts/evidence-sources.mjs`）。記録方法・完了条件・既知の未了は [B05 の完了判定](../../docs/b05/README.md) を参照してください。実機・実 API・実請求は未実施（#132・#133）で、模擬の時間は T04 の実測ではありません。
