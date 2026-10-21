# ADR 0023: スナップショット・イベント配信（WSS）・再接続後の復元と操作の経路

- 日付: 2026-10-21
- 状態: B03-04（#65）の判断と実装。DB worker の照会（スナップショット・cursor の後のイベント・操作の表示用の値・受付の有無・端末の今の接続範囲）、event_cursor の符号化と再生の判定、`getSnapshot`・`getEvents`・`getOperation`・`approveOperation`・`cancelOperation` の経路、WSS `/v1/events/stream` の配信（開始位置・接続範囲への結び付け・ping・理由つきで閉じる）、端末の接続を閉じる差し込み口を作った。試験は 127.0.0.1 の模擬（模擬の KeyStore・一時ディレクトリの DB・同じプロセスの startCore）だけで、実際の端末・Tailscale 上の接続・実機は未実施。
- 根拠: 設計 07 §1（イベントの送出記録を同じ transaction で、本文を入れない、スナップショットと境界を一つの読み取りで）・§2・§3（切断中の命令をためて自動で送らない）・§4（event_cursor は世代と位置を含む不透明な値、7 日で消す、世代違い・期限切れは再スナップショット）、02 主な通信契約、06 B03、X04・X11、ADR 0009・0018・0019・0020、`api-scenarios.json`（replay・x11）、`operation-transitions.json`、`tests/integration/fault-points.json`。設計本文は今回の作業環境に取得できず、Issue #65 の要約と ADR に基づく。原本との照合はレビューで行う。

## 決めたこと

| 対象                      | 決定                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| スナップショット          | DB worker の照会 `snapshot` が、操作の状態と `event_outbox` の最大の連番を一つの読み取り transaction（BEGIN DEFERRED）で取る。最大の連番を event_cursor にする。worker はメッセージを一つずつ処理するので、命令の transaction の途中は読まない                      |
| スナップショットの操作    | 終端でない操作はすべて。終端（succeeded・cancelled・superseded）の操作は、その変更のイベントがまだ `event_outbox` にある（7 日以内）ものだけ                                                                                                                        |
| ロック中                  | `RequestEnvironment.lockState` が unlocked でなければ（locked・unknown）`view: management_only` で、会話・候補・操作を含めない。`io_state.lock_state` に判定した値を入れる                                                                                          |
| event_cursor              | `ec1_` ＋ base64url（パディングなし）の `<store_generation>.<sequence>.<発行の時刻ms>`。端末は解釈しない。秘密でも認証情報でもない（端末トークンが必須）。読み取りは厳格にし、符号化し直して同じ文字列になるものだけを受け付ける                                    |
| 再スナップショット        | DB 世代が違う → `store_generation_changed`。発行から 7 日（`event_outbox` の保存期限）・時計が発行より前へ戻った・cursor の直後のイベントが残っていない（最小の連番 ＞ cursor＋1）・cursor が今の最大より先 → `history_expired`                                     |
| 欠落の判定                | 連番は store_generation ごとに COMMIT した transaction だけが使う（飛びがない）ので、欠けは中枢が「残っている最小の連番」で判定する。端末は連番の飛びだけで欠落と判定せず、event_id と state_revision で重複・逆順を捨てる（domain の `applyEvents`）               |
| 見せないイベント          | 契約の `event_type`（operation.updated・command.durable）以外の行は配らず、位置だけ進める。端末から見ると連番が飛ぶ                                                                                                                                                 |
| durable commit の後の配信 | イベントは中枢のメモリーにためず、配るたびに DB worker の照会（`events_since`）で `event_outbox` から読む。読めるのは COMMIT 済みの行だけ（COMMIT 前の失敗で巻き戻した命令のイベントは出ないことを試験で確認）                                                      |
| 配信の通知                | 経路から送った命令は、durable・accepted の結果の後に `EventFeed.notify()` を呼ぶ（`watchStore`）。別の経路の命令に備え、購読がある間は 1 秒ごとにも読み直す。`CoreHandle.events` を出し、B04 などは `notify()` か `watchStore` を使える                             |
| 取りこぼし（X11）         | 購読の登録を最初の読み出しより先に行い、購読ごとの読み出しは一つずつ。読み出しの途中に届いた通知は dirty にして読み直す。スナップショットの後・購読の前の更新は cursor の後のイベントとして必ず読まれる                                                             |
| 操作の命令                | 承認・取消を `operation.approve`・`operation.cancel` へつなぐ。依頼・忘却の版は要求の時点の DB の現在値（`operation_view`）を入れる。許可の版は接続のない操作では DB で照合しない（ADR 0018 の読み取りのまま）                                                      |
| 受付と再送（X04）         | 要求の照合値は「経路・対象・本文（キー順の JSON）」の SHA-256。命令 ID は接続範囲と request_id から決まる UUID v4 の形の値（下の「命令 ID を要求から決める理由」）。同じ内容は保存済みの受付結果（同じ command_id・版）、違えば 409、古い接続範囲は経路の検査で 410 |
| 版の照合                  | `approveOperation`・`cancelOperation` の `expected_revision` を DB の現在の state_revision と照合する。保存済みの受付（同じ接続範囲・request_id）があれば DB worker の再送の判定に任せる。承認は、同じ内容版・hash の有効な承認があれば版が進んでいても通す（X02）  |
| preview                   | preview の発行（`previewOperation`）は対象外。有効性は注入（`CoreHttpsOptions.previewValid`）にし、既定は「有効な preview はない」（承認は 409、安全側）                                                                                                            |
| 応答                      | 承認・取消は 202 の `CommandReceipt`（durable は commit 済みの版、送出境界の後の取消は accepted で版なし）。DB worker の拒否のうち内容・状態の変化は 409 conflict、成否不明・DB worker の停止は 503 dependency_unavailable                                          |
| 本文を入れない            | 応答・イベントは ID・版・状態・hash・種類・時刻だけ。`event_outbox` に本文の列はない（0001）。EventEnvelope は契約で additionalProperties: false。試験でキーの集まり・トークンを含まないことを確かめる                                                              |

