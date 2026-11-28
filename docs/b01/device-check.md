# B01 の実機確認（#47）

B01 の受入条件のうち、実機でしか確かめられないもの（ロック・解除・停止の観測、ログイン後の再開）の手順と記録です。結果は 09 §8 の形式（`tests/integration/test-evidence.schema.json`、`kind: real_device`）で `tests/integration/evidence-b01-*.json` に残します。模擬の試験（CI）とは分けて扱います。

## 状況

| 確認                                                  | 端末                 | 状態                             | 記録                      |
| ----------------------------------------------------- | -------------------- | -------------------------------- | ------------------------- |
| Core の起動・二重起動の拒否・停止（A）                | macOS（MacBook Air） | 期待どおり（2026-10-20）         | `evidence-b01-macos.json` |
| デスクトップ・ロック・スリープ（B）                   | macOS（MacBook Air） | 期待どおり（2026-10-20）         | `evidence-b01-macos.json` |
| ログイン後の自動再開（C）                             | macOS（MacBook Air） | 期待どおり（参考。中枢ではない） | `evidence-b01-macos.json` |
| デスクトップ・ロック・スリープ（B）                   | Windows              | 未実施                           | —                         |
| ログイン後の自動再開・スリープ設定・FileVault（C・D） | Mac mini（中枢）     | 未実施                           | —                         |
| Windows の中枢の起動・二重起動の拒否・停止（W1〜W5）  | Windows（中枢）      | 未実施                           | —                         |
| Windows の中枢のログオン後の自動起動・電源（W6〜W16） | Windows（中枢）      | 未実施                           | —                         |

B01 の完了条件「両 OS でロック・解除・停止のイベントを観測できる」と、06 B01 の「中枢は Mac mini で LaunchAgent・スリープしない設定・FileVault・ログイン後の再開を検証」は、Windows と Mac mini の確認が済んでから判定します。本人の決定（2026-11-28）で Windows も中枢にできるようにしたので、Windows の中枢の確認（W、[ADR 0203](../adr/0203-windows-hub-autostart-and-network.md)）も同じく未実施のまま合格にしません。

## 準備

リポジトリのルートで main を最新にし、ビルドします。

```sh
git switch main
git pull --ff-only
pnpm install --frozen-lockfile
pnpm run build
```

## A. Core（macOS。ターミナルを 2 つ）

| #   | 操作                                              | 期待する結果                                                      |
| --- | ------------------------------------------------- | ----------------------------------------------------------------- |
| A1  | ターミナル 1: `node apps/core/dist/cli.js start`  | `{"event":"running",...}`。鍵保護（キーチェーン）の実検査に通る   |
| A2  | ターミナル 2: `node apps/core/dist/cli.js status` | `state: running`。`core_instance_id`・`store_generation` を控える |
| A3  | ターミナル 2: `node apps/core/dist/cli.js start`  | 二重起動として拒否（終了コード 4）                                |

A は macOS の手順です。Windows の中枢は下の W で確かめます（Linux の中枢は対象外で、`start` は鍵保護が使えないとして起動を拒否します）。

## B. デスクトップ（macOS・Windows）

`pnpm --filter @buddy/desktop dev` で起動します（初回は Electron の取得あり）。

| #   | 操作                                                                  | 期待する結果                                                                 |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| B1  | 起動直後の画面を見る                                                  | 状態欄に「中枢は未接続」。電源とロックの記録に OS への問い合わせが 1 件      |
| B2  | ウィンドウを閉じる                                                    | 終了せず、メニューバー（Windows は通知領域）に残る。アイコンから画面を戻せる |
| B3  | 画面の「■ 入出力を停止」→ 前面のまま「この端末で再開する」            | 停止中になり、再開で受付中に戻る                                             |
| B4  | 画面をロック（macOS: Control＋Command＋Q、Windows: Windows＋L）→ 解除 | ロックと解除が記録される。解除しても自動では再開しない                       |
| B5  | スリープ → 復帰                                                       | スリープと復帰が記録される。自動では再開しない                               |
| B6  | アイコンのメニュー →「Buddy を終了」                                  | アプリが終了する                                                             |
| B7  | （macOS で A を動かしている場合）`node apps/core/dist/cli.js status`  | Core は動いたままで、`core_instance_id`・`store_generation` が A2 と同じ     |
| B8  | `node apps/core/dist/cli.js stop`                                     | Core が `stopped` を出して終了する                                           |

Windows では powerMonitor の `shutdown` がないため、OS の終了はクライアントの終了として扱います（ADR 0015）。

## C. ログイン後の自動再開（Mac mini。MacBook での確認は参考）

| #   | 操作                                          | 期待する結果                                 |
| --- | --------------------------------------------- | -------------------------------------------- |
| C1  | `node apps/core/dist/cli.js autostart enable` | `registered`。この時点では Core は起動しない |
| C2  | ログアウトして、もう一度ログイン              | —                                            |
| C3  | `node apps/core/dist/cli.js status`           | Core が `running`                            |
| C4  | `node apps/core/dist/cli.js autostart status` | 登録の状態と、スリープ設定・FileVault の警告 |

