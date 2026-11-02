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

## 実装

| 場所                                                       | 内容                                                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/window-roles.ts`                    | `INPUT_BAR_EXPANDED_SIZE`・`inputBarBounds(area, expanded)`。下端固定・中央・作業領域内に収める                |
| `apps/desktop/src/main/electron/main.ts`                   | `inputBarExpanded` の正本、`setInputBarExpanded`、`input` 窓の `focus`／`blur`／`hide`、画面の変更時の置き直し |
| `apps/desktop/src/renderer/state/use-role-window-state.ts` | `useInputBarExpanded`（窓の高さ 120 以上で広がっていると判断）                                                 |
| `apps/desktop/src/renderer/screens/canvas/InputBar.tsx`    | 広がっているときは HeroUI の `TextArea`（5 行・高さ 128）、小さめのときは `Input`。下端に寄せる                |

## 試験（模擬のみ）

- `apps/desktop/src/main/window-roles.test.ts`: 小さめと入力中の位置・大きさ（下端が同じ）、作業領域に収まらないときの切り詰め。既存の「入力バーは小さな枠なし・常に最前面」の試験はそのまま通る。
- `apps/desktop/src/renderer/screens/canvas/RoleWindow.test.tsx`: 広がっているときは `textarea`（5 行）で、小さめのときは `input`。既存の入力バーの試験はそのまま通る。
- `apps/desktop/src/renderer/screens/canvas/InputBar.dom.test.tsx`: 広げた `TextArea` でも通常の Enter で 1 回だけ送り、IME の変換の確定（`isComposing`）と Shift+Enter では送らない。小さめの `Input` の Enter も 1 回だけ送る。
- 実機の macOS・Windows での窓の伸縮・フォーカスの往復・IME は**未実施**。撮影用の起動での確認もこの段階では行っていない。

## 残ること

- 聞き返しの表示（次の段階。入力バーの広がった領域に出す）。
- B05 の音声の状態と「続ける」の見た目、AquaVoice・macOS の音声入力・Win+H の受け取り（変換中は送らない）。
- 実機での確認（Windows はできる範囲で、macOS は未実施）。
