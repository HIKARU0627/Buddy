# Buddy — 共通作業指示

Codex と Claude Code はこのファイルを共通の指示として使う。説明・レビュー・引き継ぎは日本語で行う。

## 現在地と参照先

- 現在は B00 の初回契約（ラベル変更経路・入力・予算の記録形式）をファイル化した段階。B00 全体は未完了。契約 CI の成功を製品試験合格として扱わない。
- 初めに README.md、docs/b00/README.md、docs/design/README.md を読む。変更対象に関係する設計本文を確認してから編集する。
- 原本は非公開 Notion。取得資料は .local/design/notion/ に置く。原本の不足を要約から推測しない。更新履歴内の旧コード例を現行仕様と取り違えない。
- B00 では契約と根拠・試験を一緒に更新する。設計の意味が変わる未決事項は docs/b00/contract-map.md に記録し、設計判断として解決する。既存の判断を黙って変更しない。

## コマンド

- Node.js 24.19.0（24 系）、pnpm 12.11.2。依存追加は正確な版を指定し、pnpm-lock.yaml を更新する。
- 初回: `pnpm install --frozen-lockfile`、`pnpm run hooks:install`
- 一括検証: `pnpm run check`
- 個別: `pnpm run lint`、`pnpm run typecheck`、`pnpm run build`、`pnpm test`、`pnpm run security:check`
- TypeScript の試験はビルド後の *.test.js、ツール試験は *.test.mjs を Node.js の標準 test runner で実行する。
- 契約変更時は `pnpm run contracts:generate`。`pnpm run contracts:check` で生成差分・Schema・OpenAPI・合成例を検査する。生成型を直接編集しない。
- 書式修正: `pnpm run format`。Notion スナップショットは再整形しない。

## 設計境界

- Buddy は生活・学習・開発を支える個人アシスタント。開発支援専用に用途を狭めない。
- Core は Electron に依存しない Node.js / TypeScript。初期中枢は Mac mini、PC クライアントは Windows / macOS。
- contracts / domain に Electron・DOM・Node 専用 API を入れない。副作用はアダプターと Core 側へ置く。別ワークスペースの src を相対パスで直接 import しない。
- ワイヤ契約は OpenAPI / JSON Schema を正本とし、TypeScript 型は生成・整合検査する。状態機械・認可・意味検証をスキーマ検証と混同しない。
- LLM とクライアントは承認、実行権限、処理状態、effect_kind の正本にならない。Read / LocalCommand / RemoteMutation の判定はコードが持つ。
- request_revision、content_version + content_hash、state_revision を区別する。ExtractionResult は現行 v2 を使う。
- F01〜F05 / QA41〜QA45 は docs/b00/README.md を起点に再確認する。sealed 単独で実行許可にしない。
- 結果不明の外部変更を自動再送しない。保存・承認・忘却・予算・世代の最終ガードを省略しない。

## 作業と検証

- 1 作業につきブランチ / worktree を分ける。同じ作業ツリーを複数エージェントで編集しない。未依頼の変更を巻き戻さない。
- スコープに関係する正常系・拒否系・境界条件を検証する。期待値を実装と同じ処理で生成しない。
- 模擬試験・実機試験・実 API / 実請求の結果を分け、未実施を明記する。
- API キー、トークン、実メール、実音声、本番 DB、ユーザー固有の認証設定をコミットしない。検証用データは合成する。
- 個人の Codex / Claude Code のモデル・認証・承認設定はリポジトリへ固定しない。
- 最後に変更点、実行した検証、未解決事項、次の着手点を短く報告する。

## 公開リポジトリの情報管理

- docs/public-release.md を読み、Notion 全文・内部 URL・個人設定・実データを公開ファイルへコピーしない。原本とローカル資料は非公開で扱う。
- commit 前に `pnpm run security:staged`、push 前に `pnpm run security:scan`。hook の無効化や強制追加で検査を回避しない。
- 公開前は `pnpm run public:check` で履歴も確認する。現在のファイルの削除だけでは過去の公開を防げない。
- PR・Issue・CI ログ・artifact に秘密や個人情報を出さない。検出値を報告文へ転記しない。
- 外部 PR のコードに秘密情報・書込権限を渡さず、情報管理の設定変更は影響を説明してレビュー対象にする。
