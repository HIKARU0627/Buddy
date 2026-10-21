# ADR 0022: 自宅ネットワークの判定（指紋と Tailscale の直接経路）

- 日付: 2026-10-21
- 状態: B03-03（#64）の判断と実装。自宅の指紋の契約・報告と登録の経路・ペアリングの申請と受取りの指紋の項目、domain の判定の関数、マイグレーション 0003（自宅の登録値と端末ごとの最新の報告、MAC・SSID は HMAC）、platform の指紋の収集と Tailscale の状態の取得のアダプター（模擬版つき）、Core の判定（不成立なら 403・接続範囲の失効・切断の通知）を作った。試験は 127.0.0.1 の模擬（模擬の runner・模擬の Tailscale の状態・模擬の KeyStore・一時ディレクトリの DB）だけで、実機の Tailscale・指紋の取得・実際の端末からの接続は未実施。
- 根拠: 設計 11 §10、02 端末登録と接続・運用上の境界、06 B03、09 X42、ADR 0009（経路の検査順）・0019（データ鍵の照合値）・0020（HTTPS の受付・RequestEnvironment）。下の「本人の判断」は 2026-10-21 の決定。設計本文は今回の作業環境に取得できず、Issue #64 の要約と ADR に基づく。原本との照合はレビューで行う。

## 本人の判断（2026-10-21）

| 対象             | 決定                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------- |
| 指紋の要素       | ゲートウェイの MAC とサブネットは必須。SSID は登録値と報告の両方で取れたときだけ比べる |
| 自宅の数         | 家ごとに 1 つ。中枢の画面から登録する                                                  |
| Tailscale の状態 | `tailscale status --json` で取得する                                                   |
| 報告の鮮度       | 端末からの最後の報告から 6 分を過ぎたら拒否する                                        |
| 保存             | MAC と SSID は HMAC にして保存する。HMAC の鍵の置き場所は ADR に書く                   |

## 決めたこと

### 判定（domain の `homeNetworkDecision`）

次の二つを両方満たすときだけ許可する（11 §10）。端末認証の代わりではなく追加の条件で、端末トークンの照合（device_token）は経路の検査で先に行う。

1. 自宅の指紋が一致する: 報告のゲートウェイの MAC の HMAC とサブネットが登録値と同じ。SSID は登録値と報告の両方にあるときだけ比べる。
2. Tailscale の直接経路が自宅 LAN の中にある: 接続元のアドレスに合うピアの CurAddr が空でなく、そのアドレスが登録したサブネットの中にある。

どちらかを満たさない・確かめられないときは不成立で、指紋だけの許可に切り替えない。理由のコード（診断用。MAC・SSID・アドレスの値を含めない）は次のとおりで、判定できるものはすべて返す。

| 理由                                                          | 意味                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `home_not_registered`                                         | 自宅が未登録                                                       |
| `report_missing`・`report_stale`・`report_clock_inconsistent` | 報告がない・受け取りから 6 分以上・中枢の時計が受け取りより前      |
| `gateway_mac_unavailable`・`gateway_mac_mismatch`             | ゲートウェイの MAC が取れない・違う                                |
| `subnet_unavailable`・`subnet_mismatch`                       | サブネットが取れない・違う                                         |
| `ssid_mismatch`                                               | 両方にある SSID が違う                                             |
| `tailscale_unavailable`                                       | `tailscale status --json` を取得できない・読めない・Running でない |
| `tailscale_peer_not_found`                                    | 接続元のアドレスに合うピアがない（同じアドレスのピアが複数も含む） |
| `tailscale_derp`                                              | CurAddr が空で Relay（DERP の地域）がある                          |
| `tailscale_peer_relay`                                        | CurAddr が空で PeerRelay がある（ピアの中継）                      |
| `direct_address_missing`                                      | CurAddr も中継も空（経路を確認できない）                           |
| `direct_address_invalid`・`direct_address_outside_home`       | CurAddr が読めない・自宅のサブネットの外（IPv6 を含む）            |

