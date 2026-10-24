# Desktop クライアント

Electron / React / TypeScript / Vite のクライアントです。画面は HeroUI（v3）と Tailwind CSS（v4）で作ります（[ADR 0024](../../docs/adr/0024-ui-heroui-desktop-renderer.md)）。B01 はトレイ常駐・端末状態（ロック・この端末の入出力停止・io_epoch）の記録・限定 IPC の開発起動までです（[ADR 0015](../../docs/adr/0015-b01-desktop-minimal-app.md)、IPC の契約は [ADR 0014](../../docs/adr/0014-b01-desktop-ipc-contract.md)）。
B03 で中枢（Core）に HTTPS（TLS のピン留め）と WSS で接続し、ペアリング・接続状態の表示・ロック状態の申告・自宅の指紋の報告を行います（[ADR 0025](../../docs/adr/0025-b03-client-desktop-connection.md)）。端末トークンは main だけが持ち、safeStorage で暗号化して保存します（Renderer・IPC・ログに出さない）。Core の存続を Electron の起動に依存させないでください。インストーラー・署名・自動更新・実際の音声（マイク・WebRTC）は未実装です（音声レンダラーは模擬だけ。B05-06）。

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
- 中枢に登録すると、トークンと中枢の証明書を safeStorage（macOS はキーチェーン、Windows は DPAPI）で暗号化して userData の `device-credential.bin` に置きます。保護の弱い方式（Linux の basic_text など）しか使えなければ保存せず、登録もしません。
- 確かめるときに実機のキーチェーンへ書きたくなければ、`electron . --use-mock-keychain --user-data-dir=<一時ディレクトリ>` で起動し、中枢は `buddy-core start --mock-key-protection --https-host 127.0.0.1` を使います（模擬。実機の確認は [docs/b03/device-check.md](../../docs/b03/device-check.md)）。

### 3 つの窓の試作（UI-02）

`electron . --buddy-ui=canvas`（または環境変数 `BUDDY_DESKTOP_UI=canvas`）で、キャンバス・状態の層（端のつまみ）・入力バーの 3 つの窓を作ります（[ADR 0032](../../docs/adr/0032-ui-canvas-stream-and-window-roles.md)）。既定（フラグなし）と配布版（`app.isPackaged`）は今の 1 つの窓です。main は送信元の窓の役割で受付を絞り（`src/main/window-roles.ts`）、役割に合わない要求を `untrusted_sender` で拒否します。キャンバスは普段はデスクトップの層にあり、⌘⌥⇧B（Windows は Ctrl+Alt+Shift+B）・端のつまみ・入力バーの右端のボタンで前に出て、Esc かほかのアプリへ移ると後ろへ戻ります（`src/main/canvas-presence.ts`）。試作の記録は [docs/ui/window-prototype.md](../../docs/ui/window-prototype.md) です。

### 最小の縦断（UI-03）

同じフラグのとき、入力バーの発言（`desktop.turn_submit`）は会話ではなく流れ（`POST /v1/stream/turns`）へ送り、中枢のキャンバスの記述（`GET /v1/canvas`）を取って、形式（Ajv）と意味（domain）を検査し、参照を不透明な参照に置き換えて、キャンバスの窓だけへ通知します（`desktop.canvas_changed`。`src/main/canvas-bridge.ts`）。ロック・切断・世代の変化では記述を捨てます。キャンバスの窓は、受け取った記述から用事の list のカードを描きます（`src/renderer/screens/canvas/`）。試した範囲は [docs/ui/canvas-vertical.md](../../docs/ui/canvas-vertical.md) です。

### 状態と停止の層（UI-04）

同じフラグのとき、端のつまみ（入出力の記号・確認が必要な操作の数・専用の記号 3 つ）を押すか ⌘⌥⇧P（Windows は Ctrl+Alt+Shift+P）で、main が状態の層の窓を画面の右の端から広げてパネルを出します（`desktop.status_panel`。`src/main/status-panel.ts`）。パネルには、入出力と停止・再開、ADR 0014 の 8 項目、確認が必要な操作の一覧と確認の欄（従来の窓の WorkPanel と同じ部品）を出します。Esc・つまみ・外へのクリックでしまいます。承認・取消・再試行・照合は、パネルの窓を親にした OS の確認ダイアログで 1 回行います。⌘⌥⇧X（Windows は Ctrl+Alt+Shift+X）は全体の停止で、トレイの「入出力を停止」と同じ処理です。これは既定の従来の窓（配布版を含む）でも登録し、登録できなければトレイの停止の項目と停止のボタンの横に ⚠ を出します（`src/main/global-shortcuts.ts`）。試した範囲は [docs/ui/status-layer.md](../../docs/ui/status-layer.md) です。

