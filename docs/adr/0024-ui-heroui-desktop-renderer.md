# ADR 0024: デスクトップの UI を HeroUI で作る

- 日付: 2026-10-21
- 状態: UI-01（#71）の判断と実装。`apps/desktop` の UI レンダラーに HeroUI v3 と Tailwind CSS v4 を入れ、B01 の画面（状態欄・入出力の停止と再開・ウィンドウを閉じる・クライアントの終了・電源とロックの記録）を HeroUI の部品で作り直した。試験は renderer の純粋なモジュールとサーバー描画（react-dom/server）の node:test、ビルド後の CSP・読み込みの検査（CI の 3 OS）。macOS のローカルで Electron を起動し、CDP で画面・配色・キーボード操作・CSP の違反を確かめた（模擬。Windows の実機・実際の読み上げソフト・タッチ操作は未実施）。
- 追記（2026-10-22、#74）: UI レビュー 2 回目（新しいレビュワー 2 人）とコードレビューを受け、約束を足した（下の「UI レビュー 2 回目の追記」）。
- 追記（2026-10-21、#74）: 独立した 2 人の見た目のレビュー（UI レビュー 1 回目）を受け、画面の骨格・色・文言・読み上げを作り直した。決めたことは下の「画面の骨格とデザインの約束」「コントラスト」。B01 の画面（#71）・登録の画面（#66）・中枢の画面（#74、ADR 0026）に同じ約束を当てる。
- 根拠: 本人の指示（2026-10-21）「UI は HeroUI を使用する。すでにある UI は作り直す」。以後の画面もすべて HeroUI で作る。画面の内容・IPC は ADR 0014・0015 のまま変えない。CSP・sandbox・contextIsolation は ADR 0015 のまま弱めない。

## 決めたこと

| 対象             | 決定                                                                                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 部品             | 画面の部品は HeroUI（`@heroui/react`）を使う。HeroUI にない見た目だけの配置（並べ方・余白）は Tailwind CSS のクラスで書く。独自のボタン・カード・警告の部品を作らない                                                                                                         |
| 入れる場所       | UI レンダラー（`src/renderer`）だけ。main・preload は HeroUI・Tailwind CSS・React Aria を読み込まない（main の Ajv などはそのまま）                                                                                                                                           |
| スタイル         | Tailwind CSS v4 の Vite プラグイン（`@tailwindcss/vite`）で、HeroUI のスタイルと画面のクラスをビルド時に一つの CSS ファイル（`dist/renderer/assets/*.css`）へ出す。実行時に CSS を作らない                                                                                    |
| ライト・ダーク   | OS の設定（`prefers-color-scheme`）に従う。HeroUI のテーマは html の `class="dark"` と `data-theme` で切り替わるため、`app/theme.ts` が `matchMedia` を読み、変わったら追従する。手動の切り替えは置かない                                                                     |
| 共通の Provider  | HeroUI v3 は Provider を要求しない。`app/AppProviders.tsx` に React Aria の `I18nProvider`（`ja-JP`）だけを置き、部品の内部の読み上げの文言・日付の書式を日本語にする                                                                                                         |
| 画面の内容と IPC | 表示する項目・操作・preload の `invoke`／`onNotification`・`DesktopStatusBar` は ADR 0014・0015 のまま。再開は「この端末の停止」のときだけ出し、画面が表示している io_epoch を `expected_io_epoch` で送る。文言（`labels.ts`）は UI レビュー 1 回目で書き直した（下の約束 7） |
| CSP・sandbox     | 変えない（`default-src 'none'; script-src 'self'; style-src 'self'; …`、sandbox、contextIsolation、nodeIntegration 無効）。下の「CSP との関係」                                                                                                                               |
| 開発用のサーバー | 使わない（ADR 0015 のまま）。画面を変えたら `pnpm --filter @buddy/desktop dev` で起動し直す                                                                                                                                                                                   |

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
  index.html              CSP の meta と、React Aria・input-otp の style の差し込みを省かせる空の template
  main.tsx                入口（配色の追従を始め、AppProviders で包む）
  App.tsx                 画面の切り替え（登録の画面・端末の画面。中枢の画面の端末なら本体を Tabs にする）
  styles.css              tailwindcss → @heroui/styles の順で読み込む。テーマの変数の上書きはここの 1 か所だけ
  labels.ts               画面の文言（拒否・失敗の文言は「何が起きたか」と「次に何をするか」）
  tones.ts                状態の色と記号の対応表（全画面で共有）
  format.ts               時刻・期限・指紋の書き方（純粋な関数）
  desktop-api.ts          preload の限定 API の型と要求の組み立て
  app/                    画面全体の共通: AppProviders（Provider）・theme（配色）・AppShell（骨格）
  components/             画面をまたぐ部品: StatusBand（状態帯）・StatusText（記号＋文言）・Section（見出しと区切り線の欄）・
                          FingerprintGrid（指紋の 4 × 4 の格子）・AppFooter（閉じる・終了）
  state/                  純粋な関数（desktop-state・connection-state・hub-state・home-state・status-lines）と、限定 API とつなぐフック
  screens/device/         端末の画面: DeviceScreen・StopBanner（停止中の帯）・ConnectionSection・PowerLogDetails
  screens/pairing/        登録の画面: PairingScreen・PairingPanel（手順 1〜4）
  screens/hub/            中枢の画面の本体: HubPanels（Tabs・申請・端末）・ConfirmDialog（ADR 0026）・
                          HomeNetworkPanel（自宅のネットワーク。B03-08、ADR 0022 の追記）
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
- **input-otp が差し込む style 要素**（UI レビュー 1 回目で足したコードの入力）: HeroUI の `InputOTP` が使う input-otp は、`id="input-otp-style"` の要素がなければ `<style>`（選択・自動入力の色を透明にする規則など）を差し込む。React Aria と同じく、規則を `styles.css` に置き、`index.html` に空の `<template id="input-otp-style">` を置いて省かせた。JavaScript を切ったとき用の `<noscript>` の style も `noScriptCSSFallback={null}` で出さない。
- **AlertDialog・Tabs・Disclosure**: 確認の AlertDialog（React Aria の Modal）、中枢の画面の Tabs、電源とロックの記録の Disclosure は、style 要素を差し込まず、要素の `style` プロパティ（CSSOM）だけを書く。Electron で開閉・切り替えを行い、`securitypolicyviolation` が 0 件であることを確かめた（下の「検証」）。
- **ビルド後の検査**（`src/main/renderer-build.test.ts`）: `dist/renderer/index.html` の CSP の meta、インラインのスクリプト・style 要素・style 属性・イベント属性がないこと、参照するファイルと出力したすべてのファイルが `buddy://app/` で返せる種類であること、上の 2 つの template と、touch-action・input-otp の規則がビルドに入っていること、CSS の外部の読み込み・JavaScript の eval がないことを確かめる。

