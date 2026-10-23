// キャンバスの窓の配置とユーザーの操作の状態（UI-06、ADR 0032）。React と DOM に依存しない純粋な関数だけを置き、node:test で
// 試験する。位置は配置のエンジン（@buddy/domain の layoutCanvas）が決め、画面はその結果を描くだけ。
// - 守る物（ドラッグ中・送信中の物）はエンジンにその位置で置かせ、新しい記述が届いても AI の更新から守る。
// - 操作は物の名前とマスだけで、ピクセル・本文を送らない。ロック・停止・後ろへ戻る・記述を捨てたときは、選択・ドラッグ・
//   送信中の位置をすべて捨てる。
import type { CanvasUserOp, DesktopCanvasView } from '@buddy/contracts';
import { canvasCellAt, layoutCanvas } from '@buddy/domain';
import type {
  CanvasCellLike,
  CanvasInsets,
  CanvasLayoutBox,
  CanvasLayoutGrid,
  CanvasLayoutResult,
  CanvasUserPinLike,
} from '@buddy/domain';

export type { CanvasLayoutBox, CanvasLayoutGrid, CanvasLayoutResult };

export const NO_INSETS: CanvasInsets = { top: 0, right: 0, bottom: 0, left: 0 };

// window.screen と窓の位置（一部）。
export interface ScreenLike {
  readonly availLeft?: number;
  readonly availTop?: number;
  readonly availWidth: number;
  readonly availHeight: number;
}

export interface WindowLike {
  readonly screenX: number;
  readonly screenY: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
}

const finite = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

// キャンバスの窓の大きさに対する、作業領域の外の幅（macOS のメニューバー・Dock）。画面ぴったりの窓が作業領域より
// 大きいときだけ 0 より大きい。IPC を足さず、window.screen の avail* と窓の位置から求める。
export function canvasInsetsFrom(
  screen: ScreenLike,
  win: WindowLike,
): CanvasInsets {
  const availLeft = finite(screen.availLeft);
  const availTop = finite(screen.availTop);
  const width = Math.max(0, finite(win.innerWidth));
  const height = Math.max(0, finite(win.innerHeight));
  const clampTo = (value: number, max: number) =>
    Math.min(max, Math.max(0, Math.round(value)));
  return {
    top: clampTo(availTop - finite(win.screenY), height),
    left: clampTo(availLeft - finite(win.screenX), width),
    right: clampTo(
      finite(win.screenX) + width - (availLeft + finite(screen.availWidth)),
      width,
    ),
    bottom: clampTo(
      finite(win.screenY) + height - (availTop + finite(screen.availHeight)),
      height,
    ),
  };
}

export interface CanvasDrag {
  readonly item_id: string;
  // move は位置、resize は大きさを変える。
  readonly mode: 'move' | 'resize';
  // 掴んだときのマスとポインターの位置。
  readonly origin: CanvasCellLike;
  readonly startX: number;
  readonly startY: number;
  // 今の置く先のマス（格子に合わせた）。
  readonly cell: CanvasCellLike;
}

export interface CanvasPending {
  // 操作の ID（画面の中で単調に増やし、使い回さない）と世代（選択・ドラッグ・送信中を捨てるたびに進める）。
  // 応答はこの 2 つが今の送信中と同じときだけ反映する（前の操作の遅れた応答で、次の操作の保護を外さない）。
  readonly op_id: number;
  readonly generation: number;
  readonly item_id: string;
  // cell が null なら閉じる・片付けるの送信中。
  readonly cell: CanvasCellLike | null;
  // 送ったときに描いていた版。
  readonly revision: string;
  // 中枢が当てた後の版（成功の応答の canvas_revision）。null は応答を待っている。
  readonly applied: string | null;
}

export interface CanvasInteraction {
  readonly selected: string | null;
  readonly drag: CanvasDrag | null;
  // 送った操作が当たった版の記述が届くか、拒否されるまで守る位置。
  readonly pending: CanvasPending | null;
  // 入りきらない物の札から見せるよう選んだ物（画面だけの表示の切り替え。記述・記録は変えない）。
  readonly revealed: string | null;
}

export const NO_INTERACTION: CanvasInteraction = {
  selected: null,
  drag: null,
  pending: null,
  revealed: null,
};

const visibleIds = (view: DesktopCanvasView | null): Set<string> =>
  new Set(
    view === null
      ? []
      : view.items
          .filter((item) => item.placement === 'canvas')
          .map((item) => item.item_id),
  );

const newer = (a: string, b: string): boolean => {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return false;
  }
};

