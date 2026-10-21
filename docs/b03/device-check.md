# B03 の実機確認（Mac mini の中枢・Tailscale・macOS / Windows の端末）

B03 の完了条件のうち、実機でしか確かめられないもの（Mac mini のキーチェーンの TLS の秘密鍵、Tailscale の直接経路と DERP、端末での自宅の指紋の取得、macOS・Windows の safeStorage、別のマシンの 2 台の再接続・失効・証明書の差し替え）の手順と記録の形式です。CI の試験は同じマシンの模擬（127.0.0.1・模擬の KeyStore・模擬の safeStorage）だけで、実機のキーチェーン・Tailscale に触れません（[ADR 0025](../adr/0025-b03-client-desktop-connection.md)）。

結果は 09 §8 の形式（`tests/integration/test-evidence.schema.json`、`kind: real_device`）で `tests/integration/evidence-b03-<端末>.json` に残します（本人の確認の後に司令塔が作る）。**ここに書いた確認はすべて未実施です。未実施のまま B03 を合格にしません。**

## 状況

| 確認                                              | 端末                           | 状態                                                   | 記録 |
| ------------------------------------------------- | ------------------------------ | ------------------------------------------------------ | ---- |
| A. Mac mini のキーチェーンの TLS の秘密鍵         | 中枢（Mac mini）               | 未実施                                                 | —    |
| B. Tailscale の状態の取得（中枢）                 | 中枢（Mac mini）               | 未実施                                                 | —    |
| C. 1 台目の登録と safeStorage（中枢と同じマシン） | 中枢（Mac mini）のデスクトップ | 未実施                                                 | —    |
| D. 自宅の判定と指紋の取得（別のマシン）           | macOS・Windows の端末          | 未実施。**2 台目の承認の手段が未実装**（下の「前提」） | —    |
| E. 2 台の再接続・失効・証明書の差し替え           | 中枢と別のマシンの端末 2 台    | 未実施。**同上**                                       | —    |

## 前提と注意

- **2 台目以降の承認・失効の手段**: 今の中枢は、承認待ちの申請（claim_id）を中枢の画面へ知らせる経路と、中枢の画面の操作（ペアリングの開始・承認・端末の失効）の UI がない（ADR 0025 の「残ること」）。最初の端末の CLI（`buddy-core first-device`）は「登録済みの端末が 0 台」かつ「中枢と同じマシンからの申請」だけを承認する（ADR 0021）。そのため **D・E は、承認・失効の手段（経路か CLI）が入るまで行えません**。A〜C は今の main で行えます。
- 指紋・宛先・MAC・SSID・アドレス・ホスト名・トークンの値は記録に写しません（同じだったか、期待どおりだったかだけを書く）。スクリーンショットも残しません。
- 確認には `--mock-key-protection` を付けません（実機のキーチェーン・Tailscale を使う）。
- 中枢の HTTPS の宛先は Tailscale の IPv4 のアドレス（`tailscale ip -4` の値）。以下では `<hub-ip>` と書きます。ポートは既定の 47443。

## 準備（中枢・端末の両方）

```sh
git switch main
git pull --ff-only
pnpm install --frozen-lockfile
pnpm run build
```

デスクトップは `pnpm --filter @buddy/desktop dev`（初回は Electron のバイナリを取得）で起動します（[apps/desktop/README.md](../../apps/desktop/README.md)）。

## A. Mac mini のキーチェーンの TLS の秘密鍵（ADR 0020）

| #   | 操作（中枢）                                                                                                 | 期待する結果                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `security find-generic-password -s dev.buddy.core -a tls-key-v1 >/dev/null && echo exists \|\| echo missing` | 初めてなら `missing`                                                                                                                   |
| A2  | ターミナル 1: `node apps/core/dist/cli.js start --https-host <hub-ip>`                                       | `{"event":"https_listening",...}` の `certificate_creation` が `key_and_certificate`（初回）。キーチェーンの許可を求められたら許可する |
| A3  | A1 をもう一度                                                                                                | `exists`                                                                                                                               |
| A4  | `ls -l "$HOME/Library/Application Support/Buddy/core"`                                                       | `tls-certificate.pem` が `-rw-------`。秘密鍵のファイルがない                                                                          |
| A5  | ターミナル 2: `node apps/core/dist/cli.js stop` → A2 をもう一度                                              | 2 回目の `certificate_creation` が既存の鍵・証明書の利用を示し、`certificate_fingerprint` が 1 回目と同じ（値は写さず、同じかだけ）    |

## B. Tailscale の状態の取得（中枢、ADR 0022 の「実機での確認」1）

