# ADR 0125: B12-02 公開 Web 調査の受付・進捗・完了（失敗を完了と表示できない形）

- 日付: 2026-11-14
- 状態: B12-02（親 #27、Issue #264）の P1。契約と規則だけ。検索アダプター・取得・workflow・画面・保存は未着手。**実 API は呼んでいない**。
- 根拠: 設計 05「公開Web調査」、設計 10 §5「裏のジョブ」「即時ジョブの上限」、設計 11 §4（`research_done`）、Issue #27 の完了条件（失敗を完了と表示しない・出典を確認できる）、ADR 0073・0077。原本の参照手順は `docs/design/README.md`。
- 対象: `packages/contracts/schemas/buddy.schema.json` の `WebResearchState`・`WebResearchStopReason`・`WebResearchStop`・`WebResearchResult`・`WebResearchStatus`、`packages/domain/src/web-research-status.ts`、`packages/contracts/fixtures/web-research-status-cases.json`、`scripts/web-research-status.test.mjs`。

## 決めたこと

| 対象                 | 決定                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 受付                 | 調査（`research` 意図）は最初から裏のジョブへ回し、受け付けたら `WebResearchStatus` が `accepted` になる。受付の発話は既存のコードの定型文（`acceptedCommentary`）で、結果の内容を含めない。受け付けていない依頼には使わない                                                                                                                                 |
| 状態                 | `accepted`・`searching`・`reading`・`summarizing`・`completed`・`no_results`・`held`・`failed`・`canceled` の 9 つ。終端は `completed`・`no_results`・`failed`・`canceled`。`held` は終端ではなく、予算の回復か本人の操作を待つ保留                                                                                                                          |
| 完了                 | `completed` は「自分で取得した本文を 1 ページ以上読み、要約を作れた」ときだけ。`result` を持てるのは `completed` だけで、それ以外の状態に `result` や出典のリンクを載せると意味検査が拒否する。失敗・0 件・保留・取消は、結果を持てないので完了の形にならない                                                                                                |
| 完了と表示できる条件 | `webResearchDisplayLabel` が `completed` を返すのは、状態が `completed` で、意味検査に 1 件も引っかからないときだけ。項目の整合が取れない応答は `unconfirmed`（確認できない）にし、完了と出さない。画面側が状態名だけで「完了」と出さず、この判定を使う（B12-05）                                                                                            |
| 完了にならない理由   | 0 件は `no_results`／`zero_hits`。保留は `held`（`budget_held`・`query_rejected`）。失敗は `failed`（`search_failed`・`no_readable_page`・`summary_failed`）。取消は `canceled`（`user_canceled`・`superseded`）。**検索の失敗と 0 件を同じ状態にしない**。読めたページが 1 件も無いときは検索の結果があっても完了にせず `failed`／`no_readable_page` にする |
| 遷移                 | 手で書いた表を domain が持つ（`accepted`→`searching`・`searching`→`reading` または `no_results`・`reading`→`searching` または `summarizing`・`summarizing`→`completed`、各段階から `held`・`failed`・`canceled`）。終端からは動かない。`held` からは `searching`（検索からやり直す）か `canceled` だけ                                                       |
| 版                   | 応答は `request_revision`（本人の依頼の版）と `state_revision`（処理状態の更新番号）を別に持つ。遷移では `state_revision` が 1 ずつ進み、同じ `workflow_id`・`request_revision`・`accepted_at` の中だけで動く。内容の版（`content_version`）は使わない                                                                                                       |
| 完了の知らせ         | 候補の種類 `research_done`（ADR 0073）は完了のときだけ作る（`webResearchNotificationParts`）。識別子の材料は ADR 0073 の「kind・workflow_id・完了の版」で、**完了の版は完了した応答の `state_revision`**（U291）。失敗・0 件・保留・取消は `research_done` にしない。それらの知らせ方は B12-05                                                               |
| 出典の数             | 完了の出典は 1〜5 件、読んだページと読めなかったページ（`unread_count`）の合計は 5 以下。範囲を上限や予算で減らしたときは `scope_reduced` を true にし、減らしたことを隠さない                                                                                                                                                                               |
| 保存・再起動         | 状態の保存（DB・世代・再起動後の扱い）は B12-05。この ADR は応答の形と規則だけを決める。`transient_links` は保存する形に含めない（ADR 0126）                                                                                                                                                                                                                 |

## 原本に決めがない項目

- 設計 05 は「取得失敗・会員限定・PDF 等で本文を解析できない場合は、読めたものと検索要約だけのものを区別します」と書くが、**検索要約だけで完了にしてよいか**は書かれていない。Issue #27 の完了条件（失敗を完了と表示しない）と B12-05 の完了条件（失敗・会員限定を完了にしない）から、読めたページが無いものは完了にしない側に倒した（U293、暫定）。検索要約は Brave の検索結果なので、保存もできない（ADR 0077）。
- 保留した調査をどこから再開するかは書かれていない。検索結果と取得本文を保存しないので、続きから読み直せる材料が残らない。**検索からやり直す**とした（U292、暫定）。やり直しは新しい検索の費用予約を伴い、1 依頼の上限（3 検索・5 ページ）の残りを使う。数え方は PR2（ADR 0128）。
- 訂正・取消で古い依頼を失効させるときの理由 `superseded` は設計 10 §5「取り消し・訂正」の語に合わせた。画面側の表示は B12-05。

## 試験（模擬だけ）

- `pnpm run contracts:check`: `web-research-status-cases.json` の許可例・拒否例（失敗・0 件・保留・取消に結果を載せた形、完了に結果が無い形、出典が 0 件・6 件の形、検索結果の項目を足した形）と OpenAPI 3.1.2 を検査した。
- `node --test scripts/web-research-status.test.mjs`: 状態ごとに持てる項目、完了と表示できる条件、遷移表（全組み合わせ）、状態の版、`research_done` の材料を、手で書いた期待値と照合した。
- `node --test scripts/contract-gate.test.mjs`: 写しの契約ゲートに新しい fixture を加えた。

**模擬の期待値だけ**。検索アダプター・取得・画面・保存・実 API・実請求・実機は未実施で、合格扱いにしない。

## 残ること

- 上限の数え方と、失敗の細かい区別（取得の失敗・会員限定・読めない形式・過大・遅延）は PR2（ADR 0128・0129）。
- 状態の保存・裏のジョブ・画面・完了の気づきの出し方は B12-05。
- 出典の永続形と URL の扱いは ADR 0126、検索語の検査は ADR 0127。
