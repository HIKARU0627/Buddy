# ADR 0136: B08-05 同期の走査の実行器（排他・staging・公開の配線、同期の状態の経路、U207）

- 日付: 2026-11-22
- 状態: B08-05（親 #16）。保存層の sync 操作・Core の走査実行器・`getConnectionSync` のハンドラまで。実 API・実アカウントは未実施（B15 と本人の承認）。周期の起動（60 秒ポーリング・起動時の回復・担当世代の更新）は B08-06。
- 根拠: 設計 11 §1・§1A（F04）・§5B、設計 04 同期方式の選定・取得する対象、ADR 0007（domain の排他・公開 CAS の規則）、ADR 0071（同期の状態の契約）、ADR 0088・0089（取得対象の保存と経路。`getConnectionSync` は B08-05 まで処理を付けないとしていた）、ADR 0133（Google 読み取り connector。page_cursor の保存は B08-05 が持つとしていた）。原本の参照手順は `docs/design/README.md`。

## 決めたこと

| 対象                     | 決定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保存層                   | 新しい DB 経路 `sync` を足す（`packages/storage/src/sync-store.ts`）。操作は get_scope・list_scopes・list_published・begin・stage_page・validate・publish・abandon。規則の正本は domain の `sync.ts`（requestScan・scanCurrentReasons・publishScan・abandonScan）で、保存層は保存済みの状態へ規則を適用し、短い transaction で書く。マイグレーションは要らない（表は 0001 にある）                                                                                                                       |
| ページの仮置き           | 1 ページの staging と次の継続位置（page_cursor）の記録を同じ transaction にする（11 §1・D15）。ページの保存・検証・公開は、保存済みの active_scan_id・scope_revision・担当世代が一致するときだけ行い、古い走査の遅着は保存も公開もしない                                                                                                                                                                                                                                                                 |
| 公開                     | publish の transaction で差分を数えて domain の公開 CAS を通し、公開像（source_items）・watermark／cursor・完了時刻・batch の published・active_scan_id の解放を同じ commit に含める。差分は「版が違うか新規の upsert、公開済みに存在する delete／out_of_scope、全量のときだけ staging に無い公開済み行（不在）」。差分ゼロでも照合を省かず、世代は進めない。版が変わる行は body_blob_id を消す（古い本文を新しい版に結び付けない）                                                                      |
| 解析計画の無効化         | 差分のある公開で世代が進むと、保存済みの analysis_plan_complete_generation と一致しなくなるため、その世代の解析計画は未完了として扱われる（11 §5B の「公開の transaction で無効化」と同じ結果を、世代の照合で表す）。解析計画そのものの作成は B10・B11 の後続処理                                                                                                                                                                                                                                        |
| 実行器                   | `apps/core/src/sync-executor.ts` の `createSyncExecutor`。呼ばれたら 1 回だけ走る（タイマーを持たない）。固定窓は domain の窓の規則（メールは過去の選択日数まで、カレンダーは過去〜未来）で走査開始時に決め、query_fingerprint（範囲の版・窓・起点・対象のハッシュ）で再開を照合する。保存済みの継続位置があり条件が一致すれば続きから読み、一致しなければ触らない                                                                                                                                       |
| Gmail の増分と失効       | 起点は scope の provider_cursor（historyId）。追加・ラベルの増減は messages.get（minimal）で版（historyId）と選択ラベル・窓を確認してから仮置きし、範囲外は out_of_scope、削除は delete にする。history の 404（GoogleHistoryExpiredError）は旧走査を abandoned にして全量へ切り替える。全量は選択ラベルごとに ID を列挙し、既に公開済みの ID は保存済みの版で仮置きして、新しい ID だけ minimal で取得する。全量後の cursor は、取得したメッセージの historyId の最大値（無ければ従来の cursor を保つ） |
| Calendar の増分          | updatedMin は committed_watermark の 5 分前（11 §1）。取消（status=cancelled）は delete、全量では不在も削除にする。版は etag → updated の順、どちらも無ければ ID から決まる固定値（存在の差分だけは追える）                                                                                                                                                                                                                                                                                              |
| トークンと account       | トークンは接続ごとの出所（tokenSourceFor）を注入で受け、口が無い接続は走査しない（token_unavailable）。実 OAuth の保存・更新は B03-04。source_items の account_id は接続の作成（B03-04）が持つ識別子を呼び出し側が渡す（保存層は受けた値をキーに使うだけ）                                                                                                                                                                                                                                               |
| 同期の状態の経路         | `getConnectionSync` に処理を付ける（ADR 0089 の持ち越し）。応答は契約どおり接続につき 1 つの取得集合の状態で、保存層が scope_id 順に返す最初の取得集合を使う。取得集合がまだ無い接続は状態を作らず 503（取得集合の作成は接続の作成の責務）。last_attempt_at は、その取得集合の走査の開始時刻の最大値から作る（専用の列は足さない）                                                                                                                                                                       |
| U207（範囲変更後の全量） | **(b) 変更のたびに pending_full を立てる**。選択の変更で、その接続の全取得集合に pending_full を立てるよう `connection-targets-store` を変えた（ADR 0088 の (a) を置き換え）。新しく選んだフォルダー／ラベルの過去分は増分（history・updatedMin）では届かないため。実行器は pending_full があれば要求の種類より先に全量を行う                                                                                                                                                                            |
| connector のページ API   | B08-03 の connector にページ単位の読み取り（listEventsPage・listMessageIdsPage・listHistoryPage）を足し、全件版はその上に再構成した（ADR 0133 の持ち越し）。応答の検証規則は変えていない                                                                                                                                                                                                                                                                                                                 |
| 掃除ゲート               | 走査は外部の読み取りなので、入口表（apps/core の retention-entries.test.ts）へ gated で登録し、実行器が掃除の口（ready／gate／lease）を任意で受ける。ゲートが閉じている間は走査を始めず、取得から公開まで貸し出しを持って掃除の本体と直列にする。製品配線（core.ts から RetentionSweeper を渡す）は周期の起動と合わせて B08-06 で行う                                                                                                                                                                    |

