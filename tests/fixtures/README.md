# 合成データ

統合試験用の合成メール・時計・provider 状態を置きます。契約単体の入出力は packages/contracts/fixtures に置きます。

- `storage-cases.json`: 保存案 0001 の一意制約・CHECK・外部キー・trigger の期待値（ADR 0010）。手書きで、SQLite の実行結果から生成していません。
- `retention-sweep-cases.json`: 保存期限の掃除の計画・時計の巻き戻り・派生物の期限・保存モードの変更・起動時のゲートの期待値（ADR 0043、B06-02）。手書きで、domain の出力から生成していません。
- `backup-restore-cases.json`: バックアップの中身・古いバックアップの世代・鍵の運用・復元の 6 段階・復元の後の保留の期待値（ADR 0047、B06-05）。手書きで、domain の出力から生成していない。HKDF の既知値は Python で RFC 5869 を別に実装して求めた。
