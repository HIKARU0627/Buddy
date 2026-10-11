# ADR 0001: B00 の開発基盤

- 状態: 環境セットアップとして採用
- 日付: 2026-10-11
- 範囲: 開発ツールと配置。製品の未決事項を確定する判断ではない。

## 背景

Notion 設計 02 は Node.js / TypeScript の独立 Core と Electron / React の PC クライアントを採用している。設計 09 は B00 で契約・境界・保存案・試験入力をファイル化すると定めている。

## 決定

1. Node.js 24 LTS、基準 24.19.0。pnpm 12.11.2 と pnpm workspaces を利用し、追加のモノレポ実行基盤を導入しない。
2. TypeScript 6.0.3、ESLint 10.12.0、typescript-eslint 8.71.1、Prettier 3.9.10 を固定する。TypeScript は linter の対応範囲内の版を選ぶ。
3. Node.js の標準 test runner を使う。製品試験の必要に応じて後で補助ツールを追加できる。
4. contracts / domain は OS 非依存、storage / core は Node 側。共有層の型環境に DOM / Node を入れない。
5. Notion の一次設計は非公開で管理し、必要な写しは Git 対象外の .local/design/notion/ に置く。共通エージェント指示は AGENTS.md に集約し、CLAUDE.md から import する。
6. CI は Ubuntu / Windows / macOS。実機の製品動作や B00 完了とは別の検証として扱う。

## 後続で決めること

JSON Schema 検証器、型生成器、OpenAPI 検証器、JCS 実装は、設計 07〜11 の必要条件を確認して B00 で選定・固定する。
HTTP 実装、OS KeyStore、Electron とネイティブ依存の配布は該当工程で導入する。
初期環境に製品用の外部接続・DB・音声処理・LLM SDK は含まない。

## 影響

lockfile から再現できる。バージョン更新は CI の全 OS と型・lint の互換性を確認する。
空の TypeScript 入口はパッケージの配置とビルドだけを成立させる。契約・機能の実装として数えない。

## 2026-10-11 の更新

本人の指定で pnpm 12.11.2 と pnpm-workspace.yaml へ移行した。公開を前提に Notion 全文を追跡対象から外し、公開情報・秘密情報・履歴の検査を追加した。旧全文は過去の履歴に残るため公開前に別途整理する。
