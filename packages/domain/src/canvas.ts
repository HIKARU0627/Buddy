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
  | 'heading_markup'
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
  | 'item_not_found'
  // UI-06: ユーザーの置き場所（user_pins）が、見える物でない・同じ物に 2 つある。
  | 'pin_unknown_item'
  | 'pin_duplicate';

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

// 格子のマス（UI-06）。列・行は 1 から。ユーザーの置き場所と配置のエンジンの出力に使う。ピクセルではない。
export interface CanvasCellLike {
  readonly column: number;
  readonly row: number;
  readonly span: number;
  readonly rows: number;
}

// ユーザーが動かした・大きさを変えた物の置き場所（UI-06、ADR 0032）。AI の束がその物を動かす・閉じる・置き直す・
// 棚へ移すと消える（AI が優先）。
export interface CanvasUserPinLike {
  readonly item_id: string;
  readonly cell: CanvasCellLike;
}

export interface CanvasDocumentLike {
  readonly canvas_revision: string;
  readonly items: readonly CanvasItemLike[];
  readonly reading_order: readonly string[];
  // UI-06: ユーザーの置き場所。省略は空と同じ（UI-05 までの記述との互換）。
  readonly user_pins?: readonly CanvasUserPinLike[];
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

// マークアップ・URL らしい見出し（ADR 0032）。Schema の CanvasHeading の not.anyOf と同じパターンの文字列を
// 同じ u フラグで使い、判定をそろえる（一致は試験で確かめる）。大文字・小文字は /i を使わず ASCII の文字集合で
// 明示する（/iu は ſ・K などの Unicode の大文字・小文字の対応まで含めるため）。描画はプレーンテキストだけだが、
// 見出しに HTML・スクリプト・リンクを紛れ込ませない。「A<B の比較」「A < B」「3/5 の予定」は通す。
const ci = (word: string): string =>
  [...word].map((c) => `[${c.toUpperCase()}${c}]`).join('');
const TAG_NAME = '[A-Za-z][A-Za-z0-9:-]*';
const URL_SCHEMES = [
  `${ci('http')}[Ss]?`,
  ci('javascript'),
  ci('vbscript'),
  ci('data'),
  ci('file'),
  ci('ftp'),
  ci('blob'),
  ci('mailto'),
].join('|');
export const CANVAS_HEADING_MARKUP_PATTERNS: readonly string[] = [
  // 閉じたタグ（属性は任意）。名前の直後の / も区切りとして扱う（<br/>・<img/src=x> も HTML ではタグになる）。
  String.raw`<${TAG_NAME}([\s/][^<>]*)?>`,
  // 終わりのタグ。
  String.raw`</${TAG_NAME}\s*>`,
  // コメント・宣言・処理命令。
  '<[!?]',
  // 属性の形（> がなくても拒否）。名前と属性の区切りは空白か /。
  String.raw`<${TAG_NAME}[\s/]+[A-Za-z_:][A-Za-z0-9_.:-]*\s*=`,
  // URL のスキーム。直前が ASCII の英数字でない（または先頭）。
  String.raw`(^|[^A-Za-z0-9])(${URL_SCHEMES})\s*:`,
  // www. で始まる表現。
  String.raw`(^|[^A-Za-z0-9])${ci('www')}\.`,
];
const HEADING_MARKUP: readonly RegExp[] = CANVAS_HEADING_MARKUP_PATTERNS.map(
  (pattern) => new RegExp(pattern, 'u'),
);

const sorted = (errors: Set<CanvasSemanticError>): CanvasSemanticError[] =>
  [...errors].sort();

function headingErrors(heading: string, errors: Set<CanvasSemanticError>) {
  // 長さはコードポイントで数える（Schema の maxLength と同じ）。
  if (
    [...heading].length > CANVAS_HEADING_LIMIT ||
    FORBIDDEN_HEADING.test(heading)
  )
    errors.add('heading_invalid');
  if (HEADING_MARKUP.some((pattern) => pattern.test(heading)))
    errors.add('heading_markup');
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
  const pinned = new Set<string>();
  for (const pin of canvas.user_pins ?? []) {
    if (pinned.has(pin.item_id)) errors.add('pin_duplicate');
    pinned.add(pin.item_id);
    // ユーザーの置き場所は見える物だけが持つ（棚の物・ない物は持たない）。
    if (!visible.has(pin.item_id)) errors.add('pin_unknown_item');
    if (pin.cell.column + pin.cell.span - 1 > CANVAS_GRID_COLUMNS)
      errors.add('grid_overflow');
  }
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
  // text は 1 回の答えにつき 1 つまで。足す text に加え、中身（見出し・データ）を変える既存の text も数える
  // （既存の text の更新で上限を回避させない）。強調・まとまり・関係だけの更新は中身を変えないので数えない。
  let texts = 0;
  for (const op of batch.ops)
    if (op.op === 'add' && op.item.component === 'text') texts += 1;
    else if (
      op.op === 'update' &&
      items.get(op.item_id)?.component === 'text' &&
      (op.changes.heading !== undefined || op.changes.data !== undefined)
    )
      texts += 1;
  if (texts > CANVAS_TEXT_PER_ANSWER) errors.add('text_limit');
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
  const pins = pinsAfterBatch(canvas, batch, items);
  const next: CanvasDocumentLike = {
    canvas_revision: batch.canvas_revision,
    items: [...items.values()],
    reading_order: batch.reading_order,
    // ユーザーの置き場所の項目は、前の記述が持っていたときだけ持つ（UI-05 までの記述の形を変えない）。
    ...(canvas.user_pins === undefined ? {} : { user_pins: pins }),
  };
  const after = canvasDocumentErrors(next);
  return after.length > 0
    ? { ok: false, errors: after }
    : { ok: true, canvas: next };
}

// AI の束を当てた後に残すユーザーの置き場所（UI-06、ADR 0032。AI が優先）。束がその物を動かす（move）・閉じる・
// 置き直す（relayout。すべて）・棚へ移すと消す。中身だけの update では消さない。
function pinsAfterBatch(
  canvas: CanvasDocumentLike,
  batch: CanvasOpBatchLike,
  items: ReadonlyMap<string, CanvasItemLike>,
): CanvasUserPinLike[] {
  if (batch.ops.some((op) => op.op === 'relayout')) return [];
  const moved = new Set(
    batch.ops.flatMap((op) =>
      op.op === 'move' || op.op === 'close' ? [op.item_id] : [],
    ),
  );
  return (canvas.user_pins ?? []).filter(
    (pin) =>
      !moved.has(pin.item_id) && items.get(pin.item_id)?.placement === 'canvas',
  );
}

// 束で置き場所・存在が変わる物（UI-06）。Core はこれで物ごとの「置き場所が最後に変わった版」を進め、古い版への
// ユーザーの操作を当ててよいかを決める。relayout はすべての物（null）。中身だけの update は含めない。
export function canvasBatchPlacementTargets(
  batch: CanvasOpBatchLike,
): readonly string[] | null {
  if (batch.ops.some((op) => op.op === 'relayout')) return null;
  return batch.ops.flatMap((op) =>
    op.op === 'add'
      ? [op.item.item_id]
      : op.op === 'move' || op.op === 'close'
        ? [op.item_id]
        : [],
  );
}

// ユーザーの操作（UI-06、ADR 0032）。move・resize は置く先のマス（エンジンの格子のマス）、close は閉じる、
// shelve は棚へ片付ける、unshelve は棚から出す。
export type CanvasUserOpLike =
  | {
      readonly kind: 'move' | 'resize';
      readonly item_id: string;
      readonly cell: CanvasCellLike;
    }
  | {
      readonly kind: 'close' | 'shelve' | 'unshelve';
      readonly item_id: string;
    };

export type CanvasUserOpRejection =
  // 古い版への操作で、その物の置き場所・存在が後から変わった。物がない。今より新しい版。
  | 'stale'
  // 今の記述には当てられない（見える数の上限・棚の物を動かす・マスのはみ出し）。
  | 'not_applicable';

export type CanvasUserOpResult =
  | { readonly ok: true; readonly canvas: CanvasDocumentLike }
  | { readonly ok: false; readonly reason: CanvasUserOpRejection };

const revisionOf = (value: string): bigint | null =>
  /^(0|[1-9][0-9]*)$/u.test(value) ? BigInt(value) : null;

// ユーザーの操作を今の記述に当てる（UI-06、ADR 0032）。版の照合: 添えた版（画面が描いている版）が今と同じなら当てる。
// 古い版でも、その物の置き場所・存在が添えた版より後に変わっていなければ当てる（placedAt はその物の置き場所が
// 最後に変わった版。Core が持つ）。今より新しい版・物がない・後から変わった物は stale。当てたら版を 1 進める。
export function applyCanvasUserOp(input: {
  readonly canvas: CanvasDocumentLike;
  readonly op: CanvasUserOpLike;
  readonly expected_revision: string;
  readonly placed_at: string | null;
}): CanvasUserOpResult {
  const { canvas, op } = input;
  const current = revisionOf(canvas.canvas_revision);
  const expected = revisionOf(input.expected_revision);
  if (current === null || expected === null || expected > current)
    return { ok: false, reason: 'stale' };
  const item = canvas.items.find((entry) => entry.item_id === op.item_id);
  if (item === undefined) return { ok: false, reason: 'stale' };
  const placedAt =
    input.placed_at === null ? null : revisionOf(input.placed_at);
  if (expected < current && (placedAt === null || placedAt > expected))
    return { ok: false, reason: 'stale' };
  const pins = (canvas.user_pins ?? []).filter(
    (pin) => pin.item_id !== op.item_id,
  );
  let items = canvas.items;
  let order = canvas.reading_order;
  switch (op.kind) {
    case 'move':
    case 'resize':
      if (item.placement !== 'canvas')
        return { ok: false, reason: 'not_applicable' };
      if (op.cell.column + op.cell.span - 1 > CANVAS_GRID_COLUMNS)
        return { ok: false, reason: 'not_applicable' };
      pins.push({ item_id: op.item_id, cell: { ...op.cell } });
      break;
    case 'close':
      // 閉じた物への関係（compare・sequence・detail_of）も同じ操作で取り除く（参照先のない関係を残さない）。
      items = items
        .filter((entry) => entry.item_id !== op.item_id)
        .map((entry) =>
          entry.relations.some((relation) => relation.target === op.item_id)
            ? {
                ...entry,
                relations: entry.relations.filter(
                  (relation) => relation.target !== op.item_id,
                ),
              }
            : entry,
        );
      order = order.filter((id) => id !== op.item_id);
      break;
    case 'shelve':
      if (item.placement !== 'canvas')
        return { ok: false, reason: 'not_applicable' };
      items = items.map((entry) =>
        entry.item_id === op.item_id
          ? { ...entry, placement: 'shelf' as const }
          : entry,
      );
      order = order.filter((id) => id !== op.item_id);
      break;
    case 'unshelve':
      if (item.placement !== 'shelf')
        return { ok: false, reason: 'not_applicable' };
      items = items.map((entry) =>
        entry.item_id === op.item_id
          ? { ...entry, placement: 'canvas' as const }
          : entry,
      );
      order = [...order, op.item_id];
      break;
  }
  const next: CanvasDocumentLike = {
    canvas_revision: (current + 1n).toString(),
    items,
    reading_order: order,
    user_pins: pins,
  };
  return canvasDocumentErrors(next).length > 0
    ? { ok: false, reason: 'not_applicable' }
    : { ok: true, canvas: next };
}

// 記録しない区切りの間のキャンバス（ADR 0032）。persisted は保存してよい記述（DB・スナップショット・
// イベントの記録に書くのはこれだけ）、ephemeral は記録しない区切りの間だけ RAM に持つ一時の記述。
// 記録しない間の変更は、既存の物の update・move・close を含めてすべて ephemeral に当て、区切りが終わったら
// ephemeral を捨てて persisted に戻す。
export interface CanvasStore {
  readonly persisted: CanvasDocumentLike;
  readonly ephemeral: CanvasDocumentLike | null;
}

export type CanvasStoreResult =
  | { readonly ok: true; readonly store: CanvasStore }
  | { readonly ok: false; readonly errors: readonly CanvasSemanticError[] };

// 記録しない区切りに入る。既に入っていれば何も変えない。
export function beginPrivateCanvas(store: CanvasStore): CanvasStore {
  return store.ephemeral !== null
    ? store
    : { persisted: store.persisted, ephemeral: store.persisted };
}

// 今描くべき記述。記録しない間は一時の記述。
export function canvasForDisplay(store: CanvasStore): CanvasDocumentLike {
  return store.ephemeral ?? store.persisted;
}

// 変更の束を当てる。記録しない間は一時の記述にだけ当て、保存してよい記述は変えない。
export function applyCanvasBatchToStore(
  store: CanvasStore,
  batch: CanvasOpBatchLike,
): CanvasStoreResult {
  const result = applyCanvasBatch(canvasForDisplay(store), batch);
  if (!result.ok) return result;
  return {
    ok: true,
    store:
      store.ephemeral === null
        ? { persisted: result.canvas, ephemeral: null }
        : { persisted: store.persisted, ephemeral: result.canvas },
  };
}

// 記録しない区切りを終える。一時の記述を捨て、記録しない前の記述に戻す。端末が新しい記述として受け取れるよう、
// 版は一時の記述の版より 1 進める（版を巻き戻さない）。記録しない区切りでなければ何も変えない。
export function endPrivateCanvas(store: CanvasStore): CanvasStore {
  if (store.ephemeral === null) return store;
  const revision =
    (BigInt(store.ephemeral.canvas_revision) >
    BigInt(store.persisted.canvas_revision)
      ? BigInt(store.ephemeral.canvas_revision)
      : BigInt(store.persisted.canvas_revision)) + 1n;
  return {
    persisted: { ...store.persisted, canvas_revision: revision.toString() },
    ephemeral: null,
  };
}

// 流れの区切り（StreamSegment）の意味の検査（ADR 0032）。
export type StreamSegmentError =
  | 'private_carries_summary'
  | 'summary_carried_across_boundary'
  | 'storage_mode_mismatch'
  | 'summary_expired'
  | 'summary_from_self';

export interface CarriedSummaryLike {
  readonly source_segment_ids: readonly string[];
  readonly expires_at: string;
}

export interface StreamSegmentLike {
  readonly segment_id: string;
  readonly storage_mode: 'normal' | 'extended' | 'private';
  readonly opened_at: string;
  readonly open_reason: string;
  readonly carried_summary: CarriedSummaryLike | null;
}

export const CARRIED_SUMMARY_SOURCE_LIMIT = 256;

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
  const summary = segment.carried_summary;
  if (segment.storage_mode === 'private' && summary !== null)
    errors.push('private_carries_summary');
  if (NO_CARRY_REASONS.includes(segment.open_reason) && summary !== null)
    errors.push('summary_carried_across_boundary');
  // 期限が区切りの始まり以前の要約は、もう捨てているはずなのでつながない。
  if (
    summary !== null &&
    Date.parse(summary.expires_at) <= Date.parse(segment.opened_at)
  )
    errors.push('summary_expired');
  if (summary?.source_segment_ids.includes(segment.segment_id))
    errors.push('summary_from_self');
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

export interface ClosingSegmentLike {
  readonly segment_id: string;
  readonly storage_mode: 'normal' | 'extended' | 'private';
  // 区切りの発言ごとの保存期限（生成から一度だけ計算した値。設計 03）。
  readonly turn_expires_at: readonly string[];
}

// 新しい区切りにつなぐ要約の由来と期限（ADR 0032）。規則:
// - 要約の期限は、由来の発言のうち最も早い期限。その時に要約全体を捨てる（一部の由来だけを残さない）。
// - 要約し直すときは、期限内の材料だけを使う。期限の切れた前の要約・期限の切れた発言は材料にしない。
//   前の要約を材料にしたら、その由来と期限も引き継ぐ（何回区切りをまたいでも同じ規則）。
// - つながない始まり方（流れの最初・忘却・記録しない会話の出入り）と、記録しない区切りからはつながない。
// - 由来が 256 区切りを超えるなら、つながない（Core は期限内の発言から作り直す）。
// 期限の比較は UTC のミリ秒で行い、返す期限は材料の値をそのまま使う。
export function nextCarriedSummary(input: {
  readonly previous: CarriedSummaryLike | null;
  readonly closing: ClosingSegmentLike;
  readonly open_reason: string;
  readonly now: string;
}): CarriedSummaryLike | null {
  if (NO_CARRY_REASONS.includes(input.open_reason)) return null;
  if (input.closing.storage_mode === 'private') return null;
  const now = Date.parse(input.now);
  const previous =
    input.previous !== null && Date.parse(input.previous.expires_at) > now
      ? input.previous
      : null;
  const turns = input.closing.turn_expires_at.filter(
    (expiresAt) => Date.parse(expiresAt) > now,
  );
  const sources = [
    ...(previous?.source_segment_ids ?? []),
    ...(turns.length > 0 ? [input.closing.segment_id] : []),
  ].filter((id, index, all) => all.indexOf(id) === index);
  if (sources.length === 0 || sources.length > CARRIED_SUMMARY_SOURCE_LIMIT)
    return null;
  const candidates = [...(previous ? [previous.expires_at] : []), ...turns];
  const earliest = candidates.reduce((a, b) =>
    Date.parse(b) < Date.parse(a) ? b : a,
  );
  return { source_segment_ids: sources, expires_at: earliest };
}
