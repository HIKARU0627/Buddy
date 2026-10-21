# ADR 0024: デスクトップの UI を HeroUI で作る

- 日付: 2026-10-21
- 状態: UI-01（#71）の判断と実装。`apps/desktop` の UI レンダラーに HeroUI v3 と Tailwind CSS v4 を入れ、B01 の画面（状態欄・入出力の停止と再開・ウィンドウを閉じる・クライアントの終了・電源とロックの記録）を HeroUI の部品で作り直した。試験は renderer の純粋なモジュールとサーバー描画（react-dom/server）の node:test、ビルド後の CSP・読み込みの検査（CI の 3 OS）。macOS のローカルで Electron を起動し、CDP で画面・配色・キーボード操作・CSP の違反を確かめた（模擬。Windows の実機・実際の読み上げソフト・タッチ操作は未実施）。
- 根拠: 本人の指示（2026-10-21）「UI は HeroUI を使用する。すでにある UI は作り直す」。以後の画面もすべて HeroUI で作る。画面の内容・IPC は ADR 0014・0015 のまま変えない。CSP・sandbox・contextIsolation は ADR 0015 のまま弱めない。

## 決めたこと

| 対象             | 決定                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 部品             | 画面の部品は HeroUI（`@heroui/react`）を使う。HeroUI にない見た目だけの配置（並べ方・余白）は Tailwind CSS のクラスで書く。独自のボタン・カード・警告の部品を作らない                                                            |
| 入れる場所       | UI レンダラー（`src/renderer`）だけ。main・preload は HeroUI・Tailwind CSS・React Aria を読み込まない（main の Ajv などはそのまま）                                                                                              |
| スタイル         | Tailwind CSS v4 の Vite プラグイン（`@tailwindcss/vite`）で、HeroUI のスタイルと画面のクラスをビルド時に一つの CSS ファイル（`dist/renderer/assets/*.css`）へ出す。実行時に CSS を作らない                                       |
| ライト・ダーク   | OS の設定（`prefers-color-scheme`）に従う。HeroUI のテーマは html の `class="dark"` と `data-theme` で切り替わるため、`app/theme.ts` が `matchMedia` を読み、変わったら追従する。手動の切り替えは置かない                        |
| 共通の Provider  | HeroUI v3 は Provider を要求しない。`app/AppProviders.tsx` に React Aria の `I18nProvider`（`ja-JP`）だけを置き、部品の内部の読み上げの文言・日付の書式を日本語にする                                                            |
| 画面の内容と IPC | 文言（`labels.ts`）・表示する項目・操作・preload の `invoke`／`onNotification`・5 つのチャネル・`DesktopStatusBar` は変えない。再開は「この端末の停止」のときだけ出し、画面が表示している io_epoch を `expected_io_epoch` で送る |
| CSP・sandbox     | 変えない（`default-src 'none'; script-src 'self'; style-src 'self'; …`、sandbox、contextIsolation、nodeIntegration 無効）。下の「CSP との関係」                                                                                  |
| 開発用のサーバー | 使わない（ADR 0015 のまま）。画面を変えたら `pnpm --filter @buddy/desktop dev` で起動し直す                                                                                                                                      |

## 版の一覧

着手時点（2026-10-21）に `pnpm view <pkg> time` で公開日を確かめ、正確な版で固定しました。プレリリースは使いません。pnpm 12 の公開からの経過期間の方針（`pnpm add` と `pnpm install` の「supply-chain policies」の検査）はすべて通り、除外の設定（minimumReleaseAgeExclude など）は足していません。

