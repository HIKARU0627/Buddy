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
| Windows の中枢のログオン後の自動起動・電源（W6〜W14） | Windows（中枢）      | 未実施                           | —                         |

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

準備は上と同じです（PowerShell で、リポジトリのルートで `pnpm install --frozen-lockfile`・`pnpm run build`）。データディレクトリの既定は `%LOCALAPPDATA%\Buddy\core` です（ADR 0202 の前の版は `%APPDATA%\Buddy\core`）。タスクは `autostart enable` のときのデータディレクトリの絶対パスを持つので、既定が変わった版へ更新したら `autostart enable` をやり直します。

| #   | 操作                                                                                                                                                                                  | 期待する結果                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | PowerShell 1: `node apps/core/dist/cli.js start`                                                                                                                                      | `{"event":"running",...}`。鍵保護（DPAPI）の実検査に通る                                                                                                                                           |
| W2  | PowerShell 2: `node apps/core/dist/cli.js status`                                                                                                                                     | `state: running`。`core_instance_id`・`store_generation` を控える（値は記録に写さず、後で同じかだけを見る）                                                                                        |
| W3  | PowerShell 2: `node apps/core/dist/cli.js start`                                                                                                                                      | 二重起動として拒否（終了コード 4、`already_running`）                                                                                                                                              |
| W4  | PowerShell 2: `node apps/core/dist/cli.js stop`                                                                                                                                       | PowerShell 1 の Core が `stopped` を出して終了コード 0 で終わる。もう一度 `status` で終了コード 3                                                                                                  |
| W5  | W1 をもう一度 → PowerShell 1 で Ctrl+C                                                                                                                                                | `store_generation` が W2 と同じで起動し、Ctrl+C で `stopped` を出して終わる                                                                                                                        |
| W6  | `node apps/core/dist/cli.js autostart enable`                                                                                                                                         | `registered`・`definitionPath` が `\BuddyCore`・`loaded` が false。この時点では Core は起動しない（`status` が終了コード 3）。管理者の確認（UAC）は出ない                                          |
| W7  | `Get-ScheduledTask -TaskName BuddyCore \| Select-Object State` と、タスク スケジューラの画面で `BuddyCore` の「トリガー」「全般」を見る                                               | State が Ready。トリガーは「ログオン時」で本人だけ、「最上位の特権で実行する」は付いていない、「ユーザーがログオンしているときのみ実行する」。「操作」は node.exe と `autostart launch --data-dir` |
| W8  | サインアウトして、もう一度サインイン                                                                                                                                                  | —                                                                                                                                                                                                  |
| W9  | `node apps/core/dist/cli.js status`                                                                                                                                                   | Core が `running`。コンソールの窓が残っていない（サインインの直後に一瞬出たか・出なかったかを記録する）                                                                                            |
| W10 | `Get-Content "$env:LOCALAPPDATA\Buddy\core\logs\core.out.log" -Tail 3`                                                                                                                | `running` の行がある。`core.err.log` に鍵・パスワードの値が出ていない                                                                                                                              |
| W11 | `node apps/core/dist/cli.js autostart status`                                                                                                                                         | `installed` が true・`load` が `loaded`。スリープ・休止状態の警告（`system_sleep_enabled`・`hibernate_enabled` など）が設定どおりに出る                                                            |
| W12 | 電源につないだときにスリープ・休止状態にしない設定にする（設定の「電源」、または `powercfg /change standby-timeout-ac 0`・`powercfg /change hibernate-timeout-ac 0`）→ W11 をもう一度 | 警告がない（`warnings` が空）                                                                                                                                                                      |
| W13 | PC を再起動してサインインし、`status` を見る。続けて `stop`                                                                                                                           | サインインの後に Core が `running`。シャットダウンでは終了処理を通らない（U721）ので、`store_opened` の `held_after_restart` の値と、起動が拒否されなかったかを記録する                            |
| W14 | `node apps/core/dist/cli.js autostart disable` → サインアウトしてサインイン → `status`                                                                                                | `removedDefinition` が true。次のサインインでは Core が起動しない（終了コード 3）。disable は動いている Core を止めない                                                                            |

- 自動起動した Core は HTTPS を開きません（`--https-host` を渡さない。macOS も同じ。U723）。端末をつなぐ確認は手で `start --https-host <hub-ip>` を起動して行います（docs/b03 の device-check の W）。
- 標準の利用者のアカウントで W6 が通るか（管理者の権限を求めないか）、W8 の後にタスク スケジューラの「最後の実行結果」が成功か、起動役の終了の後に Core が止められていないか（U720）を記録します。

## 記録の残し方

各項目が期待どおりか、違った点を伝えてもらい、司令塔が `tests/integration/evidence-b01-<端末>.json` に写します（Windows の中枢は `evidence-b01-windows-hub.json`、case_id は `B01-win-hub-core`（W1〜W5）・`B01-win-hub-autostart`（W6〜W14））。出力の ID・パスなどの値は記録しません。メール本文・音声・鍵は扱いません。
