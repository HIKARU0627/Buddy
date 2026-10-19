# ADR 0002: B00 初回契約と検証

- 日付: 2026-10-18
- 状態: 初回範囲の実装判断。製品の本採用・B00 全体完了ではない。
- 根拠: 設計 07 §1〜4、08 §1〜5 の H01、10 §5 / 5A / 6A、05 の F02 とモデル再選定。原本の参照手順は docs/design/README.md。

## 対象と順序

原本に全フィールドと期待 hash があるラベル変更 H01 を最初の具体例にする。入力の固定、モデルの提案、Core の意味検証、実行可否、承認と操作を別の型にし、未実装の認可を形式検査で代用しない。
公開契約に個人の契約プラン、予算額、実データ、内部 URL を埋め込まない。モデル候補だけを一般化し、予算・クレジットの実値は実行時設定に残す。

## ツール

| 目的            | 固定版                           | 選択理由                                                                          |
| --------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| JSON Schema     | Ajv 8.20.0 / ajv-formats 3.0.1   | 2020-12 用クラス、strict、format 検査。型変換・既定値挿入・未知項目削除を行わない |
| TypeScript 生成 | json-schema-to-typescript 16.0.0 | スキーマから生成し、手書き型との二重管理を避ける                                  |
| OpenAPI         | swagger-parser 13.1.0            | 固定した 3.1.2 とローカル参照を検査。HTTP による外部参照の取得は禁止              |
| 生 JSON         | jsonc-parser 3.3.1               | コメント・末尾カンマを禁止し、構文木で階層ごとの重複キーを検出してから JSON.parse |
| JCS             | canonicalize 5.1.0               | RFC 8785 の正規化。受理前に不正 Unicode / 非有限数 / 重複キーを拒否               |

これらは開発時の検証依存。製品のランタイム検証器・HTTP サーバーとして接続したわけではない。型生成だけでは文字列パターン、format、意味、状態の条件を証明できない。
H01 と追加の境界例は実行するが、RFC 全体の完全適合証明とはしない。

## 原本の意味を維持した具体化

- ランダム識別子は UUID v4 の小文字表現。版・連番は非負整数の10進文字列。フィールドごとの版は交換不能だが、生成 TypeScript は同じ文字列表現のため意味検査が必要。
- 金額は通貨と百万分の一単位の非負整数文字列。通貨換算・安全係数・丸めは別の価格計算境界。これは実費の通貨や個人の上限を固定するものではない。
- 未知、未確定、適用しない値は契約で明示した null。省略や空配列とは同一視しない。
- InputSnapshot の本文は不変の入力。sealed と input_evidence を分離する。音声の訂正は文字確定へ自動昇格させない。再接続時の epoch と有効版の照合は Core の責務。
- LabelMailWireResponse は最初の限定比較用（ADR 0004 で 24 意図共通の WireResponse に置き換え）。24 intent の全引数形式として使わない。対象候補 ID は Core が渡した候補集合の範囲で解決する。モデルは承認・状態・effect_kind を指定できない。
- FieldEvidence（ADR 0003 で InputFieldEvidence に改名）の位置は JavaScript の UTF-16 コード単位で表し、元入力の版・引用との一致を Core が確認する。機械的に形が通っただけでは証拠として受理しない。
- OperationSnapshot / EventEnvelope は初回のラベル操作用。preview、scope、ロック、表示権、現行版の検査なしに承認しない。HTTP 202 / accepted / durable は外部成功ではない。
- BudgetReservation は R / M と gross / credit / spend を分離。R / M を加算しない。M を超えた実費も記録可能にし、新規有料処理を止めるのは Core の責務。
- CreditObservation は残高の観測。請求周期と予算月を分け、共有組織の残高を専有したとみなさない。プロバイダーの未確認 API を契約に作らない。

## 残る判断

残り23意図の固有引数、認可・最終ガード、完全な WorkContext、音声・同期・ExtractionResult v2、保存マイグレーション、全APIと試験の対応は後続。未確認の外部残高取得方法やプロバイダー能力を補完しない。モデルを有効化する manifest は、その確認と用途別評価を終えてから作る。

## 公式資料

- [Ajv の Schema 方言](https://ajv.js.org/json-schema.html) と [strict mode](https://ajv.js.org/strict-mode.html)
- [型生成器](https://github.com/bcherny/json-schema-to-typescript)
- [OpenAPI 検証器](https://github.com/APIDevTools/swagger-parser)
- [JSON パーサー](https://github.com/microsoft/node-jsonc-parser)
- [JCS](https://www.rfc-editor.org/rfc/rfc8785.html)
