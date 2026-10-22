// UI レンダラーの画面の切り替え（ADR 0014・0015・0024）。
// 限定 API（preload の invoke・onNotification）を読めなければ、その旨だけを出す。
// 現在の画面は端末の画面（状態欄・停止と再開・電源とロックの記録）だけ。画面を足すときは screens/<名前>/ に置き、ここで切り替える。
import { Alert } from '@heroui/react';
import { AppShell } from './app/AppShell.js';
import { desktopApi } from './desktop-api.js';
import type { BuddyDesktopApi } from './desktop-api.js';
import { DeviceScreen } from './screens/device/DeviceScreen.js';
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
  const { state, actions } = useDesktopState(api);
  return <DeviceScreen state={state} actions={actions} />;
}

export function App() {
  const api = desktopApi();
  return api === null ? <ApiUnavailable /> : <ConnectedApp api={api} />;
}
