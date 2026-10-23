// compare: 2〜3 列を横に並べて見比べる（UI-07、ADR 0032）。違いは位置で示す: 全部の列で同じ値の行は 1 つの広いセルにまとめて
// 中央に置き、違う値の行は列ごとにセルを分けて並べ、行の左に accent の太い線を引く（色だけに頼らず、まとまりか分かれかで
// 分かる）。幅に入らない列（→）・箱の高さに入らない行は数の札で示す。狭い箱（幅 240 未満）では、行の名前を値の上に置く。
import type { CanvasContent } from '@buddy/contracts';
import {
  ROW,
  columnCapacity,
  rowsThatFit,
} from '../../../state/canvas-content-state.js';
import { MoreChip } from './part-kit.js';
import type { PartProps } from './part-kit.js';

type CompareContent = Extract<CanvasContent, { component: 'compare' }>;

// 1 列の最小の幅と、行の名前の列の幅（ピクセル）。
const MIN_COLUMN = 80;
const LABEL_WIDTH = 64;

export function ComparePart({ item, content, box }: PartProps<CompareContent>) {
  const narrow = box.size === 'narrow';
  const visible = columnCapacity(
    box.width,
    MIN_COLUMN,
    content.columns.length,
    2,
  );
  const capacity = rowsThatFit(
    content.rows.length,
    box.height - ROW.compare.header,
    narrow ? ROW.compare.narrowRow : ROW.compare.row,
    0,
    item.data.more_count > 0 || visible < content.columns.length,
  );
  const rows = content.rows.slice(0, capacity);
  const hiddenRows = content.rows.length - rows.length + item.data.more_count;
  const hiddenColumns = content.columns.length - visible;
  const template = narrow
    ? `repeat(${visible}, minmax(0, 1fr))`
    : `${LABEL_WIDTH}px repeat(${visible}, minmax(0, 1fr))`;
  // 値の列の始まり（1 から数える）。狭い箱では行の名前を上の段に置くので、値は 1 列目から。
  const first = narrow ? 1 : 2;
  return (
    <>
      <div
        data-part="compare"
        role="table"
        aria-label={item.heading}
        className="flex flex-col"
      >
        <div
          role="row"
          style={{ gridTemplateColumns: template }}
          className="grid h-8 items-center gap-x-2 border-b border-separator"
        >
          {narrow ? null : <span role="presentation" />}
          {content.columns.slice(0, visible).map((name, index) => (
            <span
              key={index}
              role="columnheader"
              className="truncate text-sm font-medium text-foreground"
            >
              {name}
            </span>
          ))}
        </div>
        {rows.map((row, rowIndex) => {
          const same = row.values.every((value) => value === row.values[0]);
          const values = row.values.slice(0, visible);
          return (
            <div
              key={rowIndex}
              role="row"
              data-same={same ? 'true' : 'false'}
              style={{ gridTemplateColumns: template }}
              className={`grid items-center gap-x-2 border-b border-l-4 border-separator py-1 ${
                same ? 'border-l-transparent' : 'border-l-accent pl-1'
              } ${narrow ? 'min-h-[52px] content-center' : 'min-h-8'}`}
            >
              <span
                role="rowheader"
                style={{
                  gridColumn: narrow ? `1 / span ${visible}` : '1',
                }}
                className="truncate text-xs text-muted"
              >
                {row.label}
              </span>
              {same ? (
                <span
                  role="cell"
                  data-merged="true"
                  style={{ gridColumn: `${first} / span ${visible}` }}
                  className="truncate text-center text-sm text-foreground"
                >
                  {row.values[0]}
                </span>
              ) : (
                values.map((value, index) => (
                  <span
                    key={index}
                    role="cell"
                    className="truncate text-sm font-medium text-foreground"
                  >
                    {value}
                  </span>
                ))
              )}
            </div>
          );
        })}
      </div>
      <div className="flex gap-1">
        <MoreChip count={hiddenRows} />
        <MoreChip count={hiddenColumns} axis="columns" />
      </div>
    </>
  );
}
