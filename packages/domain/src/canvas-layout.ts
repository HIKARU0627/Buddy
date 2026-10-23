// キャンバスの配置のエンジン（UI-06、ADR 0032 の「UI-06 の配置のエンジンとユーザーの操作」）。
// 記述（物・読む順）・ユーザーの操作の記録（ユーザーの置き場所）・守る物（ドラッグ中・送信中）・キャンバスの大きさから、
// 各物の位置と大きさ・読む順・棚・入りきらない物を決める。純粋な関数で、DOM・Electron・Node 専用 API に依存しない。
// 乱数・時刻・前回の結果を使わず、決まった入力からは決まった結果を出す。AI はピクセルを書かない（意味だけを書く）。
import type {
  CanvasCellLike,
  CanvasGridLike,
  CanvasRelationLike,
  CanvasUserPinLike,
} from './canvas.js';
import { CANVAS_GRID_COLUMNS } from './canvas.js';

// 寸法（CSS ピクセル）。入力バー・端のつまみの大きさ（apps/desktop の INPUT_BAR_SIZE 560 × 56・INPUT_BAR_MARGIN 16・
// STATUS_TAB_SIZE の幅 56）より広く空ける（一致は apps/desktop の試験で確かめる）。
export const CANVAS_LAYOUT = {
  margin: 24,
  gap: 16,
  rowHeight: 72,
  // 作業領域の右の端に空ける幅（状態の層のつまみ 56 と余白）。
  statusReserveWidth: 72,
  // 作業領域の下の中央に空ける場所（入力バー 560 × 56、下の余白 16、上の余白 16）。
  inputBarReserve: { width: 592, height: 88 },
  shelfHeight: 56,
  // 棚を入力バーの左に置くときの、作業領域の下端からの余白（入力バーと高さをそろえる）。
  shelfBottomMargin: 16,
  shelfMinWidth: 160,
  // カードを置ける幅がこれ未満なら 1 列にする。
  gridMinWidth: 720,
  maxRows: 48,
  // 扱う最小の高さ（作業領域）。上の余白 24 ＋ 1 行 72 ＋ 間 16 ＋ 棚 56 ＋ 間 16 ＋ 入力バーの場所 88。これ以上なら、
  // 少なくとも 1 行（1 列では 1 行分の物 1 つ）を置け、棚と入力バーの場所は重ならず、棚は作業領域の中にある。
  minHeight: 272,
  // 最小の高さに満たないときの、小さな棚（作業領域の上の端から 4 下・高さ 32）。
  compactShelfTop: 4,
  compactShelfHeight: 32,
} as const;

export interface CanvasLayoutItemLike {
  readonly item_id: string;
  readonly emphasis: string;
  readonly group: string | null;
  readonly relations: readonly CanvasRelationLike[];
  readonly grid: CanvasGridLike;
  readonly placement: 'canvas' | 'shelf';
}

export interface CanvasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface CanvasLayoutInput {
  readonly items: readonly CanvasLayoutItemLike[];
  readonly reading_order: readonly string[];
  // ユーザーの操作の記録（Core が持つユーザーの置き場所）。
  readonly user_pins?: readonly CanvasUserPinLike[];
  // 守る物（ドラッグ中・送信中の物の今のマス）。画面だけが持つ。AI の更新から守る。
  readonly held?: CanvasUserPinLike | null;
  readonly viewport: { readonly width: number; readonly height: number };
  // 作業領域の外（macOS のメニューバー・Dock など）。省略は 0。
  readonly insets?: CanvasInsets;
  // 札から見せるよう選ばれた物（画面だけが持つ表示の切り替え。記述は変えない）。先に場所を取る。
  readonly revealed?: string | null;
}

export interface CanvasLayoutBox {
  readonly item_id: string;
  readonly rect: CanvasRect;
  // 格子のマス（1 列のときは null）。
  readonly cell: CanvasCellLike | null;
  // 位置を決めたもの: 守る物・ユーザーの置き場所・エンジン。
  readonly source: 'held' | 'user' | 'engine';
}

