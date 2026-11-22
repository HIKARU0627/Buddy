# ADR 0138: B09-04 Microsoft Graph の同期走査（実行器と provider 振り分け）

- 日付: 2026-11-23
- 状態: B09-04（親 #17）。Graph 用の走査実行器・provider 振り分け・core.ts の配線まで。模擬 connector の試験だけ。実 API・OAuth の実接続・実アカウントは未実施（B15 と本人の承認）。
- 根拠: 設計 11 §1（Outlook の行: 増分は選択フォルダーごとに lastModifiedDateTime ge 前回成功時刻の 5 分前、$top 50、全量は期間内の ID の全ページ列挙で削除・移動を検知）・§1A、設計 04 同期方式の選定（初期はポーリングと既取得 ID・版の比較。delta は唯一の正本にしない）、ADR 0134（Graph 読み取り connector。5 分前の計算は実行器が持つ）、ADR 0136（B08-05 の実行器と保存層。Outlook の走査は B09-04 が形を共有する）、ADR 0137（B08-06 の周期起動。Graph 用の実行器が入る時点で scheduler の実行器の差し替えが要る）。原本の参照手順は `docs/design/README.md`。

## 在庫確認

済んでいたもの: domain の排他・公開 CAS・回復の規則（provider 非依存）、保存層の sync 操作（publish・list_published は provider 'microsoft' を既に受ける）、Graph 読み取り connector のページ単位の読み取り（listMessagesPage、modifiedSince／receivedSince、cursor は nextLink）、周期起動（対象は provider を持たない）、同期の状態の経路 `getConnectionSync`（provider 非依存）。

本当の残件だったもの: Graph 用の走査実行器、scheduler が使う実行器の provider 振り分け、掃除ゲートの新しい入口の登録。

## 決めたこと

| 対象                | 決定                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 実行器              | `apps/core/src/graph-sync-executor.ts` の `createGraphSyncExecutor`。B08-05 の Google 用実行器と同じ形（開始→ページごとの staging→検証→公開、再開の照合、pending_full の優先、掃除ゲート）で、同じ `SyncExecutor` の形を返す。対象はメールだけ（Graph connector に予定の読み取りは無い）で、予定の要求は `resource_unsupported`         |
| 増分                | 選択フォルダーごとに `listMessagesPage`（modifiedSince＝committed_watermark の 5 分前。設計 11 §1）。起点は時刻型 watermark だけで、provider cursor は持たない（delta を使わない。設計 04・ADR 0134）。起点が無ければ全量から始める                                                                                                     |
| 全量                | 選択フォルダーごとに receivedSince＝固定窓の開始で全ページを列挙し、全件を仮置きする。不在の削除と範囲外への移動の検知は保存層の公開が担う（全量のときだけ staging に無い公開済み行を消す）。窓の後に届いたメールは今回の固定窓に入れない                                                                                               |
| 版と比較            | source_revision は lastModifiedDateTime（無ければ ID から決まる固定値）。基本キーは immutable_id で所属フォルダーはキーに含めないため、フォルダー移動は版の差分として表れる（QA23）。増分で届いた受信が窓の外のメールは out_of_scope として仮置きする                                                                                   |
| 継続位置            | page_cursor は Google 用と同じく「フォルダーの位置＋ページトークン」の JSON。トークンは Graph の nextLink（完全な URL）そのもの。固定条件の指紋は provider 名（microsoft）・窓・範囲の版・起点の watermark から作る                                                                                                                     |
| 失敗の表面化        | connector の結果型を理由コードへ写す。rejected は `graph_rejected:<理由の語彙>`、401 は `graph_authentication_expired`、429 は `graph_rate_limited`、unavailable は `graph_unavailable:<理由>`。途中失敗では公開せず、走査は継続位置まで保存した状態で残す。状態コード・応答本文・トークンは理由に入れない                              |
| provider の振り分け | `apps/core/src/provider-sync-executor.ts` の `createProviderSyncExecutor`。接続を保存層で確かめ、provider で該当の実行器へ渡す薄い振り分け。scheduler 本体は変えず、core.ts が scheduler と CoreHandle へこの振り分けを渡す（ADR 0137 の「実行器の差し替え」は配線で行う）。接続が読めない・無いときはどちらの実行器も呼ばない          |
| 製品配線            | core.ts は Graph 用実行器も常に作り、Google 用と同じ掃除のゲート（RetentionSweeper の ready／gate／lease）を渡す。入口表（retention-entries.test.ts）に graph-sync-executor.ts を gated で足し、core.ts のゲートの数えを 4 から 5 へ更新した。トークンの出所は CoreSyncOptions の `graphTokenSourceFor`（接続の作成 B03-04 が用意する） |
| 公開                | 保存層の sync.publish に provider 'microsoft'・provider_cursor null で渡す。公開世代・watermark（＝走査開始時刻 T）・完了時刻の規則は domain の publishScan のまま                                                                                                                                                                      |

