# ADR 0178: レシートの写真の読み取りの provider と profile（家計簿 段階 3 の一部）

- 日付: 2026-11-27
- 状態: 家計簿の段階 3 の部分。ADR 0177 で口（`ReceiptImageReader`）と模擬だけを作ったレシートの写真の読み取りに、外部のモデル（Gemini の `generateContent`）を呼ぶ実装と profile を足し、中枢の起動の設定につないだ（U368）。鍵（`BUDDY_GEMINI_API_KEY`）を起動の環境に置かず、予算の設定（`budget-runtime.json`）に確認済みの単価の版がなければ、これまでどおり「使えない（unavailable）」になる。**模擬の試験だけ**で、実 API・実請求・実機・実在のレシートは未実施。モデル・単価の系列・期限・出力の上限・入力の予約の量は暫定（U371〜U375）。
- 根拠: ADR 0177（追補 1・2 を含む）、本人の決定 D1（2026-11-01。意図の判定・抽出・返信案の暫定は Gemini 3.8 Flash・思考 low。ADR 0070・0081）、ADR 0034・0037（予算の設定と門）、ADR 0080（アダプターの境界・秘密の置き場所）、ADR 0081・0082（profile の検査・usage の精算）、ADR 0091（Gemini の codec）、ADR 0144 の追補（秘密は起動の環境変数からだけ受け取る）、AGENTS.md。原本（非公開 Notion）に家計簿の決めはない（U318 以降と同じ）。原本にレシートの読み取りのモデルの決めはなく、推測で決めず、D1 に合わせた暫定にした。
- 対象: `packages/ai/src/gemini-codec.ts`（画像 1 枚の要求の封筒 `encodeGeminiImageRequest`）、`apps/core/src/household-receipt-reader.ts`（新規。Gemini の読み取りの口・profile・起動の設定の組み立て）、`apps/core/src/model-https.ts`（新規。node:https の送信）、`apps/core/src/household-receipt.ts`（口の中断の型を `AbortSignal` にした）、`apps/core/src/budget-gate.ts`（`priceVersionFor`）、`apps/core/src/core.ts`（`https.household.receiptProvider`）、`apps/core/src/cli.ts`（環境変数の鍵）。契約（`packages/contracts`）・マイグレーション・端末は変えていない。

## 背景

ADR 0177 で、写真の受け取り・検査・予算の門・応答の厳格な検査・端末の画面までを作ったが、外部のモデルへ送る口の実装はなく、製品の起動では「使えない」のままだった（U368）。既存の仕組みを調べた結果は次のとおり。

| 対象               | 分かったこと                                                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider の codec  | `packages/ai` にあるのは Gemini（`generateContent`）の codec だけ。文字の `messages` だけを送り、画像を送る形はない。応答の封筒の読み方（usage・拒否・打ち切り・思考の要約）は Gemini の codec が持つ。音声の `gpt-live` は会話（Live）の接続で、画像の読み取りの口ではない |
| HTTP の送信        | `packages/ai` は `HttpTransport` の口だけで、node:* を読まない（ADR 0080）。実際に送る実装はリポジトリのどこにもない。`createHttpAdapter` は中断を送信の前後でしか確かめず、送っている途中の要求を切れない                                                                  |
| profile の決め方   | `ModelProfile`（契約）を、ジョブの振り分け表（`TASK_RULES`）と `modelProfileErrors`・`routingErrors` で確かめる。表は `docs/b10/model-routing.md` に人が読む形で置き、`verified_capabilities` は模擬の設定の値。endpoint・API キーは実行時の設定（ADR 0081）                |
| 単価               | 単価の値は本人が書く `budget-runtime.json`（`PriceVersion`）だけにあり、リポジトリに置かない。予算の門は `price_key` と受付の時刻から確認済みの版を選ぶ。会話（Live）は設定の `live_seconds` の系列から `price_key` を決める（`livePriceKey`）                              |
| 鍵                 | LLM の鍵を受け取る仕組みはまだない。秘密を受け取る既存の形は、OAuth のクライアントシークレット（`BUDDY_GOOGLE_OAUTH_CLIENT_SECRET`）を CLI が起動の環境変数から読み、DB・KeyStore・ファイル・ログに出さない形（ADR 0144 の追補）                                            |
| 製品の起動での配線 | ADR 0091 は「Core の起動時の設定（endpoint・認証・profile の読み込み）は、実 API の承認まで既定では配線しない」とした。意図の判定・メールの抽出は今も模擬の解釈が既定                                                                                                       |
| 模擬の試験         | `@buddy/ai/testing` の偽のアダプター・偽の HTTP、`.invalid` の endpoint、127.0.0.1 の模擬の HTTPS サーバー（模擬の TLS の鍵）                                                                                                                                               |

