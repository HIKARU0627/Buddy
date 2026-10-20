# @buddy/contracts

B00 の初回契約です。`schemas/buddy.schema.json`（Draft 2020-12）がデータ形式の正本、`openapi.yaml`（3.1.2）が HTTP 経路の正本です（設計 07 §2 の全経路と端末登録・連携の接続。ADR 0009）。`src/generated.ts` は自動生成し、Node.js / DOM / Electron へ依存しません。

- 入力根拠、24 intent 名、ラベル変更の WireResponse / Interpretation、ActionReadiness。
- H01 のラベル変更、プレビュー、承認・状態命令、受付／durable レシート、操作状態・本文なしイベント。
- 予約 R / 最大負担 M と通常料金・クレジット・追加支出の記録形式。
- 経路ごとの要求・応答・エラーと、Core が行う検査の表（`x-buddy-core-checks`）。WSS のメッセージは `EventStreamMessage`。
- デスクトップの UI レンダラーと main の間の限定 IPC（要求・応答・通知・状態欄。`DesktopIpcRequest` ほか。ADR 0014）。main が受け取った要求をこの定義で検査します。
- 記憶の候補・忘却台帳・本人の指示、モデルの配備（DeploymentManifest）・用途別の評価結果・影モードの記録・評価セットの書き出し形式（ADR 0008）。
- `model-evaluation.json` は評価候補。API 呼出し・モデルの有効化・利用料の承認を行う設定ではありません。

`pnpm run contracts:generate` で型生成、`pnpm run contracts:check` と `pnpm test` で検査します。型はパターン・format・数値の大小・認可を保証しません。実行時には形式検査と最新状態の意味検査が別途必要です。

入力→ラベル変更の契約例を用意していますが、LLM アダプター・認可・DB transaction・サーバーはまだありません。残る契約と意図は [対応表](../../docs/b00/contract-map.md)、公開用の具体化判断は [ADR 0002](../../docs/adr/0002-contract-validation.md) を参照してください。
