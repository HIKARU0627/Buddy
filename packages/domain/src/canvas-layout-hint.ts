// モデルが出す配置のヒントの意味の検査と、コードの配置者の束への当て方（UI-09、ADR 0200）。
// ヒントは配置の候補（どの物を目立たせるか・周辺に回すか・読む順・まとまり）だけで、承認・実行権限・処理状態・
// 表示してよい内容の正本にならない。形（JSON Schema の CanvasLayoutHint）の検査はこの前に Core が行う。
//
// - コードの値: 物ごとの強調・まとまりの正本はコードの配置者が決めた値（コードの値）。ヒントはその発言で当てる上乗せで、
//   次の発言（ヒントがあってもなくても）ではまずコードの値へ戻す update を束に足す。前のヒントの焦点は残らない。
// - 守る物: コードの値が焦点（high。重なる予定の確認など）の物と、呼び出し側が名前で渡す物（Core では文字の結果・
//   保留を捨てた知らせ）。守る物は、周辺へ回せず・読む順で後ろへ下げられず・まとまりに入れられない。ヒントが焦点を
//   足すときは、コードの焦点と合わせて 2 個まで。基準の画面の大きさのどれかで、守る物が入りきらなくなる・小さくなる
//   ヒントは捨てる。
// - 当てられなければ理由のコードを 1 つ返し、呼び出し側はコードの束（コードの値へ戻す update を足したもの）を当てる。
//   物を足す・閉じる・動かす・棚へ出し入れする・置き直す操作は作らないので、ユーザーの置き場所と棚は変わらない。
// - まとまりの名前はモデルの文字列を記述へ入れず、g1〜g4 に付け直す（モデルの名前はヒントの中の対応付けにだけ使う）。
// 純粋な関数で、DOM・Electron・Node 専用 API に依存しない。
import {
  CANVAS_OPS_LIMIT,
  CANVAS_VISIBLE_LIMIT,
  applyCanvasBatch,
  type CanvasDocumentLike,
  type CanvasItemChangesLike,
  type CanvasItemLike,
  type CanvasOpBatchLike,
  type CanvasOpLike,
} from './canvas.js';
import { layoutCanvas, type CanvasLayoutResult } from './canvas-layout.js';

// Schema の CanvasLayoutHint と同じ上限（一致は試験で確かめる）。
export const CANVAS_LAYOUT_HINT_FOCUS_LIMIT = 2;
export const CANVAS_LAYOUT_HINT_PERIPHERAL_LIMIT = 10;
export const CANVAS_LAYOUT_HINT_ORDER_LIMIT = CANVAS_VISIBLE_LIMIT;
export const CANVAS_LAYOUT_HINT_GROUP_LIMIT = 4;
export const CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MIN = 2;
export const CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MAX = 12;
// 1 つのヒントが強調・まとまりを変えてよい物の数。次の発言でコードの値へ戻す update（この数まで）とコードの配置者の
// 束の操作が、1 つの束の上限 12 に入るようにする。
export const CANVAS_LAYOUT_HINT_CHANGE_LIMIT = 10;
// 守る物が入りきらなくならないかを確かめる基準の画面の大きさ（CSS ピクセル）。実際の画面の大きさは Core が知らない。
export const CANVAS_LAYOUT_HINT_CHECK_VIEWPORTS: readonly {
  readonly width: number;
  readonly height: number;
}[] = [480, 600, 768, 1024, 1280, 1920].flatMap((width) =>
  [600, 800, 1080].map((height) => ({ width, height })),
);

export interface CanvasLayoutHintGroupLike {
  readonly group: string;
  readonly members: readonly string[];
}

export interface CanvasLayoutHintLike {
  readonly base_canvas_revision: string;
  readonly focus: readonly string[];
  readonly peripheral: readonly string[];
  readonly order: readonly string[];
  readonly groups: readonly CanvasLayoutHintGroupLike[];
}

// コードの配置者が決めた、物の強調とまとまり。
export interface CanvasCodeLayout {
  readonly emphasis: string;
  readonly group: string | null;
}

