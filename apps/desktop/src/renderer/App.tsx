// UI レンダラーの画面の切り替え（ADR 0014・0015・0024・0025・0026）。
// 限定 API（preload の invoke・onNotification）を読めなければ、その旨だけを出す。
// 未登録・再登録が必要・登録の途中なら登録の画面、それ以外は端末の画面。中枢の画面の端末（main が中枢に確かめた
// hub_screen）なら、端末の画面の本体を「端末の登録」「登録済みの端末」「自宅のネットワーク」「このマシンの接続」の Tabs にする。
// ロック中・ロック状態不明では main が接続の内容を隠すので、端末の画面（内容を隠した状態帯）になる。
// 画面を足すときは screens/<名前>/ に置き、ここで切り替える。
import { useEffect, useState } from 'react';
import { Alert } from '@heroui/react';
import type { DesktopOperationEntry } from '@buddy/contracts';
import { AlertIcon } from './components/AlertIcon.js';
import { AppShell } from './app/AppShell.js';
import { desktopApi } from './desktop-api.js';
import type { BuddyDesktopApi } from './desktop-api.js';
import { ConnectionSection } from './screens/device/ConnectionSection.js';
import { DeviceScreen } from './screens/device/DeviceScreen.js';
import { HomeNetworkPanel } from './screens/hub/HomeNetworkPanel.js';
import { HubTabs } from './screens/hub/HubPanels.js';
import { PairingScreen } from './screens/pairing/PairingScreen.js';
import {
  hubScreenMode,
  needsPairing,
  nextHubSeen,
  shownConnection,
} from './state/connection-state.js';
import { useDesktopState, useNow } from './state/use-desktop-state.js';
import { useHomeState } from './state/use-home-state.js';
import { useHubState } from './state/use-hub-state.js';
import { useWorkState } from './state/use-work-state.js';
import { WorkPanel } from './screens/work/WorkPanel.js';

// 操作がないときの空の配列（描画のたびに新しい配列を作らない）。
const NO_OPERATIONS: readonly DesktopOperationEntry[] = [];

function ApiUnavailable() {
  return (
    <AppShell role="この端末">
      <Alert status="danger" role="alert">
        <Alert.Indicator>
          <AlertIcon />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Title>
            画面を開けませんでした。Buddy を終了して、開き直してください。
          </Alert.Title>
        </Alert.Content>
      </Alert>
    </AppShell>
  );
}

function ConnectedApp({ api }: { readonly api: BuddyDesktopApi }) {
  const { state, actions, pairing, dismissRegistered } = useDesktopState(api);
  const now = useNow();
  const connection = shownConnection(state.connection);
  // 前に中枢の画面と確かめたか（接続を待つ間も中枢の画面の枠を残す。判定の正本は main）。
  const [hubSeen, setHubSeen] = useState(false);
  const seen = nextHubSeen(hubSeen, connection);
  useEffect(() => {
    if (seen !== hubSeen) setHubSeen(seen);
  }, [seen, hubSeen]);
  const mode = hubScreenMode(seen, connection);
  const hubScreen = mode !== 'off';
  const locked = state.status?.visibility !== 'shown';
  const hub = useHubState(api, mode, locked);
  // 自宅のネットワーク（B03-08）。接続を待つ間も最後の表示を残し、操作だけを止める。
  const home = useHomeState(api, hubScreen);
  const stopped =
    state.status?.visibility === 'shown' && state.status.stop_scope !== 'none';
  // 会話・変更の確認・処理状況（B04-05）。ロック中・未登録では内容を持たない（ロックで捨てる）。
  const workShown =
    !locked && connection !== null && connection.registration === 'registered';
  // 中枢に接続している間だけ会話の内容を持つ。切断（接続の待ちを含む）で世代を進めて内容を捨て、切断をまたいだ応答を
  // 反映しない（main も切断で参照・preview・会話を捨てる。ADR 0031）。
  const workLive = workShown && connection?.link === 'connected';
  const work = useWorkState(
    api,
    workLive,
    connection?.operations ?? NO_OPERATIONS,
  );
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
      role={
        mode === 'live'
          ? '中枢の画面'
          : mode === 'paused'
            ? '中枢の画面（接続を待っています）'
            : 'この端末'
      }
      onDismissRegistered={dismissRegistered}
      work={
        workShown && connection !== null ? (
          <WorkPanel
            state={work.state}
            actions={work.actions}
            operations={connection.operations}
            link={connection.link === 'connected' ? 'connected' : 'other'}
            stopped={stopped}
          />
        ) : undefined
      }
      hub={
        hubScreen && connection !== null ? (
          <HubTabs
            state={hub.state}
            actions={hub.actions}
            now={now}
            paused={
              mode === 'paused'
                ? {
                    linked: connection.link === 'connected',
                    lastConfirmedAt: connection.last_confirmed_at,
                  }
                : null
            }
            stopped={stopped}
            thisDevice={
              <ConnectionSection
                connection={connection}
                title="このマシンと中枢の接続"
              />
            }
            home={
              <HomeNetworkPanel
                state={home.state}
                actions={home.actions}
                now={now}
                paused={mode === 'paused'}
                stopped={stopped}
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
