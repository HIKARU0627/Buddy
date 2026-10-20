# ADR 0013: OS 別の起動・監督アダプターと鍵保護不能時の停止

- 日付: 2026-10-20
- 状態: B01-02（#44）の判断。`packages/platform` の境界・macOS の LaunchAgent・診断・鍵保護の可否の確認を実装し、模擬の runner で試験した。Core の起動前検査と `buddy-core autostart` に組み込んだ。実機の launchctl への登録、pmset・fdesetup・security の実機での読み取りは未実施（B01-05）。鍵保護の可否の確認（`security default-keychain`）は B02-02 で KeyStore に基づく確認へ置き換えた（ADR 0017）。
- 根拠: 設計 02（処理の配置・保存と秘密情報・マルチプラットフォーム）、06 B01・初期のコード配置、09 §7、決定事項 J01・質問129。今回の作業環境では設計 02 の本文を `.local/design/notion/` に取得できなかったため、司令塔から受け取った要約に基づく。原本との照合はレビューで行う。

## 決めたこと

| 対象                  | 決定                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| パッケージ            | `@buddy/platform` に OS 別の起動・監督、診断、鍵保護の可否の確認を置く。Node API は使ってよいが Electron・Core には依存しない。contracts・domain からは import できない（lint と `scripts/tooling.test.mjs` で検査）                          |
| コマンド実行          | launchctl・pmset・fdesetup・security は注入できる `CommandRunner` 経由でだけ実行する。実機用は shell を通さない `execFile`、コマンドは絶対パス。試験は `createMockCommandRunner` を使い、実機の登録や設定の読み取りをしない                   |
| 起動方法（macOS）     | ログイン後の LaunchAgent（`~/Library/LaunchAgents/dev.buddy.core.plist`、`launchctl bootstrap gui/<uid>`）。サインイン前の LaunchDaemon は使わない。FileVault 有効の中枢は停電などの後は本人のログインまで止まり、ログイン後に再開する（J01） |
| plist の内容          | Label は個人情報を含まない固定の `dev.buddy.core`。ProgramArguments は node・Core の CLI・`start --data-dir <path>`。RunAtLoad は true。標準出力・標準エラーはデータディレクトリの `logs/` に置く。値は XML エスケープする                    |
| 本人の同意            | `register` は `enabled: true` を明示的に受け取らない限り、ファイルもコマンドも触らない（`not_enabled` を返す）。自動起動は本人が設定で有効にした場合だけ                                                                                      |
| 読み込みの時点        | `loadNow` / `unloadNow` を必須にする。false なら定義ファイルだけを書く・消すので、実行中の Core を止めたり二重に起動したりしない。すでに読み込み済みなら読み込み直さない                                                                      |
| 診断                  | `pmset -g` の `sleep`（と `SleepDisabled`）と `fdesetup status` を構造化する。判定できない出力・失敗したコマンドは unknown にし、良好と推測しない。結果は表示用の警告で、起動の可否は決めない                                                 |
| 鍵保護の可否          | `KeyProtectionProbe` は `{ available, backend, reason }` を返す。macOS は `security default-keychain` で既定のキーチェーンがあることだけを確かめる（保存・暗号化はしない）。Windows・Linux の中枢は初期版の対象外として使えない               |
| 起動前検査            | `keyProtectionPreflight(probe)` は使えなければ `key_protection_unavailable:<理由>` を返し、Core は起動を拒否する。例外・不正な結果も使えない扱い。平文の保存へ切り替える経路・設定は作らない                                                  |
| 模擬の probe          | `createMockKeyProtectionProbe` は `kind: 'mock'`・`backend: 'mock'`。起動前検査は既定で模擬を拒否し、試験だけ `allowMock: true` で受け入れる                                                                                                  |
| Windows・Linux の起動 | 例外ではなく `{ status: 'unsupported', reason: 'initial_release_supports_macos_core_only' }` を返す                                                                                                                                           |

理由コードにはコマンドの出力をそのまま入れません。`security` の出力はホームのパスを含むためです。

## 読み取り（レビュー対象）

- **KeepAlive を付けない**: 異常終了した Core を launchd が自動で再起動すると、旧担当の終了確認なしに Core が並行実行し得るため。異常終了後の再開は、本人の操作か次のログインになる。単一起動のロックと監督の方針が決まれば見直す。
- **RunAtLoad による即時起動**: `loadNow: true` で読み込むと Core がすぐ起動する。設定画面から有効にする場合は、実行中の Core と二重に起動しないよう `loadNow: false`（次のログインから有効）を使うか、Core 側の単一起動のロックで防ぐ必要がある。
- **解除の順序**: 定義ファイルを先に消し、次のログインで起動しないことを優先する。bootout に失敗して読み込まれたままなら失敗を返す。
- **ログの置き場所**: launchd は `StandardOutPath` の親ディレクトリを作らないため、登録時に `<dataDir>/logs` を 0700 で作る。ログの容量・削除の方針は未定。
- **診断は警告だけ**: スリープする設定・FileVault の無効は起動を拒否せず、警告として表示する（設計では推奨の設定であり、起動の条件とは読み取らなかった）。
- **既定のキーチェーンの確認**: キーチェーンのロック状態や書込み可否は確かめていない。B02 の KeyStore 実装で、保存・読み出しを含む確認へ置き換える。

## 残ること

- macOS のキーチェーンへの保存・暗号化（KeyStore の実装）は B02。
- 実機での LaunchAgent の登録・ログイン後の再開・pmset・fdesetup・security の読み取りの確認は B01-05。今回の試験は模擬の runner とファイル出力だけ。
- Core への組み込みは司令塔が行った。`buddy-core start` は既定で実行中の OS の鍵保護を確かめ、使えなければ `key_protection_unavailable:<理由>` で起動を拒否する（Linux・Windows の中枢は初期版の対象外）。`--mock-key-protection` は試験・模擬起動用。
- `buddy-core autostart enable | disable | status` を追加した。enable は LaunchAgent を登録するだけで即時には起動しない（`loadNow: false`）。実行中の Core と二重に起動しないためで、次のログインから有効になる。status はスリープ設定・FileVault の警告も返す。
- 端末能力のアダプター、Windows・Linux の中枢の正式対応、インストーラー・署名は対象外。
