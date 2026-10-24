# ADR 0038: B05 の音声の契約の補い（限定 IPC・制御接続・リース・世代の永続・input_kind・外部への送信の同意）

- 日付: 2026-10-23
- 状態: B05-01（#125、親 #15）の判断。契約（JSON Schema・生成型）、domain の純粋な規則（`packages/domain/src/voice.ts`）、手書きの fixture、試験、マイグレーション 0008 の案（SQL は書かない）だけ。音声レンダラー・KWS・ASR・Live の接続・サイドバンド・リースの実装、同意の経路と画面、epoch の永続（SQL）は未実装。実際の音声・実 API・実機は未実施で、この ADR の試験は模擬の期待値だけ。
- 追記（2026-10-24、ADR 0041）: B05-02 で domain の純粋な規則（リースの期限・世代の発行・3 層の停止の時間・無音・追加予約・通知の頻度・方式 A/C・ASR の比較）を足した。下の「原本に決めがない項目」のうち、再生停止の ACK が返らないときの理由（既存の device_io_stop を使う）と `set_silence_timeout` の宛先（main が判定）は ADR 0041 で決めた。サイドバンド接続済みの伝え方は未決のまま。
- 根拠: 設計 07 §1・§2・§5、10 §1・§1A・§2・§2A・§3・§5・§6・§6A・§7・§10、09（X13・X25・X28・X30・X31・X32・X46・X47・X49・X54・X58・QA43）、ADR 0005・0006・0014・0032・0037、本人の判断（2026-10-23、#15 のコメント）。原本は権限のある接続で読み取りだけ行い、全文は写していない。原本に決めがないことは「原本に決めなし」と書いた。ADR 0005・0006 で決めたことは、下の「ADR 0005 との関係」に書いた追加のほかは変えていない。

## 本人の判断（#15 のコメント、2026-10-23）

| 項目                        | 本人の判断                                                                                                                                                                   | この作業での反映                                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 呼びかけ                    | 端末内の sherpa-onnx で、語を指定する方式で "Hey Buddy" を検知する（学習なし）。ショートカットと「続ける」ボタンでも起動できる。誤起動が多ければ、後で専用のモデルを学習する | 契約に KWS のモデルは入れない（起動の経路は音声リースと `voice.start` だけ）。KWS のモデルと語の指定は「原本に決めなし」の表へ。最小の起動の操作（ショートカットと「続ける」ボタン）は B05（B05-02 以降）で作る。入力バーの見た目と AquaVoice は UI-08（#100） |
| 実 API の試し方             | 2 段階。まず合成の音声で接続・停止・精算、その後で本人の声で日本語の品質                                                                                                     | 試験の区分を `docs/b00/contract-map.md` と test-map の説明に追記（この ADR は模擬だけ）。2 段階の実施は B05-0x                                                                                                                                                 |
| 実 API の試験の費用         | 本番の音声の枠とは別に、小さな上限の試験用の枠。接続の回数と合計の時間にも上限。金額は本人がリポジトリの外の設定ファイルで決める                                             | 金額・回数・時間は契約にも fixture にも入れない。試験用の枠の置き方は「原本に決めなし」の表へ（枠の木の別の根にするか。ADR 0006・0037 の音声の枠との関係を B05-03・B07 で確かめる）                                                                            |
| 外部へ送ることへの同意      | 初めて使うときに main の OS の確認ダイアログで 1 回だけ取って記録する。いつでも取り消せる。会話中は端の印と効果音で常に示す                                                  | `ExternalSendConsent`・`ExternalSendConsentChange`。同意は中枢が正本（下の「外部への送信の同意」）。取り消しで Live を閉じる理由 `consent_revoked` を足した。会話中の印は UI-04 の「音声を外部へ送っている」記号に既にある                                     |
| 人名のヒント（hotwords）    | 最初は使わない。実測で誤認識が多ければ、一時ファイルで渡して直後に消す方式を足す                                                                                             | 契約に hotwords の項目を入れない。人名はこの ADR の対象外（設計 10 §6A の「RAM だけ・一時ファイル」は B05 の実測の後）                                                                                                                                         |
| UI-08（#100）との分担       | B05 は状態・IPC・最小の「続ける」まで。入力バーの見た目と AquaVoice は UI-08                                                                                                 | 契約は状態・IPC・起動の経路（音声リースと `voice.start`）まで。最小の「続ける」の実装は B05-02 以降。入力バーの見た目・AquaVoice の契約は作らない                                                                                                              |
| stop_playback の後の再開    | 設計 10 §1A に従い、新しい Live 接続を既定にする。同じ接続で再生に戻る方式は、実機で検証できたら有効にする設定として持つ                                                     | `resolvePlaybackResume`（既定は `new_live_connection`）と、設定 `voice.same_connection_playback_resume`（既定 false）。ADR 0005 との関係は下の「ADR 0005 との関係」                                                                                            |
| 読み上げの定型句（質問 99） | 読み上げは定型句を使わず、効果音だけにする                                                                                                                                   | `VoiceClipId` は効果音の 6 つだけで、話し言葉の識別子を持たない。`voice.play` に定型句の識別子を渡すと Schema が拒否する                                                                                                                                       |

