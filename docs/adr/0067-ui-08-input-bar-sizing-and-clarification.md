# ADR 0067: UI-08 の入力バーの伸縮と聞き返しの表示

- 日付: 2026-11-03
- 状態: UI-08（#100、親 #92）の段階の判断。入力バーの大きさの規則を決め、実装した。聞き返しの表示は同じ ADR の次の段階で追記する。試験は模擬だけ。実機（macOS・Windows）は**未実施**。
- 根拠: 設計 01（画面の下の小さなバー。入力するときだけ大きくする）、ADR 0032（3 つの窓・入力バーは `input` の役割）、ADR 0024（HeroUI）、本人の決定（2026-10-22、エピック #92）と司令塔の指示（2026-11-03）。

## 決めたこと

- **小さめの大きさ**は 560 × 56、作業領域の下の中ほど（下端から 16）。従来の `INPUT_BAR_SIZE` のまま。
- **入力中の大きさ**は 560 × 176。**下の端を固定して上へ広げる**（画面の下のバーが上に伸びる）。横の位置も変えない。
- **契機**: 入力バーの窓がフォーカスを受けたら広げ、フォーカスを失ったら縮める。窓を隠したときも縮める。入力中にロック・停止になっても、窓の大きさは変えない（入力欄は無効になる）。
- **作業領域に収まらないとき**は、高さを作業領域 − 16 に切り詰める。幅も作業領域を超えない。
- **キャンバスの配置**は従来の小さめの予約（592 × 88）のまま。入力中は入力バーがキャンバスのカードに重なるが、入力している間だけの一時の重なりとして許す。入力が終われば縮んで元に戻る。
- **新しい IPC は足さない**。大きさの正本は main（Electron の窓）で、renderer は窓の高さ（`window.innerHeight`）で入力欄を 1 行の `Input` と複数行の `TextArea` に切り替える。画面から main へ大きさを要求しない（承認・停止のチャネルを増やさない）。
- 入力欄の文字は、縮んだときも renderer の状態に残す。フォーカスし直すと広がり、続きを打てる。
- **聞き返しの表示**: 送信の結果が聞き返し（`status: clarification`）のとき、`turn.reply_text` を広がった入力バーの上部に HeroUI の `Alert` で出す。説明文ではなく、その回の質問そのものを出す。小さめのときは出さず、広げたときに出す。入力の変更・送信の成功・ロック・不明で消す。ロック中・不明の render では、`InputBar` 側でも本文を出さない（effect の後片付けを待たない）。
- **高さの収め方**: 176 の窓に、上部の `Alert`（最大 72、超えた分はスクロール）、8 の間隔、残りの入力欄を入れる。入力欄は固定の高さにせず、残りの高さに合わせて縮む（`min-h-0`）。
- **古い聞き返しを出さない**: 送信の後に下書きを編集したら下書きの世代を進め、送信時の世代と違う応答の聞き返しは出さない。ロック・不明になったときも世代を進め、応答が遅れて届いても本文を出さない。

## 実装

