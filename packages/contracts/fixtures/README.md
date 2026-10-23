# 契約の検証データ

- `schema-cases.json`: スキーマ名・期待する正常／拒否と合成入力。`contracts:check` で実行します。予算の単価の版・実行時の設定・利用状況・超過の承認・M 超過の確認・手での精算の例（ADR 0034）も含み、通貨は XTS（拒否例の別通貨は XXX）、金額は縮めた合成値です。
- `h01.json`: 設計 08 にある合成ラベル変更と独立した期待 SHA-256。期待値を実装から再生成しません。
- `content-hash-cases.json`: 内容 hash の差分ケース。正規形は手書き、SHA-256 は OS の shasum で計算し、実装から生成していません。下書き・用事の系列（ADR 0027）は Python の json.dumps と hashlib で計算しました。
- `readiness-cases.json`: 変更を伴う意図の実行可否の期待値（QA41 ほか）。手書きの表で、domain の実装から生成していません。
- `operation-transitions.json`: X01〜X11 の操作の期待遷移。実行済みの記録ではありません。
- `audio-control-cases.json`: 停止理由ごとの動作と再開条件の期待値（設計 10 §1A）。
- `delivery-cases.json`: 古い世代・端末・出力先へ遅れて届いた結果の受け入れの期待値。
- `session-control-phrases.json`: 会話の操作の照合表の例と照合の期待値（X58）。
- `budget-scenarios.json`: 合成設定（通貨 XTS、合成の上限）による予算の受付・精算のシナリオ。本人の金額を含まない。
- `sync-scenarios.json`: 同期の走査の排他・公開前の照合の期待値（QA44・QA36 ほか）。
- `analysis-cases.json`: 関連解析の ready、取消の順序の逆転、再作成抑止の期待値（QA45 ほか）。
- `extraction-cases.json`: 候補起点の自動実行の検査と期限の変換の期待値（X39・X62・X63 ほか）。
- `memory-cases.json`: 記憶の保存直前の検査・期限・復元・抽出の時点の期待値（X15・X16・X44 ほか）。
- `evaluation-cases.json`: 配備×用途の採否・段階・成果物の照合・変化の検知・影モードの期待値（X57・X66・QA21・QA26 ほか）。実測値ではない。
- `eval-conversion-cases.json`: 評価セットの行を書き出し形式へ変換する期待値。行はすべて合成。
- `api-cases.json`: 経路ごとの正常な要求・応答と、認証不足・古い接続範囲・旧版などの拒否の期待値（X04・X42 ほか）。
- `home-network-cases.json`: 自宅判定の期待値（指紋の不一致・DERP・経路不明・Tailscale を取得できない・指紋だけ・報告の鮮度・中枢と同じマシンの免除、X42、ADR 0022）と、サブネットの正準の表記。手書きで、domain の実装から生成していない。
- `api-scenarios.json`: 再送・イベントの反映・リース・停止の到達・ペアリングの期待値（X04・X11・X13・X14）。
- `canvas-stream-cases.json`: キャンバスの記述・流れの区切りの正常例と不正例（上限超え・双方向の上書き・制御文字・未知の種類・読む順の欠けや重複・説明文の項目・要約のつなぎ方、ADR 0032）。形式は `contracts:check`、手書きの `semantic_errors` は `scripts/canvas.test.mjs` がビルド後の domain で確かめる。
- `desktop-ipc-cases.json`: デスクトップの限定 IPC の受付と、端末の入出力・ロックの状態遷移の期待値（QA43・X13、ADR 0014）。Electron の実機の記録ではありません。
- `boundary-cases.json`: 承認の受付・DB 命令の再検査・通知の配信・削除期限の期待値（X02・X12 ほか）。
- `workflow-label.json`: 実行境界の期待結果。`specification_only` で、DB・外部処理の実行済み記録ではありません。

追加の生JSON・JCS・入力根拠・局所的な費用不変条件は `scripts/contracts.test.mjs` で確認します。実データ・認証情報・個人予算を置きません。
