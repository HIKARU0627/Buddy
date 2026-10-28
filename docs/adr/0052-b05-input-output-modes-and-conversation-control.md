# ADR 0052: B05 の入出力のモード・文字応答への切り替え・会話の操作（出力先の固定・結果の届け先・方式 C の委譲・発話開始の一時保留・返し方の切り替え）

- 日付: 2026-10-25
- 状態: B05-05（#129、親 #15）の判断。`packages/domain` の純粋な規則（出力先・結果の届け先・呼びかけでの ① か ③ の選び方・返し方の切り替え・一時保留・Live の文字起こしの整理と入力の受付・声で返す定型文）、中枢の Live の会話の処理（`apps/core/src/live-conversation.ts`）と共通の workflow への入口、会話の操作の適用（中枢・main）、`turn.record` の Live の入力の記録、契約の補い、状態の層の最小の操作（返し方の 2 択・読み上げの停止・会話の終了）、試験。試験は**模擬だけ**（模擬の provider のサイドバンドの出来事・手で進める時計・合成の文字起こし）。実際の音声・実 API・実機・実請求は**未実施**。入力バーの見た目と AquaVoice は UI-08（#100）で、ここでは作らない（本人の判断、#15 のコメント）。
- 根拠: 設計 07 §5、10 §1A・§2・§3・§5・§5A・§6・§6A、09（X27・X36・X46・X47・X49・X51・X58・X59・QA05・QA35・QA41）、ADR 0005・0006・0037・0038・0041・0046・0049・0050、本人の判断（2026-10-23、#15 のコメント）。原本は権限のある接続で読み取りだけ行い、全文は写していない。原本に決めがないことは「原本に決めなし」と書き、`docs/b00/contract-map.md` の U99〜U103 に記録した。ADR 0038・0041 の規則（`acceptDelivery`・`resolveOutputMode`・`admitInputKind`・`admitMethodC`・`resolveSessionControl`・`SESSION_CONTROL_EFFECTS`）は変えずに使った。

## 作ったもの

