# ADR 0018: DB worker と操作・承認・受付の保存

- 日付: 2026-10-20
- 状態: B02-03（#55）の判断と実装。`packages/storage` に DB worker（worker_threads）と Core main 側のクライアント、操作・内容版・承認・試行・命令の受付・イベントの送出記録の保存、送出の許可（DispatchPermit）の境界を作り、一時ファイルの DB で試験した（模擬。CI の 3 OS）。Core への組み込みと再起動の復元（B02-04）、本文の暗号化（B02-02）、外部送出（B04）、電源断の耐久性（X60）は対象外で未実施。
- 根拠: 設計 11 §9（DB worker P06）、08 §1〜§5、07 §2・§3、03 保存期限、設計改訂 v1.2 の P06（`.local/design/notion/design-revision-v1.2.md`）、ADR 0009・0010・0016。設計 08・11・07 の本文は今回の作業環境に取得できず、司令塔から受け取った要約と v1.2 の P06 の節に基づく。原本との照合はレビューで行う。

## 決めたこと

| 対象                 | 決定                                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB worker            | 起動時から専用の worker_threads が better-sqlite3 の書込み接続を所有する単一 writer。`openWriteConnection`（耐久設定の読み戻し）と `applyMigrations` が成功してから受付を始める。メッセージを一つずつ同期で処理し、外部 HTTP・LLM を実行しない                         |
| transaction          | 1 命令を 1 つの BEGIN IMMEDIATE の短い transaction で処理し、状態の更新・`event_outbox`・`command_receipts` を同じ transaction で書く。本体は同期関数だけ（Promise を返せば巻き戻して拒否）。BEGIN・COMMIT・ROLLBACK を明示し、本体の失敗と COMMIT の失敗を区別する    |
| 耐久設定             | 接続の作成時に加えて、命令ごとに transaction の前で PRAGMA を読み戻す（`writeConnectionReasons`）。違えば記録せず `durability_mismatch` で拒否し、以後の書込みを止める。worker 化を理由に NORMAL へ下げない                                                            |
| 結果の 4 種          | durable（コミット済みの state_revision）・accepted（受付だけ記録し状態は変えていない）・rejected（適用していないことが確か）・unknown（成否不明）                                                                                                                      |
| 成否不明             | COMMIT の失敗は未 commit と決めつけずに unknown とする。worker の異常終了・応答なし（既定 30 秒）も unknown。どちらも送出の許可を出さず、クライアントは以後の命令を送らない（broken）。新しい worker で永続レコードを照会してから進める                                |
| 書込みの停止（halt） | 成否不明・想定外の失敗（I/O・ディスクの空き・注入した例外）・耐久設定の不一致の後、worker は以後の命令を `worker_halted` で拒否する。接続の作り直しは前の世代の worker の終了（exit）を待ってから新しい worker で行う。制約違反と書込みの競合（SQLITE_BUSY）は止めない |
| state_revision       | 作成で 1、状態を一つ進めるごとに 1 ずつ増やす。命令の expected_state_revision と一致しなければ拒否する（作成は 0）                                                                                                                                                     |
| 送出の許可           | `DispatchPermit` は、この世代の worker が送出意図（dispatching）の COMMIT の成功を返したときだけクライアントが作る。一度だけ使える（`consumeDispatchPermit`）                                                                                                          |
| 大量書込み           | `writeBulkSlice` は最大 50 件または 20ms で transaction を区切る（1 件は必ず書く）。間に他の命令を処理できる。fsync が 20ms 以内に終わる保証ではない。同期の取り込み（後続の工程）で使う                                                                               |
| 計測                 | 命令ごとに IPC と待ち行列の待ち・transaction・COMMIT・往復の時間をクライアントの `onMetrics` へ渡す（記録の口だけ。WAL の大きさ・checkpoint・長い読み取りの計測は後続）                                                                                                |
| 依存                 | 新しい外部依存はない。`@buddy/storage` から `@buddy/domain`（workspace）を参照し、`approvalDecision`・`commandGuard`・`replayDecision`・`canTransition`・`RETENTION_RULES` を使う                                                                                      |

## 命令の約束

型は `packages/storage/src/operation-commands.ts`。どの命令にも次を付けます（domain の `DbCommand` と同じ形）。

| 項目                      | 意味                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `command_id`              | 命令の ID。同じ command_id の再到着は `command_receipts` を照会して保存済みの結果を返し、二度適用しない。内容が違えば `command_id_reused` |
| `kind`                    | `operation.create`・`approve`・`prepare`・`dispatch_intent`・`record_result`・`cancel`                                                    |
| `expected_state_revision` | 呼び出し側が見たコミット済みの版（10 進の文字列）。作成は 0                                                                               |
| `request_revision`        | 依頼の版。`workflows.current_request_revision` と照合する。workflow のない操作は null                                                     |
| `permission_revision`     | 許可の版。`connection_id` があれば `connections.permission_revision` と照合する                                                           |
| `forgetting_generation`   | 忘却台帳の世代。`forget_ledger` の最大の世代（なければ 0）と照合する                                                                      |
| `connection_id`           | 操作が使う連携の接続。外部変更の送出意図では必須                                                                                          |
| `request`                 | 端末からの要求の接続範囲・request_id・照合値（07 §3）。null は Core 内部の命令                                                            |