## 試験（模擬だけ）

- `packages/storage/dist/sync-store.test.js`: 13/13 合格（connection-targets・db-worker と合わせた実行でも 36/36）。
- `packages/connectors/dist/google-connector.test.js`: 26/26 合格（既存 18＋ページ API の新規 8）。
- `apps/core/dist/sync-executor.test.js`: 9/9 合格。`api-connections.test.js`: 10/10 合格（同期の状態の新規 1 を含む）。`retention-entries.test.js`: 4/4 合格。
- 全体試験は CI と同じ 4 シャードを逐次実行し、全 3,300 件合格（シャード別 800・759・909・832）。初回実行でシャード 4 の X58（live-conversation、既知のフレーク）が 1 件取消になったが、再実行で合格した。
- 静的検査: build・typecheck・lint・format:check・contracts:check（1270 fixtures）・design:check（4 snapshots）・security:check（963 files）すべて合格。design:check と security:check は、スナップショットに無い `.local` の設計原本（メインクローンから複写）と一時的な git 初期化を使って実行した。
- 実 API・実アカウント・実データは未実施。模擬の成功を実 API の合格として扱わない。

## 残ること

- 周期の起動（60 秒ポーリング＋ジッター、起動時の全量、再起動時の担当世代の更新と旧走査の回復）は B08-06（起動時ゲート）。
- 接続の作成・OAuth・トークンの保存と更新、取得集合の作成、account_id の供給は B03-04。実接続が無い間、製品の起動では実行器は呼ばれない。
- 公開後の後続処理（解析計画の作成・抽出の enqueue、11 §5B の列挙）は B10・B11。event_outbox への同期イベントの記録は、契約に同期のイベント種別が無いため見送った。
- 添付の取得と抽出は B08-04。Outlook（Graph）の走査は B09-04 がこの実行器と保存層の形を共有する。
- `tests/test-map.json` の QA18・QA19・QA36・QA44 は、模擬の製品試験を足したが、実 API の証拠ではないので product_test の扱いは従来どおり据え置く。
- 公開時の忘却チェック（11 §1A の「TTL・忘却」）のうち忘却は未実装。忘却台帳の source_item は HMAC で記録され、照合には台帳の HMAC 鍵（封筒の素材で、今は復元の流れだけが開く）が要る。その口が用意されるまで、忘却した元情報の再取り込みを公開側では止められない。TTL 切れは、公開 transaction が現行の公開済みを読むことと、掃除ゲートの貸し出しによる直列化で扱う。
- 掃除ゲートの製品配線は B08-06。core.ts で実行器へ RetentionSweeper を渡し、retention-entries.test.ts の「ゲートを渡す入口は 3 つ」という数えを 4 つへ更新する。
