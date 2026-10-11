# 情報管理と公開前確認

## 現在の状態

非公開 Notion の全文・内部 URL・取得 manifest は現在の追跡対象から除外しました。
**削除前の資料は過去の Git 履歴に残ります。現在の CI 合格だけで Public にしてよいという判定にはなりません。**
可視性の変更、履歴の書き換え、GitHub の管理設定は、この変更では実施していません。

## 情報の置き場所

| 情報                                   | 保存先                                             |
| -------------------------------------- | -------------------------------------------------- |
| 公開コード・一般化した契約・合成データ | Git                                                |
| 非公開の設計原本                       | 権限のある Notion                                  |
| 作業用の写し・検査ツール               | `.local/`（Git 対象外）                            |
| API キー・OAuth トークン・鍵           | OS の秘密情報保護／本人のローカル設定              |
| 実メール・音声・予定・本番 DB          | 開発リポジトリへ持ち込まない                       |
| 診断資料・画像                         | 値と画像内容・メタデータを確認して公開用に作り直す |

`.env.example` はダミー値だけにし、メールの例には予約ドメイン `example.invalid` 等を使います。
バイナリは文字列検査だけでは内容を確認できないため、既定では公開検査を失敗させます。公開アセットが必要になったら、内容レビューと検査方針の変更を同じ PR で行います。

## 3 段階の検査

1. `pnpm run hooks:install` でローカル hook を有効化。pre-commit はステージ済みの内容を、pre-push は送信する各コミットの内容・現在のファイル・秘密情報の履歴を検査します。追加後に削除した非公開情報も、送信する履歴に残っていれば拒否します。
2. `pnpm run check` は非公開パス・Notion 内部リンク・個人メール形式・tailnet ホスト・資格情報付き URL を拒否します。`pnpm run security:scan` は Gitleaks で取得済みの全 Git 履歴の秘密情報を検査します。
3. **Public 切替前は `pnpm run public:check`。** 秘密情報に加え、取得済みの全ブランチ・タグの過去の非公開資料も検査します。shallow clone は拒否します。

Gitleaks の版とアーカイブの SHA-256 は固定しています。検出値をログ・PR コメント・CI artifact へ出しません。
詳細はローカルで `--redact=100` 付きの Gitleaks で調べ、ログをそのまま Issue に貼らないでください。
誤検出への対応で広い除外や検査の無効化を追加しません。すべての個人情報を自動検出できるわけではないため、文章・画像の内容レビューも必要です。

## 既存履歴

現在の Private リポジトリを非公開の履歴保管先に残し、検査済みの現在のファイルだけから新しい Public リポジトリを作る方法が明確です。
同じリポジトリを Public にするなら、Private のまま資料の履歴削除と全ブランチ・タグ・PR 参照の確認を行います。force push は既存 clone に影響するため、方法を決めてから実施します。
履歴を書き換えても古いコミット・PR・キャッシュの完全削除を保証しません。必要に応じ GitHub の手順に従います。実際の資格情報が見つかったら失効・再発行します。

## GitHub 側で有効にする設定

次はファイルだけでは有効にならない管理設定です。**このセットアップで有効化済みとは扱わないでください。**

- Secret scanning と push protection。
- main の ruleset: PR 経由、必須チェック、force push / 削除の禁止。チェック名は `Public content / secrets` と各 OS の `Verify (...)`。
- 承認数は個人開発の運用に合わせる。CODEOWNERS だけではレビューは強制されない。
- Fork の Actions 実行承認。外部 PR に秘密情報や書き込み token を渡さない。
- Private vulnerability reporting（利用可能なら）。
- Actions の利用予算、保存量、ログ保持期間。

CI は標準 runner、contents: read、checkout の資格情報保持なし、固定 Action SHA、合成データのみ。
`pull_request_target` で外部コードを実行せず、本番キーを登録しません。キャッシュは pnpm store だけで、リポジトリ全体や `.local/` は保存しません。

## 公開直前

全リモートブランチ・タグを取得した clone で `pnpm run public:check` を通します。
Git 以外の Issue・PR・Release・Actions ログ・artifact・添付・作者メールも確認します。
README と画像と入力例を内容レビューし、GitHub 管理設定を確認してから可視性を変更します。

参考:

- [Actions 課金](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [機密情報の履歴削除](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
- [Push protection](https://docs.github.com/en/code-security/concepts/secret-security/push-protection)
- [Gitleaks](https://github.com/gitleaks/gitleaks)