## 音声レンダラーへの限定 IPC（`VoiceRendererRequest`・`VoiceRendererAck`）

main から音声レンダラーへの命令は、`voice.start`・`voice.stop_playback`・`voice.close_voice_session`・`voice.suspend_io`・`voice.play`・`voice.set_silence_timeout` の 6 つだけです（設計 10 §1）。これ以外の名前（トークンの取得・HTTP の実行を含む）は Schema が拒否します。音声レンダラーは中枢・端末トークン・OpenAI の資格情報を持たず、中枢と通信しません。

- **共通**: `request_id`（UUID）・`ack_timeout_ms`（1〜3000）・`payload`。ACK は `VoiceRendererAck`（`request_id`・`channel`・`outcome`・4 つの世代・`acked_at`）。`outcome` は `applied`・`ignored_stale_epoch`・`rejected_invalid`・`failed`。
- **世代の付き方**: 世代を進めるのは main だけです（ADR 0005 の io_epoch・output_epoch は端末が停止時にその場で進める）。main は世代を進めてから、**進めた後の値**を命令に付けます。音声レンダラーは自分の世代以上の命令を適用し、古い命令は無視して `ignored_stale_epoch` と自分の現在の世代を返します（現在の世代にだけ作用する。10 §1A）。`applied` の ACK は要求の世代をそのまま返し、音声レンダラーは世代を進めません。1 つでも要求より小さい世代の ACK は、どの結果でも受け付けず（`epoch_regressed`）、遅れて届いた古い ACK で再開しません（X30）。
- **命令ごとの世代**: `start` は io・audio・output・session、`stop_playback` と `suspend_io` は io・audio（null 可）・output、`close_voice_session` は io・audio・output、`play` は io・output、`set_silence_timeout` は audio。`stop_playback`・`close_voice_session`・`suspend_io` は `AudioControl` と同じ理由と範囲（scope）を持ち、チャネルごとの理由の列挙は Schema、理由と範囲の組は domain の表（`voiceRequestErrors`）で検査します。
- **ACK が来ないときの動作と待ち時間**（`VOICE_IPC_TIMEOUTS`）:

