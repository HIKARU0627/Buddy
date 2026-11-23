# @buddy/connectors

外部サービス（メール・予定）への接続の置き場です。B04 の縦断試作のための **模擬 provider**（合成のメール・予定）、**故障注入の装置**、Core 側の**アダプター**と、B09-02 の **Microsoft Graph の読み取り connector**（模擬 transport でだけ検証）を置きます。Gmail などの実装は B08 で、試験に実メール・実予定は使いません（[ADR 0028](../../docs/adr/0028-b04-mock-provider.md)）。

## 出口

| 出口                        | 内容                                                                                                                             | 使える場所                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `@buddy/connectors`         | アダプター（`createMockMailConnector`・`createGraphMailConnector`）、能力の最小の型、故障注入（`FaultInjector`・`FAULT_POINTS`） | Core                              |
| `@buddy/connectors/testing` | 模擬 provider の起動（`createMockProvider`）と、真の結果を見る `truth`、合成データの定数                                         | 試験装置だけ（Core には渡さない） |

`src/adapter/**` と `src/index.ts` は静的 import だけで、`provider/`・`testing` を読み込めません。Core（apps/core・packages/storage）の製品コードも `@buddy/connectors/testing` を静的・動的のどちらでも読み込めず、試験（`*.test.ts`・`*-test-support.ts`）だけが例外です（ESLint。検査は `scripts/tooling.test.mjs`）。

## 模擬 provider

- `127.0.0.1` の HTTP（`node:http`）。状態と受信記録は、注入したディレクトリの `provider.json` に 1 つのファイルとして保存します（一時ファイルへ書いて置き換え）。同じディレクトリで作り直すと引き継ぎ、Core の再起動とは独立しています。同じプロセスで同じディレクトリを 2 つの provider に使わせません（`close()` で手放す）。別のプロセスで同じ保存先を共有する使い方には対応しません（試験の実行器が保存先をプロセスごとに分けます。ADR 0028）。
- 受信記録は、書込みの経路に届いた要求を、不正・拒否も含めて届いた順に残します。項目は `operation_id`・`attempt_id`・`step_id`・`receive_order`・`applied_change`・`responded`（`received_at`・`route`・`response_status` を加えています）。
- **要求の回数**（受信記録の件数）と**状態の変更の回数**（`state_changes`）は別に数えます。重複した要求は消さず、サービス側で冪等にもしません（同じ要求を 2 回送ると 2 件・変更 2 件）。読み取りはどちらにも数えません。
- 合成データ: 時計は `2026-10-05T09:00:00+09:00`。`mail-001`（`r1`・INBOX）、`event-001`（13:00〜14:00）・`event-002`（13:30〜14:30。13:30〜14:00 が重なる）。口座・許可は H01 の fixture と同じ合成の値。

| 経路                                       | 内容                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `GET /v1/accounts/:id/permission`          | 許可（`permission_revision`・`scopes`）                                                                |
| `GET /v1/mail/messages/:id`                | メールの状態（`source_revision`・`mailbox`・`labels`）                                                 |
| `GET /v1/calendar/events`                  | 予定の一覧                                                                                             |
| `GET /v1/mail/drafts?operation_id&step_id` | 正確な対象の lookup                                                                                    |
| `GET /v1/mail/drafts?marker`               | 操作の目印での lookup（下書きの保存の照合、B04-07）。条件なしは 400                                    |
| `POST /v1/mail/messages/:id/labels`        | ラベルの追加・削除（H01）。`step_id` は任意                                                            |
| `POST /v1/mail/drafts`                     | 下書きの作成（X10 の工程 `create_draft`、B04-07 の返信の下書き。任意の `marker`・`in_reply_to`・`cc`） |
| `POST /v1/mail/drafts/:id/send`            | 下書きの送信（X10 の工程 `send`。実際には送らず状態だけを動かす）                                      |

真の結果を見る API（`truth`: 要求と変更の回数・受信記録・状態・保留の件数・遅れた適用・試験の状況づくり）は、HTTP の経路にせず、プロセス内の試験装置の窓口だけにしています。

## 故障注入

`FaultInjector` の地点名は `tests/integration/fault-points.json` の `fault_points` と同じです（試験で照合）。

