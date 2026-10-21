# @buddy/platform

OS 別の鍵保護・起動・端末能力のアダプターを置きます（[ADR 0013](../../docs/adr/0013-b01-platform-adapters.md)・[ADR 0017](../../docs/adr/0017-b02-keystore-and-encryption.md)・[ADR 0020](../../docs/adr/0020-b03-https-tls-and-route-checks.md)）。Core から使い、共有層（contracts・domain）からは import しません。Electron には依存しません。

- `src/runner.ts`: コマンド実行の境界 `CommandRunner`。実機用の `createNodeCommandRunner`（shell を通さない）と、試験用の `createMockCommandRunner`。
- `src/supervisor.ts`: 起動・監督の境界 `StartupSupervisor`（register・unregister・status）。Windows・Linux は `unsupported` を返す。
- `src/macos-launch-agent.ts`: ログイン後の LaunchAgent。plist の生成（純粋関数）、`~/Library/LaunchAgents/dev.buddy.core.plist` への書き出しと `launchctl bootstrap` / `bootout`。`enabled: true` を受け取らない限り登録しません。KeepAlive は付けません。
- `src/macos-diagnostics.ts`: `pmset -g` のスリープ設定と `fdesetup status` の FileVault の状態のパーサー。判定できなければ unknown。
- `src/key-store.ts`: 中枢のデータ鍵の `KeyStore`（`loadDataKey`・`loadOrCreateDataKey`）。macOS はキーチェーン（`@napi-rs/keyring`、サービス名 `dev.buddy.core`・アカウント名 `data-key-v1`）に 32 バイトの乱数を base64 で保存し、読み出し時に形式と長さを検査します。ネイティブモジュールは初めて鍵を読むときに読み込み、Windows・Linux では読み込みません。試験用の `createMockKeyStore`（`kind: 'mock'`）。鍵の値は結果の理由・例外・`JSON.stringify`・`inspect` に出しません。
- `src/tls-key-store.ts`: 中枢の TLS の秘密鍵の `TlsKeyStore`（`loadTlsKey`・`loadOrCreateTlsKey`、[ADR 0020](../../docs/adr/0020-b03-https-tls-and-route-checks.md)）。ECDSA P-256 の鍵を作り、キーチェーンのデータ鍵と同じサービス名の別の項目（アカウント名 `tls-key-v1`）に PKCS#8 の DER を正準の base64 で保存し、読み出し時に P-256 の EC 秘密鍵であることを検査します。平文の鍵をディスクに置きません。試験用の `createMockTlsKeyStore`。鍵の値は JSON・inspect・文字列化に出しません（`TlsPrivateKey`）。
- `src/key-protection.ts`: 鍵保護の可否の確認 `KeyProtectionProbe` と、起動前検査 `keyProtectionPreflight`。macOS の確認は KeyStore でデータ鍵を取得（初回は作成）できるかで判定します（`createKeyStoreProbe`）。使えなければ `key_protection_unavailable:<理由>` を返します。平文の保存へ切り替える経路はありません。
- `src/startup.ts`: 実行中の OS に合う起動・監督アダプターの選択。

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
