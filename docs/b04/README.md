# B04 の完了判定

B04（#14）の文字入力から一度だけ変更する縦断試作と、B04-06（#86）・B04-07（#106）の統合試験を記録します。**B04-07 で QA27 の外部の下書きの保存（RemoteMutation）を実装し、親 Issue の完了条件 4 項目は模擬の範囲ですべて確認できました。** 実機・実 API・実請求・本物の OS 確認ダイアログは未実施で、B04 の完了をこの模擬の範囲で判定するか（実機の確認を待つか）は本人の判断です。

根拠は設計 06 の B04、09 §1〜5・QA27・QA28・§8、08 §1〜4、07 §1〜4、01 の承認画面と状態表示、本人の判断 D1〜D6（2026-10-22）。今回、権限のある接続で原本本文を確認し、取得資料は非公開の `.local/design/notion/` に置きました。更新履歴の旧例は仕様に用いていません。D1〜D6 と既存 ADR の判断は変更していません。

## 子 Issue と範囲

| 工程   | Issue | 内容・根拠                                                                                                           |
| ------ | ----- | -------------------------------------------------------------------------------------------------------------------- |
| B04-01 | #81   | intent・内容版・経路・工程の型（[ADR 0027](../adr/0027-b04-operation-kinds-and-transitions.md)）                     |
| B04-02 | #82   | 独立した模擬 provider・故障注入・アダプター（[ADR 0028](../adr/0028-b04-mock-provider.md)）                          |
| B04-03 | #83   | 発言・意味検査・preview・承認待ち（[ADR 0029](../adr/0029-b04-turns-interpretation-and-preview.md)）                 |
| B04-04 | #84   | 一度だけの送出・照合・LocalCommand・再起動（[ADR 0030](../adr/0030-b04-runner-dispatch-reconcile-local-command.md)） |
| B04-05 | #85   | 会話・確認・処理状況、main の確認ダイアログ（[ADR 0031](../adr/0031-b04-desktop-conversation-approval-screen.md)）   |
| B04-06 | #86   | 下記の実行器・模擬証拠・対応表・実機手順                                                                             |
| B04-07 | #106  | 外部の下書きの保存と QA27 の 3 経路・権限・期限（[ADR 0033](../adr/0033-b04-draft-save-and-qa27-paths.md)）          |

先行実装にはそれぞれの契約・単体・模擬統合試験があります。実行器は既存の Core 試験装置を `operation-runner-test-support.ts` に取り出して再利用しています。製品の動作は変更せず、runner のコメントを B04-07 の範囲記述にそろえています。

## 親 Issue の完了条件 4 項目

| #   | 完了条件                                                                                | 対応する試験と観測                                                                                                                                                                                                                                                                                                                                                   | 判定の範囲                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2 端末で同じ候補を見て、一度の承認で変更が 1 回                                         | 実行器の X02: 2 個の製品クライアントを TLS/WSS で接続し、同じ操作 ID・内容版・hash を確認。関門にそろえた承認と二度押しでも承認 1 件・受信 1 回・変更 1 回。両端末が成功へ収束                                                                                                                                                                                       | 模擬。画面側は既存 `two-clients.test.ts` の「A の発言から B の確認で完了」の試験（LocalCommand、main の OS 確認は模擬）も通す。実際の OS ダイアログと別のマシンは未実施                     |
| 2   | 二重操作・ACK 喪失・再起動でも重複変更しない                                            | X01・X02・X04・X06・X07・X08・X11、QA28。provider の受信 ID・試行 ID・工程・回数と、DB の状態履歴・承認・試行・outbox を突き合わせる                                                                                                                                                                                                                                 | 模擬。X01 は完了後と preparing 中、X06 は送出意図の後の中枢だけの再起動。QA28 は DB worker の COMMIT 後の異常終了                                                                           |
| 3   | 結果不明を成功とせず、自動再送しない                                                    | X05-after-dispatch は取消の受付だけで reconciling。X06 は受信 0 でも unknown_held。X07 は応答喪失後の自動照合 1 回。X08 は遅延適用前も後も保留し、本人の参照照合で成功。下書きの保存も同じ規則（`-draft` の 4 ケース、照合は目印）                                                                                                                                   | 模擬。unknown_held の再開要求や再起動で書込みを増やさない。一定時間の未発見を未実行の証明にしない                                                                                           |
| 4   | Read は変更承認なし、LocalCommand は外部 HTTP なし、RemoteMutation だけが送出境界を使う | QA27-read: 予定参照で操作・承認・試行 0。QA27-local: 用事 1 件、発言の受付から完了までアダプター呼出し（読み取りを含む）0。QA27-remote: 外部の下書きの保存だけに preparing・dispatching と工程 `1-create_draft` の送出意図、下書きの内容と hash を手書きの値と照合。QA27-auth・QA27-expiry: 全経路で失効した端末は 401、接続範囲の期限切れは 410、何も作らず送らない | 模擬。同じ画面からの 3 経路は `two-clients.test.ts`（デスクトップの main の部品と実際の Core の HTTPS、OS の確認は模擬）で別に確認。Electron の画面の操作と本物の OS 確認ダイアログは未実施 |