| パッケージ              | 版     | 公開日     | 理由                                                                                                     |
| ----------------------- | ------ | ---------- | -------------------------------------------------------------------------------------------------------- |
| @heroui/react           | 3.2.6  | 2026-09-17 | HeroUI の最新の安定版（latest）。React 19・Tailwind CSS v4 が前提                                        |
| @heroui/styles          | 3.2.6  | 2026-09-17 | HeroUI のスタイル（公式の導入手順で `@heroui/react` と組で入れる）                                       |
| react-aria              | 3.52.1 | 2026-09-04 | HeroUI の peer（`^3.52.1`）。HeroUI 3.2.6 の公開時点の版に合わせた（最新は 3.53.1）                      |
| react-aria-components   | 1.21.1 | 2026-09-04 | HeroUI の peer（`^1.21.1`）。同上（最新は 1.22.1）                                                       |
| @react-aria/ssr         | 3.10.1 | 2026-05-28 | HeroUI の peer（`^3.10.1`）の最新                                                                        |
| @react-aria/utils       | 3.34.1 | 2026-05-28 | HeroUI の peer（`^3.34.1`）の最新                                                                        |
| @internationalized/date | 3.12.4 | 2026-09-01 | HeroUI の peer（`^3.12.4`）の最新。今の画面では使わないが、peer なので明示して版を固定する               |
| tailwindcss             | 4.3.3  | 2026-07-16 | HeroUI の peer（`>=4.0.0`）。Tailwind CSS v4 の最新の安定版                                              |
| @tailwindcss/vite       | 4.3.3  | 2026-07-16 | Vite 8 に対応する（peer `^5.2.0 \|\| ^6 \|\| ^7 \|\| ^8`）公式の Vite プラグイン。`tailwindcss` と同じ版 |

- react・react-dom（19.3.1）、vite（8.3.4）、@vitejs/plugin-react（6.1.2）は既存の版のまま。HeroUI 3.2.6 の peer（`react >=19.0.0`）を満たす。
- 依存を足して増えたパッケージは約 80（`pnpm add` の表示で +53・+25）。install 時のスクリプト（preinstall・install・postinstall）を持つものはなく、`allowBuilds` の変更は不要でした（ルートの package.json・pnpm-workspace.yaml は変えていない）。
- Tailwind CSS の `@tailwindcss/oxide` と、その依存の `lightningcss` は Rust のネイティブのモジュールですが、OS・CPU ごとのビルド済みのバイナリを optionalDependencies で取得し、install 時にビルドしません（Windows・macOS・Linux の x64・arm64 を含む）。
- HeroUI が依存する `@react-types/color` 3.2.0 は、型の包みでありながら `@react-spectrum/color` を依存に持つため、`@adobe/react-spectrum` 一式（と react-aria 3.53.1・react-aria-components 1.22.1 の別の版）が node_modules に入ります。画面のコードからは読み込まず、ビルド結果（Vite の束）にも入りません。上流の構成のため、overrides などで外していません。

## 構成

```text
src/renderer/
  index.html              CSP の meta と、React Aria の style の差し込みを省かせる空の template
  main.tsx                入口（配色の追従を始め、AppProviders で包む）
  App.tsx                 画面の切り替え（限定 API がなければその旨だけ。今は端末の画面だけ）
  styles.css              tailwindcss → @heroui/styles の順で読み込む。独自の色は定義しない
  labels.ts               画面の文言（変えていない）
  desktop-api.ts          preload の限定 API の型と要求の組み立て（変えていない）
  app/                    画面全体の共通: AppProviders（Provider）・theme（配色）・AppShell（枠）
  components/             画面をまたいで使う小さな部品（PanelTitle: Card.Title を h2 で出す）
  state/                  desktop-state（状態の反映と要求の組み立て。純粋な関数）・use-desktop-state（限定 API とつなぐフック）
  screens/device/         端末の画面: DeviceScreen・StatusPanel・IoControls・ContentPanel・PowerLogPanel
```

- 画面の部品は状態と操作を引数で受け取り、限定 API を直接呼ばない。限定 API とつなぐのは `state/` のフックだけ。
- 試験は `src/renderer/**/*.test.ts(x)`。`tsconfig.renderer-test.json` が `dist/renderer-test/` へ出し、`pnpm test` が他の試験と一緒に実行する。lint は renderer の試験にだけ `node:test`・`node:assert` を許す（Electron・他の Node API・main は読み込めないまま）。
- 型検査の `tsconfig.renderer.json`・`tsconfig.renderer-test.json` だけ `skipLibCheck: true` にした（下の「読み取り」）。

