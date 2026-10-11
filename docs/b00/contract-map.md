# 契約対応表の初期台帳

状態はすべて **未ファイル化**。以下は設計 09 と現行 07〜11 を元にした作業単位です。
B00 の最初の作業で個々の契約・フィールド・24 intent へ分解し、予定パスを確定してください。
スキーマや試験のファイルが存在すること、各行が網羅的であることはまだ意味しません。

| 契約群         | 主な契約・対象                                                                                                     | 根拠              | 予定の配置                         | 主な検証                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------- | ---------------------------------- | ---------------------------- |
| 共通表現       | ID、用途別 revision、時刻・LocalDate、金額、エラー                                                                 | 07 / 08 / 10 / 11 | contracts/schemas                  | 境界値・不正値・版の混同     |
| 通信           | API、認証、再接続、DeviceIOState、LiveSessionRequest / Answer                                                      | 07 / 10           | contracts/openapi.yaml、schemas    | X04 / X11 / X13              |
| 入力・意図     | InputSnapshot、WorkflowRequest、WireResponse、Interpretation、FieldEvidence、24 intent                             | 10 / 11、D15      | contracts/schemas                  | QA41、QA01〜QA08             |
| 実行条件       | ActionReadiness、WorkContext、Read / LocalCommand / RemoteMutation                                                 | 08 / 10 / 11      | contracts/schemas、domain          | 最終ガード、QA41 / QA45      |
| 承認・操作     | OperationIntent、ApprovalRequest、OperationSnapshot、CommandReceipt、EventEnvelope                                 | 07 / 08           | contracts/schemas                  | H01、X01〜X11                |
| 会話・委譲     | ConversationContext、DelegationIntent / Result、InteractionMode、PendingClarification、ResponsePlan、ResultView    | 10                | contracts/schemas                  | X27 / X29 / X48              |
| 音声制御       | AudioControl、LiveControlState、世代・リース・再開条件                                                             | 07 / 10           | contracts/schemas、domain          | QA43、X13 / X30 / X58        |
| 予算           | BudgetReservation、R / M、月・scope・精算キー                                                                      | 05 / 08 / 10      | contracts/schemas、domain          | QA42、X18 / QA20             |
| 同期           | SyncBatch、SourceCompleteness、cursor、active_scan_id、worker 世代                                                 | 11                | contracts/schemas、storage         | QA44、QA18 / QA19 / QA36     |
| 抽出・関連解析 | ExtractionResult v2、RequestChange、RequestEntity / RequestRevision、Deadline、CandidateSnapshot、related_analysis | 10 / 11           | contracts/schemas、domain          | QA45、QA32 / X64 / X65       |
| 記憶・忘却     | MemoryCandidate、忘却世代、保存期限、機密情報                                                                      | 03 / 08 / 10      | contracts/schemas、domain、storage | X15 / X16 / X17 / X59        |
| モデル評価     | IntentShadowRecord、DeploymentManifest、profile 境界                                                               | 05 / 10 / 11      | contracts/schemas                  | X48 / X56、設計 09 の該当 QA |
| 保存           | 操作版・承認・試行・工程・レシート・イベントのキーと制約                                                           | 08 / 11           | storage/migrations                 | 重複、再起動、期限           |
| 試験接続       | 合成データ、故障点、期待遷移、結果の記録形式                                                                       | 09                | contracts/fixtures、tests          | X01〜X66 / QA01〜QA45        |

実際のパスはリポジトリ直下の `packages/` を起点とします。
旧 UtteranceSnapshot 等の表記と InputSnapshot の現行定義は本文を照合して整理し、旧表記のために競合する契約を重複作成しないでください。

## 未決事項の記録欄

対象、設計上の根拠、選択肢、実装への影響、結論と反映先を追記します。
現時点で未選定の開発部品は [ADR 0001](../adr/0001-development-baseline.md) を参照してください。
