// 端末の画面（設計 01 いつも見える状態・停止・終了、ADR 0014・0015・0024・0025）。骨格は AppShell の順:
// 状態帯 → 今やること（登録の知らせ・停止中の帯） → 本体（中枢との接続、中枢の画面なら申請・端末の管理） →
// 詳細（電源とロックの記録） → フッター（閉じる・終了）。状態と操作は引数で受け取り、限定 API を直接呼ばない。
// ロック中・ロック状態不明では、状態帯（内容を隠した表示と停止）とフッターだけを出す。
import type { ReactNode } from 'react';
import { Alert, CloseButton } from '@heroui/react';
import type { DesktopConnectionView } from '@buddy/contracts';
import { AppShell } from '../../app/AppShell.js';
import { AppFooter } from '../../components/AppFooter.js';
import { StatusBand } from '../../components/StatusBand.js';
import { messageFor, shownStatus } from '../../state/desktop-state.js';
import type {
  DesktopViewState,
  DeviceActions,
} from '../../state/desktop-state.js';
import { stopReasonText } from '../../state/status-lines.js';
import { ConnectionSection } from './ConnectionSection.js';
import { PowerLogDetails } from './PowerLogDetails.js';
import { StopBanner } from './StopBanner.js';

type ShownConnection = Extract<DesktopConnectionView, { visibility: 'shown' }>;

const IO_CHANNELS = ['desktop.io_resume', 'desktop.io_stop'] as const;
const FOOTER_CHANNELS = ['desktop.window_hide', 'desktop.client_quit'] as const;

export function DeviceScreen({
  state,
  actions,
  now,
  role = 'この端末',
  hub,
  onDismissRegistered,
}: {
  readonly state: DesktopViewState;
  readonly actions: DeviceActions;
  readonly now: number;
  readonly role?: string;
  // 中枢の画面の端末だけに出す本体（申請・端末の管理の Tabs。B03-06）。null なら中枢との接続の欄だけ。
  readonly hub?: ReactNode;
  readonly onDismissRegistered?: () => void;
}) {
  const shown = shownStatus(state.status);
  const connection: ShownConnection | null =
    state.connection?.visibility === 'shown' ? state.connection : null;
  const other = messageFor(state, [...FOOTER_CHANNELS]);
  return (
    <AppShell
      role={role}
      band={
        <StatusBand
          status={state.status}
          connection={state.connection}
          now={now}
          onStop={actions.stop}
        />
      }
      todo={
        shown === null ? null : (
          <>
            {/* 登録の知らせは、停止の帯と同時には出さない（Alert は 1 画面に 1 つ。ADR 0024 の約束 6）。 */}
            {state.justRegistered && shown.stop_scope === 'none' ? (
              <Alert status="success">
                <Alert.Content>
                  <Alert.Title>この端末を中枢に登録しました。</Alert.Title>
                </Alert.Content>
                {onDismissRegistered === undefined ? null : (
                  <CloseButton
                    aria-label="知らせを閉じる"
                    onPress={onDismissRegistered}
                  />
                )}
              </Alert>
            ) : null}
            <StopBanner
              status={shown}
              reason={stopReasonText(shown, state.stopCause, now)}
              resume={actions.resume}
              message={messageFor(state, [...IO_CHANNELS])}
            />
          </>
        )
      }
      details={
        shown === null ? null : (
          <PowerLogDetails entries={state.powerLog} now={now} />
        )
      }
      footer={
        <>
          {other === null ? null : (
            <p role="alert" className="text-sm text-warning-soft-foreground">
              {other}
            </p>
          )}
          <AppFooter onHide={actions.hideWindow} onQuit={actions.quit} />
        </>
      }
    >
      {shown === null
        ? undefined
        : (hub ??
          (connection === null ? null : (
            <ConnectionSection connection={connection} />
          )))}
    </AppShell>
  );
}