| 部分                         | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 出力先の固定                 | `voice-interaction.ts`: `fixOutputTarget`。入力ごとに出力先（text・voice、device_id、session_epoch）を固定し、音声の接続が開いているかを見ない。声で返すのは Live の文字起こし（voice_live）で接続の世代があるときだけ。文字入力・端末内の音声認識は、どの世代・接続の状態でも文字（④文字→音声は作らない）                                                                                                                                                      |
| 結果の届け先                 | `routeResultDelivery`。声（voice）・画面（screen）・捨てる（discard）の 3 つ。声で返せるのは、声で依頼され、接続が開いたままで、文字へ切り替えておらず、裏の処理へ移しておらず、世代（音声・出力・会話）・端末・リースが今も有効なときだけ（`acceptDelivery` を使う）。それ以外は画面（一覧）へ回し、結果を捨てない。訂正・取消で失効した旧版だけ捨てる。文字の依頼は、他の条件がどうでも声にならない（全組を試験）                                             |
| 呼びかけでの ① か ③          | `chooseWakeInteraction`。入出力が許可されていなければ何もしない。声の接続は、返し方が声・記録する会話・同意あり・残り 15 秒以上・直近の失敗なし・中枢の拒否なしのときだけ。知らない値（返し方・同意・予算）は文字へ倒す                                                                                                                                                                                                                                         |
| 返し方の切り替え             | `planReplyModeChange`。声から文字は、開いている Live（始めている途中を含む）をすぐ閉じる（理由 output_mode_text）。会話（session_id）と文脈は続く。文字から声へは設定を戻すだけで、接続は次の「続ける」・呼びかけで新しく作る（閉じた接続・同じ接続を戻さない）。端末（main）が持つ（`voice-reply-mode.ts`、userData の `voice-reply-mode.json`。U99）                                                                                                          |
| 方式 C の委譲                | `voice-live-input.ts` と `live-conversation.ts`。サイドバンドの断片を発話（ターン）ごとにため、連番の飛び・時刻の対応・対象のターンが 1 つか・300 ms の安定を確かめる。入力の受付（`admitInputKind` の voice_live の 9 条件）→ 方式 C の限定（`admitMethodC`: 4 操作だけ。記憶の保存・画面承認の操作・表示先の移動・他の参加者のいる予定は全文の確定へ戻す）。進めてよいときだけ、共通の workflow（api-turns の `commitLive`）で readiness を再検査して保存する |
| 共通の workflow への入口     | `api-turns.ts` に `interpret`（解釈。副作用なし）と `commitLive`（保存）を足した。保存は文字入力と同じ `recordTurn`（暗号化・意味検証・readiness・承認待ちの操作）で、入力は `live_fragment`・`live_transcript_policy`・`live_policy_observed`・方針の版・音声の世代つきの暫定入力として記録する。確定前の参照は `collecting`、確定できなかった入力は `blocked`・`unverified`（依頼・操作を作らない）                                                           |
| 方式 C と自動実行の方針      | readiness は方式 C の入力を、画面承認が要る操作と、方針が自動実行を許さない操作で `requires_full_text` にする。**方針表が自動実行を許さない既定（B04 の試験用の表はすべて off）では、4 操作でも承認の対象を作らず、画面で全文を確かめる案内になる**。承認待ちへの昇格はしない                                                                                                                                                                                   |
| 発話の開始による一時保留     | `startUtteranceHold`・`resolveHold`。新しい本人の発話の開始で、送出前の変更を保留する（参照・送出済みは保留しない）。訂正・補足・取消が一つの対象に確定したときだけ扱いを決め（supersede・cancel）、別件は再開、確定しない（関係が分からない・対象なし・複数・知らない対象）は保留のまま聞き返し、勝手に再開しない。保存の命令の直前にも保留を見る（`precommit`）。保留の上限は 30 秒で、超えたら実行せずに捨てて画面へ知らせる（U103）                         |
| 会話の操作（LLM を使わない） | 製品の照合表（`SESSION_CONTROL_TABLE` 版 1。手書きの fixture と同じ値）。①: 中枢が発話の全体（終了候補・断片が 300 ms 変化なし）を照合し、読み上げの停止（再生だけ止める）・会話の終了・記録しないで・文字で返して（接続を閉じる。理由はそれぞれ別）・ちょっと待って（次の 1 区間だけ 60 秒。新しい音声イベント `silence_extension`）を行う。②③: 文字の発言を照合し、`status: session_control`・`session_control` を返す。依頼は作らない（U100）                |
| 声で返す定型文               | `voice-commentary.ts`（版 1）。予定の件数・重なり・残りの件数と画面への案内だけ。承認の対象は「画面で確認してください」で、実行を告げる語を含めない。言い直し・全文の確定の案内は別の定型文。1 回の追記は 3 つ以内・200 文字以内                                                                                                                                                                                                                                |
| 遅着の結果を画面へ           | 中枢の `canvas-stream.ts` の `placeLate`。声で返せなかった結果を、発言の結果と同じ配置者・意味の検査でキャンバスへ置く（同じ発言は重ねて置かない）。保存の途中に Live が閉じても、依頼は 1 つ保存し、結果は画面へ回る（U101）                                                                                                                                                                                                                                   |
| デスクトップの返し方・操作   | `voice-controller.ts`: 返し方（`DesktopVoiceView.reply_mode`）・`setReplyMode`・`applyControl`・`applyTurnControl`・`onCoreVoiceEvent`（形・宛先の端末・今の接続の世代を確かめ、中枢が出した停止・終了・無音の延長だけを受ける）。限定 IPC `desktop.voice_control`（読み上げの停止・会話の終了・声で返す・文字で返す）。文字のとき「続ける」は押せず、同意・リース・接続を求めない                                                                              |
| 状態の層（最小）             | `VoiceStrip` の 3 段目: 左に返し方の 2 択（声／文字のトグル。記号だけ）、右に読み上げの停止（■）・会話の終了（×）。押せない間は枠だけで位置は変えない。文字で返す間の「続ける」は枠だけ（始めている途中の回る記号を出さない）。見た目の整えは UI-08                                                                                                                                                                                                             |

## 契約の変更

