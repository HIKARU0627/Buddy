# 契約の検証データ

- `schema-cases.json`: スキーマ名・期待する正常／拒否と合成入力。`contracts:check` で実行します。予算の単価の版・実行時の設定・利用状況・超過の承認・M 超過の確認・手での精算の例（ADR 0034）も含み、通貨は XTS（拒否例の別通貨は XXX）、金額は縮めた合成値です。
- `h01.json`: 設計 08 にある合成ラベル変更と独立した期待 SHA-256。期待値を実装から再生成しません。
- `content-hash-cases.json`: 内容 hash の差分ケース。正規形は手書き、SHA-256 は OS の shasum で計算し、実装から生成していません。下書き・用事の系列（ADR 0027）は Python の json.dumps と hashlib で計算しました。
- `readiness-cases.json`: 変更を伴う意図の実行可否の期待値（QA41 ほか）。手書きの表で、domain の実装から生成していません。
- `operation-transitions.json`: X01〜X11 の操作の期待遷移。実行済みの記録ではありません。
- `audio-control-cases.json`: 停止理由ごとの動作と再開条件の期待値（設計 10 §1A）。
- `delivery-cases.json`: 古い世代・端末・出力先へ遅れて届いた結果の受け入れの期待値。
- `session-control-phrases.json`: 会話の操作の照合表の例と、照合・操作ごとの効果・表の形の期待値（X58、ADR 0038）。
- `voice-contract-cases.json`: 音声レンダラーへの限定 IPC・ACK・リースの更新・外部への送信の同意・input_kind の規則・制御接続の遷移の記録の、正常例と拒否例（世代の逆行・リースの期限の逆転・許されない理由と範囲の組・知らない IPC の名前・同意のない表。ADR 0038）。形式と契約の検証ツールの意味検査は `contracts:check`、IPC の意味検査は `scripts/voice-contract.test.mjs` が domain で確かめる。
- `voice-ipc-cases.json`・`live-control-cases.json`・`lease-renewal-cases.json`・`input-kind-cases.json`・`consent-cases.json`: 限定 IPC の ACK・待ち時間・世代と stop_playback の後の再開、制御接続の遷移、リースの更新の受付と応答の適用、input_kind の受付、同意と Live の接続の受付の期待値（ADR 0038）。手書きで、domain の実装から生成していない。ACK の待ち時間のうち原本にない値は仮置き（`basis: provisional`）。
- `voice-lease-clock-cases.json`・`voice-epoch-cases.json`: リースの期限の計算（要求時の単調時計から数える・遅着で延ばさない・スリープや時計の不整合で捨てる）と、世代の発行・逆行の拒否の期待値（X13・X25・X30・QA06、ADR 0041）。手書きで、domain の実装から生成していない。時計の許容は仮置き。
- `voice-stop-timing-cases.json`・`voice-silence-cases.json`・`voice-start-gate-cases.json`: 3 層の停止の時間（200 ms 目標・300 ms 期限）、無音の規則、接続開始の送信トラックの門の期待値（X13・X25・X30・X31・X54・X55・X58・QA43、ADR 0041）。時間は設計の初期値で合格値ではない。
- `voice-reservation-cases.json`・`voice-notification-rate-cases.json`: 追加予約の計画・予算到達の閉じ方・精算の秒数と、音声の通知の頻度の制限の期待値（X26・X34・X35、ADR 0041）。秒数だけで、金額は予算の規則（合成の通貨 XTS）が決める。
- `voice-segment-cases.json`・`voice-method-c-cases.json`・`voice-asr-compare-cases.json`: 方式 A の区間リングと sealed・blocked・truncated、方式 C の 4 操作の限定、Live と端末の ASR の比較の期待値（QA05・QA06・QA08・QA41・X51、ADR 0041）。音声は含まず、フレームの番号と sample の範囲、合成の発話だけ。
- `budget-scenarios.json`: 合成設定（通貨 XTS、合成の上限）による予算の受付・精算のシナリオ。超過枠への経路・手での精算・M 超過の確認の手順と、QA42 の残り・X53・X18 の予算の行を含む（ADR 0035）。本人の金額を含まない。
- `budget-rules.json`: 予算の純粋な規則の期待値（M と R の計算・単価の境界・丸め・予算月とタイムゾーンの翌月反映・時計の戻り・利用状況・超過枠への経路と承認の照合・手での精算・M 超過の確認。ADR 0035）。合成の実行時の設定（通貨 XTS、換算の例の元の通貨は XXX、縮めた単価）で、期待値は手計算。`scripts/budget-rules.test.mjs` がビルド後の domain で確かめる。
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
