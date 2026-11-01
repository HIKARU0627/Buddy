# ADR 0070: B10-01 共通 LLM 契約（ResponsePlan・ModelOutcome）

- 日付: 2026-11-01
- 状態: B10-01（親 #18）の契約と fixture。LLM アダプター・振り分け・評価の実施・画面は未着手。実 API・実請求は未実施。
- 根拠: 設計 05 モデルの振り分け・評価の進め方、設計 06 B10、設計 09 QA01〜QA03・X57、設計 10 §5・§5A・§6A、設計修正案 v1.2 P01・P02、ADR 0004・0005・0008。原本の参照手順は `docs/design/README.md`。
- 対象: `packages/contracts/schemas/buddy.schema.json` の `ResponsePlan`・`ResponseSpeech`・`ModelOutcome`・`ModelUsage`、`packages/contracts/fixtures/response-plan-cases.json`、`scripts/response-plan.test.mjs`、`tests/test-map.json` の QA01〜QA03。生成型は `contracts:generate` の出力だけを更新した。

## 決めたこと

| 対象                          | 決定                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契約の粒度                    | `ResponsePlan` は **1 つの schema** にまとめ、意図は `intent` の列挙で表す。24 意図ぶんの schema を複製しない。意図ごとの違いは既存の `RESULT_VIEW_BY_INTENT`（`packages/domain/src/conversation.ts`）が持ち、24 意図すべての手書きの対応表を fixture に置いて、契約と domain の対応が変わっていないことを試験で固定する                  |
| `ResponsePlan` の位置づけ     | Core が決めた**表示と読み上げの計画**。モデルの生出力（`WireResponse`）、検証済みの解釈（`Interpretation`）、実行可否（`ActionReadiness`）とは別の層で、ADR 0005 の分割を変えない。旧名の「1 つの JSON に全項目を持つ ResponsePlan」は廃止のまま（下の「名前の扱い」）                                                                    |
| `ResponsePlan` が持たないもの | 応答文の本文、宛先、件名、承認、実行経路、effect_kind。`additionalProperties: false` で拒否し、fixture の拒否例で固定する。本文は開いたときだけ許可範囲内で取得する既存の規則を変えない                                                                                                                                                   |
| 読み上げ                      | `ResponseSpeech` は `template_id`・`template_version`・`parts`（最大 3 部・1 部 200 文字）だけ。文はコードの定型文から作り、モデルの自由文を入れない（ADR 0005）。文面と版は仮置きで、B15 までに本人が調整する（D3）                                                                                                                      |
| 構造化した事実                | `facts` は既存の `ResultFact` の配列。`view` は既存の `ResultView` を使い、結果の種類の対応を増やさない                                                                                                                                                                                                                                   |
| `ModelOutcome` の粒度         | 成功（`ok`）と失敗を `oneOf` で分ける。成功は `WireResponse`・`profile_id`・`usage` を持ち、`retryable` は `false` に固定する。失敗は原因の列挙（`refused`・`truncated`・`invalid_schema`・`invalid_semantics`・`timeout`・`unavailable`・`budget_denied`・`cancelled`・`stale`）と `retryable`・`usage`（観測できなければ `null`）を持つ |
| 失敗と `unclear` の区別       | 失敗の原因を `unclear` に混ぜない（QA02・QA03）。`retryable` は利用者が手で再試行したときに成功し得るかだけを表し、**自動の再送・JSON 修復・上位モデルでの再試行を許可しない**（設計修正案 v1.2 P01・P02）                                                                                                                                |
| usage                         | `ModelUsage` は token 数と `usage_complete` だけを持ち、金額を持たない。`usage_complete: false` のときは予約を実費として精算しない。費用の計算と予約の精算は B07 の規則を再利用する                                                                                                                                                       |
| モデルの暫定                  | D1（2026-11-01、本人の決定）により、意図判定は Gemini 3.8 Flash（思考 low）を暫定の profile にする。契約は profile で差し替え可能にし、採否は B10-07 の用途別評価で本人が決める。この ADR はモデルを採用しない                                                                                                                            |
| 評価の再利用                  | `ModelProfile`・`EvaluationResult`・`EvaluationUse`・`IntentShadowRecord`・`ShadowCampaignState` は既存のまま使う。影モードの既定は OFF（D4）、評価セットと採点器は B10-07                                                                                                                                                                |
| 定型文の版                    | `COMMENTARY_TEMPLATE_VERSION = '1'` と既存の `CommentaryTemplateId` を仮の版として使う。文面の変更は版で管理し、契約の形を変えない                                                                                                                                                                                                        |

## 名前の扱い

旧 `ResponsePlan`（intent・汎用 args・relation・reply_text・confidence を 1 つの JSON にまとめたもの）は、ADR 0004・0005 で `WireResponse` / `Interpretation` / `ActionReadiness` に分けた。この ADR の `ResponsePlan` はその分割を戻すものではなく、**表示・読み上げの計画**という別の層に付けた名前である。混同を避けるため、`docs/b00/contract-map.md` の旧名称の表には「旧名の廃止は維持」と明記し、U171 に判断を残す。将来この名前が紛らわしければ、契約の意味を変えずに改名できる。

## 24 意図の扱い

`ResponsePlan.intent` は既存の `IntentName`（24 意図）を使う。意図ごとの結果の種類は既存の `RESULT_VIEW_BY_INTENT` のままで、次の 2 点を試験で固定する。

- `packages/contracts/fixtures/response-plan-cases.json` の `intent_views` に 24 意図すべての `intent` と `view_kind` を手で書く。
- `scripts/response-plan.test.mjs` が、fixture の対応表と `RESULT_VIEW_BY_INTENT` が一致すること、`resultViewKind` の `needs_clarification` / `needs_approval` の優先が変わっていないことを確かめる。

`view.kind` が意図の表と食い違う計画は、`scripts/response-plan.test.mjs` の `qa03-plan-view-kind-mismatch` で拒否する。段（plan と view）の `workflow_id`・`request_revision`・`intent` の食い違いは `scripts/contract-tools.mjs` の意味検査で拒否する。

## 試験（模擬だけ）

- `pnpm run contracts:check`: 生成型の差分なし、`response-plan-cases.json` の許可例・拒否例・意味検査の例、24 意図の最小の計画、OpenAPI 3.1.2 を検査した。
- `node --test scripts/response-plan.test.mjs`: 24 意図の対応、`needs_clarification` / `needs_approval` の優先、失敗の種類、本文・宛先・承認・経路の拒否を検査した。
- QA01 は形式の拒否（欠損・null・存在しない意図・型違い・余分な項目）、QA02 は出力上限・拒否・途中の JSON・timeout の区別、QA03 は `invalid_semantics` と段の食い違いを fixture に置いた。`tests/test-map.json` は QA01〜QA03 を `contract_fixture` にし、製品試験は `not_run` のままにした。

**模擬の期待値だけ**。LLM の呼出し・実 API・実請求・評価の実施・画面（UI-09）は未実施で、合格扱いにしない。

## 残ること

- LLM アダプター・振り分け・出力検証・usage から予算への接続は B10-02。
- 24 意図の判定の接続・聞き返し・影モードは B10-03。
- 委譲の時間制御と定型文の適用は B10-04。
- 用途別評価と採否（D1 の最終判断）は B10-07。
- UI-09（#101）は `ResponsePlan` に配置のヒントを足す。この ADR はヒントの形を決めない。
