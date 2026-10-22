// 端末の画面（設計 01 いつも見える状態・停止・終了、ADR 0014・0015・0024）。
// 状態欄・操作・拒否の文言・内容・電源とロックの記録を並べる。状態と操作は引数で受け取り、限定 API を直接呼ばない。
// ロック中・ロック状態不明では状態欄の内容と、内容・記録の欄を描画しない。
import type { ReactNode } from 'react';
import { Alert } from '@heroui/react';
import { AppShell } from '../../app/AppShell.js';
import { shownStatus } from '../../state/desktop-state.js';
import type {
  DesktopViewState,
  DeviceActions,
} from '../../state/desktop-state.js';
import { ContentPanel } from './ContentPanel.js';
import { IoControls } from './IoControls.js';
import { PowerLogPanel } from './PowerLogPanel.js';
import { StatusPanel } from './StatusPanel.js';

export function DeviceScreen({
  state,
  actions,
  connectionPanel,
}: {
  readonly state: DesktopViewState;
  readonly actions: DeviceActions;
  // 中枢との接続の欄（B03-05、ADR 0025）。ロック解除済みのときだけ描画する。
  readonly connectionPanel?: ReactNode;
}) {
  const shown = shownStatus(state.status);
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
      {shown === null ? null : (
        <>
          {connectionPanel}
          <ContentPanel inputPermitted={shown.input_permitted} />
          <PowerLogPanel entries={state.powerLog} />
        </>
      )}
    </AppShell>
  );
}
