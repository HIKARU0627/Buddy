# ADR 0075: B14-01 送信・予定の変更・参加者のいる予定・ごみ箱の契約

- 日付: 2026-11-14
- 状態: B14-01（親 #28）の契約と規則。connector の書込み・送出直前の照合・承認画面・保存は未着手。実データ・実機・実 API は未実施。
- 根拠: 設計 04 変更操作の表・再試行の初期値、設計 08 §1〜§4、設計 11 §6、設計 09 X01〜X11、ADR 0027・0031・0071・0074。
- 対象: `packages/contracts/schemas/buddy.schema.json` の `OperationKind`・`ApprovalRequiredOperationKind`・`MailSendOperationIntent`・`CalendarUpdateOperationIntent`・`CalendarCreateWithAttendeesOperationIntent`・`MailTrashOperationIntent`・`DispatchGuard`・`DispatchGuardRejection`、`packages/domain/src/connectors.ts` の `OPERATION_KINDS`・`OPERATION_STEP_KINDS`・`OPERATION_KIND_RULES`、`packages/domain/src/dispatch-guard.ts`、`packages/contracts/fixtures/approval-required-operations-cases.json`、`scripts/approval-required-operations.test.mjs`。

## 決めたこと

| 対象             | 決定                                                                                                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 操作の種類       | 既存の `mail.labels.change`・`mail.draft.create`・`task.create` に、`mail.send`・`calendar.event.update`・`calendar.event.create_with_attendees`・`mail.trash` を足す。語彙は作り直さず広げる（B13-01 の判断を保つ）                                            |
| 参加者のいる予定 | `calendar.event.create_with_attendees` を、送信・予定の変更・ごみ箱と別の種類にする。参加者が 1 人以上いるので、自分だけの予定の自動実行（`calendar.create_own`）とは別に毎回画面で承認する                                                                     |
| 完全削除         | 作らない。`mail.trash` は Gmail の trash・Outlook の deleteditems への移動だけで、完全削除・空にする操作の種類を持たない。fixture で語彙に無いことを確かめる                                                                                                    |
| 経路             | 4 種類とも RemoteMutation。LocalCommand は `task.create` だけのまま。書込みの自動再送は 0 回（ADR 0071 の能力宣言と同じ）                                                                                                                                       |
| 工程             | 4 種類とも 1 工程（`send_mail`・`update_event`・`create_event_with_attendees`・`trash_mail`）。下書き作成と送信を束ねる 2 工程は、既存の `mail.draft.create` と送信を同じ `operation_id` の中で扱う B14-02 の課題で、承認を工程の数だけ増やさない（設計 08 §4） |
| 照合の範囲       | 送信と参加者のいる予定の作成は `operation_marker`（送出前に作成物の ID が分からない）。予定の変更とごみ箱は `exact_target`（既存の対象 ID と版がある）                                                                                                          |
| 前提の確かめ方   | 4 種類とも `recheck_before_dispatch` だけを宣言する。条件付き要求を使えるかは connector ごとに B14-03 で決め、この ADR では能力を広げない                                                                                                                       |
| 宛先・内容の固定 | 宛先・CC・BCC・件名・本文・カレンダー・時刻・参加者・通知の有無を確定 intent に入れ、`content_hash` の対象にする。承認の後にアダプターが既定値を足さない                                                                                                        |
| 拒否の形式       | `DispatchGuard` は、この内容版への承認（取消の有無・内容版・hash・状態の版）、送出直前に読み直した対象の版、承認時に確かめた対象の版を持つ。未承認・取消済み・内容変更・宛先変更・対象変更・旧版を `DispatchGuardRejection` の語彙で表す                        |
| 結果不明         | 拒否の語彙に入れない。`unknown_held` として保留し、自動で再送しない。一定時間の未発見を未送信の証拠にしない（ADR 0027・0071）                                                                                                                                   |
| 取り消し         | ごみ箱への移動は元の場所へ戻す補償操作として扱い、B13-01 の 30 日・`UndoTarget` の規則を使う。送信は取り消せないため、補償の対象にしない                                                                                                                        |
| 宛先の重複       | 同じ相手を to・cc・bcc に重ねない。`effects.external_recipients` は実際の宛先の集合と一致させる。外部の相手に届く操作で空にしない（ごみ箱は空）                                                                                                                 |

## 原本に決めがない項目

- 送信・予定の変更・ごみ箱で条件付き要求を使うかは、サービスごとの版の提供に依存するため、この ADR では `recheck_before_dispatch` に限った（U181）。
- 参加者のいる予定の作成で、参加者を to と同じ「外部の宛先」として数える範囲（通知を送らない場合を含む）は、承認画面の表示と合わせて B14-04 で決める（U182）。

## 契約の形

- 4 種類の intent は `buddy.operation.v1` を使い、`action.kind` を種類ごとの const にする。`OperationIntent` の oneOf に加え、一般形でも解決できることを `contracts:check` が確かめる。
- `DispatchGuard.operation_kind` は `ApprovalRequiredOperationKind` に限る。ラベル・下書き・用事は既存の承認の経路を使う。
- `dispatchGuardReasons` は、未承認 → 取消 → 内容 → 版 → 宛先・対象の順で理由を返す。参加者のいる予定の作成だけは対象を持たないので、対象の欠落を拒否にしない。
- 参加者のいる予定の作成は `target` を null 固定にする。既存の対象を持たないことを型で表す。

## 試験（模擬だけ）

- `pnpm run contracts:check`: `approval-required-operations-cases.json` の許可例・拒否例、`OperationIntent` の解決、OpenAPI 3.1.2 を検査した。
- `node --test scripts/approval-required-operations.test.mjs`: 4 種類の語彙・経路・工程・照合の範囲、完全削除が無いこと、宛先の重複と効果の不一致、未承認・取消済み・内容変更・宛先変更・対象変更・旧版の拒否を検査した。
- `node --test scripts/operation-kinds.test.mjs`: 語彙と intent の oneOf・照合の範囲の一致を 7 種類で検査した。

**模擬の期待値だけ**。connector の書込み・送出直前の照合・承認画面・保存・実データ・実機・実 API は未実施で、合格扱いにしない。

## 残ること

- connector の書込みと 2 工程（下書き → 送信）は B14-02。
- 送出直前の照合の実行と `unknown_held` の保留は B14-03。
- 承認画面（宛先・参加者の確認）は B14-04。
- 結果の表示と取消の案内は B14-05。
- 実アカウントでの有効化は T02・T03 の模擬合格と本人の承認の後（B15）。