## 以後の画面の約束

1. 画面は `screens/<名前>/` に置き、`App.tsx` で切り替える。画面の部品は HeroUI の部品で作り、状態と操作は引数で受け取る。限定 API とつなぐのは `state/` のフック（画面ごとに足してよい）。
2. 共通の Provider は `app/AppProviders.tsx` に、画面の枠は `app/AppShell.tsx` に足す。画面ごとに Provider を作らない。
3. 色は HeroUI のテーマの変数（`bg-background`・`text-foreground`・`text-muted`・`border-border` など）と部品の `color`／`variant`／`status` だけを使い、ライト・ダークの両方で見えることを確かめる。状態は色だけでなく文言と記号でも示す（設計 01）。
4. 操作は HeroUI の `Button`（React Aria）の `onPress` で受ける。キーボード（Tab・Enter・Space）で届くこと、欄に `aria-label` か見出しがあること、警告は `role="alert"` で出すことを確かめる。
5. CSP・sandbox・contextIsolation を弱めない。新しい部品（Modal・Toast・Tooltip など）を使う画面では、Electron で `securitypolicyviolation`（コンソールの CSP 違反）が 0 件であることを確かめる。違反が出たら、まず弱めずに済む方法（ビルド時の CSS に移す・差し込みを省かせる）を探し、CSP の変更が要るなら実装せずに本人の判断に回す。
6. 依存は正確な版で足し、公開からの経過期間の方針を満たす版を選ぶ（除外の設定を足さない）。install 時にビルドが要る依存は、`allowBuilds` に足す前に報告する。

## 画面の骨格とデザインの約束（UI レビュー 1 回目、#74）

独立した 2 人のレビュー（使いやすさ・情報設計、日本語の組版・色・アクセシビリティ）の指摘を、司令塔がまとめた決定どおりに直した。以後の画面もこの約束で作る。