## 決めたこと

| 対象                   | 決定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider とモデル      | Gemini の `generateContent`、モデルは `gemini-3.8-flash`、思考は `low`（D1 の意図の判定・抽出と同じ）。既存の仕組みで画像を受けられる provider は Gemini だけ。原本に決めがないので暫定（U371）                                                                                                                                                                                                                                                                                                     |
| 送る内容               | `systemInstruction` に固定の指示文（`HOUSEHOLD_RECEIPT_INSTRUCTIONS`。ADR 0177）、`contents` に画像の part 1 つ（`inlineData`。`image/jpeg` と base64）、`generationConfig`（構造化出力・出力の上限・思考）だけ。要求の ID・本人の名前・端末の情報・ほかの家計の記録・タイムゾーンは送らない。`temperature` は指定しない（ADR 0091 と同じ）                                                                                                                                                         |
| 封筒の作り方           | `packages/ai` に `encodeGeminiImageRequest` を足した（`ModelCommand` は文字だけなので、画像の要求を別の型 `GeminiImageRequest` にした）。base64 は Core が作って渡す（`packages/ai` は node:* を読まない）。応答は既存の `createGeminiCodec().decode` で読む                                                                                                                                                                                                                                        |
| 構造化出力             | `responseMimeType: application/json` と `responseJsonSchema`（`HOUSEHOLD_RECEIPT_REPLY_SCHEMA`。domain の `readHouseholdReceiptReply` と同じ 9 つのキー、品目は 100 件まで、余計なキーなし）。構造化出力は手助けで、検査の正本はこれまでどおり厳格な JSON の読み取りと domain の検査（応答が形に合っていても信用しない）                                                                                                                                                                            |
| profile                | `household-receipt.gemini`（設定の版 `1`）。役割 `background_text`、`structured_output: json_schema_strict`、出力の上限 4,096、期限 45 秒、同時数 2（同じ provider の profile と揃える）、予約は `max_liability`、`api_version: v1beta`。`verified_capabilities` は `docs/b10/model-routing.md` の表と同じく模擬の設定の値（`json_schema_strict`・`reasoning:low`）で、実 endpoint で確かめた記録ではない（U372）。起動の時点で `modelProfileErrors` に通らなければ使わない                         |
| 期限                   | 45 秒（U374）。ADR 0177 の追補の上限 60 秒（`RECEIPT_READ_TIMEOUT_MAX_MS`）より短くし、返らない口を待つ上限（期限 + 5 秒）までの間、保存期限の門が閉じる時間を縮める                                                                                                                                                                                                                                                                                                                                |
| 出力の上限             | 4,096 token（思考を含む。U374）。品目 100 件の JSON と思考に足りる見込みの暫定の値。打ち切られた応答は候補にしない（ADR 0177）                                                                                                                                                                                                                                                                                                                                                                      |
| 入力の予約の量         | 8,192 token（`max_input_tokens`。U374）。画像の token の数え方を実 API で確かめていないので、指示文と画像 1 枚に足りる大きめの値にした。予算の門は実際の usage で精算するので、予約が実費より大きいことは費用を増やさない                                                                                                                                                                                                                                                                           |
| 単価の系列と版         | `price_key` は `gemini.gemini-3.8-flash`（U373）。単価の値は本人が `budget-runtime.json` に書き、`verified_price_versions` に載せる（リポジトリに単価を書かない）。起動の時点で、予算の門の `priceVersionFor`（`computeLiability` で、今の時刻・期限・入力 8,192・出力 4,096 を見積もれるか）で版を確かめ、見積もれなければ使わない（記録は理由の名前 `receipt_price_version_unavailable` だけ）。profile の `price_version` は起動の時点の版で記録用。受付では、予算の門が受付の時刻で版を選び直す |
| endpoint               | `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent` をコードに置いた（U372）。公開の API の URL で、秘密・個人の情報・内部の URL ではない。モデルの名前が URL に入るので、profile のモデルと endpoint を同じ場所で決め、食い違わないようにした。ADR 0081・`docs/b10/model-routing.md` の「endpoint は実行時の設定」と違う扱いなので、U372 に記録した。試験は `.invalid` の名前と 127.0.0.1 の模擬の HTTPS サーバーだけを使う                                 |
| 鍵                     | 起動の環境変数 `BUDDY_GEMINI_API_KEY` だけから CLI が読み（ADR 0144 の追補と同じ形）、`https.household.receiptProvider.apiKey` として Core へ渡す。リクエストの `x-goog-api-key` のヘッダーにだけ入れ、URL・profile・DB・KeyStore・ファイル・ログ・例外には入れない。読み取りの口のオブジェクトのプロパティにも置かない（関数の中だけ）。空・空白や改行を含む値・表示できない文字は鍵がないものとして扱う。鍵がなければ記録も出さず、設定は unavailable のまま（U373）                              |
| 模擬の起動             | `--mock-key-protection` などの模擬の鍵保護で起動したときは、環境変数に鍵があっても渡さない（模擬の起動から外部のモデルへ写真を送らない）                                                                                                                                                                                                                                                                                                                                                            |
| HTTPS の送信           | `apps/core/src/model-https.ts` に `createModelHttpsTransport` を足した。`https:` だけ、1 回だけ送る、期限で接続を切って `timeout`、中断で接続を切ってすぐ返す、応答の本文は 1 MiB まで（超えたら切る）、送った本文と受け取った断片の Buffer を終えた後に 0 で埋める、何も記録しない。証明書の検証は Node の既定（信頼する CA と名前の照合）                                                                                                                                                         |
| 中断                   | `ReceiptImageReader.read` の中断の型を `Cancellation`（`aborted` だけ）から `AbortSignal` にした（呼び出し側の予算の門は前から `AbortSignal` を渡している）。読み取りの口は中断を HTTPS の送信へ渡し、送っている途中でも接続を切ってすぐ `cancelled` を返す（ADR 0177 の追補 2）。送る前に中断されていれば送らない。応答が届いた後に中断されたときは、観測した usage を捨てずに `cancelled` と一緒に返す（ADR 0080 と同じ）                                                                         |
| 失敗の扱い             | 200 以外の状態・封筒が読めない（JSON でない・候補がない・知らない終了の理由）・送れない・送信の口の例外は `unavailable`、期限切れは `timeout`。どれも usage は分からないとして返し、自動で送り直さない。経路は 503 `dependency_unavailable`（結果不明）にし、予算の門が予約を保持する（ADR 0177）。安全のための拒否（`promptFeedback.blockReason`、`SAFETY`・`IMAGE_SAFETY`・`SPII` などの終了の理由）は `refused`、出力の上限での終了は `truncated` で、どちらも候補にしない                       |
| usage                  | Gemini の codec の読み方のまま（入力は `promptTokenCount`、出力は `candidatesTokenCount` + `thoughtsTokenCount`、cached は入力の内数）。欄が欠けている・負・cached が入力を超えるときは null（推測で埋めない）。予算の門が、予約に固定した単価の版で実費にし、null なら予約を保持する（ADR 0177・0082）                                                                                                                                                                                             |
| 記録                   | 読み取りの口は、応答を得られなかったときに理由の名前だけを記録する（`http_status_<番号>`・`response_unreadable`・`timeout`・`unavailable`・`transport_failed`・`provider_mismatch`）。画像・応答の本文・鍵は出さない。起動の設定は、使えなくしたときに理由の名前（`receipt_api_key_invalid`・`receipt_price_version_unavailable`・`receipt_profile_invalid`）だけを記録する                                                                                                                         |
| 起動の設定の口         | `CoreHouseholdOptions` に `receiptProvider`（`apiKey`・送信の口・試験だけの endpoint）を足した。これまでの `receiptReading`（設定をそのまま渡す。試験の模擬）を渡せば、そちらを優先する。どちらもなければ unavailable                                                                                                                                                                                                                                                                               |
| 保存期限の門の入口     | `household-receipt-reader.ts` を `retention-entries.test.ts` の表に wiring（口の実装。呼ぶのは `household-receipt.ts` で、掃除のゲートはそこで通す）として載せた                                                                                                                                                                                                                                                                                                                                    |
| 製品の起動につなぐこと | ADR 0091 は実 API の承認まで既定では配線しないとした。この ADR は、レシートの写真の読み取りに限り、鍵を起動の環境に置いたときだけ外部へ送る形で製品の起動につないだ（U375）。鍵を置かなければ動きは変わらない。鍵を置いても、送るのは本人が家計簿の欄で入にし（OS の確認ダイアログ）、写真を 1 枚選んだときだけ（ADR 0177）。実 API の確かめは、本人の承認の後に `docs/household/README.md` の項目 L の手順で行う                                                                                   |

