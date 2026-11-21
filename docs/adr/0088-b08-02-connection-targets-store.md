# ADR 0088: B08-02 取得対象の保存（読み取りと CAS 更新、旧走査の無効化）

- 日付: 2026-11-03
- 状態: B08-02（Issue #201、親 #16）の P2a。`packages/storage` の DB worker の操作まで。Core のハンドラと配線（P2b）・中枢の画面（P3）は未着手。実 API は未実施。
- 根拠: 設計 04 取得する対象（J13・J16）、設計 11 §1・§1A、設計 08 §3、ADR 0007・0018・0086・0087、本人の決定 D5・D8（2026-11-01）。原本の参照手順は `docs/design/README.md`。
- 対象: `packages/storage/src/connection-targets-store.ts`、`db-protocol.ts`・`db-worker.ts`・`db-client.ts`・`index.ts` の配線、`packages/storage/src/connection-targets-store.test.ts`、`docs/b00/contract-map.md` の U207・U208。

## 決めたこと

| 対象                 | 決定                                                                                                                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 経路                 | 新しい DB 経路は作らず、既存の `connections` 表（`targets` は JSON 列、`permission_revision`・`scope_revision` 列）を使う。**マイグレーションは要らない**。DB worker に操作 `connections.list`・`connections.get`・`connections.update_targets` を足す（`home` と同じ作り）               |
| 検査の正本           | 期間・サイズの上限、種類、ID は domain の `validateFetchScope`（ADR 0086）が正本。保存層は DB に書く前に形（7 項目だけ・配列）と意味を確かめ、拒否の理由はコード（`targets_invalid` と項目の理由）だけにする。値・SQL・パスを理由に入れない                                               |
| 変更の条件           | 期待する許可版が保存済みの許可版と一致するときだけ書く（compare-and-swap。不一致は `permission_revision_mismatch`）。切断済みの接続（`disconnected`）は変えない。存在しない接続は `connection_not_found`                                                                                  |
| 版                   | 選択に変更があれば `permission_revision` と `scope_revision` を 1 つずつ上げる。変更が無ければ（並び順・重複だけの違いを含む）何も書かず、版も上げない。保存は整列・重複なしの正規化した形                                                                                                |
| 旧走査の無効化       | 変更と同じ transaction で、その接続の取得集合（`sync_scopes`）の `scope_revision` を新しい版へ揃え、有効な走査（fetching・staged・validated）を `abandoned` にして `active_scan_id` を外す。種類に応じて `pending_full`／`pending_incremental` を立てる（domain の `abandonScan` と同じ） |
| 他の接続             | 他の接続の取得集合・走査・対象は変えない                                                                                                                                                                                                                                                  |
| 不完全な保存済みの値 | `targets` が空・4 項目なし・不正な行は、**何も選ばれていない状態**として読み（`targets_state: incomplete`）、取得させない。期間とサイズは設計の初期値（上限）を表示用に返すだけで、選択を足さない。同じ内容の保存でも、不完全な行は書き直す（U208）                                       |
| 読み取りの安全性     | 読み取りは何も書かない。書込みを止めた worker（成否不明など）は書かず、読み取りは続ける（ADR 0018）                                                                                                                                                                                       |
| 成否不明             | COMMIT の失敗は `unknown` で返し、以後の書込みを止める。照会が失敗しても書込みの成否を推測しない                                                                                                                                                                                          |

## 未決（B08-05 で決める）

変更後に全量照合を必ず要求するか（新しく選んだフォルダー／ラベルの過去分の取り込み）は設計に書かれていない（U207、提案 (b)）。この PR は `abandonScan` と同じ規則に留め、版と旧走査の無効化だけを保証する。

## 試験（模擬だけ）

- `node --test packages/storage/dist/connection-targets-store.test.js`（10 件）: 不完全な行を空の選択として読み広い既定値を作らないこと、最初の保存で書き直して両方の版が上がること、変更で整列して保存し版が 1 つずつ上がること、同じ選択（並び順違い）は何も書かないこと、古い許可版・切断済み・存在しない接続の拒否、設計の上限を超える値・小数・未知の種類・重複・空の ID・欠落・余計な項目の拒否で何も書かないこと、変更で旧走査が abandoned になり取得集合の版が揃い他の接続は変わらないこと、変更なし・拒否では走査に触れないこと、書込みを止めた worker は読むだけで書かないこと、DB worker 経由の読み取りと CAS 更新。期待値は設計の値と D5・設計 11 §1A から手で書き、実装の表から作らない。

**模擬の期待値だけ**。Core のハンドラ・画面・実 API・実アカウント・実データは未実施で、合格扱いにしない。

## 残ること

- P2b: Core の `getConnectionTargets`／`updateConnectionTargets`／`listConnections` のハンドラと配線（認可・ロック・画面の確認の検査は `ROUTE_CHECKS` のとおり）。
- P3: 中枢の画面での選択と表示。
- 接続の作成・OAuth・切断は B03-04。取得そのものは B08-03。