### 骨格

すべての画面を `AppShell` の次の順に並べる。

1. 上端の細い帯: 「Buddy」と画面の役割（「この端末」「この端末（未登録）」「中枢の画面」）。
2. 状態帯（`StatusBand`、全画面で共通）: 1 行目に「入出力:」とこの端末の入出力（`text-base font-semibold` の記号＋文言）と、右に停止のボタン（`danger-soft`・1 回で効く。確認を挟まない。main が止まっていることを確かめた後は出さない）。2 行目に「中枢:」と中枢との接続（最終確認の時刻・次の接続の時刻）。下に区切り線を引き、中枢が正本の項目（表示先・音声・保存モード・予算保留・安全停止）と「（— は中枢から未受信）」を 1 行に小さく並べる。
3. 今やること（必要なときだけ）: 停止中の帯（`StopBanner`）・再登録が必要な理由の警告・登録の知らせ。
4. 本体: 登録のフォーム、中枢との接続の欄、中枢の画面なら Tabs（承認待ちの申請・登録済みの端末・この端末）。
5. 詳細: 電源とロックの記録（Disclosure に畳み、件数を出す。開くと直近の 5 件）。
6. フッター: 「ウィンドウを閉じる」「Buddy を終了」（`ghost`・`sm`）と「閉じてもトレイに残ります。終了しても中枢は止まりません。」

ロック中・ロック状態不明では、状態帯（内容を隠した旨と停止）とフッターだけを出す。

### 状態帯の項目（ADR 0014 の「いつも見える状態」）

ADR 0014 は状態欄（DesktopStatusBar）を設計 01「いつも見える状態」の表示とし、入出力・中枢との接続・最終確認に加えて、表示先・音声・保存モード・予算保留・安全停止を項目として定めている（中枢が正本で、受け取るまでは null）。常に見せる項目と判断し、Disclosure に畳まずに状態帯の下に小さく並べた。値のないものは「—」（muted）にし、同じ行の最後に「（— は中枢から未受信）」を出す（すべて受け取ったら出さない。UI レビュー 2 回目で、960×680 で中枢の画面の申請が画面に収まるよう 1 行にまとめた）。「世代」（io_epoch）は画面に出さない（再開の要求には使う）。

### 約束

1. **書体**: `--font-sans` に日本語の書体（-apple-system・Segoe UI・Hiragino Sans・Yu Gothic Medium・Meiryo など）を明示する。16 進・コード・宛先は `font-mono`、時刻と桁数は `tabular-nums`。html・body に `word-break: auto-phrase; line-break: strict;`。説明は `leading-6`、行の長さは `max-w-prose` 程度。
2. **文字の段階**（4 段）: 見出し `text-base font-semibold`（h2）／本文 `text-sm leading-6`／補足 `text-xs text-muted`／強調する状態 `text-base font-semibold`＋状態の色。指紋とコードは `font-mono` の `text-lg` 以上。
3. **余白**（3 段）: `gap-2`（同じ行の並び・ボタンの並び）／`gap-4`（欄の中の要素の間）／`gap-6`（欄と欄の間）。部品の内側（ラベルと補足、記号と文言）だけ `gap-1`〜`gap-1.5` を使う。ページは `px-4 py-5`。
4. **色と記号の対応表**（`tones.ts`、`labels.ts` と組で使う）: success＝受付中・接続中（●）／warning＝要対応（再登録・前面に出す・接続し直し待ち。⚠・○）／danger＝失敗・取り消せない操作（⚠）／中立（既定の文字色・muted）＝未登録・未受信・本人が意図した停止（■・—）／進行中＝Spinner。状態は必ず「記号＋文言」で示し、色だけに頼らない。⚠ は HeroUI の `WarningIcon`、補足の印は `InfoIcon`（単色の SVG）。色絵文字（🔒 など）と「？」は使わない。accent は「その画面で前に進む操作 1 つ」だけに使う。
5. **コントラスト**: 文字 4.5:1・文字でないもの（境界・フォーカスの枠・記号）3:1 を `scripts/contrast.test.mjs` で測り、下の「コントラスト」に残す。テーマの変数の上書きは `styles.css` の 1 か所だけ。
6. **部品の使い分け**: Card は状態帯と入力フォーム（登録）だけ。一覧・記録・接続の欄は見出しと区切り線の `Section`。Alert は「結果」と「要対応」に限り、本文は `text-foreground`（登録の知らせは停止の帯と同時に出さない）。ボタンの重さは 3 段階: primary（その画面の主操作 1 つ）・danger-soft（停止・拒否・失効）／secondary（確かめて進む・やめる・取り直す）／ghost（閉じる・終了・一覧の取り直し）。指紋の確認の「最後の 4 桁を確かめて次へ」と「一致しない（やめる）」は同じ重さ（secondary）にする。Chip は主状態に使わない。角丸は `--radius: 0.375rem`（ボタンの錠剤型をやめる）、影と左の色の縁は使わない。
7. **文言**: 開発の段階名（B0x）・内部の理由のコード・「世代」の語を画面に出さない（理由は対応表で文言にする）。拒否・失敗は「何が起きたか」と「次に何をするか」を 2 文以内で書き、押したボタンのすぐ下に出す。状態が変わる・次の操作を始めると消す。敬体、ラベルは名詞止め、ボタンは動詞で終える。押せないボタンは置かず（無効にせず）、押したら欄の下（FieldError）に理由を出す。例外は、操作の最中で main が受け付けないもの（受取りの要求の最中の「申請をやめる」は main の `cancelable` に従って無効にする。ADR 0025）と、確認の後に結果を待っている間の承認・拒否・失効。main が宛先・4 桁を拒否したときも、その欄の下に出す。
8. **読み上げ**: ライブ領域（`role="status"`）は状態帯の入出力の 1 行と、進行中の 1 行（受け取っている・申請している・承認を待っている）だけ。時刻が変わる値はライブ領域に入れない。拒否・失敗は `role="alert"`。section は `aria-labelledby` で見出しと結ぶ。`p` に `aria-label`・`aria-labelledby` を付けない。
9. **時刻**: 今日の分は時刻だけ（`16:15:55`）、それ以外は月日を付ける。次の接続は「次は 16:16:10（4 秒後）」、期限は「16:20 まで（残り 4 分）」。

