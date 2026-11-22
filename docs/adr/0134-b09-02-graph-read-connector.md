# ADR 0134: B09-02 Microsoft Graph の読み取り connector

- 日付: 2026-11-22
- 状態: B09-02（Issue #203）の読み取り connector。模擬 transport の試験だけ。実 API・OAuth の実接続・実アカウントは未実施。
- 根拠: 設計 04 接続・権限／取得する対象／再試行の初期値、設計 11 §1・§5A、設計 09 QA22・QA23、ADR 0071・0072。原本の参照手順は `docs/design/README.md`。
- 対象: `packages/connectors/src/adapter/graph-mail-connector.ts`・`graph-transport.ts`・`capability.ts`、`packages/connectors/src/index.ts`、`packages/connectors/src/graph-mail-connector.test.ts`、`scripts/graph-mail-connector.test.mjs`。

## 決めたこと

| 対象            | 決定                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transport       | B08-03 の HTTP の土台が未マージのため、Graph 専用の薄い transport（`node:https`、1 回だけ送る、keep-alive なし、自動再送なし）を置く。connector は `GraphTransport` を注入で受け取り、土台が入ったら差し替えられる注入点にした。結果は `http.ts` の `HttpOutcome` の `not_sent`・`no_response` を再利用し、応答に Retry-After を読むための応答ヘッダーを加える |
| 委任トークン    | `accessToken: () => Promise<string>` の注入。要求ごとに呼び、`Authorization: Bearer` ヘッダーにだけ使う。connector は値を保持・記録せず、結果・例外にトークンと応答本文を載せない。取得に失敗したら要求を送らず `unavailable`（`not_sent`）                                                                                                                    |
| 識別子          | すべての要求（`@odata.nextLink` を含む）に `Prefer: IdType="ImmutableId"`。基本キーは `immutable_id`、所属フォルダーは `folder_id` として別に持つ。フォルダー移動で新しい ID を作らない。id の無い・空の項目は同一と断定せず、`skipped_without_id` に数えるだけ（QA23）                                                                                        |
| 取得の形        | フォルダーごとの `messages`。`modifiedSince` は `lastModifiedDateTime ge` と `lastModifiedDateTime desc`、`receivedSince` は `receivedDateTime ge` と `receivedDateTime desc`（両方なら lastModified を優先して and で結ぶ）。`$top` 既定 50、`$select` は固定の最小集合（本文を取らない）。「前回成功時刻の 5 分前」の計算は同期の実行器（B09-04）が持つ      |
| 差分取得        | Graph の delta（`/delta`・`$deltatoken`）は実装しない。初期はポーリング（設計 04）。試験で要求の URL に delta が無いことを確かめる                                                                                                                                                                                                                             |
| ページング      | `@odata.nextLink` を組み直さずそのまま使う。同じ入口（origin とパスの接頭辞）以外の nextLink は辿らず `invalid_response`（トークンを他の宛先へ送らない）。途中のページの失敗はその結果を返し、取得完了にしない。全ページ版の上限は 1000 ページで、超えたらプログラムの誤りとして例外                                                                           |
| 結果型          | `ok`・`rejected`（理由付き）・`authentication_expired`（401）・`rate_limited`（429、Retry-After の秒をミリ秒に）・`unavailable`（`not_sent`・`timeout`・`connection_lost`・`server_error`・`invalid_response`）。拒否を成功と区別する。例外は引数の誤りとページ数の上限だけ                                                                                    |
| アカウント種別  | 接続側が渡すテナント ID から判定する。Microsoft の個人アカウント用テナント `9188040d-6c67-4c5b-b112-36a304b66dad` は `personal`、それ以外の空でないテナントは `work_or_school`、未取得・空は `null`（断定しない）。模擬の判定規則で、実 API の値は B15 で検証する                                                                                              |
| 能力            | `provider: 'microsoft'`、reads は `permission`・`mail.message`（Read）、writes は空。カテゴリ一覧（masterCategories）の読み取りは `CONNECTOR_READ_KINDS` に種別が無いため能力の reads に含めず、connector 固有の読み取り（`listCategories`）とした。表示用（`display_only`、ADR 0072）で、カテゴリの付与は作らない                                             |
| domain との関係 | connectors は `@buddy/domain` を import しない（模擬 connector の流儀）。語彙（拒否の理由・アカウント種別）の値は domain と同じにし、`scripts/graph-mail-connector.test.mjs` が照合する。能力の宣言は読み取りだけの `ConnectorCapability` として domain の `checkConnectorCapability` を通す                                                                   |
| 能力の最小の型  | `MinimalConnectorCapability.provider` を `'mock' \| 'microsoft'` に広げた（他の項目は変えない）                                                                                                                                                                                                                                                                |