// ヒントを捨ててコードの配置に戻した理由（記録するのはこのコードだけ。ヒントの中身・物の名前・見出しを残さない）。
export type CanvasLayoutHintFallbackReason =
  // 形が契約（CanvasLayoutHint）に反する（Core が判定する）。
  | 'schema'
  // この発言にはコードの配置がない（Core が判定する）。
  | 'no_placement'
  // モデルが見た版が、置く時点の版と違う。
  | 'stale_revision'
  // 数の上限を超える（一覧の長さ・変える物の数・束の操作の数）。
  | 'limit_exceeded'
  // 同じ物を 2 回指す（同じ一覧の中、焦点と周辺の両方、2 つのまとまり）・まとまりの名前が重なる。
  | 'duplicate_item'
  // ない物を指す。
  | 'unknown_item'
  // 忘却・期限切れで消えた物を指す。
  | 'withdrawn_item'
  // 棚の物を指す（ユーザーが片付けた物を、ヒントで戻さない）。
  | 'shelved_item'
  // 読む順の候補が、見える物をちょうど 1 回ずつ含まない。
  | 'order_mismatch'
  // 守る物を周辺へ回す。
  | 'protected_demoted'
  // 守る物を読む順で後ろへ下げる（守る物より前に、コードの順では後ろの物を入れる）。
  | 'protected_moved'
  // 守る物をまとまりに入れる。
  | 'protected_grouped'
  // 基準の画面の大きさのどれかで、守る物が入りきらない・小さくなる。
  | 'protected_overflow'
  // 焦点がコードの焦点と合わせて 2 個を超える。
  | 'focus_limit'
  // ヒントを当てた束がキャンバスの検査に反した、または配置以外の項目が変わった（多重の防御）。
  | 'apply_rejected';

// コードの束の後の値（物の名前 → コードの値）。
export type CanvasCodeLayoutMap = ReadonlyMap<string, CanvasCodeLayout>;

export type CanvasCodeLayoutBatchResult =
  // コードの束そのものが今の記述に当たらない（ヒントの問題ではない）。
  | { readonly ok: false }
  | {
      readonly ok: true;
      // コードの束に、コードの値へ戻す update を足した束（入りきらなければコードの束のまま）。
      readonly batch: CanvasOpBatchLike;
      // 1 つの束に入りきらなかった、コードの値へ戻す update（呼び出し側が続く束で当てる）。
      readonly rest: readonly CanvasOpLike[];
      // 束の後の、物ごとのコードの値。
      readonly code: CanvasCodeLayoutMap;
    };

const sameLayout = (item: CanvasItemLike, code: CanvasCodeLayout) =>
  item.emphasis === code.emphasis && item.group === code.group;

// コードの束を確かめ、ヒントで変わった強調・まとまりをコードの値へ戻す update を足す。code は前の発言までのコードの値で、
// 持っていない物は今の値をコードの値とみなす。
export function canvasCodeLayoutBatch(
  canvas: CanvasDocumentLike,
  batch: CanvasOpBatchLike,
  code: CanvasCodeLayoutMap = new Map(),
): CanvasCodeLayoutBatchResult {
  if (batch.base_canvas_revision !== canvas.canvas_revision)
    return { ok: false };
  const applied = applyCanvasBatch(canvas, batch);
  if (!applied.ok) return { ok: false };
  const before = new Map(canvas.items.map((item) => [item.item_id, item]));
  const next = new Map<string, CanvasCodeLayout>();
  const resets = new Map<string, CanvasItemChangesLike>();
  for (const item of applied.canvas.items) {
    const op = batch.ops.find(
      (entry) =>
        (entry.op === 'add' && entry.item.item_id === item.item_id) ||
        (entry.op === 'update' && entry.item_id === item.item_id),
    );
    const previous = code.get(item.item_id) ?? before.get(item.item_id);
    const changes = op?.op === 'update' ? op.changes : undefined;
    // コードの束が足した物・強調やまとまりを決めた物は、その値がコードの値。
    const value: CanvasCodeLayout =
      op?.op === 'add'
        ? { emphasis: op.item.emphasis, group: op.item.group }
        : {
            emphasis: changes?.emphasis ?? previous?.emphasis ?? item.emphasis,
            group:
              changes !== undefined && 'group' in changes
                ? (changes.group ?? null)
                : previous === undefined
                  ? item.group
                  : previous.group,
          };
    next.set(item.item_id, value);
    if (!sameLayout(item, value))
      resets.set(item.item_id, {
        ...(item.emphasis === value.emphasis
          ? {}
          : { emphasis: value.emphasis }),
        ...(item.group === value.group ? {} : { group: value.group }),
      });
  }
  if (resets.size === 0) return { ok: true, batch, rest: [], code: next };
  const merged = mergeChanges(batch, resets);
  if (
    merged.ops.length <= CANVAS_OPS_LIMIT &&
    applyCanvasBatch(canvas, merged).ok
  )
    return { ok: true, batch: merged, rest: [], code: next };
  return {
    ok: true,
    batch,
    rest: [...resets].map(([itemId, changes]) => ({
      op: 'update' as const,
      item_id: itemId,
      changes,
    })),
    code: next,
  };
}

