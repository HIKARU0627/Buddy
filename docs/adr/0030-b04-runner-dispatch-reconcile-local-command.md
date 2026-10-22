# ADR 0030: 実行担当（一度だけの送出・照合・LocalCommand・再起動からの再開）

- 日付: 2026-10-22
- 状態: B04-04（#84）の判断と実装。B04-03（#83、PR #89）の上に作った。試験は同じプロセスの模擬だけ（127.0.0.1 の Core の HTTPS、#87 の模擬 provider とアダプター、故障注入）。実機・実 API・実請求は未実施。
- 根拠: Issue #84 の要約と本人の判断 D1〜D6（2026-10-22）、ADR 0018・0019・0027・0028・0029、`tests/integration/fault-points.json`（X01・X05〜X09 の期待値の正）、`packages/contracts/fixtures/operation-transitions.json`。設計本文（08 §1〜4、09 §4）は今回の作業環境に取得できず、Issue と ADR の要約に基づく。原本との照合はレビューで行う。

## 決めたこと

| 対象                   | 決定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 実行担当               | `apps/core/src/operation-runner.ts`。承認の保存の後（approve の経路が 202 を返したとき）に、操作ごとに一つだけ実行する（進行中の操作には二つ目を始めない）。経路は `OPERATION_KIND_RULES` で決め、表と保存した `effect_route` が食い違う操作は実行しない                                                                                                                                                                                                                                  |
| RemoteMutation の順序  | `operation.prepare` → アダプターで接続・許可・対象を読み直す → `operation.dispatch_intent`（送出意図・工程・接続の照合を一つの transaction）→ `DispatchPermit` を `consumeDispatchPermit` で一度だけ使い、アダプターで 1 回だけ送る → `operation.record_result`                                                                                                                                                                                                                           |
| 確かめ直し（D1、X09）  | 対象の `source_revision` か許可の版が確定 intent と違えば送らず、同じ operation_id で内容版を上げた intent（対象の版・許可の版だけを差し替え）を `operation.revise_content` で保存する。旧版の承認は revoked、preparing の試行は superseded、状態は awaiting_approval                                                                                                                                                                                                                     |
| 確かめられないとき     | 接続・許可・対象が読めない、口座が違う場合は送らず、preparing のまま残す（本人の取消か、次の起動での再開を待つ）。内容を変えられないので D1 にはしない                                                                                                                                                                                                                                                                                                                                    |
| 送出の直前の接続の照合 | 操作に連携の接続の列がなく（0001）、模擬 provider は `connections` の provider の CHECK（google・microsoft）に入らない。そこで送出意図の命令に `observed_connection`（Core が読み直した status・access・許可の版）を持たせ、DB worker が transaction の中で書込み可・許可の版の一致（命令の permission_revision＝確定 intent の許可の版）を確かめる。承認の `preview_valid` と同じく、Core が判定の材料を渡す形。DB に接続の行がある場合（`connection_id`）は従来どおり DB の値で確かめる |
| 応答を失ったとき（D4） | 書込みの結果が `unknown`（時間切れ・切断・5xx・形の違う応答）なら、直後に 1 回だけ参照で照合する（`canAutoReconcile(0)`）。ラベル変更は正確な対象（exact_target）で、追加したラベルがすべてあり外したラベルがなければ `found`。`reconcileOutcome` で found だけを succeeded、他は unknown_held。自動再送はしない                                                                                                                                                                          |
| 結果の記録             | 応答あり・照合で確認: dispatching → reconciling → succeeded（fixture の X01・X07 の経路）。確認できない: dispatching → unknown_held（X08）。4xx・未送信: reconciling → not_executed                                                                                                                                                                                                                                                                                                       |
| 送出後の取消（X05）    | 送出意図の後の取消は受付だけ（accepted）。結果が分かっても reconciling で止め、本人の照合を待つ（`OperationView.cancel_requested`、表示の allowed_actions に reconcile）。fault-points.json の `core_final_state: reconciling` に合わせた読み取り（下の「判断してほしい点」）                                                                                                                                                                                                             |
| 本人の照合             | `POST /v1/operations/{id}/reconcile`。unknown_held・reconciling の操作だけ。unknown_held は本人の要求の受付で reconciling へ進め、参照で照合して succeeded か unknown_held を記録する。同じ request_id の再送は保存済みの受付結果（照合し直さない）、内容が違えば 409                                                                                                                                                                                                                     |
| 本人の再試行           | `POST /v1/operations/{id}/retry`。not_executed の操作だけ、新しい試行で preparing へ戻し（同じ承認、08 §4）、実行担当が確かめ直しから進める。自動では呼ばない                                                                                                                                                                                                                                                                                                                             |
| 起動時                 | 回復（`recovery.ts`）は dispatching を unknown_held にし（従来どおり）、approved・preparing を再開の対象に返す。実行担当は HTTPS の開始後に、それらを確かめ直しから進める。unknown_held・reconciling は自動では照合も再送もしない                                                                                                                                                                                                                                                         |
| 停止                   | `close()` の後は外部へ送らない。故障点で止まっていても、再開の後に送らずに終える（送出意図の後なら次の起動で unknown_held）                                                                                                                                                                                                                                                                                                                                                               |
| LocalCommand（D5）     | `operation.apply_local`。承認済みの task.create だけ。用事の行（tasks）・成功の試行・承認の consumed・approved → succeeded・イベント・受付を一つの transaction で書く。外部 HTTP は使わない。同じ命令の再到着は command_receipts で保存済みの結果、二度目の適用は状態版と `tasks.operation_id` の一意制約で拒否                                                                                                                                                                           |
| LocalCommand の試行    | 0001 の CHECK（succeeded は dispatch_intent_at を持つ）は変えず、適用の時刻を dispatch_intent_at に入れる（LocalCommand では transaction の COMMIT が送出に当たる）。external_id は用事の ID                                                                                                                                                                                                                                                                                              |
| 工程（D3）             | 送出意図の命令に工程（`1-apply_labels` など）を持たせ、operation_steps に同じ transaction で書く。結果の記録と起動時の回復で、送出意図のある工程にも結果（unknown を含む）を書く。実行担当は送出の前に `nextStepDecision` で決め、dispatch 以外（照合・停止）なら送らない。2 工程の送信の操作は作らない（X10 の合格は B14）                                                                                                                                                               |
| 故障点                 | `FaultHook`（`turn-ports.ts`、構造は `FaultInjector` と同じ）。approve の経路で `approval_barrier`・`before_approval_save`、実行担当で `after_approval_save`・`after_target_recheck`・`after_dispatch_intent_before_send`・`before_result_save`、WSS の配信で `after_event_delivery_before_ack`（注入で例外なら配信の後に接続を失ったものとして閉じる）。製品では何もしない（`NO_FAULTS`）                                                                                                |
| #87 のアダプター       | `mock-mail-ports.ts` の `mockMailPorts` が `MockMailConnector` を `ProviderReader`・`ProviderWriter` へつなぐ。読み取りと書込みに別のアダプターを渡せる（時間切れの設定を書込みだけに持たせる、X08）。接続の状態は許可の読み取りから決める（読めれば active、変更の範囲があれば read_write）。Core の依存に `@buddy/connectors` を足した（製品コードは公開の出口だけを読む）                                                                                                              |

