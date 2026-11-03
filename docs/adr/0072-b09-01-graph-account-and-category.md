# ADR 0072: B09-01 Outlook のアカウント種別・委任・組織拒否・カテゴリの扱い

- 日付: 2026-11-03
- 状態: B09-01（親 #17）の契約と語彙。Microsoft Graph の実装・画面・同期は未着手。実 API・実アカウントは未実施。
- 根拠: 設計 04 接続・権限／取得する対象、設計 11 §1・§5A、設計 09 QA22・QA23、ADR 0007・0071。原本の参照手順は `docs/design/README.md`。
- 対象: `packages/contracts/schemas/buddy.schema.json` の `GraphAccountKind`・`GraphDelegationScope`・`GraphRejectionReason`・`GraphCategoryUpdateMode`・`GraphAccountState`、`ConnectionSummary.graph_account`、`packages/domain/src/graph.ts`、`packages/contracts/fixtures/graph-account-cases.json`、`scripts/graph-account.test.mjs`。

## 決めたこと

| 対象           | 決定                                                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| アカウント種別 | `personal` と `work_or_school` の 2 種。接続時に特定し、状態に残す。種別で取得範囲や操作を黙って広げない                                                                                           |
| 委任           | `delegated_user` だけ。組織全体のアプリ権限・サービスアカウントへ切り替えない（設計 04 接続・権限）                                                                                                |
| 拒否の理由     | `insufficient_permission`・`organization_policy`・`admin_consent_required`・`tenant_restriction`・`unknown`。拒否を成功として扱わない                                                              |
| 拒否と状態     | 拒否の理由がある接続は `active` にしない。権限不足は `needs_reauth`、組織の方針・管理者の同意・テナントの制限は `needs_attention` を基本にし、画面に理由と使える範囲を出す                         |
| カテゴリの扱い | `category_updates` は `display_only` だけ。初期版は既存カテゴリの案を表示するだけで、自動付与しない（D7、設計 11 §5A）。If-Match の検証ができるまで、自動実行の操作種別にも加えない                |
| 接続の要約     | `ConnectionSummary.graph_account` は Outlook（microsoft）だけが持ち、Google では null。microsoft で欠けている接続、Google で付いている接続、拒否の理由があるのに active の接続は意味検査で拒否する |
| 画面の語彙     | 接続画面にはアカウント種別・委任・拒否の理由・カテゴリの扱い（案の表示だけ）を出す。トークン・メール本文・予定の詳細は出さない                                                                     |
| 既存の契約     | `ConnectionSummary`・`ConnectionTargets`・`ConnectorCapability`・`SyncBatch`・`SyncScopeState` を再利用し、Outlook 用の別の接続・同期の契約を作らない                                              |

## 意味検査

`packages/domain/src/graph.ts` の `connectionAccountErrors` と `scripts/contract-tools.mjs` の `ConnectionSummary` の検査が同じ規則を持つ。

- microsoft で `graph_account` がない → `graph_account_missing`
- microsoft 以外で `graph_account` がある → `graph_account_unexpected`
- `rejection_reason` があり `status` が `active` → `rejection_with_active`

契約の列挙は `GRAPH_ACCOUNT_KINDS`・`GRAPH_DELEGATION_SCOPES`・`GRAPH_REJECTION_REASONS`・`GRAPH_CATEGORY_UPDATE_MODES` と同じにする。`scripts/graph-account.test.mjs` が照合する。

## 原本に決めがない項目

- 組織拒否の理由と API のエラーコードの対応は、設計 04 に理由を表示するとだけある。初期版はこの 5 つの語彙にまとめ、Graph の実際のエラーとの対応は B09-02 の模擬応答で確かめる（U174）。
- カテゴリの自動付与を有効にする条件（If-Match の検証・失敗時の扱い）は、B09-04 と B13 で決める。この ADR は `display_only` だけを許す。

## 試験（模擬だけ）

- `pnpm run contracts:check`: `graph-account-cases.json` の許可例・拒否例・意味検査の例、OpenAPI 3.1.2 を検査した。
- `node --test scripts/graph-account.test.mjs`: 契約の列挙と domain の語彙、拒否を active にしないこと、カテゴリの自動付与の値が存在しないことを検査した。
- `node --test scripts/contract-gate.test.mjs`: 写しの契約ゲートに新しい fixture を加えた。

**模擬の期待値だけ**。Graph の実 API・実アカウント・組織の拒否の実測は未実施で、合格扱いにしない。

## 残ること

- Microsoft Graph の読み取り connector とアカウント種別の判定は B09-02。
- 添付の取得と抽出は B09-03。
- 同期の走査と公開は B09-04（B08-05・B08-06 の実行器を再利用）。
- 接続画面の表示は B09-05。
- カテゴリの自動付与は、If-Match の検証と承認の設計（B13）まで実装しない。
