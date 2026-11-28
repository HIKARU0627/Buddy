# @buddy/platform

OS 別の鍵保護・起動・端末能力のアダプターを置きます（[ADR 0013](../../docs/adr/0013-b01-platform-adapters.md)・[ADR 0017](../../docs/adr/0017-b02-keystore-and-encryption.md)・[ADR 0020](../../docs/adr/0020-b03-https-tls-and-route-checks.md)・[ADR 0202](../../docs/adr/0202-windows-core-key-protection-dpapi.md)）。Core から使い、共有層（contracts・domain）からは import しません。Electron には依存しません。

- `src/runner.ts`: コマンド実行の境界 `CommandRunner`。実機用の `createNodeCommandRunner`（shell を通さない）と、試験用の `createMockCommandRunner`。
- `src/supervisor.ts`: 起動・監督の境界 `StartupSupervisor`（register・unregister・status）。Linux などは `unsupported` を返す。
- `src/macos-launch-agent.ts`: ログイン後の LaunchAgent。plist の生成（純粋関数）、`~/Library/LaunchAgents/dev.buddy.core.plist` への書き出しと `launchctl bootstrap` / `bootout`。`enabled: true` を受け取らない限り登録しません。KeepAlive は付けません。
- `src/macos-diagnostics.ts`: `pmset -g` のスリープ設定と `fdesetup status` の FileVault の状態のパーサー。判定できなければ unknown。
- `src/key-store.ts`: 中枢のデータ鍵の `KeyStore`（`loadDataKey`・`loadOrCreateDataKey`）。macOS はキーチェーン（`@napi-rs/keyring`、サービス名 `dev.buddy.core`・アカウント名 `data-key-v1`）に 32 バイトの乱数を base64 で保存し、読み出し時に形式と長さを検査します。ネイティブモジュールは初めて鍵を読むときに読み込み、Windows・Linux では読み込みません。試験用の `createMockKeyStore`（`kind: 'mock'`）。鍵の値は結果の理由・例外・`JSON.stringify`・`inspect` に出しません。
- `src/tls-key-store.ts`: 中枢の TLS の秘密鍵の `TlsKeyStore`（`loadTlsKey`・`loadOrCreateTlsKey`、[ADR 0020](../../docs/adr/0020-b03-https-tls-and-route-checks.md)）。ECDSA P-256 の鍵を作り、キーチェーンのデータ鍵と同じサービス名の別の項目（アカウント名 `tls-key-v1`）に PKCS#8 の DER を正準の base64 で保存し、読み出し時に P-256 の EC 秘密鍵であることを検査します。平文の鍵をディスクに置きません。試験用の `createMockTlsKeyStore`。鍵の値は JSON・inspect・文字列化に出しません（`TlsPrivateKey`）。
- `src/windows-dpapi.ts`: Windows の中枢の鍵の保護（[ADR 0202](../../docs/adr/0202-windows-core-key-protection-dpapi.md)）。DPAPI（CurrentUser）で保護した値を `%LOCALAPPDATA%\Buddy\key-store\<項目名の SHA-256>.dpapi` に置く保護領域の 1 項目（`windowsDpapiSlotOpener`）。PowerShell（`%SystemRoot%` の下の `powershell.exe -NoProfile -NonInteractive`）を子プロセスで呼び、値は標準入力で渡します（引数に載せない）。データ鍵・TLS の秘密鍵・バックアップの鍵・OAuth のトークンの各 KeyStore は `win32` でこれを使います（`createWindowsDpapi*`）。試験用の `createMockStdinCommandRunner`。
- `src/key-protection.ts`: 鍵保護の可否の確認 `KeyProtectionProbe` と、起動前検査 `keyProtectionPreflight`。macOS の確認は KeyStore でデータ鍵を取得（初回は作成）できるかで判定します（`createKeyStoreProbe`）。使えなければ `key_protection_unavailable:<理由>` を返します。平文の保存へ切り替える経路はありません。
- `src/startup.ts`: 実行中の OS に合う起動・監督アダプターの選択。
- `src/windows-scheduled-task.ts`: Windows のログオン時のタスク（[ADR 0203](../../docs/adr/0203-windows-hub-autostart-and-network.md)）。本人の SID・`InteractiveToken`・`LeastPrivilege`・失敗時の再起動なし・時間の上限なしの XML の生成（純粋関数）、`schtasks /Create /XML`・`/Delete`、固定の PowerShell のスクリプトでの状態の読み取り。
- `src/windows-diagnostics.ts`: `powercfg /query` の AC のスリープ・休止状態の時間の読み取り（見出しは読まず 16 進の値の並びだけ）。判定できなければ unknown。
- `src/windows-paths.ts`: %SystemRoot%\System32 のコマンドの絶対パスと、ドライブ文字から始まる絶対パスの検査（指紋の収集・自動起動・診断で共有）。
- `src/home-fingerprint.ts`: 端末側の自宅の指紋（既定のゲートウェイの MAC・サブネット・SSID）の収集（[ADR 0022](../../docs/adr/0022-b03-home-network-check.md)）。macOS は `route -n get default`・`arp -n`・接続口のアドレス・`ipconfig getsummary`（SSID が `<redacted>` なら `networksetup -getairportnetwork`）、Windows は PowerShell の `Get-NetRoute`・`Get-NetNeighbor`・`Get-NetIPAddress` と `netsh wlan show interfaces`。取れない要素は null。試験用の `createMockHomeFingerprintCollector`。デスクトップの main は公開出口 `@buddy/platform/home-fingerprint`（`src/home-fingerprint-entry.ts`: 指紋の収集と runner だけ）から読み込む（[ADR 0025](../../docs/adr/0025-b03-client-desktop-connection.md)。キーチェーンなど中枢側のアダプターを含めない）。
- `src/tailscale-status.ts`: 中枢側の Tailscale の状態の取得（`tailscale status --json`、既定 5 秒だけ保持して取り直す）。接続元のアドレスからピアを特定し、CurAddr・Relay・PeerRelay を返す。取得できない・Running でないは unavailable。Windows の候補（`tailscaleCommandsFor`）は Program Files と PATH の各ディレクトリの `tailscale.exe` の絶対パス。試験用の `createMockTailscaleStatusSource`。