### 部品のカタログ（UI-07）

同じフラグのとき、キャンバスの窓は 9 つの部品（list・table・schedule_timeline・mail_card・compare・progress・chart・source_list・text）を HeroUI で描きます（`src/renderer/screens/canvas/ItemCard.tsx` と `parts/`）。説明文は置かず、数・形・位置で伝えます（重なる予定は横に並べる、違う値は列を分ける、系列は色だけでなく塗り方・線の種類・点の形で分ける）。本文（行・セル・予定・メールの件名・出典など）は、描くときにキャンバスの窓が main に求め（`desktop.canvas_content`。`src/main/canvas-bridge.ts` の `content`）、main が中枢から許可範囲内で取って返します（`POST /v1/canvas/content`）。本文は main と画面のメモリーだけに置き、端末に保存せず、イベントにも入れず、キャンバスの窓だけに届け、ロック・停止・切断・世代の変化で捨てます。UI-07 の中身は模擬の合成データです（実データは B08・B09・B11）。試した範囲は [docs/ui/canvas-catalog.md](../../docs/ui/canvas-catalog.md) です。

### 配置のエンジンとユーザーの操作（UI-06）

同じフラグのとき、キャンバスの窓は物の位置と大きさを配置のエンジン（`@buddy/domain` の `layoutCanvas`）で決めます。意味（強調・まとまり・関係・格子のヒント）から置き、下の中央（入力バー）と右の端（状態の層）を空け、使わない物は下の棚に並べます。幅が 840 未満なら 1 列で、入りきらない物は棚の場所の札になり、札を押すとその物を見せます（作業領域の高さが 272 未満なら物を置かず、棚は上の端の小さな帯です）。作業領域の外の幅（メニューバー・Dock）は main が知らせます（`desktop.canvas_work_area`）。キャンバスを前に出している間だけ、見出しの帯を掴んで動かす・右下の角で大きさを変える・×で閉じる・下向きの矢印で棚へ片付ける・棚の物を押して出すことができ、キーボードでも同じことができます（Tab・矢印・Shift ＋ 矢印・Delete・Alt ＋ ↓）。操作は main を通して中枢に記録します（`desktop.canvas_user_op` → `POST /v1/canvas/user-ops`。`src/main/canvas-bridge.ts`）。キャンバスを置く画面の設定はユーザーのデータの場所の `canvas-display.json` だけで（既定は主の画面。`src/main/canvas-display.ts`）、キャンバスの本文・見出しは端末に保存しません。試した範囲は [docs/ui/canvas-layout.md](../../docs/ui/canvas-layout.md) です。

### 音声レンダラーと 3 層の停止（B05-06）

同じフラグに `--buddy-voice=mock`（または環境変数 `BUDDY_DESKTOP_VOICE=mock`）を足すと、隠した音声レンダラーの窓（模擬のレンダラー。合成の PCM で、マイク・WebRTC・実 API を使わない）と、端末の中だけで答える模擬の中枢を使います（[ADR 0050](../../docs/adr/0050-b05-desktop-voice-renderer-isolation-and-stop.md)）。音声レンダラーは専用のスキーム（`buddy-voice://renderer/`）と保存しないセッションで、ビルド済みの `dist/voice` の HTML と JS だけを読み、ほかの通信・権限・遷移を全て拒否します。main は 6 つの限定 IPC だけを送り、ACK の期限（suspend_io は 300 ms）を過ぎた・失敗した・固まったときは強制終了して、この端末の入出力も止めます（`src/main/voice-controller.ts`）。状態の層のパネルに音声の段（状態・「音声を外部へ送っている」の印・同意の取り消し・最小の「続ける」）を出します。外部への送信の同意は、初めて「続ける」を押したときに main の OS の確認ダイアログで 1 回だけ取り、userData の `voice-consent.json` に記録します（表示と確認を出すかの判断だけ。正本は中枢）。模擬のレンダラーの故障は `--buddy-voice-fault=delay=250,hang=suspend_io,drop=stop_playback:play,fail=start` で注入できます。どれも開発の起動だけで、配布版と既定は音声レンダラーを作りません。

## 確かめられること