## 退けた案

| 案                                                                                    | 退けた理由                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 別の提供元（画像を受けるほかのモデル）の codec を新しく作る                           | 既存の仕組みにあるのは Gemini の codec だけで、新しい提供元は wire 形式・usage・終了理由・単価をすべて新しく決めることになる。原本にも本人の決定にも根拠がない。D1 で同じ提供元を暫定にしているので、まず Gemini にした（U371） |
| Gemini のより大きいモデル（Pro など）                                                 | D1 の暫定と違うモデルを選ぶ根拠が原本にない。単価の系列と予約の量も別に決め直すことになる。読み取りの精度が足りないと分かれば、実 API の確かめ（項目 L）の後に本人が決める（U371）                                              |
| `ModelCommand` の `messages` に画像の part を足し、`createHttpAdapter` をそのまま使う | すべての codec と呼び出し側（意図の判定・抽出）の型が変わる。`createHttpAdapter` は送っている途中の要求を切れず、ADR 0177 の追補 2（中断されたらすぐ返す）を満たせない                                                          |
| `packages/ai` の `HttpTransport` に中断を足す                                         | ADR 0080 は DOM の `AbortSignal` を `packages/ai` に持ち込まないとした。中断を使うのは Core の読み取りの口だけなので、Core の口（`ReceiptHttpTransport`）に置いた。`packages/ai` の偽の HTTP もそのまま使える形にした           |
| endpoint・モデルを環境変数などの実行時の設定にする                                    | Gemini はモデルの名前が URL に入るので、profile のモデルと endpoint が食い違うと、記録のモデル・単価の系列と実際に呼ぶモデルが変わる。公開の URL で秘密でもない。本人が変えたいかは U372 で確かめる                             |
| 鍵を KeyStore（OS の秘密情報保護）に置き、CLI のコマンドで登録する                    | 登録の経路・KeyStore の項目・忘却とバックアップの扱いを新しく決めることになる。秘密を受け取る既存の形（ADR 0144 の追補の環境変数）に合わせた。KeyStore に置くかは U373 で本人に確かめる                                         |
| 単価の系列を `livePriceKey` のように設定から探す                                      | LLM の単価の系列は、モデルごとに複数ありうる（会話の `live_seconds` と違い、区分で一つに決まらない）。決まった `price_key` を本人が設定に書く形にした                                                                           |
| 起動の時点で単価の版を確かめない（受付で初めて分かる）                                | 単価の版がないと、本人が入にして写真を選んでも、毎回送る前に止まる（503 `not_sent`）。起動の時点で確かめ、なければ「使えない」と出す方が分かりやすい                                                                            |
| 構造化出力を使わず、指示文だけで JSON を求める（`json_mode`・`none`）                 | 構造化出力は応答の形の崩れを減らす手助けになる。どちらでも検査の正本は domain の検査なので、構造化出力を使う側にした。`responseJsonSchema` が実 endpoint で受け付けられるかは未確認（U372）                                     |