// 束の add・update に変更を重ね、ほかの物には変更だけの update を足す。
function mergeChanges(
  batch: CanvasOpBatchLike,
  changes: ReadonlyMap<string, CanvasItemChangesLike>,
  readingOrder: readonly string[] = batch.reading_order,
): CanvasOpBatchLike {
  const used = new Set<string>();
  const ops: CanvasOpLike[] = batch.ops.map((op) => {
    if (op.op === 'add') {
      const change = changes.get(op.item.item_id);
      if (change === undefined) return op;
      used.add(op.item.item_id);
      return { op: 'add', item: { ...op.item, ...change } };
    }
    if (op.op === 'update') {
      const change = changes.get(op.item_id);
      if (change === undefined) return op;
      used.add(op.item_id);
      return {
        op: 'update',
        item_id: op.item_id,
        changes: { ...op.changes, ...change },
      };
    }
    return op;
  });
  for (const [itemId, change] of changes)
    if (!used.has(itemId))
      ops.push({ op: 'update', item_id: itemId, changes: change });
  return {
    base_canvas_revision: batch.base_canvas_revision,
    canvas_revision: batch.canvas_revision,
    ops,
    reading_order: [...readingOrder],
  };
}

export type CanvasLayoutHintResult =
  | { readonly ok: true; readonly batch: CanvasOpBatchLike }
  | { readonly ok: false; readonly reason: CanvasLayoutHintFallbackReason };

export interface CanvasLayoutHintInput {
  // 今の記述（束を当てる前）。
  readonly canvas: CanvasDocumentLike;
  // コードの束（canvasCodeLayoutBatch の batch。コードの値へ戻す update を含み、当てた後の強調・まとまりはコードの値）。
  readonly batch: CanvasOpBatchLike;
  readonly hint: CanvasLayoutHintLike;
  // 守る物（コードの値が焦点の物に加えて、呼び出し側が名前で決める物）。
  readonly protected?: ReadonlySet<string>;
  // 忘却・期限切れで記述から消えた物の名前（今の記述にない物だけを見る）。
  readonly withdrawn?: ReadonlySet<string>;
}

const fail = (
  reason: CanvasLayoutHintFallbackReason,
): CanvasLayoutHintResult => ({ ok: false, reason });

const hasDuplicate = (values: readonly string[]): boolean =>
  new Set(values).size !== values.length;

// 配置の項目（強調・まとまり・読む順）以外が変わっていないか。物から強調とまとまりを除いた残りをまるごと比べ、
// ユーザーの置き場所も比べる。
export function canvasLayoutOnlyChange(
  before: CanvasDocumentLike,
  after: CanvasDocumentLike,
): boolean {
  const rest = (described: CanvasDocumentLike) =>
    described.items
      .map((item) =>
        canonical(
          Object.fromEntries(
            Object.entries(item).filter(
              ([key]) => key !== 'emphasis' && key !== 'group',
            ),
          ),
        ),
      )
      .sort();
  return (
    JSON.stringify(rest(before)) === JSON.stringify(rest(after)) &&
    canonical(before.user_pins ?? []) === canonical(after.user_pins ?? [])
  );
}

// 鍵の順に依らない JSON の文字列（入れ子の物も鍵を並べ替える）。
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

const layoutAt = (
  described: CanvasDocumentLike,
  viewport: { readonly width: number; readonly height: number },
): CanvasLayoutResult =>
  layoutCanvas({
    items: described.items,
    reading_order: described.reading_order,
    user_pins: described.user_pins ?? [],
    held: null,
    viewport,
  });

