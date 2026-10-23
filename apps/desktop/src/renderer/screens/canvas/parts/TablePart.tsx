// table: 行と列（UI-07、ADR 0032。50 行 × 8 列まで）。箱の大きさに入る行と列だけを描き、入りきらない行（↓）・列（→）は数の札で
// 示す。先頭の列は行の見出し（読み上げは行ごとに列の名前と値を結び付ける）。セルはプレーンテキストで 1 行に切る。
// 表はキーボードの移動を増やさない（Tab で選ぶのはカードだけ）ので、HeroUI のトークンで整えた table 要素で描く。
import type { CanvasContent } from '@buddy/contracts';
import {
  ROW,
  columnCapacity,
  rowsThatFit,
} from '../../../state/canvas-content-state.js';
import { MoreChip } from './part-kit.js';
import type { PartProps } from './part-kit.js';

type TableContent = Extract<CanvasContent, { component: 'table' }>;

// 列の最小の幅（これより細くなる列は描かない）。
const MIN_COLUMN = 88;

export function TablePart({ item, content, box }: PartProps<TableContent>) {
  const columns = columnCapacity(box.width, MIN_COLUMN, content.columns.length);
  const capacity = rowsThatFit(
    content.rows.length,
    box.height - ROW.table.header,
    ROW.table.row,
    0,
    item.data.more_count > 0 || columns < content.columns.length,
  );
  const rows = content.rows.slice(0, capacity);
  const hiddenRows = content.rows.length - rows.length + item.data.more_count;
  const hiddenColumns = content.columns.length - columns;
  return (
    <>
      <table
        data-part="table"
        aria-label={item.heading}
        className="w-full table-fixed border-separate border-spacing-0 text-sm"
      >
        <thead>
          <tr>
            {content.columns.slice(0, columns).map((name, index) => (
              <th
                key={index}
                scope="col"
                className="h-8 truncate border-b border-separator pr-2 text-left text-xs font-medium text-muted"
              >
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="h-8">
              {row.cells.slice(0, columns).map((cell, index) =>
                index === 0 ? (
                  <th
                    key={index}
                    scope="row"
                    className="truncate border-b border-separator pr-2 text-left text-sm font-medium text-foreground"
                  >
                    {cell}
                  </th>
                ) : (
                  <td
                    key={index}
                    className="truncate border-b border-separator pr-2 text-sm text-foreground"
                  >
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex gap-1">
        <MoreChip count={hiddenRows} />
        <MoreChip count={hiddenColumns} axis="columns" />
      </div>
    </>
  );
}
