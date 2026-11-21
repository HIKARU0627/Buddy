# ADR 0087: B08-02 取得対象の契約に、取得範囲を狭める設定を足す

- 日付: 2026-11-03
- 状態: B08-02（Issue #201、親 #16）の契約。ADR 0086（`packages/domain` の規則）の続きで、contract-map の U204 を解決する。Core の処理・保存・画面（P2・P3）は未着手。実 API は未実施。
- 根拠: 設計 04 取得する対象・接続・権限（J13・J16）、設計 06 B08、設計 11 §1・§1A、ADR 0071・0086、本人の決定 D5（2026-11-01）。原本の参照手順は `docs/design/README.md`。
- 対象: `packages/contracts/schemas/buddy.schema.json` の `ConnectionTargets`、`packages/contracts/src/generated.ts`（生成）、`packages/contracts/openapi.yaml` の `/v1/connections/{connection_id}/targets` の説明、`packages/contracts/fixtures/api-cases.json`・`graph-account-cases.json`、`scripts/connection-targets-contract.test.mjs`。

## 決めたこと

| 対象               | 決定                                                                                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保存先             | 新しい経路・新しい型を作らず、既存の `ConnectionTargets` に 4 項目を足す。`GET`／`PUT /v1/connections/{connection_id}/targets` と `ConnectionSummary.targets`・`ConnectionTargetsRequest.targets` がそのまま使う（U204 の (a)）                                                        |
| 追加する項目       | `mail_lookback_days`（整数 1〜90）、`calendar_past_days`（0〜30）、`calendar_future_days`（0〜90）、`attachment_max_bytes`（1〜10,000,000）。どれも**必須**                                                                                                                            |
| 上限は契約で閉じる | 設計の初期値（過去 90 日、カレンダーは過去 30 日〜今後 90 日、添付 10MB）を `maximum` にする。上限を超える値、0 や負の値、小数、文字列、欠落、余計な項目は契約が拒否する。範囲を広げる既定値は作らない（D5）。`packages/domain` の `FETCH_SCOPE_LIMITS` と一致することを試験で確かめる |
| 必須にした理由     | 欠けた項目を Core が既定値で補うと、「範囲を広げる既定値は作らない」を実装側の補完に任せることになる。初期値は接続時に Core が `initialFetchScope`（ADR 0086）で入れ、要求には明示して書く                                                                                             |
| 添付の 10MB        | 10,000,000 バイト（U205）                                                                                                                                                                                                                                                              |
| 意味の検査         | 契約は形と上下限だけを見る。重複した ID、前後に空白のある ID、選択外の対象は契約では見ず、`validateFetchScope`（domain）と Core が見る。状態機械・認可・版の判定をスキーマ検証と混同しない                                                                                             |
| 版                 | 変更の有無で版を上げる規則は ADR 0086 の `applyFetchScopeUpdate` が正本。契約に版の規則は足さない                                                                                                                                                                                      |
| 既存の値           | 既存の fixture の `targets` は、設計の初期値（90・30・90・10,000,000）を明示した形に更新した。保存済みの接続の移行（4 項目が無い既存行の扱い）は P2 で扱う。`connections.targets` は JSON 列のためマイグレーションは要らない見込み                                                     |

## 試験（模擬だけ）

- `pnpm run contracts:check`: 生成型の差分なし、`api-cases.json`・`graph-account-cases.json` の許可例・拒否例（上限超過・下限割れ・小数・欠落・余計な項目の拒否例を足した）、OpenAPI 3.1.2 を検査した。
- `node --test scripts/connection-targets-contract.test.mjs`: 契約の上下限と必須、契約の上限が domain の `FETCH_SCOPE_LIMITS` と同じこと、境界の値（最小・最大とそのすぐ外）の結論が契約と domain で同じこと、欠落・小数・文字列・余計な項目の拒否を検査した。期待値は手で書き、実装の表から作らない。

**模擬の期待値だけ**。Core の処理・保存・実 API・実アカウント・実データは未実施で、合格扱いにしない。

## 残ること

- P2: `getConnectionTargets`／`updateConnectionTargets` の処理と `connections` の保存（4 項目が無い既存行の移行を含む）。
- P3: 中枢の画面での選択と表示。B09-05 と同じ画面を触るので、B08-02 を先にマージする。
- 取得そのものは B08-03、添付の取得と抽出は B08-04。
