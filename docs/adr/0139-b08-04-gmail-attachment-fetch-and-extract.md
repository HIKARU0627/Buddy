# ADR 0139: B08-04 Gmail 添付の取得と抽出（attachments.get・テキスト／PDF の抽出・抽出入力への写し）

- 日付: 2026-11-23
- 状態: B08-04（親 #16）。connector の添付取得、添付パートの列挙、Core の取得・抽出手続きと模擬試験まで。実 API・実アカウントは未実施（B15 と本人の承認）。解析計画が保存済みメールから抽出入力を組み立てる配線は B10・B11 の後続処理（本文の組み立ても同じ持ち越しで、本 ADR の対象外）。
- 根拠: 設計 04 取得する対象（J16: 添付は本人が選んだ種類だけ、初期値は PDF とテキスト系、1 件 10MB まで。選択した種類・サイズの添付だけを attachments.get で取得し、PC 内でテキストを抽出してから必要部分を LLM へ渡す。RAW 全体取得は使わない。選択外は最小限のメタデータだけ）、設計 11 §1・§2（対象添付が未取得・読取失敗・切り詰めなら条件Bは未確定）・§3（根拠の対応付け、添付は取得済みの許可対象の ID だけを使う、添付の抽出テキストは最大 2,000 トークン）、ADR 0071・0086（取得範囲の検査の正本は domain の fetch-scope）・0087（契約の上限）・0133（添付の取得と抽出は B08-04）・0136（添付の取得と抽出は B08-04）、本人の決定 D5。
- 対象: `packages/connectors/src/adapter/google-gmail.ts`（getAttachment・listAttachmentParts・decodeBase64Url）、`packages/connectors/src/index.ts` の出口、`packages/connectors/src/google-connector.test.ts`、`apps/core/src/mail-attachments.ts`、`apps/core/src/mail-attachments.test.ts`、`apps/core/package.json` と `pnpm-lock.yaml`（unpdf 2.2.1 を正確な版で追加）。

## 在庫確認（済んでいたもの）

- 取得可否の規則は B08-02 の domain（`classifyAttachment`・`checkAttachment`）で完成していた。MIME と拡張子の両方で種類を決め、食い違い・対象外は取らない側に倒し、サイズ不明は取らず、上限は 10,000,000 バイト（U205）。
- Gmail の payload の構造化は B08-03 で済んでいた。添付パートのファイル名・MIME・申告サイズ・attachmentId・インラインのデータ（body.data）を保持している。
- 抽出入力の受け口は B10-05 で定義済み（`MailAttachmentInput`: extracted／unread／failed、permitted、source_revision。組立て側が添付を最大 2,000 トークンに切り詰める）。
- 能力宣言は変えていない。添付の取得は messages の読み取りの一部で、`GOOGLE_READ_CAPABILITY` の `mail.message` に含まれる（新しい読み取り種別は足さない）。

## 決めたこと

