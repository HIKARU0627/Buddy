# ADR 0106: B10-04 P2a 返答文 reply_text の経路への接続（文字の入力の雑談・一般の質問だけ）

- 日付: 2026-11-14
- 状態: B10-04（親 #18、Issue #246）P2a の判断。ADR 0105 で決めた U217（本人決定 (b)）の境界を、判定の返り値から文字の発言の応答までつなぐ。Live の定型文・追記の上限・調査/相談の背景化の口は P2b、時間制御は P3。実音声・実 API・実請求・実機は未実施。
- 根拠: 設計 10 §5・§6・§6A（雑談は判定と同じ呼出しで返答文まで出させる）、設計 09 X49、contract-map U217、ADR 0005・0070・0090・0105。非公開の原本は権限のある接続で読み取りだけを行い、全文を写していない。
- 対象: `apps/core/src/turn-ports.ts`（`InterpreterReply.reply_text`）、`apps/core/src/model-interpreter.ts`、`apps/core/src/api-turns.ts`（`TurnPlan` の `reply`・`planFrom`・応答と保存）、各試験、`docs/b00/contract-map.md`（U251・U252）。契約（`packages/contracts`）・マイグレーションは変えていない（`TurnResponse` は `result_view.kind = speech_bubble`・`status = answered`・`reply_text` を元から持つ）。

## 決めたこと

| 対象         | 決定                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 判定の返り値 | `InterpreterReply` の意図の返答に、省略できる `reply_text` を足す。`createModelInterpreter` は判定の `reply_text` が null でないときだけ付ける（null のときの返り値は従来と同じ）。判定の層（ADR 0090）は、smalltalk・general_question 以外に `reply_text` が付いた判定を意味の不正にして実行へ進めない（変えない）                                            |
| 解釈の結果   | `InterpretedTurn` の意図に `reply_text` を持たせる。Core は意図表で検査した後、**表示の対象の意図だけ**値を保ち、他の意図の値は捨てる（モデルを信用しない）。影モードの比較・保留・訂正には使わない                                                                                                                                                            |
| 計画         | `TurnPlan` に `reply`（意図・検査済みの文）を足す。`planFrom` は、対象の意図のとき `admitReplyText`（ADR 0105）で検査する。入力が文字（`submitted_text`）で検査を通ったときだけ `reply` にする。通らない・声の入力（Live。`live_policy_observed`・`unverified`）は従来どおり「未対応」の聞き返しで、モデルの文は出ない。承認・読み取り・保存の経路には入らない |
| 応答         | `status: answered`、`result_view = { kind: speech_bubble, status: ready, item_refs: [] }`、`reply_text` = 検査を通った平文。workflow は `done`（実行も操作も作らない）                                                                                                                                                                                         |
| 保存         | **モデルの文は `turn_responses.response_json`（平文の列）に残さない**。保存する応答は `reply_text: null` で、同じ `request_id` の再送は返答文のない同じ結果（`answered`・同じ `turn_id`）を返す。本文の列のように封印して残すかは U251                                                                                                                         |
| 声（①）      | 返答文を読み上げにも画面にも使わない。Live の委譲が smalltalk・general_question を受けても、従来の固定文（未対応）になる。言い回しは GPT-Live-1 に任せる（設計 10 §6A）                                                                                                                                                                                        |
| 聞き返し     | `clarify_question` は変えない（コードの決まった文）                                                                                                                                                                                                                                                                                                            |
| 呼出し回数   | 増やさない。返答文は意図判定と同じ 1 回の呼出しで得る                                                                                                                                                                                                                                                                                                          |

## 試験（模擬だけ）

- `apps/core/src/api-turns.test.ts`: smalltalk・general_question の返答文が、`answered`・`speech_bubble`・`ready`・項目なしで返る。同じ `request_id` の再送は同じ `turn_id` で返答文がなく、本文も含まない。操作は 0 件。空・空白・制御文字だけ・401 文字・URL・`www.`・`javascript:`・Markdown と HTML のリンク・見えない文字で分けた URL・null・未指定は、どの意図でも「未対応」の固定文になり、モデルの文を含まない。制御文字と見えない文字を除いて表示し、400 文字ちょうどは表示する。対象外の意図（query_schedule・create_task・consult・send_mail・memory_save）に返答文が付いても応答に出ない。
- `apps/core/src/model-interpreter.test.ts`: 判定の `reply_text` が null でないときだけ返り値に付く。実際のモデルの経路（偽のアダプター）で、文字の雑談が返答文つきで返り、リンクを含む返答は固定文になり、対象外の意図の返答文は判定の層で拒否され操作が 0 件。
- `apps/core/src/live-conversation.test.ts`: 声の入力で smalltalk が委譲されても、モデルの文は読み上げにも画面にも出ず、固定文になる。

**模擬のみ**。実 API・実請求・実機・実際のモデルの返答の質は未実施で、合格扱いにしない。

## 残ること

- U251: 返答文を会話の履歴として残すか（残すなら本文と同じ封印・期限・忘却の閉包に載せる）。今は返す応答にだけ載せ、再送では返らない。
- U252: 画面の表示。入力バーは聞き返し（`clarification`）の文だけを出す。`answered` の吹き出し（`speech_bubble`）の表示は UI（UI-08・UI-09 の続き）の作業で、この PR では画面を変えない（Core の応答までを接続した）。
- P2b: Live の定型文の追加と結果の種類の対応、追記の上限（3 回・超える分は画面へ）、調査・相談の背景化の口。