- 鮮度: 報告は中枢が受け取った時刻（UTC）から 6 分（360,000 ms）の前だけ使う。ちょうど 6 分で使わない（`leaseReasons`・接続範囲の期限と同じ「期限の前だけ」）。端末の時計は使わない。
- サブネット: IPv4 の CIDR で、ネットワークのアドレス（ホスト部が 0）・接頭辞の長さ 8〜30 だけ。広すぎる範囲（/0〜/7）で直接経路の条件が実質なくなるのを防ぐ。JSON Schema では接頭辞の長さと表記を、Core ではホスト部が 0 であることを検査する（違えば 422）。

### 経路と契約

| 経路                                                       | 検査                                                                              | 内容                                                                                                                                                                                               |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/home-network/reports`（`reportHomeFingerprint`） | device_token                                                                      | 端末の指紋（`HomeFingerprintReport`）。報告そのものが判定の材料なので home_network を求めない。応答は報告を受け取った後の判定（`HomeNetworkStatus`）。不成立なら接続範囲を失効させ、切断を知らせる |
| `PUT /v1/home-network/registration`（`registerHome`）      | device_token・home_network・command_scope・unlocked・screen_operation・hub_screen | 中枢の画面だけ（`startPairing` と同じ検査）。家ごとに 1 つで、登録し直すと置き換える。応答（`HomeRegistration`）に MAC・SSID を返さない                                                            |

- `HomeFingerprint`: `gateway_mac`（小文字のコロン区切り）・`subnet`・`ssid`（1〜32 文字）。取れない要素は null。
- `PairingClaimRequest`・`PairingTokenRequest` に `home_fingerprint` を必須で足した。認証前の申請・受取りは端末の報告を持たないため、本文の指紋をその時点の報告として判定する（Tailscale の直接経路も求める）。
- `ApiError` のコードは足していない（不成立は既存の 403 `outside_home_network`）。

### 不成立のときの扱い

- 経路の検査で 403 `outside_home_network`（ApiError だけ。診断の理由は報告の応答と Core の記録に出す）。
- 認証済みの端末なら、その端末の有効な接続範囲（command_scope）を失効させる（`home.revoke_scopes`）。音声・機密表示のリース（`Lease`）は接続範囲に結び付いており、接続範囲が変われば無効（`leaseReasons` の `scope_changed`）なので、リースの表はまだないが同時に失効する。
- 失効の後に `HomeNetworkGate.onDenied(deviceId, reasons)` で知らせる。WSS を閉じる差し込み口で、Core は `CoreHandle.homeNetwork` として出す。B03-04 の `DeviceConnections.closeDevice(deviceId, 'outside_home_network')` へは統合のときに 1 行でつなぐ（B03-04 は ping ごとに `RequestEnvironment.homeNetwork` を引き直す）。
- 判定の元（自宅の登録値・報告）を DB から読めないときは例外にし、経路の検査は 503（許可にしない）。

### HMAC の鍵の置き場所

- 鍵はデータ鍵（キーチェーンの `data-key-v1`、ADR 0017）から導く: `HMAC-SHA256(データ鍵, "buddy.home_network.hmac.v1" + NUL + key_id)` の 32 バイト。Core の起動でデータ鍵をロックの後に読み直すとき（ADR 0019）に一度だけ導き、導いた鍵だけをメモリに置く（データ鍵そのものは保持しない）。DB・ディスク・キーチェーンの別の項目には置かない。
- MAC は `HMAC-SHA256(鍵, "gateway_mac" + NUL + MAC)`、SSID は `HMAC-SHA256(鍵, "ssid" + NUL + SSID の UTF-8)` の 16 進。用途の文字列で値の種類を分ける。
- 鍵の値・MAC・SSID はログ・例外・応答に出さない（`HomeNetworkKey` は文字列化・JSON・inspect で `[redacted]`）。
- 鍵の版は持たない。データ鍵が変われば鍵の照合値が合わず DB を開けない（ADR 0019）ので、古い鍵の HMAC と比べることはない。

### 保存（マイグレーション 0003）

| 表                     | 内容                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `home_networks`        | 自宅の登録値。`home_id = 1` の 1 行だけ。MAC・SSID の HMAC（32 バイトの BLOB、SSID は NULL 可）・サブネット・登録した端末と時刻 |
| `home_network_reports` | 端末ごとの最新の報告（端末 ID が主キー）。MAC・SSID の HMAC とサブネット（取れなければ NULL）・中枢が受け取った時刻             |

DB worker に `type: 'home'` のメッセージで `home.register`・`home.get`・`home.report`・`home.find_report`・`home.revoke_scopes` を足した（`packages/storage/src/home-network-store.ts`）。書込みは 1 つの短い BEGIN IMMEDIATE の transaction で、命令ごとに耐久設定を読み戻し、halted の worker は書かない（ADR 0018 と同じ）。失効した端末・未登録の端末の報告と登録は拒否する。表ごとの方針（`TABLE_POLICIES`）に 2 表を足し、`scripts/storage.test.mjs` は全版のマイグレーションを順に適用するようにした。

### 中枢と同じマシンの免除

- 認証した端末は、`hub_local` で、かつ接続元が同じマシン（ループバック、または待ち受けのアドレスと同じ IP）のときだけ自宅判定を免除する。トークンは必要（device_token の検査が先）。hub_local の端末のトークンを別のマシンから使っても免除しない。
- 端末のない申請・受取り（`claimPairing`・`pickupPairingToken`）は、接続元が同じマシンなら免除する。最初の端末（中枢の画面）を登録するためで、登録前なので hub_local を確かめられない（B03-02 と合わせた読み取り）。
- 同じマシンの判定は B03-02 の `isSameMachine(remoteAddress, listenHost)` と同じ意味で、このブランチでは `isSameMachineAddress` として置いた。統合で一つにまとめる。
- 外出先からの接続を有効にする経路・設定・CLI の引数は作らない（初期版は OFF に固定）。試験で経路の表・schema にそれらしい名前がないことを確かめる。

### platform のアダプター

| アダプター                    | コマンド                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 指紋の収集（端末側、macOS）   | `/sbin/route -n get default`（gateway・interface）→ `/usr/sbin/arp -n <gateway>`（MAC。先頭の 0 を補う）→ 接続口の IPv4 とネットマスク（`os.networkInterfaces` の値）からサブネット → `/usr/sbin/ipconfig getsummary <interface>` の SSID（`<redacted>` なら `/usr/sbin/networksetup -getairportnetwork <interface>`） |
| 指紋の収集（端末側、Windows） | `powershell.exe -NoProfile -NonInteractive -Command`（`Get-NetRoute` の 0.0.0.0/0 で metric の和が最小の経路・`Get-NetNeighbor` の LinkLayerAddress・`Get-NetIPAddress` の IPv4 と PrefixLength を JSON で出す）→ `netsh.exe wlan show interfaces` の SSID の行（複数なら取得できない）                                |
| Tailscale の状態（中枢側）    | `tailscale status --json`。実行ファイルは `/Applications/Tailscale.app/Contents/MacOS/Tailscale`・`/opt/homebrew/bin/tailscale`・`/usr/local/bin/tailscale`・`tailscale` の順に試す（起動できなければ次へ）。既定 5 秒だけ保持して取り直し、同時の要求は一度の実行にまとめる                                           |

- すべて `CommandRunner` 経由で shell を通さずに実行する。CI では実機のコマンドを呼ばず、模擬の runner に合成の出力を渡す。
- 取れない要素は null（理由のコードつき）で、推測で埋めない。Linux は対象外（すべて取得できない）。
- Core は `CoreHttpsOptions.tailscale` で状態の取得元を受け取る。CLI は `--mock-key-protection` でない起動のときだけ実機の `tailscale` を使い、模擬の起動・省略したときは常に取得できない扱い（中枢と同じマシンのクライアントだけが通る）。

## 試験

| 試験                                              | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/home-network.test.mjs`                   | `home-network-cases.json`（手書き）の 22 例と判定の一致、理由のコードと schema の一致、鮮度 6 分、報告・登録の経路の検査、外出の経路がない、サブネットの正準の表記                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/core/src/api-home-network.test.ts`          | HTTPS で X42: 一致と直接経路で許可（トークンなし・失効は 401）、指紋の不一致・DERP・経路不明・Tailscale を取得できない・止まっている・ピアなし・指紋だけ（直接のアドレスが自宅の外）はいずれも 403 で接続範囲を失効させ通知し、古い接続範囲の命令も 403。鮮度（5:59.999 は許可・6:00 で拒否・時計の巻き戻り）、SSID の比較の条件、未登録、サブネットのホスト部の 422、同じマシンの免除（トークンなしは 401・hub_local でない端末・別のマシンからの hub のトークンは免除しない）、申請・受取りの本文の指紋、WSS の切り替えの 403、DB を読めないときに許可しない、HMAC の値（openssl で別に求めた値）と鍵を出さないこと |
| `apps/core/src/home-network-core.test.ts`         | startCore への組み込み（取得元なしは同じマシンの hub だけ、模擬の状態で登録・報告・判定・通知）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/storage/src/home-network-store.test.ts` | 登録の置き換え・報告の最新 1 件・BLOB で保存、失効・未登録の端末の拒否、接続範囲の失効（他の端末に触れない）、平文らしい値・形の不正・halted・耐久設定の不一致、DB worker のクライアント経由                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/platform/src/home-fingerprint.test.ts`  | macOS・Windows の合成の出力からの収集、`<redacted>` の SSID と代わりのコマンド、経路なし・不完全な ARP・接続口なし、有線・権限なしの SSID、複数の無線の接続口、MAC・ネットマスク・サブネットの正規化、Linux は対象外                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/platform/src/tailscale-status.test.ts`  | 接続元のアドレスからのピアの特定（IPv4 射影・IPv6・大文字）と直接・DERP・ピアの中継・不明の区別、読めない・止まっている・同じアドレスのピアが複数、候補の順・終了コード・例外、5 秒の保持と取り直し・同時の要求のまとめ・単調時計の巻き戻り                                                                                                                                                                                                                                                                                                                                                                           |
| `tests/fixtures/storage-cases.json`               | 0003 の制約（1 行だけ・32 バイトの HMAC・サブネットの形・外部キー）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/contracts/fixtures/schema-cases.json`   | 指紋・報告・状態・登録・申請の正例と負例（大文字・ハイフンの MAC、/31・/7・IPv6 のサブネット、空・長い SSID、外出のスイッチ、MAC を返す応答）                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

各試験に時間の上限を付け、後始末は `onCleanup`（後に登録したものから先、閉じてから削除）で行う。MAC・SSID・アドレスは文書用の合成値で、実機の値はコミットしていない。

## 実機での確認（B03-05 の実機確認の手順の下書き）

結果（期待どおりか、違った点）だけを記録し、MAC・SSID・アドレス・ホスト名の値は記録に写さない。

1. 中枢（Mac mini）で `tailscale status --json` が上の候補のどれかで動き、Core の LaunchAgent（PATH が短い）から実行できるか。Mac App Store 版のアプリに同梱の CLI を別のプロセスから呼べるか。
2. 自宅の LAN にいる端末（macOS・Windows）から接続したとき、中枢の `tailscale status --json` のそのピアの `CurAddr` が LAN の IPv4 のアドレスになるか（IPv6 のアドレスや DERP にならないか）。ならない場合は自宅でも拒否される（読み取りの「IPv6 の直接経路」）。
3. 端末を自宅の外（携帯回線のテザリングなど）に移し、`CurAddr` が空（DERP）か自宅のサブネットの外になり、403 で拒否されることを確かめる。
4. macOS の端末で `route -n get default`・`arp -n`・`ipconfig getsummary`・`networksetup -getairportnetwork` の出力が想定の形か。macOS 14.4 以降で SSID が `<redacted>` になるか（位置情報の許可の有無）。有線の場合に SSID が取れない扱いになるか。
5. Windows の端末で PowerShell の `Get-NetRoute`・`Get-NetNeighbor`・`Get-NetIPAddress` が想定の JSON を出すか（実行ポリシー・言語の設定の影響）。`netsh wlan show interfaces` が位置情報の許可なしで SSID を出さない場合に、取得できない扱いになるか。
6. VPN・Tailscale の出口ノードを使っているときの既定の経路（ゲートウェイが LAN のものでなくなる）で拒否されることを確かめる。
7. 中枢の画面から自宅を登録し、端末の報告から 6 分を過ぎると拒否され、報告し直すと戻ることを確かめる。

## 読み取り（レビュー対象）

原本に明記がなく、実装で決めた点です。

- **報告の経路に home_network を求めない**: 報告が判定の材料なので、求めると報告が古くなった端末が二度と報告できない。端末トークンは必要で、報告だけでは許可にならない（Tailscale の直接経路も要る）。
- **受取り（pickupPairingToken）にも指紋の項目を足した**: Issue は「申請の指紋の項目」だけだが、受取りにも自宅判定があり、登録前の端末は報告を持たないため。申請の時点の指紋を保存して使う案は、申請の保存（B03-02）に依存するので採らなかった。
- **登録前の同じマシンからの申請・受取りの免除**: Issue の免除の条件（hub_local の端末）を、端末のない要求では確かめられないため。最初の端末（中枢の画面）の登録に要る（B03-02 と合わせた）。
- **報告の応答に診断の理由を返す**: 自宅の外の端末にも「DERP」「指紋の不一致」などのコードが見える。値は含めない。端末の画面で「自宅の Wi-Fi に接続してください」などを出すのに使う想定。
- **6 分ちょうどで拒否**: 「6 分を過ぎたら」を、他の期限と同じ「期限の前だけ使う」に読んだ。
- **自宅のサブネットは IPv4 だけ・接頭辞は 8〜30**: 家庭の LAN の IPv6 の接頭辞は回線の契約で変わり得るため、初期版は IPv4 にした。自宅の中でも Tailscale が IPv6 の LAN のアドレスで直接つながると拒否される（実機の確認 2）。
- **PeerRelay は直接経路ではない**: 新しい Tailscale のピアの中継（peer relay）は CurAddr が空のまま使われる前提で、DERP と別の理由にした。CurAddr があれば直接経路とみなす。
- **同じアドレスのピアが複数あれば見つからない扱い**: 読み違いを許可にしない。
- **Tailscale の状態の保持は 5 秒**: 「短い周期で取り直す」を、要求ごとに取り直さず 5 秒の間は同じ結果を使う形にした（実行の頻度を抑える）。失敗も 5 秒保持する。専用の定期の再判定は作らず、要求ごとの判定と B03-04 の ping ごとの引き直しに頼る。
- **不成立のたびに接続範囲の失効を書く**: すでに失効していれば 0 件の UPDATE。拒否された要求ごとに短い書込みが 1 回増える。
- **端末側の収集は platform に置いた**: Issue の指定どおり。ただし ADR 0015 でデスクトップの main は OS アダプター（`@buddy/platform`）を読み込めないので、端末の定期報告（B03-05）で使うときは、境界の見直し（指紋の収集だけを読み込めるようにする、など）が要る。
- **既定の環境（`SAFE_REQUEST_ENVIRONMENT`）は変えていない**: Core は常に自宅判定を注入するので、`createApiServer` を直接使うときの安全側の既定（hub_local だけ）は B03-01 のまま。
- **tests/test-map.json**: X42 に契約の期待値（判定の fixture・経路・schema・保存の制約）を足して `contract_fixture` にした。HTTP 経由の模擬の試験は通ったが、実機の Tailscale・指紋の取得は未実施なので `product_test` は not_run のまま。

## 残ること

- 端末側の定期報告の組み込み（B03-05）と、デスクトップの main から指紋の収集を使うための境界の見直し。
- WSS の切断の配信（B03-04 の `DeviceConnections` へ `onDenied` をつなぐ）。
- 中枢の画面の自宅の登録の UI（登録の経路は作った）。
- 上の実機での確認。
