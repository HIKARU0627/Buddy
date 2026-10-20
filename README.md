# Buddy

生活・学習・開発を支える、デバイスに依存しない個人 AI アシスタント。

現在は **B00（契約のファイル化）の初回範囲を作成した段階** です。入力・ラベル変更・承認受付・状態通知・予算記録の JSON Schema、対象経路の OpenAPI、生成型と合成例を検査できます。製品の Core / UI、DB マイグレーション、全 API・全意図の契約は未完成です。B00 全体の完了を意味しません。

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
- [契約検証ツールと初回の具体化](docs/adr/0002-contract-validation.md)
- [共通表現と用途別の版](docs/adr/0003-common-representation.md)
- [意図表・実行可否と入力から結果までの契約](docs/adr/0004-intent-table-and-readiness.md)
- [会話・委譲・音声制御・出力先の契約](docs/adr/0005-conversation-and-voice-control.md)
- [予約 R・最大負担 M と精算の契約](docs/adr/0006-budget-reservation-and-liability.md)
- [同期世代・抽出 v2・関連解析の契約](docs/adr/0007-sync-extraction-and-related-analysis.md)
- [記憶・忘却とモデル評価の交換形式](docs/adr/0008-memory-forgetting-and-model-evaluation.md)
- [OpenAPI・認証・イベント・再接続の契約](docs/adr/0009-openapi-auth-events-and-reconnect.md)
- [AI の役割分担と採用条件](docs/design/model-routing.md)

## 構成

| 場所                 | 責務・現在の状態                                                     |
| -------------------- | -------------------------------------------------------------------- |
| `packages/contracts` | 初回の JSON Schema / OpenAPI / 生成型 / 合成例。全体は B00 で継続    |
| `packages/domain`    | 認可・承認・状態遷移などの純粋な規則。境界仕様は B00 で作成          |
| `packages/storage`   | Core の保存アダプター。マイグレーション案は B00 で作成               |
| `apps/core`          | Electron から独立した Node.js 中枢。現在は型検査・ビルド用の空の入口 |
| `apps/desktop`       | 将来の Electron / React クライアントの配置先。B02 で実装             |
| `tests`              | 合成データ・統合試験の配置先。製品試験は未実装                       |
| `scripts`            | 環境確認、設計資料の整合検査、試験実行                               |
| `docs/design`        | 公開できる設計概要と非公開原本の参照手順                             |

## コマンド

| コマンド                      | 用途                                                   |
| ----------------------------- | ------------------------------------------------------ |
| `pnpm run doctor`             | Node / pnpm とワークスペース確認                       |
| `pnpm run check`              | 書式・lint・型・ビルド・試験・資料の整合を一括検証     |
| `pnpm run format`             | ソースと開発資料の書式修正                             |
| `pnpm run lint`               | 静的解析と直接 import の依存方向検査                   |
| `pnpm run typecheck`          | 全ワークスペースの厳格な型検査                         |
| `pnpm run build`              | 全ワークスペースを `dist/` へビルド                    |
| `pnpm test`                   | 開発基盤と契約境界の合成検査。実 API・製品統合は未実施 |
| `pnpm run contracts:generate` | JSON Schema から TypeScript 型を再生成                 |
| `pnpm run contracts:check`    | 生成差分、Schema、OpenAPI、合成例を検証                |
| `pnpm run security:check`     | 公開対象に非公開情報が混入していないか確認             |

Codex は [AGENTS.md](AGENTS.md)、Claude Code は [CLAUDE.md](CLAUDE.md) から同じ共通指示を読みます。

公開前は `pnpm run public:check` で全履歴も確認してください。削除前の非公開設計資料が過去の履歴に残るため、現在の CI 合格だけで Public へ切り替えないでください。詳細は[公開前確認](docs/public-release.md)を参照してください。