## CSP との関係

CSP は変えていません。HeroUI・React Aria・Tailwind CSS がインラインのスタイル・eval を要るかを確かめ、次のとおり弱めずに済ませました。

- **スタイル**: Tailwind CSS v4 と HeroUI のスタイルはビルド時に CSS ファイルへ出し、`<link rel="stylesheet">` で `buddy://app/` から読み込むので `style-src 'self'` に収まる。CSS の中の `url()`・`@import` はない（ビルド後の検査で確かめる）。
- **React の `style` の指定**: React と React Aria（読み上げ専用の要素の隠し方など）は要素の `style` プロパティ（CSSOM）を直接書くため、CSP の対象外で、止められない。HTML の `style` 属性は使わない。
- **React Aria が差し込む style 要素**: React Aria の押下の処理（`usePress`）は、`id="react-aria-pressable-style"` の要素がなければ `<style>`（`[data-react-aria-pressable] { touch-action: pan-x pan-y pinch-zoom }`。タッチのダブルタップの拡大による押下の遅れを避ける）を head に差し込む。CSP がこれを止め、コンソールに違反が出ていた（Electron で確認）。同じ規則を `styles.css` に置き、`index.html` に空の `<template id="react-aria-pressable-style">` を置いて差し込みを省かせた。nonce・hash・`'unsafe-inline'` は使わない。再確認で違反は 0 件。
- **アニメーション**: HeroUI v3 は framer-motion などの JavaScript のアニメーションのライブラリを使わず、CSS（`tw-animate-css`）で動かす。
- **eval**: ビルド結果の JavaScript に `eval(`・`new Function(` はない（ビルド後の検査で確かめる）。
- **data: URI**: Vite が小さな画像・フォントを data: URI に埋め込むと `img-src`・`font-src 'self'` に掛かるため、`build.assetsInlineLimit: 0` にした（今は該当する資源はない）。
- **ビルド後の検査**（`src/main/renderer-build.test.ts`）: `dist/renderer/index.html` の CSP の meta、インラインのスクリプト・style 要素・style 属性・イベント属性がないこと、参照するファイルと出力したすべてのファイルが `buddy://app/` で返せる種類であること、上の template と touch-action の規則がビルドに入っていること、CSS の外部の読み込み・JavaScript の eval がないことを確かめる。

## 以後の画面の約束

1. 画面は `screens/<名前>/` に置き、`App.tsx` で切り替える。画面の部品は HeroUI の部品で作り、状態と操作は引数で受け取る。限定 API とつなぐのは `state/` のフック（画面ごとに足してよい）。
2. 共通の Provider は `app/AppProviders.tsx` に、画面の枠は `app/AppShell.tsx` に足す。画面ごとに Provider を作らない。
3. 色は HeroUI のテーマの変数（`bg-background`・`text-foreground`・`text-muted`・`border-border` など）と部品の `color`／`variant`／`status` だけを使い、ライト・ダークの両方で見えることを確かめる。状態は色だけでなく文言と記号でも示す（設計 01）。
4. 操作は HeroUI の `Button`（React Aria）の `onPress` で受ける。キーボード（Tab・Enter・Space）で届くこと、欄に `aria-label` か見出しがあること、警告は `role="alert"` で出すことを確かめる。
5. CSP・sandbox・contextIsolation を弱めない。新しい部品（Modal・Toast・Tooltip など）を使う画面では、Electron で `securitypolicyviolation`（コンソールの CSP 違反）が 0 件であることを確かめる。違反が出たら、まず弱めずに済む方法（ビルド時の CSS に移す・差し込みを省かせる）を探し、CSP の変更が要るなら実装せずに本人の判断に回す。
6. 依存は正確な版で足し、公開からの経過期間の方針を満たす版を選ぶ（除外の設定を足さない）。install 時にビルドが要る依存は、`allowBuilds` に足す前に報告する。

