# ADR 0203: Windows の中枢の自動起動・電源の診断・Tailscale・自宅の登録

- 日付: 2026-11-28
- 状態: 本人の決定（2026-11-28）「Windows でも中枢を使えるようにしてください」を受けた作業のうち、ログオン後の自動起動・電源の診断・Tailscale の状態の取得・自宅の登録・手順書を行った。模擬の試験（Linux の CI）と、Windows の CI（windows-latest）でだけ動く試験を足した。**Windows の実機（本人の PC）での確かめは未実施**。決定の記録と鍵の保護（DPAPI）は ADR 0202（別の作業）。
- 根拠: 本人の決定（2026-11-28）、ADR 0013（OS 別の起動・監督アダプター、LaunchAgent・KeepAlive を付けない）、ADR 0012（単一起動・制御チャネル）、ADR 0022（自宅の判定・Tailscale の状態・コマンドの絶対パス L9）、ADR 0025（端末の接続）、ADR 0026（中枢の画面）。Microsoft の文書（Task Scheduler のスキーマ・`schtasks`・`powercfg`・`whoami`・ScheduledTasks モジュール）の形に合わせた。
- 番号: ADR は 0203、未決事項は U720〜U726。
- 対象: `packages/platform/src/windows-scheduled-task.ts`・`windows-diagnostics.ts`・`windows-paths.ts`（新設）、`tailscale-status.ts`（Windows の候補）、`home-fingerprint.ts`（SystemRoot の検査の共有）、`supervisor.ts`・`startup.ts`（Windows の選択、未対応の理由のコード）、`apps/core/src/autostart.ts`（Windows の状態の警告・起動役 `autostart launch`）・`cli.ts`、docs/b01・docs/b03 の device-check、README。

## 決めたこと

### ログオン後の自動起動（Task Scheduler）

| 対象             | 決定                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仕組み           | 本人のログオン時に動くタスク（Task Scheduler）。タスク名は個人情報を含まない固定の `\BuddyCore`（ルートのフォルダー）。同じ PC の別の利用者と名前が重なる扱いは U724                                                                                                                                                                            |
| 誰として動くか   | 本人のアカウントだけ。LogonTrigger の `UserId` と Principal の `UserId` に本人の SID（`whoami /user /fo csv /nh` で読む）を入れる。`LogonType` は `InteractiveToken`、`RunLevel` は `LeastPrivilege`（管理者の権限を求めない）                                                                                                                  |
| 使わない形       | ログオンの前に動く形（S4U・パスワードを保存する形・SYSTEM・起動時のトリガー）。S4U ではユーザーの DPAPI の鍵を読めず（ADR 0202 の鍵の保護が使えない）、パスワードの保存は秘密を Task Scheduler に置くことになるため。macOS の LaunchDaemon を使わない判断（ADR 0013）と同じ                                                                     |
| 失敗時の再起動   | 付けない（`RestartOnFailure` なし）。KeepAlive を付けない macOS と同じ理由で、旧担当の終了確認なしに Core が並行実行し得るため。`MultipleInstancesPolicy` は `IgnoreNew`                                                                                                                                                                        |
| 時間の上限・電源 | `ExecutionTimeLimit` は `PT0S`（上限なし。既定の 72 時間で止めない）。バッテリーでも起動し、バッテリーに切り替わっても止めない（`DisallowStartIfOnBatteries`・`StopIfGoingOnBatteries` は false）。優先度は 5（通常。既定の 7 は通常より低く、子の Core に受け継がれる）                                                                        |
| 起動するもの     | `"<node.exe>" "<cli.js>" autostart launch --data-dir "<データディレクトリ>"`。launch（起動役、U720）が Core（`start --data-dir`）を窓のない切り離したプロセス（`detached`・`windowsHide`。libuv では DETACHED_PROCESS）として起動し、標準出力・標準エラーを `<データディレクトリ>\logs\core.out.log`・`core.err.log` に追記させて、すぐに終わる |
| なぜ起動役か     | node.exe はコンソールのプログラムで、タスクから直接起動するとログオンのたびにコンソールの窓が開き（閉じると Core が止まる）、ログもファイルに残らない（Task Scheduler には出力の行き先の設定がない）。cmd.exe の `>` でつなぐ形は引数の展開（`%`・`^`・`&`）の扱いが要るので使わない                                                            |
| 定義の書き方     | XML（スキーマの版 1.2）を Node で生成し（純粋関数。値は XML のエスケープ）、データディレクトリの一時ファイル（UTF-16LE、BOM つき）に書いて `schtasks /Create /TN \BuddyCore /XML <file> /F` で登録し、一時ファイルを消す。schtasks は %SystemRoot%\System32 の絶対パスで、shell を通さずに呼ぶ                                                  |
| 使えるパス       | ドライブ文字から始まる正規化した絶対パスだけ。`"`（引数の区切りを壊す）・`%`（Task Scheduler が環境変数として展開する）・制御文字・末尾の `\`（閉じの `"` をエスケープする）を含むものは `invalid_spec` で拒否する                                                                                                                              |
| 有効にする時点   | `autostart enable` は登録だけで、すぐには起動しない（`loadNow: false`。macOS と同じ）。`loadNow: true`（CLI からは使わない）はタスクを一度実行する（`schtasks /Run`）。Core が動いていれば、起動した start が単一起動のロックで拒否される                                                                                                       |
| 解除             | `schtasks /Delete /TN \BuddyCore /F`。Core はタスクから切り離して動くので、解除しても止まらない（`bootedOut` は常に false。止めるのは `buddy-core stop`）                                                                                                                                                                                       |
| 状態             | 固定の PowerShell のスクリプト（値を埋め込まない。タスク名は検査した固定の形だけ）で `Get-ScheduledTask` を読み、`{"found":false}` か `{"found":true,"enabled":…,"state":…}` の JSON にする。`installed` はタスクがあるか、`load` はタスクが有効か（次のログオンで動くか）。問い合わせに失敗したら `failed`（`task_query_failed`）              |
| 出力を読まない   | schtasks の出力は利用者の言語に訳されるので読まず、終了コードだけを使う。失敗の理由は段階と終了コードだけ（`schtasks_create_exit:1` など）。SID・パス・コマンドの出力はログ・理由に入れない                                                                                                                                                     |

