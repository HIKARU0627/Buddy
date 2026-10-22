// キャンバスの記述（CanvasDocument・CanvasOpBatch）と流れの区切り（StreamSegment）の意味の検査（ADR 0032）。
// 形式（JSON Schema）の検査はこの前に別に行う。ここは Schema では表せない規則だけを、純粋な関数で決める:
// 読む順が見える物をちょうど 1 回ずつ含むこと・参照の件数・1 回の変更の数・text の数・格子のはみ出し・版の連続。
// domain は contracts の型を import しないので、必要な形だけを構造で受ける。

export const CANVAS_VISIBLE_LIMIT = 24;
export const CANVAS_ITEM_LIMIT = 48;
export const CANVAS_OPS_LIMIT = 12;
export const CANVAS_TEXT_PER_ANSWER = 1;
export const CANVAS_REFS_LIMIT = 50;
export const CANVAS_GRID_COLUMNS = 12;
export const CANVAS_HEADING_LIMIT = 24;

export type CanvasSemanticError =
  | 'item_limit'
  | 'visible_limit'
  | 'duplicate_item_id'
  | 'heading_blank'
  | 'heading_invalid'
  | 'grid_overflow'
  | 'refs_limit'
  | 'more_count_without_full_refs'
  | 'relation_self'
  | 'relation_unknown_target'
  | 'reading_order_missing'
  | 'reading_order_duplicate'
  | 'reading_order_unknown'
  | 'ops_limit'
  | 'text_limit'
  | 'op_target_duplicate'
  | 'relayout_duplicate'
  | 'revision_not_next'
  | 'base_revision_mismatch'
  | 'item_exists'
  | 'item_not_found';

export interface CanvasGridLike {
  readonly column: number;
  readonly span: number;
  readonly rows: number;
}

export interface CanvasDataLike {
  readonly item_refs: readonly { readonly kind: string; readonly id: string }[];
  readonly more_count: number;
}

export interface CanvasRelationLike {
  readonly kind: string;
  readonly target: string;
}

export interface CanvasItemLike {
  readonly item_id: string;
  readonly kind: string;
  readonly component: string;
  readonly heading: string;
  readonly emphasis: string;
  readonly group: string | null;
  readonly relations: readonly CanvasRelationLike[];
  readonly grid: CanvasGridLike;
  readonly placement: 'canvas' | 'shelf';
  readonly data: CanvasDataLike;
}

export interface CanvasDocumentLike {
  readonly canvas_revision: string;
  readonly items: readonly CanvasItemLike[];
  readonly reading_order: readonly string[];
}

export interface CanvasItemChangesLike {
  readonly heading?: string;
  readonly emphasis?: string;
  readonly group?: string | null;
  readonly relations?: readonly CanvasRelationLike[];
  readonly data?: CanvasDataLike;
}

export type CanvasOpLike =
  | { readonly op: 'add'; readonly item: CanvasItemLike }
  | {
      readonly op: 'update';
      readonly item_id: string;
      readonly changes: CanvasItemChangesLike;
    }
  | {
      readonly op: 'move';
      readonly item_id: string;
      readonly grid?: CanvasGridLike;
      readonly placement?: 'canvas' | 'shelf';
    }
  | { readonly op: 'close'; readonly item_id: string }
  | { readonly op: 'relayout' };

export interface CanvasOpBatchLike {
  readonly base_canvas_revision: string;
  readonly canvas_revision: string;
  readonly ops: readonly CanvasOpLike[];
  readonly reading_order: readonly string[];
}

// 制御文字・改行・双方向の上書き・埋め込み・分離・方向の印（Schema の CanvasHeading と同じ集合）。
// 制御文字を拒否するための正規表現なので、no-control-regex をこの行だけ外す。
/* eslint-disable no-control-regex */
const FORBIDDEN_HEADING =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/u;
/* eslint-enable no-control-regex */

const sorted = (errors: Set<CanvasSemanticError>): CanvasSemanticError[] =>
  [...errors].sort();

function headingErrors(heading: string, errors: Set<CanvasSemanticError>) {
  // 長さはコードポイントで数える（Schema の maxLength と同じ）。
  if (
    [...heading].length > CANVAS_HEADING_LIMIT ||
    FORBIDDEN_HEADING.test(heading)
  )
    errors.add('heading_invalid');
  if (heading.trim() === '') errors.add('heading_blank');
}

