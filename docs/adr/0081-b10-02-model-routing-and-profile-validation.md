# ADR 0081: B10-02 P2 モデルの振り分けと profile の検査

- 日付: 2026-11-03
- 状態: B10-02 P2 の判断。ジョブごとの振り分け表、profile の検査、同時数・枠・影モードの受付だけ。出力の検証・usage の計上は P3。実 API・実請求・実機・実 endpoint の能力確認は未実施。
- 根拠: 設計 05「モデルの振り分け」・「費用の計算」・「予約と最大負担の区別」、設計 10 §5（判定モデルの選定・LLM の同時実行）、設計 11 §8・§9、設計 09 QA13・QA20・QA37・QA40、ADR 0034・0070。本人の決定 D1・D4（2026-11-01）。原本は権限のある接続で読み取りだけを行い、全文は写していない。
- 対象: `packages/ai/src/routing.ts`・`scheduler.ts`・`testing.ts` の合成 profile、`packages/ai/src/routing.test.ts`・`scheduler.test.ts`、`docs/b10/model-routing.md`。契約（`packages/contracts`）は変えていない。

## 決めたこと

| 対象              | 決定                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 振り分けの単位    | 役割（`ModelProfile.role`）だけでなく**ジョブ（`ModelTask`）**ごとの固定表にした。同じ `intent` の役割でも、意図判定・文字会話・影モードで思考・優先度・出力の形が違うため。表は `TASK_RULES` に手で書き、利用側はそこだけを見る                                                                                                                                                                    |
| 優先度と枠        | 設計 11 §9 の P0（対話）・P1（本人が頼んだ裏のジョブ）・P2（自発的解析）を使う。テキスト推論は同時 2 本、枠 A は P0 専用、枠 B は P1→P2。ローカル生成は同時 1 本                                                                                                                                                                                                                                    |
| P0 が待たないこと | P0 は枠 A が空いていれば、枠 B の P2 が動いていても待たない（QA37）。同時数 1 の provider を P0 と P1／P2 で共有する設定は `provider_shared_between_priorities` で拒否する                                                                                                                                                                                                                          |
| ローカル生成      | 同時 1 本の制限は、ローカル ASR（lane local）だけでなく、**ローカル provider を使うテキストの仕事**にも掛ける。ローカル provider の profile を P0 と P1 に置いても、同時に 2 本は受け付けない（`local_limit`）                                                                                                                                                                                      |
| 影モードの順序    | 既定 OFF・予算なしの影モードは、経路の解決より先に `skip` を決める。経路が null の設定でも待機にしない（経路がないまま放置しない）                                                                                                                                                                                                                                                                  |
| 影モード          | 既定 OFF（D4）。有効でも、P0／P1／P2 の仕事がある間は待たずに skip する。予算が空いていないときも skip。影モードのために本人の依頼の枠を空けない。影モードかどうかは**ジョブの規則**（`intent_shadow` の `shadow: true`）を正本にし、明示のフラグと食い違う要求は `shadow_flag_mismatch` で拒否する。実行中の影モードも枠 B とテキストの同時数に数える（B10-03 は P0／P1 が来たら影モードを止める） |
| profile の検査    | `modelProfileErrors` が 1 つの profile を、`routingErrors` が設定全体を検査する。役割・思考・構造化出力・出力上限・price_version・timeout・同時数・能力を確かめる。形（JSON Schema）は contracts が検査済みの値を渡す                                                                                                                                                                               |
| 出力上限          | 有料の provider の profile は `output_limit_tokens` を必須にした。M（最大負担）を有限にできない profile では予約を始められないため（設計 05 F02）                                                                                                                                                                                                                                                   |
| price_version     | 有料の profile は `price_version` と、実行時の設定の `verified_price_versions` への一致を必須にした。金額・単価・為替はコードと文書に置かない                                                                                                                                                                                                                                                       |
| 能力              | 構造化出力と思考は、`verified_capabilities` に同じ名前があるときだけ使える。schema の記載から能力を推定しない（`ModelProfile` の説明）。この判断は**設定の整合**の検査で、実 endpoint で確かめたことの証明ではない。実 endpoint の確認と採用は B10-07・B15 まで行わない                                                                                                                             |
| p95               | `measured_p95` は意図判定の役割だけに許す（設計 05 質問132、ADR 0034）。他の用途へ自動で広げない                                                                                                                                                                                                                                                                                                    |
| ローカル ASR      | `local_asr` の profile は provider を `local` に限る。ローカル生成の同時数は 1                                                                                                                                                                                                                                                                                                                      |
| D1 の暫定         | 意図判定・抽出・返信案の暫定は Gemini 3.8 Flash（思考 low）。表と profile の例は `docs/b10/model-routing.md` に置き、採否は B10-07 の評価で本人が決める。この ADR はモデルを採用しない                                                                                                                                                                                                              |
| timeout           | ジョブごとの上限（P2 は 20 秒、即時の判定は 20 秒、調査・相談は 120 秒、ローカル ASR は 60 秒）を初期値として置いた。合格値ではなく、実測で調整する                                                                                                                                                                                                                                                 |
| endpoint・秘密    | endpoint・認証ヘッダー・API キーは実行時の設定（Core）で渡す。profile の型に秘密を入れず、リポジトリ・ログ・試験に置かない。試験の endpoint は予約済みの `.invalid` ドメインだけを使う                                                                                                                                                                                                              |

## 表の置き場所

人が読む表は [docs/b10/model-routing.md](../b10/model-routing.md) に置いた。ジョブの一覧・思考・優先度・枠・timeout の上限・profile の例・拒否の理由コードを手で書き、`routing.test.ts` が固定表の整合（枠 A は P0 だけ、枠 B に P0 を置かない、影モードは必須でない）を確かめる。表を実装から生成しない。

## 試験（模擬だけ）

- `packages/ai/src/routing.test.ts`: 正常な合成設定、必須の経路の欠落、未知の profile、役割・思考の不一致、構造化出力と能力の欠如、出力上限と price_version、timeout の上限、重複した profile、provider の同時数の不一致、QA37 の provider の共有、p95 の制限、ローカル ASR の provider。
- `packages/ai/src/scheduler.test.ts`: QA13（P0・P1 を受付、P2 は待機、影モードは skip）、QA37（P2 が動いていても P0 は待たない）、影モードの既定 OFF・予算なし・busy の skip、ローカル生成 1 本、provider の同時数 1 の待機。
- `pnpm --filter @buddy/ai run build`、`node --test packages/ai/dist/*.test.js`。
- **模擬のみ**。実 API・実請求・実機・実 endpoint の能力確認・QA40 の遅延測定は未実施で、合格扱いにしない。

## 残ること

- 出力の検証（schema・上限・空・途中の JSON・拒否）と `ModelOutcome`、usage から予約・精算へ渡す部分は P3。
- 実際の provider の codec と、本人の「しっかり考えて」による上位の設定への切り替えは B10-03 以降。
- QA40 の prefix cache の有無による遅延の比較は実機（B15）で測る。cache なしを採用条件未達とする判定は B10-07。
