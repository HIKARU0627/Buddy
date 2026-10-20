# Desktop クライアント

Electron / React / TypeScript / Vite のクライアントです。B01 はトレイ常駐・端末状態（ロック・この端末の入出力停止・io_epoch）の記録・限定 IPC の開発起動までです（[ADR 0015](../../docs/adr/0015-b01-desktop-minimal-app.md)、IPC の契約は [ADR 0014](../../docs/adr/0014-b01-desktop-ipc-contract.md)）。
中枢（Core）には接続しません。Core の存続を Electron の起動に依存させないでください。インストーラー・署名・自動更新・音声レンダラーは未実装です。

## 開発起動

リポジトリのルートで依存を入れてから実行します（Windows / macOS）。

```sh
pnpm install --frozen-lockfile
pnpm --filter @buddy/desktop dev
```

`dev` は contracts・domain・desktop をビルドしてから `electron .` を起動します。ビルド済みなら `pnpm --filter @buddy/desktop start` で起動だけを行えます。

- 初回の起動で Electron のバイナリ（約 100 MB）を GitHub から取得し、OS のキャッシュに置きます。ネットワークが必要です。取得に失敗したら `apps/desktop` で `pnpm exec install-electron` を実行してください。`pnpm install` と CI ではバイナリを取得しません。
- 開発用のサーバー（HMR）はありません。画面を変えたら `dev` で起動し直します。
- 端末状態は userData（macOS `~/Library/Application Support/Buddy Desktop`、Windows `%APPDATA%\Buddy Desktop`）の `device-io-state.json` に io_epoch と停止の範囲だけを保存します。秘密・本文は保存しません。

## 確かめられること

- ウィンドウを閉じてもトレイ（macOS はメニューバー）に残ります。終了はトレイの「クライアントを終了」か画面のボタンです。どちらも中枢を止めません。
- 起動直後はロック状態が不明として内容を隠し、OS へ問い合わせて解除を確かめてから表示します。ロック・スリープの後は「この端末で再開する」を押すまで入出力を再開しません。
- 状態欄・電源とロックの記録（OS からの通知・OS への問い合わせ）を画面に表示します。

## 構成

| 場所                        | 役割                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/main/*.ts`             | Electron に依存しない純粋なモジュール（IPC の受付・端末状態・保存・ウィンドウとトレイの判断）と試験 |
| `src/main/electron/main.ts` | Electron のアダプター（BrowserWindow・Tray・ipcMain・powerMonitor・protocol・app のライフサイクル） |
| `src/preload/preload.cts`   | sandbox の preload。contextBridge で限定 API（invoke・onNotification）だけを公開する                |
| `src/renderer`              | React の画面。状態欄・停止と再開のボタン・電源とロックの記録。Electron・Node.js の API を使わない   |

試験は `pnpm test` がビルド後の `dist/main/*.test.js` を実行します（Electron は起動しません）。実機でのロック・スリープの確認は B01-05 で行います。
