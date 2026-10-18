# JSON Schema

`buddy.schema.json` は Draft 2020-12。各契約を `$defs` に定義し、参照先をローカルで検証します。`$id` は識別用の予約ドメインで、ネットワーク取得先ではありません。

ルートの `BuddyContract` は生成用の共用体。HTTP やモデル応答の検査では対応する個別定義を使用します。未知フィールドの削除、型の強制変換、未指定値の自動補完を行いません。

初回は入力・ラベル操作・予算記録・モデル評価候補の形式だけです。生成型を手編集せず、変更後は `pnpm run contracts:generate` と `pnpm run contracts:check` を実行してください。未作成の範囲は docs/b00/contract-map.md に記録します。