// 基準の画面の大きさのどれかで、守る物がコードの配置より入りきらない・小さくなるなら true。
function protectedShrinks(
  code: CanvasDocumentLike,
  hinted: CanvasDocumentLike,
  guarded: ReadonlySet<string>,
): boolean {
  for (const viewport of CANVAS_LAYOUT_HINT_CHECK_VIEWPORTS) {
    const before = layoutAt(code, viewport);
    const after = layoutAt(hinted, viewport);
    for (const itemId of guarded) {
      const was = before.boxes.find((box) => box.item_id === itemId);
      if (was === undefined) continue;
      const now = after.boxes.find((box) => box.item_id === itemId);
      if (now === undefined) return true;
      // 格子ではマスの数で比べる（列の位置でピクセルの丸めが 1 違うのを小さくなったとみなさない）。
      if (
        was.cell !== null && now.cell !== null
          ? now.cell.span < was.cell.span || now.cell.rows < was.cell.rows
          : now.rect.width < was.rect.width || now.rect.height < was.rect.height
      )
        return true;
    }
  }
  return false;
}

// ヒントを確かめ、当てられるならコードの束に強調・まとまり・読む順だけを足した束を返す。当てられなければ理由を
// 1 つ返す（確かめる順に最初に当たった理由）。
export function applyCanvasLayoutHint(
  input: CanvasLayoutHintInput,
): CanvasLayoutHintResult {
  const { canvas, batch, hint } = input;
  const withdrawn = input.withdrawn ?? new Set<string>();
  // 1. モデルが見た版と、置く時点の版。
  if (hint.base_canvas_revision !== canvas.canvas_revision)
    return fail('stale_revision');
  // 2. 数の上限（Schema と同じ。domain だけで使う呼び出し側のために重ねて確かめる）。
  if (
    hint.focus.length > CANVAS_LAYOUT_HINT_FOCUS_LIMIT ||
    hint.peripheral.length > CANVAS_LAYOUT_HINT_PERIPHERAL_LIMIT ||
    hint.order.length > CANVAS_LAYOUT_HINT_ORDER_LIMIT ||
    hint.groups.length > CANVAS_LAYOUT_HINT_GROUP_LIMIT ||
    hint.groups.some(
      (group) =>
        group.members.length < CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MIN ||
        group.members.length > CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MAX,
    )
  )
    return fail('limit_exceeded');
  // 3. 同じ物を 2 回指さない。
  const grouped = hint.groups.flatMap((group) => group.members);
  if (
    hasDuplicate(hint.focus) ||
    hasDuplicate(hint.peripheral) ||
    hasDuplicate(hint.order) ||
    hasDuplicate(grouped) ||
    hasDuplicate(hint.groups.map((group) => group.group)) ||
    hint.focus.some((id) => hint.peripheral.includes(id))
  )
    return fail('duplicate_item');
  // 4. コードの束を当てた後の記述（強調・まとまりはコードの値）。ヒントはこの記述の物だけを指せる。
  const coded = applyCanvasBatch(canvas, batch);
  if (!coded.ok) return fail('apply_rejected');
  const after = coded.canvas;
  const items = new Map(after.items.map((item) => [item.item_id, item]));
  // 5. 指す物が、今ある見える物か。
  for (const id of [
    ...hint.focus,
    ...hint.peripheral,
    ...hint.order,
    ...grouped,
  ]) {
    const item = items.get(id);
    if (item === undefined)
      return fail(withdrawn.has(id) ? 'withdrawn_item' : 'unknown_item');
    if (item.placement !== 'canvas') return fail('shelved_item');
  }
  // 6. 読む順の候補は、見える物をちょうど 1 回ずつ含む（空なら変えない）。
  if (
    hint.order.length > 0 &&
    (hint.order.length !== after.reading_order.length ||
      !after.reading_order.every((id) => hint.order.includes(id)))
  )
    return fail('order_mismatch');
  // 7. 守る物（見える物で、コードの値が焦点の物と、名前で渡された物）。
  const guarded = new Set(
    after.items
      .filter(
        (item) =>
          item.placement === 'canvas' &&
          (item.emphasis === 'high' ||
            (input.protected?.has(item.item_id) ?? false)),
      )
      .map((item) => item.item_id),
  );
  if (hint.peripheral.some((id) => guarded.has(id)))
    return fail('protected_demoted');
  if (grouped.some((id) => guarded.has(id))) return fail('protected_grouped');
  // 守る物より前に来る物は、コードの読む順でも前にあった物だけ（守る物を後ろへ下げない）。
  if (hint.order.length > 0)
    for (const id of guarded) {
      const was = new Set(
        after.reading_order.slice(0, after.reading_order.indexOf(id)),
      );
      if (hint.order.slice(0, hint.order.indexOf(id)).some((x) => !was.has(x)))
        return fail('protected_moved');
    }
  // 8. 焦点の数（コードの焦点とヒントで足す焦点を合わせて 2 個まで）。
  const focused = new Set([
    ...after.items
      .filter((item) => item.placement === 'canvas' && item.emphasis === 'high')
      .map((item) => item.item_id),
    ...hint.focus,
  ]);
  if (
    hint.focus.some((id) => items.get(id)?.emphasis !== 'high') &&
    focused.size > CANVAS_LAYOUT_HINT_FOCUS_LIMIT
  )
    return fail('focus_limit');
  // 9. 変える項目を物ごとに集める（今の値と同じなら変えない）。まとまりの名前は g1〜g4 に付け直す。
  const groupOf = new Map<string, string>();
  hint.groups.forEach((group, index) => {
    for (const id of group.members) groupOf.set(id, `g${index + 1}`);
  });
  const changes = new Map<string, CanvasItemChangesLike>();
  for (const item of after.items) {
    const emphasis = hint.focus.includes(item.item_id)
      ? 'high'
      : hint.peripheral.includes(item.item_id)
        ? 'low'
        : undefined;
    const group = groupOf.get(item.item_id);
    const change = {
      ...(emphasis !== undefined && emphasis !== item.emphasis
        ? { emphasis }
        : {}),
      ...(group !== undefined && group !== item.group ? { group } : {}),
    };
    if (Object.keys(change).length > 0) changes.set(item.item_id, change);
  }
  if (changes.size > CANVAS_LAYOUT_HINT_CHANGE_LIMIT)
    return fail('limit_exceeded');
  const hinted = mergeChanges(
    batch,
    changes,
    hint.order.length > 0 ? hint.order : batch.reading_order,
  );
  if (hinted.ops.length > CANVAS_OPS_LIMIT) return fail('limit_exceeded');
  // 10. 当てた後の記述を、キャンバスの検査と、配置以外が変わっていないことで確かめる（多重の防御）。
  const result = applyCanvasBatch(canvas, hinted);
  if (!result.ok || !canvasLayoutOnlyChange(after, result.canvas))
    return fail('apply_rejected');
  // 11. 基準の画面の大きさで、守る物がコードの配置より入りきらない・小さくならない。
  if (guarded.size > 0 && protectedShrinks(after, result.canvas, guarded))
    return fail('protected_overflow');
  return { ok: true, batch: hinted };
}

