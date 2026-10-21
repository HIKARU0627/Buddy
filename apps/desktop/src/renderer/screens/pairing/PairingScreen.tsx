// ペアリングの画面（ADR 0024・0025）。未登録・再登録が必要・ペアリングの途中のときに出す。
// 状態欄と入出力の停止（いつでも押せる）は端末の画面と同じものを上に置き、その下にペアリングの欄と接続の欄を並べる。
// 状態と操作は引数で受け取り、限定 API を直接呼ばない。ロック中・不明では main が内容を隠した値を送るので、
// この画面は出ない（App.tsx が端末の画面にする）。
import { Alert } from '@heroui/react';
import { AppShell } from '../../app/AppShell.js';
import type {
  PairingActions,
  ShownConnection,
} from '../../state/connection-state.js';
import type {
  DesktopViewState,
  DeviceActions,
} from '../../state/desktop-state.js';
import { IoControls } from '../device/IoControls.js';
import { StatusPanel } from '../device/StatusPanel.js';
import { ConnectionPanel } from './ConnectionPanel.js';
import { PairingPanel } from './PairingPanel.js';

export function PairingScreen({
  state,
  connection,
  actions,
  pairing,
}: {
  readonly state: DesktopViewState;
  readonly connection: ShownConnection;
  readonly actions: DeviceActions;
  readonly pairing: PairingActions;
}) {
  return (
    <AppShell header={<StatusPanel status={state.status} />}>
      <IoControls actions={actions} />
      {state.message !== null ? (
        <Alert status="warning" role="alert">
          <Alert.Content>
            <Alert.Title>⚠ {state.message}</Alert.Title>
          </Alert.Content>
        </Alert>
      ) : null}
      <PairingPanel connection={connection} actions={pairing} />
      {connection.registration === 'reregistration_required' ? (
        <ConnectionPanel connection={connection} />
      ) : null}
    </AppShell>
  );
}
