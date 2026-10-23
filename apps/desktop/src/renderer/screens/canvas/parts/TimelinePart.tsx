// schedule_timeline: 時間の軸と予定（UI-07、ADR 0032）。縦の軸に時（目盛りの高さに合わせて間引く）を置き、予定は開始と終了の
// 位置と高さで置く。重なる予定は、決まった順に別の列へ（横に並べる）置いて位置で示し、重ならない予定は全幅。位置は箱の高さに
// 対する割合なので、箱の大きさが変わっても時刻と位置が合う。題名はプレーンテキスト。
import type { CanvasContent } from '@buddy/contracts';
import {
  MORE_RESERVE,
  assignLanes,
  assignLanesWithin,
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
// 予定の列の最小の幅（これより細い列は作らない。題名の頭と時刻が読める幅）。置けない予定は描かず、数の札に数える。
const MIN_LANE_WIDTH = 56;

export function TimelinePart({
  item,
  content,
  box,
}: PartProps<TimelineContent>) {
  const start = content.day_start_minute;
  const range = content.day_end_minute - start;
  // 列は見える長さで決める（短い予定は最小の高さまで伸ばして描くので、その分も重なりとして別の列へ）。重なりの印は
  // 実際の時刻の重なりだけに付ける。列の数は読める幅（MIN_LANE_WIDTH）で抑え、置けない予定は描かず、省いた件数の札に数える。
  const maxLanes = Math.max(
    1,
    Math.floor((box.width - AXIS_WIDTH) / MIN_LANE_WIDTH),
  );
  const arrange = (axisHeight: number) => {
    const minMinutes = (MIN_EVENT_HEIGHT / axisHeight) * range;
    return assignLanesWithin(
      content.events.map((event) => ({
        start_minute: event.start_minute,
        end_minute: Math.max(event.end_minute, event.start_minute + minMinutes),
      })),
      maxLanes,
    );
  };
  // 札（省いた予定・more_count）を出すときは、その高さを先に空けて並べ直す。
  let height = Math.max(MIN_EVENT_HEIGHT, box.height);
  let slots = arrange(height);
  if (slots.some((slot) => slot === null) || item.data.more_count > 0) {
    height = Math.max(MIN_EVENT_HEIGHT, box.height - MORE_RESERVE);
    slots = arrange(height);
  }
  const omitted = slots.filter((slot) => slot === null).length;
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
          const slot = slots[index];
          if (slot === undefined || slot === null) return null;
          const overlapping = overlaps[index]?.overlaps === true;
          const eventHeight = Math.max(
            MIN_EVENT_HEIGHT,
            at(event.end_minute) - at(event.start_minute) - 2,
          );
          // 軸の終わりの直前の予定は、最小の高さで箱からはみ出さないよう、下の端にそろえる。
          const top = Math.min(at(event.start_minute), height - eventHeight);
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
      <MoreChip count={omitted + item.data.more_count} />
    </>
  );
}