## 開始位置の指定（契約に足したこと）

`streamEvents` にクエリー `cursor`（必須、`components.parameters.Cursor`、getEvents と同じ）を足した。最初のメッセージで送る形にしなかった理由:

- **切り替えの前に拒否できる**: 中枢が発行した形でない cursor を、切り替えずに HTTP の 422（ApiError）で返せる。最初のメッセージにすると、切り替えの後に「最初のメッセージを待つ」状態と時間切れ・不正なメッセージの扱いが要る。
- **形式の検査の仕組みを使える**: パスの値・クエリーと同じく、経路の表（`api-routes.ts`）と JSON Schema で検査し、未知・重複のクエリーも拒否される。OpenAPI と経路の表が同じことも既存の試験で確かめられる。
- **getEvents と同じ**: 位置の渡し方が HTTP と WSS でそろう。端末から送るメッセージを定義しないまま（ADR 0020）にでき、受け取ったら閉じるだけで済む。
- **秘密を URL に入れない規則に反しない**: cursor は秘密でも認証情報でもない（契約の説明のとおり）。OpenAPI のクエリーは cursor だけという既存の検査（`scripts/api.test.mjs`）もそのまま通る。

接続範囲（command_scope_id）はクエリーに入れず、切り替えの後に「その端末の今の接続範囲」（今回の起動で発行し、失効・期限切れでないもの。発行で前のものを無効にするので高々一つ）に結び付ける。なければ resnapshot_required（scope_expired）を送って閉じる。ROUTE_CHECKS（`streamEvents` は端末トークン・自宅判定だけ）は変えていない。

OpenAPI に `x-buddy-websocket-close-codes`（閉じるコードの表）を足した。`api-cases.json` の `streamEvents` に `params.cursor` を足した（全経路の要求の合成例に必要）。JSON Schema は変えていない（生成型の変更なし）。

## WSS の閉じる理由