// 新しい記述が届いた。記述がない（ロック・停止・切断で捨てた）ならすべて捨てる。ドラッグしている物がなくなった
// （AI が閉じた・片付けた）ならドラッグをやめる。送信中の位置は、中枢が当てた版（成功の応答の canvas_revision）以上の
// 記述が届いたら解く（ほかの物の更新で新しい版が届いただけでは解かない。PR #121 のレビュー P2）。その物が記述から
// なくなったときも解く。ドラッグしている物の位置は変えない（AI の更新から守る）。
export function interactionAfterView(
  state: CanvasInteraction,
  view: DesktopCanvasView | null,
): CanvasInteraction {
  if (view === null) return NO_INTERACTION;
  const visible = visibleIds(view);
  const drag =
    state.drag !== null && visible.has(state.drag.item_id) ? state.drag : null;
  const pending =
    state.pending !== null &&
    ((state.pending.applied !== null &&
      !newer(state.pending.applied, view.canvas_revision)) ||
      !view.items.some((item) => item.item_id === state.pending?.item_id))
      ? null
      : state.pending;
  const selected =
    state.selected !== null && visible.has(state.selected)
      ? state.selected
      : null;
  const revealed =
    state.revealed !== null && visible.has(state.revealed)
      ? state.revealed
      : null;
  if (
    drag === state.drag &&
    pending === state.pending &&
    selected === state.selected &&
    revealed === state.revealed
  )
    return state;
  return { selected, drag, pending, revealed };
}

// エンジンに守らせる物（ドラッグ中が先、次に送信中）。
export function heldOf(state: CanvasInteraction): CanvasUserPinLike | null {
  if (state.drag !== null)
    return { item_id: state.drag.item_id, cell: state.drag.cell };
  if (state.pending?.cell != null)
    return { item_id: state.pending.item_id, cell: state.pending.cell };
  return null;
}

// 記述と窓の大きさから配置を決める。閉じる・片付けるの送信中の物は、Core が当てるまで描かない（すぐに消えたように見せる）。
export function layoutForView(
  view: DesktopCanvasView | null,
  viewport: { readonly width: number; readonly height: number },
  insets: CanvasInsets,
  interaction: CanvasInteraction,
): CanvasLayoutResult {
  const hidden =
    interaction.pending !== null && interaction.pending.cell === null
      ? interaction.pending.item_id
      : null;
  const items = (view?.items ?? []).filter((item) => item.item_id !== hidden);
  return layoutCanvas({
    items,
    reading_order: (view?.reading_order ?? []).filter((id) => id !== hidden),
    user_pins: view?.user_pins ?? [],
    held: heldOf(interaction),
    revealed: interaction.revealed,
    viewport,
    insets,
  });
}

