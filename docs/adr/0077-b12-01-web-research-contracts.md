# ADR 0077: B12-01 公開 Web 調査の契約（Brave・一時保持・訓練に使わない）

- 日付: 2026-11-14
- 状態: B12-01 の契約と規則。検索アダプター・取得・抽出・表示は未着手。**実 API は呼んでいない**。
- 根拠: 設計 05「公開Web調査」「費用の計算」、設計 06 B12、設計 09 X18・T08、ADR 0034・0042、`docs/b12/search-service-comparison.md`、本人の決定（2026-11-03、D2）。
- 対象: `packages/contracts/schemas/buddy.schema.json` の `WebSearchRequest`・`WebSearchHit`・`WebSearchResponse`・`WebFetchRequest`・`WebFetchResult`・`WebResearchSource`・`WebResearchLimits`・`WebUsagePolicy`、`packages/domain/src/web-research.ts`、`packages/contracts/fixtures/web-research-cases.json`、`scripts/web-research.test.mjs`。

## 決めたこと

| 対象           | 決定                                                                                                                                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 検索サービス   | **Brave Search API** を採用する（本人の決定 2026-11-03、D2）。比較の記録は `docs/b12/search-service-comparison.md`。DeepSeek（Search／Fetch）は API 入力の学習利用の除外を確認できないため採用しない                                                                                                 |
| 検索結果の保存 | **永続保存しない**。検索結果は操作中の一時保持だけにし、データベース化・キャッシュ・再配布をしない（Brave 利用条件 3(b)(i)）。契約では `WebSearchResponse.retention` を `transient_only` に固定する                                                                                                  |
| モデルの利用   | 検索結果と取得本文は回答の根拠（grounding）にだけ使い、モデルの訓練・再訓練・評価・ベンチマークに使わない（Brave 利用条件 3(b)(xiii)）。契約では `model_use` を `grounding_only` に固定する                                                                                                          |
| 出典           | 出典の抜粋・要約は、**自分で取得した本文**から作る。検索結果の要約だけのものは `search_summary_only` として区別し、抜粋・要約を永続保存しない（`excerpt`・`summary` は null）                                                                                                                        |
| 取得           | HTTPS の公開ページだけを、1 ページ 2MB・15 秒・リダイレクト 3 回まで取得する。認証 Cookie を付けず、ローカル・プライベート・リンクローカルへの取得を拒否する（IPv6 の ULA・リンクローカル・IPv4 mapped も含む）。読めない形式（PDF 等）は `text: null`・`readable: false` とし、読めたものと区別する |
| 上限           | 1 依頼あたり検索 3 回・参照本文 5 ページ。品質の保証ではなく処理と費用の上限で、予算不足では範囲を減らすか保留する                                                                                                                                                                                   |
| URL の保存     | `WebResearchSource.url` は null を許し、永続保存してよいかは B12-02 で決める（U183）。決めるまでは `WebUsagePolicy.url_storage` を `undecided` にする                                                                                                                                                |
| 表示           | Brave の帰属表示は任意だが、設計 05 の方針どおりアプリに「Brave の検索を利用」を置く。表示の最終文言は B12-05                                                                                                                                                                                        |
| 予算           | 検索は B07 の検索の枠（300 円／月）へ計上する。170 円／米ドル・安全係数 1.2 では 1 検索 1.02 円、300 円で約 294 検索（1 依頼 3 検索で約 98 依頼）。実請求は未検証                                                                                                                                    |

## 利用条件との整合

- **3(b)(i) 保存の制限**: 検索結果は応答の処理中だけ保持し、DB・ファイル・キャッシュへ保存しない。保存するのは自分で取得した本文から作った抜粋・要約と、その取得時刻だけにする。検索結果のスニペットを出典として保存しない。
- **3(b)(xiii) モデルの利用の制限**: 検索結果・取得本文を、モデルの訓練・評価・改善・ベンチマークに使わない。LLM へは回答を作るための根拠としてだけ渡し、学習用のデータセットへ入れない。
- **帰属**: Brave の利用条件は帰属を任意とし、付ける場合は「POWERED BY BRAVE」とロゴを求める。設計 05 の方針でアプリに表示を置くが、ロゴの利用条件は B12-05 で確認する。
- **再配布**: 検索結果を第三者へ再配布しない。出典は本人への表示に限る。

## 契約の形

- `WebSearchRequest` は検索語・言語・国・最大件数・安全検索だけを持つ。検索語にメール全文・API キー・個人の予定を入れない。
- `WebSearchResponse` は `retention: 'transient_only'` と `model_use: 'grounding_only'` を必須にし、保存用の項目を持たない。`search_index` は 1〜3。
- `WebFetchRequest`・`WebFetchResult` は 2MB・15 秒・3 リダイレクトを上限にし、`send_cookies` を false に固定する。`readable` と `text` の組み合わせを意味検査で確かめる。
- 取得先の判定は domain の `privateWebTargetReason` が持つ（IPv4 の 0/8・10/8・127/8・100.64/10・169.254/16・172.16/12・192.168/16・198.18/15・文書用・224/4 以上、IPv6 の ULA・リンクローカル・サイトローカル・マルチキャスト・文書用・IPv4 mapped）。B12-04 は接続のたびと各リダイレクトの後に、名前解決したアドレスでも同じ判定を行う。リテラルの IP だけでは足りない。
- `WebResearchSource` は `page_read` と `search_summary_only` を区別する。`page_read` は取得時刻と本文の抜粋または要約を必須にし、`search_summary_only` は取得時刻・抜粋・要約を null にする。
- `WebResearchLimits` は設計 05 の初期値を const で固定する。`WebUsagePolicy` は Brave・一時保持・grounding だけを許し、URL の保存は未決を表せる。
- `webResearchUsageErrors`・`webFetchUsageErrors`・`webSourceErrors`・`webUsagePolicyErrors` が境界を判定する。

## 試験（模擬だけ）

- `pnpm run contracts:check`: `web-research-cases.json` の許可例・拒否例、OpenAPI 3.1.2 を検査した。
- `node --test scripts/web-research.test.mjs`: 3 検索・5 ページ・2MB・15 秒・3 リダイレクトの境界、private 宛先の拒否、page_read と search_summary_only の区別、policy の const を検査した。
- `node --test scripts/contract-gate.test.mjs`: 写しの契約ゲートに新しい fixture を加えた。

**模擬の期待値だけ**。実 API・実請求・実測（日本語品質・遅延・失敗率）・実機は未実施で、合格扱いにしない。

## 残ること

- URL の永続保存の可否は B12-02（U183）。法務確認も B12-02 で行う。
- 検索アダプターは B12-03、取得と抽出は B12-04、表示と帰属は B12-05、完了条件は B12-06。
- 実 API の確認は B15 と本人の承認の後。