## ケース別の結果

要求は provider の書込み受信数、変更は provider 自身の状態変更数、承認は失効した旧版を含む DB の保存件数です。Read の HTTP を書込み要求に数えません。

| ケース                                | 要求 / 変更 / 承認         | 最終状態・確認した境界                                                                                                                                                          |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X01                                   | 1 / 1 / 1                  | succeeded。完了後／preparing 中の再起動、DB 世代と操作の維持・起動 ID の更新                                                                                                    |
| X02                                   | 1 / 1 / 1                  | succeeded。同時承認の関門、2 端末、二度押し、承認の順序変更                                                                                                                     |
| X03                                   | 0 / 0 / 0                  | awaiting_approval・内容版 2。キー順だけなら同じ hash、ラベル変更・古い preview・不正 JSON                                                                                       |
| X04                                   | 0 / 0 / 0                  | awaiting_approval。request_id の別内容は 409、再起動前の scope は 410。操作を追加しない                                                                                         |
| X05-before-dispatch                   | 0 / 0 / 1                  | cancelled。対象再確認の関門で取消を確定                                                                                                                                         |
| X05-after-dispatch                    | 1 / 1 / 1                  | reconciling。取消は受付だけ、工程の成功は本人の照合まで未確定                                                                                                                   |
| X06                                   | 0 / 0 / 1                  | unknown_held。送出意図後・送信前の停止、繰り返し再起動でも再送 0                                                                                                                |
| X07                                   | 1 / 1 / 1                  | succeeded。応答だけ喪失、正確な対象の自動照合 1 回                                                                                                                              |
| X08                                   | 1 / 1 / 1                  | unknown_held → 本人の照合 → succeeded。時間切れは AbortSignal の関門で作る。遅延適用後も自動照合・再送なし                                                                      |
| X09                                   | 0 / 0 / 1                  | awaiting_approval・内容版 2。対象 r2 と許可失効を別に注入。承認 revoked・試行 superseded                                                                                        |
| X10-after-draft / after-send-accepted | 各 0 / 0 / 1（仕組みだけ） | 送出意図と unknown_held の工程が保存され、再起動後は該当工程の照合判断。実際の下書き作成・送信は実行していない                                                                  |
| X11                                   | 1 / 1 / 1                  | succeeded。snapshot と購読の隙間の更新、イベント受領情報の喪失、中枢再起動、再配信・重複・逆順でも状態版 6                                                                      |
| X05-after-dispatch-draft              | 1 / 1 / 1                  | reconciling。下書きの保存の後の取消は受付だけ。目印 `buddy-op:<操作 ID>:1` の下書き 1 件                                                                                        |
| X06-draft                             | 0 / 0 / 1                  | unknown_held。送出意図の後・送る前の停止と再起動で、下書きの保存の再送 0                                                                                                        |
| X07-draft                             | 1 / 1 / 1                  | succeeded。応答だけ喪失、目印での自動照合 1 回                                                                                                                                  |
| X08-draft                             | 1 / 1 / 1                  | unknown_held → 本人の照合 → succeeded。遅れた保存の後も自動照合・再送なし                                                                                                       |
| QA27-read / local / remote            | 0/0/0、0/0/1、1/1/1        | 前表の経路分離。remote は外部の下書きの保存（宛先・件名・本文・返信元・目印・確定 intent の hash を手書きの値と照合）                                                           |
| QA27-auth / expiry                    | 各 0 / 0 / 0               | 用事と下書きの操作を作って preview を出した後、失効した端末（401）・期限切れの接続範囲（410）で 3 種の発言と 2 種の承認を拒否。予定の読み取りの範囲がなければ Read も聞き返す   |
| QA28                                  | 0 / 0 / 1                  | succeeded。文字入力と画面経路の承認後、適用 COMMIT 直後に worker を終了。ACK は unknown、同じ command_id は保存済み receipt、内容違いは拒否。用事・試行・成功イベントは増えない |