function gridErrors(grid: CanvasGridLike, errors: Set<CanvasSemanticError>) {
  if (grid.column + grid.span - 1 > CANVAS_GRID_COLUMNS)
    errors.add('grid_overflow');
}

function dataErrors(data: CanvasDataLike, errors: Set<CanvasSemanticError>) {
  if (data.item_refs.length > CANVAS_REFS_LIMIT) errors.add('refs_limit');
  // 残りの件数は、参照を上限まで並べたときだけ持つ（ResultView の 50 件上限と more_count と同じ考え）。
  if (data.more_count > 0 && data.item_refs.length < CANVAS_REFS_LIMIT)
    errors.add('more_count_without_full_refs');
}

function relationErrors(
  itemId: string,
  relations: readonly CanvasRelationLike[],
  errors: Set<CanvasSemanticError>,
) {
  if (relations.some((relation) => relation.target === itemId))
    errors.add('relation_self');
}

function itemErrors(item: CanvasItemLike, errors: Set<CanvasSemanticError>) {
  headingErrors(item.heading, errors);
  gridErrors(item.grid, errors);
  dataErrors(item.data, errors);
  relationErrors(item.item_id, item.relations, errors);
}

// 今のキャンバスの記述の意味の検査。誤りの理由を辞書順で返す（なければ空）。
export function canvasDocumentErrors(
  canvas: CanvasDocumentLike,
): CanvasSemanticError[] {
  const errors = new Set<CanvasSemanticError>();
  if (canvas.items.length > CANVAS_ITEM_LIMIT) errors.add('item_limit');
  const ids = new Set<string>();
  for (const item of canvas.items) {
    if (ids.has(item.item_id)) errors.add('duplicate_item_id');
    ids.add(item.item_id);
    itemErrors(item, errors);
  }
  for (const item of canvas.items)
    if (item.relations.some((relation) => !ids.has(relation.target)))
      errors.add('relation_unknown_target');
  const visible = new Set(
    canvas.items
      .filter((item) => item.placement === 'canvas')
      .map((item) => item.item_id),
  );
  if (visible.size > CANVAS_VISIBLE_LIMIT) errors.add('visible_limit');
  const seen = new Set<string>();
  for (const id of canvas.reading_order) {
    if (seen.has(id)) errors.add('reading_order_duplicate');
    seen.add(id);
    // 棚の物と、ない物は読む順に入れない。
    if (!visible.has(id)) errors.add('reading_order_unknown');
  }
  for (const id of visible)
    if (!seen.has(id)) errors.add('reading_order_missing');
  return sorted(errors);
}

const targetOf = (op: CanvasOpLike): string | null =>
  op.op === 'add' ? op.item.item_id : op.op === 'relayout' ? null : op.item_id;

// 1 回の答えの変更の束だけで決まる意味の検査（今のキャンバスに依らない）。
export function canvasBatchErrors(
  batch: CanvasOpBatchLike,
): CanvasSemanticError[] {
  const errors = new Set<CanvasSemanticError>();
  if (batch.ops.length > CANVAS_OPS_LIMIT) errors.add('ops_limit');
  if (
    !/^(0|[1-9][0-9]*)$/u.test(batch.base_canvas_revision) ||
    !/^(0|[1-9][0-9]*)$/u.test(batch.canvas_revision) ||
    BigInt(batch.canvas_revision) !== BigInt(batch.base_canvas_revision) + 1n
  )
    errors.add('revision_not_next');
  let texts = 0;
  let relayouts = 0;
  const targets = new Set<string>();
  for (const op of batch.ops) {
    const target = targetOf(op);
    if (target !== null) {
      if (targets.has(target)) errors.add('op_target_duplicate');
      targets.add(target);
    }
    if (op.op === 'add') {
      if (op.item.component === 'text') texts += 1;
      itemErrors(op.item, errors);
    } else if (op.op === 'update') {
      if (op.changes.heading !== undefined)
        headingErrors(op.changes.heading, errors);
      if (op.changes.data !== undefined) dataErrors(op.changes.data, errors);
      if (op.changes.relations !== undefined)
        relationErrors(op.item_id, op.changes.relations, errors);
    } else if (op.op === 'move') {
      if (op.grid !== undefined) gridErrors(op.grid, errors);
    } else if (op.op === 'relayout') relayouts += 1;
  }
  if (texts > CANVAS_TEXT_PER_ANSWER) errors.add('text_limit');
  if (relayouts > 1) errors.add('relayout_duplicate');
  if (new Set(batch.reading_order).size !== batch.reading_order.length)
    errors.add('reading_order_duplicate');
  return sorted(errors);
}