- `SessionControlAction`（新）: 会話の操作の 5 値。`TurnResponse`・`StreamTurnResponse`・`DesktopTurnResult` に任意の `session_control`（status が `session_control` のときだけ。意味検査: 状態と対で、依頼・結果の表示を持たない）。
- `VoiceEvent`: `event_type` に `silence_extension` と任意の `silence_extension_ms`（1000〜60000。その種類だけ）。
- `DesktopVoiceView`: `reply_mode`（必須。hidden を除く）。`DesktopIpcChannel` に `desktop.voice_control`（payload は `{action}`: stop_playback・end_conversation・reply_in_voice・reply_in_text。処理の取り消し・記録しない会話は含めない）。状態の層だけ。
- 解釈の差し込み口（`InterpreterReply`）に任意の `relation`・`target_workflow_id`（コードが検証する。なければ「分からない」）。
- 保存（`turn.record`）に任意の `input`（Live の入力の記録）。マイグレーションは足していない（0001 の列の制約の範囲）。

## 判断が要る点（原本に決めなし。本人の確認待ち）

`docs/b00/contract-map.md` の U99〜U103 に同じ内容を記録した。

1. **返し方の正本（U99）**: 端末が持つ（質問 107 は端末ごとの切り替えボタン）。記録がなければ声、あるのに読めない・形が違うなら文字。中枢は持たず、Live を閉じる理由（output_mode_text）で知る。
2. **会話の操作の適用先（U100）**: 「会話の終了」は Live を閉じるまでで、会話（session_id）の終了は作っていない。流れの区切り（UI-05）と合わせて決めるため、`session.end` の命令は足さなかった。「記録しないで」は接続を閉じるまで（記録しない会話の開始は B06・UI-08）。
3. **声の結果の届け先と画面（U101）**: 画面は今の流れのキャンバスへ置く。次回の文脈要約へ含めることは、文脈（ConversationContext）の組み立てが未実装なので未対応。
4. **Live の文字起こしの整理（U102）**: 断片の連番（0 から。provider が持たなければ null で、欠落を確かめられないので変更は進まない）、発話の開始・終了候補（provider の抽象のイベント。端末の VAD の報告経路は未）、対象のターンの窓 2 秒（先の委譲が使ったターンは候補から外す）、確定を待つ上限 5 秒、方針の版 `1`。
5. **一時保留（U103）**: 上限 30 秒、関係の出所は解釈の `relation`・`target_workflow_id`（なければ分からない）、会話の操作は別件として保留を解く、Live が閉じたら保留は捨てる。

## 解決しなかったこと

- **文字で返す設定の聞き取り（③）**: KWS・端末内の音声認識（ReazonSpeech）は未実装なので、文字で返す設定でも端末内で聞き取る経路はない。「続ける」は押せないだけで、③の聞き取りを始めるボタンはない。`voice_local` の HTTP の受付は B04-03 のまま（503）。
- **端末の VAD・無音の判定**: `silence_extension` を受ける口（`onSilenceExtension`）だけ。無音の判定を main が行う実装は未了で、製品の起動では配線していない。
- **中枢の音声イベントの受信**: デスクトップは WSS を持たないため、`onCoreVoiceEvent` は試験からだけ呼ぶ。配線は WSS の受信の作業で行う。`main.ts` へは返し方の保存と文字の発言の `session_control` の配線だけを足した。
- **端末の再生停止の中枢への報告**: 画面のボタンの読み上げの停止は main の出力の世代だけを進める。中枢の保留中の結果は止まらない（Live の発話の「読み上げを止めて」は中枢が照合するので止まる）。
- **委譲のつなぎ・8 秒の裏への切り替え・先回りの処理・ConversationContext・全発話の保存**: 設計 10 §5 は B10 の実装範囲。委譲されなかった発話は保存していない。
- **Live の発話ごとの断片の保存・依頼の版の更新（request_revision の増加）**: 訂正は、保存前の旧い依頼を作らない（旧い版が DB にない）ことで扱っている。保存済みの依頼の版の更新は B10。
- **実際の音声・時計・ASR の精度・provider のイベント名**: すべて未実施（T04・T08、実機・実 API の 2 段階の試験）。

## 試験（模擬のみ）

