// モデルが出す配置のヒントの意味の検査と、コードの配置者の束への当て方（UI-09、ADR 0200）。
// ヒントは配置の候補（どの物を目立たせるか・周辺に回すか・読む順・まとまり）だけで、承認・実行権限・処理状態・
// 表示してよい内容の正本にならない。形（JSON Schema の CanvasLayoutHint）の検査はこの前に Core が行う。
// ここでは、今のキャンバスとコードの配置者の束を見て、ヒントが指す物・数・矛盾を確かめ、当てられるならコードの束に
// 強調・まとまりの update と読む順だけを足した束を返す。当てられなければ理由のコードを 1 つだけ返し、呼び出し側は
// コードの束をそのまま当てる（コードの配置に戻す）。物を足す・閉じる・動かす・棚へ出し入れする・置き直す操作は作らない
// ので、ユーザーの置き場所（user_pins）と棚は変わらない（ADR 0032 の「AI が優先」で消えるのは move・close・relayout・
// 棚へ移すときだけ）。純粋な関数で、DOM・Electron・Node 専用 API に依存しない。
import {
  CANVAS_OPS_LIMIT,
  CANVAS_VISIBLE_LIMIT,
  applyCanvasBatch,
  type CanvasDocumentLike,
  type CanvasItemLike,
  type CanvasOpBatchLike,
  type CanvasOpLike,
} from './canvas.js';

// Schema の CanvasLayoutHint と同じ上限（一致は試験で確かめる）。
export const CANVAS_LAYOUT_HINT_FOCUS_LIMIT = 2;
export const CANVAS_LAYOUT_HINT_PERIPHERAL_LIMIT = 12;
export const CANVAS_LAYOUT_HINT_ORDER_LIMIT = CANVAS_VISIBLE_LIMIT;
export const CANVAS_LAYOUT_HINT_GROUP_LIMIT = 4;
export const CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MIN = 2;
export const CANVAS_LAYOUT_HINT_GROUP_MEMBERS_MAX = 12;

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

// ヒントを捨ててコードの配置に戻した理由（記録するのはこのコードだけ。ヒントの中身・物の名前・見出しを残さない）。
export type CanvasLayoutHintFallbackReason =
  // 形が契約（CanvasLayoutHint）に反する（Core が判定する）。
  | 'schema'
  // この発言にはコードの配置がない（ヒントだけで記述を変えない。Core が判定する）。
  | 'no_placement'
  // モデルが見た版が、置く時点の版と違う。
  | 'stale_revision'
  // 数の上限を超える（ヒントの一覧の長さ・束の操作の数）。
  | 'limit_exceeded'
  // 同じ物を 2 回指す（同じ一覧の中、焦点と周辺の両方、2 つのまとまり）。
  | 'duplicate_item'
  // ない物を指す。
  | 'unknown_item'
  // 忘却・期限切れ・記録しない区切りの終わりで消えた物を指す。
  | 'withdrawn_item'
  // 棚の物を指す（ユーザーが片付けた物を、ヒントで戻さない）。
  | 'shelved_item'
  // 読む順の候補が、見える物をちょうど 1 回ずつ含まない。
  | 'order_mismatch'
  // コードの配置が焦点（high）にした物を周辺に回そうとした（重なりの確認などを目立たなくさせない）。
  | 'code_focus_demoted'
  // ヒントを当てた束がキャンバスの検査に反した、または配置以外の項目が変わった（多重の防御）。
  | 'apply_rejected';

export type CanvasLayoutHintResult =
  | { readonly ok: true; readonly batch: CanvasOpBatchLike }
  | { readonly ok: false; readonly reason: CanvasLayoutHintFallbackReason };

export interface CanvasLayoutHintInput {
  // 今の記述（コードの束を当てる前）。
  readonly canvas: CanvasDocumentLike;
  // コードの配置者の束（ヒントがなければ、これをそのまま当てる）。
  readonly batch: CanvasOpBatchLike;
  readonly hint: CanvasLayoutHintLike;
  // 忘却・期限切れ・記録しない区切りの終わりで記述から消えた物の名前（今の記述にない物だけを見る）。
  readonly withdrawn?: ReadonlySet<string>;
}

const fail = (
  reason: CanvasLayoutHintFallbackReason,
): CanvasLayoutHintResult => ({ ok: false, reason });

const hasDuplicate = (values: readonly string[]): boolean =>
  new Set(values).size !== values.length;

// 配置の項目（強調・まとまり・読む順）以外が変わっていないか。物の集合・種類・部品・見出し・関係・格子のヒント・
// 置き場所（canvas・shelf）・データの参照・ユーザーの置き場所が同じなら true。
export function canvasLayoutOnlyChange(
  before: CanvasDocumentLike,
  after: CanvasDocumentLike,
): boolean {
  if (before.items.length !== after.items.length) return false;
  const byId = new Map(after.items.map((item) => [item.item_id, item]));
  const fixed = (item: CanvasItemLike) =>
    JSON.stringify([
      item.kind,
      item.component,
      item.heading,
      item.relations,
      item.grid,
      item.placement,
      item.data,
    ]);
  for (const item of before.items) {
    const other = byId.get(item.item_id);
    if (other === undefined || fixed(other) !== fixed(item)) return false;
  }
  return (
    JSON.stringify(before.user_pins ?? []) ===
    JSON.stringify(after.user_pins ?? [])
  );
}

// ヒントを確かめ、当てられるならコードの束に強調・まとまり・読む順だけを足した束を返す。当てられなければ理由を
// 1 つ返す（確かめる順に最初に当たった理由）。
export function applyCanvasLayoutHint(
  input: CanvasLayoutHintInput,
): CanvasLayoutHintResult {
  const { canvas, batch, hint } = input;
  const withdrawn = input.withdrawn ?? new Set<string>();
  // 1. モデルが見た版と、置く時点の版（コードの束の元の版）。
  if (
    hint.base_canvas_revision !== canvas.canvas_revision ||
    batch.base_canvas_revision !== canvas.canvas_revision
  )
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
  // 4. コードの束を当てた後の記述（ヒントはこの記述の物だけを指せる）。コードの束そのものが当たらないなら、
  // ヒントも当てない（呼び出し側がコードの束を当てようとして、同じ検査で前の版が残る）。
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
  // 7. コードの配置が焦点にした物を、周辺に回さない。
  if (hint.peripheral.some((id) => items.get(id)?.emphasis === 'high'))
    return fail('code_focus_demoted');
  // 8. 変える項目を物ごとに集める（今の値と同じなら変えない）。
  const groupOf = new Map<string, string>();
  for (const group of hint.groups)
    for (const id of group.members) groupOf.set(id, group.group);
  const changes = new Map<string, { emphasis?: string; group?: string }>();
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
  // 9. コードの束の add・update に重ね、ほかの物には強調・まとまりだけの update を足す。
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
  if (ops.length > CANVAS_OPS_LIMIT) return fail('limit_exceeded');
  const hinted: CanvasOpBatchLike = {
    base_canvas_revision: batch.base_canvas_revision,
    canvas_revision: batch.canvas_revision,
    ops,
    reading_order:
      hint.order.length > 0 ? [...hint.order] : [...batch.reading_order],
  };
  // 10. 当てた後の記述を、キャンバスの検査と、配置以外が変わっていないことで確かめる（多重の防御）。
  const result = applyCanvasBatch(canvas, hinted);
  if (!result.ok || !canvasLayoutOnlyChange(after, result.canvas))
    return fail('apply_rejected');
  return { ok: true, batch: hinted };
}