## UI レビュー 2 回目の追記（2026-10-22、#74）

新しいレビュワー 2 人（使いやすさ・情報設計、組版・色・アクセシビリティ）とコードレビュー（PR #77）の指摘を、司令塔がまとめた決定（round2-consolidated）どおりに直した。上の約束に次を足す。

1. **停止のボタン**: main が止まっていることを確かめた後（停止の範囲が none でない）は、状態帯の停止のボタンを出さない。止まっている端末で押しても何も変わらず（domain の `stopLocally` は止まっていれば何もしない）、主状態の「■ 停止中」と取り違えるため。ロック中・ロック状態不明・未受信では出したままにし、トレイの「この端末の入出力を停止」もいつでも使える。ADR 0014 の「いつでも停止できる」は、止まっていない端末をいつでも 1 回で止められることとして保つ。
2. **Alert の記号と重さ**: danger・warning の Alert には `Alert.Indicator` に ⚠（`WarningIcon`）を付け、面に `--danger-soft`・`--warning-soft` を敷いてカードと区別する。本人が止めた停止の帯は中立（■）、登録の知らせは ●。ペアリングの失敗は、証明書が変わった（ピン留めが外れた警報）だけ danger、ほかは warning。同じことを 2 つの Alert で言わない（登録し直している途中は再登録の警告を 1 行に縮め、失敗したときは失敗の Alert だけにする）。
3. **--danger を文字に使う部品**: `--danger` は塗りのボタンの面の色で、ダークの面の上の文字としては 3.45:1 に届かない（`--danger` 1 つの値では白文字の面と面の上の文字を両立できない）。FieldError・無効なラベル・必須の * の文字は、`styles.css` の components 層で `--danger-soft-foreground` に寄せる。必須の * は読み上げで「必須」と読ませる（`content: '*' / '必須'`）。
4. **角丸**: Tabs（一覧・タブ・選ばれた印）と確認のダイアログ・その記号も `--radius-lg` にそろえ、錠剤型と影をやめる。
5. **中枢の画面**: 申請が 1 件以上あるときは「承認待ちの申請」を「新しい端末を登録する」より先に置く。確認コード（`text-2xl font-semibold`）はワンタイムコード（`text-xl`）より目立たせ、それぞれに役割（「承認の前に、申請した端末の画面と見比べる 8 桁」「登録する端末に入力する 8 桁」）を添える。期限切れ・申請に使われたコードは表示に残さない。操作の結果の文言は押した行のすぐ下に出し、タブの切り替えと「一覧を更新」で消す（定期の取り直しでは消さない）。「一覧を更新」は outline の小さなボタンにする。
6. **確認のダイアログ**: 本文は `text-foreground`。承認では確認コードを大きな等幅（`text-2xl`）の別の段に出し、題に OS と申請の時刻を入れる。ボタンの読み上げの名前に端末名を入れる（「『合成の端末』を失効する」など）。
7. **登録の画面**: 端末の画面の指紋の格子では最後の組を伏せる（ADR 0025）。失敗の画面でも「手順 n / 4」を残し、ボタンは「最初からやり直す」「宛先を直す」「確かめたので、もう一度登録する」のように何が起きるかを書く。接続できないときは試した宛先を、受取りの結果が分からないときは申請した端末名を本文に入れる。手順名は欄のラベルと重ねない（手順 1 は「宛先の入力」）。
8. **文言と記号**: 失効済みは中立の ○（muted、新しい tone `muted`）、自宅の判定は `StatusText`（記号は対応表）、電源とロックの記録の出どころは「OS の通知」「Buddy が確かめた」、表示している件数より多いときは「直近 5 件を表示しています（ほか n 件）」。開発の語（main）を出さない（「画面と Buddy の本体の間で通信できませんでした。Buddy を終了して、開き直してください。」）。段落は `text-wrap: pretty` にして、文節の折り返しの凸凹を減らす。

