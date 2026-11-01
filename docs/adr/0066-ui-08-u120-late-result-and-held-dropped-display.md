# ADR 0066: U120 の遅着した文字の結果・保留を捨てた知らせの画面への表示（キャンバスの text の中身を実データにする）

- 日付: 2026-11-01
- 状態: UI-08（#100、親 #92）の最初の段階の判断。U120（ADR 0052 の「解決しなかったこと」、`docs/b00/contract-map.md` の U120）を閉じる。B05-05（#169）のレビュー（P2-3）で残した「声で返せなかった文字の結果と保留の破棄の知らせが画面に届かない」を、製品の組み立て（Core の `createLiveScreenSink` → 流れの `placeLate` → キャンバス → `POST /v1/canvas/content`）で届けるようにした。試験は**模擬だけ**。実際の音声・実 API・実機（macOS・Windows）は**未実施**。
- 根拠: 設計 10 §1A（声で返せない結果は画面へ回し、失ってはならない）、ADR 0032（キャンバスは参照だけを持ち、本文は content の経路で取る。text は 1 回の答えにつき 1 つ）、ADR 0052（結果の届け先・保留の破棄・声の定型文）、本人の決定（2026-10-31。#100 のコメント）。原本は権限のある接続で読み取りだけを行い、全文は写していない。

## 決めたこと

契約の選択肢（`docs/b00/contract-map.md` の U120 の (a)）のうち、**「結果の文字を載せる物の種類（text の中身を実データにする）」**を採った。本文なしの通知イベントは足さない。理由は、既にキャンバスの `text` 部品と `POST /v1/canvas/content` の経路があり、画面（キャンバスの窓）と HeroUI の描画も UI-07 でできているため。新しいイベントと通知の経路を足すより、本文を実データに切り替えるほうが変更が小さく、ADR 0032 の「物は参照だけ・本文は描くときに許可範囲内で取る」という境界もそのまま保てる。

- **遅着した文字の結果**: `placeLate` は、予定のカードにできない結果（聞き返し・全文の確定の案内など）を、キャンバスの `text` の物（物の名前 `reply`、見出し「答え」）にする。本文は `turn.reply_text`（Core の定型文）。結果の文字がないときは「画面で確認してください。」にする。結果の本文を物の項目（`description`・`body` など）に足さない。
- **保留を捨てた知らせ**: `heldDropped` は、物の名前 `held-dropped`・見出し「実行前の依頼」の `text` の物にする。本文は `inputCommentary('hold_dropped')` の固定の定型文「実行前の依頼は実行していません。必要なら、もう一度お願いします。」だけで、捨てた依頼の本文を含めない。
- **本文の置き場所**: 本文は Core の RAM（`CanvasHub` の物ごとの本文）にだけ置く。キャンバスの記述・WSS の版の知らせ・イベントの記録・ログには載せない。端末は `POST /v1/canvas/content` で、画面が描いている版の物についてだけ取る（既存の UI-07 の規則のまま。ロック・停止・切断・世代の変化・版の食い違いでは渡さない）。
- **同じ物を使い回す**: 遅着の結果は `reply`、保留の破棄は `held-dropped` の 1 つずつを更新する（物を増やさない。見える物の上限 24 を消費し続けない）。物のデータの参照 `screen_result` の ID を結果ごとに進め、画面が本文を取り直す。棚へ片付けられていれば棚のままにする（ユーザーの置き場所を AI が戻さない）。
- **実行の権限は生まれない**: この表示は結果の事実と定型文だけで、承認・実行の操作を持たない。`text` の物は承認・停止・取消のチャネルを持たず、キャンバスの窓はそれらを送れない（ADR 0032 のまま）。既定の方針で方式 C の入力は全文の確定へ戻るので、表示の追加で承認の対象は増えない。
- **通常の発言の聞き返し**: 入力バーからの発言（`POST /v1/stream/turns`）の聞き返しは、この段階ではキャンバスに置かない（UI-03 の「聞き返し・承認待ちの操作はキャンバスに置かない」を変えない）。入力バーでの聞き返しの表示は UI-08 の次の段階で行う。

## 契約

JSON Schema・OpenAPI の形は変えない。`CanvasContent` の `text`（`CanvasContentBody`。2000 文字・改行だけを許すプレーンテキスト）と `POST /v1/canvas/content` は既にあり、模擬の中身だけだった `text` を、中枢が持つ本文に切り替えた。`contracts:generate` による生成型の差分はない。`packages/contracts/fixtures/canvas-stream-cases.json` には `text` の物（`reply`）の正常な記述が既にあるため、fixture の追加はしていない。`tests/test-map.json` は X29・X36 の契約 fixture を変えない（実装の試験を足しただけで、契約 fixture の追加・変更ではない）。`product_test` は `not_run` のまま。

## 実装

| 場所                                 | 内容                                                                                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/core/src/canvas-stream.ts`     | `placeReplyForTurn`・`placeHeldDropped`・`textCardBatch`、`CanvasHub.setText` / `textFor` / 本文の破棄、`placeLate` の文字の結果、`placeNotice`、`postCanvasContent` で本文を返す |
| `apps/core/src/canvas-content.ts`    | `mockCanvasContent` が `text` の本文を受け取る（渡された本文をそのまま返す）                                                                                                      |
| `apps/core/src/live-conversation.ts` | `createLiveScreenSink` が文字の結果を `placeLate` へ、保留の破棄を `placeNotice` へ渡す。置けなかったときだけ理由をログに残す（本文は残さない）                                   |
| `apps/core/src/core.ts`              | 製品の組み立てで `placeNotice` を流れへつなぐ                                                                                                                                     |

## 試験（模擬のみ）

- `apps/core/src/canvas-stream.test.ts`: 遅着の結果が `reply` の `text` の物（float・見出し「答え」・参照 `screen_result`）になり、2 回目は同じ物の更新になること。保留の破棄が `held-dropped` の別の物になり、固定の定型文だけを持つこと。**製品の組み立て**（`createLiveScreenSink` → `createStreamRoutes` の `placeLate` / `placeNotice` → `CanvasHub`）で、記述に本文が載らず、`postCanvasContent` が版 2 の物について本文を返すこと。置けなかったときだけ理由のログになること（本文はログに残らない）。
- `apps/core/src/canvas-content.test.ts`: `mockCanvasContent` が渡された `text` の本文を返し、ほかの部品には使わないこと。
- `apps/core/src/live-conversation.test.ts`: 画面 sink が予定のカード・文字の結果・保留の破棄をすべて配置へ渡し、中身をログに残さないこと。
- UI-03 の既存の試験（聞き返し・承認待ちの操作はキャンバスに置かない）は変更せずに通る。
- 変異試験・実際の音声・実 API・実機での確認は**未実施**。契約 CI の成功を製品の試験の合格として扱わない。

## 残ること

- 入力バーでの聞き返しの表示、入力バーが大きくなる・小さくなる規則、B05 の音声の状態と「続ける」の見た目、AquaVoice・macOS の音声入力・Win+H の受け取り（変換中は送らない）は、UI-08 の次の段階（ADR 0067 以降）。
- 保留の破棄の知らせを Live の終了時に声でも伝える経路は、接続が閉じているため声には乗らない（画面の `text` の物だけ）。
- 実機（macOS・Windows）でのキャンバスの窓・text の描画・本文の取得は未実施。撮影用の起動での確認も、この段階では行っていない。
