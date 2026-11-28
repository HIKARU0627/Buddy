# ADR 0202: Windows の中枢を使えるようにする（鍵の保護は DPAPI）

- 日付: 2026-11-28
- 状態: 本人の決定（下記）を受けた判断と、中枢の鍵の保護（データ鍵・TLS の秘密鍵・OAuth のトークン・バックアップの鍵）の Windows の実装。`packages/platform` に DPAPI の保護領域（`src/windows-dpapi.ts`）を足し、KeyStore の OS の選択・鍵保護の確認・起動前検査を Windows につないだ。データディレクトリの Windows の既定の場所を %LOCALAPPDATA% に改めた。試験は模擬の PowerShell（どの OS でも動く）と、Windows の CI（windows-latest）だけで動く本物の DPAPI の往復。**Windows の実機（本人の PC）での確認は未実施**。
- 根拠: 本人の決定（2026-11-28）、ADR 0013（OS 別のアダプター・鍵保護不能時の停止）・0017（KeyStore）・0020（TLS の秘密鍵）・0055（バックアップの鍵）・0144（OAuth のトークン）・0012（データディレクトリ）。設計本文（02 保存と秘密情報・マルチプラットフォーム）は今回の作業環境に取得していない。原本との照合はレビューで行う。
- 番号: ADR は 0202、未決事項は U700〜U705。
- 範囲外（別の作業）: ログイン後の自動起動（Task Scheduler）・Tailscale の状態の取得・自宅のネットワークの登録・docs/b01・b03 の Windows の中枢の手順。`packages/platform` の `startup.ts`・`supervisor.ts` の起動・監督の `unsupported`（`initial_release_supports_macos_core_only`）は、この ADR では変えていない。

## 本人の決定（2026-11-28）

本人が「Windows でも中枢を使えるようにしてください」と決めた。ADR 0013 の「Windows・Linux の中枢は初期版の対象外」を、**Windows について改める**。Linux の中枢は初期版の対象外のまま。

## 決めたこと