## 読み取り（レビュー対象）

原本・本人の指示に明記がなく、実装で決めた点です。

- **peer の版**: react-aria・react-aria-components は最新（3.53.1・1.22.1）ではなく、HeroUI 3.2.6 の公開時点の版（3.52.1・1.21.1）にした。HeroUI が試した組み合わせに近づけるため。HeroUI を上げるときに合わせて上げる。
- **skipLibCheck**: リポジトリの既定は `skipLibCheck: false` だが、HeroUI 3.2.6・react-aria-components 1.21.1 の型定義は `exactOptionalPropertyTypes` の下で型定義の中の衝突（TS2320）を出すため、renderer の二つの tsconfig だけ `true` にした。自分のコードの型検査（strict・exactOptionalPropertyTypes など）は変わらない。main・preload・他のワークスペースは `false` のまま。
- **CSS の大きさ**: `@heroui/styles` を丸ごと読み込むため、使わない部品のスタイルも含めて CSS は約 430 KB（gzip 約 40 KB）。ローカルのファイルなので今は許容し、部品ごとの読み込みは画面が揃ってから判断する。
- **差し込みを省かせる template**: React Aria の内部の実装（id で既存の要素を探す）に依る。React Aria が変われば違反が再び出るが、止められるだけで動作は変わらない（規則は styles.css にある）。ビルド後の検査と、上の約束 5 の確認で気づける。
- **試験の範囲**: DOM の試験のライブラリ（jsdom・Testing Library など）は足していない（HeroUI が求めるものだけを入れる原則）。表示・読み上げのラベル・ボタンの要素はサーバー描画の HTML で、押したときの要求はボタンの `onPress` を呼んで確かめる。実際のクリック・キーボード操作は Electron の画面で確かめる。DOM の試験を足すかは後続で判断する。
- **見出し**: Card.Title の既定は h3 だが、文書の構造を B01 と同じ h2 にするため `render` で h2 を出す。
- **状態欄の縁の色**: B01 の画面の下線の色（受付中は緑・停止中は橙）の代わりに、カードの左の縁と Chip の色（success・warning）で示す。文言と記号（● ■ 🔒 ？）は B01 と同じ。

## 検証

- 模擬: `pnpm run check`（renderer の試験・ビルド後の検査を含む）。CI の 3 OS で同じものを実行する。
- ローカルの起動（macOS、模擬の端末状態）: `--user-data-dir` を一時ディレクトリにして Electron を起動し、CDP で次を確かめた。スクリーンショットはリポジトリに入れていない。
  - ライト・ダーク（`prefers-color-scheme` のエミュレーション）で html の class・data-theme と背景が切り替わる。
  - Tab で「停止」「再開」「ウィンドウを閉じる」「終了」の順にフォーカスが移り、フォーカスの枠が出る。Enter・Space で押せる。
  - 再開は、ウィンドウが前面でないと main が `screen_operation_required` で拒否し、`role="alert"` の文言が出る（ADR 0014 のまま）。
  - アクセシビリティの木で、ボタンの名前、status・alert・region（操作・内容・電源とロックの記録）・見出しを確かめた。
  - 再読み込みの後の CSP の違反・コンソールの記録は 0 件。
- 未実施: Windows の実機、実際の読み上げソフト（VoiceOver・ナレーター）、タッチ操作、受付中・ロック中の状態の実機での表示（受付中への再開はウィンドウを前面に出せず未確認。表示はサーバー描画の試験で確認）。

## 残ること

- ペアリング画面（#66）と B04 以降の画面を、この土台と約束で作る。
- DOM の試験のライブラリを足すか、部品ごとの CSS の読み込みにするかの判断。
- Windows の実機での表示・キーボード操作・読み上げの確認（B01-05 の実機確認とまとめてよい）。