確認の後に自動起動を残さない場合は、`stop` の後に `autostart disable` で登録を解除します。

## D. 停電後の再開（Mac mini。06 B01・T07・質問129）

FileVault が有効な Mac mini で、電源を切って入れ直します。

| #   | 操作                                          | 期待する結果                                              |
| --- | --------------------------------------------- | --------------------------------------------------------- |
| D1  | 電源を入れ直し、ログインしない                | Core は起動していない（本人のログインまで止まる）         |
| D2  | ログインする                                  | LaunchAgent で Core が自動で起動し、`status` が `running` |
| D3  | `node apps/core/dist/cli.js autostart status` | スリープしない設定と FileVault 有効が確認でき、警告がない |

## W. Windows の中枢（ADR 0203。PowerShell を 2 つ）

本人の決定（2026-11-28）で、Windows でも中枢を使えるようにしました。鍵の保護（DPAPI）は別の作業（ADR 0202）で入ります。**ADR 0202 が入る前の版では、`start` は鍵保護が使えないとして起動を拒否します（終了コード 5）**。その場合は W1〜W5 を `--mock-key-protection` を付けて参考として確かめ、ADR 0202 が入った版でやり直します（W6 以降の自動起動は、タスクが `--mock-key-protection` を付けないので、ADR 0202 の後に行います）。

### 前提と準備

