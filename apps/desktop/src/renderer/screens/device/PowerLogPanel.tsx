// 電源とロックの記録（ADR 0015）。main が送った記録を新しい順に出す。停止・再開の命令ではない。
import { Card, Chip } from '@heroui/react';
import { PanelTitle } from '../../components/PanelTitle.js';
import {
  POWER_EVENT_LABELS,
  POWER_SOURCE_LABELS,
  formatObservedAt,
} from '../../labels.js';
import type { PowerEvent } from '../../state/desktop-state.js';

export function PowerLogPanel({
  entries,
}: {
  readonly entries: readonly PowerEvent[];
}) {
  return (
    <section aria-label="電源とロックの記録">
      <Card>
        <Card.Header>
          <PanelTitle>電源とロックの記録</PanelTitle>
        </Card.Header>
        <Card.Content>
          {entries.length === 0 ? (
            <p className="text-sm text-muted">記録はまだありません。</p>
          ) : (
            <ol className="flex flex-col divide-y divide-separator text-sm">
              {entries.map((entry, index) => (
                <li
                  key={`${entry.observed_at}-${index}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2"
                >
                  <time
                    dateTime={entry.observed_at}
                    className="tabular-nums text-muted"
                  >
                    {formatObservedAt(entry.observed_at)}
                  </time>
                  <span>{POWER_EVENT_LABELS[entry.event]}</span>
                  <Chip size="sm" variant="tertiary">
                    {POWER_SOURCE_LABELS[entry.source]}
                  </Chip>
                </li>
              ))}
            </ol>
          )}
        </Card.Content>
      </Card>
    </section>
  );
}