| チャネル                    | ACK の待ち時間の上限 | ACK が来ないとき                                       | 由来                                                                                         |
| --------------------------- | -------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `voice.suspend_io`          | 300 ms               | 音声レンダラーを強制終了し WebRTC を消す               | 原本（10 §1 第 2 層、X30）                                                                   |
| `voice.stop_playback`       | 300 ms               | 安全側に全停止し、入力の中断を画面で知らせる           | 動作は原本（10 §1）。待ち時間は**原本に決めなし**（仮置き）                                  |
| `voice.close_voice_session` | 1500 ms              | 音声レンダラーを強制終了。中枢もサイドバンドから閉じる | 原本は session.closed を 1 秒まで待つ（10 §2）。ACK の待ち時間は**原本に決めなし**（仮置き） |
| `voice.start`               | 3000 ms              | 接続を閉じて③へ切り替える                              | 原本の許容 3 秒（10 §2・§9）を使った**仮置き**                                               |
| `voice.play`                | 500 ms               | 何もしない（効果音の欠落は安全に影響しない）           | **原本に決めなし**（仮置き）                                                                 |
| `voice.set_silence_timeout` | 500 ms               | 何もしない（無音の判定は main が持つ）                 | **原本に決めなし**（仮置き）                                                                 |

- **ACK は今の状態と照合してから使う**: 要求との対応だけでは、ADR 0005 の「現在の世代との一致」を保証できません。main は待っている要求の一覧（pending）を持ち、停止・失効・世代の更新の後に `retainPendingVoiceRequests` で、世代が今の世代と一致しない要求と、入出力の停止中の `start`・`play`・`set_silence_timeout` を捨てます（停止の命令そのものは ACK を待ちます）。ACK は `acceptVoiceAck(pending, ack, current)` が、(1) pending にある要求に対応する、(2) ACK の世代が戻っていない、(3) 要求の世代が今の世代と一致する（古い `request_epoch_stale`・main が出していない新しい `request_epoch_unknown`）、(4) 入出力の停止中に音を出す命令の ACK ではない、の全てを満たすときだけ使います。捨てた要求の ACK は後から届いても `no_pending_request` で使いません。中枢側で遅着の結果・音声・ACK を受けるときは、既存の `acceptDelivery`（audio.ts）を使います。この 2 つは別の層で、どちらも必須です。

仮置きの値は T04 の実測まで置く値で、合格値ではありません。要求の `ack_timeout_ms` が表の上限を超えると意味検査が拒否します。`set_silence_timeout` の範囲は 1000〜60000 ms（原本の 10 秒・20 秒・60 秒を含む）です。

## Live の制御接続（サイドバンド。`LiveControlTransition`・`nextLiveControl`）

`control_state`（connecting・ready・lost・closing・closed）と `closure`（open・close_requested・close_confirmed・close_unconfirmed）の遷移を表にしました（10 §2A）。