export interface CanvasLayoutGrid {
  readonly x: number;
  readonly y: number;
  readonly columnWidth: number;
  readonly rowHeight: number;
  readonly gap: number;
  readonly columns: number;
  readonly rows: number;
}

export interface CanvasLayoutResult {
  // minimal は作業領域が最小の高さに満たない（物を置かず、すべて小さな棚の札にする）。
  readonly mode: 'grid' | 'column' | 'minimal';
  // 置いた物（読む順）。
  readonly boxes: readonly CanvasLayoutBox[];
  // 置いた物と入りきらない物の読む順（記述の reading_order のまま）。
  readonly reading_order: readonly string[];
  // 入りきらず、棚の場所に並べる物（読む順）。記述は変えない。
  readonly overflow: readonly string[];
  readonly shelf: {
    readonly rect: CanvasRect;
    readonly items: readonly string[];
    // 小さな棚（最小の高さに満たないとき。作業領域の上の端に置く）。
    readonly compact: boolean;
  };
  readonly reserved: {
    readonly input_bar: CanvasRect;
    readonly status: CanvasRect;
  };
  readonly grid: CanvasLayoutGrid | null;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const finite = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

// 強調の読み替え（ADR 0032）: high は焦点、normal は補助、low は周辺。
type Role = 'focus' | 'support' | 'peripheral';
const roleOf = (emphasis: string): Role =>
  emphasis === 'high' ? 'focus' : emphasis === 'low' ? 'peripheral' : 'support';

interface Spot {
  readonly row: number;
  readonly column: number;
}

// 望む場所。point はその位置（マスの左上）からの距離、area はその範囲からのすき間（接していれば 0）で近さを測る。
type Want =
  | { readonly kind: 'point'; readonly spot: Spot }
  | { readonly kind: 'area'; readonly cell: CanvasCellLike };

const point = (row: number, column: number): Want => ({
  kind: 'point',
  spot: { row, column },
});

// 2 つの範囲の、行と列のすき間（重なる・接するなら 0）。
const gapOf = (
  start: number,
  length: number,
  otherStart: number,
  otherLength: number,
): number =>
  Math.max(
    0,
    otherStart - (start + length),
    start - (otherStart + otherLength),
  );

// 格子の空き。行 × 12 列。
class Occupancy {
  readonly #rows: number;
  readonly #cells: boolean[];

  constructor(rows: number) {
    this.#rows = rows;
    this.#cells = new Array<boolean>(rows * CANVAS_GRID_COLUMNS).fill(false);
  }

