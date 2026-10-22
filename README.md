# Buddy

生活・学習・開発を支える、デバイスに依存しない個人 AI アシスタント。

現在は **B00（契約のファイル化）の終了条件を満たした段階** です（[ADR 0011](docs/adr/0011-b00-completion-review.md)）。JSON Schema・OpenAPI・生成型、domain の規則、保存マイグレーション案、試験対応表を検査できます。B01 では、Core の起動・状態確認・停止とローカル制御チャネル（[ADR 0012](docs/adr/0012-b01-core-lifecycle-and-local-control.md)）、OS 別の起動・鍵保護のアダプター（ADR 0013）、トレイ常駐と端末状態の記録を持つ最小のデスクトップ（ADR 0014・0015）を実装しました。B02 では SQLite の保存・鍵保護（キーチェーン）・暗号化・DB worker を作り、Core に組み込んで再起動の後の復元と内容 hash の照合を行いました（ADR 0016〜0019、完了判定の下書きは [docs/b02/README.md](docs/b02/README.md)）。B02 の試験は模擬のみで、macOS 実機の確認・電源断と、製品の統合・実 API・実請求の試験は未実施です。B03 では中枢の自己署名証明書（秘密鍵はキーチェーン）・HTTPS の受付・経路検査・接続範囲、ペアリングと失効、自宅の判定、スナップショットと WSS の配信、端末側の接続（`packages/client`）とデスクトップの中枢への接続（ピン留め・safeStorage）、中枢の画面の端末での申請の承認と端末の失効を作りました（ADR 0020〜0023・0025・0026、完了判定の下書きは [docs/b03/README.md](docs/b03/README.md)）。B03 の試験は同じマシンの模擬のみで、Mac mini・Tailscale・別のマシンの実機の確認は未実施です（[docs/b03/device-check.md](docs/b03/device-check.md)）。デスクトップの画面は本人の指示で HeroUI に作り直し、以後の画面も HeroUI で作ります（[ADR 0024](docs/adr/0024-ui-heroui-desktop-renderer.md)）。

B04-06 では文字入力から模擬 provider の変更までの統合実行器を追加し、X01〜X09・X11 と QA28 を固定 seed で確認しました。X10 は工程の仕組みだけ（合格は B14）、QA27 は予定・用事・ラベルの経路分離まで（外部下書き保存は未実装）です。[B04 の完了判定](docs/b04/README.md)と[実機手順（未実施）](docs/b04/device-check.md)を参照してください。表示の移動は B05 です。

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

npm は pnpm の初回導入だけに使います。hook の準備時に公式 Gitleaks を検証付きで取得し、その後の検証は外部サービスへ接続しません。ローカルでも CI と同じ `pnpm run check` を使います。Core の起動方法は [apps/core/README.md](apps/core/README.md)、デスクトップの開発起動は [apps/desktop/README.md](apps/desktop/README.md) を参照してください。

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
- [domain 境界と保存マイグレーション案](docs/adr/0010-domain-boundary-and-storage-draft.md)
- [生成型・CI・試験対応表と B00 の完了判定](docs/adr/0011-b00-completion-review.md)
- [Core のライフサイクルとローカル制御チャネル](docs/adr/0012-b01-core-lifecycle-and-local-control.md)
- [OS 別の起動・監督アダプターと鍵保護不能時の停止](docs/adr/0013-b01-platform-adapters.md)
- [デスクトップの型付き IPC の契約](docs/adr/0014-b01-desktop-ipc-contract.md)
- [デスクトップの最小アプリ（トレイ常駐・端末状態の記録）](docs/adr/0015-b01-desktop-minimal-app.md)
- [SQLite の接続・マイグレーション・耐久設定の検査](docs/adr/0016-b02-sqlite-connection-and-migrations.md)
- [中枢の KeyStore と sealed_blobs の暗号化（AES-256-GCM）](docs/adr/0017-b02-keystore-and-encryption.md)
- [DB worker と操作・承認・受付の保存](docs/adr/0018-b02-db-worker-and-operation-store.md)
- [Core への DB の組み込みと再起動の復元・内容 hash の照合](docs/adr/0019-b02-core-storage-integration.md)
- [中枢の TLS 証明書・HTTPS の受付・経路検査の基盤](docs/adr/0020-b03-https-tls-and-route-checks.md)
- [端末のペアリング・端末の一覧と失効・最初の端末の CLI の承認](docs/adr/0021-b03-device-pairing-and-revocation.md)
- [自宅ネットワークの判定（指紋と Tailscale の直接経路）](docs/adr/0022-b03-home-network-check.md)
- [スナップショット・イベント配信（WSS）・再接続後の復元と操作の経路](docs/adr/0023-b03-snapshot-events-and-operation-routes.md)
- [デスクトップの UI を HeroUI で作る](docs/adr/0024-ui-heroui-desktop-renderer.md)
- [端末側の接続とデスクトップの中枢への接続・2 クライアントの試験](docs/adr/0025-b03-client-desktop-connection.md)
- [中枢の画面の端末で申請の承認と端末の失効を行う](docs/adr/0026-b03-hub-screen-approval.md)
- [下書き・用事の intent、内容版の更新、LocalCommand の遷移、connector の能力と工程の型](docs/adr/0027-b04-operation-kinds-and-transitions.md)
- [模擬 provider・故障注入・Core 側のアダプター（B04-02）](docs/adr/0028-b04-mock-provider.md)
- [発言から操作の作成までの経路と、preview の発行・無効化](docs/adr/0029-b04-turns-interpretation-and-preview.md)
- [実行担当（一度だけの送出・照合・LocalCommand・再起動からの再開）](docs/adr/0030-b04-runner-dispatch-reconcile-local-command.md)
- [デスクトップの会話・変更の確認・処理状況の画面（発言・承認・取消・照合の IPC）](docs/adr/0031-b04-desktop-conversation-approval-screen.md)
- [キャンバスの UI への作り直し（窓の役割・宣言的なキャンバスの記述・流れと区切り）](docs/adr/0032-ui-canvas-stream-and-window-roles.md)
- [AI の役割分担と採用条件](docs/design/model-routing.md)

