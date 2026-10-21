// UI レンダラーの画面の切り替え（ADR 0014・0015・0024・0025・0026）。
// 限定 API（preload の invoke・onNotification）を読めなければ、その旨だけを出す。
// 未登録・再登録が必要・登録の途中なら登録の画面、それ以外は端末の画面。中枢の画面の端末（main が中枢に確かめた
// hub_screen）なら、端末の画面の本体を「承認待ちの申請」「登録済みの端末」「自宅のネットワーク」「この端末」の Tabs にする。
// ロック中・ロック状態不明では main が接続の内容を隠すので、端末の画面（内容を隠した状態帯）になる。
// 画面を足すときは screens/<名前>/ に置き、ここで切り替える。
import { Alert } from '@heroui/react';
import { AppShell } from './app/AppShell.js';
import { desktopApi } from './desktop-api.js';
import type { BuddyDesktopApi } from './desktop-api.js';
import { ConnectionSection } from './screens/device/ConnectionSection.js';
import { DeviceScreen } from './screens/device/DeviceScreen.js';
import { HomeNetworkPanel } from './screens/hub/HomeNetworkPanel.js';
import { HubTabs } from './screens/hub/HubPanels.js';
import { PairingScreen } from './screens/pairing/PairingScreen.js';
import { needsPairing, shownConnection } from './state/connection-state.js';
import { useDesktopState, useNow } from './state/use-desktop-state.js';
import { useHomeState } from './state/use-home-state.js';
import { useHubState } from './state/use-hub-state.js';

function ApiUnavailable() {
  return (
    <AppShell role="この端末">
      <Alert status="danger" role="alert">
        <Alert.Content>
          <Alert.Title>限定 API を読み込めませんでした。</Alert.Title>
        </Alert.Content>
      </Alert>
    </AppShell>
  );
}

function ConnectedApp({ api }: { readonly api: BuddyDesktopApi }) {
  const { state, actions, pairing, dismissRegistered } = useDesktopState(api);
  const now = useNow();
  const connection = shownConnection(state.connection);
  const hubScreen = connection?.hub_screen === true;
  const hub = useHubState(api, hubScreen);
  const home = useHomeState(api, hubScreen);
  if (connection !== null && needsPairing(connection))
    return (
      <PairingScreen
        state={state}
        connection={connection}
        actions={actions}
        pairing={pairing}
        now={now}
      />
    );
  return (
    <DeviceScreen
      state={state}
      actions={actions}
      now={now}
      role={hubScreen ? '中枢の画面' : 'この端末'}
      onDismissRegistered={dismissRegistered}
      hub={
        hubScreen && connection !== null ? (
          <HubTabs
            state={hub.state}
            actions={hub.actions}
            now={now}
            thisDevice={<ConnectionSection connection={connection} />}
            home={
              <HomeNetworkPanel
                state={home.state}
                actions={home.actions}
                now={now}
              />
            }
          />
        ) : undefined
      }
    />
  );
}

export function App() {
  const api = desktopApi();
  return api === null ? <ApiUnavailable /> : <ConnectedApp api={api} />;
}