試験は `src/*.test.ts`（ビルド後の `dist/*.test.js`）で、模擬の runner・模擬の KeyStore・模擬の keyring モジュールと一時ディレクトリを使います。実機のキーチェーンには書き込みません。実機の launchctl への登録、pmset・fdesetup の実機での読み取り（B01-05）、キーチェーンへの鍵の作成・読み出し（下の手順）は試験の対象外です。

## 実機での確認（macOS のキーチェーン）

本人の macOS で、データ鍵の作成と読み出しを確かめます（ADR 0017）。鍵の値は画面に出さず、記録にも写しません。

1. main を最新にしてビルドします。

   ```sh
   pnpm install --frozen-lockfile
   pnpm run build
   ```

2. 事前に項目がないことを確かめます（`missing` なら未作成）。値は表示しません。

   ```sh
   security find-generic-password -s dev.buddy.core -a data-key-v1 >/dev/null && echo exists || echo missing
   ```

3. 作成: `apps/core` のディレクトリ（`@buddy/platform` を依存に持つ）で次を実行し、`{"ok":true,"created":true,"keyId":"data-key-v1","length":32}` を確かめます。

   ```sh
   cd apps/core
   node --input-type=module -e "import { createMacKeychainKeyStore } from '@buddy/platform'; const r = await createMacKeychainKeyStore().loadOrCreateDataKey(); console.log(JSON.stringify(r.ok ? { ok: true, created: r.created, keyId: r.dataKey.keyId, length: r.dataKey.key.length } : r));"
   cd ../..
   ```

4. 読み出し: 手順 3 の node のコマンドをもう一度実行し、`created` が `false` になることを確かめます。手順 2 のコマンドが `exists` になり、キーチェーンアクセスの「ログイン」に `dev.buddy.core` の項目があることも確かめます（「パスワードを表示」は押さない）。
5. 起動前検査: ターミナル 1 で `node apps/core/dist/cli.js start` が鍵保護の確認に通って `running` になり、ターミナル 2 の `node apps/core/dist/cli.js stop` で止まることを確かめます。
6. 拒否（任意）: キーチェーンへのアクセスの許可を求めるダイアログ（Node.js を更新した後などに出る）で「拒否」を選ぶと、手順 3 が `{"ok":false,"backend":"macos_keychain","reason":"keystore_read_failed"}` になり、`start` が `key_protection_unavailable:keystore_read_failed` で拒否されることを確かめます。
7. 後片付け（任意）: 確認用の鍵を消すときは `security delete-generic-password -s dev.buddy.core -a data-key-v1` を実行します。B02-03 以降で暗号化したデータがある環境では消さないでください（鍵を消すと読めなくなります）。

結果（期待どおりか、違った点）を司令塔に伝え、実機の記録として残します。出力の値・パスは記録しません。

## 実機での確認（Windows の DPAPI、未実施）

本人の Windows で、DPAPI で保護したデータ鍵の作成と読み出しを確かめます（ADR 0202）。鍵の値は画面に出さず、記録にも写しません。Windows の CI の試験（`src/windows-dpapi.test.ts` の「Windows の実機の DPAPI」）は CI の runner の利用者での確認で、本人の環境の合格ではありません。

1. main を最新にして `pnpm install --frozen-lockfile`、`pnpm run build` を実行します。
2. 事前に `%LOCALAPPDATA%\Buddy\key-store` が無い（または `.dpapi` のファイルが無い）ことを確かめます。
3. 作成: `apps/core` のディレクトリで次を実行し、`{"ok":true,"created":true,"keyId":"data-key-v1","length":32}` を確かめます。

   ```powershell
   cd apps/core
   node --input-type=module -e "import { createWindowsDpapiKeyStore } from '@buddy/platform'; const r = await createWindowsDpapiKeyStore().loadOrCreateDataKey(); console.log(JSON.stringify(r.ok ? { ok: true, created: r.created, keyId: r.dataKey.keyId, length: r.dataKey.key.length } : r));"
   cd ../..
   ```

4. 読み出し: 手順 3 をもう一度実行し、`created` が `false` になることを確かめます。`%LOCALAPPDATA%\Buddy\key-store` に `.dpapi` のファイルが 1 つだけあり、中身に `"scope":"current_user"` があることを確かめます（`blob` の値は記録しない）。
5. 起動前検査: `node apps/core/dist/cli.js start` が鍵保護の確認に通って `running` になり、別の端末の `node apps/core/dist/cli.js stop` で止まることを確かめます。
6. 後片付け: 手順 5 で起動した後は、鍵（`%LOCALAPPDATA%\Buddy\key-store` の `.dpapi` のファイル）を消さないでください。起動でデータディレクトリの DB が鍵で作られたため、鍵だけを消すと DB が読めなくなります。確認をやり直すために消すときは、データディレクトリ（`%LOCALAPPDATA%\Buddy\core`）も一緒に消します（暗号化した本人のデータがある環境では消さない）。

結果は実機の記録として残します。出力の値・パスは記録しません。