- **中枢の PC は本人だけが使います**。同じ PC の別の利用者は、制御チャネルの名前付きパイプを先に作って（先取りして）、`first-device start` に偽のペアリングのコード・証明書の指紋を表示させ得ます（U722）。家族と共有する PC は中枢にしないでください。
- **リポジトリと node は、本人のプロファイルの下（`C:\Users\<本人>\...`）か `C:\Program Files` の下に置きます**。ドライブの直下（`C:\buddy` など）に置くと、別の利用者が `apps\core\dist\cli.js` を書き換えられ、ログオンのたびに本人の権限で動いてしまいます。
- 準備は上と同じです（PowerShell で、リポジトリのルートで `pnpm install --frozen-lockfile`・`pnpm run build`）。
- データディレクトリの既定は `%LOCALAPPDATA%\Buddy\core` です（ADR 0202 の前の版は `%APPDATA%\Buddy\core`）。DPAPI で保護した鍵は別の場所の `%LOCALAPPDATA%\Buddy\key-store\` に置かれます（ADR 0202）。
  - データディレクトリだけを別の PC へ移す・バックアップから戻すと、鍵がないので DB を開けません。移すときは Buddy のバックアップ（`backup setup`・`restore`）を使います。
  - DPAPI の鍵は本人の Windows のパスワード（資格情報）に結び付いています。管理者がパスワードを再設定した・プロファイルを作り直した後は鍵を読めなくなります（本人がパスワードを変更するのは問題ありません）。
- タスクは `autostart enable` のときのデータディレクトリと node の実体の絶対パスを持ちます。既定のデータディレクトリが変わった版へ更新した・node を入れ替えた（版を上げた）ときは `autostart enable` をやり直します。
- 自動起動の Core には秘密（API キーなど）を渡しません。ユーザーの環境変数に秘密を置かないでください（タスクの Core はその環境を受け継ぎます）。
- ログ（`logs\core.out.log`・`core.err.log`）は追記し続け、大きさの上限はありません（ADR 0013 と同じ未定）。大きくなったら Core を止めてから消します。

### 起動・二重起動・停止（W1〜W5）

| #   | 操作                                              | 期待する結果                                                                                                |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| W1  | PowerShell 1: `node apps/core/dist/cli.js start`  | `{"event":"running",...}`。鍵保護（DPAPI）の実検査に通る。`https` が `off`                                  |
| W2  | PowerShell 2: `node apps/core/dist/cli.js status` | `state: running`。`core_instance_id`・`store_generation` を控える（値は記録に写さず、後で同じかだけを見る） |
| W3  | PowerShell 2: `node apps/core/dist/cli.js start`  | 二重起動として拒否（終了コード 4、`already_running`）                                                       |
| W4  | PowerShell 2: `node apps/core/dist/cli.js stop`   | PowerShell 1 の Core が `stopped` を出して終了コード 0 で終わる。もう一度 `status` で終了コード 3           |
| W5  | W1 をもう一度 → PowerShell 1 で Ctrl+C            | `store_generation` が W2 と同じで起動し、Ctrl+C で `stopped` を出して終わる                                 |

### ログオン後の自動起動・電源（W6〜W16）

| #   | 操作                                                                                                                                                                                                                                                                                                                         | 期待する結果                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W6  | 標準の利用者のアカウントで `node apps/core/dist/cli.js autostart enable --https-host <hub-ip>`（`<hub-ip>` は `tailscale ip -4` の値。docs/b03 の W1）                                                                                                                                                                       | 先に `https_config_saved`、続いて `registered`・`definitionPath` が `\BuddyCore`・`loaded` が false。この時点では Core は起動しない（`status` が終了コード 3）。管理者の確認（UAC）は出ない。`0.0.0.0`・LAN のアドレスは使い方の誤り（終了コード 2）で保存されない                                |
| W7  | `Get-ScheduledTask -TaskName BuddyCore \| Select-Object State` と、タスク スケジューラの画面で `BuddyCore` の「トリガー」「全般」「操作」を見る                                                                                                                                                                              | State が Ready。トリガーは「ログオン時」で本人だけ、「最上位の特権で実行する」は付いていない、「ユーザーがログオンしているときのみ実行する」。「操作」は node.exe と `autostart launch --data-dir`                                                                                                |
| W8  | サインアウトして、もう一度サインイン                                                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                                                                                 |
| W9  | サインインの直後と、数分後にもう一度 `node apps/core/dist/cli.js status` と `Get-ScheduledTask -TaskName BuddyCore \| Select-Object State`                                                                                                                                                                                   | どちらも Core が `running`（数分後も止められていない。U720）。`https` は Tailscale が動くまで `pending`、動いた後は `listening`。タスクの State（Ready か Running か）を記録する。コンソールの窓が残っていない（サインインの直後に一瞬出たか・出なかったかを記録する）                            |
| W10 | `Get-Content "$env:LOCALAPPDATA\Buddy\core\logs\core.out.log" -Tail 3 -Encoding UTF8` と `core.err.log` も同じく                                                                                                                                                                                                             | `running` の行がある。`https_listening`・`https_pending` に待ち受けのアドレス（`host`）がない。鍵・パスワード・アドレスの値が出ていない                                                                                                                                                           |
| W11 | `node apps/core/dist/cli.js autostart status`                                                                                                                                                                                                                                                                                | `installed` が true・`load` が `loaded`・`core` が `running`。スリープ・休止状態の警告（`system_sleep_enabled`・`hibernate_enabled` など）が設定どおりに出る。https.json がなければ `https_not_configured`                                                                                        |
| W12 | 電源につないだときにスリープ・休止状態にしない設定にする（設定の「電源」、または `powercfg /change standby-timeout-ac 0`・`powercfg /change hibernate-timeout-ac 0`）→ W11 をもう一度。ノートの PC はふたを閉じたときの動作（コントロール パネルの「電源ボタンの動作の選択」、電源につないでいるとき）を「何もしない」にする | 警告がない（`warnings` が空）。休止状態そのものを無効（`powercfg /h off`）にした PC では休止状態の警告が出ない。ふたを閉じても Core が動き続ける（ふたの動作は診断しないので、閉じて開いた後の `status` で確かめる）                                                                              |
| W13 | PC を再起動してサインインし、`status` を見る。続けて `stop`                                                                                                                                                                                                                                                                  | サインインの後に Core が `running`。シャットダウンでは終了処理を通らない（U721）ので、`store_opened` の `held_after_restart` の値と、起動が拒否されなかったか（ロックが片付いたか）を記録する。高速スタートアップが有効か（電源オプションの「高速スタートアップを有効にする」）も記録する（U727） |
| W14 | Windows Update の再起動の後（または再起動して、サインインしない）に、別の端末から中枢へつなげるかを見る。続けてサインインして `status`                                                                                                                                                                                       | サインインするまで Core は動かない（本人のログオンまで止まる。macOS の FileVault の中枢と同じ）。「更新または再起動後にサインイン情報を使ってデバイスのセットアップを自動的に完了する」（ARSO）が有効な PC で、サインインの前に Core が動いたかを記録する。自動ログオンは勧めない                 |
| W15 | `node apps/core/dist/cli.js autostart disable` → すぐ（サインアウトの前に）`status`                                                                                                                                                                                                                                          | `removedDefinition` が true。動いている Core は止まらず `running` のまま（disable は Core を止めない）。`Get-ScheduledTask -TaskName BuddyCore` が見つからない                                                                                                                                    |
| W16 | `stop` → サインアウトしてサインイン → `status`                                                                                                                                                                                                                                                                               | 次のサインインでは Core が起動しない（終了コード 3）                                                                                                                                                                                                                                              |

- 自動起動した Core は、W6 で保存した `https.json`（データディレクトリ）を読んで HTTPS を開きます（U723。macOS の LaunchAgent も同じ）。手で起動するときも `start --https-host <hub-ip> --save` で保存できます。
- 標準の利用者のアカウントで W6 が通るか（管理者の権限を求めないか）、W8 の後にタスク スケジューラの「最後の実行結果」が成功か、起動役の終了の後に Core が止められていないか（W9、U720）を記録します。

## 記録の残し方

各項目が期待どおりか、違った点を伝えてもらい、司令塔が `tests/integration/evidence-b01-<端末>.json` に写します（Windows の中枢は `evidence-b01-windows-hub.json`、case_id は `B01-win-hub-core`（W1〜W5）・`B01-win-hub-autostart`（W6〜W16））。出力の ID・パスなどの値は記録しません。メール本文・音声・鍵は扱いません。
