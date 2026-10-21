// 電源とロックの記録（ADR 0024 の骨格の 4「詳細」）。件数を出して畳み、開いたときは直近の数件だけを出す。
// 記録の通知で、停止・再開の命令ではない。時刻は tabular-nums、今日の分は時刻だけ。
import { Disclosure } from '@heroui/react';
import { clockOf } from '../../format.js';
import { POWER_EVENT_LABELS, POWER_SOURCE_LABELS } from '../../labels.js';
import type { PowerEvent } from '../../state/desktop-state.js';

export const POWER_LOG_SHOWN = 5;

export function PowerLogDetails({
  entries,
  now,
}: {
  readonly entries: readonly PowerEvent[];
  readonly now: number;
}) {
  return (
    <section
      aria-labelledby="power-log-heading"
      className="border-t border-separator pt-4"
    >
      <Disclosure>
        <Disclosure.Heading>
          <Disclosure.Trigger className="flex w-full items-center justify-between text-sm">
            <span id="power-log-heading" className="font-semibold">
              電源とロックの記録（{entries.length} 件）
            </span>
            <Disclosure.Indicator />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body>
            {entries.length === 0 ? (
              <p className="text-sm text-muted">記録はまだありません。</p>
            ) : (
              <ol className="flex flex-col divide-y divide-separator text-sm">
                {entries.slice(0, POWER_LOG_SHOWN).map((entry, index) => (
                  <li
                    key={`${entry.observed_at}-${index}`}
                    className="grid grid-cols-[auto_1fr_auto] items-baseline gap-4 py-1.5"
                  >
                    <time
                      dateTime={entry.observed_at}
                      className="text-muted tabular-nums"
                    >
                      {clockOf(entry.observed_at, now)}
                    </time>
                    <span>{POWER_EVENT_LABELS[entry.event]}</span>
                    <span className="text-xs text-muted">
                      {POWER_SOURCE_LABELS[entry.source]}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {entries.length > POWER_LOG_SHOWN ? (
              <p className="pt-1 text-xs text-muted">
                直近 {POWER_LOG_SHOWN} 件を表示しています（ほか{' '}
                {entries.length - POWER_LOG_SHOWN} 件）。
              </p>
            ) : null}
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </section>
  );
}