| コード   | 理由（close の reason）                                        | 中枢が閉じる場面                                                                             | 端末のすること                      |
| -------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------- |
| 4410     | `store_generation_changed`・`history_expired`・`scope_expired` | `{"type":"resnapshot_required","reason":…}` を送った後。世代違い・期限・欠け・接続範囲の失効 | bootstrap・スナップショットから再開 |
| 4401     | `device_revoked`                                               | 端末の失効（`DeviceConnections.closeDevice`、B03-02）                                        | 再登録                              |
| 4403     | `outside_home_network`                                         | 自宅判定の不成立（`closeDevice`、B03-03）と、ping ごとの `homeNetwork` の引き直しが false    | 自宅のネットワークで接続し直す      |
| 1001     | `core_stopping`                                                | 中枢の停止                                                                                   | cursor から接続し直す               |
| 1003     | `unsupported_data`                                             | 端末からメッセージを受け取った（定義していない）                                             | —                                   |
| 1011     | `dependency_unavailable`                                       | DB の照会の失敗（DB worker の停止など）                                                      | 時間をおいて cursor から接続し直す  |
| 1013     | `slow_consumer`                                                | 送り先に 1 MiB を超えて溜まった                                                              | cursor から接続し直す               |
| 4429     | `too_many_streams`                                             | 同じ端末の購読が上限（4）を超えた（同時の切り替えで後から開いたもの。B03-07）                | 購読を閉じてから接続し直す          |
| （切断） | —                                                              | 前の ping に pong がない（閉じる手順を踏まない。端末からは 1006）                            | cursor から接続し直す               |

ping は 15 秒ごと。同じ間隔で接続範囲（`scope.find` と `commandScopeState`：再接続・失効・期限・起動 ID）と自宅判定を確かめ直す。失効・自宅判定の不成立は `DeviceConnections`（`register(deviceId, close)`・`closeDevice(deviceId, reason)`、形は B03-02・B03-03 と合わせた）からすぐに閉じ、ping ごとの確認は呼び忘れの保険にする。

## 命令 ID を要求から決める理由

`DbWorkerClient` は、結果の command_id が送った命令の command_id と同じことを確かめ、違えば成否不明（response_mismatch）にする（ADR 0018、古い応答を送出の根拠にしないため）。一方、DB worker の再送の判定は保存済みの受付の command_id を返す。再送ごとに新しい command_id を作ると、保存済みの結果を受け取れない。そこで命令 ID を `SHA-256("buddy/device-command/v1" NUL 接続範囲 NUL request_id)` の先頭 16 バイトから UUID v4 の形で作り、同じ要求の再送は同じ command_id にした。同じ接続範囲・request_id で内容が違えば DB worker は `command_id_reused` で拒否し、経路は 409 にする（`request_conflict` と同じ扱い）。共有の `db-client.ts` は変えていない。

## DB worker の照会（packages/storage）

`DbQuery` に次を足した（`event-store.ts`・`snapshot-store.ts`。共有の `db-protocol.ts`・`db-worker.ts`・`db-client.ts` は数行の追記だけ）。どれも書込みをしない。マイグレーションは足していない。

| 照会             | 内容                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `snapshot`       | 操作の表示用の値の一覧と、`event_outbox` の最小・最大の連番（一つの読み取り transaction） |
| `events_since`   | 連番の後のイベント（最大 500 件）、残っている最小・最大の連番、続きの有無                 |
| `operation_view` | 操作 1 件の表示用の値（状態・版・内容 hash・承認・最新の試行の結果）と、依頼・忘却の版    |
| `receipt_exists` | 接続範囲＋request_id の受付が保存済みか                                                   |
| `current_scope`  | 端末の今の接続範囲                                                                        |

## 試験

