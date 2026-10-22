# @buddy/client

端末側の接続の純粋な部分です（B03-05、[ADR 0025](../../docs/adr/0025-b03-client-desktop-connection.md)）。Node・DOM・Electron の API を使わず、通信（TLS のピン留め・WSS）・時計・形式の検査は `transport.ts` の境界から受け取ります。デスクトップの main が実装を渡します。

- `src/connection.ts`: 接続の状態機械 `ClientConnection`。bootstrap → スナップショット → 購読 → （切断・再スナップショットの要求）→ bootstrap。API の版の検査、cursor の追跡、domain の `applyEvents` によるイベントの反映と `getOperation` での取り直し、再接続の間隔、ロック状態の変化での取り直し、切断中の命令をためない `send`。
- `src/api-version.ts`: 端末が使える API の major（`CLIENT_API_MAJORS`）と `checkApiVersion`。
- `src/backoff.ts`: 再接続の間隔（1 秒から 2 倍ずつ、上限 60 秒、±20% の揺らぎ）。
- `src/transport.ts`: 通信・時計・形式の検査の境界の型。
- `src/test-support.ts`: 試験用の模擬の通信・時計と、契約の schema による形式の検査（ビルドの公開出口に含めない）。

試験は `src/*.test.ts`（ビルド後の `dist/*.test.js`）で、模擬の通信と時計を使います。製品のコードは `tsconfig.json`（Node・DOM の型なし）で、試験と模擬は `tsconfig.test.json`（Node の型あり）で型検査します。lint は製品のコードから Node・Electron・中枢・OS アダプター・ws を読み込めないようにしています。
