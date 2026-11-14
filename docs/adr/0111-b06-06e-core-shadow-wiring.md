# ADR 0111: B06-06e Core の配線（影モードの入口と、B15 までの既定 OFF・閉じた口）

- 日付: 2026-11-14
- 状態: B06-06e（親 #142、関連 #143・#18、Issue #245）の判断。Core の `onInterpreted` を `createShadowRecorder` と SQLite の保存先につなぐ。**設定（campaign・比較モデルの配備・endpoint・認証）は読まない**（B15 と本人の承認まで）。契約・マイグレーションは変えていない。実 API・実請求・実機・実音声は未実施。
- 根拠: 設計 10 §5、設計 09 X48、ADR 0092（影モードの記録・既定 OFF・D4）・ADR 0110（保存の命令）、`apps/core/src/shadow-mode.ts`・`api-turns.ts`・`core.ts`。非公開の原本は写していない。
- 対象: `apps/core/src/shadow-store.ts`（新規）、`shadow-store.test.ts`・`shadow-wiring.test.ts`（新規）、`shadow-mode.ts`（`ShadowRecordStore.save` に保存モード）、`core.ts`。

## 決めたこと

| 対象                 | 決定                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 保存先               | `createDbShadowRecordStore(client)` を新設し、`ShadowRecordStore` を DB worker の `intent_shadow.count`・`intent_shadow.save` に写す。件数が読めないときは例外（呼び出し側の `campaignStatus` が null にして比較を始めない）。保存の拒否と成否不明は `failed`（比較の失敗で本線を止めない）。                |
| 保存モードの受け渡し | `ShadowRecordStore.save(record, limit, storage_mode)` に観測した会話の保存モードを足した。保存側（ADR 0110）が `record_shadow` の許可を確かめるため、Core の判断を渡すだけで写し取らない。既存の偽の保存先（試験）は引数が少なくても型が合うので、呼び出しの変更は 1 か所。                                  |
| 入口                 | `core.ts` の `startHttps` で `createShadowRecorder` を組み立て、`createTurnRoutes` の `onInterpreted` を「`observe` に渡す→呼び出し側の口（試験・診断）にも渡す」の 1 つの関数にする。`observe` は同期で戻り、失敗しても発言の結果を変えない（ADR 0092）。                                                   |
| 設定（既定 OFF）     | `settings: () => null`。設定の読み込み（campaign・比較モデル・endpoint・認証）は B15 と本人の承認まで入れない。設定が無い間は `observe` がモデルも保存先も呼ばない（比較の呼出し 0・記録 0）。                                                                                                               |
| 本番の値で渡す口     | `privateConversation` は `StorageModeGate.privateConversation()`（受付の前後・保存の直前にも読み直す）、`liveSessionOpen` は Core がメモリーに置いている Live の接続数（`VoiceControl.liveCount`）が 0 より大きいか。観測時の `live_session_open` と、送る直前の読み直しの両方に使う。                       |
| B15 までの閉じた口   | 余力（`planModelCalls`）・実費（`spent`）・予算の口（`guard`）・出力の検証（`output_schema`・`schema`）は B15 の配線。今は **走らせない側**（`slotAvailable: false`、`spent: ''`＝不正な値、`guard.admit` は拒否、検証は常に偽）にし、設定が無い間は届かない。届いたときに黙って緩い側へ倒れないようにする。 |
| 発言の期限           | `onInterpreted` が渡す `turn_expires_at` をそのまま比較の記録の期限にする（比較の完了時刻から数えない。ADR 0092）。Core の入口では `session_id` を使わない（保存先は input_id と版で発言を指す）。                                                                                                           |

## 試験（模擬だけ）

- `apps/core/src/shadow-store.test.ts`: 件数は worker の値・読めなければ例外・保存は記録と上限と保存モードを渡す・拒否と成否不明は `failed`。
- `apps/core/src/shadow-wiring.test.ts`: Core を起動して発言を 1 つ置くと、入口が 1 回だけ呼ばれ、`storage_mode`・発言の版・7 日の期限が渡り、`intent_shadow` の行は 0 件（既定 OFF）。
- `apps/core/src/shadow-mode.test.ts`（既存 24 件）と `apps/core/src/core.test.ts` が通る（`save` の引数の追加で壊れない）。

**模擬のみ**。実 API・実請求・実機・実音声は未実施で、合格扱いにしない。

## 残ること

- B15 と本人の承認: 設定の読み込み（campaign・比較モデルの配備 ID・endpoint・認証）、`planModelCalls` による余力、B07 の予算の門と実費の合計、出力の schema と検証。U260（campaign の開始・停止の置き場）の判断もそこで行う。
- 集計（`ShadowCampaignSummary`）と採否は B10-07。
- B10-04 のつなぎ・背景化の経路でも、受付の前後と送る直前の再確認が同じように働くことの確認（ADR 0092 の指摘）。
