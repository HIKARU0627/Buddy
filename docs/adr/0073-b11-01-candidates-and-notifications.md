# ADR 0073: B11-01 気づき（候補）の記録・状態・保持・通知の重複

- 日付: 2026-11-03
- 状態: B11-01（親 #23）の契約と規則。保存・一覧の画面・OS 通知・抽出は未着手。実データは未実施。
- 根拠: 設計 11 §4（F05）、設計 04 気づきの作成／通知の重複と再通知、設計 08 §7、設計 10 §7、設計 09 X12・X35、QA12、ADR 0010。原本の参照手順は `docs/design/README.md`。
- 対象: `packages/contracts/schemas/buddy.schema.json` の `CandidateListResponse`・`CandidateStateCounts`・`CandidateEvidence`、`packages/domain/src/candidate.ts`、`packages/contracts/fixtures/candidate-cases.json`、`scripts/candidate.test.mjs`。

## 決めたこと

| 対象                    | 決定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 候補の記録              | 既存の `CandidateSnapshot`（候補 ID・由来の依頼・根拠の版・種類・`notification_key`・題・期限・初回取り込み・未読・関連解析・操作 ID）を再利用する。本文全体は持たず、表示用の抄録は 200 文字以内で暗号化して別に保存する                                                                                                                                                                                                                                                                                                                       |
| 一覧の応答              | `CandidateListResponse` は候補の配列・状態ごとの件数・次のカーソルだけを返す。本文・添付・件名の一覧を持たない。表示順は domain が決める                                                                                                                                                                                                                                                                                                                                                                                                        |
| 根拠の応答              | `CandidateEvidence` は候補 ID・依頼 ID と版・`SourceRef`（source_id・source_revision・引用・コードポイントの位置）・未読・抄録（200 文字以内）を返す。本文全体を複製しない                                                                                                                                                                                                                                                                                                                                                                      |
| 状態の遷移              | `new` は open→`seen`、act→`acted`、dismiss→`dismissed`、snooze→`snoozed`、resolve→`resolved`。`seen` と `snoozed` も同じ操作を受ける。`acted` は期限まで一覧に残り、resolve だけを受ける。時間による遷移として、`snoozed` のスヌーズ期限の到来は `snooze_elapsed` で `new` に戻し、`new`・`seen`・`acted`・`snoozed` の期限経過は `deadline_passed` で `resolved` にする。スヌーズの期限は Core が持ち、B11-02 で保存する。`dismissed` と `resolved` は終端（自動で戻さない）                                                                   |
| 保持                    | 活動中（new・seen・acted・snoozed）は期限を切らない。resolved・dismissed は状態が変わった時刻から **7 日**で抄録を消し、**97 日**（7＋90）に `notification_key` と状態を消す。識別子はその間だけ再通知の重複を防ぐために残す                                                                                                                                                                                                                                                                                                                    |
| 表示順                  | (1) 今日・明日の予定の重複、(2) 期限の近い順（期限不明は最後）、(3) 受信の新しい順。見出しは「今日」「明日」「今週」「それ以降」「期限不明」に分け、初回取り込みの過去の期限は「初回取り込み（過去の期限）」にまとめて折りたたむ。この順序は B11-02 の domain が持つ                                                                                                                                                                                                                                                                            |
| 未返信の断定            | メールの候補の行には常に「対応済みかは未確認」と出す。「未返信です」と断定しない。題は 60 文字以内にし、本文・件名・宛先をそのまま複製しない                                                                                                                                                                                                                                                                                                                                                                                                    |
| OS 通知の既定           | 端末がロック解除済みで、アプリが前面でないときだけ、音なしの OS 通知「新しい気づきが 1 件あります」を出す。件名・差出人・本文を含めない。ロック中は出さない。トレイ（macOS はメニューバー）に new の件数を出す。設定で OS 通知を OFF にできる。既定は ON（D4 の影モードとは別）                                                                                                                                                                                                                                                                 |
| 通知の重複              | `packages/domain/src/notification.ts` の `deliveryDecision` を再利用する。新規の候補だけが通知を作り、再取得・再接続・端末移動では新しい通知を作らない。本人が指定した再通知だけが別の `reminder_id` で一度出る。ACK を失った配信は `delivery_unknown` にし、自動で鳴らし直さない                                                                                                                                                                                                                                                               |
| 音声通知との分担        | 音声通知モード（B05、設計 10 §7）は本人が開始する別のモードで、この ADR の OS 通知とは別に扱う。同じ `notification_key` で二重に鳴らさないため、音声側も `deliveryDecision` の記録を共有する。音声で読み上げる文はコードの定型文だけにする（ADR 0005）                                                                                                                                                                                                                                                                                          |
| notification_key の構成 | 種類と対象を連結した文字列の SHA-256（64 桁の小文字 16 進）。メールは `kind`・`source_account_id`・`request_entity_id`・`request_revision`（依頼エンティティの版）・期限（または返信要否の解決結果）、予定の重複は `kind`・重複する予定 ID を昇順に並べたもの・重複する時間帯、調査は `kind`・workflow_id・完了の版。本文・件名・宛先・メールアドレスを材料にしない。同じ入力から同じキーを作り、候補の再取得で作り直さない（U176）。fixture の `notification_key_parts` は材料の構造だけを固定し、キーの生成そのものは B11-02 の試験で確かめる |

## 契約の形

- `CandidateSnapshot` は既存のまま使う。状態の列挙は `CANDIDATE_STATES` と同じにする。
- `CandidateListResponse` は `candidates`・`counts`（6 状態）・`next_cursor` を必須にし、`additionalProperties: false` で本文・添付・件名を拒否する。
- `CandidateEvidence` は `SourceRef` を再利用し、`excerpt` は 200 文字以内。`body`・`text` など本文全体の欄は持たない。
- 状態の遷移と保持の境界は `packages/domain/src/candidate.ts` の `candidateTransition`・`candidateRetention` が持つ。`scripts/candidate.test.mjs` が手書きの fixture と照合する。

## 原本に決めがない項目

- `notification_key` の作り方は設計 11 §4 に項目名だけで、材料が書かれていない。この ADR で材料を決めた（U176）。実装は B11-02・B11-03 で行う。
- OS 通知の既定（ON/OFF）は設計 04・11 に「設定で OFF にできる」とだけある。初期値を ON とし、D4 の影モード（既定 OFF）とは別に扱う。
- 音声通知との記録の共有方法は設計 10 §7 と 11 §4 に分かれて書かれている。同じ `notification_key` と `deliveryDecision` を使うところまでをこの ADR の範囲とし、音声側の実装は B05 に残す。

## 試験（模擬だけ）

- `pnpm run contracts:check`: `candidate-cases.json` の一覧・根拠の許可例・拒否例、OpenAPI 3.1.2 を検査した。
- `node --test scripts/candidate.test.mjs`: 状態の遷移、保持の境界（活動中・7 日・97 日）、一覧と根拠が本文を持たないこと、`notification_key` の材料を検査した。
- `node --test scripts/contract-gate.test.mjs`: 写しの契約ゲートに新しい fixture を加えた。

**模擬の期待値だけ**。保存・一覧の画面・OS 通知・実データ・実機は未実施で、合格扱いにしない。

## 残ること

- 表示順・状態・重複排除・予定の重複・根拠の失効は B11-02。
- 候補の保存と保持の掃除は B11-03。
- 候補の生成・一覧・根拠・状態変更は B11-04。
- 一覧・根拠・状態・OS 通知の画面は B11-05。
- 通知の識別子の生成と、音声通知との記録の共有は B11-02・B05 で実装する。