| #   | 操作                                                                                                                                                                     | 期待する結果                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| B1  | 中枢で `tailscale status --json`（候補: `/Applications/Tailscale.app/Contents/MacOS/Tailscale`・`/opt/homebrew/bin/tailscale`・`/usr/local/bin/tailscale`・`tailscale`） | JSON が出る。どの候補で動いたかを記録する                                     |
| B2  | Core を LaunchAgent（`autostart enable` の後のログイン）で起動したときも B1 の候補で取得できるか                                                                         | 取得できる。できなければ理由（PATH・App Store 版の CLI の起動など）を記録する |

## C. 1 台目の登録と safeStorage（中枢と同じマシンのデスクトップ）

| #   | 操作                                                                                                                                                                       | 期待する結果                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | 中枢でデスクトップを起動する                                                                                                                                               | ペアリングの画面（未登録）。安全な保存が使えないと出たら、その旨を記録して中断する                                                                                                   |
| C2  | 宛先 `<hub-ip>`・ポート 47443 で「中枢の証明書を受け取る」                                                                                                                 | 指紋が 4 桁ずつ表示される。この時点で中枢のログに申請・要求の記録がない                                                                                                              |
| C3  | ターミナル 2: `node apps/core/dist/cli.js first-device start`                                                                                                              | コードと指紋が出る。画面の指紋と 64 桁すべて同じ                                                                                                                                     |
| C4  | 画面で「一致」→ コードと端末名 →「申請する」→ ターミナル 2: `first-device approve --pairing-id <id>`                                                                       | 画面が「● 接続中」になり、状態欄の中枢が「接続中」・最終確認の時刻が進む。自宅の判定は「中枢と同じマシン（判定を免除）」                                                             |
| C5  | `security find-generic-password -s "Buddy Desktop Safe Storage" >/dev/null && echo exists`（項目名は Electron の既定。違えばキーチェーンアクセスで「Safe Storage」を探す） | `exists`。userData（`~/Library/Application Support/Buddy Desktop`）の `device-credential.bin` が `-rw-------` で、中身に平文のトークンがない（`strings` で 43 文字の英数字が出ない） |
| C6  | デスクトップを終了して起動し直す                                                                                                                                           | ペアリングなしで「● 接続中」に戻る                                                                                                                                                   |
| C7  | 画面をロックして解除する                                                                                                                                                   | ロック中は接続の欄が隠れ、解除の後に戻る。中枢へのロック状態の申告（Buddy-Lock-State）で、解除の後に操作の表示が戻る                                                                 |
| C8  | 中枢を止めて（ターミナル 1 で `stop`）起動し直す                                                                                                                           | 端末は「接続できません（自動で接続し直します）」→ 中枢の起動の後に「● 接続中」へ戻る（新しい接続範囲）                                                                               |

Windows の safeStorage（DPAPI）は D・E の Windows の端末で確かめます（登録の後に `%APPDATA%\Buddy Desktop\device-credential.bin` があり、平文のトークンがないこと）。

## D. 自宅の判定と指紋の取得（別のマシン、ADR 0022 の「実機での確認」2〜7）

**前提: 2 台目の承認の手段が入ってから行う。** 中枢の画面から自宅を登録し（`registerHome`）、別のマシンの端末（macOS・Windows）を登録した後に行います。

| #   | 操作                                                                                                                                                                                       | 期待する結果                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 自宅の LAN の端末から接続する                                                                                                                                                              | 中枢の `tailscale status --json` のそのピアの `CurAddr` が LAN の IPv4。端末の接続の欄の自宅の判定が「● 自宅のネットワーク」                              |
| D2  | 端末を自宅の外（テザリングなど）に移す                                                                                                                                                     | 5 分以内（ネットワークの変化なら 15 秒程度）に報告し直され、`tailscale_derp` などの理由で「○ 自宅のネットワークではありません」・接続が 4403 で切れて待つ |
| D3  | 自宅の LAN に戻す                                                                                                                                                                          | 報告が通り、すぐに接続し直す                                                                                                                              |
| D4  | macOS の端末で `route -n get default`・`arp -n`・`ipconfig getsummary`・`networksetup -getairportnetwork` の出力の形（macOS 14.4 以降の SSID の `<redacted>`、有線で SSID が取れない扱い） | 想定の形。取れない要素は null として送られる                                                                                                              |
| D5  | Windows の端末で PowerShell の `Get-NetRoute`・`Get-NetNeighbor`・`Get-NetIPAddress`、`netsh wlan show interfaces`（位置情報の許可なし）                                                   | 想定の JSON。SSID が出なければ取れない扱い                                                                                                                |
| D6  | VPN・Tailscale の出口ノードを使う                                                                                                                                                          | 既定の経路が LAN でなくなり拒否される                                                                                                                     |
| D7  | 報告を止めて 6 分待つ（端末をスリープさせるなど）                                                                                                                                          | 中枢が 6 分を過ぎた報告で拒否し、報告し直すと戻る                                                                                                         |