本文（確定 intent）は B02-02 が暗号化した `sealed_blobs` の 1 行（blob_id・形式版・key_id・nonce・暗号文・認証タグ）として渡し、平文を渡しません。preview の有効性と方針の現在の版は DB に正本がないため、Core が判定して命令に入れます。

### 受付（command_receipts）

- 端末の要求は接続範囲＋request_id、内部の命令は接続範囲 `core-internal`＋command_id で記録します。内部の照合値は命令をキー順の JSON にした SHA-256 です。
- 同じ接続範囲・request_id・同じ照合値は保存済みの受付結果を返し（`replayDecision` の replay）、照合値が違えば `request_conflict`（409 相当、X04）で拒否します。
- 受付は状態の更新と同じ transaction で `durable`（コミット済みの版）として書きます。送出後の取消だけは `accepted`（版なし）で書き、状態を変えません。拒否した命令は記録しません。
- 同じ内容版の有効な承認が既にある承認（X02）は新しく作らず、現在の版を `durable` の受付結果にします（`existing`）。

### 受付 ACK と durable ACK

`DbWorkerClient.submit()` は `received`（worker が受け取った受付 ACK）と `result` を分けて返します。`received` は保存済みの意味を持たず、送出の根拠にしません。「保存済み」「送出」へ進めるのは `result` が durable のときだけです（07 §2）。

## transaction の分け方

| 段（08 §3）      | 命令                        | transaction の中で確かめること                                                                                                                                                                     | 書くもの                                                                        |
| ---------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 作成             | `operation.create`          | 操作がまだない、依頼・許可・忘却の版（`commandGuard`）、自動承認なら方針の版（`approvalDecision`）                                                                                                 | operations・sealed_blobs・operation_versions（版 1）・自動承認・イベント・受付  |
| 承認             | `operation.approve`         | `approvalDecision`（内容版・hash・状態版・承認待ち・preview・方針の版、既存の承認）と `commandGuard`                                                                                               | approvals（valid）・approved・イベント・受付                                    |
| ① 準備権         | `operation.prepare`         | 状態版、approved か未実行の確定からの再試行、版、現在の内容版の有効な承認と hash                                                                                                                   | operation_attempts（preparing）・preparing・イベント・受付                      |
| ② 最新状態の確認 | （transaction の外）        | 対象と許可の最新状態の確認は Core とアダプターの担当（B04）。結果の版を ③ の命令に入れる                                                                                                           | —                                                                               |
| ③ 送出意図       | `operation.dispatch_intent` | 耐久設定、状態版、試行が preparing、内容版が最新、承認が有効で hash が一致、外部変更なら接続が active かつ read_write、`commandGuard`（external: 依頼・許可・忘却・安全停止・予算予約が reserved） | 試行を dispatching（dispatch_intent_at）・dispatching・イベント・受付           |
| ④ 結果           | `operation.record_result`   | 状態版、遷移が `OPERATION_TRANSITIONS` にある、試行が操作と同じ状態で送出済み。許可・忘却の版の変更では拒否しない（送出済みの結果を失わない）                                                      | 試行の状態・result_status・external_id、成功なら承認を consumed、イベント・受付 |
| 取消             | `operation.cancel`          | 状態版。送出前（承認待ち・approved・preparing）は確定、送出後（dispatching・reconciling・unknown_held）は受付だけ                                                                                  | cancelled・準備中の試行を cancelled・イベント・受付、または受付（accepted）だけ |

外部送出（④ の前の一度だけの送信）は transaction の外で、Core main の実行担当が許可を使って行います（B04）。自動リトライはしません。

## 送出の許可の境界

- 許可を作る条件: 命令が `operation.dispatch_intent`、worker の結果が durable で再到着（replayed）ではない、今回コミットした試行（`dispatched`）が命令の attempt_id と一致、応答の worker の世代・command_id・operation_id・種類が送った命令と一致、クライアントが running。
- 作らない場合: rejected（耐久設定の不一致・版の不一致・COMMIT 前の失敗）、unknown（COMMIT の失敗・worker の異常終了・応答なし）、再到着（同じ command_id で保存済みの dispatching を返しただけ）、別の世代の応答。
- 許可のコンストラクタはモジュール内の合言葉がないと例外を投げ、外部から作れません。クライアントは自分が作った許可だけを、worker が動いている同じ世代の間に一度だけ `consumeDispatchPermit` で使わせます。worker の再起動の後は古い許可を使えません（古い世代の ACK を再利用しない）。
- 送出意図の COMMIT の後・応答の前に worker が止まると、結果は unknown で許可は出ず、DB には dispatching が残ります。同じ命令を送り直しても再到着として版を返すだけで、許可は出ません。dispatching の操作は照合（unknown_held・reconciling）へ進め、自動では送りません（X06）。

## 試験

