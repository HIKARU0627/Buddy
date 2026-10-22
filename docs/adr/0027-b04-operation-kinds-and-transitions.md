# ADR 0027: 下書き・用事の intent、内容版の更新、LocalCommand の遷移、connector の能力と工程の型

- 日付: 2026-10-22
- 状態: B04-01（#81）の判断と実装。契約（JSON Schema・OpenAPI・生成型・合成例・hash の期待値）と domain の規則を足した。製品の経路（Core の保存・送出・照合）・模擬 provider・画面は対象外（B04-02〜05）。試験は契約と domain の単体の試験だけで、模擬サービス・実機・実 API・実請求の試験は未実施。
- 根拠: Issue #81 の要約と本人の判断 D1〜D6（2026-10-22）、ADR 0004・0009・0010・0018・0019・0023。設計本文（06 B04、07 §1〜3、08 §1〜4、09 §1〜5）は今回の作業環境に取得できず、Issue と ADR の要約に基づく。原本との照合はレビューで行う。

## 決めたこと

| 対象              | 決定                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 確定 intent       | `OperationIntent` を `oneOf` で `LabelOperationIntent`（mail.labels.change）・`DraftReplyOperationIntent`（mail.draft.create）・`TaskOperationIntent`（task.create）に広げた。どれも `schema: buddy.operation.v1`・`operation_id`・`content_version`・`permission_revision`・`target`・`action`・`effects` を持ち、content_hash はこの全体の JCS＋SHA-256（ADR 0003）                                                                                                     |
| 返信の下書き      | RemoteMutation。`target` は返信元のメール（remote_id・source_revision）。`action` は `to`（1 件以上）・`cc`・`subject`・`body`。宛先は返信元から Core が決め、モデルに作らせない（ADR 0004）。下書きは送らないので `effects.external_recipients` は空。照合の範囲は `operation_marker`。宛先と CC の重複は意味検査で `duplicate_recipient`。用事の期限が地域日時なら、実在の日時かを意味検査で確かめる（`invalid_local_datetime`）                                        |
| 用事の登録        | LocalCommand。`provider`・`account_id` を持たない。`target.list_id` は登録先の一覧、`action` は `title`・`due`（日付または地域日時、または null）・`body`（または null）。照合の範囲は `local_transaction`                                                                                                                                                                                                                                                                |
| preview と表示    | `LabelPreview` を `OperationPreview`（intent は `OperationIntent`）に一般化した。`OperationSnapshot` に `operation_kind`（`OperationKind` = 3 種類の action.kind）を必須で足した。Core は `operations.kind` をそのまま出す（storage の照会に `operation_kind` を足した）                                                                                                                                                                                                  |
| 遷移（D1）        | 内容版の更新は同じ operation_id で content_version を上げ、`awaiting_approval` に戻る。更新できるのは `awaiting_approval`（自分自身への遷移）・`approved`・`preparing`・`not_executed` だけ。送出境界を越えた状態（dispatching・reconciling・unknown_held）と終端では更新しない。旧版の有効な承認は revoked、実行中の試行は superseded（domain の `planContentRevision`）                                                                                                 |
| 遷移（D5）        | `approved → succeeded` は LocalCommand だけに許す（`ROUTE_ONLY_TRANSITIONS`）。`canTransition(from, to, route)` は経路を渡さなければ共通の遷移だけを許す（経路が分からない呼び出しには近道を許さない）                                                                                                                                                                                                                                                                    |
| 操作の種類の規則  | domain の `OPERATION_KIND_RULES` が種類ごとに経路・照合の範囲・lookup 方式・lookup に要る読み取り・許す precondition・工程を持つ。経路は意図表（ADR 0004）と一致させる                                                                                                                                                                                                                                                                                                    |
| connector の能力  | `ConnectorCapability { provider, reads[], writes[] }`。書込みは `action_kind`・`effect_kind: 'RemoteMutation'`・`automatic_http_retries: 0`・`precondition`・`lookup`・`reconcile_scope`・`steps`。`checkConnectorCapability` が規則との食い違い・自動再送・LocalCommand の書込み・lookup に要る読み取りの欠け・送出の直前の読み直し（`recheck_before_dispatch`）に要る読み取り（前提の対象と `permission`。`preconditionReads`）の欠け・重複を `action_kind:理由` で返す |
| 照合（D4 の一部） | 照合は参照だけ。`found` だけを成功の証拠にし、`not_found`（遅れて適用されうる、X08）・`multiple`・`unreadable` は unknown_held に留める。照合だけで not_executed にしない。自動の照合は応答を失った直後の 1 回（`AUTO_RECONCILE_LIMIT`）。作成物の目印は `buddy-op:<operation_id>:<content_version>`（試行 ID を含めない）                                                                                                                                                |
| 工程（D3）        | `operation_steps` の行（step_id・step_kind・dispatch_intent_at・result_status・external_id）から工程の状態を決め、`nextStepDecision` が「送出・照合・完了・停止」を返す。前の工程が成功で確定するまで次へ進まず、送出意図を保存した工程は再送せず照合する。工程 ID は `<位置>-<種類>`（例: 1-create_draft）。X10 の合格は B14                                                                                                                                             |