## E. 2 台の再接続・失効・証明書の差し替え（Tailscale 越し）

**前提: 2 台目の承認・失効の手段が入ってから行う。** 端末 A（中枢と別のマシン）と端末 B（もう 1 台）を登録し、両方が「● 接続中」の状態から始めます。直接経路（D1）と DERP（D2 の状態で自宅の判定を一時的に免除できないため、DERP では 4403 になることの確認）の両方で記録します。

| #   | 操作                                                                                                          | 期待する結果                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | 中枢を止めて起動し直す                                                                                        | A・B とも「接続できません」→「● 接続中」。同じ操作の ID・版・状態を表示し、停止中に起きた変化（起動時の回復）が表示に反映される                                                               |
| E2  | 中枢が止まっている間に A で操作をしようとする（承認・取消の UI が入った後）                                   | 送らずに「接続していません」。復帰の後も自動では送られない                                                                                                                                    |
| E3  | 中枢の画面（または CLI）で A を失効する                                                                       | A はすぐに「この端末は失効しました」（再登録が必要）。B は「● 接続中」のまま                                                                                                                  |
| E4  | A のデスクトップを起動し直す                                                                                  | 「この端末の登録が無効です」（401）で再登録が必要。要求を繰り返さない                                                                                                                         |
| E5  | 中枢の TLS の鍵の項目を消して（`security delete-generic-password -s dev.buddy.core -a tls-key-v1`）起動し直す | 中枢の `certificate_creation` が作り直しを示し、前の証明書の端末を失効する。B は「中枢の証明書が登録時と違います」で再登録が必要。B は中枢へ要求を送っていない（中枢のログに B の要求がない） |
| E6  | B を登録し直す（C2〜C4 と同じ手順。指紋は新しい証明書のもの）                                                 | 登録でき、「● 接続中」                                                                                                                                                                        |

## 後片付け（任意）

- 端末の登録をやめる場合は、デスクトップを終了してから userData の `device-credential.bin` を消し、中枢で端末を失効します。safeStorage の鍵（キーチェーンの「Buddy Desktop Safe Storage」）は他の Electron アプリと共有しないので、消しても他に影響しません。
- 中枢の TLS の鍵を消すと全端末の再登録が要ります（E5）。データ鍵（`data-key-v1`）は消さないでください（B02 の device-check を参照）。

## 記録の形式

各項目が期待どおりか、違った点を伝えてもらい、司令塔が `tests/integration/evidence-b03-<端末>.json` に写します（`{ "status": "recorded", "description": ..., "records": [...] }`、1 項目 1 件、09 §8 の項目をすべて埋める）。

| case_id                        | 対応   | `final_state` の例                                       |
| ------------------------------ | ------ | -------------------------------------------------------- |
| `B03-mac-hub-tls-key`          | A1〜A5 | `created（キーチェーンに TLS の鍵、指紋は再起動で同じ）` |
| `B03-mac-hub-tailscale-status` | B1〜B2 | `available（候補 <n> で取得）`                           |
| `B03-mac-first-device-pairing` | C1〜C6 | `connected（safeStorage に保存、平文なし）`              |
| `B03-mac-lock-and-restart`     | C7〜C8 | `connected（ロック中は隠す、再起動の後に再接続）`        |
| `B03-<os>-home-network`        | D1〜D7 | `allowed / denied（理由のコードだけ）`                   |
| `B03-two-devices-reconnect`    | E1〜E2 | `connected（同じ ID・版・状態、切断中の命令は送らない）` |
| `B03-two-devices-revoke`       | E3〜E4 | `reregistration_required（A のみ。B は connected）`      |
| `B03-two-devices-certificate`  | E5〜E6 | `reregistration_required → connected（再登録）`          |

- `kind` は `real_device`、`commit` は確認したビルドのコミット、`environment.os` は OS の版、`environment.hub` は機種、`environment.devices` は端末の OS と種類（値・名前は写さない）、直接経路か DERP かは `final_state` に書く、`provider_requests`・`provider_state_changes`・`approvals` は 0、`seed`・`fault_point`・`voice_stop_ms` は null。
- 模擬の試験（CI）の結果をこのファイルに混ぜません（`scripts/test-map.test.mjs` が `kind: real_device` 以外を拒否する）。
