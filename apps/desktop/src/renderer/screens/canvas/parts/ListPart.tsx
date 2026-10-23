// list: 用事・気づきの行（UI-07、ADR 0032）。題名・期限・状態の記号。状態は形（線の円・塗った円とチェック・三角と！）で
// 分け、色だけに頼らない。題名はプレーンテキスト。箱の高さに入る行だけを描き、残り（と more_count）は「+数」の札にする。
// 狭い箱（幅 240 未満）では、期限を題名の下の行へ移す（題名を優先する）。
import type { CanvasContent } from '@buddy/contracts';
import { StateMark } from '../../../components/CanvasPartIcons.js';
import {
  ROW,
  clockLabel,
  rowsThatFit,
} from '../../../state/canvas-content-state.js';
import { MoreChip } from './part-kit.js';
import type { PartProps } from './part-kit.js';

type ListContent = Extract<CanvasContent, { component: 'list' }>;

export function ListPart({ item, content, box }: PartProps<ListContent>) {
  const narrow = box.size === 'narrow';
  const pitch = narrow ? ROW.list.narrowPitch : ROW.list.pitch;
  const capacity = rowsThatFit(
    content.rows.length,
    box.height,
    pitch,
    ROW.list.gap,
    item.data.more_count > 0,
  );
  const rows = content.rows.slice(0, capacity);
  const hidden = content.rows.length - rows.length + item.data.more_count;
  return (
    <>
      <ol data-part="list" className="flex flex-col gap-1">
        {rows.map((row, index) => (
          <li
            key={index}
            data-state={row.state}
            className={`flex min-h-7 items-center gap-2 ${narrow ? 'flex-wrap' : ''}`}
          >
            <StateMark state={row.state} />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {row.title}
            </span>
            {row.due_at === null ? null : (
              <time
                dateTime={row.due_at}
                className={`shrink-0 text-xs text-muted tabular-nums ${narrow ? 'basis-full pl-7' : ''}`}
              >
                {clockLabel(row.due_at, box.now)}
              </time>
            )}
          </li>
        ))}
      </ol>
      <MoreChip count={hidden} />
    </>
  );
}