## コントラスト

`scripts/contrast.test.mjs` が HeroUI 3.2.6 の `variables.css` と `styles.css` の上書きを読み、oklch・`color-mix(in oklab)` を解いて WCAG 2.2 のコントラスト比を測る（`pnpm test` に含む）。色の計算（OKLab ⇔ sRGB・相対輝度）は試験の中で書き、白と黒の 21:1・#767676 と白の 4.54:1 などの既知の値で計算そのものも確かめる。

上書きした値（HeroUI の既定では足りなかったもの）:

| 変数             | ライト                      | ダーク                    | 理由                                                                    |
| ---------------- | --------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `--accent`       | `oklch(0.54 0.15 253.83)`   | `oklch(0.56 0.16 253.83)` | 白文字の primary ボタン（既定はライト 3.59:1）。フォーカスの枠にも効く  |
| `--danger`       | `oklch(0.56 0.19 25.74)`    | `oklch(0.56 0.19 25.74)`  | danger の文字・danger-soft の文字（既定はライト 3.48:1 の白文字）       |
| `--muted`        | `oklch(0.51 0.0138 285.94)` | （既定のまま）            | 地・入力欄・選ばれていないタブの上の補足（既定は地で 4.43:1）           |
| `--field-border` | `oklch(0.64 0.006 286)`     | `oklch(0.56 0.006 286)`   | 入力欄の境界（既定は境界なし）                                          |
| `--border`       | （既定のまま）              | `oklch(0.4 0.006 286)`    | ダークでカード・Alert の縁が見えるように（既定は面に対して 1.2:1 前後） |
| `--separator`    | （既定のまま）              | `oklch(0.36 0.006 286)`   | ダークの区切り線                                                        |

測った値（2026-10-22、`node --test scripts/contrast.test.mjs` の出力。前景が半透明のときは背景に重ねた色で測る。説明には実際に測っている変数を書く）:

| 組み合わせ（使っている変数）                                                         | 下限  | ライト                           | ダーク                           |
| ------------------------------------------------------------------------------------ | ----- | -------------------------------- | -------------------------------- |
| 本文 --foreground / カード --surface                                                 | 4.5:1 | 17.72:1（`#18181b` / `#ffffff`） | 17.27:1（`#fcfcfc` / `#18181b`） |
| 本文 --foreground / 地 --background                                                  | 4.5:1 | 16.25:1（`#18181b` / `#f5f5f5`） | 19.79:1（`#fcfcfc` / `#060607`） |
| 補足 --muted / カード                                                                | 4.5:1 | 5.77:1（`#65656e` / `#ffffff`）  | 6.74:1（`#9f9fa9` / `#18181b`）  |
| 補足 --muted / 地                                                                    | 4.5:1 | 5.29:1（`#65656e` / `#f5f5f5`）  | 7.72:1（`#9f9fa9` / `#060607`）  |
| primary ボタン --accent-foreground / --accent                                        | 4.5:1 | 4.97:1（`#fcfcfc` / `#216fc3`）  | 4.57:1（`#fcfcfc` / `#1e74cf`）  |
| danger（塗り）ボタン（確認の「拒否する」「失効する」）--danger-foreground / --danger | 4.5:1 | 4.99:1（`#fcfcfc` / `#cc3334`）  | 4.99:1（`#fcfcfc` / `#cc3334`）  |
| secondary ボタン --accent-soft-foreground / --default（地）                          | 4.5:1 | 6.50:1（`#24548c` / `#ebebec`）  | 5.13:1（`#639ade` / `#27272a`）  |
| secondary ボタン --accent-soft-foreground / --default（カード）                      | 4.5:1 | 6.50:1（`#24548c` / `#ebebec`）  | 5.13:1（`#639ade` / `#27272a`）  |
| tertiary ボタン（確認の「やめる」）--default-foreground / --default                  | 4.5:1 | 14.86:1（`#18181b` / `#ebebec`） | 14.52:1（`#fcfcfc` / `#27272a`） |
| ghost・outline ボタン（閉じる・終了・一覧を更新）--default-foreground / 地           | 4.5:1 | 16.25:1（`#18181b` / `#f5f5f5`） | 19.79:1（`#fcfcfc` / `#060607`） |
| danger-soft ボタン（停止）--danger-soft-foreground / --danger-soft（カード）         | 4.5:1 | 6.80:1（`#862f2d` / `#f7e0e0`）  | 5.12:1（`#e0726a` / `#331c1f`）  |
| danger-soft ボタン（拒否・失効）--danger-soft-foreground / --danger-soft（地）       | 4.5:1 | 6.28:1（`#862f2d` / `#efd8d8`）  | 5.99:1（`#e0726a` / `#230c0e`）  |
| success の文字・記号 --success-soft-foreground / カード                              | 4.5:1 | 5.48:1（`#2b7745` / `#ffffff`）  | 10.11:1（`#74d88f` / `#18181b`） |
| success の文字・記号 --success-soft-foreground / 地                                  | 4.5:1 | 5.03:1（`#2b7745` / `#f5f5f5`）  | 11.59:1（`#74d88f` / `#060607`） |
| warning の文字（拒否の文言）--warning-soft-foreground / カード                       | 4.5:1 | 5.71:1（`#855f2e` / `#ffffff`）  | 11.72:1（`#f9cb86` / `#18181b`） |
| warning の文字（拒否の文言）--warning-soft-foreground / 地                           | 4.5:1 | 5.24:1（`#855f2e` / `#f5f5f5`）  | 13.43:1（`#f9cb86` / `#060607`） |
| FieldError・無効なラベル・必須の * --danger-soft-foreground / カード                 | 4.5:1 | 8.52:1（`#862f2d` / `#ffffff`）  | 5.73:1（`#e0726a` / `#18181b`）  |
| FieldError・無効なラベル・必須の * --danger-soft-foreground / 地                     | 4.5:1 | 7.81:1（`#862f2d` / `#f5f5f5`）  | 6.57:1（`#e0726a` / `#060607`）  |
| Alert danger の題 --danger-soft-foreground / --danger-soft（カードの上）             | 4.5:1 | 6.80:1（`#862f2d` / `#f7e0e0`）  | 5.12:1（`#e0726a` / `#331c1f`）  |
| Alert danger の本文 --foreground / --danger-soft（地の上）                           | 4.5:1 | 13.06:1（`#18181b` / `#efd8d8`） | 18.06:1（`#fcfcfc` / `#230c0e`） |
| Alert warning の題 --warning-soft-foreground / --warning-soft（地の上）              | 4.5:1 | 4.76:1（`#855f2e` / `#f5e9d6`）  | 11.27:1（`#f9cb86` / `#231b10`） |
| Alert warning の本文 --foreground / --warning-soft（カードの上）                     | 4.5:1 | 15.94:1（`#18181b` / `#fef2de`） | 13.57:1（`#fcfcfc` / `#332b21`） |
| 選ばれていないタブ --muted / --default                                               | 4.5:1 | 4.83:1（`#65656e` / `#ebebec`）  | 5.66:1（`#9f9fa9` / `#27272a`）  |
| 選ばれたタブ --segment-foreground / --segment                                        | 4.5:1 | 17.72:1（`#18181b` / `#ffffff`） | 9.13:1（`#fcfcfc` / `#46464c`）  |
| 確認のダイアログの本文（text-foreground）--foreground / --overlay                    | 4.5:1 | 17.72:1（`#18181b` / `#ffffff`） | 17.27:1（`#fcfcfc` / `#18181b`） |
| 入力欄の文字 --field-foreground / --default（secondary の Input）                    | 4.5:1 | 14.86:1（`#18181b` / `#ebebec`） | 14.52:1（`#fcfcfc` / `#27272a`） |
| 入力欄の placeholder --field-placeholder / --default                                 | 4.5:1 | 4.83:1（`#65656e` / `#ebebec`）  | 5.66:1（`#9f9fa9` / `#27272a`）  |
| InputOTP の桁 --field-foreground / --field-background                                | 4.5:1 | 17.72:1（`#18181b` / `#ffffff`） | 17.27:1（`#fcfcfc` / `#18181b`） |
| 確認のダイアログの accent のアイコン --accent-soft-foreground / --accent-soft        | 3:1   | 6.33:1（`#24548c` / `#dee9f6`）  | 5.45:1（`#639ade` / `#192331`）  |
| 確認のダイアログの danger のアイコン --danger-soft-foreground / --danger-soft        | 3:1   | 6.80:1（`#862f2d` / `#f7e0e0`）  | 5.12:1（`#e0726a` / `#331c1f`）  |
| 入力欄の境界 --field-border / カード                                                 | 3:1   | 3.37:1（`#8c8c90` / `#ffffff`）  | 3.80:1（`#747478` / `#18181b`）  |
| InputOTP の枠 --field-border / --field-background                                    | 3:1   | 3.37:1（`#8c8c90` / `#ffffff`）  | 3.80:1（`#747478` / `#18181b`）  |
| 無効な入力欄の枠 --danger / カード                                                   | 3:1   | 5.12:1（`#cc3334` / `#ffffff`）  | 3.46:1（`#cc3334` / `#18181b`）  |
| フォーカスの枠 --focus / カード                                                      | 3:1   | 5.10:1（`#216fc3` / `#ffffff`）  | 3.78:1（`#1e74cf` / `#18181b`）  |
| フォーカスの枠 --focus / 地                                                          | 3:1   | 4.68:1（`#216fc3` / `#f5f5f5`）  | 4.33:1（`#1e74cf` / `#060607`）  |
| フォーカスの枠 --focus / --default（タブの一覧・secondary の面）                     | 3:1   | 4.27:1（`#216fc3` / `#ebebec`）  | 3.17:1（`#1e74cf` / `#27272a`）  |
| フォーカスの枠 --focus / --overlay（ダイアログ）                                     | 3:1   | 5.10:1（`#216fc3` / `#ffffff`）  | 3.78:1（`#1e74cf` / `#18181b`）  |