`SupervisorStatus` に `FailedResult` を足した（Windows で問い合わせに失敗したとき。macOS は返さない）。対応しない OS（Linux など）の理由のコードは `initial_release_supports_macos_core_only` から `core_autostart_supports_macos_and_windows_only` に改めた（ADR 0013 の表の「Windows・Linux の起動」は、この ADR で Windows を外した）。

### 電源の診断（macOS の pmset にあたるもの）

- `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` と `... HIBERNATEIDLE` を %SystemRoot%\System32 の絶対パスで呼ぶ（管理者の権限は要らない）。
- 見出しは訳されるので読まず、`: 0x........` の 16 進の値の行の並び（最小・最大・増分・AC の現在値・DC の現在値の 5 つ）だけを読む。数が 5 でなければ unknown。プラン名（利用者が付けた名前を含み得る）は読まない。
- 電源につないでいるとき（AC）の値を使う。0 はしない、それ以外は分（切り上げ）。警告は `system_sleep_enabled`・`system_sleep_unknown`・`hibernate_enabled`・`hibernate_unknown`。起動の可否は決めない（ADR 0013 の診断と同じ）。
- `autostart status` は Windows ではこの警告を返す（macOS は pmset・fdesetup の警告のまま）。
- ディスクの暗号化（BitLocker、macOS の FileVault にあたる）は、状態を読むのに管理者の権限が要る（`manage-bde`・`Get-BitLockerVolume`）ので見ない（U725）。

### Tailscale の状態の取得

- `tailscaleCommandsFor(process.platform, process.env)` で候補を選ぶ。Windows は `%ProgramW6432%\Tailscale\tailscale.exe`・`%ProgramFiles%\Tailscale\tailscale.exe`・`C:\Program Files\Tailscale\tailscale.exe`、続いて PATH の各ディレクトリ（ドライブ文字から始まる絶対パスで `%` を含まないもの、64 個まで）に `tailscale.exe` を付けた絶対パス。大文字小文字を区別せずに重複を除く。
- 名前だけ（`tailscale.exe`）では呼ばない。Windows の実行ファイルの探し方はカレントディレクトリを PATH より先に探すため（ADR 0022 のレビューの指摘 L9 と同じ考え）。macOS の候補（最後に名前だけの `tailscale`）は変えない。
- 出力（`tailscale status --json`）の形は macOS と同じで、読み方・保持の時間・理由のコードは ADR 0022 のまま。起動できない候補（`exitCode: null`）は次へ進む。

### 自宅の登録（中枢側）