| 対象                     | 決定                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保護の手段               | Windows の DPAPI（`System.Security.Cryptography.ProtectedData`）の **CurrentUser** のスコープ。同じ Windows の利用者（とその資格情報）でなければ復号できない。LocalMachine のスコープは使わない（同じ PC の別の利用者が復号できるため）                                                                                                                                                                     |
| 呼び出し方               | ネイティブのモジュールを使わず、`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand <固定のスクリプト>` を子プロセスで呼ぶ。PATH から探さない。shell を通さない（`execFile`）。時間の上限は 30 秒                                                                                                                                               |
| 秘密の渡し方             | 秘密の値はコマンドラインの引数に載せない。標準入力に「操作（`protect` / `unprotect`）・entropy の base64・データの base64」の 3 行を書いて閉じる。スクリプトは定数で値を含まない。標準出力は結果の base64 だけ。標準エラーと例外の文（利用者名・パスを含み得る）は理由に入れない                                                                                                                            |
| entropy                  | `dev.buddy.core/<項目名>` の UTF-8。保護した blob を別の項目のファイルへ移しても復号に失敗する（本物の DPAPI で Windows の CI が確かめる）                                                                                                                                                                                                                                                                  |
| 項目名                   | macOS のキーチェーンのアカウント名と同じ: `data-key-v1`・`tls-key-v1`・`backup-file:<key_id>`・`ledger-hmac:<key_id>`・`oauth-v1:<connection_id>`                                                                                                                                                                                                                                                           |
| blob の置き場所          | `%LOCALAPPDATA%\Buddy\key-store\<項目名の SHA-256 の 16 進>.dpapi`。データディレクトリの外（キーチェーンと同じく利用者ごとに 1 つで、データディレクトリの写し・バックアップに含めない）。LOCALAPPDATA がドライブ文字で始まる絶対パスでなければ使えない（ネットワークの共有・相対パスへ切り替えない）。ファイル名を SHA-256 にするのは、Windows のファイル名が大文字・小文字を区別しない・`:` を使えないため |
| ファイルの中身           | `{"v":1,"scope":"current_user","account":<項目名>,"blob":<保護した値の正準の base64>}`。読み出しで欄の組・版・スコープ・項目名・base64 の形を照合し、違えば復号しない（読み出しの失敗）                                                                                                                                                                                                                     |
| 書込み                   | 同じディレクトリの一時ファイル（`wx`）に書いて fsync し、rename で置き換える。途中で止まっても古い値か新しい値のどちらか。削除は項目が無くても成功（OAuth のトークンの削除の性質に合わせる）                                                                                                                                                                                                                |
| 置き場所の検査           | 置き場所は開くたびに作り（`mkdir -p`）、ディレクトリであること・リンク（シンボリックリンク・ジャンクション）でないことを確かめる。違えば使えない。ACL の検査はしない（U700）                                                                                                                                                                                                                                |
| 失敗の区別               | 使えない（PowerShell を起動できない・時間切れ、DPAPI の型を読み込めない（終了コード 10）、置き場所・LOCALAPPDATA・SystemRoot がない）は `dpapi_unavailable`。Protect の失敗は `keystore_write_failed`、Unprotect の失敗・ファイルの形の不正・不正な出力は `keystore_read_failed`。鍵の形式の検査・読み戻しの照合・不正な値を上書きしないことは既存の上の層のまま                                            |
| 保護手段の名前           | `backend: 'windows_dpapi'`。起動前検査が実機の probe から受け入れる「使える」は `macos_keychain` と `windows_dpapi` だけ（模擬・none・その他の名前は `probe_result_invalid`）                                                                                                                                                                                                                               |
| 鍵保護の確認の条件       | Windows の probe は DPAPI の KeyStore でデータ鍵を `loadOrCreateDataKey` で取得できるか（初回は作成して Protect し、Unprotect で読み戻して一致を確かめる）。PowerShell を呼べて、DPAPI で保護・復号でき、置き場所に書けるときだけ `available`。使えなければ従来どおり `key_protection_unavailable:<理由>` で起動を断る                                                                                      |
| OS の選択                | `createKeyStore`・`createTlsKeyStore`・`createBackupKeyStore`・`createOAuthTokenStore`・`createKeyProtectionProbe` は `win32` で DPAPI の実装を返す。Core（preflight・cli の start・backup・restore）は `process.platform` を渡すだけなので、呼び出し側は変えていない。Linux は `linux_core_not_supported_in_initial_release` のまま                                                                        |
| 理由の整理               | `windows_core_not_supported_in_initial_release` は使わなくなったので、各 KeyStore の理由の型から外した。対応しない OS の KeyStore（`createUnsupported*`）は Linux なら Linux の理由、それ以外は `platform_not_supported`                                                                                                                                                                                    |
| データディレクトリの既定 | Windows は `%LOCALAPPDATA%\Buddy\core`（LOCALAPPDATA が絶対パスでなければ `<ホーム>\AppData\Local\Buddy\core`）。これまでの `%APPDATA%\Buddy\core`（Roaming）は移動プロファイルで同期され得るため、SQLite と WAL を置かない。鍵（key-store）と同じ PC・同じ利用者の場所にそろえる。これまで Windows の中枢は起動を拒否していたので、移すデータはない                                                        |
| データディレクトリの権限 | Windows では POSIX の所有者・0700 の検査を飛ばしたまま（`data-dir.ts`、`budget-config.ts`・`backup-config.ts`・`budget-credit.ts` の `0o022` の検査も同じ）。既定の %LOCALAPPDATA% の ACL（本人・SYSTEM・Administrators）に任せる。ACL の検査を足すかは U700                                                                                                                                                |

### DPAPI を選んだ理由（資格情報マネージャーを使わない理由）

`@napi-rs/keyring` は Windows の資格情報マネージャーにも保存できるが、1 項目の値の上限が 2560 バイトで、Microsoft のアクセストークン（数 KB になり得る）を `oauth-v1:<connection_id>` の JSON に入れると収まらないおそれがある。DPAPI は値の大きさの制限がなく、ネイティブのモジュールも要らない（Windows の CI で本物を動かせる）。本人の決定の指示（PowerShell の子プロセスで DPAPI を呼ぶ）にも合う。試験では 4096 文字のアクセストークンを保存・読み出しする。

## 守ること（変えていないもの）

- 平文の保存へ切り替える経路・設定は作らない。保護手段が使えなければ起動を断る（ADR 0013・0017）。
- 鍵の作成・正準の base64 と長さの検査・書いた値の読み戻し・不正な値を上書きしない・復元のデータ鍵の導入で違う素材を上書きしない（U130・U134）・バックアップの鍵の ID ごとの上書きの拒否は、OS によらない上の層（`createSlotKeyStore` など）がそのまま行う。保存・忘却・世代の最終ガードは Core の側で変えていない。
- 鍵・トークンの値は DB・ログ・例外・理由・コマンドラインに出さない。ファイルには保護した blob だけを置く（試験で平文とその base64 がファイルに無いことを確かめる）。
- 子プロセスは親の環境を受け継ぐ。CLI は起動の環境変数から読んだシークレットを `start` の最初に `process.env` から消すので（ADR 0144 の追補）、PowerShell の子プロセスにも渡らない。