- ダークの合成には、ライトだけに当てる上書き（`:not(.dark)`）を含めない（UI レビュー 2 回目の CR-L4 で直した。直す前もダークの値は同じ）。
- 未測定: 画面の画素（表示環境の色管理で小さな差が出うる）、ハイコントラストの設定、文字の拡大（200%）、無効なボタン（opacity .5。WCAG の対象外。レビュワーの計算で 2.3〜3.6:1）。
- スクリーンショットの画素: macOS の Electron の撮影は Display P3 の画素値で保存されるため、有彩色の 16 進は上の表（CSS の sRGB の値）と一致しない（例: `#cc3334` が `#bc413b`、`#216fc3` が `#396ebd` に写る）。無彩色は一致する。画素から測ると比は 0.1〜0.2 低く出る。判定は CSS の値で行い、画素は裏取りに使う（`--force-color-profile=srgb` で起動すれば一致する）。

## 読み取り（レビュー対象）

原本・本人の指示に明記がなく、実装で決めた点です。

- **peer の版**: react-aria・react-aria-components は最新（3.53.1・1.22.1）ではなく、HeroUI 3.2.6 の公開時点の版（3.52.1・1.21.1）にした。HeroUI が試した組み合わせに近づけるため。HeroUI を上げるときに合わせて上げる。
- **skipLibCheck**: リポジトリの既定は `skipLibCheck: false` だが、HeroUI 3.2.6・react-aria-components 1.21.1 の型定義は `exactOptionalPropertyTypes` の下で型定義の中の衝突（TS2320）を出すため、renderer の二つの tsconfig だけ `true` にした。自分のコードの型検査（strict・exactOptionalPropertyTypes など）は変わらない。main・preload・他のワークスペースは `false` のまま。
- **CSS の大きさ**: `@heroui/styles` を丸ごと読み込むため、使わない部品のスタイルも含めて CSS は約 430 KB（gzip 約 40 KB）。ローカルのファイルなので今は許容し、部品ごとの読み込みは画面が揃ってから判断する。
- **差し込みを省かせる template**: React Aria の内部の実装（id で既存の要素を探す）に依る。React Aria が変われば違反が再び出るが、止められるだけで動作は変わらない（規則は styles.css にある）。ビルド後の検査と、「以後の画面の約束」の 5 の確認で気づける。
- **試験の範囲**: DOM の試験のライブラリ（jsdom・Testing Library など）は足していない（HeroUI が求めるものだけを入れる原則）。表示・読み上げのラベル・ボタンの要素はサーバー描画の HTML で、押したときの要求はボタンの `onPress` を呼んで確かめる。実際のクリック・キーボード操作は Electron の画面で確かめる。DOM の試験を足すかは後続で判断する。
- **見出し**: 欄の見出しは h2（`Section`・登録のフォーム）。Card.Title は使わない。
- **状態の色**: UI レビュー 1 回目で、カードの左の縁と Chip をやめ、記号＋文言と soft-foreground の色（上の約束 4）にした。🔒・？ もやめた。
- **Alert の数**: 停止中の帯と再登録が必要な警告は、どちらも「要対応」として同時に出ることがある（ロックを解いた直後に再登録が必要と分かったときなど）。止まっている入出力と、中枢との登録は別の対処のため、片方を隠さない。
- **余白の段階**: 2 人の提案（gap-2・4・6 と、カード内 gap-3・欄の間 gap-4）が分かれたため、段階の少ない gap-2・4・6 にした。