## 設計どおりにできなかったこと（残件として明記）

- **フォルダー単位の全量間隔**（設計 11 §1: 受信トレイは 15 分ごと、その他のフォルダーは 6 時間ごと）。公開と不在判定は scope（取得集合）単位で、フォルダー別の照合状態（last_full_reconciled_at 相当）が保存層に無いため、フォルダーごとに全量の時刻を変える形は現在の保存の形では表現できない。scope の全量は scheduler のメール間隔（6 時間）に従う。受信トレイの新着は 60 秒ごとの増分（lastModifiedDateTime）で届くため、15 分の全量が担うのは受信トレイ内の削除・移動の検知の早さだけが遅れる。フォルダー別の照合状態を足すかは、実 API の API 回数の実測（B15）と合わせて判断する。
- U175（カテゴリの自動付与を有効にする条件）は、カテゴリの付与が書込みで B13 の承認・If-Match の検証が前提のため、本作業（読み取りの走査）では決めない。ADR 0072 の display_only のまま据え置く。

## 試験（模擬だけ）

- `apps/core/dist/graph-sync-executor.test.js`: 実際の DB worker と台本の偽 connector で、全量（複数フォルダー・ページング・版と不在の差分）、増分（watermark の 5 分前・差分ゼロで世代据え置き・フォルダー移動の版差分・窓の外の out_of_scope）、起点なしの全量への切替え、pending_full の優先、拒否・認証切れ・429・利用不可の失敗コード、途中失敗からの再開（保存済み cursor）、provider・資源・トークンの guard を確かめる。期待値は設計 11 §1・§1A から手で書いた。
- `apps/core/dist/provider-sync-executor.test.js`: provider ごとの振り分けと、接続が無い・保存層が使えないときにどちらの実行器も呼ばないこと。
- `apps/core/dist/retention-entries.test.js`: 新しい実行器が gated の入口として表に載り、core.ts がゲートを 5 つの入口へ渡すこと。
- 全体試験は CI と同じ 4 シャードを逐次実行し、合計 3,362 件中 3,360 件合格・失敗 0・取消 2（シャード別 981・713・909・759）。取消はシャード 1 の X51／QA05 と X58（live-conversation、既知のフレーク）で、単独再実行では対象群 7/7 合格と切り分けた。静的検査: build・typecheck・lint・format:check・contracts:check（1270 fixtures）・design:check（4 snapshots）・security:check（978 files）すべて合格。design:check と security:check は B08-05・B08-06 と同じく、設計原本の複写と一時的な git 初期化を使って実行した。
- 実 API・OAuth の実接続・実アカウントは未実施で、模擬の成功を実 API の合格として扱わない。`tests/test-map.json` の QA18・QA19・QA36・QA44 は ADR 0136 と同じく据え置く（模擬の製品試験は実 API の証拠ではない）。

## 残ること

- 実 API・OAuth の実接続・実アカウントでの確認は B15 と本人の承認の後。接続の作成・トークンの保存と更新、取得集合の作成、account_id の供給、targetsFor／tokenSourceFor の製品供給は B03-04。実接続が無い間、製品の起動では Graph の実行器も呼ばれない。
- 添付の取得と抽出は B09-03。接続画面（アカウント種別・拒否の理由・取得範囲の選択）は B09-05。
- フォルダー単位の全量間隔は上記のとおり未実装（フォルダー別の照合状態が前提）。
- 公開時の忘却チェック（設計 11 §1A）は ADR 0136 の持ち越しのまま（忘却台帳の HMAC 鍵の口が前提）。
- B08-03 の HTTP の土台への Graph 既定 transport の差し替え判断は ADR 0134 の持ち越しのまま（本作業は connector の注入点を使うだけで、transport は変えていない）。