- `scripts/voice-interaction.test.mjs` と `packages/contracts/fixtures/voice-interaction-cases.json`（手書き）: 出力先・結果の届け先（文字の依頼が声になる組が 0 であることの全組）・呼びかけでの選び方・返し方の切り替え・一時保留・文字起こしの整理・入力の受付と 4 操作（全 24 意図 × 観測の全組で、進むのは 4 操作だけ）・定型文・製品の照合表と手書きの表の一致。
- `apps/core/src/live-conversation.test.ts`（本物の DB worker・VoiceControl・共通の workflow）: QA41（完全な観測で 1 つの承認待ち、方針が許さなければ操作 0）・X59（記憶・承認の対象は全文の確定まで 0）・X51・QA05（欠落・対応不明・対象が複数・offset 不明は変更 0）・X49（文字の依頼は接続が開いていても文字、voice_live を HTTP で名乗れない）・X58（照合表の各操作の効果が別。LLM を呼ばない）・X27・QA35（保留・訂正・取消・確定しない・上限・保存の直前の再検査）・X29・X36（遅着は画面・Live の終了で保留は捨てる）・X47・X46（返し方が文字・同意の取り消しで受けない）。
- `packages/storage/src/conversation-store.test.ts`: Live の入力の記録（sealed・partial・blocked と拒否）。
- `apps/desktop/src/main/voice-controller-control.test.ts`・`voice-reply-mode.test.ts`・`operation-bridge.test.ts`・`VoiceControls.dom.test.tsx`: 返し方・ボタンの IPC・中枢のイベントの受け入れと無視・状態の層の 3 段目。
- **変異試験**: domain の `dist` に 17 通り、中枢の `dist` に 10 通りの変異（文字の出力を声にする・知らない返し方を通す・境界を 1 ずらす・保留を解く・保存の直前の再検査を外す・参照を保留に残す・同意・証拠の格下げ・照合の除去など）を入れて試験を走らせ、すべて失敗することを確かめた。最初に生き残った 2 通り（保存の直前の再検査だけを外す・確定した発話の会話の操作の照合を見直しの中で先に行う順）には、その競合の試験を足して失敗させた。試験と自分のレビューで見つけた実装の誤りは 3 件（知らない返し方を声として扱う・参照の依頼が「保留中の変更」として次の発話を聞き返しにする・見直しと照合の timer の順で会話の操作が解釈に回る）で、直した。
- 実際の音声・実 API・実機・実請求の試験は**未実施**。契約 CI の成功を製品の試験の合格として扱わない。`tests/test-map.json` は X27・X47・X49・X51・X59・QA05・QA35・QA41 の契約 fixture を足した（`product_test` は `not_run` のまま）。

## B04・B07 の証拠

`packages/domain/src/index.ts`・`desktop.ts`・`packages/storage/src/conversation-store.ts`・`packages/contracts/schemas/buddy.schema.json` は B04・B07 の実行器の読み込み先なので、`tests/integration/evidence-b04-simulated.json`・`evidence-b07-simulated.json` の `source_sha256` を `docs/b04/README.md`・`docs/b07/README.md` の手順で作り直した（観測の内容は変わらない）。

## 並行する作業との境界

#162（DeepSeek）が直す `voice-controller.ts` の `#leaseLost`・`#continue` と `main.ts` の `onNotification` には手を入れていない。同じファイルの別の箇所（`continueConversation` の先頭の条件・`view()`・IPC の switch・`createVoice` の引数・文字の発言の配線）を変えたので、取り込みの競合が出たら、これらの箇所を残して合わせてほしい。`voice-controller.test.ts` は、`view()` の期待値に `reply_mode: 'voice'` を足しただけ。

## 残ること

- 返し方が文字のときの聞き取り（③: KWS・VAD・ReazonSpeech）、WSS の受信（`onCoreVoiceEvent` の配線）、無音の判定（main）、端末の再生停止の中枢への報告、会話の明示終了と流れの区切り（UI-05）、記録しない会話の開始（B06・UI-08）。
- 委譲のつなぎ・8 秒の裏への切り替え・文脈の要約への反映（B10）、provider の実際のイベント名と連番・時刻の対応（実 API の 2 段階目の作業）、実機の試験（T04・T08）。
- UI-08（#100）は入力バーの見た目・AquaVoice。