## 検証

- UI レビュー 2 回目の後（#74、2026-10-22）: 同じ方法で全状態を撮り直した（フォーカスは停止のボタン・宛先の欄・最後の 4 桁の欄・承認のボタン・Tabs・ダイアログのボタンを Tab で確実に撮った）。CSP の違反は 0 件。
- UI レビュー 1 回目の後（#74）: 模擬の Core（`--mock-key-protection`・127.0.0.1）と Electron（`--use-mock-keychain`・一時の userData）を CDP で操作し、全状態をライト・ダークで撮り直した（幅 640px・キーボードのフォーカスを含む。スクリーンショットはリポジトリに入れていない）。確認の AlertDialog・Tabs・Disclosure・InputOTP を開閉・入力した後も `securitypolicyviolation` は 0 件。

- 模擬: `pnpm run check`（renderer の試験・ビルド後の検査を含む）。CI の 3 OS で同じものを実行する。
- ローカルの起動（macOS、模擬の端末状態）: `--user-data-dir` を一時ディレクトリにして Electron を起動し、CDP で次を確かめた。スクリーンショットはリポジトリに入れていない。
  - ライト・ダーク（`prefers-color-scheme` のエミュレーション）で html の class・data-theme と背景が切り替わる。
  - Tab で「停止」「再開」「ウィンドウを閉じる」「終了」の順にフォーカスが移り、フォーカスの枠が出る。Enter・Space で押せる。
  - 再開は、ウィンドウが前面でないと main が `screen_operation_required` で拒否し、`role="alert"` の文言が出る（ADR 0014 のまま）。
  - アクセシビリティの木で、ボタンの名前、status・alert・region（操作・内容・電源とロックの記録）・見出しを確かめた。
  - 再読み込みの後の CSP の違反・コンソールの記録は 0 件。
- 未実施: Windows の実機、実際の読み上げソフト（VoiceOver・ナレーター）、タッチ操作、受付中・ロック中の状態の実機での表示（受付中への再開はウィンドウを前面に出せず未確認。表示はサーバー描画の試験で確認）。

## 残ること

- B04 以降の画面を、この土台と約束で作る。
- DOM の試験のライブラリを足すか、部品ごとの CSS の読み込みにするかの判断。
- Windows の実機での表示・キーボード操作・読み上げの確認（B01-05 の実機確認とまとめてよい）。