`packages/storage/src/*.test.ts`（ビルド後の `dist/*.test.js` を `pnpm test` で実行）。DB は一時ディレクトリの書込み接続（WAL・FULL）で、試験の終わりに消します。

- `operation-store.test.ts`（worker を介さない同期の試験、17 件）: 通常の流れ（各段の state_revision・event_outbox の連番と期限・command_receipts の状態と期限）、二重承認（X02）、同じ request_id の内容違いと再送（X04）、同じ command_id の再到着、状態版・許可・忘却・依頼の版・安全停止・予算予約・接続の書込み権限・試行の不一致の拒否（何も書かない）、送出前・送出後の取消（X05）、未実行の確定からの再試行、自動実行（X21）、制約違反の巻き戻し、COMMIT 前の例外、COMMIT の失敗（遅延の外部キー違反）、耐久設定の不一致、命令の形、LocalCommand、同期でない transaction の本体、大量書込みの区切り。
- `db-worker.test.ts`（worker_threads の試験、11 件）: `operation-transitions.json` の X01・X02・X05（前後）・X06・X07・X08・X21 を worker で実行し、最終状態・state_revision・イベント・有効な承認の数・使えた許可の数（external_writes と比較）を確かめる。受付 ACK と結果の順と計測、許可の一回性と世代、故障注入（COMMIT 前の例外・COMMIT の失敗・COMMIT 前の worker の終了・応答なし・耐久設定の不一致）で許可を返さず preparing のまま残ること、送出意図の COMMIT 後の worker の終了で dispatching のまま残り再送でも許可が出ないこと、耐久設定を弱めた接続で worker が起動しないこと。

期待値は `operation-transitions.json`・`h01.json`・`content-hash-cases.json` の手書きの値と、0001 の制約から手で書きました。故障注入（`DbWorkerFaults`・`connectionSql`）は試験専用の起動オプションで、製品の起動では渡しません。worker の強制終了・異常終了では、better-sqlite3 が worker の環境の後始末で接続を閉じ、未 commit の transaction は巻き戻ります（試験で確認）。

## 読み取り（レビュー対象）

- **LocalCommand の許可の版**: 「Buddy 側の許可設定の版」（S:PermissionRevision）の現在値を置く場所が 0001 にないため、接続のない操作の許可の版は DB で照合していません。外部変更は接続の `permission_revision` と照合します。
- **操作と接続の結び付け**: `operations` に接続の列がないため、命令が指す `connection_id` が操作の接続と同じことは DB では確かめていません（確定 intent の account_id に含まれる）。0002 で列を足すかは B02-04 以降で判断が要ります。
- **内部の命令の受付**: 内部の命令の再到着の判定にも `command_receipts` を使い（接続範囲 `core-internal`）、7 日で消えます。7 日より後の同じ command_id は新しい命令として扱われます。
- **承認の状態**: 承認は成功した送出で consumed にし、それまでは valid のまま試行へ貸し出します（未実行の確定の後に同じ承認で再試行できる、08 §4 と storage fixture のとおり）。取消では承認を revoked にしていません（取消は終端のため使われない）。
- **イベントの種類**: 状態の更新ごとに `operation.updated` を 1 件書きます。`command.durable` は使っていません（worker の結果が durable を同期で返すため）。
- **event_outbox の連番**: 連番は同じ store_generation の最大値＋1 です。7 日の削除で全行が消えると連番が戻り得るため、削除ジョブ（未実装）は最後の行を残すか、連番の置き場所を決める必要があります。
- **COMMIT の失敗の扱い**: 遅延の外部キー違反のように巻き戻ったことが分かる場合も含め、COMMIT の失敗はすべて unknown にしました。区別すると I/O の失敗の後に commit が残る場合を誤って rejected と扱うおそれがあるためです。
- **予算予約**: 予約の ID を渡した送出意図だけ予約が reserved であることを確かめます。費用のない操作（模擬サービスのラベル変更など）は予約なしで通ります。

## 残ること

- Core への組み込み（起動時の worker の起動・store_generation の `core-state.json` からの移行）と、再起動の復元（dispatching・unknown_held の操作の照合）は B02-04 です。
- 本文の暗号化（AES-256-GCM・追加認証データ）と KeyStore は B02-02 です。今回の試験の暗号文は乱数の合成値です。統合では B02-02 の封をした行を `intent` に渡します。
- 外部送出と照合（RemoteEffectRunner・模擬サービス・X07・X08 の照合方法）は B04 です。
- 内容版の更新（X03・X09 の superseded と次の内容版）、複数工程（operation_steps、X10）、自動実行の `auto_actions`・安全停止の件数の同じ transaction での記録（H02）、予算予約の作成と精算は未実装です。
- WAL の大きさ・checkpoint・長い読み取りの計測、遅いディスク・disk full・worker 停止中の音声制御の応答（QA15〜QA17）は未試験です。
- 電源断・同時書込み・再起動を含む耐久性の試験（X60・T07）は未実施です。製品の統合・実機の試験も未実施で、`tests/test-map.json` の product_test は not_run のままです。
