// キャンバスの物を 12 列の格子に並べる（UI-03、ADR 0032）。置く物は main が検査した記述（DesktopCanvasView）だけで、
// 読む順（reading_order）の順に DOM へ並べる（読み上げ・キーボードの移動の順）。位置は物ごとの格子のヒントから決まる
// （state/canvas-state.ts の gridClass）。AI はコード・HTML・CSS・座標を出さず、描画は決まった部品だけで行う。
// 今の部品は list の 1 種類で、そのほかの部品・フローティングウィンドウは UI-07。同じ見た目（card）で描く。
import type { DesktopCanvasView } from '@buddy/contracts';
import { visibleItems } from '../../state/canvas-state.js';
import { ListCard } from './ListCard.js';

export function CanvasBoard({
  view,
}: {
  readonly view: DesktopCanvasView | null;
}) {
  const items = visibleItems(view);
  if (items.length === 0) return null;
  return (
    <div
      data-canvas-revision={view?.canvas_revision}
      className="grid h-full grid-cols-12 auto-rows-[5rem] content-start gap-4 p-10"
    >
      {items.map((item) => (
        <ListCard key={item.item_id} item={item} />
      ))}
    </div>
  );
}
