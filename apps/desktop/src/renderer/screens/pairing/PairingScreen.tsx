// 登録の画面（ADR 0024・0025）。未登録・再登録が必要・登録の途中のときに出す。骨格は端末の画面と同じ:
// 状態帯 → 今やること（再登録が必要な理由の警告）→ 本体（登録のフォーム）→ 詳細（電源とロックの記録）→ フッター。
// 再登録が必要なときは、先に理由を警告し、その下のフォームに前の宛先を入れておく。状態の表示は状態帯の 1 か所だけ。
import { Alert } from '@heroui/react';
import { AppShell } from '../../app/AppShell.js';
import { AppFooter } from '../../components/AppFooter.js';
import { StatusBand } from '../../components/StatusBand.js';
import {
  DEFAULT_HUB_PORT,
  type PairingActions,
  type ShownConnection,
} from '../../state/connection-state.js';
import { messageFor, shownStatus } from '../../state/desktop-state.js';
import type {
  DesktopViewState,
  DeviceActions,
} from '../../state/desktop-state.js';
import { stopReasonText } from '../../state/status-lines.js';
import { PowerLogDetails } from '../device/PowerLogDetails.js';
import { StopBanner } from '../device/StopBanner.js';
import { PairingPanel } from './PairingPanel.js';

const PAIRING_CHANNELS = [
  'desktop.pairing_begin',
  'desktop.pairing_confirm',
  'desktop.pairing_submit',
  'desktop.pairing_cancel',
] as const;

// 再登録が必要な理由ごとの警告（R1-H3 の文言。証明書が変わったときはピン留めが外れた警報として danger）。
export function reregistrationCopy(connection: ShownConnection): {
  readonly status: 'danger' | 'warning';
  readonly title: string;
  readonly body: string;
} {
  const compare =
    '登録し直すときは、新しい指紋を中枢の画面と必ず比べてください。';
  switch (connection.link_reason) {
    case 'certificate_mismatch':
      return {
        status: 'danger',
        title: '中枢の証明書が、登録したときと変わりました',
        body: `中枢を入れ直した・証明書を作り直したといった覚えがなければ、登録し直さずに、まず中枢の画面で状態を確かめてください。覚えがあるときは、下から登録し直してください。${compare}`,
      };
    case 'device_revoked':
      return {
        status: 'warning',
        title: 'この端末は中枢で失効しました',
        body: `もう一度使うときは、下から登録し直してください。${compare}`,
      };
    case 'unauthenticated':
      return {
        status: 'warning',
        title: 'この端末の登録が中枢にありません',
        body: `中枢で失効したか、中枢のデータが作り直された可能性があります。下から登録し直してください。${compare}`,
      };
    default:
      return {
        status: 'warning',
        title: '登録の情報を読めませんでした',
        body: `OS の鍵束が作り直された可能性があります。下から登録し直してください。${compare}`,
      };
  }
}

export function PairingScreen({
  state,
  connection,
  actions,
  pairing,
  now,
}: {
  readonly state: DesktopViewState;
  readonly connection: ShownConnection;
  readonly actions: DeviceActions;
  readonly pairing: PairingActions;
  readonly now: number;
}) {
  const shown = shownStatus(state.status);
  const message = messageFor(state, [...PAIRING_CHANNELS]);
  const tailRejected =
    state.message?.channel === 'desktop.pairing_confirm' &&
    message !== null &&
    message.startsWith('中枢の画面の指紋と違います')
      ? message
      : null;
  const target =
    connection.pairing !== null
      ? { host: connection.pairing.host, port: connection.pairing.port }
      : (state.lastTarget ?? connection.hub_target);
  const rereg =
    connection.registration === 'reregistration_required'
      ? reregistrationCopy(connection)
      : null;
  return (
    <AppShell
      role="この端末（未登録）"
      band={
        <StatusBand
          status={state.status}
          connection={state.connection}
          now={now}
          onStop={actions.stop}
        />
      }
      todo={
        <>
          {rereg === null ? null : (
            <Alert status={rereg.status}>
              <Alert.Content>
                <Alert.Title>{rereg.title}</Alert.Title>
                <Alert.Description className="max-w-prose text-sm leading-6 text-foreground">
                  {rereg.body}
                </Alert.Description>
              </Alert.Content>
            </Alert>
          )}
          {shown === null ? null : (
            <StopBanner
              status={shown}
              reason={stopReasonText(shown, state.stopCause, now)}
              resume={actions.resume}
              message={messageFor(state, [
                'desktop.io_resume',
                'desktop.io_stop',
              ])}
            />
          )}
        </>
      }
      details={
        shown === null ? null : (
          <PowerLogDetails entries={state.powerLog} now={now} />
        )
      }
      footer={<AppFooter onHide={actions.hideWindow} onQuit={actions.quit} />}
    >
      <PairingPanel
        connection={connection}
        actions={pairing}
        initialHost={target?.host ?? ''}
        initialPort={target?.port ?? DEFAULT_HUB_PORT}
        deviceName={state.submittedName}
        now={now}
        message={tailRejected === null ? message : null}
        tailRejected={tailRejected}
      />
    </AppShell>
  );
}