| 場所                                                       | 内容                                                                                                                                                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/window-roles.ts`                    | `INPUT_BAR_EXPANDED_SIZE`・`inputBarBounds(area, expanded)`。下端固定・中央・作業領域内に収める                                                                                                                |
| `apps/desktop/src/main/electron/main.ts`                   | `inputBarExpanded` の正本、`setInputBarExpanded`、`input` 窓の `focus`／`blur`／`hide`、画面の変更時の置き直し                                                                                                 |
| `apps/desktop/src/renderer/state/use-role-window-state.ts` | `useInputBarExpanded`（窓の高さ 120 以上で広がっていると判断）                                                                                                                                                 |
| `apps/desktop/src/renderer/state/input-bar-state.ts`       | `clarificationText`（聞き返しのときだけ `reply_text` を返す）                                                                                                                                                  |
| `apps/desktop/src/renderer/screens/canvas/InputBar.tsx`    | 広がっているときは HeroUI の `TextArea`（残りの高さに合わせる）、小さめのときは `Input`。下端に寄せる。広がった後に置き換わった入力欄へフォーカスを移す。聞き返しは上部の `Alert`（最大 72・スクロール）に出す |
| `apps/desktop/src/renderer/screens/canvas/RoleWindow.tsx`  | 送信の結果から聞き返しの文を取り、入力の変更・成功・ロックで消す                                                                                                                                               |

## 試験（模擬のみ）

- `apps/desktop/src/main/window-roles.test.ts`: 小さめと入力中の位置・大きさ（下端が同じ）、作業領域に収まらないときの切り詰め。既存の「入力バーは小さな枠なし・常に最前面」の試験はそのまま通る。
- `apps/desktop/src/renderer/screens/canvas/RoleWindow.test.tsx`: 広がっているときは `textarea`（5 行）で、小さめのときは `input`。既存の入力バーの試験はそのまま通る。
- `apps/desktop/src/renderer/screens/canvas/InputBar.dom.test.tsx`: 広げた `TextArea` でも通常の Enter で 1 回だけ送り、IME の変換の確定（`isComposing`）と Shift+Enter では送らない。小さめの `Input` の Enter も 1 回だけ送る。小さめの入力欄にフォーカスしたまま広げると、置き換わった `TextArea` にフォーカスが移る（`document.activeElement` で確認）。
- `apps/desktop/src/renderer/state/input-bar-state.test.ts`: 聞き返しのときだけ `reply_text` を返し、空の文と聞き返し以外では返さない。送信時の世代と今の世代が違う・画面を出していないときは、遅れて届いた聞き返しを出さない。
- `apps/desktop/src/renderer/screens/canvas/InputWindow.dom.test.tsx`: 応答を待つ間に下書きを編集し、その後に聞き返しが返っても、古い依頼の質問を新しい下書きの上に出さない。
- `apps/desktop/src/renderer/screens/canvas/RoleWindow.test.tsx`: 広げた入力バーに聞き返しの文が出る。ロック中・不明で広げていても、聞き返しの本文は出ない。
- 実機の macOS・Windows での窓の伸縮・フォーカスの往復・IME は**未実施**。
- ビルドした画面の CSS と `InputBar` の描画を Chrome（headless）で 560 × 176 に置き、2 行の聞き返しで alert 72・入力欄 78・操作 36 が収まり、`form.scrollHeight` が 174 で窓内に収まることを確認した（`buddy-input-bar-clarification.png`。Electron の実画面ではなく、同じビルドの CSS と DOM の確認）。

## B05 の音声の段（U162）

状態の層の音声の段の見た目を、UI-08 の範囲で整えた。

- **同意の取り消しの位置**: 取り消しの行は「音声を外部へ送っている」の印の右端にそろえる（`-mr-1` を外す）。行の間は 4px ではなく 8px（`gap-y-2`）にし、「続ける」との間を近づけすぎない。
- **ロック中・不明の面**: ほかの状態と同じ高さ 176（`h-44`）にし、読み込み中の骨組みと見分けられるよう、中央に錠の記号（`LockIcon`）を置く。文言・ボタンは出さない。
- **試験**: `VoiceStrip.dom.test.tsx` で、隠した面が `h-44`・錠の SVG 1 つ・文字なしであること、取り消しの行が `h-8`・`-mr-1` なし・親の格子が `gap-y-2` であることを確認した。
- 実機の macOS・Windows での見た目は未実施。Electron の実画面の撮影もこの段階では行っていない。

## 残ること

- 聞き返しの表示（次の段階。入力バーの広がった領域に出す）。
- B05 の音声の状態と「続ける」の見た目、AquaVoice・macOS の音声入力・Win+H の受け取り（変換中は送らない）。
- 実機での確認（Windows はできる範囲で、macOS は未実施）。
