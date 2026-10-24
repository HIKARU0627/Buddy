# ADR 0046: B05 の中枢の音声の制御（リースの経路・音声所有権・世代の永続・停止の到達・サイドバンドの喪失）

- 日付: 2026-10-24
- 状態: B05-03（#127、親 #15）の判断。Core の音声の制御（`apps/core/src/voice-control.ts`・`api-voice.ts`）、マイグレーション 0008、domain の純粋な規則の追加（`voice-ownership.ts`）、契約の補い（経路 `renewLease`・拒否の理由・ApiError のコード）、試験。試験は**模擬だけ**（DB worker・予算の門・模擬の Live の provider・手で進める時計）。実際の音声・実 API（OpenAI の Live）・実機・実請求は**未実施**。
- 根拠: 設計 07 §1・§2・§4・§5、10 §1・§1A・§2・§2A・§3・§8、09（X13・X14・X25・X28・X32・QA24・QA43）、ADR 0005・0006・0037・0038・0041、本人の判断（2026-10-23、#15 のコメント）、B05-01 の持ち越し（#127 のコメント）。原本は権限のある接続で読み取りだけ行い、全文は写していない。原本に決めがないことは「原本に決めなし」と書き、`docs/b00/contract-map.md` の U68〜U72 に記録した。

## 作ったもの

| 部分           | 内容                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 経路           | `POST /v1/leases/renew`（renewLease）を足した。`/v1/io/stop`・`/v1/io/resume`・`/v1/live/sessions`・`/v1/live/sessions/{id}/close` は 503 から実装へ。getBootstrap の `io_state` は中枢の正本（世代・停止・リース）を返す                                                                                                                                                                                                    |
| 判定           | B05-01・02 の規則をそのまま使う。リースの更新は `leaseRenewalReasons`、返す期限は `grantedLeaseTtlMs`（6 秒に切り詰め）、制御接続の遷移は `nextLiveControl`、Live の受付は `admitLiveStart`、世代は `issueLiveEpochs`、停止の第 3 層は `planStop(reason).core`、精算の秒数は `settleLiveSeconds`。足した規則は `arbitrateAudioClaim`（同時の呼びかけ）・`leaseRotationRequired`（取り直し）・`ioStopReach`（停止の到達）だけ |
| 保存           | 0008: `device_epochs`（io・output・audio・session の epoch と端末単位の停止。戻さない・消さない trigger）、`io_stop_state`（来客モード・全体停止。再起動で解除しない）、`live_sessions` の `audio_epoch`・`session_epoch`（挿入の後は変えない）と、control_epoch を戻さない・lost 以降から ready へ戻さない・確認済みの使用秒数を変えない trigger。DB worker の命令 `voice.*`（compare-and-set）                             |
| 停止のイベント | WSS の `{type:"voice"}`（VoiceEvent の `audio_control`・`sideband_connected`）を、その端末の購読にだけ送る。イベントの記録（cursor）には入れない。届かなくても端末はリースの期限で止まる（10 §2A）                                                                                                                                                                                                                           |
| 境界           | provider（`LiveProvider`）と予算の門（`LiveBudgetPort`。秒数だけを渡す）は注入する。製品の起動ではまだ渡さないので、Live の接続は 503（実 API を使わない）。同意（`consent`）は既定で missing                                                                                                                                                                                                                                |

## リースと音声所有権（U68・U69）

