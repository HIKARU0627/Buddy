# 契約対応表

状態: **初回範囲のみファイル化**。以下の全体台帳に対する実績と残りを次節で区別します。
設計 09 と現行 07〜11 を根拠にし、原本の更新履歴内の旧例は現行契約にしません。全体の網羅・B00 完了は未判定です。

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

## 初回の実績と残り

実ファイルは `packages/contracts/schemas/buddy.schema.json` 内の同名 `$defs`。公開用の具体化判断は [ADR 0002](../adr/0002-contract-validation.md) に記録しました。

| 範囲       | 作成済み                                                                                                                              | 残り・検査の限界                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 共通       | Id / Revision / UtcTime / LocalDate / Hash / Money / ApiError                                                                         | 版の意味・通貨換算・認可は型だけでは判定不可                                              |
| 入力       | InputSnapshot / AudioRange / FieldEvidence、F01 の形式例                                                                              | 実区間の観測、入力訂正、QA41 統合                                                         |
| 解釈       | IntentName 24件、LabelMailWireResponse / LabelMailInterpretation / ActionReadiness                                                    | 残り23意図の引数、Core の対象・根拠解決と実行ガード                                       |
| ラベル変更 | LabelOperationIntent / LabelPreview / ApprovalRequest / StateCommand / CommandReceipt / OperationSnapshot / EventEnvelope / EventPage | 他操作、プレビューの有効性、同時承認、永続化と外部一回実行                                |
| HTTP       | 操作取得、preview / approve / cancel / reconcile / retry、GET events                                                                  | bootstrap・snapshot・sessions・handoff・IO・Live・auto-actions・WSS                       |
| 費用       | BudgetReservation / CreditObservation と局所的不変条件                                                                                | 価格計算、同時受付、共有残高照合、QA42 / MA03〜MA06 統合                                  |
| モデル     | ModelEvaluationPlan / ModelCandidate、候補一覧                                                                                        | endpoint 能力・実usage・評価・有効化可能な DeploymentManifest                             |
| 品質       | H01、形式の正常／拒否例、生JSON・Unicode・時刻等の境界試験、型生成差分                                                                | schema 合格を X01〜X66 / QA01〜QA45 合格にしない                                          |
| 後続       | [初回境界仕様](boundaries.md)                                                                                                         | F03音声、F04同期、F05関連解析、ExtractionResult v2、記憶・忘却、domain / SQL と全件対応表 |

## 24 intent の作業台帳

名前は設計 10 §5 から確定。`label_mail` 以外は名前の列挙だけで、固有引数契約・意味検証は未ファイル化です。下表は用途の整理であり、実行権限の付与ではありません。

| intent           | 用途・経路上の注意                                   | 固有契約                 |
| ---------------- | ---------------------------------------------------- | ------------------------ |
| query_schedule   | 予定参照                                             | 未作成                   |
| query_mail       | メール参照                                           | 未作成                   |
| query_tasks      | 用事参照                                             | 未作成                   |
| query_memory     | 記憶参照                                             | 未作成                   |
| create_task      | 用事登録。自動候補でも全ガードが必要                 | 未作成                   |
| create_note      | メモ登録。自動候補でも全ガードが必要                 | 未作成                   |
| label_mail       | 可逆なラベル変更。H01から開始                        | 初回の形式・局所検査のみ |
| draft_reply      | 返信下書き保存。根拠と版を検査                       | 未作成                   |
| create_event     | 自分だけの予定作成。対象条件を検査                   | 未作成                   |
| update_event     | 画面で変更内容を承認                                 | 未作成                   |
| send_mail        | 画面承認。音声の「はい」は承認にしない               | 未作成                   |
| trash_mail       | 画面承認                                             | 未作成                   |
| undo_action      | 対象を選んだ取消一覧へ。画面操作で補償               | 未作成                   |
| update_task      | 完了・期限変更・削除は画面承認                       | 未作成                   |
| research         | 裏の調査。根拠と費用を管理                           | 未作成                   |
| memory_save      | 明示依頼・全文確定が必要。記録しない会話では保存不可 | 未作成                   |
| memory_forget    | 忘却台帳と非同期結果の再検査                         | 未作成                   |
| memory_correct   | 記憶訂正。保存条件を検査                             | 未作成                   |
| dev_status       | 開発状態の参照                                       | 未作成                   |
| handoff_screen   | 表示権の移動。音声権とは別                           | 未作成                   |
| smalltalk        | 同じ判定呼出しで短い文字返答                         | 未作成                   |
| general_question | 同じ判定呼出しで一般回答                             | 未作成                   |
| consult          | 相談。高度用途は明示と評価済みprofileが必要          | 未作成                   |
| unclear          | 意図が不明な場合の聞き返し。通信失敗とは別           | 未作成                   |

## 未解決事項

- 24意図を統合する固定 wire フィールド群は、残る固有引数を本文と照合してから確定。初回のラベル専用 schema を全用途へ流用しない。
- FieldEvidence と候補IDの意味検証、および訂正・記憶・取消の最終ガードは製品コード未実装。
- 外部クレジットの取得 API、価格・通貨換算・丸めと課金上限は未検証。取得方法を推測しない。
- 全API、F03〜F05、ExtractionResult v2、保存制約、試験全件の対応が揃うまでは B00 完了としない。