| 出来事                                  | 遷移                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sideband_connected`                    | connecting → ready                                                                                                                                                                                                                                                                                                                         |
| `sideband_connect_failed`               | connecting → lost（control_epoch を 1 進める。3 秒を超えたとき。X54）                                                                                                                                                                                                                                                                      |
| `sideband_disconnected`・`ping_timeout` | ready → lost（control_epoch を 1 進める。ping 2 秒間隔・6 秒期限は設計初期値）                                                                                                                                                                                                                                                             |
| `core_restarted`                        | connecting・ready → lost（control_epoch を 1 進める。再起動した中枢が残った接続を扱う。X28）                                                                                                                                                                                                                                               |
| `close_requested`                       | connecting・ready・lost → closing（closure は close_requested）                                                                                                                                                                                                                                                                            |
| `session_closed_received`               | 使用秒数（0 以上の整数）が要る。closing → closed のほか、**provider が先に閉じた場合**（connecting・ready・lost のまま届く）と、**終了を待つ時間が切れた後に届いた場合**（closed の close_unconfirmed）も、そのまま closed・close_confirmed・予約 settled にする（後者は `usage_reconciled` と同じ結果）。確認済みの後の重複は受け付けない |
| `close_unconfirmed`                     | closing → closed、closure は close_unconfirmed、使用秒数は null。予約は held（解放しない）                                                                                                                                                                                                                                                 |
| `usage_reconciled`                      | closed（close_unconfirmed）→ close_confirmed、使用秒数が要る。予約は settled                                                                                                                                                                                                                                                               |

lost・closing・closed から ready へは戻りません（同じ Live セッションへ再接続して会話を継続しない）。provider が先に閉じて使用秒数つきの `session.closed` が届いたときは、状態を closed へ更新するので、音声処理・リースの更新の許可も残りません。中枢は端末へ `close_voice_session`（理由は既存の `provider_failure`）を送ります。使用秒数のない終了は、`sideband_disconnected` などで lost にして、閉じる要求・確認できなければ `close_unconfirmed` の順に進みます。lost の間は新規の委譲・結果の読み上げ・送出前の音声依頼の変更を止め（`controlAllowsVoiceWork`）、端末とのハートビートが正常でも音声リースを更新しません（`controlAllowsAudioLease`）。精算済みにできるのは、確認した使用秒数があるときだけです。ready・lost の遷移の表は期待値（`live-control-cases.json`）で手書きし、全ての状態・出来事・使用秒数の組でも「世代は戻らない」「lost 以降から ready へ戻らない」「精算済みは確認済みだけ」を試験で確かめました。

## リースの更新（`LeaseRenewalRequest`・`LeaseRenewalResponse`）

更新の入力は、`lease_id`・種類（audio・display）・端末 ID・**中枢の起動 ID**・接続範囲・入出力の世代・`nonce`・`previous_nonce`・**要求を送った時点の端末の単調時計**（`requested_at_mono_ms`）・`heartbeat_ms`・`ttl_ms`です（07 §5、10 §2A）。

- 中枢は、起動 ID・接続範囲・端末・種類・入出力の世代（古い・中枢が発行していない新しい）・端末の停止・端末の失効・音声リースでは制御接続が lost 以降であること・nonce の再利用と再送（`previous_nonce` が前に受け付けた nonce と一致しない）・同じリースの中で単調時計が増えないこと・`heartbeat_ms` が `ttl_ms` より短いこと、を見て拒否する理由を返します（`leaseRenewalReasons`）。端末の単調時計は中枢の時刻とは比べません。
- **使い済みの nonce は拒否**します。中枢はそのリースで受け付けた nonce を古い順に全て持ち（RAM。リースの寿命の間だけ）、直前でなくても再利用を `nonce_reused` で拒否します（A → B → A で、最初の A の遅着の応答を最後の A に当てさせない）。
- 端末は、待っている更新要求（pending。1 つのリースにつき最新の 1 件）の**要求 ID・リース ID・nonce が全て一致する**応答だけを受け取ります。さらに、要求を送った後に中枢の起動 ID・接続範囲・入出力の世代が変わった、または端末の入出力が止まったなら使いません（`core_restarted`・`scope_changed`・`stale_io_epoch`・`io_suspended`）。停止・失効・拒否・適用済みで pending を捨てた後に届いた応答は `no_pending_request` で使いません。期限は**要求を送った時点の単調時計**から数え、遅れて届いた応答の受信時刻から足し直しません。数え直した期限がすでに過ぎていれば延ばさず（`expired_before_applied`）、時計の不整合ではリースを捨てます（`applyLeaseResponse`）。
- 原本は「nonce と単調時計を付ける」までです。`previous_nonce` で更新の連鎖を確かめることと、同じリースの中の単調時計の増加の検査は、再送と時計の巻き戻しを拒否するための**原本に決めなし**の追加です。

## input_kind の受付（`InputKindRule`・`admitInputKind`）

| input_kind    | 経路                                                                           | 出力 | 必要な条件                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`        | HTTP の発言（`POST /v1/sessions/{id}/turns`・`/v1/stream/turns`）              | 文字 | 端末の認証・自宅・接続範囲・ロック解除                                                                                                       |
| `voice_local` | 同じ HTTP の発言（端末内で文字にした声）                                       | 文字 | 上に加えて、収音の許可（入出力が停止中でない）と端末内の認識。**音声は端末の外へ出ないので、外部への送信の同意・音声リースは要らない**       |
| `voice_live`  | 中枢がサイドバンドで受け取る Live の文字起こし。**端末の HTTP では名乗れない** | 音声 | 制御接続が ready・音声の世代と会話の世代が現在・音声リース・収音の許可・記録しない会話でない・返し方が声・**外部への送信の同意**・予算の予約 |