- 自宅の登録は中枢の画面の端末（中枢と同じマシンのデスクトップ、hub_local）が指紋を読み、Core へ送る（B03-08）。デスクトップは `@buddy/platform/home-fingerprint` の収集を使い、Windows の収集（PowerShell の `Get-NetRoute`・`Get-NetNeighbor`・`Get-NetIPAddress`、`netsh wlan show interfaces`）は既にある。中枢が Windows でも同じ経路で登録できるので、新しい経路・CLI は作らない（CLI を作らないのは B03-08 の本人の判断）。
- SystemRoot の形の検査（ドライブ文字から始まる絶対パス、`.`・`..`・使えない文字を拒否）を `windows-paths.ts` に移し、指紋の収集・自動起動・電源の診断で共有した。`%` も拒否するようにした（SystemRoot に `%` が入ることはない）。
- 中枢が Windows の Wi-Fi で SSID を読めない（位置情報の許可がない）ときは、有線の中枢と同じく SSID なしで登録される（U726）。
- Core の側（`api-home-network.ts`）に OS の分岐はない。同じマシンの判定（`isSameMachine`）もループバックか待ち受けのアドレスとの一致で、OS に依存しない。

### apps/core の Windows の分岐（読んだ結果）

| 対象               | 読んだ結果                                                                                                                                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 制御のチャネル     | データディレクトリの実体の絶対パス（`realpath`）の SHA-256 から求めた名前付きパイプ（`\\.\pipe\buddy-core-<16 桁>`）。CLI と Core が同じ求め方をする。パイプは既定の権限（U722）                                                                                                                                                 |
| 二重起動の拒否     | ロックファイルの排他作成と、パイプの待ち受け（libuv は最初のインスタンスとして作るので、既にあれば EADDRINUSE）。使用中なら status を問い合わせ、応答があれば `already_running`、なければ `endpoint_in_use`（Windows はパイプを消して作り直さない）。既存の試験（`core.test.ts`・`cli.test.ts`）が windows-latest でも動いている |
| 停止               | 制御チャネルの `stop`。コンソールがあれば SIGINT・SIGBREAK も受ける。起動役で起動した Core はコンソールを持たないので、止めるのは `buddy-core stop` だけ。ログオフ・シャットダウンでは終了処理なしで止まる（U721）                                                                                                               |
| HTTPS の受付       | `--https-host` に Tailscale のアドレスを渡したときだけ開く（OS の分岐なし）。TLS の秘密鍵の保護は ADR 0202（別の作業）。自動起動の Core は `--https-host` を渡さないので HTTPS を開かない（macOS も同じ。U723）                                                                                                                  |
| データディレクトリ | 既定は `%LOCALAPPDATA%\Buddy\core`（ADR 0202・U705 で `%APPDATA%` から変えた。paths.ts は別の作業）。DPAPI で保護した鍵は `%LOCALAPPDATA%\Buddy\key-store\`。権限の検査は別の作業（data-dir.ts）                                                                                                                                 |

## 試験

- Linux の CI（模擬）: `windows-scheduled-task.test.ts`（XML の手書きの期待値・UTF-16LE の BOM・使えないパスと SID の理由・whoami の CSV・問い合わせの JSON・登録・解除・状態・失敗の段階、模擬の runner と模擬のファイル操作）、`windows-diagnostics.test.ts`（英語と日本語の見出しの合成の出力）、`tailscale-status.test.ts`（Windows の候補）、`startup.test.ts`（Windows の選択・Linux の未対応）、`apps/core/src/autostart.test.ts`（Windows の状態と警告・登録の失敗・解除、起動役の spawn の引数・切り離し・窓を出さない・実際の子の出力のログへの追記）。
- Windows の CI（windows-latest）でだけ動く試験（`windows-live.test.ts`、ほかの OS では飛ばす）: 実際の whoami で SID を読める、ないタスクの問い合わせが `{"found":false}` になる、試験用の別の名前のタスクを作り・状態を読み・XML で読み直して `InteractiveToken`・`LeastPrivilege`・`PT0S`・LogonTrigger・失敗時の再起動なしを確かめ・消せる、powercfg で STANDBYIDLE を読める、tailscale.exe がなければ `tailscale_command_unavailable`、自宅の指紋の PowerShell のスクリプトが動いて既定のゲートウェイを読める。値は assert の文言にも出さない。
- 期待値は手で書き、実装の関数で作らない。実機の Windows（本人の PC）でのログオン後の起動・窓が出ないこと・ログ・Tailscale・自宅の登録・2 台目の端末は未実施（docs/b01・docs/b03 の device-check の「Windows の中枢」）。

## 未決事項

U720〜U726（docs/b00/contract-map.md）。

## 残ること

- 実機（Windows 10・11 の本人の PC）での確かめ全部。特に、標準の利用者の権限でタスクを登録できるか、起動役の窓が一瞬出るか、Task Scheduler が起動役の終了の後に Core を止めないか（U720）。
- 鍵の保護（DPAPI）と preflight の鍵の分岐、データディレクトリの権限の検査は別の作業（ADR 0202）。それが入るまで、Windows の `start`（模擬の鍵の保護なし）は鍵の保護が使えないとして起動を拒否する。
- インストーラー・署名は対象外。
