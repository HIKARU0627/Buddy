# @buddy/core

Electron から独立した Node.js 中枢です。B01-01 で、起動・状態確認・停止、単一起動の排他、同じマシン専用のローカル制御チャネルを実装しました（[ADR 0012](../../docs/adr/0012-b01-core-lifecycle-and-local-control.md)）。
HTTP API・端末との接続・認証・TLS は B03、DB は B02、LaunchAgent と鍵保護の実検査は B01-02 で追加します。

## 使い方

ビルド後（`pnpm run build`）、リポジトリのルートで次のように動かします。

```sh
node apps/core/dist/cli.js start --mock-key-protection   # フォアグラウンドで起動（Ctrl+C で停止）
node apps/core/dist/cli.js status                        # 状態を JSON で表示
node apps/core/dist/cli.js stop                          # 停止を要求し、解放まで待つ
```

- `--data-dir <path>` でデータディレクトリを指定できます。既定は macOS `~/Library/Application Support/Buddy/core`、Windows `%APPDATA%\Buddy\core`、Linux `$XDG_DATA_HOME/buddy/core`（なければ `~/.local/share/buddy/core`）です。
- 鍵保護の実検査（B01-02）がまだないため、`start` は `--mock-key-protection` を付けた模擬起動だけを受け付けます。`--mock-key-protection-unavailable` は鍵保護が使えない状態を再現し、起動を拒否します。平文の保存へ切り替える経路はありません。
- 標準出力には機械向けの JSON を 1 行ずつ、標準エラーには人向けの記録を書きます。
- 終了コード: 0 正常、1 障害、2 使い方の誤り、3 動いている Core がない（status / stop）、4 排他による拒否、5 起動前の検査による拒否。

## データディレクトリ

| ファイル          | 内容                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `core.lock`       | 単一起動のロック（pid・core_instance_id・起動時刻）。停止時に消える                               |
| `core-state.json` | store_generation と作成時刻だけ。**B02 で DB に置き換えるまでの仮置き**。通常の再起動では維持する |
| `control.sock`    | 制御チャネル（macOS / Linux、0600）。Windows は名前付きパイプ                                     |

ディレクトリは本人だけの権限（POSIX は 0700）にします。個人のパスや値をリポジトリに書かないでください。

## 構成

| ファイル                  | 責務                                                   |
| ------------------------- | ------------------------------------------------------ |
| `src/cli.ts`              | `buddy-core` の CLI とシグナル                         |
| `src/core.ts`             | `startCore`（起動・停止の手順）                        |
| `src/lifecycle.ts`        | starting / running / stopping / stopped の純粋な遷移表 |
| `src/lock.ts`             | 単一起動の排他と古いロックの片付け                     |
| `src/control-protocol.ts` | 制御要求の厳格な検査                                   |
| `src/control-channel.ts`  | Unix socket / 名前付きパイプの送受信                   |
| `src/data-dir.ts`         | データディレクトリの準備と状態ファイルの原子的な書込み |
| `src/paths.ts`            | OS 別の既定値と接続先                                  |
| `src/preflight.ts`        | 起動前の検査の入口と模擬の鍵保護                       |
| `src/strict-json.ts`      | 重複キーを拒否する JSON の読み取り                     |

試験は `src/*.test.ts` で、ビルド後の `dist/*.test.js` を `pnpm test` が実行します。子プロセスで `dist/cli.js` を動かすヘッドレス起動の試験を含みます（模擬のみ。実機の LaunchAgent・鍵管理・電源断は未実施）。
