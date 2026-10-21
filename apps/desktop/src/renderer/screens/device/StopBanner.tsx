// 停止中の帯（ADR 0024 の骨格の 2「今やること」）。本人が意図した停止を「異常」に見せないよう、
// この端末の停止は中立（default）、来客モード・全体停止は要対応（warning）にする。
// 再開のボタンは帯の中に置き、拒否されたときはボタンのすぐ下に理由と次の行動を出す。
import { Alert, Button, Description } from '@heroui/react';
import { AlertIcon } from '../../components/AlertIcon.js';
import type { ShownStatus } from '../../state/desktop-state.js';

export const STOP_BANNER_LABELS = {
  title: 'この端末の入出力を止めています',
  resume: 'この端末で再開する',
  resumeNote: 'ウィンドウが前面にあるときだけ再開できます。',
} as const;

export function StopBanner({
  status,
  reason,
  resume,
  message,
}: {
  readonly status: ShownStatus;
  // 止まった理由と時刻（分からなければ null）。
  readonly reason: string | null;
  readonly resume: (() => void) | null;
  // 再開の拒否の文言（ボタンのすぐ下に出す）。
  readonly message: string | null;
}) {
  if (status.stop_scope === 'none') return null;
  return (
    <Alert status={status.stop_scope === 'local' ? 'default' : 'warning'}>
      {/* 本人が止めたときは中立の ■、来客モード・全体停止（要対応）は ⚠（ADR 0024 の対応表）。 */}
      <Alert.Indicator>
        {status.stop_scope === 'local' ? (
          <span aria-hidden="true" className="text-sm leading-none">
            ■
          </span>
        ) : (
          <AlertIcon />
        )}
      </Alert.Indicator>
      <Alert.Content className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Alert.Title>{STOP_BANNER_LABELS.title}</Alert.Title>
          {reason === null ? null : (
            <Alert.Description className="text-sm leading-6 text-foreground tabular-nums">
              {reason}
            </Alert.Description>
          )}
        </div>
        {resume === null ? null : (
          <div className="flex flex-col gap-1">
            <div>
              <Button variant="primary" onPress={resume}>
                {STOP_BANNER_LABELS.resume}
              </Button>
            </div>
            <Description className="text-xs text-muted">
              {STOP_BANNER_LABELS.resumeNote}
            </Description>
            {message === null ? null : (
              <p
                role="alert"
                className="flex items-start gap-1.5 text-sm leading-6 text-warning-soft-foreground"
              >
                {message}
              </p>
            )}
          </div>
        )}
      </Alert.Content>
    </Alert>
  );
}
