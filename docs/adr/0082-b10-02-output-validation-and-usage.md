# ADR 0082: B10-02 P3 出力の検証・失敗の区別・usage の計上

- 日付: 2026-11-03
- 状態: B10-02 P3 の判断。出力の検証、`ModelOutcome` への変換、usage から実費と予約の量を求める部分、ローカル P0 の採用条件の形だけ。実際の provider の codec と Core の配線は B10-03 以降。実 API・実請求・実機は未実施（B15 と本人の承認まで扱わない）。
- 根拠: 設計 05「費用の計算」「予約と最大負担の区別」、設計 09 QA02・QA20・QA40、設計 10 §6A D15、設計 11 §8・§9、ADR 0006・0034・0035・0037・0070・0081。原本は権限のある接続で読み取りだけを行い、全文は写していない。
- 対象: `packages/ai/src/{validation,cost,reservation,settlement,local}.ts` と各試験、`packages/ai/package.json`（`@buddy/domain`・devDependency の Ajv）、`docs/b00/contract-map.md` の U191、`tests/test-map.json` の QA02・QA13・QA20・QA37・QA40。契約（`packages/contracts`）は変えていない。

## 出力の検証（`validation.ts`）

| 段階                      | 決定                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| schema の正本             | 契約（`packages/contracts` の JSON Schema）を注入する。Core が Ajv の検証器を渡し、`packages/ai` は schema を複製しない。意味の検査（意図ごとの引数の規則）も注入し、B10-03 が domain の規則を渡す                       |
| provider の拒否・打ち切り | `refused` は `ModelOutcome.kind = 'refused'`、`truncated` は `'truncated'`。どちらも retryable は false。本文が空でも成功にしない                                                                                        |
| 空                        | 空白だけの本文は `invalid_schema`。内訳は `detail: 'empty'`                                                                                                                                                              |
| 途中の JSON               | `JSON.parse` の失敗は `invalid_schema`。内訳は `detail: 'json_parse'`。**自動の JSON 修復をしない**（設計修正案 v1.2 P01・P02）                                                                                          |
| schema 不一致             | `invalid_schema`、`detail: 'schema'`                                                                                                                                                                                     |
| 意味の不一致              | `invalid_semantics`、`detail: 'semantics'`。理由は診断用に返し、契約の `ModelOutcome` には入れない（契約の失敗の種類を増やさない）                                                                                       |
| 出力上限                  | provider の打ち切りは `truncated`。`output_limit_tokens` を超える `output_tokens` と、任意の文字数の上限も `truncated`（内訳 `output_limit`・`chars_limit`）。アプリ側で無断に出力を削らない                             |
| 成功                      | `WireResponse` に変換し、`profile_id`・`usage` を持つ `ok`。`retryable` は false に固定                                                                                                                                  |
| usage がない成功          | 出力は捨てず、`usage` を `0`・`usage_complete: false` にして成功を保つ（U191）。実費は精算しない（`settlement.ts` が usage 不明にする）。実測値の推測は入れない                                                          |
| retryable                 | 利用者が手で再試行したときに成功し得るかだけ。timeout・unavailable は true、refused・truncated・invalid_schema・invalid_semantics・cancelled は false。true でも**自動の再送・上位モデルでの再試行をしない**（ADR 0070） |
| 内訳（detail）            | `ModelOutcome` の失敗の種類は変えず、空・途中の JSON・schema・意味・上限・拒否・打ち切りを `detail` で区別する（ログ・診断・試験用）                                                                                     |

## usage から実費（`cost.ts`）

| 対象             | 決定                                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 精算の条件       | `usage_complete: true` のときだけ実費を確定する。false・usage なしは usage 不明として R と M を保持する（ADR 0070・0037）                                                                                                                                                             |
| 入力             | `input_tokens` のうち `cached_input_tokens` を命中分として分ける。命中分は `cached_input_tokens` の単価、残りは `input_tokens` の単価。版に命中分の単価がなければ、命中分も入力の単価で課金する                                                                                       |
| 思考             | 契約の `PriceCategory` の説明どおり、`output_tokens` は思考を含む。`reasoning_tokens` は内訳で、**足して二重に数えない**。`reasoning_tokens` が `output_tokens` を超える記録は `reasoning_exceeds_output` で拒否する（矛盾した usage で少なく数えない）                               |
| 安全係数         | 実費には掛けない（M の見積もりの余裕。B07 の会話の実費と同じ）                                                                                                                                                                                                                        |
| 最低課金量       | 入力・cache は量が 0 のときは掛けない（ゼロ免除）。出力は量が 0 でも `minimum_quantity` を掛ける（拒否・打ち切りで出力が 0 の応答も最低料金を落とさない。B07 の `estimate` と同じ）。量が 1 以上で最低課金量を下回るときは、最低課金量で課金する                                      |
| 丸め             | 区分ごとに切り上げ、合計する（少なく数えない。ADR 0035 と同じ）                                                                                                                                                                                                                       |
| 上限             | 合計が 18 桁（契約の `Amount`）を超えたら `amount_overflow` で拒否する                                                                                                                                                                                                                |
| 1 要求の最大量   | 実費では `max_quantity_per_request` で切らない。実際に使った量を全額記録し、M を超えたら B07 の門が異常超過として扱う                                                                                                                                                                 |
| 扱えない料金区分 | `tool_calls` は実使用量（0 も既知の値）を別に受け取れば精算する。受け取っていないときは `unsettled_category:tool_calls` で精算しない。`search_requests`・`live_seconds` はこの段階では実使用量を確定できないので `unsettled_category:<category>` で精算しない（少なく数えない。U192） |
| 通貨             | `price_version.conversion.to_currency` が予算の通貨と一致しなければ拒否する                                                                                                                                                                                                           |
| 単価の版         | 予約で固定した `price_version` を使う。金額・単価・為替はコード・文書・fixture に置かず、合成の通貨 XTS で試験する                                                                                                                                                                    |

