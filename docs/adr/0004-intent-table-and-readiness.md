# ADR 0004: 意図表・実行可否と入力から結果までの契約

- 日付: 2026-10-19
- 状態: B00-03（#13）の判断。Core の検査処理・DB・外部送出は未実装。
- 根拠: 設計 03 データ表、07 §1〜§5、08 §1〜§5・§9、10 §5・§5A・§6A、11 §5・§5A、修正案 v1.2 の H02、01 流れ C・E、決定事項 D04・D05・D14・J07・J09〜J12。台帳の未決事項 U02・U06・U07 は本人の回答（2026-10-19、いずれも推奨案）で決定。

## 決めたこと

| 対象                     | 決定                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| U02 InputSnapshot の項目 | 設計 03 どおり `origin`・`permission_revision`・`forgetting_generation` を加える。入力時点の値を記録し、最終検査では WorkContext の現在値と比べる |
| U06 経路が原本にない意図 | 下の意図表のとおり。記憶の訂正・忘却は全文確定が必要（方式 C 不可）、handoff は承認不要の LocalCommand、応答だけの意図と undo_action は Read      |
| U07 24 意図の引数        | 全意図で一つの固定フィールド群 `IntentArgs`（13 項目、全項目必須・使わない項目は null）を使う。意図ごとの必須・許可は domain の意図表で検査する   |

`origin` は `seal_reason` と組み合わせて schema で固定します（本人の送信・文字の修正確定は typed、端末内の認識は local_asr、方式 C は live_fragment）。

## 意図表

経路と承認はコード（`packages/domain/src/intents.ts`）が持ち、モデルや端末の申告からは作りません。原本に分類があるものは原本のとおりで、太字は今回の判断（U06）です。

| 意図                                        | 経路                               | 承認                            | 方式 C               | 必須の引数                                     |
| ------------------------------------------- | ---------------------------------- | ------------------------------- | -------------------- | ---------------------------------------------- |
| query_schedule / query_mail                 | Read                               | なし                            | —                    | —                                              |
| **query_tasks / query_memory / dev_status** | **Read**                           | なし                            | —                    | —                                              |
| create_task / create_note                   | LocalCommand                       | 方針による自動（D05）           | 可                   | title / body                                   |
| label_mail / draft_reply                    | RemoteMutation                     | 方針による自動（D05）           | 可                   | target_candidate_id                            |
| create_event                                | RemoteMutation                     | 自分だけの予定は自動、他は画面  | 自動の場合だけ可     | title、start                                   |
| update_event / send_mail                    | RemoteMutation                     | 画面                            | 不可                 | target_candidate_id / body                     |
| **trash_mail**                              | RemoteMutation                     | 画面（ごみ箱への移動まで。J07） | 不可                 | target_candidate_id                            |
| update_task                                 | LocalCommand                       | 画面（X61）                     | 不可                 | target_candidate_id、task_change               |
| memory_save                                 | LocalCommand                       | 本人の明示依頼のため承認なし    | 不可（全文確定）     | body                                           |
| **memory_forget / memory_correct**          | LocalCommand                       | 承認なし（D04、01 流れ E）      | **不可（全文確定）** | 対象（ID または検索語） / body                 |
| **handoff_screen**                          | LocalCommand                       | 承認なし（表示権の移動。D06）   | **可**               | —（device_name が null なら発話した端末）      |
| **research / consult**                      | **Read**（裏の job を含む）        | なし（費用は予約する）          | —                    | query                                          |
| **smalltalk / general_question / unclear**  | **Read**（参照 0 件の応答のみ）    | なし                            | —                    | —                                              |
| **undo_action**                             | **Read**（取り消し一覧を開くだけ） | なし                            | —                    | —。補償操作は画面の undo API で別に作る（J12） |

## 引数の設計判断（U07）

`IntentArgs` は target_candidate_id、start、end、due、title、body、subject、add_labels、remove_labels、task_change、memory_kind、query、device_name です。原本に明記がない点は次の判断です。

