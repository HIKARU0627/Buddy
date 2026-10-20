# @buddy/platform

OS 別の鍵保護・起動・端末能力のアダプターを置きます（[ADR 0013](../../docs/adr/0013-b01-platform-adapters.md)）。Core から使い、共有層（contracts・domain）からは import しません。Electron には依存しません。

- `src/runner.ts`: コマンド実行の境界 `CommandRunner`。実機用の `createNodeCommandRunner`（shell を通さない）と、試験用の `createMockCommandRunner`。
- `src/supervisor.ts`: 起動・監督の境界 `StartupSupervisor`（register・unregister・status）。Windows・Linux は `unsupported` を返す。
- `src/macos-launch-agent.ts`: ログイン後の LaunchAgent。plist の生成（純粋関数）、`~/Library/LaunchAgents/dev.buddy.core.plist` への書き出しと `launchctl bootstrap` / `bootout`。`enabled: true` を受け取らない限り登録しません。KeepAlive は付けません。
- `src/macos-diagnostics.ts`: `pmset -g` のスリープ設定と `fdesetup status` の FileVault の状態のパーサー。判定できなければ unknown。
- `src/key-protection.ts`: 鍵保護の可否の確認 `KeyProtectionProbe` と、起動前検査 `keyProtectionPreflight`。使えなければ `key_protection_unavailable:<理由>` を返します。平文の保存へ切り替える経路はありません。
- `src/startup.ts`: 実行中の OS に合う起動・監督アダプターの選択。

試験は `src/*.test.ts`（ビルド後の `dist/*.test.js`）で、模擬の runner と一時ディレクトリを使います。実機の launchctl への登録、pmset・fdesetup・security の実機での読み取り（B01-05）、キーチェーンへの保存・暗号化（B02）は未実装・未検証です。