## 構成

| 場所                  | 責務・現在の状態                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/contracts`  | 初回の JSON Schema / OpenAPI / 生成型 / 合成例。全体は B00 で継続                                          |
| `packages/domain`     | 認可・承認・状態遷移などの純粋な規則。境界仕様は B00 で作成                                                |
| `packages/client`     | 端末側の接続の状態機械（bootstrap・スナップショット・購読・再接続）。Node・DOM・Electron なし（B03）       |
| `packages/storage`    | Core の保存アダプター。SQLite・暗号化・DB worker・内容 hash（B02）                                         |
| `packages/connectors` | 模擬 provider（合成メール・予定）・故障注入・Core 側のアダプター（B04-02。実 provider は B08・B09）        |
| `packages/platform`   | OS 別の起動・監督・鍵保護の可否のアダプター（B01）。Core から使う                                          |
| `apps/core`           | Electron から独立した Node.js 中枢。起動・停止・排他・制御・DB（B01・B02）・HTTPS の受付（B03）            |
| `apps/desktop`        | Electron / React（HeroUI）クライアント。トレイ常駐・端末状態の記録（B01）、中枢への接続・ペアリング（B03） |
| `tests`               | 合成データ・模擬統合実行器・証拠と実施範囲の対応表                                                         |
| `scripts`             | 環境確認、設計資料の整合検査、試験実行                                                                     |
| `docs/design`         | 公開できる設計概要と非公開原本の参照手順                                                                   |

## コマンド

| コマンド                      | 用途                                               |
| ----------------------------- | -------------------------------------------------- |
| `pnpm run doctor`             | Node / pnpm とワークスペース確認                   |
| `pnpm run check`              | 書式・lint・型・ビルド・試験・資料の整合を一括検証 |
| `pnpm run format`             | ソースと開発資料の書式修正                         |
| `pnpm run lint`               | 静的解析と直接 import の依存方向検査               |
| `pnpm run typecheck`          | 全ワークスペースの厳格な型検査                     |
| `pnpm run build`              | 全ワークスペースを `dist/` へビルド                |
| `pnpm test`                   | 開発基盤・契約・模擬統合の検査。実 API は未実施    |
| `pnpm run contracts:generate` | JSON Schema から TypeScript 型を再生成             |
| `pnpm run contracts:check`    | 生成差分、Schema、OpenAPI、合成例を検証            |
| `pnpm run security:check`     | 公開対象に非公開情報が混入していないか確認         |

Codex は [AGENTS.md](AGENTS.md)、Claude Code は [CLAUDE.md](CLAUDE.md) から同じ共通指示を読みます。

公開前は `pnpm run public:check` で全履歴も確認してください。削除前の非公開設計資料が過去の履歴に残るため、現在の CI 合格だけで Public へ切り替えないでください。詳細は[公開前確認](docs/public-release.md)を参照してください。