// ドラッグを始める（キャンバスが前に出ていて、格子のときだけ）。
export function beginDrag(
  state: CanvasInteraction,
  box: CanvasLayoutBox,
  mode: CanvasDrag['mode'],
  point: { readonly x: number; readonly y: number },
): CanvasInteraction {
  if (box.cell === null || state.pending !== null) return state;
  return {
    ...state,
    selected: box.item_id,
    pending: null,
    drag: {
      item_id: box.item_id,
      mode,
      origin: box.cell,
      startX: point.x,
      startY: point.y,
      cell: box.cell,
    },
  };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

// ポインターが動いた。move は掴んだマスからの移動量で置く先を、resize は大きさを決める（格子のマスに合わせる）。
export function dragTo(
  state: CanvasInteraction,
  grid: CanvasLayoutGrid | null,
  point: { readonly x: number; readonly y: number },
): CanvasInteraction {
  const drag = state.drag;
  if (drag === null || grid === null) return state;
  const pitchX = grid.columnWidth + grid.gap;
  const pitchY = grid.rowHeight + grid.gap;
  const dx = point.x - drag.startX;
  const dy = point.y - drag.startY;
  let cell: CanvasCellLike;
  if (drag.mode === 'move') {
    const originX = grid.x + (drag.origin.column - 1) * pitchX;
    const originY = grid.y + (drag.origin.row - 1) * pitchY;
    cell = canvasCellAt(
      grid,
      { x: originX + dx, y: originY + dy },
      drag.origin,
    );
  } else {
    const span = clamp(
      drag.origin.span + Math.round(dx / pitchX),
      1,
      grid.columns - drag.origin.column + 1,
    );
    const rows = clamp(
      drag.origin.rows + Math.round(dy / pitchY),
      1,
      Math.max(1, Math.min(8, grid.rows - drag.origin.row + 1)),
    );
    cell = { ...drag.origin, span, rows };
  }
  if (
    cell.column === drag.cell.column &&
    cell.row === drag.cell.row &&
    cell.span === drag.cell.span &&
    cell.rows === drag.cell.rows
  )
    return state;
  return { ...state, drag: { ...drag, cell } };
}

const sameCell = (a: CanvasCellLike, b: CanvasCellLike): boolean =>
  a.column === b.column &&
  a.row === b.row &&
  a.span === b.span &&
  a.rows === b.rows;

// ドラッグを終えた。置く先が掴んだときと違えば、送る操作を返す（送信中の位置は sent で守る）。
export function endDrag(state: CanvasInteraction): {
  readonly state: CanvasInteraction;
  readonly op: CanvasUserOp | null;
} {
  const drag = state.drag;
  if (drag === null) return { state, op: null };
  const next = { ...state, drag: null };
  if (sameCell(drag.cell, drag.origin)) return { state: next, op: null };
  return {
    state: next,
    op: {
      kind: drag.mode,
      item_id: drag.item_id,
      cell: { ...drag.cell },
    },
  };
}

// 操作を送った。Core が当てるか拒否されるまで、送った位置を守る（閉じる・片付けるは描かない）。
export function sent(
  state: CanvasInteraction,
  op: CanvasUserOp,
  revision: string,
  id: { readonly opId: number; readonly generation: number },
): CanvasInteraction {
  const removes = op.kind === 'close' || op.kind === 'shelve';
  return {
    selected: op.kind === 'move' || op.kind === 'resize' ? op.item_id : null,
    drag: null,
    pending: {
      op_id: id.opId,
      generation: id.generation,
      item_id: op.item_id,
      cell: 'cell' in op ? { ...op.cell } : null,
      revision,
      applied: null,
    },
    revealed: removes && state.revealed === op.item_id ? null : state.revealed,
  };
}

// 送った操作の応答が来た。操作の ID と世代が今の送信中と違えば何もしない（前の操作の遅れた応答・捨てた後の応答）。
// 拒否・結果不明（applied が null）なら守る位置を解く（記述は main が取り直す）。当たったなら、当てた版を覚え、
// その版以上の記述が届くまで守る（今の記述がもうその版以上なら、すぐに解く）。
export function settled(
  state: CanvasInteraction,
  id: { readonly opId: number; readonly generation: number },
  applied: string | null,
  viewRevision: string | null,
): CanvasInteraction {
  const pending = state.pending;
  if (
    pending === null ||
    pending.op_id !== id.opId ||
    pending.generation !== id.generation
  )
    return state;
  if (applied === null) return { ...state, pending: null };
  if (viewRevision !== null && !newer(applied, viewRevision))
    return { ...state, pending: null };
  return { ...state, pending: { ...pending, applied } };
}

// 入りきらない物の札から、その物を見せる（ほかの物が札に回る）。画面だけの切り替えで、記述・記録は変えない。
export function reveal(
  state: CanvasInteraction,
  itemId: string,
): CanvasInteraction {
  return { ...state, revealed: itemId, selected: itemId };
}

export interface KeyLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

// 選んだ物へのキーボードの操作（ADR 0032 の UI-06）。矢印で 1 マス動かす、Shift ＋ 矢印で大きさを 1 マス変える
// （← → は幅、↑ ↓ は行数）、Delete・Backspace で閉じる、Alt（Option）＋ ↓ で棚へ片付ける。1 列（格子がない）のときは
// 動かす・大きさを変えるを受けない。変わらない操作（端で動かす）は null。
export function keyOp(
  key: KeyLike,
  box: CanvasLayoutBox,
  grid: CanvasLayoutGrid | null,
): CanvasUserOp | null {
  if (key.ctrlKey || key.metaKey) return null;
  if (
    (key.key === 'Delete' || key.key === 'Backspace') &&
    !key.shiftKey &&
    !key.altKey
  )
    return { kind: 'close', item_id: box.item_id };
  if (key.altKey && !key.shiftKey && key.key === 'ArrowDown')
    return { kind: 'shelve', item_id: box.item_id };
  if (key.altKey) return null;
  const delta: Readonly<Record<string, readonly [number, number]>> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const step = delta[key.key];
  if (step === undefined || grid === null || box.cell === null) return null;
  const cell = box.cell;
  let next: CanvasCellLike;
  if (key.shiftKey)
    next = {
      ...cell,
      span: clamp(cell.span + step[0], 1, grid.columns - cell.column + 1),
      rows: clamp(
        cell.rows + step[1],
        1,
        Math.max(1, Math.min(8, grid.rows - cell.row + 1)),
      ),
    };
  else
    next = {
      ...cell,
      column: clamp(cell.column + step[0], 1, grid.columns - cell.span + 1),
      row: clamp(cell.row + step[1], 1, Math.max(1, grid.rows - cell.rows + 1)),
    };
  if (sameCell(next, cell)) return null;
  return {
    kind: key.shiftKey ? 'resize' : 'move',
    item_id: box.item_id,
    cell: next,
  };
}