条件の足りなさは表の順にすべて返します。経路が表と合わなければ（`voice_live` を HTTP で、`text` をサイドバンドで）`route_not_allowed` です。`TurnRequest.input_kind` は `text` と `voice_local` だけで、`voice_live` は Schema が拒否します（X49）。返し方は入力の種類だけで決まります（D14）。表は Schema（`InputKindRule` は必須の条件を `contains` で固定し、同意のない `voice_live` の表を拒否する）と domain の定数と fixture の 3 か所で照合します。

## 外部への送信の同意（`ExternalSendConsent`・`ExternalSendConsentChange`）

- **対象**: 音声を OpenAI の Live へ送ること（kind `voice_live_audio`、送り先 `openai_live`）。端末内で文字にする③の音声は端末の外へ出ないので対象にしません。
- **取り方**: 端末ごとに、初めて使うときに main の OS の確認ダイアログで 1 回だけ取ります（Renderer・LLM は同意を作れない。`confirmation.method` は `os_dialog_main` だけ）。取り消しは確認なしでいつでもできます。送り先か同意の文面の版（`policy_version`）が変わったら取り直します。
- **保管する場所（原本に決めなし。この ADR の設計判断）**: **中枢が正本**です。理由は、(1) 承認・実行権限の正本をクライアントに置かない（AGENTS.md）、(2) 外部へ出す点は中枢の `POST /v1/live/sessions`（OpenAI のセッション作成）で、そこで検査すれば端末が偽っても開かない、(3) 取り消しは中枢が Live を閉じる必要がある。端末（main）は最後に受け取った状態を表示のために持つだけで、判定には使いません。端末ごと・送り先ごとの 1 行で、新しい端末は取り直します。バックアップの復元では、取り消した同意が戻らないよう、すべての同意を取り直しにします（閉じた側）。
- **使い方**: `admitLiveStart`（経路の検査の後段）が、端末の状態・記録しない会話・返し方・**同意**・予算の順に検査し、同意が有効でなければ他の条件が揃っても 403（`external_send_consent_required`）で開きません。通知の接続（purpose が notification）も同じです。取り消されたときは、中枢が開いている Live を `consent_revoked` で閉じます。
- **未実装**: 同意を中枢へ送る経路（HTTP）・main の OS の確認ダイアログ・状態欄の表示・取り消しの画面は未実装です。OpenAPI の経路表（`ROUTE_CHECKS`）は変えていません（B05-02 以降）。

## 追加した停止の理由 `consent_revoked`（原本に決めなし）

外部への送信の同意を取り消したとき、開いている Live を閉じる理由が既存の表になかったため、`close_voice_session` に `consent_revoked` を足しました。動作は他の close と同じ（Live と再生を終え、収音・KWS・③は使える）。再開は `local_asr_until_consent`（同意を OS の確認ダイアログで取り直すまで③。①は開かない）です。強さは close_voice_session のまま（端末自体の停止が重なれば suspend_io が優先）。

## stop_playback の後の再開（設計 10 §1A、ADR 0005 との関係）

- **既定**: 本人の音声再開の操作で、確定済みの文脈を渡す**新しい Live 接続**を開きます。旧ストリームを再利用せず、旧世代の音声を新しい世代へ付け替えません。同じストリームから旧音声を排除できたと確認できなければ、出力 mute を保持して訂正の入力と画面での応答を続けます。
- **同じ接続での再生復帰**は、設定 `voice.same_connection_playback_resume`（既定 false）を実機で検証してから有効にします。有効にしても、その場で旧ストリームの音声を排除できたと確認できたときだけ使い（`resolvePlaybackResume(setting, oldStreamExcluded)`）、どちらかが欠ければ新しい Live 接続です。設定の置き場所は B05-02 で決めます（実行時の設定。リポジトリの外）。検証の方法（旧音声の排除の確認）は T04・QA43 の実機で、未実施です。

