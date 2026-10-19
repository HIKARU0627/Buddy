# ADR 0003: 共通表現と用途別の版

- 日付: 2026-10-19
- 状態: B00-02（#9）の判断。製品の検証器・DB への接続は未実装。
- 根拠: 設計 07 §1・§4、08 §1・§2、10 §1A・§4・§5A、11 §3・§5A、設計修正案 v1.2 §17.3。原本の参照手順は docs/design/README.md。台帳の未決事項 U01・U03・U04・U08 は本人の回答（2026-10-19、いずれも推奨案）で決定。

## 決めたこと

| 対象                        | 決定                                                                                                                                                    | 理由                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| U01 根拠の型の名前          | 入力引数の根拠を `InputFieldEvidence` に改名する。`FieldEvidence` は設計 03・11 の抽出の根拠（コードポイント位置）に残し、B00-06 で定義する             | 原本の語彙を保ち、ADR 0002 の UTF-16 位置の判断は変えない                                          |
| U03 音声の世代              | io / audio / output / control / session の各 epoch を 10 進文字列の版にする（UUID をやめる）                                                            | 設計 10 §1A の「世代を進め、古い世代を拒否する」を順序比較で検査できる                             |
| U04 2 つの request_revision | フィールド名は原本どおり `request_revision`。型は本人の依頼の `RequestRevision` と抽出した依頼の `RequestEntityRevision` に分け、同じ object に並べない | 設計 07 §1 の「型を分けて混同しない」を、原本の名前を変えずに満たす                                |
| U08 フィールド名の表記      | `sealReason` を `seal_reason` に改名する                                                                                                                | 他の契約と schema は snake_case。原本（07 §1）の `sealReason` と同じ意味であることを台帳に記録する |

## 用途別の版

版・連番は先頭ゼロのない非負整数の 10 進文字列です（07 §1）。共通の表現は `NonNegativeDecimal` ですが、プロパティからは直接参照せず、用途別の型を使います。

- 10 進の版: RequestRevision、RequestEntityRevision、TranscriptRevision、ContentVersion、StateRevision、PolicyVersion、PermissionRevision、ForgettingGeneration、ScopeRevision、AnalysisRevision、PublishedGeneration、各 Epoch。連番・カウンタは版と分けて `Sequence` にする。
- 不透明な値: `SourceRevision`（元サービスの etag・履歴 ID など。大小比較しない）、`EventCursor`（中枢が発行するイベント位置）。
- `StoreGeneration` は UUID のまま、等値比較だけに使います。バックアップ復元で連番を振ると、失われた DB と同じ値になって古いカーソルを受け入れるおそれがあるためです。設計 10 §4 の文脈例の `"3"` は例示として扱います。この点は原本に明記がない設計判断なので、レビュー対象です。

型の取り違えは次の 2 段で防ぎます。

1. `scripts/common-contracts.test.mjs` が schema を走査し、`content_version` などの版のフィールドが決められた型だけを参照していること、`_revision` / `_version` / `_generation` / `_epoch` で終わる新しいフィールドに型の割り当てがあることを検査する。型の決定を後続に残すのは `price_version`（B00-05）だけ。
2. 生成 TypeScript では `ContentVersion` などの別名になる。ただし実体は同じ `string` なので、型検査だけでは取り違えを防げない。値の比較・失効は Core の意味検査で行う。区別できる型（branded type）の導入は、domain の実装時に必要性を判断する。

## 時刻・日付

- `UtcTime` は UTC の RFC 3339 で、区切りは大文字の `T` と `Z` だけです。オフセット付き・小文字は受け付けません。
- うるう秒（`23:59:60Z`）は拒否します。形式検査（ajv-formats）は通しますが、JavaScript の `Date` が `NaN` を返し、期限比較が壊れるためです。
- 小数秒の桁数は制限しません（例: 7 桁を返すサービスがある）。比較の精度はミリ秒までで、比較は Core が行います。
- `LocalDate`（日付だけ）、`YearMonth`（暦月）、`TimeZone`（IANA 名）を分けます。`TimeZone` の実在は、形式ではなく実行環境のタイムゾーン情報で確認します（意味検査）。

## 検査の層の割り当て

| 対象                                            | 層                                                       | 実装（B00 時点）                                                  |
| ----------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| 不正 Unicode（孤立サロゲート）・重複キー        | 生 JSON の解析。値にする前に拒否                         | `parseStrictJson`                                                 |
| 非有限数・コメント・末尾カンマ・深さ・サイズ    | 生 JSON の解析                                           | `parseStrictJson`                                                 |
| 型・必須・未知フィールド・列挙・pattern・format | 形式検査                                                 | Ajv（strict、型変換・既定値挿入・未知項目削除なし）               |
| null と省略の区別                               | 形式検査。null を許す項目は required に入れ、null を明示 | schema の required と `anyOf` の null                             |
| 時刻・日付の形式、うるう秒                      | 形式検査                                                 | `UtcTime` / `LocalDate` / `YearMonth`                             |
| タイムゾーンの実在、時刻の前後・期限            | 意味検査                                                 | `semanticErrors`（局所的な例のみ）と後続の Core                   |
| 版の比較・失効、承認・状態遷移                  | 意味検査と状態機械                                       | 後続の domain / Core（未実装）                                    |
| 内容 hash の正規化                              | 正規化境界                                               | JCS（RFC 8785）だけ。NFC / NFKC、空白除去、配列の並べ替えはしない |

入力の整形（改行など）が必要な場合は、画面表示と hash 計算の前に一度だけ行います（08 §2）。

## 期待値の独立性

`packages/contracts/fixtures/content-hash-cases.json` の正規形は手書きのリテラル、SHA-256 は OS の `shasum` で計算しました。検査対象の canonicalize と Node.js の crypto では生成していません。手書きの H01 の正規形から計算した値は、設計 08 §2 の期待値と一致しました。キー順の変更は同じ値、許可版・内容版・対象・対象版・配列順・Unicode の正規化形・エスケープの違いは別の値になります。

## 検証器と版

検証器と正規化処理の採用理由と正確な版は [ADR 0002](0002-contract-validation.md) のとおりで、今回は変更していません（Ajv 8.20.0、ajv-formats 3.0.1、json-schema-to-typescript 16.0.0、swagger-parser 13.1.0、jsonc-parser 3.3.1、canonicalize 5.1.0）。

## 影響

`$defs` の名前（`Revision` → `NonNegativeDecimal` と用途別の型、`FieldEvidence` → `InputFieldEvidence`）、`seal_reason`、`audio_epoch` の値の形式が変わり、生成型・fixture・試験を更新しました。契約の利用者はまだいません。