## エラーと拒否の理由の対応（U174 への回答。実 API は未検証）

`classifyGraphError(status, body)` が持つ。結果には `status` と `error.code`（無ければ `unknown`）だけを持ち、`message` の全文は持たない（個人情報を含みうるため）。判定に使う文字列は `error.code`・`error.message`・`innerError` の文字列で、大文字小文字を区別しない。

| 応答                                                                                          | 結果                                                |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 401                                                                                           | `authentication_expired`                            |
| 403 で `AADSTS65001`・`AADSTS90093`・`admin consent` を含む                                   | `rejected` / `admin_consent_required`               |
| 403 で `AADSTS500021`・`tenant` を含む（例 `ErrorTenantRestriction`）                         | `rejected` / `tenant_restriction`                   |
| 403 で `policy` を含む                                                                        | `rejected` / `organization_policy`                  |
| 403 で上記以外の `error.code` がある（例 `ErrorAccessDenied`・`Authorization_RequestDenied`） | `rejected` / `insufficient_permission`              |
| 403 で `error.code` が読めない                                                                | `rejected` / `unknown`                              |
| 429                                                                                           | `rate_limited`（Retry-After は connector が付ける） |
| 5xx                                                                                           | `unavailable` / `server_error`                      |
| その他の 4xx                                                                                  | `rejected` / `unknown`                              |

上から順に判定する。この対応は模擬の判定規則で、Graph の実際のエラーの形・文言との一致は B15 で実 API を使って確かめる。ADR 0072 の「拒否の理由がある接続を active にしない」と状態の対応（権限不足は `needs_reauth` など）は、この結果を受ける接続側（B09-05）が持つ。

## 試験（模擬だけ）

- `node --test packages/connectors/dist/graph-mail-connector.test.js`: 模擬 transport（要求を記録し、手書きの応答を返す）で、フォルダーの列挙・メッセージの全ページの取得（0 件のページを挟む）・増分の条件・最小の select・cursor の扱い・フォルダー移動・id の欠落・カテゴリ一覧・拒否の対応表・Retry-After・トークンの秘匿・別の宛先の nextLink・アカウント種別・途中のページの失敗・ページ数の上限・差分取得の経路が無いことを確かめる。
- `node --test scripts/graph-mail-connector.test.mjs`: 語彙が domain と同じこと、能力が domain の規則を通ること、書込みが無いこと。

**模擬の期待値だけ**。Graph の実 API・OAuth の実接続・実アカウント・組織の拒否の実測は未実施で、合格扱いにしない。既定の transport（`node:https`）は試験で実ネットワークに接続しないため、模擬 transport で置き換えた範囲だけを確かめている。

## 残ること

- 実 API・OAuth の実接続（認可 URL・PKCE・トークンの交換と更新）・実アカウントでの確認は B15 と本人の承認の後。
- 同期の実行器（ページの走査・前回成功時刻の 5 分前の計算・再試行・保存）は B09-04（B08-05・B08-06 の実行器を再利用）。
- 添付の取得と抽出は B09-03。
- 接続画面の表示（アカウント種別・拒否の理由）は B09-05。
- B08-03 の HTTP の土台が入ったら、既定の transport を差し替えるかを判断する。
- カテゴリの付与は、If-Match の検証と承認の設計（B13）まで実装しない（ADR 0072）。