- Core 側の地点: Core のコードが `await injector.hit(point, { operation_id, step_id })` を呼ぶ。`pause`（`release()` まで待つ）・`throw`（`InjectedFaultError`）・`barrier`（`parties` 件がそろうまで待ち、そろった瞬間に一斉に解放する。`approval_barrier` 用）。待ち合わせには `waitReached(point, n)` を使い、sleep を使わない。
- provider 側の地点: `after_external_apply_before_response`（適用して記録した後、応答を返さず接続を切る = `drop_response`）、`response_timeout_then_late_apply`（適用せず保留し、`truth.releaseLateApplies()` で遅れて適用する = `hold_then_apply`。応答は返さない）。
- `arm(point, spec, { times, match: { operation_id, step_id } })` で回数と対象を絞れる（barrier の `times` は `parties` と同じだけ。不正な設定は即座に拒否）。`core_restart` は試験装置がアダプターを作り直して表す（provider は止めない）。

## アダプター

`createMockMailConnector({ baseUrl, timeoutMs, timeoutSignal })`（`timeoutSignal` は試験用。中止すると時間切れとして扱う）。

- 読み取り: `readPermission`・`readTarget`・`listEvents`・`lookupDrafts`（状態を変えない）。
- 書込み: `changeLabels`・`createDraft`・`sendDraft`。**1 回だけ送り、HTTP の自動再送は 0 回**（keep-alive も使わない）。結果は `applied`・`rejected`（4xx。適用されていない）・`not_sent`（接続できない）・`unknown`（時間切れ・切断・5xx・形の違う応答。再送するかは Core の状態機械が決める）。
- `capability`: 最小の能力の型（暫定。connector の能力の型は #81 で domain に置く予定で、できたら `src/adapter/capability.ts` を差し替える）。

## Microsoft Graph の読み取り connector（B09-02）

`createGraphMailConnector({ accessToken, transport, baseUrl, timeoutMs, tenantId, timeoutSignal, maxPages })`（[ADR 0134](../../docs/adr/0134-b09-02-graph-read-connector.md)）。

- **読み取り専用**: `readAccount`・`listMailFolders`・`listMessagesPage`（1 ページ）・`listMessages`（全ページ）・`listCategories`（表示用）。カテゴリの付与・移動・送信は作らない（`capability.writes` は空）。
- **差分取得なし**: Graph の delta（`/delta`・`$deltatoken`）は使わず、フォルダーごとの `receivedDateTime`・`lastModifiedDateTime` の条件で読む（ポーリング）。
- **トークンを保持しない**: 委任トークンは取得関数の注入で受け取り、要求ごとに `Authorization` ヘッダーにだけ使う。結果・例外にトークン・応答本文を載せない。
- すべての要求に `Prefer: IdType="ImmutableId"`。基本キーは `immutable_id`、所属フォルダーは `folder_id`。id の無い項目は `skipped_without_id` に数える。
- 拒否（403 など）は `rejected`（理由: `insufficient_permission`・`organization_policy`・`admin_consent_required`・`tenant_restriction`・`unknown`）で返し、成功扱いにしない。通信・応答の失敗は結果型で返す。
- transport は注入できる（既定は `node:https` で 1 回だけ送る Graph 専用の薄い実装。B08-03 の HTTP の土台が入ったら差し替えられる）。
- 検証は**模擬 transport だけ**。実 API・OAuth の実接続は未実施（B15）。

## Google の取得対象の列挙（ADR 0145）

`createGoogleReadConnector` の `calendar.listCalendars()`（`calendarList.list`、全ページ、`fields` は `id`・`summary`・`summaryOverride`・`primary`・`accessRole` だけ）と `gmail.listLabels()`（`labels.list`、`fields` は `id`・`name`・`type` だけ）。

- 選べる取得対象を本人に見せるための読み取り。読んだ一覧を取得対象へ足すのは本人の選択（Core の取得対象の変更）だけで、connector は何も足さない（設計 04 取得する対象）。
- カテゴリ一覧（Graph の `listCategories`）と同じく connector 固有の読み取りで、能力（`capability.reads`）の種別には加えない。
- 失敗の扱いは既存の Google の読み取りと同じ（`GoogleApiError`。再試行は `CONNECTOR_RETRY_POLICY`）。検証は**模擬 transport だけ**で、実 API は未実施（B15）。

## 試験

`src/*.test.ts`（ビルド後の `dist/*.test.js`）。期待値は手書きで、一時ディレクトリの provider を使います。後片付けは「閉じてから削除」の順、各試験に timeout を付けています。実 provider・実 API の試験ではありません（模擬のみ）。