### ADR 0005 との関係（黙って変えない）

ADR 0005 の表の stop_playback の再開条件 `playback_queue`（再生キューと現在の output_epoch を照合して再開）は**変えていません**。これは「どの音声を再開してよいか」（現在の output_epoch と一致する再生キューだけ）の条件で、**どの接続で再開するか**は別の軸です。この ADR は後者を決めました（既定は新しい Live 接続、同じ接続は設定で有効にしたとき）。ADR 0005 にも同じ内容を追記しました。

## 会話の操作（X58）

`SessionControlPhrases` の照合（短い発話の全体が言い回しに一致したときだけ操作にする）に、操作ごとの効果の表 `SESSION_CONTROL_EFFECTS` を足しました。extend_silence は無音の猶予を 1 回だけ 60 秒に延ばす、stop_playback は `stop_playback`（user_stop）、end_conversation は `close_voice_session`（conversation_ended。会話を終える）、start_private_conversation は `close_voice_session`（private_conversation）、reply_in_text は `close_voice_session`（output_mode_text）です。どの言い回しも別の効果を持ち、同じ終了処理に束ねません。「処理を取り消す」（cancel_workflow）は照合表にない別の命令で、音声も会話も閉じません（10 §1A）。fixture は `session-control-phrases.json`（照合・効果・表の形）です。

## マイグレーション 0008 の案（epoch の永続。SQL は B05-03 で書く）

今は io・output・audio・session の epoch を保存する場所がなく（`live_sessions.control_epoch` と、入力・WorkContext の audio_epoch・session_epoch の列だけがある）、中枢の再起動で巻き戻る恐れがあります。ADR 0005 は「どれも中枢の再起動で巻き戻さず、受け取った側は小さい値に戻さない」と決めています。案:

```sql
-- 0008_voice_epochs.sql（案）
CREATE TABLE device_epochs (
  device_id TEXT PRIMARY KEY REFERENCES devices (device_id),
  io_epoch INTEGER NOT NULL DEFAULT 0 CHECK (io_epoch >= 0),
  output_epoch INTEGER NOT NULL DEFAULT 0 CHECK (output_epoch >= 0),
  audio_epoch INTEGER NOT NULL DEFAULT 0 CHECK (audio_epoch >= 0),
  session_epoch INTEGER NOT NULL DEFAULT 0 CHECK (session_epoch >= 0),
  updated_at INTEGER NOT NULL
) STRICT;
-- 戻さない: BEFORE UPDATE で、どの epoch も OLD より小さければ RAISE(ABORT)。消さない: BEFORE DELETE で RAISE(ABORT)。
-- 端末の登録と同じ transaction で 1 行を作る。
ALTER TABLE live_sessions ADD COLUMN audio_epoch INTEGER NOT NULL DEFAULT 0 CHECK (audio_epoch >= 0);
ALTER TABLE live_sessions ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0 CHECK (session_epoch >= 0);
-- control_epoch は既存。戻さない trigger と、lost・closing・closed から ready へ戻さない trigger を足す（nextLiveControl の表と同じ）。
CREATE TABLE voice_consents (
  consent_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices (device_id),
  kind TEXT NOT NULL CHECK (kind IN ('voice_live_audio')),
  provider TEXT NOT NULL CHECK (provider IN ('openai_live')),
  policy_version INTEGER NOT NULL CHECK (policy_version >= 0),
  state TEXT NOT NULL CHECK (state IN ('granted', 'revoked')),
  confirmation_method TEXT NOT NULL CHECK (confirmation_method = 'os_dialog_main'),
  confirmed_at INTEGER NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (device_id, kind, provider),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
) STRICT;
-- policy_version は戻さない trigger。取り直しは同じ行を granted に更新する。
```

