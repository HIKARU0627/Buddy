// 端末の画面（設計 01 いつも見える状態・停止・終了、ADR 0014・0015・0024・0025・0181・0204）。骨格は AppShell:
// 左のサイドバーでページを切り替え、右の上に状態帯（上の中央の島と項目の行）と今やること（登録の知らせ・停止中の帯）を
// いつも出す。ページは、呼び出し側が渡す機能のページ（会話・気づき・自動実行・家計簿・記憶）と、この部品が足す
// 「端末と接続」（中枢との接続。中枢の画面なら申請・端末の管理。電源とロックの記録）。閉じる・終了はサイドバーの下。
// 状態と操作は引数で受け取り、限定 API を直接呼ばない。
// ロック中・ロック状態不明では、ページを出さず、島（内容を隠した表示と停止）とフッターだけを 1 列に出す。
import type { ReactNode } from 'react';
import { Alert, CloseButton } from '@heroui/react';
import type { DesktopConnectionView } from '@buddy/contracts';
import { AppShell } from '../../app/AppShell.js';
import type { ShellPage } from '../../app/AppShell.js';
import { DeviceIcon } from '../../components/NavIcons.js';
import { AppFooter } from '../../components/AppFooter.js';
import { StatusBand } from '../../components/StatusBand.js';
import { messageFor, shownStatus } from '../../state/desktop-state.js';
import type { IslandSignals } from '../../state/island-state.js';
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
const NO_PAGES: readonly ShellPage[] = [];
export const DEVICE_PAGE_ID = 'device';
export const DEVICE_PAGE_LABEL = '端末と接続';
const FOOTER_CHANNELS = ['desktop.window_hide', 'desktop.client_quit'] as const;

export function DeviceScreen({
  state,
  actions,
  now,
  role = 'この端末',
  hub,
  pages = NO_PAGES,
  page,
  onPageChange,
  onOpenAttention,
  stopShortcut,
  island = null,
  onDismissRegistered,
}: {
  readonly state: DesktopViewState;
  readonly actions: DeviceActions;
  readonly now: number;
  readonly role?: string;
  // 中枢の画面の端末だけに出す本体（申請・端末の管理の Tabs。B03-06）。null なら中枢との接続の欄だけ。
  readonly hub?: ReactNode;
  // 機能のページ（会話・気づき・自動実行・家計簿・記憶。登録済みの端末。ADR 0204）。「端末と接続」の前に並べる。
  readonly pages?: readonly ShellPage[];
  // 選んでいるページ（渡さなければ最初のページから始める）。
  readonly page?: string;
  readonly onPageChange?: (id: string) => void;
  // 島の「確認が必要な操作を見る」を押したとき（会話のページへ移って、確認の欄の見出しへ移る）。
  readonly onOpenAttention?: () => void;
  // 全体の停止のショートカットの印（UI-04。停止のボタンの横に置く）。なければ出さない。
  readonly stopShortcut?: ReactNode;
  // 上の中央の島を広げるきっかけ（確認が必要な操作・操作の結果。ADR 0181 の段階 2）。なければ小さい形のまま。
  readonly island?: IslandSignals | null;
  readonly onDismissRegistered?: () => void;
}) {
  const shown = shownStatus(state.status);
  const connection: ShownConnection | null =
    state.connection?.visibility === 'shown' ? state.connection : null;
  const other = messageFor(state, [...FOOTER_CHANNELS]);
  const devicePage: ShellPage = {
    id: DEVICE_PAGE_ID,
    label: DEVICE_PAGE_LABEL,
    icon: <DeviceIcon />,
    content: (
      <>
        {hub ??
          (connection === null ? null : (
            <ConnectionSection connection={connection} />
          ))}
        <PowerLogDetails entries={state.powerLog} now={now} />
      </>
    ),
  };
  return (
    <AppShell
      role={role}
      {...(shown === null ? {} : { pages: [...pages, devicePage] })}
      {...(page === undefined ? {} : { page })}
      {...(onPageChange === undefined ? {} : { onPageChange })}
      band={
        <StatusBand
          status={state.status}
          connection={state.connection}
          now={now}
          onStop={actions.stop}
          stopShortcut={stopShortcut}
          island={island}
          {...(onOpenAttention === undefined ? {} : { onOpenAttention })}
        />
      }
      todo={
        shown === null ? null : (
          <>
            {/* 登録の知らせは、停止の帯と同時には出さない（Alert は 1 画面に 1 つ。ADR 0024 の約束 6）。 */}
            {state.justRegistered && shown.stop_scope === 'none' ? (
              <Alert status="success">
                <Alert.Indicator>
                  <span aria-hidden="true" className="text-sm leading-none">
                    ●
                  </span>
                </Alert.Indicator>
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
      footer={
        <>
          {other === null ? null : (
            <p role="alert" className="text-sm text-warning-soft-foreground">
              {other}
            </p>
          )}
          <AppFooter
            onHide={actions.hideWindow}
            onQuit={actions.quit}
            layout={shown === null ? 'bottom' : 'side'}
          />
        </>
      }
    />
  );
}