## 原本に決めがない項目

- U371: レシートの読み取りのモデル（Gemini 3.8 Flash・思考 low）。
- U372: endpoint をコードに置くこと、`verified_capabilities` を模擬の設定の値で登録すること、構造化出力の形。
- U373: 鍵の受け取り（起動の環境変数）と単価の系列の名前、模擬の起動で鍵を渡さないこと。
- U374: 期限 45 秒・出力の上限 4,096・入力の予約の量 8,192。
- U375: 鍵を置いたときだけ製品の起動から実 API へ送る形にしたこと（ADR 0091 の既定では配線しない、との関係）。

## 対象外

- 意図の判定・メールの抽出などほかのジョブの配線（ADR 0091 のまま模擬の解釈が既定）。
- Gemini の画像の解像度の指定（`mediaResolution` など）・送る画像の縮め方の見直し（U365）。
- 鍵の KeyStore への保存、鍵の入れ替えの手順。
- 実 API・実請求・実在のレシートでの確かめ（項目 L）。

## 試験（模擬だけ）

- `packages/ai/src/gemini-codec.test.ts`（1 件）: 画像の要求の封筒が、`systemInstruction`・画像の part 1 つ・`generationConfig`（注釈を落とした `responseJsonSchema`・`maxOutputTokens`・`thinkingLevel`）だけを持ち、認証のヘッダーを持たないこと。構造化出力・思考・出力の上限のない profile ではその欄を送らないこと。
- `apps/core/src/household-receipt-reader.test.ts`（16 件）: 送る要求の形（URL・`POST`・期限 45 秒・`content-type` と鍵のヘッダーだけ・本文の 3 つのキー・指示文・画像の base64 を手で書いた値と照合・要求の ID と鍵が本文と URL にないこと・画像を変えないこと）、既定の profile の全項目、応答と usage（思考を含む出力）、usage がない・出力がない・負・cached が入力を超える、安全のための拒否（入力・`IMAGE_SAFETY`・`SPII`）・打ち切り・空の本文・思考の要約、HTTP の 500・429・403・JSON でない・候補がない・知らない終了の理由・時間切れ・送れない・送信の口の例外（どれも 1 回だけ送り、理由の名前だけを記録）、中断（送る前・送っている途中・応答の後・例外のとき）、Gemini 以外の profile、記録とオブジェクトに鍵・画像・応答の中身が出ないこと、構造化出力の形（余計なキー・小数・品目 100 件と 101 件・キーの不足）、環境変数の鍵の形、起動の設定（鍵がない・形が違う・単価の版がない・見積もりの要求の値）、経路まで通した候補と候補にしない応答（外貨・重複したキー・余計なキー・合計と品目の食い違い・空の本文・拒否・打ち切り・HTTP の失敗の 503）、鍵がないときの unavailable、実際の `BudgetGate` での `priceVersionFor`（系列がない・確認されていない・まだ始まっていない・出力の 1 要求の最大量が足りない）と、Gemini の usage での精算・usage が不完全なときの予約の保持。
- `apps/core/src/model-https.test.ts`（7 件）: 127.0.0.1 の模擬の HTTPS サーバーへ、要求をそのまま 1 回送り、状態・ヘッダー・本文を返すこと、200 以外の状態、期限で接続を切ること、中断で接続を切ってすぐ返すこと・中断済みなら接続しないこと、応答の本文の上限のちょうどと 1 バイト超え、`https:` でない URL・読めない URL・不正なヘッダーで接続しないこと、閉じたポートと信頼しない証明書。
- `apps/core/src/household-receipt-core.test.ts`（2 件）: 実際の `startCore` で、鍵と確認済みの単価の版があれば、端末の HTTPS の要求から Gemini の読み取りの口で 1 回だけ送って候補を返すこと。鍵がない・単価の版がないときは入にできず（503）、読み取りも送らないこと。
- `apps/core/src/retention-entries.test.ts`: 入口の表。

期待値は手で書いた。画像は合成のバイト列、鍵は合成の値、応答は合成の封筒で、実在のレシートと実 API は使っていない。`responseJsonSchema` の受け付け・usage の欄・終了の理由・モデルの名前・画像の token の数え方は、実 endpoint では確かめていない（ADR 0091 と同じく模擬の HTTP でだけ確かめた）。

## 残ること

- 本人の承認の後に、合成のレシートの画像で実 API を確かめる（`docs/household/README.md` の項目 L の L0）。そこで、構造化出力の受け付け・usage の欄・拒否と打ち切りの形・期限・出力の上限・画像の token の数を確かめ、U371〜U375 を見直す。
- 提供元の利用の条件（送った画像の扱い）を本人が確かめる（U375）。
- 鍵を KeyStore に置くか（U373）。
