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

B01 の完了条件「両 OS でロック・解除・停止のイベントを観測できる」と、06 B01 の「中枢は Mac mini で LaunchAgent・スリープしない設定・FileVault・ログイン後の再開を検証」は、Windows と Mac mini の確認が済んでから判定します。

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

Windows・Linux の中枢は初期版の対象外のため、A は macOS だけで行います（Windows で `start` すると鍵保護が使えないとして起動を拒否するのが期待どおりの動作です）。

## B. デスクトップ（macOS・Windows）

`pnpm --filter @buddy/desktop dev` で起動します（初回は Electron の取得あり）。

| #   | 操作                                                                  | 期待する結果                                                                 |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| B1  | 起動直後の画面を見る                                                  | 状態欄に「中枢は未接続」。電源とロックの記録に OS への問い合わせが 1 件      |
| B2  | ウィンドウを閉じる                                                    | 終了せず、メニューバー（Windows は通知領域）に残る。アイコンから画面を戻せる |
| B3  | 「この端末の入出力を停止」→ 前面のまま「この端末で再開する」          | 停止中になり、再開で受付中に戻る                                             |
| B4  | 画面をロック（macOS: Control＋Command＋Q、Windows: Windows＋L）→ 解除 | ロックと解除が記録される。解除しても自動では再開しない                       |
| B5  | スリープ → 復帰                                                       | スリープと復帰が記録される。自動では再開しない                               |
| B6  | アイコンのメニュー →「クライアントを終了」                            | アプリが終了する                                                             |
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

## 記録の残し方

各項目が期待どおりか、違った点を伝えてもらい、司令塔が `tests/integration/evidence-b01-<端末>.json` に写します。出力の ID・パスなどの値は記録しません。メール本文・音声・鍵は扱いません。