- リースは RAM だけ。中枢の再起動で起動 ID が変わり、前のリースは `core_restarted` で全て通らない（07 §4・§5）。
- 本文の `device_id` が認証した端末と違えば `device_mismatch`。ロック中・ロック状態が分からない端末（Buddy-Lock-State が unlocked でない）は `io_suspended`（解除済みと扱わない。07 §2）。
- **新しい lease_id の初回の音声リースを、音声所有権の取得とする**（原本に決めなし）。所有者が有効なまま別の端末が取得したとき、300 ms 以内（ちょうどを含む）は 409（`audio_owned_elsewhere`）。ただし要求した端末が表示先なら優先する。300 ms より後は端末の交代として、前の端末の Live を閉じる要求を記録してサイドバンドから session.close を送り、リースを取り消し、停止のイベント（`close_voice_session`・`device_move`）を送ってから発行する（10 §8）。session.closed は待たない（U72）。中枢の時計を比べられないときは閉じない側（409）。
- 取り消した（停止・交代）リースの同じ lease_id は更新しない。交代なら 409、停止なら世代の古さ（`stale_io_epoch`）など、理由がなくても `lease_rotation_required`。
- **nonce の履歴の上限**: 1 つのリースで受け付ける更新は 1800 回（2 秒ごとで 1 時間分）。超えたら `lease_rotation_required`（契約の拒否の理由に足した）で、端末は新しい lease_id・previous_nonce null で取り直す。使い済みの nonce を全て持つ保証（ADR 0038）は 1 つのリースの中で保つ。
- 中枢の見積もりの期限は「最後に受け付けた時刻（中枢の単調時計）+ 返した ttl」。端末は要求を送った時点から数えるので、端末の期限は必ずこれより前に来る。見積もりで切れた音声リースの Live は、中枢からも `core_lease_lost` で閉じる（07 §5）。

## Live の接続（古い世代・期限切れのリースでは開けない）

受付の順は、端末の状態と世代 → `admitLiveStart`（所有者・停止・リース・記録しない会話・返し方・同意）→ 会話の存在 → provider と予算の境界 → 1 台に 1 つの接続 → 予約（15 秒 + 180 秒）→ 送出意図 → 世代の発行と記録 → provider へ 1 回だけ送る。リースが有効と言えるのは、所有者が自分・取り消していない・中枢の見積もりで期限内・リースの io_epoch が今の世代・同じ接続範囲・まだ Live を開いていない（1 つのリースで 1 つ）ときだけ。provider の結果が分からなければ送り直さず、終了未確認として予約を保持する（`usage_unknown`）。返し方と記録しない会話の正本が中枢にない点は U71。

## 制御接続（サイドバンド）と喪失（X25・QA24）

- SDP answer を返すのと同時に接続を始め、3 秒で接続できなければ lost。接続したら端末へ `sideband_connected` を送る。
- ping 2 秒、最後の pong から 6 秒で `ping_timeout`（5999 ms では ready）。断線も lost。lost では control_epoch を進め、端末へ `close_voice_session`（`sideband_lost`）を送り、**ハートビートが正常でも音声リースを更新しない**（`sideband_lost`）。
- 閉じるためだけの再接続を 1 回・3 秒まで試し、成り立てば session.close を送る。成り立たなければ終了未確認（予約を保持）。3 秒の後に成り立った接続は使わない。session.close の後 2 秒で session.closed がなければ終了未確認（仮置き。U72）。後から届いた使用秒数で照合して精算する（15 秒の最低課金を含む）。
- provider が使用秒数つきで先に閉じたら、確認済み・精算し、端末へ `close_voice_session`（`provider_failure`）を送る。使用秒数のない終了は断線として扱う。

## 停止と再開（X13・X14・QA43。U70）

- 停止は版を求めず常に受け付ける。中枢が対象の端末（local は要求した端末、guest・global は失効していない全端末）の io・output の世代を 1 進めて保存し、リースを取り消し、開いている Live を第 3 層として閉じ始め、要求した端末以外へ `suspend_io` を送る。以後の更新は世代の古さと停止中で通らないので、停止の通知が届かなくても端末は 6 秒で止まる。
- 応答の `devices` は、要求した端末だけ `confirmed`、中枢の見積もりでリースが切れた端末は `lease_expired`（停止の確認ではない）、他は `awaiting_ack`。他の端末の ACK の経路は原本に決めなし（未実装）。
- 再開は画面操作・ロック解除・`expected_io_epoch` の一致だけ（経路の検査と DB の両方で照合）。停止の印を外すだけで世代は進めず、リースは戻さない（端末は今の世代で新しいリースを取り直す）。再接続（bootstrap のし直し）・ロックの解除・新しいリースだけでは再開しない。来客モード・全体停止は DB にあるので中枢の再起動で解除しない。

