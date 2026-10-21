// 状態帯（設計 01 いつも見える状態、ADR 0014・0024）。全画面で共通。
// 1 行目: この端末の入出力（ライブ領域はこの 1 行だけ）と、右に「停止」（1 回で効く。確認を挟まない）。
// 2 行目: 中枢との接続。下に、中枢が正本の項目（表示先・音声・保存モード・予算保留・安全停止）を小さく並べ、
// 値がないものは「—」にする（ADR 0014 が常に見せる項目として定めているため畳まない）。
// ロック中・ロック状態不明では、内容を出さずにその旨だけを出す（停止は押せる）。
import type { DesktopConnectionView, DesktopStatusBar } from '@buddy/contracts';
import { Button, Card, InfoIcon, WarningIcon } from '@heroui/react';
import { NOT_RECEIVED_NOTE } from '../labels.js';
import { detailItems, hubLine, ioLine } from '../state/status-lines.js';
import { StatusText } from './StatusText.js';

export const STOP_LABEL = '■ 入出力を停止';

export function StopButton({ onStop }: { readonly onStop: () => void }) {
  return (
    <Button variant="danger-soft" size="sm" onPress={onStop}>
      {STOP_LABEL}
    </Button>
  );
}

export function StatusBand({
  status,
  connection,
  now,
  onStop,
}: {
  readonly status: DesktopStatusBar | null;
  readonly connection: DesktopConnectionView | null;
  readonly now: number;
  readonly onStop: () => void;
}) {
  if (status === null || status.visibility === 'hidden') {
    const text =
      status === null
        ? '状態を確かめています。'
        : status.lock_state === 'locked'
          ? '画面がロックされているため、内容を隠しています。'
          : 'ロック状態を確かめられないため、内容を隠しています。';
    const Icon =
      status !== null && status.lock_state === 'unknown'
        ? WarningIcon
        : InfoIcon;
    return (
      <Card>
        <Card.Content className="flex flex-row items-center justify-between gap-4">
          <p
            role="status"
            className="flex items-center gap-2 text-sm leading-6"
          >
            {status === null ? null : (
              <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
            )}
            <span>{text}</span>
          </p>
          <StopButton onStop={onStop} />
        </Card.Content>
      </Card>
    );
  }
  const io = ioLine(status);
  const hub = hubLine(status, connection, now);
  const items = detailItems(status);
  return (
    <Card>
      <Card.Content className="flex flex-col gap-4">
        <div className="flex flex-row flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <p role="status" className="text-base font-semibold">
              <span className="sr-only">この端末の入出力: </span>
              <StatusText line={io} />
            </p>
            <p className="text-sm">
              <span className="text-muted">中枢: </span>
              <StatusText line={hub} className="tabular-nums" />
            </p>
          </div>
          <StopButton onStop={onStop} />
        </div>
        <dl className="flex flex-wrap gap-x-4 gap-y-1 border-t border-separator pt-4 text-xs">
          {items.map((entry) => (
            <div key={entry.label} className="flex gap-1.5">
              <dt className="text-muted">{entry.label}</dt>
              <dd className={entry.missing ? 'text-muted' : ''}>
                {entry.value}
              </dd>
            </div>
          ))}
        </dl>
        {items.some((entry) => entry.missing) ? (
          <p className="text-xs text-muted">{NOT_RECEIVED_NOTE}</p>
        ) : null}
      </Card.Content>
    </Card>
  );
}
