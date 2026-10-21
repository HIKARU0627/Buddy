// 状態の「記号＋文言」（ADR 0024 の対応表。tones.ts）。記号は読み上げない（文言で伝える）。
import { Spinner, WarningIcon } from '@heroui/react';
import { MARK_TEXT, TONE_TEXT_CLASS } from '../tones.js';
import type { StatusLine } from '../tones.js';

export function StatusMark({ line }: { readonly line: StatusLine }) {
  if (line.mark === 'none') return null;
  if (line.mark === 'spinner')
    return <Spinner size="sm" color="current" aria-hidden="true" />;
  if (line.mark === 'warning')
    return (
      <WarningIcon
        aria-hidden="true"
        className={`size-4 shrink-0 ${TONE_TEXT_CLASS[line.tone]}`}
      />
    );
  return (
    <span aria-hidden="true" className={TONE_TEXT_CLASS[line.tone]}>
      {MARK_TEXT[line.mark]}
    </span>
  );
}

export function StatusText({
  line,
  className = '',
}: {
  readonly line: StatusLine;
  readonly className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <StatusMark line={line} />
      <span>{line.text}</span>
    </span>
  );
}