- **発行**: audio_epoch・session_epoch は、中枢が Live の開始・再接続・端末交代で、`live_sessions` の挿入と同じ transaction の `UPDATE device_epochs SET audio_epoch = audio_epoch + 1 … RETURNING` で発行します。control_epoch は lost へ入る更新と同じ transaction で進めます。
- **報告**: io_epoch・output_epoch は端末が進めて報告します。中枢は `MAX(保存した値, 報告した値)` で保存し、小さい値に戻しません。端末の main は起動時に中枢の値（`GET /v1/bootstrap`）と自分の保存値の大きい方に 1 を足して始めます（端末の再インストールや保存の喪失で巻き戻さない。**原本に決めなし**）。
- **リースは永続しない**: リースは RAM の一時の値で、中枢の再起動で起動 ID が変わり、全て無効になります（07 §4・§5）。nonce と単調時計の記録も保存しません。
- **復元**: バックアップの復元は DB 世代（store_generation）を更新し、旧接続・リース・カーソルを無効にします（07 §4）。復元で戻った Core 発行の世代と、復元前の接続が持つ世代が同じ値になっても、旧接続は DB 世代で無効なので受け付けません。復元後の最初の発行の前に、全端末の audio_epoch・session_epoch を 1 進める案です（進める幅は**原本に決めなし**）。復元前に端末が進めた io_epoch・output_epoch は、端末の報告（MAX）で取り戻します。同意は復元後に取り直します。
- 試験は B05-03 で、DB の制約（戻す更新の拒否・消さない・ready へ戻さない・同意の時刻の順）を手書きの期待値で確かめます。この ADR では、同じ規則を domain の純粋な関数と fixture で確かめました。

## 原本に決めがない項目

| 項目                                       | 現状                                                                                                                                                                                 | 次に決める所                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| KWS のモデル                               | 原本は「sherpa-onnx-node の "Hey Buddy" 検知」までで、モデルの種類・語の指定の形式・配布元は決まっていない。本人の判断は「語を指定する方式（学習なし）」                             | B05-02（実測。CPU は待受けで 1 コアの 5% 未満が目標で合格値ではない） |
| ASR（ReazonSpeech）の配布元                | 原本は「初回にダウンロードしてハッシュで検証」「モデルのライセンスは導入前に確認」まで。配布元・ハッシュの取得方法・ライセンスの確認は未決                                           | B05 の ASR の作業（導入前）                                           |
| 同意の保管                                 | 原本に決めなし。この ADR で中枢を正本にした（上）                                                                                                                                    | 本人の確認（下の「判断が要る点」）                                    |
| 実 API の試験の費用の枠                    | 本人は「本番の音声の枠とは別・小さな上限・接続回数と合計時間の上限・金額は外の設定」。原本には試験用の枠がなく、ADR 0006・0037 の枠の木と routing の検査に合わせる必要がある         | B05-03・B07（枠の木の別の根にするか、起点を足すか）                   |
| 合格の値                                   | 停止時間（200 ms・300 ms・6 秒）・応答時間・呼びかけの精度・日本語の品質・CPU は、原本が「初期値で合格値ではない。実機測定の後に決める」（質問 44）                                  | T04・T08 の実測の後。仮置きの ACK の待ち時間もここ                    |
| 再生停止の ACK が返らないときの理由        | 原本は「安全側に全停止」までで、suspend_io の理由に該当がない（device_io_stop 等は別の意味）。表は動作（escalate_suspend_io）だけ                                                    | B05-02（理由を足すか既存を使うか）                                    |
| サイドバンド接続済みの renderer への伝え方 | 原本は「端末へ『サイドバンド接続済み』を送る」「送信トラックは session.started と両方が揃うまで無効」だが、main から renderer への 6 つの IPC に該当がない（start は answer の適用） | B05-02（7 つ目の IPC を足すか、start の再送か）。契約は 6 つのまま    |
| `set_silence_timeout` の宛先               | 10 §1 は音声レンダラー宛の IPC、§3（v0.5）は「無音の判定は main だけ」。両立のため IPC は残し、判定の主体は main とした                                                              | B05-02                                                                |
| 接続の回数・合計時間の上限（試験用）       | 原本にない。本人が外の設定で決める                                                                                                                                                   | B05-03                                                                |

