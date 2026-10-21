// Alert の記号（ADR 0024 の約束 4「記号＋文言」）。danger・warning は ⚠（WarningIcon）、success・default は InfoIcon。
// 単色の SVG で、色は Alert の status（HeroUI の .alert__indicator）が付ける。記号は読み上げない（題で伝える）。
import { InfoIcon, WarningIcon } from '@heroui/react';

export function AlertIcon({
  kind = 'warning',
}: {
  readonly kind?: 'warning' | 'info';
}) {
  const Icon = kind === 'warning' ? WarningIcon : InfoIcon;
  return <Icon aria-hidden="true" className="size-4 shrink-0" />;
}