export type CanvasApplyResult =
  | { readonly ok: true; readonly canvas: CanvasDocumentLike }
  | { readonly ok: false; readonly errors: readonly CanvasSemanticError[] };

// 今のキャンバスへ変更の束を当てた結果。束の検査・版の一致・対象の有無を確かめ、当てた後の記述を
// canvasDocumentErrors で検査する（読む順の欠け・見える数の上限・関係の先がない、など）。
// どれかに反すれば何も当てない（一部だけ当てない）。
export function applyCanvasBatch(
  canvas: CanvasDocumentLike,
  batch: CanvasOpBatchLike,
): CanvasApplyResult {
  const errors = new Set<CanvasSemanticError>(canvasBatchErrors(batch));
  if (batch.base_canvas_revision !== canvas.canvas_revision)
    errors.add('base_revision_mismatch');
  const items = new Map(canvas.items.map((item) => [item.item_id, item]));
  for (const op of batch.ops) {
    if (op.op === 'relayout') continue;
    if (op.op === 'add') {
      if (items.has(op.item.item_id)) errors.add('item_exists');
      else items.set(op.item.item_id, op.item);
      continue;
    }
    const current = items.get(op.item_id);
    if (current === undefined) {
      errors.add('item_not_found');
      continue;
    }
    if (op.op === 'close') items.delete(op.item_id);
    else if (op.op === 'update')
      items.set(op.item_id, { ...current, ...op.changes });
    else
      items.set(op.item_id, {
        ...current,
        ...(op.grid === undefined ? {} : { grid: op.grid }),
        ...(op.placement === undefined ? {} : { placement: op.placement }),
      });
  }
  if (errors.size > 0) return { ok: false, errors: sorted(errors) };
  const next: CanvasDocumentLike = {
    canvas_revision: batch.canvas_revision,
    items: [...items.values()],
    reading_order: batch.reading_order,
  };
  const after = canvasDocumentErrors(next);
  return after.length > 0
    ? { ok: false, errors: after }
    : { ok: true, canvas: next };
}

// 流れの区切り（StreamSegment）の意味の検査（ADR 0032）。
export type StreamSegmentError =
  | 'private_carries_summary'
  | 'summary_carried_across_boundary'
  | 'storage_mode_mismatch';

export interface StreamSegmentLike {
  readonly storage_mode: 'normal' | 'extended' | 'private';
  readonly open_reason: string;
  readonly carried_summary_from: string | null;
}

// 前の区切りの要約をつながない始まり方。流れの最初・忘却の指示・記録しない会話の出入り。
// 記録しない会話の要約は作らないので、出た後にも持ち込まない（ADR 0032）。
const NO_CARRY_REASONS = [
  'stream_started',
  'forget_requested',
  'private_started',
  'private_ended',
];

export function streamSegmentErrors(
  segment: StreamSegmentLike,
): StreamSegmentError[] {
  const errors: StreamSegmentError[] = [];
  if (
    segment.storage_mode === 'private' &&
    segment.carried_summary_from !== null
  )
    errors.push('private_carries_summary');
  if (
    NO_CARRY_REASONS.includes(segment.open_reason) &&
    segment.carried_summary_from !== null
  )
    errors.push('summary_carried_across_boundary');
  if (
    (segment.open_reason === 'private_started') !==
      (segment.storage_mode === 'private') &&
    (segment.open_reason === 'private_started' ||
      segment.open_reason === 'private_ended' ||
      segment.open_reason === 'storage_mode_changed')
  )
    errors.push('storage_mode_mismatch');
  return errors.sort();
}
