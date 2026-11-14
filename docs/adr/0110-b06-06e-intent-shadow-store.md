# ADR 0110: B06-06e 影モードの比較記録の SQLite 保存（DB worker の命令・件数・上限）

- 日付: 2026-11-14
- 状態: B06-06e（親 #142、関連 #143・#18、Issue #245）の判断。`ShadowRecordStore` の口（ADR 0092）に DB worker の命令を足す。**保存側の前提の検査（入力の存在・期限の一致・保存モード）と Core の配線は続きの PR**（下の「残ること」）。マイグレーションは足していない（表 `intent_shadow` は 0001 にある）。契約（`IntentShadowRecord`・OpenAPI）は変えていない。実 API・実請求・実機は未実施。
- 根拠: 設計 03（保存期限・忘却と再取り込み）、設計 10 §5、設計 09 X48、ADR 0008・0018・0040・0092、`packages/storage/migrations/0001_initial.sql`（`intent_shadow`）、`packages/storage/src/expiry-store.ts`・`forget-store.ts`（既存の掃除と閉包）、本人の決定 D4（2026-11-01、既定 OFF）。非公開の原本は写していない。
- 対象: `packages/storage/src/intent-shadow-store.ts`（新規）、`db-protocol.ts`・`db-worker.ts`・`db-client.ts`・`index.ts`、`intent-shadow-store.test.ts`・`db-worker.test.ts`、`docs/b00/contract-map.md`（U260）。

## 決めたこと

| 対象                  | 決定                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 命令                  | `intent_shadow.save`（1 入力の比較の記録を 1 行）と `intent_shadow.count`（campaign ごとの件数）。store ごとのファイルに分け、`DbWorkerClient.intentShadow` から 1 命令 1 往復。                                                                                                                                                               |
| 上限（原子性）        | `save` は `BEGIN IMMEDIATE` の transaction の中で、(1) 同じ組の有無、(2) campaign ごとの件数、(3) INSERT の順に判定する。件数の確認と INSERT が同じ transaction なので、Core の事前の確認（ADR 0092 の開始前・送る直前）とは別に、保存側でも 300 件を超えない。                                                                                |
| 同じ組                | `(campaign_id, input_id, request_revision)` が同じ保存は書かずに `duplicate`。`record_id` が違っても増やさない（表の一意制約が正本）。再送・再起動の後の再保存で二重にしない。                                                                                                                                                                 |
| 判定の順              | `duplicate` を `limit_reached` より先に見る。すでにある行は「上限で書けなかった」のではなく、内容が変わっていない。上限に達した campaign へ同じ組を再送しても `duplicate`。                                                                                                                                                                    |
| 結果の語              | `saved`（書いた）・`duplicate`（同じ組があった）・`limit_reached`（上限で書かなかった）。どれも書込みの失敗ではない。拒否（形の不正・`worker_halted`・耐久設定の不一致）と、成否不明（COMMIT の失敗）は `ok: false` で分ける（Core は `failed` に対応づける）。                                                                                |
| `limit` の範囲        | 1〜300 の整数だけを受ける。設定や呼び出し側が 300 を超える値を渡しても、保存側は書かない（`limit_invalid`）。300 は Core の `SHADOW_MAX_INPUTS` と同じ値を storage 側にも写しで持つ（storage は `@buddy/contracts` に依存しない）。                                                                                                            |
| `judgments` の列      | 表の列にならない部分（`schema`・`primary`・`shadows`・`used_for_execution`）を JCS の JSON（`canonicalIntentJson`）で置く。行から `IntentShadowRecord` を組み直せる。契約の意味検査は Core が行う（保存側は形の最低限だけを見る）。                                                                                                            |
| 実行に使わない印      | `used_for_execution` が `false` でない記録は書かない（契約の `const false`。影の判定を実行に使わない規則を保存側でも破らせない）。                                                                                                                                                                                                             |
| 時刻                  | `recorded_at`・`expires_at` は UTC の ISO 8601（末尾 `Z`）だけを受け、ミリ秒で行に置く。`expires_at > recorded_at` は保存側でも確かめ、表の CHECK が最後に保証する。DB は時計を持たず、呼び出し側の値を信じる。                                                                                                                                |
| JSON にできない値     | `judgments` の JSON 化（`canonicalIntentJson`）が失敗する記録（引数の `NaN`・`Infinity` など）と、形は合うが暦にない日時（`Date.parse` が `NaN`）は、**入力の拒否**として返す（`judgments_invalid`・`recorded_at_invalid`・`expires_at_invalid`）。想定外の例外として DB worker を halted にしない（止めると、無関係の命令まで通らなくなる）。 |
| 既存の掃除・閉包      | 書き方は既存の `expiry-store`（`intent_shadow` は期限を持つ派生物）、`forget-store`（`input_snapshots` との結合で発言に帰属）に合わせた。行の形を変えないので、掃除・閉包・復元の経路はそのまま働く。                                                                                                                                          |
| campaign の開始・停止 | 保存しない。件数は `COUNT` で導ける。開始日時・上限・実費の上限の置き場と、実費の合計の正本は U260 に記録し、B15 の設定の読み込みと一緒に本人が決める。                                                                                                                                                                                        |

## 試験（模擬だけ）

- `packages/storage/src/intent-shadow-store.test.ts`: 保存で件数が 1 増える・campaign ごとに数える。同じ組の再保存（`record_id` 違いを含む）は `duplicate` で行が増えない。版が違えば別の行。上限で書かない（`limit_reached`）。**299 件から 2 件保存して 1 件だけ**保存。一意制約が表にある。`limit` の範囲（0・301・1.5）。契約に合わない記録（`used_for_execution`・期限の前後・版・`shadows` 空・ID の形・outcome・schema）を書かない。書込みを止めた worker は書かず件数は読める。`judgments` の列の中身とミリ秒。DB を開き直しても件数が引き継がれ、再保存で二重にならない。
- `packages/storage/src/db-worker.test.ts`: クライアントと worker の間で `count` → `save` → 再送（`duplicate`）→ `count` が往復する。

**模擬のみ**。実 API・実請求・実機・実 endpoint は未実施で、合格扱いにしない。

## 残ること

- 保存側の前提の検査: `input_id`（と `request_revision`）が `input_snapshots` にあり `turn_id` が結び付いていること、`expires_at` が `turns.expires_at` と一致すること、保存モードの `record_shadow` が許可されていること（続きの PR）。
- Core の配線: `onInterpreted` と `createShadowRecorder` の実ストア、本番の `privateConversation`・`liveSessionOpen`・`slotAvailable`・`spent`（続きの PR）。
- 起動時の設定（campaign・比較モデルの配備 ID・endpoint・認証）と `planModelCalls` の配線は B15 と本人の承認（U260 の判断もそこで行う）。
- 集計（`ShadowCampaignSummary`）と採否は B10-07。