| 対象             | 決定                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 添付の取得       | connector に `getAttachment`（messages.attachments.get）を足す。応答の `size` と base64url の `data` を検証し、復号したバイト数と申告サイズが一致しない応答は `invalid_response` で拒否する。base64url の復号は厳密にする（余分な文字を受け付けず、符号化し直して一致するものだけを通す）。再試行・トークンの扱いは B08-03 の土台のまま                                                                                |
| 添付パートの列挙 | connector に `listAttachmentParts` を足す。ファイル名が空でないパートを添付とし、その内側はたどらない（添付されたメールの中の添付を、このメールの添付として扱わない）。ファイル名を持たない multipart はたどるだけ。並びは出現順。取得可否の判定はここではしない（domain が正本）                                                                                                                                      |
| 取得の手続き     | Core に `createMailAttachmentLoader`（`apps/core/src/mail-attachments.ts`）を新設する。接続の保存済みの取得範囲（FetchScope）を受け、パートごとに `checkAttachment` を通し、通ったものだけを取得する。範囲外は取得せず `permitted: false`・`unread` で返し、未読にも数えさせない。取得は出現順に 1 件ずつ（並列にしない）                                                                                              |
| 取得の経路       | format=full でインラインのデータ（body.data）が届いている添付はそれを使い、無いものは attachments.get で取る。インラインのデータは申告サイズ（0 でない場合）と実物が一致するときだけ使う。どちらの経路でも、実物が取得範囲のサイズ上限を超えていたら使わず failed にする（申告サイズの過小申告で上限をすり抜けさせない）                                                                                               |
| テキストの抽出   | 種類が text のものはバイト列をテキストへ復号する。charset はパートの Content-Type ヘッダーの宣言に従い（既定は UTF-8、Shift_JIS 等も TextDecoder のラベルで扱う）、対応できないラベルや不正なバイト列は化けた文を「抽出できた」とせず failed にする。先頭の BOM は落とす。設計に charset の指定は無いため、この扱いを本 ADR で決める                                                                                   |
| PDF の抽出       | 種類が pdf のものは unpdf（pdfjs の Node 向けラッパー、MIT）でテキストを抽出する。設計に抽出器の指定は無いため本 ADR で選定する。テキストが取れない PDF（画像だけ・暗号化など）は未読（failed）にする（設計 11 §2 の「読取失敗なら条件Bは未確定」に倒す）。unpdf の配布型は DOM の型を前提にするため、静的な import はせず実行時にだけ読み込み、狭い局所インターフェースで扱う（skipLibCheck: false の方針を変えない） |
| 失敗の写し       | 取得・抽出に失敗した許可対象は `failed`（source_revision はメッセージの版）にする。失敗を「読めた・期限なし」にしない。失敗の理由（通信・形式・抽出）は抽出入力の形に欄が無いため持たない                                                                                                                                                                                                                              |
| 添付 ID と版     | 抽出入力の attachment_id はパートの partId（無い場合は出現順の `attachment-<番号>`）、source_revision は件名・本文と同じメッセージの版を使う（設計 11 §3 の根拠の対応付け）                                                                                                                                                                                                                                            |
| 保存しない       | 添付のバイト列と抽出テキストはこの手続きでは保存しない。保存層に添付の置き場所は無く（source_items の body_blob_id は本文用）、設計も「取得→PC 内で抽出→必要部分を LLM へ」の流れで永続化を指定していない。抽出テキストの保持は抽出結果のキャッシュ・抄録の規則（設計 11 §3）に従う                                                                                                                                    |
| MIME の補完      | パートの mimeType が空のときだけ、Content-Type ヘッダーの種類部分で補って分類する（分類の規則そのものは domain のまま）                                                                                                                                                                                                                                                                                                |

## 試験（模擬だけ）

- `packages/connectors/dist/google-connector.test.js`: 32/32 合格（既存 26＋新規 6）。attachments.get の URL と復号、申告サイズと実物の不一致・base64url でない data・data 欠落と負の size の拒否（いずれも invalid_response）、添付パートの列挙（出現順、添付メールの内側をたどらない、Content-Type の保持、添付なしは空）。期待値は手書き（"%PDF" の 4 バイトなど）。
- `apps/core/dist/mail-attachments.test.js`: 15/15 合格。許可したテキストの取得と抽出、インラインのデータの利用、Shift_JIS の復号、不正な UTF-8 の failed、取得失敗の failed、画像・上限超過（10,000,001 は取らず 10,000,000 ちょうどは取る）・実物だけが上限を超える場合の不使用、実行ファイルを PDF と偽る添付の範囲外、選択していない種類の不取得、partId が無い場合の ID、添付なしは空、unpdf の実抽出（手で組み立てた最小の PDF から書いた 2 行が取れること）、テキストが取れない・抽出が失敗する PDF の failed、Content-Type から種類を補う PDF の抽出。
- 全体試験は CI と同じ 4 シャードを逐次実行し、合計 3,383 件中 3,380 件合格・失敗 1 件・取消 2 件。失敗と取消はシャード 1 の live-conversation（X51/QA05・X58、負荷時のタイムアウトで知られるフレーク）で、単独再実行では同ファイル 80/80 合格と切り分け済み。本変更に起因する失敗は無い。
- 静的検査: build・typecheck・lint・format:check・contracts:check（1270 fixtures）・design:check（4 snapshots）・security:check（981 files）すべて合格。design:check と security:check は、作業コピーに無い `.local` の設計原本（メインクローンから複写）と一時的な git 初期化を使って実行した。
- 実 API・実アカウント・実データは未実施。模擬の成功を実 API の合格として扱わない。`tests/test-map.json` は変えていない（X62 は B10・B13 の契約 fixture で、本変更は実 API の証拠ではない）。

## 残ること

- 解析計画が保存済みメール（source_items）から抽出入力を組み立てる配線は B10・B11 の後続処理。本文（body）の組み立ても同じ持ち越しで、この loader はそのときに件名・本文と一緒に呼ばれる想定の部品として置く。
- Outlook（Graph）の添付の取得と抽出は B09-03（Graph 側の取得 API と分類の共有が要る）。
- PDF の抽出品質は PDF 側の ToUnicode の有無に依存する（埋め込みの無い CID フォント等では正しい文が取れないことがある）。実測は B15。暗号化された PDF は未読（failed）になる。
- 取得範囲の変更（種類・サイズの狭め方）の保存と画面は B08-02 P2/P3・B09-05 の範囲で、本 ADR では保存済みの範囲を受けるだけ。
