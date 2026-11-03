# モデルの振り分けと profile（B10-02 P2）

- 状態: B10-02 P2 の**模擬の設定**。実 API・実請求・実機は未実施。実 endpoint の能力は確認しておらず、採用も決めていない（B10-07 と B15、本人の承認）。
- 正本: 振り分けと検査は `packages/ai/src/routing.ts` の `TASK_RULES`・`modelProfileErrors`・`routingErrors`、同時数の受付は `packages/ai/src/scheduler.ts` の `planModelCalls`。この文書の表は同じ内容を人が読むために手で書いたもので、実装から生成していない。
- 根拠: 設計 05「モデルの振り分け」・「費用の計算」・「予約と最大負担の区別」、設計 10 §5、設計 11 §8・§9、設計 09 QA13・QA20・QA37・QA40、ADR 0034・0070・0081。

## ジョブの振り分け表

| ジョブ（`ModelTask`）              | 役割             | 思考   | 優先度 | 枠    | timeout の上限 | 構造化出力 | 必須   | 暫定の profile      |
| ---------------------------------- | ---------------- | ------ | ------ | ----- | -------------- | ---------- | ------ | ------------------- |
| 音声の応答 `voice_reply`           | voice            | なし   | P0     | A     | 30 秒          | なし       | はい   | `voice-primary`     |
| 意図＋引数の判定 `intent_judgment` | intent           | low    | P0     | A     | 20 秒          | あり       | はい   | `intent-primary`    |
| 文字で返す会話 `text_chat`         | intent           | low    | P0     | A     | 20 秒          | なし       | はい   | `intent-primary`    |
| 影モードの比較 `intent_shadow`     | intent           | なし   | P2     | B     | 20 秒          | あり       | いいえ | 既定 OFF（D4）      |
| メールの抽出 `mail_extraction`     | background_text  | low    | P2     | B     | 20 秒          | あり       | いいえ | `background-low`    |
| 返信案 `reply_draft`               | background_text  | low    | P0     | A     | 20 秒          | なし       | いいえ | `reply-draft`       |
| 調査のまとめ `research_summary`    | background_text  | medium | P1     | B     | 120 秒         | なし       | いいえ | `background-medium` |
| 相談 `consult`                     | advanced_consult | high   | P1     | B     | 120 秒         | なし       | いいえ | `consult-high`      |
| 記憶の抽出 `memory_extraction`     | background_text  | low    | P2     | B     | 20 秒          | あり       | いいえ | `background-low`    |
| 会話の要約 `conversation_summary`  | background_text  | low    | P2     | B     | 20 秒          | なし       | いいえ | `background-low`    |
| ローカル ASR `local_asr`           | local_asr        | なし   | P0     | local | 60 秒          | なし       | いいえ | `local-asr`         |

- **D1（2026-11-01、本人の決定）**: 意図の判定・抽出・返信案の暫定は Gemini 3.8 Flash（思考 low）。採否は B10-07 の用途別評価で本人が決める。この表はモデルを採用しない。
- **D4（2026-11-01、本人の決定）**: 影モードは既定 OFF。`scheduler.ts` の `shadow_enabled` の既定は false。
- 返信案は本人の依頼への即時の応答なので P0（枠 A）。メールの抽出・記憶の抽出・要約は P2（枠 B）。調査と相談は P1（枠 B）。
- timeout の上限は設計 11 §9 の「P2 は 20 秒」と、即時性の目標から置いた**初期値**で、合格値ではない。実測（B15）で調整する。

## profile の表（模擬の設定）

| profile_id          | 役割             | provider | モデル             | 思考   | 出力の形           | 出力上限 | timeout | 同時数 | price_version          | 予約の方法    | 確認済みの能力（模擬）            |
| ------------------- | ---------------- | -------- | ------------------ | ------ | ------------------ | -------- | ------- | ------ | ---------------------- | ------------- | --------------------------------- |
| `voice-primary`     | voice            | gpt-live | gpt-live-1         | なし   | none               | 500      | 30 秒   | 2      | `price-voice-2026-01`  | max_liability | —                                 |
| `intent-primary`    | intent           | gemini   | gemini-3.8-flash   | low    | json_schema_strict | 500      | 8 秒    | 2      | `price-gemini-2026-01` | max_liability | json_schema_strict、reasoning:low |
| `reply-draft`       | background_text  | gemini   | gemini-3.8-flash   | low    | none               | 400      | 20 秒   | 2      | `price-gemini-2026-01` | max_liability | reasoning:low                     |
| `background-low`    | background_text  | gemini   | gemini-3.8-flash   | low    | json_schema_strict | 500      | 20 秒   | 1      | `price-gemini-2026-01` | max_liability | json_schema_strict、reasoning:low |
| `background-medium` | background_text  | gemini   | gemini-3.8-flash   | medium | none               | 1,500    | 120 秒  | 1      | `price-gemini-2026-01` | max_liability | reasoning:medium                  |
| `consult-high`      | advanced_consult | gemini   | gemini-3.8-flash   | high   | none               | 2,000    | 120 秒  | 1      | `price-gemini-2026-01` | max_liability | reasoning:high                    |
| `local-asr`         | local_asr        | local    | （ローカルの一式） | なし   | none               | なし     | 60 秒   | 1      | なし                   | max_liability | —                                 |