## 中枢の再起動（X28）

起動時に、閉じ終えていない Live を `core_restarted`（ready・connecting なら control_epoch を進める）→ 閉じる要求 → 終了未確認（予約を保持）にする。provider のセッション ID を保存しないので、前の起動のサイドバンドからは閉じない（実 API の作業で決める。U72）。世代は DB にあるので巻き戻らない（次の Live の audio・session は前の値の次）。

## 契約の変更

- `POST /v1/leases/renew`（x-buddy-core-checks は device_token・home_network・command_scope）。`api-cases.json` に合成の例を足した。
- `LeaseRenewalRejectReason` に `lease_rotation_required`。
- `ApiError.code` に `io_suspended`・`audio_lease_invalid`・`output_mode_text`・`external_send_consent_required`（`admitLiveStart` が返すコードで、B05-01 の契約の列挙から漏れていた）。

## 判断が要る点

1. **リースの経路を足したこと**（U68）。07 §2 の API 表にない経路です。所有権を初回の音声リースで取る読みも原本に決めなし。
2. **停止の世代を中枢が進める**（U70）。ADR 0038 は端末が進めて中枢が MAX で保存する案でした。他の端末の ACK の経路（停止確認済みにする手段）も決まっていません。
3. **nonce の上限 1800 回で取り直し**（U69）。
4. **中枢の待ち時間の仮置き**（session.closed を 2 秒）と、**交代で session.closed を待たない**こと（U72）。
5. **返し方・記録しない会話・同意・表示先の正本がない間の扱い**（U71）。

## 残ること

- 同意の経路（HTTP・main の OS の確認ダイアログ）と `voice_consents` の表、返し方・記録しない会話・表示先の正本（U71、UI-08）。
- 会話中の 60 秒ごとの追加予約と予算到達の閉じ方（`topUpSchedule`・`planBudgetFailure`）の Core への接続（予算の門は B07-07 が進めている。ここでは境界の型だけを使った）。
- 端末が進めた世代の報告の経路（`acceptDeviceEpochReport`）、端末の起動時の世代（`deviceEpochAtStartup`）、復元時に Core 発行の世代を進める処理（`epochsAfterRestore`）。
- provider（OpenAI の Live）の実装と、実 API の 2 段階の試験（合成の音声、その後に本人の声）。端末の main・音声レンダラーの実装。

## 試験（模擬のみ）

- `apps/core/src/voice-control.test.ts`（DB worker・予算の門・模擬の provider・手で進める時計）: リースの取得・更新・拒否、ロック、1800 回の取り直し、X32（300 ms・表示先・交代）、Live の受付の拒否（リースなし・期限切れ・別の接続範囲・同意なし・同じリースの 2 回目）と結果不明の保持、X25（6 秒・5999 ms・閉じるための再接続・3 秒・2 秒・遅れた使用秒数での精算）、X14（全体停止の到達・第 3 層・停止のイベント・lease_expired）、QA43（再接続・新しいリースでは再開しない・版の一致）、X28（再起動の後の世代・前のリース・ready だった Live）、X13（回線の断・サイドバンドだけの lost・停止の通知の欠落のどれでも、端末の模擬が最後に受理された要求から 6 秒で止まる）、端末の模擬の時計の逆行・ACK の失敗・音声レンダラーの無応答（domain の規則）。
- `apps/core/src/api-voice.test.ts`: HTTPS に組み込んだ経路（bootstrap の io_state、リース、409、全体停止と WSS の停止のイベント、画面の再開、Live の拒否）。応答は JSON Schema で検査した。
- `packages/storage/src/voice-store.test.ts`: 0008 の更新（版 7 の DB）、trigger、停止・再開・Live の開始と更新の compare-and-set。
- `scripts/voice-ownership.test.mjs` と `packages/contracts/fixtures/voice-ownership-cases.json`: 調停・期限・取り直し・到達の手書きの期待値。
- 実際の音声・実 API・実機・実請求は**未実施**。停止の時間（200 ms・300 ms・6 秒）は設計初期値で、合格値ではない（T04 の実測の後）。