## 遷移表の変更の理由

- 旧来は「内容が変われば旧版の操作を superseded にし、次の版を新しく作る」（X03・X09 の `next_version`）だった。D1 で同じ operation_id のまま内容版を上げる方式にしたため、操作の状態は `awaiting_approval` へ戻る。版ごとの承認と試行は DB の版の行（operation_versions・approvals・operation_attempts）で区別でき、「一つの内容版に有効な承認は一つ」（0001 の `approvals_one_effective`）も変わらない。
- `superseded` は操作を別の操作で置き換えるとき（種類や口座が変わる訂正など）のために遷移表に残した。
- D5 の近道を共通の表に入れると、経路を知らない呼び出し（今の storage の `canTransition(from, to)`）が RemoteMutation にも許してしまうので、経路だけの表に分けた。

## fixture の変更

- `operation-transitions.json`: X03 を `awaiting_approval → awaiting_approval`（内容版 1 → 2、旧版に承認・試行なし）、X09 を `… → preparing → awaiting_approval`（旧版の承認 revoked・試行 superseded）に直した。承認の後の内容変更（`X03-after-approval`、承認 2 件のうち 1 件失効、外部変更 1 回）と LocalCommand（`D5-local-command`、外部変更 0 回・transaction 1 回）を足した。`approvals` の意味を「記録された承認の件数（失効した旧版を含む）」と明記し、失効した件数を `revoked_approvals` に分けた（従来の例では両者が同じなので、既存の試験の期待値は変わらない）。
- `tests/integration/fault-points.json`: X03・X09 の `core_final_state` を superseded から `awaiting_approval` に手で直し、`content_version_after: "2"` と理由の注記を足した。外部変更・承認の回数は変えていない。時計を設計 09 §2 の `2026-10-05T09:00:00+09:00` に直した（#82 の模擬 provider の報告。証拠の例の `observed_at` も合わせた）。
- `content-hash-cases.json`: 下書き 6 件・用事 5 件を足した。入力はキー順を逆にし、期待値の正規形は Python の `json.dumps`（キーの並べ替え・空白なし・非 ASCII のまま。値は文字列・配列・null だけなので RFC 8785 と一致）、SHA-256 は Python の `hashlib` で計算し、基準の 2 件は `shasum` でも照合した。検査対象の canonicalize と node:crypto では作っていない。

## 試験

- 契約: `schema-cases.json` に正常 7 件・拒否 12 件（送り先のある下書き・宛先なし・空の本文・照合の範囲の違い・知らない種類・余分な項目・body の省略・用事の provider・時差付きの期限・空の題名など）。`common-contracts.test.mjs` で、新しい intent ごとにキー順を入れ替えても同じ hash、本文・宛先・対象・許可版・内容版で違う hash を手書きの期待値で確かめる。
- domain: `operation-kinds.test.mjs`（6 件）で D1・D5・connector の能力の検査・照合・工程を、`domain.test.mjs` で fixture の経路が経路ごとの遷移表に収まることと内容版の上がり方を確かめる。

- レビュー（PR #88、Codex の P2 2 件）の後: 読み直しに要る読み取りの検査と、用事の期限の意味検査を足した。`schema-cases.json` に、形は正しいが意味検査で拒否する例を `semantic_errors`（期待する理由を手書き）で書けるようにし、intent と preview の存在しない期限（`2030-02-31T25:61`）を足した。

## 読み取り（レビュー対象）

- 用事の `target.list_id` と `permission_revision`（Buddy 内の用事の保存先の許可の版）は、完了条件の「対象・許可の版で違う hash」を満たすために置いた。原本に用事の intent の形があれば合わせる。
- 下書きの照合の範囲を `operation_marker` とした（作成物の対象 ID は送出前に分からないため）。#82 の仮の型は書込みすべてを `exact_target` としている。
- 送信（mail.draft.send）は操作の種類に入れていない（D3 で工程 `send` の仕組みだけを作り、送信の種類は B14）。
- LocalCommand に preparing・dispatching の経路を禁じてはいない（D5 は近道を許すだけ）。

## 残ること

- storage: 試行の状態に `superseded` がない（0001 の CHECK）。D1 の適用（旧版の承認の失効・試行の置換・新しい版の保存を一つの transaction で）と、LocalCommand の成功（試行の `dispatch_intent_at` の CHECK）は B04-03・04 でマイグレーションと命令を足す。storage の `canTransition` の呼び出しに経路を渡すのも同じとき。
- 模擬 provider（#82）の仮の能力の型を domain の `ConnectorCapability` に差し替える。