- ウィンドウを閉じてもトレイ（macOS はメニューバー）に残ります。終了はトレイの「Buddy を終了」か画面のボタンです。どちらも中枢を止めません。
- 起動直後はロック状態が不明として内容を隠し、OS へ問い合わせて解除を確かめてから表示します。ロック・スリープの後は「この端末で再開する」を押すまで入出力を再開しません。
- 状態欄・電源とロックの記録（OS からの通知・OS への問い合わせ）を画面に表示します。
- 未登録なら登録の画面（手順 1 / 4 宛先 → 2 指紋の確認: 4 桁ずつ 4 行の指紋を中枢の表示と見比べ、この画面では伏せた最後の 4 桁を中枢の画面から読んで入力（main が合うときだけ進める）→ 3 ワンタイムコードと端末名 → 4 承認待ち: 確認コードと期限）を出し、登録後は中枢との接続の欄（理由・自宅の判定・中枢の操作）を出します。
- 中枢の画面の端末（中枢と同じマシン）では、本体を「端末の登録」「登録済みの端末」「自宅のネットワーク」「このマシンの接続」のタブにし、ペアリングの開始・申請の承認と拒否・端末の失効を、確認のダイアログを経て行います（ADR 0026）。
- 「自宅のネットワーク」では、このマシンが今つながっているネットワークを伏せて表示し（ルーターの MAC アドレスは最後の 2 組、サブネット、SSID は先頭の 1 文字と文字数）、確認のダイアログを経て自宅として登録・登録し直しします（「Wi-Fi 名（SSID）も確かめる」を選べる。未登録では確かめる、登録済みでは今の登録に合わせる）。MAC・SSID の値は main だけが持ち、画面・IPC・ログに出しません（ADR 0022 の追記）。

## 構成

| 場所                            | 役割                                                                                                                                                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/*.ts`                 | Electron に依存しない純粋なモジュール（IPC の受付・端末状態・保存・ウィンドウとトレイの判断、中枢との接続: `hub-transport`・`pairing-flow`・`credential-store`・`home-reporter`・`home-registration`・`core-link`）と試験（2 クライアントの統合試験 `two-clients.test.ts` を含む） |
| `src/main/electron/main.ts`     | Electron のアダプター（BrowserWindow・Tray・ipcMain・powerMonitor・protocol・safeStorage・app のライフサイクル）                                                                                                                                                                   |
| `src/preload/preload.cts`       | sandbox の preload。contextBridge で限定 API（invoke・onNotification）だけを公開する                                                                                                                                                                                               |
| `src/preload/voice-preload.cts` | 音声レンダラーの preload。命令の受け取り・ACK の返送・故障の指定だけを公開する（B05-06）                                                                                                                                                                                           |
| `src/voice`                     | 音声レンダラーの画面（模擬のレンダラーを動かすだけ。`vite.voice.config.mjs` で `dist/voice` へ出す）                                                                                                                                                                               |
| `src/renderer`                  | React と HeroUI の画面。状態帯・停止と再開・登録・中枢の画面・電源とロックの記録。Electron・Node.js の API を使わない                                                                                                                                                              |

試験は `pnpm test` がビルド後の `dist/main/*.test.js`・`dist/renderer-test/**/*.test.js` を実行します（Electron は起動しません）。実機でのロック・スリープの確認は B01-05 で行います。

## 画面（HeroUI）

画面の部品は HeroUI（`@heroui/react`）を使い、並べ方・余白だけを Tailwind CSS のクラスで書きます。スタイルはビルド時に CSS ファイルへ出し、CSP（`style-src 'self'`）を変えません。ライト・ダークは OS の設定に従います。

| 場所                           | 役割                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `src/renderer/App.tsx`         | 画面の切り替え。限定 API を読めなければその旨だけを出す                                                            |
| `src/renderer/app/`            | 共通の Provider（`AppProviders`）・配色の追従（`theme`）・画面の骨格（`AppShell`）                                 |
| `src/renderer/components/`     | 画面をまたいで使う部品（状態帯・記号＋文言・見出しの欄・指紋の格子・フッター）                                     |
| `src/renderer/state/`          | 画面の状態と要求の組み立て（純粋な関数）と、限定 API とつなぐフック                                                |
| `src/renderer/screens/<名前>/` | 画面ごとの部品（`device`: 停止中の帯・中枢との接続・電源とロックの記録、`pairing`: 登録の画面、`hub`: 中枢の画面） |
| `src/renderer/styles.css`      | `tailwindcss` → `@heroui/styles` の順で読み込む。テーマの変数の上書き（コントラスト）はここの 1 か所だけ           |

画面を足すときは `screens/<名前>/` に置いて `App.tsx` で切り替え、状態と操作は引数で受け取ります（限定 API とつなぐのは `state/` のフックだけ）。Provider は `app/AppProviders.tsx` に足します。色は HeroUI のテーマの変数だけを使い、ライト・ダーク・キーボード操作・読み上げのラベルと、Electron のコンソールに CSP の違反が出ないことを確かめます（ADR 0024 の「以後の画面の約束」と「画面の骨格とデザインの約束」。コントラストは `scripts/contrast.test.mjs`）。