## 予約の量（`reservation.ts`）と精算（`settlement.ts`）

- `planReservation` は、入力の実量と profile の `output_limit_tokens` を `PaidRequest.quantities` の形（`input_tokens`・`output_tokens`）にする。出力上限がない・`price_version` がない profile は受け付けない。**M・R の計算は B07 の `computeReservation` をそのまま使い、作り直さない。** 試験は合成の XTS の単価で、M と R の手書きの期待値（M = 30000、p95 の R = 16320）を確かめる。
- ツールの単価がある版では、ツールの件数（0 も既知の値）を `tool_calls` として渡す。B07 は省略した区分に `max_quantity_per_request` を使うため、既知の 0 を渡さないと最大回数を予約してしまう（ツール単価がある版で M が 30000 ではなく 30060 になる回帰を試験で固定）。ツールの単価がない版に 1 回以上のツールを使う要求は `tool_calls_unpriced` で拒否する。予約に使う単価の版が profile の `price_version` と違えば `price_version_mismatch` で拒否する。
- `planUsageSettlement` は、usage が確定していれば `{ kind: 'settle', actual_gross, price_version }` を返し、`BudgetGate.settle` に渡せる形にする。usage がない・`usage_complete: false` なら `{ kind: 'usage_unknown' }` を返し、予約を解放しない。ツールの実使用量は第 3 引数で受け取り、単価の版がツールを課金するときは必須にする。価格の設定が足りない・確定できない料金区分があるときは金額を作らず `invalid` を返す。

## ローカル P0 の採用条件の形（`local.ts`、QA40）

- `localAdoption` は、同じ profile の prefix cache あり・なしの遅延の記録から、**cache なしは採用条件未達**（`prefix_cache_missing`）、比較の基準がない（`cache_baseline_missing`）を返す。両方あれば、安全側（最も遅い値）の p50・p95 を `cached`・`uncached` に残し、差を記録できるようにする。
- **実機の測定は未実施**。macOS・Windows の遅延、cache の有無による差、採用の最終判断は B15・B10-07。ここでは記録の形と受付だけを固定する。

## 試験（模擬だけ）

- `packages/ai/src/validation.test.ts`: 契約の `WireResponse` の fixture を Ajv で検査し、成功・空・途中の JSON・schema 不一致・意味不一致・拒否・打ち切り・timeout・unavailable・cancelled・usage なし・出力上限・文字数上限を区別する。生成した `ModelOutcome` が契約の `ModelOutcome` に合格することも確かめる。
- `packages/ai/src/cost.test.ts`: XTS の合成の単価で、入力・cache・出力・最低課金量・usage 不完全・通貨不一致・単価なし・18 桁超え・ツールの実費（0 と 2 回）・確定できない検索の拒否を確かめる。期待値は手書き。
- `packages/ai/src/reservation.test.ts`: 予約の量と、B07 の `computeReservation` の M・R（p95 指定を含む）。ツール単価がある版で既知の 0 を渡す回帰（M 30000 と、0 を省いたときの 30060）、ツール 2 回の予約（M 30012）、ツール単価なしの拒否、単価の版の不一致。
- `packages/ai/src/settlement.test.ts`: 確定した usage の精算、usage 不明の保持、価格の設定不足、ツールの実使用量がないときの不精算、既知の 0・2 回の精算、検索の不精算。
- `packages/ai/src/local.test.ts`: QA40 の形（cache なしの不採用、cached・uncached の遅延の記録、基準なし、不正な測定）。
- **模擬のみ**。実 API・実請求・実機・実 endpoint の遅延測定は未実施で、合格扱いにしない。

## 残ること

- 実際の provider の codec と Core の予算の門・監査への配線は B10-03 以降。`apps/core/src/api-turns.ts`・`turn-ports.ts` はこの子では触っていない。
- 意図ごとの意味検証の実体（`IntentArgs` の規則）は B10-03。
- 用途別評価と採否（D1）は B10-07、実 API・実請求の照合は B15。
