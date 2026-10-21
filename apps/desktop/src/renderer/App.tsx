// UI レンダラーの画面の切り替え（ADR 0014・0015・0024・0025）。
// 限定 API（preload の invoke・onNotification）を読めなければ、その旨だけを出す。
// 未登録・再登録が必要・ペアリングの途中ならペアリングの画面、それ以外は端末の画面（中枢との接続の欄つき）。
// ロック中・ロック状態不明では main が接続の内容を隠すので、端末の画面（内容を隠した状態欄）になる。
// 画面を足すときは screens/<名前>/ に置き、ここで切り替える。
import { Alert } from '@heroui/react';
import { AppShell } from './app/AppShell.js';
import { desktopApi } from './desktop-api.js';
import type { BuddyDesktopApi } from './desktop-api.js';
import { DeviceScreen } from './screens/device/DeviceScreen.js';
import { ConnectionPanel } from './screens/pairing/ConnectionPanel.js';
import { PairingScreen } from './screens/pairing/PairingScreen.js';
import { needsPairing, shownConnection } from './state/connection-state.js';
import { useDesktopState } from './state/use-desktop-state.js';

function ApiUnavailable() {
  return (
    <AppShell>
      <Alert status="danger" role="alert">
        <Alert.Content>
          <Alert.Title>限定 API を読み込めませんでした。</Alert.Title>
        </Alert.Content>
      </Alert>
    </AppShell>
  );
}

function ConnectedApp({ api }: { readonly api: BuddyDesktopApi }) {
  const { state, actions, pairing } = useDesktopState(api);
  const connection = shownConnection(state.connection);
  if (connection !== null && needsPairing(connection))
    return (
      <PairingScreen
        state={state}
        connection={connection}
        actions={actions}
        pairing={pairing}
      />
    );
  return (
    <DeviceScreen
      state={state}
      actions={actions}
      connectionPanel={
        connection === null ? null : <ConnectionPanel connection={connection} />
      }
    />
  );
}

export function App() {
  const api = desktopApi();
  return api === null ? <ApiUnavailable /> : <ConnectedApp api={api} />;
}