// 1 つの発言の束の決め方（Core と画面の試験が同じ道筋を使う）。コードの束を確かめてコードの値へ戻し、ヒントがあれば
// 当てる。hint は形の検査を通ったものだけ（null はヒントなし）。
export type CanvasTurnLayoutDecision =
  | { readonly ok: false }
  | {
      readonly ok: true;
      readonly batch: CanvasOpBatchLike;
      readonly rest: readonly CanvasOpLike[];
      readonly code: CanvasCodeLayoutMap;
      // ヒントなし（none）・使った（applied）・捨てた理由。
      readonly hint: 'none' | 'applied' | CanvasLayoutHintFallbackReason;
    };

export function decideCanvasTurnLayout(input: {
  readonly canvas: CanvasDocumentLike;
  readonly batch: CanvasOpBatchLike;
  readonly hint: CanvasLayoutHintLike | null;
  readonly code?: CanvasCodeLayoutMap;
  readonly protected?: ReadonlySet<string>;
  readonly withdrawn?: ReadonlySet<string>;
}): CanvasTurnLayoutDecision {
  const coded = canvasCodeLayoutBatch(input.canvas, input.batch, input.code);
  if (!coded.ok) return { ok: false };
  if (input.hint === null) return { ...coded, hint: 'none' };
  // コードの値へ戻す update が 1 つの束に入りきらないときは、ヒントを当てる余地がない。
  if (coded.rest.length > 0) return { ...coded, hint: 'limit_exceeded' };
  const hinted = applyCanvasLayoutHint({
    canvas: input.canvas,
    batch: coded.batch,
    hint: input.hint,
    ...(input.protected === undefined ? {} : { protected: input.protected }),
    ...(input.withdrawn === undefined ? {} : { withdrawn: input.withdrawn }),
  });
  return hinted.ok
    ? { ...coded, batch: hinted.batch, hint: 'applied' }
    : { ...coded, hint: hinted.reason };
}
