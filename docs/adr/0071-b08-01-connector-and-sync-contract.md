# ADR 0071: B08-01 connector の能力・再試行・同期の状態の契約

- 日付: 2026-11-03
- 状態: B08-01（親 #16）の契約と fixture。connector の実装・走査の実行器・DB・画面は未着手。実 API は未実施。
- 根拠: 設計 04 接続・権限／取得する対象／同期方式の選定／再試行の初期値、設計 08 §3、設計 11 §1・§1A（F04）、設計 09 QA18・QA19・QA22・QA36・QA44、ADR 0007・0027。原本の参照手順は `docs/design/README.md`。
- 対象: `packages/contracts/schemas/buddy.schema.json` の `ConnectorCapability` ほか、`packages/contracts/openapi.yaml` の `GET /v1/connections/{connection_id}/sync` と `GET /v1/connections/{connection_id}/targets`、`packages/domain/src/connectors.ts` の列挙と `CONNECTOR_RETRY_POLICY`、`packages/contracts/fixtures/connector-capability-cases.json`、`scripts/connector-capability.test.mjs`。

## 決めたこと

| 対象               | 決定                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| connector の能力   | `ConnectorCapability` は provider・読み取り・書込みの宣言だけを持つ。読み取りは `permission`・`mail.message`・`mail.draft`・`calendar.events`、書込みは既存の `OperationKind`（ラベル変更・下書き・用事）に限る。connector は承認・実行経路・状態を宣言できない |
| 書込みの再送       | `ConnectorWriteCapability.automatic_http_retries` は **0 固定**。結果不明の外部変更を自動で再送しない（設計 04 再試行の初期値、設計 08 §3）。照合は参照だけで行い、再送しない                                                                                   |
| 前提と照合         | 前提の確かめ方・結果の照合の範囲・工程は domain の `OPERATION_KIND_RULES` が正本で、connector の宣言が規則に合わなければ `checkConnectorCapability` が拒否する。`lookup_read` と前提の読み取りが足りない宣言も拒否する                                          |
| 参照の再試行       | 設計 04 の初期値を `CONNECTOR_RETRY_POLICY` に置く。HTTP タイムアウト 15 秒、初回を含め 3 回、待機は 2 秒・10 秒にジッター、Retry-After を優先、合計 2 分を超えるジョブは保留、3 回失敗した接続は要確認。**測定済みの最適値ではない**（U172）                   |
| 値の差し替え       | 再試行の値は `ConnectorRetryPolicy` として応答に含め、設定で差し替えられる。書込みの自動再送は 0 のまま固定する                                                                                                                                                 |
| 同期の状態の応答   | `SyncStateResponse` は既存の `SyncScopeState` と走査中の `SyncBatch` を包み、`ConnectionProvider`・`scope_revision`・再試行の初期値・`last_attempt_at` を返す。トークン・本文・件名は返さない（U173）                                                           |
| 取得範囲の読み取り | 既存の `/v1/connections/{connection_id}/targets` に **GET を足す**。新しい経路を作らない。返すのは `ConnectionSummary`（対象・許可版・取得範囲の版を含む）                                                                                                      |
| 同期の状態の経路   | `GET /v1/connections/{connection_id}/sync` を足す。読み取りで、端末トークン・自宅判定・ロック解除を求める。走査の開始・停止の経路は B08-05                                                                                                                      |
| 既存の走査の規則   | `SyncBatch`・`SyncScopeState`・`packages/domain/src/sync.ts` の排他・staging・公開 CAS・時計の後退の規則を再利用し、契約を増やさない。QA18・QA19・QA36・QA44 の前提はこの契約と既存の規則で表す                                                                 |
| provider 差        | Google の読み取りは B08-03、Outlook（Microsoft Graph）の能力・委任・組織拒否は B09-01 で足す。この ADR は provider 共通の形だけを決める                                                                                                                         |
| 取得範囲の初期値   | D5（2026-11-01、本人の決定）により、設計の初期値（過去 90 日・添付は PDF とテキスト・1 件 10MB）を設定の初期値にし、設定で狭められるようにする。この ADR は取得を実装しない                                                                                     |

## 契約の形

- `ConnectorCapability` の列挙は domain の `CONNECTOR_READ_KINDS`・`PRECONDITION_METHODS`・`LOOKUP_METHODS`・`RECONCILE_SCOPES`・`OPERATION_STEP_KINDS` と同じにする。`scripts/connector-capability.test.mjs` が両方を照合する。
- `ConnectorRetryPolicy` の初期値は fixture に手で書き、`CONNECTOR_RETRY_POLICY` と一致することを試験する。値を変えるときは両方を更新する。
- `SyncStateResponse` は `additionalProperties: false` で、`access_token`・`refresh_token`・`body`・`text`・`subjects` を受け付けない。fixture の拒否例で固定する。
- OpenAPI と `apps/core/src/api-routes.ts` の経路の表は一致させる。`getConnectionTargets` と `getConnectionSync` は `ROUTE_CHECKS` で `device_token`・`home_network`・`unlocked` を求める。

## 試験（模擬だけ）

- `pnpm run contracts:check`: 生成型の差分なし、`connector-capability-cases.json` の許可例・拒否例、`ConnectorRetryPolicy`、OpenAPI 3.1.2 を検査した。
- `node --test scripts/connector-capability.test.mjs`: 契約の列挙と domain の表、再試行の初期値（3 回・2 秒/10 秒・合計 2 分・書込み 0 回）、`checkConnectorCapability` の拒否理由、同期の状態がトークン・本文を持たないことを検査した。
- `apps/core/dist/api-routes.test.js`: 経路の表と OpenAPI の一致、`Buddy-Lock-State` の宣言を検査した。
- `scripts/contract-gate.test.mjs`: 写しの契約ゲートに新しい fixture を加えた。

**模擬の期待値だけ**。connector の実装・実 API・実アカウント・実データは未実施で、合格扱いにしない。

## 残ること

- Google の読み取り connector とページングは B08-03。
- 添付の取得と抽出は B08-04。
- 走査の排他・staging・公開・再起動は B08-05 と B08-06（B06-07 の起動時ゲートを待つ）。
- 取得範囲の画面と保存は B08-02。Outlook の能力・組織拒否は B09-01。
