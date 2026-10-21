# @buddy/core

Electron から独立した Node.js 中枢です。B01-01 で、起動・状態確認・停止、単一起動の排他、同じマシン専用のローカル制御チャネルを実装しました（[ADR 0012](../../docs/adr/0012-b01-core-lifecycle-and-local-control.md)）。
B02-04 で DB（`@buddy/storage` の DB worker）を起動に組み込み、鍵の照合値・store_generation の状態ファイルからの移行・起動時の回復を作りました（[ADR 0019](../../docs/adr/0019-b02-core-storage-integration.md)）。B03-01 で自己署名証明書（秘密鍵はキーチェーン）と `node:https`（TLS 1.3 以上）の受付、端末トークンの照合、上限・形式・Origin・接続数・頻度の拒否、ROUTE_CHECKS の順の経路検査、`getBootstrap` と接続範囲の発行を作りました（[ADR 0020](../../docs/adr/0020-b03-https-tls-and-route-checks.md)）。B03-02 で端末のペアリング・端末の一覧と失効・最初の端末の CLI の承認を作りました（[ADR 0021](../../docs/adr/0021-b03-device-pairing-and-revocation.md)）。B03-03 で自宅判定（自宅の指紋の一致と Tailscale の直接経路の両方。不成立は 403・接続範囲の失効・WSS の切断）と、自宅の指紋の報告・自宅の登録の経路を作りました（[ADR 0022](../../docs/adr/0022-b03-home-network-check.md)）。スナップショット・イベント・操作の経路は B03-04（下の節）です。鍵保護の可否の確認・KeyStore と LaunchAgent は `@buddy/platform`（ADR 0013・0017）を使います。

## 起動の順序

起動前検査（鍵保護。初回は鍵を作る）→ データディレクトリ → 単一起動のロック → データ鍵の読み直し（作成しない）→ B01 の状態ファイルの読み取り → DB worker（書込み接続・耐久設定の読み戻し・マイグレーション・`quick_check`・鍵の照合値・store_generation）→ 状態ファイルの片付け → 起動時の回復（dispatching を unknown_held へ。自動では送らない）→（`--https-host` を渡したとき）TLS の身元（秘密鍵はキーチェーン）→ HTTPS の待ち受け → 制御チャネル → running。どこかで失敗したら書込みを始めず、DB worker を閉じ、ロックを返して起動を拒否します。停止は「受付停止 → HTTPS → 制御チャネル → DB worker → ソケット・ロック」の順です。

## 使い方

ビルド後（`pnpm run build`）、リポジトリのルートで次のように動かします。

```sh
node apps/core/dist/cli.js start --mock-key-protection   # フォアグラウンドで起動（Ctrl+C で停止）
node apps/core/dist/cli.js status                        # 状態を JSON で表示
node apps/core/dist/cli.js stop                          # 停止を要求し、解放まで待つ
```

- `--data-dir <path>` でデータディレクトリを指定できます。既定は macOS `~/Library/Application Support/Buddy/core`、Windows `%APPDATA%\Buddy\core`、Linux `$XDG_DATA_HOME/buddy/core`（なければ `~/.local/share/buddy/core`）です。
- `start` は既定で実行中の OS の鍵保護を確かめ、使えなければ起動を拒否します（初期版の中枢は macOS だけ）。`--mock-key-protection` は試験・模擬起動用、`--mock-key-protection-unavailable` は鍵保護が使えない状態を再現します。平文の保存へ切り替える経路はありません。
- `--https-host <ip>` を渡すと HTTPS を待ち受けます（省略すれば開かない）。製品は Tailscale のアドレス、試験は `127.0.0.1` を渡します。IP アドレスだけを受け付け、全アドレス（`0.0.0.0`・`::`）は拒否します。`--https-port <port>` の既定は 47443（0 は OS が選ぶ）。`start` は `running` の前に `https_listening`（host・port・証明書の指紋・証明書を作ったか）を出します。TLS の秘密鍵を鍵保護から取得できなければ HTTPS を開かずに起動を拒否します（終了コード 5）。
- `first-device start` は、登録済みの（失効していない）端末が 0 台のときだけ、動いている Core に最初の端末のペアリングを頼み、ワンタイムコード（8 桁・有効 5 分）と証明書の指紋を標準出力に出します（コードは本人が端末に入力するための表示で、Core のログには出しません）。同じマシンの端末で指紋を確かめてコードを入力した後、`first-device approve --pairing-id <id>` で承認します。端末は承認の後にトークンを 1 回だけ受け取ります。1 台でも登録があれば拒否します（終了コード 7）。Core の制御チャネルを使い、DB を直接開きません。
- `autostart enable | disable | status` でログイン後の自動起動（macOS の LaunchAgent）を設定します。enable は次のログインから有効で、すぐには起動しません。
- `--mock-key-protection` の鍵は公開の固定文字列から求めた模擬の鍵で、DB は保護されません。実機の鍵で作った DB は模擬起動では開けません（逆も同じ。鍵の照合値が合わない）。
- 標準出力には機械向けの JSON を 1 行ずつ、標準エラーには人向けの記録を書きます。`start` は `running` の前に `store_opened`（schema_version・store_generation とその出どころ・鍵の照合値の保存／一致・起動時の回復の結果）を出します。
- 終了コード: 0 正常、1 障害、2 使い方の誤り、3 動いている Core がない（status / stop / first-device）、7 最初の端末の命令の拒否（登録済みの端末がある・HTTPS がない・申請がないなど）、4 排他・保存の検査による拒否（状態ファイル・DB の耐久設定・版・健全性・世代の食い違い・回復）と HTTPS の設定・待ち受けの失敗、5 鍵保護・データ鍵の照合・TLS の鍵による拒否。

