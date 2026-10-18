# 開発手順

## ローカル環境

- 基準: Node.js 24.19.0 / pnpm 12.11.2。24 系 / 固定 pnpm 版の対応範囲は package.json に記載。
- 初回・lockfile 更新後: `pnpm install --frozen-lockfile`。通常の確認: `pnpm run check`。
- package.json と pnpm-lock.yaml は同時に変更する。ワークスペース一覧は pnpm-workspace.yaml の具体的パスで一元管理する（glob は使わない）。
- 開発依存は `pnpm add -Dw <package>@<version>`、各 workspace は `pnpm --filter @buddy/<name> add <package>@<version>`。内部依存には `workspace:*` を使う。
- 初回は `pnpm run hooks:install` も実行する。npm から移行する既存 clone は各 node_modules を削除してから pnpm でインストールする。
- TypeScript は 6.0.3 を固定。typescript-eslint 8.71.1 の対応範囲が 6.1 未満のため、7 系へ単独更新しない。
- 共通層の tsconfig は DOM / Node の型を読み込まない。Core / storage のみ Node 型を追加する。
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

- `scripts/*.test.mjs`: lint 設定が禁止した直接 import を実際に拒否するかを検証。
- 製品の TypeScript 試験: 対象 workspace の `src/**/*.test.ts` に追加し、ビルド後の `dist/**/*.test.js` を実行。
- `tests/integration/**/*.test.mjs`: モックや故障注入の試験を後続で追加。
- `pnpm test` の前に TypeScript をビルドする。`pnpm run check` はビルドを含む。
- 非公開資料を CI へ持ち込まない。`pnpm run design:check` はローカルに非公開 manifest がある場合だけ使う。
- 情報管理と履歴確認は [公開前確認](public-release.md) を参照する。
- 初回範囲のスキーマ・生成型・OpenAPI は `pnpm run contracts:check` で検査し、`pnpm run check` に含める。型の更新は `pnpm run contracts:generate`。CI 合格は全契約や製品動作の完成を意味しない。
- 直接 import の静的検査は依存境界を守る補助であり、サードパーティーの推移的依存や実行時隔離を証明しない。
- 実機の音声停止、OS 鍵管理、実請求は該当工程で別に検証する。

## 公式資料

- [Codex の AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Claude Code の共有指示と import](https://code.claude.com/docs/en/memory)
- [Node.js リリース方針](https://nodejs.org/en/about/previous-releases)
- [pnpm workspace](https://pnpm.io/workspaces)