## マイグレーション 0005

B04-03 が 0004 を `turn_responses` に使ったため 0005 にした。

- `operation_attempts` を作り直し、状態に `superseded` を足す。`superseded` は送出意図も結果も持たない（CHECK）。参照する operation_steps も新しい試行の表を指す形で作り直し、子・親の順に消してから改名し、索引（一つの実行中の試行・一つの承認に一つの試行）を作り直す。外部キーの検査を COMMIT まで遅らせる方法（`defer_foreign_keys`）は、DROP の暗黙の削除で数えた違反が取り消されず、試行・工程のある DB で COMMIT に失敗したため使わない（レビュー P1。試行・工程の入った版 4 の DB の更新を試験する）。
- `tasks`（task_id・operation_id（一意）・content_version・list_id・status・created_at）。題名・期限・本文は確定 intent（operation_versions の暗号文）を参照し、複製しない。

## 試験

- storage: `operation-store.test.ts` に apply_local（一つの transaction・再到着・照合値の違い・二度目の拒否・経路の違い）、observed_connection（なし・読み取りだけ・許可の版の違い・形の不正・成功）。`conversation-store.test.ts` の D1 に preparing の試行の superseded と dispatching の拒否。`storage-cases.json` に 0005 の制約（superseded の CHECK・tasks の一意と外部キー）。
- Core: `operation-runner.test.ts`（9 件）。X01・X02・X05（送出の前と後）・X06・結果の保存の前の停止・X07・X08・X09（対象の版と許可）・D5/QA28。provider の要求回数・状態の変更回数・最終状態は fault-points.json の値を読んで照合する。待ち合わせは故障点の関門と `runner.idle()` で、固定時間の sleep を使わない。
- 承認の件数（fault-points.json の `approvals`）は、HTTP の経路から数えられないため照合していない（approval_state で代えた）。