## データディレクトリ

| ファイル              | 内容                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `core.lock`           | 単一起動のロック（pid・core_instance_id・起動時刻）。停止時に消える                            |
| `buddy.sqlite`        | DB（0600。`-wal`・`-shm` が並ぶ）。store_generation・鍵の照合値・操作などの正本                |
| `core-state.json`     | B01 の状態ファイル。残っていれば起動時に store_generation を DB へ移して消す。新しくは作らない |
| `control.sock`        | 制御チャネル（macOS / Linux、0600）。Windows は名前付きパイプ                                  |
| `tls-certificate.pem` | HTTPS の自己署名証明書（公開部分、0600）。秘密鍵はキーチェーン（`tls-key-v1`）にだけ置く       |

ディレクトリは本人だけの権限（POSIX は 0700）にします。個人のパスや値をリポジトリに書かないでください。

## 構成

| ファイル                               | 責務                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `src/cli.ts`                           | `buddy-core` の CLI とシグナル                                                 |
| `src/core.ts`                          | `startCore`（起動・停止の手順）                                                |
| `src/lifecycle.ts`                     | starting / running / stopping / stopped の純粋な遷移表                         |
| `src/lock.ts`                          | 単一起動の排他と古いロックの片付け                                             |
| `src/control-protocol.ts`              | 制御要求の厳格な検査                                                           |
| `src/control-channel.ts`               | Unix socket / 名前付きパイプの送受信                                           |
| `src/data-dir.ts`                      | データディレクトリの準備と B01 の状態ファイルの読み取り・片付け                |
| `src/recovery.ts`                      | 起動時の回復（dispatching を unknown_held へ）                                 |
| `src/paths.ts`                         | OS 別の既定値と接続先                                                          |
| `src/preflight.ts`                     | 起動前の検査の入口、鍵保護の確認、起動の種類の KeyStore                        |
| `src/autostart.ts`                     | ログイン後の自動起動の設定（platform の LaunchAgent）                          |
| `src/strict-json.ts`                   | 重複キーを拒否する JSON の読み取り                                             |
| `src/api-server.ts`                    | HTTPS の受付（上限・Origin・接続数・頻度・認証・形式・経路の検査・WSS の土台） |
| `src/api-routes.ts`                    | 経路の表（OpenAPI と同じことを試験）と照合                                     |
| `src/api-auth.ts`                      | 端末トークンの形式と照合用の hash、接続範囲の判定                              |
| `src/api-environment.ts`               | 判定の元がまだない文脈（自宅判定など）の注入と安全側の既定                     |
| `src/api-contract.ts`                  | 要求の JSON Schema の検査（Ajv）                                               |
| `src/api-pairing.ts`                   | ペアリング・端末の一覧と失効の経路、中枢の画面の判定、最初の端末の CLI の承認  |
| `src/api-home-network.ts`              | 自宅判定（指紋と Tailscale の直接経路、ADR 0022）・報告と登録の経路・HMAC の鍵 |
| `src/tls-certificate.ts`・`src/der.ts` | 自己署名証明書の組み立て・検査・指紋                                           |
| `src/tls-identity.ts`                  | TLS の秘密鍵（KeyStore）と証明書（データディレクトリ）の読み込み・初回作成     |

試験は `src/*.test.ts` で、ビルド後の `dist/*.test.js` を `pnpm test` が実行します。HTTPS の試験は 127.0.0.1 の模擬で、ピン留めする試験用のクライアント（`src/api-test-support.ts`、信頼の起点は中枢の証明書 1 枚・指紋の照合の後にだけ要求を書く）を使います。子プロセスで `dist/cli.js` を動かすヘッドレス起動の試験と、再起動の後の復元・強制終了の後の再起動の試験（`restore.test.ts`）を含みます（模擬のみ。実機の LaunchAgent・鍵管理・電源断は未実施。実機の手順は [docs/b02/device-check.md](../../docs/b02/device-check.md)）。

## スナップショット・イベント・操作の経路（B03-04）

[ADR 0023](../../docs/adr/0023-b03-snapshot-events-and-operation-routes.md) で、`getSnapshot`・`getEvents`・`getOperation`・`approveOperation`・`cancelOperation` の経路と、WSS `/v1/events/stream` の配信を作りました（127.0.0.1 の模擬のみ）。

| ファイル                    | 責務                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/api-operations.ts`     | スナップショット・イベントの再取得・操作の取得・承認・取消の経路（DB worker の命令と command_receipts の再送の規則へつなぐ） |
| `src/event-cursor.ts`       | event_cursor（DB 世代・連番・発行の時刻の不透明な値）の符号化と、再生できるかの判定（7 日・世代違い・欠け）                  |
| `src/event-feed.ts`         | イベントの配信の元。DB worker の照会で COMMIT 済みの行を読み、購読ごとに位置を進める（命令の後の通知と一定の間隔の読み直し） |
| `src/event-stream.ts`       | WSS の配信（開始位置のクエリー cursor・接続範囲への結び付け・ping・理由つきで閉じる）                                        |
| `src/device-connections.ts` | 端末の接続を閉じる差し込み口（失効 B03-02・自宅判定 B03-03 が `closeDevice` を呼ぶ）                                         |

`CoreHandle.events`（`EventFeed`）と `CoreHandle.deviceConnections` を出しています。操作の命令を HTTP の経路の外から送るときは `events.notify()` を呼ぶか `events.watchStore(store)` を通すと、すぐに配られます（呼ばなくても 1 秒ごとに読み直します）。
