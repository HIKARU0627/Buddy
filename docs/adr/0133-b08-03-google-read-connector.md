# ADR 0133: B08-03 Google の読み取り connector（Calendar・Gmail・ページング）

- 日付: 2026-11-22
- 状態: B08-03（Issue #202、親 #16）。connector 本体と模擬 HTTP の試験まで。Core への配線（走査の実行器・トークンの保存からの取得・staging と公開）は B08-05／B08-06、添付の取得と抽出は B08-04。実 API・実アカウントは未実施（B15 と本人の承認）。
- 根拠: 設計 04 取得する対象・同期方式の選定・再試行の初期値、設計 11 §1・§1A、ADR 0071（B08-01 の能力・再試行・同期の契約）、ADR 0086（B08-02 の取得範囲）、本人の決定 D5・D8・D11（2026-11-01）。原本の参照手順は `docs/design/README.md`。
- 対象: `packages/connectors/src/adapter/google-http.ts`、`google-calendar.ts`、`google-gmail.ts`、`google-connector.ts`、`packages/connectors/src/google-connector.test.ts`、`packages/connectors/src/index.ts` の出口、`packages/connectors/package.json`（`@buddy/domain` への依存を追加）。

## 決めたこと

| 対象            | 決定                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP の土台     | 読み取り（GET）専用の `GoogleHttpClient` を新設する。既存の `adapter/http.ts` は模擬 provider 専用（単発・認証なし）のため流用しない。通信は `GoogleHttpTransport` として注入でき、試験は模擬 transport で判定する。既定の transport は `node:https` で 1 回だけ送り、自動再送しない                                                                                                                      |
| トークンの取得  | connector はトークンを保持せず、試行ごとに注入された `GoogleAccessTokenSource` から受け取る。保存からの取得と更新は Core（接続の保存）の責務で、この ADR では配線しない。トークンの値はエラー・例外メッセージ・ログに出さない（試験で固定する）                                                                                                                                                           |
| 再試行          | domain の `CONNECTOR_RETRY_POLICY` をそのまま使う（タイムアウト 15 秒、初回を含め 3 回、待機 2 秒・10 秒にジッター ±20%、Retry-After があればジッターなしで優先、待機の累計が 2 分を超える見込みなら待たずに `wait_limit_exceeded` で失敗にする）。再試行するのは 429・500・502・503・504 と通信失敗（未送信・応答なし）だけ。400・401・403・404 などは即座に失敗にする                                   |
| ページング      | `collectPages` が `nextPageToken` を最後まで追う（items が 0 件でも次を読む）。途中で失敗したら部分結果を返さずエラーにする。同じ pageToken が再び返ったら `invalid_response` で止める（無限ループ防止）                                                                                                                                                                                                  |
| Calendar の列挙 | 選択カレンダーごとに `events.list`（固定窓 timeMin／timeMax、`singleEvents=true`、`showDeleted=true`、増分は `updatedMin`）を全ページ読む。**syncToken は使わない**（設計 04: timeMin／timeMax と併用できない）。取消は `status='cancelled'` で受け取り、start／end／summary が無い予定も落とさない。応答は ID・状態・版（etag・updated）・繰り返しの識別など同期に要る項目だけに写し、未知の項目は落とす |
| Gmail の列挙    | 全量は選択ラベルごとに `messages.list`（`labelIds` の繰り返し、`q=after:<エポック秒>`）で ID を全ページ列挙する。本文の取得は `messages.get`（format は minimal／metadata／full を呼び出し側が選ぶ）で、payload の木（headers・パート・添付の識別子）を構造だけ写す。添付の内容の取得と抽出は B08-04                                                                                                      |
| Gmail の増分    | `history.list`（`startHistoryId`、`historyTypes` は messageAdded・messageDeleted・labelAdded・labelRemoved の 4 種）を全ページ読み、追加・削除・ラベルの増減をメッセージ ID に正規化して返し、最後の応答の `historyId` を次回の起点として返す。404 は起点の期限切れとして `GoogleHistoryExpiredError` にし、呼び出し側が全量に切り替える。再試行しない                                                    |
| 範囲を広げない  | 窓・ラベル・カレンダーは呼び出し側が渡した値だけを使う（D5）。connector は既定の範囲を持たず、新しいカレンダーやラベルを足さない。範囲の検査の正本は B08-02 の `fetch-scope` で、この connector は検査を重ねない                                                                                                                                                                                          |
| 能力の宣言      | `GOOGLE_READ_CAPABILITY` は読み取り 2 種（`mail.message`・`calendar.events`）だけを宣言し、書込みは宣言しない。`checkConnectorCapability` で規則に合うことを試験する。`permission` の読み取りは宣言しない（接続の状態の確認はこの connector の範囲外）                                                                                                                                                    |
| エラーの形      | `GoogleApiError` は種別（http_error／not_sent／no_response／wait_limit_exceeded／invalid_response）と状態コードと試行回数だけを持ち、メッセージは固定文言＋種別＋状態コードのみ。応答本文・URL・クエリ値を含めない                                                                                                                                                                                        |

## 試験（模擬だけ）

- `node --test packages/connectors/dist/google-connector.test.js`: 模擬 transport（台本で応答を返し、要求と待機を記録する）で 18 件。Calendar の 3 ページ（空ページを含む）の連結と取消、updatedMin の伝達、Gmail の一覧のページングと `q=after:`、getMessage の payload 正規化、history の正規化と 404 の専用エラー、ページング途中の失敗で部分結果を返さないこと、Retry-After の優先（秒数と HTTP 日付）、基本待機 2 秒・10 秒、待機上限の超過、403 の即時失敗、通信失敗の再試行と上限、JSON でない応答と形の違う応答の拒否、同じ pageToken の繰り返しの停止、能力宣言の照合、トークンがエラーの message・文字列・stack に出ないこと。期待値はすべて手書きで、トークンは合成値。
- 実 API・実アカウント・実データは未実施。模擬の成功を実 API の合格として扱わない。

## 残ること

- Core への配線: 走査の排他・staging・公開（設計 11 §1A）は B08-05、起動時ゲートは B08-06。トークンを接続の保存から渡す配線もそちらで行う。
- 添付の取得（attachments.get）と抽出は B08-04。
- Outlook（Microsoft Graph）の読み取りは B09-02 がこの HTTP の土台の考え方を共有する（transport の注入と再試行の上限）。
- ページングの中断・再開（page_cursor の保存）は B08-05 が持つ。この connector は 1 回の列挙を最後まで追うだけ。