## 判断が要る点

1. **`consent_revoked` の追加**: 既存の表（AudioControl・LiveSessionClose・domain・fixture）の変更です。同意の取り消しで Live を閉じる理由が他になかったためです。名前・強さ（close）・再開（同意の取り直しまで③）に異論があれば直します。
2. **同意の保管を中枢の正本にし、復元で取り直す**: 原本に決めがありません。端末ローカルを正本にする案（端末だけで完結する）は、外へ出す点の中枢で検査できない・取り消しで中枢が Live を閉じられないため採りませんでした。
3. **質問 99 の範囲の読み方**: 「読み上げは定型句を使わず効果音だけ」を、**音声レンダラーが再生する合図**（呼びかけの検知・聞き取り開始・まだ接続中など）に適用しました。委譲のつなぎ「確認しますね」（10 §5。Live への commentary）と、結果の事実文のコードの定型文（10 §6A）は、Live が話すもので質問 99 の対象外と読んでいます。
4. **ACK の待ち時間の仮置き**: suspend_io の 300 ms だけが原本の値で、他は仮置きです（T04 の実測まで）。
5. **端末の epoch の起動時の取り方**（中枢の値と自分の保存値の大きい方に 1 を足す）と、復元時に Core 発行の epoch を進める案は、原本に決めがありません。

## 試験（模擬のみ）

`scripts/voice-contract.test.mjs`、`packages/contracts/fixtures/` の `voice-contract-cases.json`・`voice-ipc-cases.json`・`live-control-cases.json`・`lease-renewal-cases.json`・`input-kind-cases.json`・`consent-cases.json`・`session-control-phrases.json`（X58）・`audio-control-cases.json`（consent_revoked）。期待値は手書きで、実装から生成していません。

- 遅着・再利用・終了の順序: nonce の A → B → A と古い成功応答の遅着（要求 ID の不一致）、停止・失効・再接続の後に届く ACK とリース応答（pending を捨てた後の拒否）、provider が先に閉じた接続と終了を待つ時間が切れた後の通知（どちらも確認済み・精算済みにする）。
- 正常例と拒否例: **世代の逆行**（ACK・音声レンダラーの古い命令・遅着）、**リースの期限の逆転**（期限が確認の間隔以下・数え直した期限が過ぎた応答）、**許されない理由と範囲の組**（os_lock に global・global_stop に local）、**知らない IPC の名前**（`voice.get_device_token` ほか）、**同意のない外部への送信**（同意なし・取り消し・文面の版が古い・別の端末・同意の確認を作れない表）、定型句の再生（`phrase_hai`）、Live の文字起こしを HTTP で名乗ること。
- 実際の音声・実 API・実機・実請求の試験は**未実施**です。契約 CI の成功を製品の試験の合格として扱いません。

## 残ること

- B05-02（音声レンダラー・main・KWS・ASR・限定 IPC の実装、設定の置き場所）、B05-03（マイグレーション 0008 の SQL・Core の Live 接続・サイドバンド・リース・同意の経路）、B05 の実機・実 API の 2 段階の試験。
- 最小の「続ける」（ショートカットとボタンでの起動）は B05-02 以降。UI-08（#100）は入力バーの見た目・同意の画面・AquaVoice。
- `admitLiveStart` を `POST /v1/live/sessions` の後段へつなぐこと（OpenAPI の説明に 403 の理由を追記した。経路の検査の表は変えていない）。