| 試験                                       | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/core/src/api-events.test.ts`         | スナップショット（契約に合う・境界の連番・手書きの操作の値・ロック中とロック不明は management_only）、getEvents（ページ・連番・cursor・422・再スナップショット 3 種・401）、**X11**（スナップショットと購読の間の更新・購読の読み出しの途中のコミットの故障点・重複と逆順の収束）、定期の読み直し、WSS の再スナップショット（接続範囲なし・世代違い・期限切れ・先の連番）・422・401、閉じる理由（再接続・失効・自宅判定・端末からのメッセージ・DB の失効・停止）、pong なしの切断 |
| `apps/core/src/api-operations.test.ts`     | **X04**（同じ内容は保存済みの結果で二度適用しない・内容違い 3 種は 409・古い接続範囲は 410・新しい接続範囲の同じ request_id は X02 の existing）、版の不一致の 409、取消の durable と送出境界の後の accepted、preview なしの 409・ロック中の 403・ない操作、**再起動と再接続**（古い接続範囲の 410・同じ操作 ID・内容版・hash・状態版、起動時の回復のイベントを cursor から HTTP と WSS で取り戻す、再起動の後の X04）                                                            |
| `apps/core/src/event-cursor.test.ts`       | 符号化（手で作った base64url と一致）、形の不正 15 種と別の書き方の拒否、判定の 11 の場合                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/core/src/event-feed.test.ts`         | 模擬の照会でページの順・見せない種類・通知、読み出しの途中のコミット、欠け・先の連番・失敗で終わる、購読がない間は読み直さない                                                                                                                                                                                                                                                                                                                                                    |
| `packages/storage/src/event-store.test.ts` | スナップショットの境界と操作の値、終端の操作を 7 日の削除の模擬で外す、イベントのページと範囲（削除の後の欠け）、受付の有無、今の接続範囲、照会の形の拒否、DB worker 経由で COMMIT しなかった命令のイベントが出ない                                                                                                                                                                                                                                                               |

既存の試験の変更: `api-server.test.ts` の WebSocket の切り替えの要求に `?cursor=c-1` を足し、cursor なしの 422 を足した（契約の変更に合わせた）。

期待値（状態・版・連番・閉じるコード・HTTP の状態）は試験に手で書いた値か、契約 fixture の値で、検査対象の関数から作っていない。端末の反映は domain の `applyEvents`（端末の規則）で行い、収束した版を手書きの値と中枢の `getOperation` の両方と比べた。各試験に時間の上限を付け、待ちはどれもメッセージ・切断・時間切れで終わる。後始末は `onCleanup`（後に登録したものから先に。閉じてから削除）。

## 読み取り（レビュー対象）

原本に明記がなく、実装で決めた点です。

- **cursor の期限**: 発行から 7 日（`event_outbox` の保存期限と同じ）にした。接続している端末の cursor は配るたびに新しく発行されるので期限に掛からない。実際に行が消えたかは「残っている最小の連番」で別に判定する。
- **連番が戻る場合**: ADR 0018 の読み取りのとおり、7 日の削除で全行が消えると連番が 1 から振り直され得る。そのとき古い cursor は「今の最大より先」として再スナップショットにするが、新しい行が cursor の連番を超えるまで増えた後は検出できない。削除ジョブ（未実装）は最後の行を残すか、連番の置き場所を決める必要がある。
- **ロック中のイベント**: スナップショットはロック中に操作を含めないが、イベント（本文のない ID・版だけ）はロック中も配っている。表示権によるイベントの絞り込みは今はない（見せない種類の行だけを配らない）。
- **スナップショットの件数**: 上限を設けていない（終端でない操作と 7 日以内に変わった終端の操作）。件数が増えたときのページ分けは後の工程で判断が要る。
- **ない操作**: 契約の ApiError に「対象がない」のコードがないため、`getOperation` は 422 invalid_input、承認・取消は版の照合が合わず 409 conflict にした。404 の追加・`forbidden` との使い分けは判断が要る。
- **approval_state**: 契約の値に consumed がないため、使い終えた承認（成功の後）は valid で表す。
- **allowed_actions**: 状態ごとの表示の補助として決めた（承認待ち: preview・approve・cancel、approved・preparing: cancel、unknown_held: reconcile、not_executed: retry、他は空）。認可ではない。reconcile・retry・preview の経路はまだない。
- **sessions・candidates・io_state**: 正本がまだない（B05・B10）ので、スナップショットでは空と安全側の値（入力不可）にした。
- **preview の既定**: preview の発行を作るまで、製品の承認は 409 になる（安全側）。発行の Issue で、端末・接続範囲・表示内容への結び付けと、接続終了・ロック・内容変更での無効化を作る必要がある。
- **版の照合で X02 を通す**: 承認で、同じ内容版・hash の有効な承認がすでにあれば、状態版が進んでいても経路の検査で 409 にせず、DB worker の approvalDecision（existing）に任せた。domain の判定の順（内容版・hash → 既存の承認 → 状態版）に合わせた。
- **受付の照合値に経路を含める**: 同じ request_id を別の経路（承認と取消）に使うと 409 になる。
- **WSS の接続範囲**: クエリーで渡さず、端末の今の接続範囲に結び付けた。bootstrap の後に接続する前提。
- **定期の読み直し**: 1 秒ごと（購読がある間だけ）。DB worker の照会 1 件で、件数に応じて増えない。
- **数値**: ping 15 秒、送り先に溜めてよい量 1 MiB、1 ページ 100 件（照会の上限 500 件）は設計に数値がないため仮に決めた。
- **tests/test-map.json**: X04・X11 の中枢の部分（HTTP・WSS・再起動）を模擬で確かめたが、fault-points.json の期待値は B04 の模擬サービス（外部への要求の回数）を含むため、`product_test` は not_run のまま。

