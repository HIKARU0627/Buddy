// schedule_timeline: 時間の軸と予定（UI-07、ADR 0032）。縦の軸に時（目盛りの高さに合わせて間引く）を置き、予定は開始と終了の
// 位置と高さで置く。重なる予定は、決まった順に別の列へ（横に並べる）置いて位置で示し、重ならない予定は全幅。位置は箱の高さに
// 対する割合なので、箱の大きさが変わっても時刻と位置が合う。題名はプレーンテキスト。
import type { CanvasContent } from '@buddy/contracts';
import {
  assignLanes,
  hourTicks,
  minuteLabel,
} from '../../../state/canvas-content-state.js';
import { MoreChip } from './part-kit.js';
import type { PartProps } from './part-kit.js';

type TimelineContent = Extract<
  CanvasContent,
  { component: 'schedule_timeline' }
>;

// 時の目盛りの文字の幅（ピクセル）と、予定の最小の高さ（短い予定でも題名の 1 行は読める）。
const AXIS_WIDTH = 36;
const MIN_EVENT_HEIGHT = 20;

export function TimelinePart({
  item,
  content,
  box,
}: PartProps<TimelineContent>) {
  const start = content.day_start_minute;
  const range = content.day_end_minute - start;
  const height = Math.max(MIN_EVENT_HEIGHT, box.height);
  // 列は見える長さで決める（短い予定は最小の高さまで伸ばして描くので、その分も重なりとして別の列へ）。重なりの印は
  // 実際の時刻の重なりだけに付ける。
  const minMinutes = (MIN_EVENT_HEIGHT / height) * range;
  const slots = assignLanes(
    content.events.map((event) => ({
      start_minute: event.start_minute,
      end_minute: Math.max(event.end_minute, event.start_minute + minMinutes),
    })),
  );
  const overlaps = assignLanes(content.events);
  const ticks = hourTicks(start, content.day_end_minute, height);
  const at = (minute: number) => ((minute - start) / range) * height;
  return (
    <>
      <div
        data-part="timeline"
        role="list"
        aria-label={item.heading}
        style={{ height }}
        className="relative w-full"
      >
        {ticks.map((hour) => (
          <div
            key={hour}
            aria-hidden="true"
            data-tick={hour}
            style={{ top: at(hour * 60) }}
            className="absolute inset-x-0 flex items-start border-t border-separator"
          >
            <span
              className={`${at(hour * 60) < 8 ? '' : '-mt-2'} w-9 bg-surface pr-1 text-right text-xs text-muted tabular-nums`}
            >
              {hour}:00
            </span>
          </div>
        ))}
        {content.events.map((event, index) => {
          const slot = slots[index] ?? { lane: 0, lanes: 1, overlaps: false };
          const overlapping = overlaps[index]?.overlaps === true;
          const top = at(event.start_minute);
          const eventHeight = Math.max(
            MIN_EVENT_HEIGHT,
            at(event.end_minute) - top - 2,
          );
          // 予定を描ける幅（軸の文字の右）を、重なりの塊の列の数で等分する。
          const laneWidth = 100 / slot.lanes;
          return (
            <div
              key={index}
              role="listitem"
              data-event={index}
              data-lane={slot.lane}
              data-lanes={slot.lanes}
              data-overlap={overlapping ? 'true' : undefined}
              aria-label={`${minuteLabel(event.start_minute)}から${minuteLabel(event.end_minute)} ${event.title}`}
              style={{
                top,
                height: eventHeight,
                left: `calc(${AXIS_WIDTH}px + (100% - ${AXIS_WIDTH}px) * ${slot.lane} / ${slot.lanes})`,
                width: `calc((100% - ${AXIS_WIDTH}px) * ${laneWidth} / 100 - 2px)`,
              }}
              className={`absolute overflow-hidden rounded-md border-l-4 bg-accent-soft px-1.5 py-0.5 text-accent-soft-foreground ${
                overlapping ? 'border-l-accent' : 'border-l-separator'
              }`}
            >
              <span className="block truncate text-xs leading-4 font-medium">
                {event.title}
              </span>
              {box.size !== 'narrow' && eventHeight >= 36 ? (
                <span className="block truncate text-xs leading-4 tabular-nums">
                  {minuteLabel(event.start_minute)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <MoreChip count={item.data.more_count} />
    </>
  );
}