- **endpoint は実行時の設定**（リポジトリに置かない）。API キー・認証ヘッダーも実行時の設定で、profile・codec・ログには持たせない。
- `price_version` の ID と単価の実体は B07 の `BudgetRuntimeConfig` の設定にある。この表の ID は模擬の例で、実際の確認済みの版は設定の `verified_price_versions` と照合する。金額・為替・安全係数はこの文書とコードに置かない。
- `確認済みの能力（模擬）` は**模擬の設定のための値**で、実 endpoint で確かめた記録ではない。実 endpoint の能力の確認と採用は B10-07 の評価・B15 の実 API の承認まで行わない。この表を実機の合格として扱わない。
- 構造化出力を使う profile は `structured_output` と同じ名前の能力を `verified_capabilities` に持つ。思考を使う profile は `reasoning:<値>` を持つ。持たない profile は `routingErrors` が `capability_unverified` で拒否する（schema の記載から能力を推定しない）。

## profile と振り分けの検査

| 理由コード                                                         | 拒否する条件                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `duplicate_profile:<id>`                                           | 同じ `profile_id` が 2 つ以上ある                                 |
| `required_route_missing:<task>`                                    | 必須のジョブ（音声・意図・文字会話）に経路がない                  |
| `unknown_profile:<task>`                                           | 経路が存在しない profile を指す                                   |
| `role_mismatch:<task>`                                             | profile の役割がジョブの役割と違う                                |
| `reasoning_mismatch:<task>`                                        | 思考の値がジョブの表と違う（表が null なら profile も null）      |
| `structured_output_missing:<task>`                                 | 構造化出力が要るジョブに `none` の profile を割り当てた           |
| `output_limit_missing:<task>`                                      | 有料の provider の profile に出力上限がない（M を有限にできない） |
| `price_version_missing` / `price_version_unverified:<task>`        | 有料の profile に `price_version` がない・確認済みの一覧にない    |
| `timeout_out_of_range:<task>`                                      | `timeout_ms` が 1 未満、またはジョブの上限を超える                |
| `concurrency_invalid` / `provider_concurrency_mismatch:<provider>` | 同時数が 1 未満、または同じ provider の profile で同時数が違う    |
| `capability_duplicate` / `capability_unverified`                   | 能力の重複、または宣言した構造化出力・思考が確認済みの能力にない  |
| `p95_not_intent`                                                   | 意図以外の profile に `measured_p95` を使う                       |
| `local_provider_required`                                          | `local_asr` の profile の provider が `local` でない              |
| `provider_shared_between_priorities:<provider>`                    | QA37。同時数 1 の provider を P0 と P1／P2 で共有する             |

## 同時数と優先度（QA13・QA37）

- テキスト推論は**同時 2 本**。**枠 A は P0 専用**、**枠 B は P1→P2**。P0 は枠 A が空いていれば P2 の完了を待たない。
- **ローカル生成は同時 1 本**。
- 影モードは枠 B の内側で、P0／P1／P2 の仕事がある間は待たずに skip する（`shadow_disabled`・`shadow_budget`・`shadow_busy`・`shadow_wait`）。影モードかどうかは**ジョブの規則**（`intent_shadow`）で決め、明示のフラグと食い違う要求は `shadow_flag_mismatch` で拒否する。実行中の影モードも枠 B とテキストの同時数に数える（P0／P1 が来たら B10-03 が影モードを止める）。
- 同時数 1 の provider を P0 と P1／P2 で共有する設定は `routingErrors` が拒否する（`provider_shared_between_priorities`）。P0 と P2 を同じ provider に置くと、P0 が P2 を待つか、同時数の上限を超えるため。
- QA40（ローカル P0 の prefix cache の有無）は実機の測定が要る。この P2 では「ローカル生成 1 本」の受付と、profile の能力の登録までで、**遅延の測定は未実施**。cache なしを採用条件未達として扱う判定は B10-07 の評価で行う。

## 試験（模擬だけ）

- `packages/ai/src/routing.test.ts`: 固定表の整合（枠 A は P0 だけ、枠 B に P0 を置かない、影モードは必須でない）、正常な合成設定、各拒否理由、QA37 の provider の共有、p95 の制限、ローカル ASR の provider。
- `packages/ai/src/scheduler.test.ts`: QA13（P0・P1 を受付、P2 は待機、影モードは skip）、QA37（P2 が動いていても P0 は待たない）、影モードの既定 OFF と予算なしの skip、ローカル生成 1 本、provider の同時数 1 の待機。
- **模擬のみ**。実 API・実請求・実機・実 endpoint の能力確認は未実施。