## レビュー（Codex、PR の P1 1 件・P2 3 件）の反映

| 指摘                                                           | 対応                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0005 が参照データのある DB で COMMIT に失敗する                | operation_steps も作り直す手順に変えた（上の「マイグレーション 0005」）。版 4 の DB に試行・工程を入れて更新し、全行・索引・外部キーを試験で確かめる                                                                                           |
| retry が approved にも効く                                     | 再試行の準備は `operation.prepare` の `retry: true` とし、DB worker の transaction の中で not_executed 以外を `retry_not_allowed`（409）で拒否する。各状態の拒否を storage と Core で試験する                                                  |
| 本人の照合で found でも、取消の受付があると reconciling に残る | 自動の照合と本人の照合を分け、本人の照合で found なら成功として確定する。「結果不明 → 取消の受付 → 遅れた適用 → 本人の照合」を試験する                                                                                                         |
| 照合の排他の登録が遅い                                         | 操作ごとの排他を最初の await より前に取り、終わったら自分の登録だけを外す。実行中の操作への照合は終わるのを待ち、同じ要求なら保存済みの受付を返す。同時に届いた同じ要求で照合が 1 回になることを試験する                                       |
| （再確認）照合の排他が retry の実行開始を捨てる                | 排他の間に届いた実行の開始は預かり、排他を外した後に始める。別の要求の照合・通常の実行と重なる照合はすぐに断る（409）。同じ要求の照合だけを 10 秒まで待つ（打ち切っても実行の排他は外さない）。偽物の store で競合を再現する単体の試験を足した |
| （CI の Windows）停止で WSS が 1006 になる                     | 停止で購読に close を送った直後に HTTPS の層が接続を切っていた。`closeAll()` が close の往復（または 2 秒の打ち切り）を待ってから下の層を閉じる順にした                                                                                        |

## 判断してほしい点

1. X05-after-dispatch の `core_final_state: reconciling` を「送出後に取消を受け付けた操作は、結果が分かっても照合中で止めて本人の照合を待つ」と読んだ。
2. 送出の直前の接続の照合を、DB の接続の行ではなく Core が読み直した値（`observed_connection`）で行う形にした。接続の行を持つのは B07 の連携の接続の管理からと考えた。
3. 確かめ直しで接続・対象が読めないときは preparing のまま残す（D1 は内容が変わる場合だけ）。
4. LocalCommand の成功の試行に、適用の時刻を dispatch_intent_at として入れた（CHECK を緩めない）。
5. 起動時の再開の対象に approved（試行の前）も含めた（承認の保存の直後に止まった場合）。
6. 下書きの作成（mail.draft.create、目印での照合）は、発言から作る経路がまだないため実行しない（実行担当は「まだ実行できない」で止める）。

## 残ること

- test-map.json の product_test は not_run のまま（各 X の担当工程が B04 の後にも続くため）。
- 画面（#85）、下書きの実行、承認の件数の照合、2 工程の送信（B14）。
