// キャンバスの窓が描く記述（UI-03、ADR 0032）の表示の規則。React と DOM に依存しない純粋な関数だけを置き、node:test で
// 試験する。記述は main が形式（Ajv）と意味（domain）を検査して参照を置き換えた DesktopCanvasView で、画面は検査をやり直さず
// 描き方だけを決める。位置は 12 列の格子のヒント（列・幅・行数）から決め、ピクセル・座標・色は記述に持たない。
import type { DesktopCanvasView } from '@buddy/contracts';

export type CanvasViewItem = DesktopCanvasView['items'][number];

// 格子のヒントを Tailwind のクラスにする表。クラス名は静的な文字列でないと、ビルド時に CSS へ出ない（styles.css の
// @source が画面のソースを走査する）ので、表で持つ。
const COLUMN_START: readonly string[] = [
  '',
  'col-start-1',
  'col-start-2',
  'col-start-3',
  'col-start-4',
  'col-start-5',
  'col-start-6',
  'col-start-7',
  'col-start-8',
  'col-start-9',
  'col-start-10',
  'col-start-11',
  'col-start-12',
];
const COLUMN_SPAN: readonly string[] = [
  '',
  'col-span-1',
  'col-span-2',
  'col-span-3',
  'col-span-4',
  'col-span-5',
  'col-span-6',
  'col-span-7',
  'col-span-8',
  'col-span-9',
  'col-span-10',
  'col-span-11',
  'col-span-12',
];
const ROW_SPAN: readonly string[] = [
  '',
  'row-span-1',
  'row-span-2',
  'row-span-3',
  'row-span-4',
  'row-span-5',
  'row-span-6',
  'row-span-7',
  'row-span-8',
];

// 物の格子のヒントから置き場所のクラスを返す。記述の検査（Schema・domain）を通った値（列 1〜12・幅 1〜12・行 1〜8・
// 列 + 幅 − 1 が 12 以内）だけが届くが、範囲外が来ても壊れないよう、範囲に収める。
export function gridClass(grid: CanvasViewItem['grid']): string {
  const column = Math.min(12, Math.max(1, Math.trunc(grid.column)));
  const span = Math.min(13 - column, Math.max(1, Math.trunc(grid.span)));
  const rows = Math.min(8, Math.max(1, Math.trunc(grid.rows)));
  return [COLUMN_START[column], COLUMN_SPAN[span], ROW_SPAN[rows]].join(' ');
}

// 描く物を、読む順（reading_order）に並べて返す。棚に片付けた物（placement が shelf）は棚の部品（UI-06）が描くので、
// ここには入れない。読む順にない物は描かない（読み上げ・キーボードの移動の順が正本）。
export function visibleItems(
  view: DesktopCanvasView | null,
): readonly CanvasViewItem[] {
  if (view === null) return [];
  const byId = new Map(view.items.map((item) => [item.item_id, item]));
  return view.reading_order.flatMap((id) => {
    const item = byId.get(id);
    return item !== undefined && item.placement === 'canvas' ? [item] : [];
  });
}

// 物の強調に応じた枠の色と濃さ。説明文ではなく、枠で「要確認」を伝える（high は accent の枠）。
export function emphasisClass(emphasis: CanvasViewItem['emphasis']): string {
  if (emphasis === 'high') return 'border-2 border-accent';
  if (emphasis === 'low') return 'opacity-70';
  return '';
}