## 実行器と証拠

```sh
pnpm run build
node --test tests/integration/b04.test.mjs
node scripts/clean.mjs && pnpm run check
pnpm run contracts:check
```

2026-10-23 のローカル検証（B04-07 の PR #107 のレビュー修正・main 取り込み後のソースを再ビルドして実行）:

| 検証                                         | 結果                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| `node scripts/clean.mjs && pnpm run check`   | 成功、933 件・失敗 0。書式・lint・ビルド・型・契約・公開情報検査を含む          |
| `pnpm run contracts:check`                   | 成功。生成型の直接変更なし                                                      |
| `node --test tests/integration/b04.test.mjs` | 69 回の観測が期待値に一致（親試験を含む 70 件）。範囲は本書のケース別表のとおり |

`pnpm test` / `pnpm run check` は実行器を自動で含みます。23 ケースを seed `86, 1406, 20261022` で並べ替えて 3 回、計 69 回実行します。node:test の親試験を含めると 70 件です。seed は順序だけを固定し、鍵・資格情報・ID の乱数は固定しません。

- 期待値は [fault-points.json](../../tests/integration/fault-points.json) に手書きします。状態履歴は既存の手書き `operation-transitions.json` と整合検査します。合成入力から手で決めた対象・追加/削除ラベル・最終ラベル集合を provider の `applied_change` と真の状態にも照合します。実装の送出引数や遷移判定から期待結果を作りません。
- 試験用の `b04_history` と trigger を合成 DB にだけ追加し、同じ transaction で状態版・内容版・状態を記録します。Core の結果を読んだ時点の標本だけでは中間状態を落とすためです。期待値や provider の真の結果を Core へ渡しません。
- `FaultInjector` の pause・barrier・waitReached と `runner.idle()`、クライアントの状態通知で同期します。固定 sleep で競合を作りません。上限 timeout は失敗検出用です。イベント待機は時間切れ・試験終了・条件の例外でも停止し、時間切れと試験終了後に子プロセスが自然終了することを回帰試験で確認します。
- Core と provider は別のデータディレクトリを使用します。中枢だけを止め、同じ provider オブジェクトと記録を保ちます。これは同じプロセス内の停止・再起動であり、OS の電源断や実機試験ではありません。
- X11 の「ACK 喪失」はイベントを transport までは届け、クライアントの cursor に反映する直前で止める模擬です。存在しない WSS ACK API を呼んだ試験ではありません。再接続後に実際に再配信されたイベントを使います。
- 下書きの保存のケース（`operation: draft_reply`）は、provider の真の下書きの宛先・件名・本文・返信元・目印を `provider_drafts` の手書きの値と照合します。目印の `{operation_id}` だけをその試行の操作 ID に置き換えます。QA27-remote は確定 intent の hash も、手書きの正規形（`content_canonical`）の SHA-256 と照合します。証拠には下書きの本文を載せません（目印と状態だけ）。
- X10 は `b04_expected` だけを検査します。ラベル操作を工程保存の試験用の容器にし、工程 ID を DB 命令へ渡します。send の先行工程成功は合成入力です。2 工程を完走した証拠ではありません。元の `expected`（下書き 1・送信 1・承認 1・成功）は B14 用のまま残します。

記録は [evidence-b04-simulated.json](../../tests/integration/evidence-b04-simulated.json)、実施状態は [test-map.json](../../tests/test-map.json) です。`kind: simulated` を証拠 Schema に追加し、旧 `mock_service` は既存例の互換用に残しました。X10 は `B04-x10-…-mechanism` の記録で、X10 全体の合格記録を作りません。QA27 は 5 ケース（read・local・remote・auth・expiry）を記録し、対応表は `simulated`（範囲は `product_scope`）です。