## 試験

- どの OS でも動く模擬の試験（`packages/platform/src/windows-dpapi.test.ts`）: PowerShell と置き場所の既定の場所の決まり方、固定の引数とスクリプトの中身（CurrentUser・標準入力・LocalMachine を使わない）、ファイル名（SHA-256 の期待値は `sha256sum` で別に求めた）、秘密が標準入力だけに載り引数に載らないこと（標準入力の期待値は `base64` コマンドで別に求めた手書きの値）、ファイルの中身（手書きの JSON）と POSIX での 0700・0600、差し替え・削除・一時ファイルを残さないこと、別の項目への差し替え（項目名の照合と entropy）、ファイルの形の不正、失敗の区別（使えない／操作の失敗）と例外の文に秘密・利用者のパス・コマンドの出力が出ないこと、置き場所（決まらない・ファイル・シンボリックリンク・書込み不可）、データ鍵・TLS・バックアップ・OAuth の各 KeyStore、OS の選択と起動前検査。模擬の DPAPI は本物の暗号ではなく、entropy の結び付けと往復の形だけを再現する。
- 標準入力つきの実機用 runner は `node -e` の子プロセスで、標準入力の受け渡しと終了コード、起動できないときの `exitCode: null` を確かめる（どの OS でも動く）。
- **Windows の CI（windows-latest）だけで動く試験**: 「Windows の実機の DPAPI: PowerShell で保護・復号の往復ができ、別の項目へ差し替えた blob は復号できない」。一時ディレクトリに本物の DPAPI で保護した blob を作り、往復（日本語を含む値）、entropy が違う blob の復号の拒否、データ鍵の probe と起動前検査、TLS の鍵・4096 文字の OAuth のトークン・バックアップの鍵の往復を確かめる。他の OS では skip（`process.platform !== 'win32'`。リポジトリの OS ごとの試験の書き方に合わせた）。
- `apps/core/src/paths.test.ts`: Windows の既定のデータディレクトリ（%LOCALAPPDATA%・Roaming を使わない・相対パスのとき）、Windows の起動前検査（模擬の PowerShell で通る・起動できないと `dpapi_unavailable`・LOCALAPPDATA がないと `dpapi_unavailable`）。
- `apps/core/src/cli.test.ts`: 鍵保護の指定なしの `start` の拒否は Linux だけで確かめる（Windows では本人の %LOCALAPPDATA% に本物の鍵を作ってしまうため実行しない）。

## 原本に決めがない項目（未決事項）

`docs/b00/contract-map.md` の U700〜U705。

- U700: Windows のデータディレクトリと key-store の ACL を検査するか（暫定: 検査しない。既定の %LOCALAPPDATA% の ACL と DPAPI に任せる）。
- U701: key-store の置き場所（暫定: %LOCALAPPDATA%\Buddy\key-store。データディレクトリの外）。
- U702: PowerShell が使えない・制限された環境（制約付き言語モード・AppLocker・WDAC）での扱い（暫定: 使えないとして起動を断る）。
- U703: Windows のパスワードのリセット・別の PC への移行で DPAPI の鍵が復号できなくなったときの復旧（暫定: バックアップの復旧キーからの復元に頼る）。
- U704: 鍵の初回作成の並行（暫定: macOS と同じく読み戻しの照合で検出し、ロックの後の読み直しと DB の照合値に頼る）。
- U705: データディレクトリの既定を %LOCALAPPDATA% に移すこと（暫定: 移す。端末側・別の作業の手順と合わせる）。

## 残ること

- **Windows の実機（本人の PC）での確認は未実施**: 本人の Windows で `buddy-core start` が鍵保護の確認に通り、`%LOCALAPPDATA%\Buddy\key-store` に `.dpapi` のファイルだけができ、再起動で同じ鍵を読めること。手順は [packages/platform/README.md](../../packages/platform/README.md) の「実機での確認（Windows の DPAPI）」。Windows の CI の試験は GitHub の runner の利用者での確認で、本人の環境の合格ではない。
- 自動起動（Task Scheduler）・Tailscale・自宅のネットワーク・Windows の中枢の手順（docs/b01・b03）は別の作業。
- Windows の名前付きパイプの ACL（ADR 0012）は変えていない。
