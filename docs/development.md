# 開発手順

## ローカル環境

- 基準: Node.js 24.19.0 / pnpm 12.11.2。24 系 / 固定 pnpm 版の対応範囲は package.json に記載。
- 初回・lockfile 更新後: `pnpm install --frozen-lockfile`。通常の確認: `pnpm run check`。
- package.json と pnpm-lock.yaml は同時に変更する。ワークスペース一覧は pnpm-workspace.yaml の具体的パスで一元管理する（glob は使わない）。
- 開発依存は `pnpm add -Dw <package>@<version>`、各 workspace は `pnpm --filter @buddy/<name> add <package>@<version>`。内部依存には `workspace:*` を使う。
- 初回は `pnpm run hooks:install` も実行する。npm から移行する既存 clone は各 node_modules を削除してから pnpm でインストールする。
- TypeScript は 6.0.3 を固定。typescript-eslint 8.71.2 の対応範囲が `>=4.8.4 <6.1.0` のため、6.1 以上へ単独更新しない。
- `@types/node` は実行環境の Node.js 24 系に合わせ、24.19.2 を固定する。
- Dependabot は TypeScript 6.1 以上と `@types/node` 25 以上を更新対象から除外する。互換範囲内の更新は継続する。上限の見直し時は linter の対応範囲または Node の実行環境・型定義を揃え、lockfile と本手順を更新して全 OS の CI を確認する。
- 共通層の tsconfig は DOM / Node の型を読み込まない。Core / storage / platform のみ Node 型を追加する。
- デスクトップ（apps/desktop）は main・preload が Electron の型定義のため DOM と Node の型を使い、main の純粋なモジュールは DOM なしでも型検査する（tsconfig.pure.json）。UI レンダラーは DOM の型だけを使い、画面は HeroUI と Tailwind CSS で作る（ADR 0024。HeroUI の型定義の都合で renderer の tsconfig だけ skipLibCheck を有効にしている）。lint で UI レンダラーから Electron・Node・`@buddy/core`・`@buddy/platform`・`@buddy/client`・ws を、main から中枢・保存・OS アダプターを読み込めないようにしている（ADR 0015）。main は接続の状態機械（`@buddy/client`）・ws・自宅の指紋の収集の出口（`@buddy/platform/home-fingerprint`）だけを読み込め、main の試験と `hub-test-support.ts` だけが同じプロセスで中枢を起動する（ADR 0025）。
- 端末側の接続（packages/client）は Node・DOM の型を読み込まない（tsconfig.json）。試験と模擬だけを Node の型で型検査する（tsconfig.test.json）。
- デスクトップの開発起動は `pnpm --filter @buddy/desktop dev`（[apps/desktop/README.md](../apps/desktop/README.md)）。初回の起動で Electron のバイナリを取得する。`pnpm install` と CI では取得しない。
- `.env` は現段階では不要。個人の認証、データ、設定はリポジトリ外または gitignore 対象に置く。

## Codex / Claude Code

既に利用している各 CLI / アプリで、このリポジトリのルートを作業ディレクトリとして開く。CLI を使う場合:

```sh
codex
```

または:

```sh
claude
```

共通指示は AGENTS.md の一か所で管理する。CLAUDE.md は `@AGENTS.md` で読み込む。Windows の symlink 設定に依存しない。
各製品へのログインとモデル選択は本人の環境で行う。共有の API キー、承認を省略する設定、固定モデル指定は追加していない。

Codex のクラウド環境を使う場合も Node.js の版を合わせ、セットアップコマンドを `pnpm install --frozen-lockfile` にする。パッケージ取得には npm registry への通信が必要。検証コマンドは `pnpm run check`。
ホスト側の環境登録やアカウント連携はリポジトリのファイルとは別の設定である。

## 二つのエージェントで作業する場合

同じディレクトリを同時編集せず、タスクごとにブランチと worktree を作る。main を最新にしてから、例えば次のように分ける。

```sh
git worktree add ../Buddy-codex -b b00/contract-inventory
git worktree add ../Buddy-claude -b review/contract-inventory
```

各 worktree で `pnpm install --frozen-lockfile` と `pnpm run hooks:install` を行う。最初は一方が契約一覧を作成し、もう一方はそのコミットを取り込んで設計との対応をレビューする。二つの独立した契約体系を同時に作らない。レビュー対象のコミット SHA と変更範囲を明記する。

## 試験と CI

GitHub Actions は Ubuntu / Windows / macOS で同じ `pnpm install --frozen-lockfile` と `pnpm run check` を実行する。
権限は contents: read、外部 API キーや実データは不要。Actions は取得時点の commit SHA で固定している。

起動待ちと接続直後の発言の不安定さについては、[Issue #108 の調査と修正](issue-108-windows-ci.md)を参照する。

- `scripts/*.test.mjs`: lint 設定が禁止した直接 import を実際に拒否するかを検証。
- 製品の TypeScript 試験: 対象 workspace の `src/**/*.test.ts` に追加し、ビルド後の `dist/**/*.test.js` を実行。
- デスクトップは Electron を import しない main の純粋なモジュール、UI レンダラーの純粋なモジュールとサーバー描画（react-dom/server）、ビルド後の画面の CSP の検査を試験し、Electron 本体は CI で起動・取得しない。実機の確認は B01-05。
- `tests/integration/**/*.test.mjs`: モックや故障注入の試験を後続で追加。
- `pnpm test` の前に TypeScript をビルドする。`pnpm run check` はビルドを含む。workspace 間の import は依存先の `dist` の型定義を読むため、`pnpm run check` はビルド（依存順）を型検査より先に行う。クリーンな状態（`node scripts/clean.mjs` の後）でも通ることを確かめる。
- 非公開資料を CI へ持ち込まない。`pnpm run design:check` はローカルに非公開 manifest がある場合だけ使う。
- 情報管理と履歴確認は [公開前確認](public-release.md) を参照する。
- スキーマ・生成型・OpenAPI は `pnpm run contracts:check` で検査し、`pnpm run check` に含める。型の更新は `pnpm run contracts:generate`。わざと壊した契約が落ちることも `scripts/contract-gate.test.mjs` で確かめる。CI 合格は製品動作の完成を意味しない。
- 直接 import の静的検査は依存境界を守る補助であり、サードパーティーの推移的依存や実行時隔離を証明しない。
- 実機の音声停止、OS 鍵管理、実請求は該当工程で別に検証する。

## 公式資料

- [Codex の AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Claude Code の共有指示と import](https://code.claude.com/docs/en/memory)
- [Node.js リリース方針](https://nodejs.org/en/about/previous-releases)
- [pnpm workspace](https://pnpm.io/workspaces)
