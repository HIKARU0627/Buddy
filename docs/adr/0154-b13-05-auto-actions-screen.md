# ADR 0154: B13-05 自動実行の画面（一覧・取り消し・安全停止の解除）

- 日付: 2026-11-26
- 状態: B13-05（親 #24）の画面の部分。標準の端末画面（従来の窓）に「自動実行」の欄を置き、一覧・取り消し・安全停止の解除を Core まで通した。**模擬・同じプロセスの統合試験だけ**で、Electron の画面の実機確認・実データ・実 API は未実施。
- 根拠: 設計 03「取り消しと安全停止」、設計 07 §2、設計 01（いつも見える状態）、J12、ADR 0014・0132・0152・0153。原本の参照手順は `docs/design/README.md`。
- 対象: `packages/contracts`（IPC の 3 チャネル、`DesktopAutoActionView`・`DesktopAutoActionEntry`・`DesktopSafetyView`、拒否の理由 `undo_target_changed`）、`packages/domain/src/desktop.ts`（チャネル・受付・役割）、`apps/desktop`（`main/auto-action-bridge.ts`・`core-link.ts`・`electron/main.ts`・`preload.cts`、`renderer/state/auto-action-state.ts`・`use-auto-action-state.ts`・`screens/auto-actions/AutoActionsPanel.tsx`・`labels.ts`・`App.tsx`）。

## 決めたこと

| 対象               | 決定                                                                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 端末の経路         | IPC は `desktop.auto_actions_list`（ロック解除済み。前面は求めない）、`desktop.auto_action_undo` と `desktop.safety_resume`（ロック解除済みの画面操作）。3 つとも従来の窓と状態の層の役割表に入れ、キャンバス・入力バーには渡さない（ADR 0132 と同じ）                        |
| 参照だけを渡す     | 画面へは main（`AutoActionBridge`）が作る参照（ref）と表示用の値だけを渡す。操作 ID・状態版・安全停止の版（`safety_revision`）は main が持ち、送るときに `expected_state_revision`・`expected_safety_revision` として付ける。世代（ロック・切断）が進んだら一覧と参照を捨てる |
| 取り消し           | 一覧の押下をそのまま確認とし、確認の問いを足さない（J12、U311）。取り消せる（`available`）行だけにボタンを出す。受け付けたら一覧を読み直す                                                                                                                                    |
| 対象が変わっていた | Core の 409 `target_changed` は、拒否の理由 `undo_target_changed` として画面へ渡し、「対象がその後に変わっていたため、自動では元に戻しませんでした」と行に出して一覧を読み直す。他の 409・410 は `preview_stale`                                                              |
| 結果が分からない   | 届いたか分からない・5xx・形の違う 2xx は自動では送り直さない。取り消しはその行を次の読み取りまで操作させず、解除は一覧を読み直す                                                                                                                                              |
| 安全停止の解除     | 画面の中で一度問う（「再開すると、方針で許した操作を、また自動で行うようになります。再開しますか。」）。送るのは画面に出した停止の参照だけで、main は今の停止の参照と違えば送らずに `preview_stale` を返す（U316）                                                            |
| 時刻の見せ方       | 実行・停止・最終取得は「何分前」、取り消しの期限は「あと何日」の相対の時間で出す。`AutoActionList` に本人のタイムゾーンが無く、端末の OS のタイムゾーンで黙って代用しないため（U314）                                                                                         |
| 取得の状態         | 欄の頭に取得の状態と最終取得の時刻を出す。読めないときに「自動で行った操作はありません」と言わず、安全停止の状態も「不明」とする                                                                                                                                              |
| 状態欄             | 状態欄の安全停止の値（`safety_stopped`）は埋めない。一覧は欄を開いたとき・押したときにしか読まず、常に正しい値を出せないため（U315）                                                                                                                                          |

## 原本に決めがない項目

- 一覧の時刻を本人のタイムゾーンで出すか、相対の時間で出すか（U314）。
- 状態欄の安全停止の値の出所（U315）。
- 安全停止の解除の前の確認（U316）。

## 対象外

- 下書き・用事・予定の取り消し（U310）。補償の操作が止まったときの取り消しの記録（U313）。
- 状態の層（キャンバスのモード）の自動実行の画面。

## 試験（模擬・同じプロセスの統合だけ）

- `packages/contracts/fixtures/desktop-ipc-cases.json`（受付 10 件）と `schema-cases.json`（14 件。操作 ID・版・未知の取り消しの状態を拒否）。
- `scripts/desktop-ipc.test.mjs`・`scripts/canvas.test.mjs`・`apps/desktop/src/main/preload.test.ts`・`window-roles.test.ts`: チャネルの一覧・役割と、画面へ渡す形に ID・版が無いこと。
- `apps/desktop/src/main/auto-action-bridge.test.ts`（10 件、模擬の接続）と `auto-action-link.test.ts`（2 件、127.0.0.1 の Core と `DesktopCoreLink`。空の一覧、動いているときの解除は送らないこと、受付の拒否）。
- `apps/desktop/src/renderer/state/auto-action-state.test.ts`（10 件）と `screens/auto-actions/AutoActionsPanel.test.tsx`（6 件、サーバー描画）。

期待値は手で書いた。Electron の画面の見た目・クリック、実データ・実 API・実機は未実施で、合格扱いにしない。

## 残ること

- U310・U313〜U316 の本人の確認。
- 状態欄の安全停止の値（U315）と、状態の層の画面。