- 日時は、タイムゾーンなしの `LocalDateTime` または `LocalDate` で受け、タイムゾーンは本人の設定から Core が付けます（11 §3 の抽出と同じ方針）。日付だけの値を時刻へ変換しません。実在しない日時は意味検査で拒否します。
- 対象はすべて Core が渡した候補 ID から選ばせ、モデルに外部 ID・アカウントを作らせません（10 §6A D15）。
- **send_mail の宛先はモデルの出力に含めません。** 返信元の候補（Reply-To / From。11 §6）か、画面で本人が確定します。誤った宛先の生成を契約で防ぐためです。
- 必須の不足は聞き返し、許可外の項目に値がある場合は意味検証の失敗（invalid_semantics）として区別します。label_mail は追加・削除の少なくとも一方、update_task の reschedule は due、memory_forget は対象 ID か検索語を必須にします。
- confidence は 0〜1 の数値のまま観測値として残し、認可・実行可否に使いません。
- 上位モデルを使う「しっかり考えて」の扱いは引数にせず、B10 のモデル振り分けで決めます。

`WireResponse` はローカルの完全検証用です。provider へ送る wire schema は、ここから pattern・format を除いた部分集合を adapter が作ります（修正案 P02 §4.2）。`WireResponse` には承認・effect_kind・実行経路・状態を表す項目がなく、未知の項目は拒否します。

## 実行可否の判定

`assessReadiness`（`packages/domain/src/readiness.ts`）は変更を伴う意図だけを対象にし、Read の意図では呼べません。

1. 入力が sealed でない、入力根拠が unverified、発話開始による一時保留、対象の未解決、根拠の未照合、許可版・方針版の変更のいずれかがあれば blocked。
2. 画面承認が必要か（承認が screen、または方針による自動を方針表が許さない）を決める。
3. 方式 C の入力で、方式 C 不可の意図か、画面承認が必要な場合は blocked（requires_full_text）。needs_approval へ昇格させない（10 §5A F01）。
4. 画面承認が必要なら needs_approval。安全停止中の自動実行は blocked（safety_stopped）。画面承認の操作は安全停止の影響を受けない（08 §9）。
5. それ以外は auto_eligible。これは 08 の最終検査へ進む資格で、送出の許可ではない。

`preview_only` は候補起点で対象が一意に決まらない場合の状態（11 §5A）で、B00-06 の関連解析とあわせて扱います。

## 操作の状態遷移

`packages/domain/src/operations.ts` に設計 08 §3・§4 の遷移を置きました。原本の表から次のように読み取っています。

- 自動実行は approved から始まる（awaiting_approval を通らない）。
- dispatching からは cancelled に進めない（送出境界の後は照合へ）。unknown_held から dispatching へは戻らない（自動再送しない）。
- not_executed から preparing へは、未実行が確定した同じ内容への本人の明示再試行だけ（新しい試行）。
- succeeded・cancelled・superseded は終端。

X01〜X11 の期待遷移は `packages/contracts/fixtures/operation-transitions.json` に手書きし、遷移表の範囲に収まることを試験で確認します。実行済みの試験記録ではありません。

## 構成上の判断

`Interpretation` は、設計 10 §6A の「判別共用体」を 24 個の分岐としては書かず、`intent` と共通の `IntentArgs` の組で表しました。U07 で引数を共通のフィールド群にしたため、分岐ごとの違いは必須・許可の項目だけになり、それを domain の意図表で検査します。意図ごとの分岐を schema に重ねると同じ定義が 24 回並び、意図表とずれる危険があるためです。この点は原本の表現からの変更なので、レビュー対象です。

domain は contracts の生成型を import しません。一括検証では型検査がビルドより前に走り、新しい clone では contracts の型定義ファイルがまだないためです。代わりに domain に意図名と引数名の一覧を持ち、schema の列挙と一致することを `scripts/domain.test.mjs` で検査します。依存の向きを変えたくなった時点で、ビルド順と合わせて見直します。

## 残ること

- LocalCommand / RemoteMutation の最終 transaction での再検査、WorkContext の共通検査、DB への記録は未実装です。
- OperationIntent はラベル変更（H01）だけです。他の操作の確定 intent は、それぞれの操作を実装する工程で追加します。
- 結果表示（ResultView）は B00-04（#19）で決めます。
