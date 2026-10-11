# Buddy

生活・学習・開発を支える、デバイスに依存しない個人 AI アシスタント。

現在は **B00（契約のファイル化）に着手するための開発環境** です。製品の Core / UI、OpenAPI / JSON Schema、DB マイグレーションは未実装です。CI は環境・型設定・依存境界・公開情報の検査を検証します。

## セットアップ

Node.js **24.19.0** と pnpm **12.11.2** を基準にします。`.node-version` / `.nvmrc` を利用するか、対応する Node.js をインストールしてください。macOS / Windows / Linux 共通で、Docker や外部 API キーは不要です。

```sh
git clone https://github.com/HIKARU0627/Buddy.git
cd Buddy
npm install --global pnpm@12.11.2
pnpm install --frozen-lockfile
pnpm run hooks:install
pnpm run check
```

npm は pnpm の初回導入だけに使います。hook の準備時に公式 Gitleaks を検証付きで取得し、その後の検証は外部サービスへ接続しません。ローカルでも CI と同じ `pnpm run check` を使います。アプリ起動コマンドは B01 / B02 で追加します。

## 最初に読むもの

- [B00 の作業順・終了条件](docs/b00/README.md)
- [契約と設計・試験の対応表](docs/b00/contract-map.md)
- [設計原本と公開資料の分離](docs/design/README.md)
- [情報管理と公開前確認](docs/public-release.md)
- [開発手順・Codex / Claude Code](docs/development.md)
- [開発基盤の選定理由](docs/adr/0001-development-baseline.md)

## 構成

| 場所                 | 責務・現在の状態                                                     |
| -------------------- | -------------------------------------------------------------------- |
| `packages/contracts` | API / イベント / ワイヤ契約。B00 用の配置先                          |
| `packages/domain`    | 認可・承認・状態遷移などの純粋な規則。境界仕様は B00 で作成          |
| `packages/storage`   | Core の保存アダプター。マイグレーション案は B00 で作成               |
| `apps/core`          | Electron から独立した Node.js 中枢。現在は型検査・ビルド用の空の入口 |
| `apps/desktop`       | 将来の Electron / React クライアントの配置先。B02 で実装             |
| `tests`              | 合成データ・統合試験の配置先。製品試験は未実装                       |
| `scripts`            | 環境確認、設計資料の整合検査、試験実行                               |
| `docs/design`        | 公開できる設計概要と非公開原本の参照手順                             |

## コマンド

| コマンド                  | 用途                                                     |
| ------------------------- | -------------------------------------------------------- |
| `pnpm run doctor`         | Node / pnpm とワークスペース確認                         |
| `pnpm run check`          | 書式・lint・型・ビルド・試験・資料の整合を一括検証       |
| `pnpm run format`         | ソースと開発資料の書式修正                               |
| `pnpm run lint`           | 静的解析と直接 import の依存方向検査                     |
| `pnpm run typecheck`      | 全ワークスペースの厳格な型検査                           |
| `pnpm run build`          | 全ワークスペースを `dist/` へビルド                      |
| `pnpm test`               | Node.js 標準 test runner。初期状態では開発基盤の検査のみ |
| `pnpm run security:check` | 公開対象に非公開情報が混入していないか確認               |

Codex は [AGENTS.md](AGENTS.md)、Claude Code は [CLAUDE.md](CLAUDE.md) から同じ共通指示を読みます。

公開前は `pnpm run public:check` で全履歴も確認してください。削除前の非公開設計資料が過去の履歴に残るため、現在の CI 合格だけで Public へ切り替えないでください。詳細は[公開前確認](docs/public-release.md)を参照してください。