証拠の `records` はケース別の結果、`runs` は各 seed の実際の順序・状態履歴・provider 受信 ID・適用内容・真のラベル集合と工程・承認と試行です。`commit` は実行時の基点コミットです。未コミット差分を含む検査対象を特定するため、`source_sha256` にソース・fixture・検証スクリプトの内容 hash を併記しています。`scripts/test-map.test.mjs` が現行ソースの対象一覧と hash の完全一致を検査し、変更・追加・削除・証拠の欠落を拒否します。これを基点コミットだけの試験結果と読み替えないでください。公開文書・秘密・鍵・トークン・メール本文は観測へ含めません。

`source_sha256` の対象の決め方（[scripts/b04-evidence-sources.mjs](../../scripts/b04-evidence-sources.mjs)、B04-07 で絞った）:

- 対象は、B04 の実行器（`tests/integration/b04*.mjs`）が実際に読み込んで動かすファイルと、期待値・fixture だけです。以前は `apps`・`packages`・`scripts`・`tests` の全ファイル（約 350 件）で、画面など B04 と関係のない変更でも証拠を作り直す必要があり、PR 同士の衝突も起きていました。
- 対象は機械的に集めます。入口の `tests/integration/b04*.mjs` から、`import`・`export … from`・文字列の動的 `import()`・`new URL('…', import.meta.url)`・`import.meta.resolve('…')` を辿ります。`import type` / `export type` だけの文は実行されないので辿りません。`dist` を指す参照は同じワークスペースの `src` へ、`@buddy/*` は各 `package.json` の `exports` で解決し、解決に使った `package.json` も対象に含めます（参照先の差し替えも検出する）。ディレクトリの参照（SQL のマイグレーション）は中のファイルを含め、説明文（`.md`）は除きます。
- `node:` の組み込みと外部の依存（node_modules・pnpm-lock.yaml）は含めません。実行器が読まないが期待値の整合に使う状態の遷移表（`packages/contracts/fixtures/operation-transitions.json`）は、明示して含めます（`EXTRA_FILES`）。
- 2026-10-23 時点で 126 件です（B07-02 で domain の index から読み込む `packages/domain/src/budget-rules.ts` が、UI-06 で配置のエンジン `packages/domain/src/canvas-layout.ts` が加わった）。デスクトップの画面（`apps/desktop/src/renderer/`）や、実行器が読まない main の部品は対象外です。`scripts/test-map.test.mjs` が、対象外のファイルを変えても検査が通ること、対象のファイルを変えると失敗すること、実行器に足した import の先が自動で対象に入ること、型だけの import は辿らないこと、対象のファイル同士で `exports` の参照先を差し替えると失敗することを確かめます。

POSIX シェルで新しい証拠を保存する場合:

```sh
pnpm run build
BUDDY_B04_EVIDENCE_PATH=tests/integration/evidence-b04-simulated.json node --test tests/integration/b04.test.mjs
pnpm exec prettier --write tests/integration/evidence-b04-simulated.json
```

全反復が成功したときだけ出力します。通常の試験は証拠を書き換えません。失敗した実行で以前の記録を今回の成功証拠と扱わず、終了コードを確認してください。

## 未実施・残る判断

- 実機（Mac mini・別マシンの macOS / Windows・Tailscale・本物の OS 確認ダイアログ）はすべて未実施。[device-check.md](device-check.md) に前提と手順を記載しています。CI の別 OS の結果も今回のローカル検証からは主張しません。
- 実 API・実メール送信・実予定変更・実請求・実音声・モデル採用は未実施。
- X10 の縦断合格は D3 により B14。表示の移動（handoff）は D6 により B05。2 端末が同じ操作を見ることと、表示権を移すことを混同しません。
- QA27 の外部の下書きの保存は B04-07（#106、ADR 0033）で実装し、模擬で確認しました。同じ画面からの比較は、デスクトップの main の部品の試験までで、Electron の画面の操作・本物の OS 確認ダイアログは未実施です。
- B04 の完了の判定: 親 Issue の完了条件 4 項目は模擬の範囲でそろいました。実機の確認（device-check.md）を待って閉じるか、模擬の範囲で閉じて実機を B04 の外に残すかは本人の判断です。
- 次の着手点は実機用 provider の配線と device-check.md の実機確認。既存 ADR 0027〜0031・0033 の未決の読み取りは、この試験追加で承認済みに変更しません。