## B03-07 の変更（独立したセキュリティレビューの指摘、#75）

試験は 127.0.0.1 の模擬（`apps/core/src/api-hardening.test.ts`）だけで、実際の端末・実機は未実施。

- **M3 停止の途中の購読**: Core の停止は配信の元（`EventFeed`）を HTTPS より先に止めるため、その間に届いた切り替えで `subscribe` が `event_feed_closed` を投げ、`void start()` が未処理の拒否になっていた（停止中のクラッシュ）。切り替えの前（`admit`）に配信の元が止まっていれば 503 `dependency_unavailable` で切り替えない。受け付けの判定の後に止まった場合を含め、開始の失敗はすべて購読の失敗として 1011 `dependency_unavailable` で閉じる（`start().catch(...)`）。停止の途中の 503・1011 は、端末が時間をおいて接続し直す既存の扱いと同じ。
- **L3 端末ごとの購読の数**: 1 台の端末が WSS の購読で接続の枠（同時の TLS 接続 32 本）を使い切れた。端末（device_id）ごとに同時に開ける購読を 4 本（`DEFAULT_MAX_STREAMS_PER_DEVICE`、仮の値）までにした。切り替えの前（`admit`）に上限に達していれば切り替えずに 429 `rate_limited`。数は切り替えた直後（`open`）に同期で数えるので、同時の切り替えで受け付けの判定を両方通った場合は、後から開いたものを 4429 `too_many_streams` で閉じる（OpenAPI の `x-buddy-websocket-close-codes` に足した）。閉じた購読の枠はすぐに戻る。
  - **4 本にした理由**: 正しい端末の通常の購読は 1 本。回線の切り替えなどで再接続すると、古い購読は前の ping に pong がない時点（最長で ping の間隔の 2 倍、30 秒）か、再接続の bootstrap で接続範囲が変わった後の確かめ直し（15 秒以内）まで残るため、数本の重なりは起こり得る。その余裕を残しつつ、1 台で使える枠を全体（32 本）の 8 分の 1 にとどめる。設計に数値がないため、実際の端末（B03-05）の再接続の様子を見て見直す。

## 残ること

- preview の発行（previewOperation）、照合・再試行の経路、表示の切替・リースの更新（B04・B05）。
- 端末側の購読・cursor の保存・再スナップショット（B03-05）。2 端末の再接続の試験。
- `event_outbox`・`command_receipts` の 7 日の削除ジョブ（連番の扱いを含む）。
- 実際の端末・Tailscale 上の接続・実機での確認。
