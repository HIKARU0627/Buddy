# @buddy/contracts

B00 の初回契約です。`schemas/buddy.schema.json`（Draft 2020-12）がデータ形式の正本、`openapi.yaml`（3.1.2）が HTTP 経路の正本です（設計 07 §2 の全経路と端末登録・連携の接続。ADR 0009）。`src/generated.ts` は自動生成し、Node.js / DOM / Electron へ依存しません。

- 入力根拠、24 intent 名、ラベル変更の WireResponse / Interpretation、ActionReadiness。
- H01 のラベル変更、プレビュー、承認・状態命令、受付／durable レシート、操作状態・本文なしイベント。
- 予約 R / 最大負担 M と通常料金・クレジット・追加支出の記録形式。単価の版・為替と安全係数・予算の実行時の設定ファイル・利用状況・超過枠の承認・M 超過の確認・不明な費用の手での精算（ADR 0034）。
- 経路ごとの要求・応答・エラーと、Core が行う検査の表（`x-buddy-core-checks`）。WSS のメッセージは `EventStreamMessage`。
- デスクトップの UI レンダラーと main の間の限定 IPC（要求・応答・通知・状態欄。`DesktopIpcRequest` ほか。ADR 0014）。main が受け取った要求をこの定義で検査します。
- 音声レンダラーへの限定 IPC（`VoiceRendererRequest`・`VoiceRendererAck`）、Live の制御接続の遷移、リースの更新、input_kind の受付の規則、外部への送信の同意（ADR 0038）。
- 忘却台帳の別ファイル（hash の連鎖）と端末の複製、バックアップの封筒・復元の結果（6 段階と拒否の理由）、期限切れ・忘却の知らせ、保存モードの状態、復旧キー、バックアップの置き場所の設定（ADR 0040）。
- 記憶の候補・忘却台帳・本人の指示、モデルの配備（DeploymentManifest）・用途別の評価結果・影モードの記録・評価セットの書き出し形式（ADR 0008）。
- 表示と読み上げの計画（`ResponsePlan`・`ResponseSpeech`）と、モデル呼出しの成功・失敗の区別（`ModelOutcome`・`ModelUsage`。ADR 0070）。計画は応答文の本文・宛先・承認・実行経路を持たず、失敗を `unclear` と混ぜない。
- connector の能力（`ConnectorCapability`・書込みの再送 0 回）と参照の再試行の初期値、同期の状態（`SyncStateResponse`。ADR 0071）。`GET /v1/connections/{connection_id}/sync` と `/targets` の GET はトークン・本文を返さない。
- Outlook のアカウント種別・委任・組織拒否・カテゴリの扱い（`GraphAccountState`・`ConnectionSummary.graph_account`。ADR 0072）。拒否を `active` にせず、カテゴリは案の表示だけ（`display_only`）にする。
- 気づき（候補）の一覧・根拠・状態ごとの件数（`CandidateListResponse`・`CandidateEvidence`。ADR 0073）。本文を持たず、保持は活動中＋7 日・識別子 97 日。
- 方針による自動承認の記録、自動実行の既定（`AutoExecutionPolicy`。4 種類すべて既定 OFF）、安全停止の時間窓の件数、取り消しの対象版（`PolicyApprovalRecord`・`SafetyStopCounters`・`UndoTarget`。ADR 0074）。自動承認の初期値は 10 分・20 件、取り消しは 30 日。
- 送信・予定の変更・参加者のいる予定の作成・ごみ箱の intent と、送出直前の照合（`MailSendOperationIntent`・`CalendarUpdateOperationIntent`・`CalendarCreateWithAttendeesOperationIntent`・`MailTrashOperationIntent`・`DispatchGuard`。ADR 0075）。完全削除の操作は持たず、結果不明は再送しない。
- 公開 Web 調査の検索・取得・出典・上限・利用条件（`WebSearchRequest`・`WebSearchResponse`・`WebFetchRequest`・`WebFetchResult`・`WebResearchSource`・`WebResearchLimits`・`WebUsagePolicy`。ADR 0077）。Brave を採用し、検索結果は一時保持だけ・モデルの訓練に使わず、URL の永続保存は B12-02 で決める。
- 公開 Web 調査の検索語の検査・永続の出典・受付/進捗/完了の応答（`WebQueryScreening`・`WebSourceRecord`・`WebTransientLinks`・`WebResearchStatus`。ADR 0125〜0127）。完了だけが結果を持ち、失敗・0 件・保留・取消は完了と表示できない。URL は保存しない既定で、保存の可否は本人の判断待ち（U183・U290）。
- `model-evaluation.json` は評価候補。API 呼出し・モデルの有効化・利用料の承認を行う設定ではありません。

`pnpm run contracts:generate` で型生成、`pnpm run contracts:check` と `pnpm test` で検査します。型はパターン・format・数値の大小・認可を保証しません。実行時には形式検査と最新状態の意味検査が別途必要です。

入力→ラベル変更の契約例を用意していますが、LLM アダプター・認可・DB transaction・サーバーはまだありません。残る契約と意図は [対応表](../../docs/b00/contract-map.md)、公開用の具体化判断は [ADR 0002](../../docs/adr/0002-contract-validation.md) を参照してください。