  free(cell: CanvasCellLike): boolean {
    if (
      cell.row < 1 ||
      cell.column < 1 ||
      cell.row + cell.rows - 1 > this.#rows ||
      cell.column + cell.span - 1 > CANVAS_GRID_COLUMNS
    )
      return false;
    for (let r = cell.row; r < cell.row + cell.rows; r += 1)
      for (let c = cell.column; c < cell.column + cell.span; c += 1)
        if (this.#cells[(r - 1) * CANVAS_GRID_COLUMNS + (c - 1)]) return false;
    return true;
  }

  take(cell: CanvasCellLike): void {
    for (let r = cell.row; r < cell.row + cell.rows; r += 1)
      for (let c = cell.column; c < cell.column + cell.span; c += 1)
        this.#cells[(r - 1) * CANVAS_GRID_COLUMNS + (c - 1)] = true;
  }

  // 望む場所に最も近い空き（距離は 行の差 × 3 ＋ 列の差 × 2。area は範囲からのすき間の行と列。同点は上、次に左）。
  // なければ null。
  nearest(span: number, rows: number, want: Want): Spot | null {
    let best: { spot: Spot; score: number } | null = null;
    for (let row = 1; row + rows - 1 <= this.#rows; row += 1)
      for (
        let column = 1;
        column + span - 1 <= CANVAS_GRID_COLUMNS;
        column += 1
      ) {
        if (!this.free({ column, row, span, rows })) continue;
        const score =
          want.kind === 'point'
            ? Math.abs(row - want.spot.row) * 3 +
              Math.abs(column - want.spot.column) * 2
            : gapOf(row, rows, want.cell.row, want.cell.rows) * 3 +
              gapOf(column, span, want.cell.column, want.cell.span) * 2;
        if (best === null || score < best.score)
          best = { spot: { row, column }, score };
      }
    return best?.spot ?? null;
  }
}

interface Frame {
  readonly safe: CanvasRect;
  readonly status: CanvasRect;
  readonly inputBar: CanvasRect;
  readonly shelf: CanvasRect;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly bottom: number;
}

// 作業領域・空ける場所・棚・カードを置ける範囲。
function frameOf(input: CanvasLayoutInput): Frame {
  const L = CANVAS_LAYOUT;
  const viewportWidth = finite(input.viewport.width);
  const viewportHeight = finite(input.viewport.height);
  const insets = input.insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const left = clamp(finite(insets.left), 0, viewportWidth);
  const top = clamp(finite(insets.top), 0, viewportHeight);
  const safe: CanvasRect = {
    x: left,
    y: top,
    width: Math.max(0, viewportWidth - left - finite(insets.right)),
    height: Math.max(0, viewportHeight - top - finite(insets.bottom)),
  };
  const statusWidth = Math.min(L.statusReserveWidth, safe.width);
  const status: CanvasRect = {
    x: safe.x + safe.width - statusWidth,
    y: safe.y,
    width: statusWidth,
    height: safe.height,
  };
  const barWidth = Math.min(L.inputBarReserve.width, safe.width);
  const barHeight = Math.min(L.inputBarReserve.height, safe.height);
  const inputBar: CanvasRect = {
    x: safe.x + Math.round((safe.width - barWidth) / 2),
    y: safe.y + safe.height - barHeight,
    width: barWidth,
    height: barHeight,
  };
  const contentLeft = safe.x + L.margin;
  const contentWidth = Math.max(0, status.x - L.margin - contentLeft);
  const leftOfBar = inputBar.x - L.gap - contentLeft;
  let shelf: CanvasRect;
  let bandTop: number;
  if (leftOfBar >= L.shelfMinWidth) {
    // 入力バーの左に、入力バーと高さをそろえて置く。
    shelf = {
      x: contentLeft,
      y: safe.y + safe.height - L.shelfBottomMargin - L.shelfHeight,
      width: leftOfBar,
      height: L.shelfHeight,
    };
    bandTop = inputBar.y;
  } else {
    // 左に幅がなければ、入力バーの上に作業領域の幅で置く。
    shelf = {
      x: contentLeft,
      y: inputBar.y - L.gap - L.shelfHeight,
      width: contentWidth,
      height: L.shelfHeight,
    };
    bandTop = shelf.y;
  }
  return {
    safe,
    status,
    inputBar,
    shelf,
    left: contentLeft,
    top: safe.y + L.margin,
    width: contentWidth,
    bottom: bandTop - L.gap,
  };
}

// 物の大きさ（格子のヒントから。焦点は広げ、周辺は縮める）。
function sizeOf(
  item: CanvasLayoutItemLike,
  gridRows: number,
): { span: number; rows: number } {
  let span = clamp(Math.trunc(item.grid.span), 1, CANVAS_GRID_COLUMNS);
  let rows = clamp(Math.trunc(item.grid.rows), 1, 8);
  const role = roleOf(item.emphasis);
  if (role === 'focus') {
    span = Math.max(span, 6);
    rows = Math.max(rows, 4);
  } else if (role === 'peripheral') {
    span = Math.min(span, 4);
    rows = Math.min(rows, 2);
  }
  return { span, rows: Math.max(1, Math.min(rows, gridRows)) };
}

// 記録したマスを格子に収める（列・幅は 12 列に、行・行数は作れる行に）。
function clampCell(cell: CanvasCellLike, gridRows: number): CanvasCellLike {
  const column = clamp(Math.trunc(cell.column), 1, CANVAS_GRID_COLUMNS);
  const span = clamp(
    Math.trunc(cell.span),
    1,
    CANVAS_GRID_COLUMNS - column + 1,
  );
  const rows = clamp(Math.trunc(cell.rows), 1, Math.max(1, gridRows));
  const row = clamp(Math.trunc(cell.row), 1, Math.max(1, gridRows - rows + 1));
  return { column, row, span, rows };
}

export function layoutCanvas(input: CanvasLayoutInput): CanvasLayoutResult {
  const L = CANVAS_LAYOUT;
  const frame = frameOf(input);
  const byId = new Map(input.items.map((item) => [item.item_id, item]));
  // 見える物（読む順にあり、置き場所が canvas）。読む順の位置も覚える。
  const visible: CanvasLayoutItemLike[] = [];
  const seen = new Set<string>();
  for (const id of input.reading_order) {
    const item = byId.get(id);
    if (item === undefined || item.placement !== 'canvas' || seen.has(id))
      continue;
    seen.add(id);
    visible.push(item);
  }
  const orderIndex = new Map(
    visible.map((item, index) => [item.item_id, index]),
  );
  const shelfItems = input.items
    .filter((item) => item.placement === 'shelf')
    .map((item) => item.item_id);
  const common = {
    shelf: { rect: frame.shelf, items: shelfItems, compact: false },
    reserved: { input_bar: frame.inputBar, status: frame.status },
  };
  const revealed =
    input.revealed === undefined || input.revealed === null
      ? undefined
      : visible.find((item) => item.item_id === input.revealed);

  if (frame.safe.height < L.minHeight) {
    // 最小の高さに満たない: 物は置かず、すべて入りきらない物にする。棚は作業領域の上の端の小さな帯にする
    // （棚の上の端が作業領域の中にあるように）。
    return {
      mode: 'minimal',
      boxes: [],
      reading_order: visible.map((item) => item.item_id),
      overflow: visible.map((item) => item.item_id),
      grid: null,
      shelf: {
        rect: {
          x: frame.left,
          y: frame.safe.y + Math.min(L.compactShelfTop, frame.safe.height),
          width: frame.width,
          height: Math.max(
            0,
            Math.min(
              L.compactShelfHeight,
              frame.safe.height - L.compactShelfTop,
            ),
          ),
        },
        items: shelfItems,
        compact: true,
      },
      reserved: common.reserved,
    };
  }
  const byOrder = (a: { item_id: string }, b: { item_id: string }) =>
    (orderIndex.get(a.item_id) ?? 0) - (orderIndex.get(b.item_id) ?? 0);

  if (frame.width < L.gridMinWidth) {
    // 1 列: 読む順に上から、幅いっぱいで並べる。下に届いた物から後ろは入りきらない物。札から見せるよう選ばれた物が
    // あれば、先にその物の場所を取り、残りを読む順に入るだけ足す（並べる順は読む順のまま）。
    const heightOf = (item: CanvasLayoutItemLike) => {
      const role = roleOf(item.emphasis);
      const hinted = clamp(Math.trunc(item.grid.rows), 1, 8);
      const rows =
        role === 'focus'
          ? clamp(hinted, 3, 4)
          : role === 'peripheral'
            ? 1
            : clamp(hinted, 1, 3);
      return rows * L.rowHeight + (rows - 1) * L.gap;
    };
    const room = frame.bottom - frame.top;
    // 札から見せるよう選ばれた物は、入らなければ入る行数まで縮める（最小の高さ以上なら 1 行は必ず入る）。
    const revealedHeight =
      revealed === undefined
        ? 0
        : Math.min(
            heightOf(revealed),
            Math.max(1, Math.floor((room + L.gap) / (L.rowHeight + L.gap))) *
              (L.rowHeight + L.gap) -
              L.gap,
          );
    const heightFor = (item: CanvasLayoutItemLike) =>
      item === revealed ? revealedHeight : heightOf(item);
    const shown = new Set<string>();
    let used = 0;
    const take = (item: CanvasLayoutItemLike): boolean => {
      const add = (shown.size > 0 ? L.gap : 0) + heightFor(item);
      if (used + add > room) return false;
      used += add;
      shown.add(item.item_id);
      return true;
    };
    if (revealed !== undefined) take(revealed);
    for (const item of visible) {
      if (shown.has(item.item_id)) continue;
      if (!take(item)) break;
    }
    const boxes: CanvasLayoutBox[] = [];
    const overflow: string[] = [];
    let y = frame.top;
    for (const item of visible) {
      if (!shown.has(item.item_id)) {
        overflow.push(item.item_id);
        continue;
      }
      const height = heightFor(item);
      boxes.push({
        item_id: item.item_id,
        rect: { x: frame.left, y, width: frame.width, height },
        cell: null,
        source: 'engine',
      });
      y += height + L.gap;
    }
    return {
      mode: 'column',
      boxes,
      reading_order: visible.map((item) => item.item_id),
      overflow,
      grid: null,
      ...common,
    };
  }

  // 格子。
  const gridRows = clamp(
    Math.floor((frame.bottom - frame.top + L.gap) / (L.rowHeight + L.gap)),
    0,
    L.maxRows,
  );
  const columnWidth =
    (frame.width - L.gap * (CANVAS_GRID_COLUMNS - 1)) / CANVAS_GRID_COLUMNS;
  const pitch = columnWidth + L.gap;
  const rectOf = (cell: CanvasCellLike): CanvasRect => {
    const x = Math.round(frame.left + (cell.column - 1) * pitch);
    const right = Math.round(
      frame.left + (cell.column - 1 + cell.span) * pitch - L.gap,
    );
    return {
      x,
      y: frame.top + (cell.row - 1) * (L.rowHeight + L.gap),
      width: right - x,
      height: cell.rows * (L.rowHeight + L.gap) - L.gap,
    };
  };
  let occupancy = new Occupancy(gridRows);
  let placed = new Map<string, CanvasLayoutBox>();
  let overflow = new Set<string>();
  // まとまりごとの、置いた物を囲む範囲。
  let groupArea = new Map<string, CanvasCellLike>();
  let firstFocus: CanvasCellLike | null = null;
  // 置き直すために、空の格子から始め直す（札から見せる物が入らなかったとき）。
  const reset = () => {
    occupancy = new Occupancy(gridRows);
    placed = new Map();
    overflow = new Set();
    groupArea = new Map();
    firstFocus = null;
  };

  const commit = (
    item: CanvasLayoutItemLike,
    cell: CanvasCellLike,
    source: CanvasLayoutBox['source'],
  ) => {
    occupancy.take(cell);
    placed.set(item.item_id, {
      item_id: item.item_id,
      rect: rectOf(cell),
      cell,
      source,
    });
    if (item.group !== null) {
      const area = groupArea.get(item.group);
      if (area === undefined) groupArea.set(item.group, cell);
      else {
        const row = Math.min(area.row, cell.row);
        const column = Math.min(area.column, cell.column);
        groupArea.set(item.group, {
          row,
          column,
          rows: Math.max(area.row + area.rows, cell.row + cell.rows) - row,
          span:
            Math.max(area.column + area.span, cell.column + cell.span) - column,
        });
      }
    }
    if (firstFocus === null && roleOf(item.emphasis) === 'focus')
      firstFocus = cell;
  };

  // 望む位置と大きさで最も近い空きを探す。なければ行数を 1 まで、次に幅を 2 まで減らす（周辺は幅を減らさない）。
  const search = (
    span: number,
    rows: number,
    want: Want,
    shrinkSpan: boolean,
  ): CanvasCellLike | null => {
    for (let r = rows; r >= 1; r -= 1) {
      const spot = occupancy.nearest(span, r, want);
      if (spot !== null) return { ...spot, span, rows: r };
    }
    if (shrinkSpan)
      for (let s = span - 1; s >= 2; s -= 1) {
        const spot = occupancy.nearest(s, 1, want);
        if (spot !== null) return { ...spot, span: s, rows: 1 };
      }
    return null;
  };

  // 記録したマスにそのまま置く（はみ出す・重なるなら、同じ大きさで最も近い空きへ）。
  const placeExact = (
    item: CanvasLayoutItemLike,
    cell: CanvasCellLike,
    source: 'held' | 'user',
  ) => {
    if (gridRows === 0) {
      overflow.add(item.item_id);
      return;
    }
    const fitted = clampCell(cell, gridRows);
    if (occupancy.free(fitted)) {
      commit(item, fitted, source);
      return;
    }
    const found = search(
      fitted.span,
      fitted.rows,
      point(fitted.row, fitted.column),
      true,
    );
    if (found === null) overflow.add(item.item_id);
    else commit(item, found, source);
  };

  // 意味の規則で置く。望む位置は、関係 → まとまり → 強調の順に、最初に当てはまるもので決める。
  // shrinkAlways は、周辺でも幅を縮めて探す（札から見せる物）。
  const placeBySemantics = (
    item: CanvasLayoutItemLike,
    shrinkAlways = false,
  ) => {
    if (gridRows === 0) {
      overflow.add(item.item_id);
      return;
    }
    const role = roleOf(item.emphasis);
    const size = sizeOf(item, gridRows);
    const span = size.span;
    let rows = size.rows;
    const hintColumn = (width: number) =>
      clamp(Math.trunc(item.grid.column), 1, CANVAS_GRID_COLUMNS - width + 1);
    let want: Want | null = null;
    // 関係の相手の隣（同じ行）・真下（同じ列）。まずそこに入るかを試し、入らなければ want から最も近い空きを探す。
    let beside: CanvasCellLike | null = null;
    for (const relation of item.relations) {
      const target = placed.get(relation.target)?.cell ?? null;
      if (target === null) continue;
      if (relation.kind === 'sequence') {
        want = point(target.row + target.rows, target.column);
        const width = Math.min(span, CANVAS_GRID_COLUMNS - target.column + 1);
        const below = {
          row: target.row + target.rows,
          column: target.column,
          span: width,
          rows,
        };
        if (occupancy.free(below)) beside = below;
        break;
      }
      if (relation.kind === 'compare')
        rows = Math.max(1, Math.min(target.rows, gridRows));
      // 右隣。右に幅がなければ左隣。どちらも空いていなければ、幅を 2 まで縮めて右・左の順に試す。
      const right = target.column + target.span;
      want = point(
        target.row,
        right + span - 1 <= CANVAS_GRID_COLUMNS
          ? right
          : Math.max(1, target.column - span),
      );
      for (
        let width = span;
        width >= Math.min(span, 2) && beside === null;
        width -= 1
      )
        for (const column of [right, target.column - width]) {
          const candidate = { row: target.row, column, span: width, rows };
          if (occupancy.free(candidate)) {
            beside = candidate;
            break;
          }
        }
      break;
    }
    if (beside !== null) {
      commit(item, beside, 'engine');
      return;
    }
    if (want === null && item.group !== null) {
      // 同じまとまりの置いた物を囲む範囲に、接する空きを先に。
      const area = groupArea.get(item.group);
      if (area !== undefined) want = { kind: 'area', cell: area };
    }
    if (want === null) {
      const focus: CanvasCellLike | null = firstFocus;
      if (role === 'focus') want = point(1, hintColumn(span));
      else if (role === 'peripheral')
        want = point(gridRows - rows + 1, hintColumn(span));
      // 補助は最初の焦点に接する空きを先に（右・下のどちらでも。同点は上、次に左）。
      else if (focus !== null) want = { kind: 'area', cell: focus };
      else want = point(1, hintColumn(span));
    }
    const found = search(
      span,
      rows,
      want,
      shrinkAlways || role !== 'peripheral',
    );
    if (found === null) overflow.add(item.item_id);
    else commit(item, found, 'engine');
  };

  const held = input.held ?? null;
  const heldItem =
    held === null
      ? undefined
      : visible.find((item) => item.item_id === held.item_id);
  const pins = new Map(
    (input.user_pins ?? []).map((pin) => [pin.item_id, pin.cell]),
  );
  const placeHeld = () => {
    if (
      held !== null &&
      heldItem !== undefined &&
      !placed.has(heldItem.item_id)
    )
      placeExact(heldItem, held.cell, 'held');
  };
  const placePins = () => {
    for (const item of visible) {
      const cell = pins.get(item.item_id);
      if (
        cell !== undefined &&
        !placed.has(item.item_id) &&
        !overflow.has(item.item_id)
      )
        placeExact(item, cell, 'user');
    }
  };
  const placeRevealed = () => {
    if (
      revealed !== undefined &&
      !placed.has(revealed.item_id) &&
      !overflow.has(revealed.item_id)
    )
      placeBySemantics(revealed, true);
  };
  const tier = (role: Role) => {
    const members = visible.filter((item) => roleOf(item.emphasis) === role);
    return [
      ...members.filter((item) => item.relations.length > 0),
      ...members.filter((item) => item.relations.length === 0),
    ];
  };
  const placeRest = () => {
    // 焦点（読む順）。
    for (const item of visible)
      if (
        roleOf(item.emphasis) === 'focus' &&
        !placed.has(item.item_id) &&
        !overflow.has(item.item_id)
      )
        placeBySemantics(item);
    // 補助、その後に周辺（読む順）。それぞれ、関係を持つ物を先に置く（相手の隣を先に取る）。関係の相手がまだなら、
    // 相手の後に回す。
    const rest = [...tier('support'), ...tier('peripheral')].filter(
      (item) => !placed.has(item.item_id) && !overflow.has(item.item_id),
    );
    while (rest.length > 0) {
      const waiting = new Set(rest.map((item) => item.item_id));
      let index = rest.findIndex((item) =>
        item.relations.every(
          (relation) =>
            relation.target === item.item_id || !waiting.has(relation.target),
        ),
      );
      if (index === -1) index = 0;
      const [next] = rest.splice(index, 1);
      if (next !== undefined) placeBySemantics(next);
    }
  };
  // 置く順: 1. 守る物 → 2. ユーザーの置き場所 → 3. 札から見せるよう選ばれた物 → 4. 焦点 → 5. 補助・周辺。
  // 選ばれた物が入らなければ（ユーザーの置き場所が場所を埋めている）、選ばれた物をユーザーの置き場所より先に置いて
  // 置き直す（ユーザーの置き場所を一時的に下げる）。それでも入らなければ（守る物が場所を埋めている）、選ばれた物を
  // 最初に置く。格子に 1 行あれば、最初に置いた物は必ず入る（幅・行数を縮める）。
  placeHeld();
  placePins();
  placeRevealed();
  if (revealed !== undefined && !placed.has(revealed.item_id)) {
    reset();
    placeHeld();
    placeRevealed();
    placePins();
  }
  if (revealed !== undefined && !placed.has(revealed.item_id)) {
    reset();
    placeRevealed();
    placeHeld();
    placePins();
  }
  placeRest();

  const boxes = [...placed.values()].sort(byOrder);
  return {
    mode: 'grid',
    boxes,
    reading_order: visible.map((item) => item.item_id),
    overflow: visible
      .filter((item) => overflow.has(item.item_id))
      .map((item) => item.item_id),
    grid: {
      x: frame.left,
      y: frame.top,
      columnWidth,
      rowHeight: L.rowHeight,
      gap: L.gap,
      columns: CANVAS_GRID_COLUMNS,
      rows: gridRows,
    },
    ...common,
  };
}

// 画面の点（ピクセル）を格子のマスの左上に合わせる（ドラッグの落とし先。UI-06）。範囲外は格子に収める。
export function canvasCellAt(
  grid: CanvasLayoutGrid,
  point: { readonly x: number; readonly y: number },
  size: { readonly span: number; readonly rows: number },
): CanvasCellLike {
  const pitchX = grid.columnWidth + grid.gap;
  const pitchY = grid.rowHeight + grid.gap;
  const span = clamp(Math.trunc(size.span), 1, grid.columns);
  const rows = clamp(Math.trunc(size.rows), 1, Math.max(1, grid.rows));
  const column = clamp(
    Math.round((point.x - grid.x) / pitchX) + 1,
    1,
    grid.columns - span + 1,
  );
  const row = clamp(
    Math.round((point.y - grid.y) / pitchY) + 1,
    1,
    Math.max(1, grid.rows - rows + 1),
  );
  return { column, row, span, rows };
}
