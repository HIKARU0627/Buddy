// 流れ（stream）への発言とキャンバスの記述の経路（UI-03・UI-05、ADR 0032・0068）。
//
// - 区切り（segment）は Core だけが選ぶ。流れの最初の発言で作り（stream_started）、以後は前の発言から 30 分
//   やりとりがないか（idle_timeout）、本人の時間帯で日付が変わった（date_changed）ときに新しい区切りを始める。
//   記録しない会話・保存モードの変更・区切りの指示は UI-05 の後続の段階（記録しない会話は B06-07a-2 の後）。
//   新しい区切りには、期限内の材料だけで作った前の区切りの要約の由来と期限だけをつなぐ（本文は持たない）。
//   保存期限は発言ごとに生成から計算し、区切りの継続で延ばさない（設計 03）。
// - キャンバスの正本は Core（CanvasHub）。変更の束は Schema（CanvasOpBatch）と domain の意味の検査
//   （applyCanvasBatch: 読む順・参照の件数・版の連続・対象の有無など）を通ったものだけを当てる。どれかに反すれば
//   何も当てず、前の版が残る。端末へは版（canvas_revision）だけを接続中の購読に知らせ、本文を入れない。
//   端末は読み取り（getCanvas）で記述を取る。UI-03 の記述は Core の RAM にだけ持つ（保存は未決。U169）。
// - 発言（postStreamTurn）は、既存の発言の処理（postTurn。模擬の解釈・意味検証・承認待ちの操作の作成）をそのまま
//   呼ぶ。応答の文字の結果（result_view）から、模擬の配置者（コードの規則。placeCanvasForTurn）が変更の束を作る。
//   LLM・端末は配置を決めない。承認・停止・取消はキャンバスに置かない。
// - 端末の expected_canvas_revision は、束の元の版に使わない（Core の今の版から作る。AI が優先）。発言は版が古くても
//   受け付け、添えた版は配置者の入力（本人が見ていた版）として渡す（UI-06）。
// - ユーザーの操作（UI-06、ADR 0032）: 動かす・大きさを変える・閉じる・棚へ片付ける・棚から出すを postCanvasUserOp で
//   記録し、記述に当てる（applyCanvasUserOp）。古い版への操作は、その物の置き場所・存在が後から変わっていなければ当て、
//   変わっていれば 409 で捨てる。記録（RAM に 64 件まで）は次の配置者の入力にする。保存は未決（U169）。
// - 期限切れ・忘却の知らせ（UI-05 の段階 3、ADR 0187）: 消えた発言・記憶に結び付くキャンバスの物を閉じる束を Core が作って
//   当て、版を進める（端末は版の知らせと getCanvas で収束する）。結び付きは、物を置いた・最後に中身を変えた発言と、物の
//   参照（screen_result の発言 ID・memory の記憶 ID）。忘却の知らせでは、今の区切りにつないだ要約を外し、次の発言で
//   新しい区切り（forget_requested）を始める。要約をつないだ区間が消えたときも要約を外す。

import { randomUUID } from 'node:crypto';
import type {
  CanvasCell,
  CanvasOp,
  CanvasContentRequest,
  CanvasContentResponse,
  CanvasDocument,
  CanvasItem,
  CanvasOpBatch,
  CanvasUserOp,
  CanvasUserOpRequest,
  CanvasUserOpResponse,
  StreamSegment,
  StreamTurnResponse,
  StorageModeChangeRequest,
  StorageModeNotice,
  TurnResponse,
} from '@buddy/contracts';
import {
  CANVAS_OPS_LIMIT,
  applyCanvasBatch,
  applyCanvasLayoutHint,
  applyCanvasUserOp,
  automaticSegmentBoundary,
  canvasBatchPlacementTargets,
  canvasContentErrors,
  endPrivateCanvas,
  nextCarriedSummary,
  streamSegmentErrors,
} from '@buddy/domain';
import type {
  AutomaticSegmentBoundaryReason,
  CanvasLayoutHintFallbackReason,
  CanvasLayoutHintLike,
} from '@buddy/domain';
import type { ApiContract } from './api-contract.js';
import { createApiContract } from './api-contract.js';
import { API_ROUTES } from './api-routes.js';
import type { ApiRoute } from './api-routes.js';
import { apiErrorResponse } from './api-server.js';
import type { ApiErrorCode } from './api-server.js';
import { mockCanvasContent } from './canvas-content.js';
import type { Notice } from './notice-sink.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import type { JsonObject } from './strict-json.js';

export const EMPTY_CANVAS: CanvasDocument = {
  canvas_revision: '0',
  items: [],
  reading_order: [],
};

export type CanvasApplyOutcome =
  | { readonly ok: true; readonly revision: string }
  | { readonly ok: false; readonly reason: 'schema' | 'semantic' };

export type CanvasUserApplyOutcome =
  | { readonly ok: true; readonly revision: string }
  | {
      readonly ok: false;
      readonly reason: 'stale' | 'not_applicable' | 'schema';
    };

// 画面へ回した文字の結果・保留を捨てた知らせの物の名前（U120、ADR 0066）。同じ物を更新して使い回す。
export const REPLY_ITEM_ID = 'reply';
export const HELD_DROPPED_ITEM_ID = 'held-dropped';
const REPLY_HEADING = '答え';
const HELD_DROPPED_HEADING = '実行前の依頼';
// 物のデータの参照の種類。本文は物に載せず、content の経路で取る（ADR 0032）。
const SCREEN_REF_KIND = 'screen_result';
// 結果の文字がないときの案内（実行を告げない）。
const SCREEN_FALLBACK_TEXT = '画面で確認してください。';
// 本文の上限（CanvasContentBody と同じ）。Core の定型文はこれより短い。
const TEXT_MAX_LENGTH = 2000;

// ユーザーの操作の記録（UI-06）。次の配置者の入力にする。本文・見出しを持たない（物の名前とマスだけ）。
export interface CanvasUserRecordEntry {
  readonly kind: CanvasUserOp['kind'];
  readonly item_id: string;
  readonly cell: CanvasCell | null;
  // 当てた後の版。
  readonly canvas_revision: string;
}

// 記録の上限（Core の RAM。保存は UI-05）。
export const CANVAS_USER_RECORD_LIMIT = 64;

// 配置のヒント（UI-09、ADR 0200）を使ったか、捨ててコードの配置に戻したかの記録。理由のコードだけを持ち、ヒントの中身・
// 物の名前・見出し・版を持たない（Core の RAM。記録しない区切りの間の記録は区切りの終わりで捨てる）。
export interface CanvasLayoutHintRecordEntry {
  readonly outcome: 'applied' | 'fallback';
  readonly reason: CanvasLayoutHintFallbackReason | null;
}

export const CANVAS_LAYOUT_HINT_RECORD_LIMIT = 64;
// 忘却・期限切れ・記録しない区切りの終わりで記述から消えた物の名前を覚える数（ヒントの拒否の理由を分けるためだけ）。
export const CANVAS_WITHDRAWN_LIMIT = 64;

// ヒントつきで当てた結果。batch は実際に当てた束（ヒントを捨てたときはコードの束）。
export interface CanvasHintedApplyOutcome {
  readonly outcome: CanvasApplyOutcome;
  readonly batch: CanvasOpBatch;
}

// キャンバスの正本（Core の RAM）。1 人に 1 本の流れの、今の記述。
export class CanvasHub {
  readonly #contract: ApiContract;
  readonly #listeners = new Set<(revision: string) => void>();
  #document: CanvasDocument = EMPTY_CANVAS;
  // 物ごとの、置き場所・存在が最後に変わった版（UI-06。古い版へのユーザーの操作を当ててよいかに使う）。
  #placedAt = new Map<string, string>();
  #record: CanvasUserRecordEntry[] = [];
  #hintRecord: CanvasLayoutHintRecordEntry[] = [];
  #withdrawn: string[] = [];
  // 物の本文（U120）。記述・イベント・ログには載せず、content の経路でだけ返す（ADR 0032・0066）。
  #texts = new Map<string, string>();
  // 記録しない区切りに入る前の記述（ADR 0032 の persisted。B06-07a-2 の 2c、ADR 0190）。記録しない間の変更は、AI の束・
  // ユーザーの操作・知らせの後始末を含めてすべて今の記述（一時の記述）に当て、ここは変えない。終えたらここへ戻す。
  // 記録しない区切りでなければ null。
  #persisted: {
    readonly document: CanvasDocument;
    readonly placedAt: Map<string, string>;
    readonly record: CanvasUserRecordEntry[];
    readonly hintRecord: CanvasLayoutHintRecordEntry[];
    readonly texts: Map<string, string>;
  } | null = null;

  constructor(contract: ApiContract = createApiContract()) {
    this.#contract = contract;
  }

  get document(): CanvasDocument {
    return this.#document;
  }

  // ユーザーの操作の記録（古い順。最大 CANVAS_USER_RECORD_LIMIT 件）。
  get record(): readonly CanvasUserRecordEntry[] {
    return this.#record;
  }

  // 配置のヒントの記録（古い順。最大 CANVAS_LAYOUT_HINT_RECORD_LIMIT 件。UI-09）。
  get layoutHintRecord(): readonly CanvasLayoutHintRecordEntry[] {
    return this.#hintRecord;
  }

  // 記録しない区切りの一時の記述を使っているか。
  get privateOpen(): boolean {
    return this.#persisted !== null;
  }

  // 記録しない区切りに入った後に、一時の記述が変わったか（閉じ直す必要があるか）。
  get privateChanged(): boolean {
    return (
      this.#persisted !== null && this.#document !== this.#persisted.document
    );
  }

  // 記録しない区切りに入る（保存境界の命令 begin_private_canvas）。今の記述・置き場所の版・操作の記録・本文を控え、以後の
  // 変更は一時の記述に当てる。すでに入っていれば何もしない（domain の beginPrivateCanvas と同じ）。版は変えない。
  beginPrivate(): void {
    if (this.#persisted !== null) return;
    this.#persisted = {
      document: this.#document,
      placedAt: new Map(this.#placedAt),
      record: [...this.#record],
      hintRecord: [...this.#hintRecord],
      texts: new Map(this.#texts),
    };
  }

  // 記録しない区切りを終える（保存境界の命令 end_private_canvas）。一時の記述と、その間の本文・操作の記録を捨て、入る前の
  // 記述へ戻す。版は一時の記述の版より 1 進める（端末から見て版を戻さない。domain の endPrivateCanvas）。購読へ版を知らせる。
  // 記録しない区切りでなければ何もせず null。
  endPrivate(): string | null {
    const saved = this.#persisted;
    if (saved === null) return null;
    this.#persisted = null;
    const ended = endPrivateCanvas({
      persisted: saved.document,
      ephemeral: this.#document,
    });
    const next = ended.persisted as CanvasDocument;
    // 一時の記述にだけあった物は、記録しない区切りの終わりで消えた物として覚える（名前だけ。ヒントの拒否の理由に使う）。
    const kept = new Set(next.items.map((item) => item.item_id));
    this.#rememberWithdrawn(
      this.#document.items
        .map((item) => item.item_id)
        .filter((itemId) => !kept.has(itemId)),
    );
    this.#placedAt = saved.placedAt;
    this.#record = saved.record;
    // 記録しない区切りの間のヒントの記録も捨てる（入る前の記録に戻す）。
    this.#hintRecord = saved.hintRecord;
    this.#texts = saved.texts;
    this.#commit(next);
    return next.canvas_revision;
  }

  // 物の置き場所・存在が最後に変わった版（試験用）。
  placedAt(itemId: string): string | null {
    return this.#placedAt.get(itemId) ?? null;
  }

  // 変更の束を当てる。Schema・意味の検査・当てた後の記述の Schema のどれかに反すれば何も当てない（前の版が残る）。
  apply(batch: CanvasOpBatch): CanvasApplyOutcome {
    if (!this.#contract.valid('CanvasOpBatch', batch))
      return { ok: false, reason: 'schema' };
    const result = applyCanvasBatch(this.#document, batch);
    if (!result.ok) return { ok: false, reason: 'semantic' };
    const next = result.canvas as CanvasDocument;
    if (!this.#contract.valid('CanvasDocument', next))
      return { ok: false, reason: 'schema' };
    // 置き場所・存在が変わった物の版を進める（relayout はすべて。中身だけの update は進めない）。
    const targets = canvasBatchPlacementTargets(batch);
    for (const id of targets ?? next.items.map((item) => item.item_id))
      this.#placedAt.set(id, next.canvas_revision);
    this.#pruneTexts(next);
    this.#commit(next);
    return { ok: true, revision: next.canvas_revision };
  }

  // コードの配置者の束を、モデルの配置のヒント（UI-09、ADR 0200）つきで当てる。ヒントは信頼しない入力として、形
  // （CanvasLayoutHint）と意味（applyCanvasLayoutHint）を確かめ、どちらかに反する・当てた束が検査に反するときは、
  // ヒントを捨ててコードの束をそのまま当てる（コードの配置に戻す）。使ったか戻したかと理由のコードだけを記録する。
  // hint が null・undefined なら、ヒントなしで当てる（記録しない）。
  applyHinted(batch: CanvasOpBatch, hint: unknown): CanvasHintedApplyOutcome {
    if (hint === null || hint === undefined)
      return { outcome: this.apply(batch), batch };
    if (!this.#contract.valid('CanvasLayoutHint', hint)) {
      this.recordLayoutHint('schema');
      return { outcome: this.apply(batch), batch };
    }
    const hinted = applyCanvasLayoutHint({
      canvas: this.#document,
      batch,
      hint: hint as CanvasLayoutHintLike,
      withdrawn: new Set(this.#withdrawn),
    });
    if (!hinted.ok) {
      this.recordLayoutHint(hinted.reason);
      return { outcome: this.apply(batch), batch };
    }
    const hintedBatch = hinted.batch as CanvasOpBatch;
    const outcome = this.apply(hintedBatch);
    if (outcome.ok) {
      this.recordLayoutHint(null);
      return { outcome, batch: hintedBatch };
    }
    this.recordLayoutHint('apply_rejected');
    return { outcome: this.apply(batch), batch };
  }

  // 配置のヒントの結果を記録する（null は使った）。理由のコードだけ。
  recordLayoutHint(reason: CanvasLayoutHintFallbackReason | null): void {
    this.#hintRecord = [
      ...this.#hintRecord,
      reason === null
        ? { outcome: 'applied' as const, reason: null }
        : { outcome: 'fallback' as const, reason },
    ].slice(-CANVAS_LAYOUT_HINT_RECORD_LIMIT);
  }

  #rememberWithdrawn(itemIds: readonly string[]): void {
    if (itemIds.length === 0) return;
    this.#withdrawn = [
      ...this.#withdrawn.filter((itemId) => !itemIds.includes(itemId)),
      ...itemIds,
    ].slice(-CANVAS_WITHDRAWN_LIMIT);
  }

  // 画面へ回した文字の結果の本文（U120）。物の名前ごとに 1 つだけ持つ（同じ物を更新して使い回す）。
  setText(itemId: string, text: string): void {
    this.#texts.set(itemId, text);
  }

  // 物の本文（content の経路だけが読む）。なければ null（模擬の中身に戻す）。
  textFor(itemId: string): string | null {
    return this.#texts.get(itemId) ?? null;
  }

  // ユーザーの操作を当てる（UI-06）。添えた版の照合と当て方は domain の applyCanvasUserOp。当てた後の記述も Schema で
  // 検査し、反すれば何も当てない。当てたら記録に足し、購読へ版を知らせる。
  applyUser(
    op: CanvasUserOp,
    expectedRevision: string,
  ): CanvasUserApplyOutcome {
    const result = applyCanvasUserOp({
      canvas: this.#document,
      op,
      expected_revision: expectedRevision,
      placed_at: this.#placedAt.get(op.item_id) ?? null,
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    const next = result.canvas as CanvasDocument;
    if (!this.#contract.valid('CanvasDocument', next))
      return { ok: false, reason: 'schema' };
    if (op.kind === 'close') {
      this.#placedAt.delete(op.item_id);
      this.#texts.delete(op.item_id);
    } else this.#placedAt.set(op.item_id, next.canvas_revision);
    this.#record = [
      ...this.#record,
      {
        kind: op.kind,
        item_id: op.item_id,
        cell: 'cell' in op ? { ...op.cell } : null,
        canvas_revision: next.canvas_revision,
      },
    ].slice(-CANVAS_USER_RECORD_LIMIT);
    this.#pruneTexts(next);
    this.#commit(next);
    return { ok: true, revision: next.canvas_revision };
  }

  // 物を閉じる（期限切れ・忘却の後始末。ADR 0187）。Core が作る束で、AI の束と同じ検査（Schema・意味）を通して当てる。
  // 残る物の関係がその物を指していれば先に外す（関係の先がない記述にしない）。1 つの束の操作は CANVAS_OPS_LIMIT までなので、
  // 多ければ束を分け、束ごとに版を 1 進める。ない物は数えない。閉じた物がなければ null、当てられなければ false。
  // 束を分けるときは、閉じる物どうしの関係も先に外す（後の束で閉じる物が、先の束で閉じた物を指したまま残らないように。
  // ADR 0187 の見直し）。途中の束で当てられなかったときは、そこまでの束は当たったまま（閉じた物の置き場所の版は捨てる）で
  // false を返す。残りは呼び出し側が次の機会に閉じ直す。
  removeItems(itemIds: ReadonlySet<string>): string | null | false {
    const document = this.#document;
    const targets = document.items
      .filter((item) => itemIds.has(item.item_id))
      .map((item) => item.item_id);
    if (targets.length === 0) return null;
    const doomed = new Set(targets);
    const pointing = (item: CanvasItem) =>
      item.relations.some((relation) => doomed.has(relation.target));
    const strip = (item: CanvasItem): CanvasOp => ({
      op: 'update',
      item_id: item.item_id,
      changes: {
        // 契約の型は長さごとの組（上限 4）。元の関係を減らすだけなので上限を超えない。
        relations: item.relations.filter(
          (relation) => !doomed.has(relation.target),
        ) as CanvasItem['relations'],
      },
    });
    const keepers = document.items.filter(
      (item) => !doomed.has(item.item_id) && pointing(item),
    );
    const closes = targets.map((itemId): CanvasOp => ({
      op: 'close',
      item_id: itemId,
    }));
    // 1 つの束に収まるなら、閉じる物どうしの関係は外さなくてよい（同じ束で両方とも消える）。収まらなければ、閉じる物の
    // 関係も外す。外す update をすべて close より前に並べるので、close を含む束を当てた時点で、残る物（後の束で閉じる物を
    // 含む）はどれも閉じた物を指さない。
    const updates = (
      keepers.length + closes.length <= CANVAS_OPS_LIMIT
        ? keepers
        : document.items.filter(pointing)
    ).map(strip);
    // 束に分ける。同じ物の update と close を 1 つの束に入れない（op_target_duplicate）。
    const chunks: CanvasOp[][] = [];
    let chunk: CanvasOp[] = [];
    let touched = new Set<string>();
    for (const op of [...updates, ...closes]) {
      const target = op.op === 'update' || op.op === 'close' ? op.item_id : '';
      if (chunk.length === CANVAS_OPS_LIMIT || touched.has(target)) {
        chunks.push(chunk);
        chunk = [];
        touched = new Set();
      }
      chunk.push(op);
      touched.add(target);
    }
    if (chunk.length > 0) chunks.push(chunk);
    let ok = true;
    for (const ops of chunks) {
      const closing = new Set(
        ops.flatMap((op) => (op.op === 'close' ? [op.item_id] : [])),
      );
      const base = this.#document.canvas_revision;
      const outcome = this.apply({
        base_canvas_revision: base,
        canvas_revision: (BigInt(base) + 1n).toString(),
        // 契約の型は長さごとの組（上限 CANVAS_OPS_LIMIT）。上で 1〜CANVAS_OPS_LIMIT 件に切っている。
        ops: ops as CanvasOpBatch['ops'],
        reading_order: this.#document.reading_order.filter(
          (itemId) => !closing.has(itemId),
        ),
      });
      if (!outcome.ok) {
        ok = false;
        break;
      }
    }
    // 記述から消えた物の置き場所の版を捨てる（途中で失敗したときも、当たった束で閉じた物の分は捨てる）。
    const alive = new Set(this.#document.items.map((item) => item.item_id));
    for (const itemId of targets)
      if (!alive.has(itemId)) this.#placedAt.delete(itemId);
    // 消えた物の名前を覚える（ヒントがこの物を指したら withdrawn_item で戻す。UI-09）。
    this.#rememberWithdrawn(targets.filter((itemId) => !alive.has(itemId)));
    return ok ? this.#document.canvas_revision : false;
  }

  // 記述から消えた物の本文を捨てる（閉じた物の本文を残さない）。
  #pruneTexts(next: CanvasDocument): void {
    if (this.#texts.size === 0) return;
    const alive = new Set(next.items.map((item) => item.item_id));
    for (const itemId of this.#texts.keys())
      if (!alive.has(itemId)) this.#texts.delete(itemId);
  }

  #commit(next: CanvasDocument): void {
    this.#document = next;
    for (const listener of [...this.#listeners]) {
      try {
        listener(next.canvas_revision);
      } catch {
        // 1 つの購読の失敗で他の購読と、当てた記述を止めない。
      }
    }
  }

  // 版が進んだことを知らせる購読（WSS の購読ごと）。版だけを渡す。
  subscribe(listener: (revision: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

// --- 模擬の配置者（コードの規則。モデル・端末は配置を決めない） ---

// 用事の一覧の物の名前（キャンバスの中だけで一意。内部の識別子を使わない）。
export const ERRANDS_ITEM_ID = 'errands';
const ERRANDS_HEADING = '今日の用事';
const MAX_REFS = 50;

// 発言の結果から変更の束を作る。今は「予定の照会（query_schedule）の結果」だけ。用事の list のカードを 1 枚置く
// （なければ add、あれば中身だけ update。棚へ片付けられていれば棚のまま）。読み取りの結果でなければ null。
export interface ScheduleViewLike {
  readonly intent: string;
  readonly kind: string;
  readonly status: string;
  readonly item_refs: readonly { readonly kind: string; readonly id: string }[];
  readonly more_count: number;
}

// 配置者の入力（UI-06）。ユーザーの操作の記録と、本人が見ていた版（発言に添えた expected_canvas_revision）。
export interface PlacerContext {
  readonly record: readonly CanvasUserRecordEntry[];
  readonly seen_revision: string;
}

export function placeCanvasForTurn(
  canvas: CanvasDocument,
  view: ScheduleViewLike | null,
  context?: PlacerContext,
): CanvasOpBatch | null {
  if (
    view === null ||
    view.intent !== 'query_schedule' ||
    view.kind !== 'schedule_cards'
  )
    return null;
  // 予定の ID の参照だけ（重なりの参照は同じ予定を指すので、強調で表す）。本文は持たない。
  const refs = view.item_refs
    .filter((item) => item.kind === 'calendar_event')
    .slice(0, MAX_REFS)
    .map((item) => ({ kind: 'calendar_event', id: item.id }));
  const data = {
    item_refs: refs,
    more_count: refs.length === MAX_REFS ? view.more_count : 0,
  };
  // 重なる予定があるとき（確認が要る）は強調する。
  const emphasis: CanvasItem['emphasis'] =
    view.status === 'needs_review' ? 'high' : 'normal';
  const existing = canvas.items.find(
    (item) => item.item_id === ERRANDS_ITEM_ID,
  );
  const base = canvas.canvas_revision;
  const next = (BigInt(base) + 1n).toString();
  if (existing !== undefined)
    return {
      base_canvas_revision: base,
      canvas_revision: next,
      ops: [
        {
          op: 'update',
          item_id: ERRANDS_ITEM_ID,
          changes: { emphasis, data },
        },
      ],
      reading_order: [...canvas.reading_order],
    };
  // 本人が前に同じ物を動かした・大きさを変えたなら、最後のマスの列・幅・行数を格子のヒントにする（記録を次の配置の
  // 入力にする。UI-06）。なければ左から 2 列目から 4 列分・3 行分（最後の位置は端末の配置のエンジンが決める）。
  const last = [...(context?.record ?? [])]
    .reverse()
    .find((entry) => entry.item_id === ERRANDS_ITEM_ID && entry.cell !== null);
  const grid =
    last?.cell === null || last?.cell === undefined
      ? { column: 2, span: 4, rows: 3 }
      : {
          column: last.cell.column,
          span: last.cell.span,
          rows: last.cell.rows,
        };
  const item: CanvasItem = {
    item_id: ERRANDS_ITEM_ID,
    kind: 'card',
    component: 'list',
    heading: ERRANDS_HEADING,
    emphasis,
    group: null,
    relations: [],
    grid,
    placement: 'canvas',
    data,
  };
  return {
    base_canvas_revision: base,
    canvas_revision: next,
    ops: [{ op: 'add', item }],
    reading_order: [...canvas.reading_order, ERRANDS_ITEM_ID],
  };
}

// --- 画面へ回した文字の結果（U120、ADR 0066） ---

// 画面へ置く文字の物と、content の経路で返す本文。
export interface ScreenTextPlacement {
  readonly item_id: string;
  readonly text: string;
  readonly batch: CanvasOpBatch;
}

// 本文を契約の上限に収める（Core の定型文はもともと短い。念のため）。
const boundedText = (text: string): string =>
  text.length <= TEXT_MAX_LENGTH ? text : text.slice(0, TEXT_MAX_LENGTH);

// 同じ物があれば中身だけを更新し、なければ格子のヒントつきで足す。棚へ片付けられていれば棚のまま
// （ユーザーの置き場所を AI が勝手に戻さない。ADR 0032）。
function textCardBatch(
  canvas: CanvasDocument,
  input: {
    readonly item_id: string;
    readonly heading: string;
    readonly ref_id: string;
    readonly grid: CanvasItem['grid'];
  },
  context?: PlacerContext,
): CanvasOpBatch {
  const data = {
    item_refs: [{ kind: SCREEN_REF_KIND, id: input.ref_id }],
    more_count: 0,
  };
  const base = canvas.canvas_revision;
  const next = (BigInt(base) + 1n).toString();
  const existing = canvas.items.find((item) => item.item_id === input.item_id);
  if (existing !== undefined)
    return {
      base_canvas_revision: base,
      canvas_revision: next,
      ops: [
        {
          op: 'update',
          item_id: input.item_id,
          changes: { heading: input.heading, emphasis: 'normal', data },
        },
      ],
      reading_order: [...canvas.reading_order],
    };
  const last = [...(context?.record ?? [])]
    .reverse()
    .find((entry) => entry.item_id === input.item_id && entry.cell !== null);
  const grid =
    last?.cell === null || last?.cell === undefined
      ? input.grid
      : {
          column: last.cell.column,
          span: last.cell.span,
          rows: last.cell.rows,
        };
  const item: CanvasItem = {
    item_id: input.item_id,
    kind: 'float',
    component: 'text',
    heading: input.heading,
    emphasis: 'normal',
    group: null,
    relations: [],
    grid,
    placement: 'canvas',
    data,
  };
  return {
    base_canvas_revision: base,
    canvas_revision: next,
    ops: [{ op: 'add', item }],
    reading_order: [...canvas.reading_order, input.item_id],
  };
}

// 声で返せなかった発言の結果を、キャンバスの text の物にする。結果の文字（Core の定型文）を本文にし、
// 実行を告げる文を足さない。会話の操作（結果の表示を持たない）は置かない。
export function placeReplyForTurn(
  canvas: CanvasDocument,
  turn: Pick<TurnResponse, 'turn_id' | 'status' | 'reply_text'>,
  context?: PlacerContext,
  chosenText: string | null = null,
): ScreenTextPlacement | null {
  if (turn.status === 'session_control') return null;
  const reply =
    chosenText !== null && chosenText.trim().length > 0
      ? chosenText
      : turn.reply_text;
  const text =
    typeof reply === 'string' && reply.trim().length > 0
      ? boundedText(reply)
      : SCREEN_FALLBACK_TEXT;
  return {
    item_id: REPLY_ITEM_ID,
    text,
    batch: textCardBatch(
      canvas,
      {
        item_id: REPLY_ITEM_ID,
        heading: REPLY_HEADING,
        ref_id: turn.turn_id,
        grid: { column: 9, span: 4, rows: 2 },
      },
      context,
    ),
  };
}

// 保留を実行せずに捨てた知らせ。本文は固定の定型文（inputCommentary('hold_dropped')）で、捨てた依頼の本文は含めない。
export function placeHeldDropped(
  canvas: CanvasDocument,
  notice: { readonly workflow_id: string; readonly text: string },
  context?: PlacerContext,
): ScreenTextPlacement {
  const text = boundedText(notice.text);
  return {
    item_id: HELD_DROPPED_ITEM_ID,
    text,
    batch: textCardBatch(
      canvas,
      {
        item_id: HELD_DROPPED_ITEM_ID,
        heading: HELD_DROPPED_HEADING,
        ref_id: notice.workflow_id,
        grid: { column: 5, span: 8, rows: 2 },
      },
      context,
    ),
  };
}

// --- 経路 ---

export interface StreamRoutesOptions {
  readonly canvas: CanvasHub;
  // 既存の会話・発言の処理（api-turns.ts の createSession・postTurn）。関数として呼ぶだけで、中身は変えない。
  readonly createSession: ApiRouteHandler;
  readonly postTurn: ApiRouteHandler;
  // 保存境界の保持者（今の区切りの世代・保存モード・保存モードの切り替え）。流れの発言の由来と、
  // POST /v1/stream/storage-mode の切り替えに使う（ADR 0045・0059・0060）。
  readonly storage: StreamStorageGate;
  readonly contract?: ApiContract;
  readonly now?: () => number;
  // 本人の時間帯（自動の区切りの日付の判定。設計 07 §5 の設定と同じ値。既定は +09:00）。
  readonly utcOffset?: string;
  // 模擬の配置者の差し替え（試験用。検査に反する束を当てようとしても前の版が残ることを確かめる）。
  readonly place?: typeof placeCanvasForTurn;
  // モデルが出した配置のヒント（ResponsePlan の layout_hint。UI-09、ADR 0200）を発言ごとに返す口。値は信頼しない入力として
  // 形と意味を確かめ、反すれば捨ててコードの配置に戻す。省略・null はヒントなし。製品の Core はまだつながない（モデルが
  // ヒントを出す呼出しは未実装。U662）。今は試験の模擬だけが使う。
  readonly layoutHint?: (turn: TurnResponse) => unknown;
  // 保存モードを切り替えて区切りを開き直したことを知らせる口（UI-05 の段階 6、ADR 0189、U477）。Core は NoticeRelay へつなぎ、
  // 開いている購読（ほかの端末を含む）へ流す。保存モードと理由だけで、区切り・会話の ID・世代を入れない。省略は知らせない。
  readonly announceStorageMode?: (notice: StorageModeNotice) => void;
}

// 保存モードの切り替えの結果（Core では storage-gate.ts の StorageGateResult がこの形を満たす）。
export type StreamStorageMode = 'normal' | 'extended' | 'private';

export interface StreamSegmentOrigin {
  readonly segment_id: string;
  readonly segment_generation: string;
  readonly storage_mode: StreamStorageMode;
}

export type StreamStorageOutcome =
  | { readonly ok: true; readonly origin: StreamSegmentOrigin }
  | { readonly ok: false; readonly reason: string };

// 流れの経路が使う保存境界の口。区切りの世代を読み、保存モードを切り替える（ADR 0060）。
export interface StreamStorageGate {
  readonly mode: StreamStorageMode;
  origin(): { readonly segment_generation: string };
  enterPrivate(): Promise<StreamStorageOutcome>;
  exitPrivate(mode: 'normal' | 'extended'): Promise<StreamStorageOutcome>;
}

export interface StreamRoutes {
  readonly handlers: Readonly<Record<string, ApiRouteHandler>>;
  // 声で返せなかった結果（接続が閉じた・文字へ切り替えた・世代が違う）を画面へ回す（B05-05、ADR 0052）。発言の結果と同じ
  // 配置者の規則・意味の検査を通して、キャンバスへ置く。配置済みの発言は重ねて置かない。置いた束を返す（置かなければ null）。
  // 予定のカードにできない結果は、text の物にして本文を content の経路で返す（U120、ADR 0066）。text には、
  // Core が選んだ案内の定型文を渡す（なければ turn.reply_text）。
  readonly placeLate: (
    turn: TurnResponse,
    text?: string | null,
  ) => CanvasOpBatch | null;
  // 保留を実行せずに捨てた知らせを画面へ置く（U120、ADR 0066）。本文は固定の定型文で、捨てた依頼の本文は含めない。
  readonly placeNotice: (notice: {
    readonly session_id: string;
    readonly workflow_id: string;
    readonly reason: string;
    readonly text: string;
  }) => CanvasOpBatch | null;
  // 保存した発言の生成の時刻と期限を区切りへ足す（UI-05。api-turns の onTurnRecorded から呼ぶ）。再送では呼ばない。
  // 期限は保存した時点で確定した値をそのまま使い、この時点の時計から作り直さない（ADR 0068）。
  readonly recordTurn: (event: {
    readonly session_id: string;
    readonly turn_id: string;
    readonly created_at: string;
    readonly expires_at: string;
  }) => void;
  // 期限切れ・忘却の知らせに合わせて流れの表示を片付ける（UI-05 の段階 3、ADR 0187。notice-relay.ts から呼ぶ）。
  // 消えた発言・記憶に結び付く物を閉じて版を進め、忘却なら区切りにつないだ要約を外して次の発言で区切る。
  // 当てられなかった（束が検査に通らない）ときだけ false。
  readonly applyNotice: (notice: Notice) => boolean;
  // 発言との結び付きを持っている物の ID（試験・診断用。ADR 0187）。
  readonly boundItemIds: () => readonly string[];
  // 記録しない区切りの表示（B06-07a-2 の 2c、ADR 0190）。Core が保存境界の命令に結び付ける。
  // - begin: begin_private_canvas。以後のキャンバスの変更を一時の記述に当てる。
  // - end: end_private_canvas。一時の記述を閉じ、入る前の記述へ戻す（版は進める）。
  // - discard: discard_private_ram。記録しない間の発言に結び付けた控え（配置済みの印・応答の束・物の結び付き）を捨てる。
  // - reset: 記録しない区切りのまま中身だけを捨てる（端末のロック・忘却の知らせ）。一時の記述を閉じて入り直し、控えも捨てる。
  readonly privateConversation: {
    begin(): void;
    end(): void;
    discard(): void;
    reset(): void;
    // 記録しない間の発言に結び付けた控えの数（試験・診断用）。
    held(): { readonly turns: number };
  };
}

const stringOf = (body: JsonObject | null, key: string): string => {
  const value = body?.[key];
  return typeof value === 'string' ? value : '';
};

const routeOf = (operationId: string): ApiRoute => {
  const found = API_ROUTES.find((route) => route.operationId === operationId);
  if (found === undefined) throw new Error(`route_missing:${operationId}`);
  return found;
};

// 応答のキャッシュの上限（前に当てた変更の束）。
const MAX_REPLAYS = 256;

// 期限切れ・忘却で消えた発言・記憶の ID を覚えておく件数（種類ごと。Core の RAM。ADR 0187 の見直し）。処理中だった
// 発言の結果を後から置かない・閉じ損ねた物を次の機会に閉じ直すために使う。古いものから捨てる。
export const GONE_IDS_LIMIT = 256;

// 上限つきの ID の集合（古く入れたものから捨てる。入れ直したものは新しい扱い）。
class RecentIds {
  readonly #ids = new Set<string>();
  readonly #limit: number;
  constructor(limit: number) {
    this.#limit = limit;
  }
  has(id: string): boolean {
    return this.#ids.has(id);
  }
  get size(): number {
    return this.#ids.size;
  }
  add(id: string): void {
    this.#ids.delete(id);
    this.#ids.add(id);
    for (const old of this.#ids) {
      if (this.#ids.size <= this.#limit) break;
      this.#ids.delete(old);
    }
  }
}

// 受け付けた要求を元の区切りへ結び付けておく期間（受付レシートの保存期限と同じ 7 日。設計 03 の command_receipt）。
// 応答の束のキャッシュとは別に数える。
export const ACCEPTED_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 期限の切れた対応を片付ける目安（毎回全件を走査しない）。
const ACCEPTED_PRUNE_THRESHOLD = 512;

// 受付の対応の鍵。保存側の受付レシートと同じく、接続範囲（command_scope_id）と要求 ID の組で識別する。
const acceptedKeyOf = (scopeId: string, requestId: string): string =>
  `${scopeId}\u0000${requestId}`;

interface Stream {
  readonly sessionId: string;
  readonly segment: StreamSegment;
  // 最後に受け付けた発言の時刻（自動の区切りの経過をここから測る。まだ無ければ区切りの始まり）。
  readonly lastTurnAt: string;
  // この区切りの発言ごとの保存期限（設計 03。生成から一度だけ計算した値を足していく）。要約をつなぐときに使う。
  readonly turnExpiresAt: readonly string[];
}

type EnsureResult =
  | { readonly ok: true; readonly stream: Stream }
  | { readonly ok: false; readonly response: { status: number; body: object } };

export function createStreamRoutes(options: StreamRoutesOptions): StreamRoutes {
  const contract = options.contract ?? createApiContract();
  const now = options.now ?? (() => Date.now());
  const utcOffset = options.utcOffset ?? '+09:00';
  const createSessionRoute = routeOf('createSession');
  const postTurnRoute = routeOf('postTurn');
  let current: Stream | null = null;
  // `private` から出た後に会話の作成に失敗した状態（ADR 0060）。ゲートは開いているが、端末はまだ `private` の表示の
  // まま。この間の新しい発言は保存しない（黙って `normal` の会話を作り、記録しないはずの発言を DB へ残さない）。
  // 次の保存モードの切り替えが成功した時点で解く。
  let reopenPending = false;
  let creating: Promise<EnsureResult> | null = null;
  // 自動の区切りで区切りを始める処理（同時の発言で二重に区切らないよう直列にする）。
  let rotating: Promise<boolean> | null = null;
  // 忘却の指示（`memory_forget`）を受けた区切り。次の発言で新しい区切りを始め、前の要約はつながない
  // （ADR 0032・0068。忘却の対象は期限内でも文脈・要約から外す）。
  let afterForget: { readonly from: string } | null = null;
  // 忘却の知らせを受けた回数（ADR 0187）。区切りを作る間（会話の作成を待つ間）に忘却の知らせが来たら、新しい区切りに
  // 要約をつながない（作る前に決めた要約に、忘れた内容が入りうる。U466）。
  let forgetNotices = 0;
  // 前に当てた束（応答のキャッシュ。上限つき）と、配置を済ませた発言の ID（上限なし。1 人の流れの RAM だけ）。
  const replays = new Map<string, CanvasOpBatch | null>();
  const placed = new Set<string>();
  // 物 → その物を置いた・最後に中身を変えた発言（ADR 0187）。発言が期限切れ・忘却で消えたら、その物を閉じる。
  // 物が閉じたら（AI の close・ユーザーの閉じる操作・知らせの後始末）消す。
  const itemTurns = new Map<string, string>();
  // 期限切れ・忘却で消えた発言・記憶の ID（上限つき。ADR 0187 の見直し）。知らせの後に処理を終えた発言の結果を置かない、
  // 置いた物が消えた発言・記憶を参照していれば閉じる、閉じ損ねた物を次の知らせ・次の発言で閉じ直す。
  const goneTurns = new RecentIds(GONE_IDS_LIMIT);
  const goneMemories = new RecentIds(GONE_IDS_LIMIT);
  // 記録しない区切りの間に受け付けた発言の ID（ADR 0190）。区切りを終えた・中身を捨てたときに、配置済みの印・応答の束・
  // 物の結び付きから外す（記録しない間の結果を、出た後の表示に使わない）。受付の対応（accepted）は外さない: 記録しない区切りの
  // 要求の再送を、出た後も元の（記録しない）区切りへ送って 409 にするため（外すと新しい要求として通常の区切りに保存してしまう）。
  // 受付の対応は要求 ID と区切りの ID・世代だけで、本文を持たない。
  const privateTurnIds = new Set<string>();
  // 記録しない区切りに入る前の物の結び付き（一時の記述を閉じて戻すときに、結び付きも戻す）。
  let itemTurnsBeforePrivate: Map<string, string> | null = null;
  // 今の記述にない物の結び付きを捨てる。
  const forgetClosedItems = (): void => {
    if (itemTurns.size === 0) return;
    const alive = new Set(
      options.canvas.document.items.map((item) => item.item_id),
    );
    for (const itemId of [...itemTurns.keys()])
      if (!alive.has(itemId)) itemTurns.delete(itemId);
  };
  // 消えた発言・記憶に結び付く物を閉じる（ADR 0187）。extra はこの知らせの ID（上限で捨てる前の分も確かめる）。
  // 閉じた物・今の記述にない物の結び付きを捨てる。当てられなかったら false（残りは次の機会に閉じ直す）。
  const sweepGone = (
    extraTurns: ReadonlySet<string> = new Set(),
    extraMemories: ReadonlySet<string> = new Set(),
  ): boolean => {
    const turnGone = (id: string) => extraTurns.has(id) || goneTurns.has(id);
    const memoryGone = (id: string) =>
      extraMemories.has(id) || goneMemories.has(id);
    const doomed = new Set<string>();
    for (const item of options.canvas.document.items) {
      const origin = itemTurns.get(item.item_id);
      if (
        (origin !== undefined && turnGone(origin)) ||
        item.data.item_refs.some(
          (ref) =>
            (ref.kind === SCREEN_REF_KIND && turnGone(ref.id)) ||
            (ref.kind === 'memory' && memoryGone(ref.id)),
        )
      )
        doomed.add(item.item_id);
    }
    const removed =
      doomed.size === 0 ? null : options.canvas.removeItems(doomed);
    forgetClosedItems();
    return removed !== false;
  };
  // 受け付けた発言の要求（request_id）→ 元の区切り（会話）と受付レシートの期限。同じ要求の再送は、区切りを
  // 切り替える前にこの対応で解決する（新しい区切りで送ると request_hash が変わり 409 になる。PR #191 のレビュー P1）。
  // 応答の束のキャッシュ（MAX_REPLAYS）とは別に、受付レシートの有効期間（`command_receipt` の 7 日。設計 03）だけ保つ。
  // 再送の判定を応答のキャッシュの件数で捨てると、その後の再送が 409 になる（レビュー P2）。
  const accepted = new Map<
    string,
    {
      readonly session_id: string;
      // 最初に受け付けたときの区切りの世代。再送はこの世代を渡す（今の世代を渡すと、private の出入りの後に
      // request_hash が変わって 409 になる）。
      readonly segment_generation: string;
      readonly expires_at: number;
    }
  >();
  // 区切り（会話）ごとの、保存を待っている発言の数と、0 になったら起こす待ち手。区切りを切り替える前に、
  // 旧区切りで保存中の発言が終わるのを待つ（PR #191 のレビュー P2）。
  const inFlight = new Map<
    string,
    { count: number; readonly waiters: (() => void)[] }
  >();
  const startTurnSave = (sessionId: string): (() => void) => {
    const entry = inFlight.get(sessionId) ?? { count: 0, waiters: [] };
    entry.count += 1;
    inFlight.set(sessionId, entry);
    return () => {
      entry.count -= 1;
      if (entry.count > 0) return;
      inFlight.delete(sessionId);
      for (const wake of entry.waiters.splice(0)) wake();
    };
  };
  const settled = (sessionId: string): Promise<void> => {
    const entry = inFlight.get(sessionId);
    if (entry === undefined || entry.count === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      entry.waiters.push(resolve);
    });
  };
  // 受付の対応（期限の切れたものは無いものとして扱う）。
  const acceptedIn = (
    key: string,
  ):
    | {
        readonly session_id: string;
        readonly segment_generation: string;
        readonly expires_at: number;
      }
    | undefined => {
    const entry = accepted.get(key);
    return entry !== undefined && entry.expires_at > now() ? entry : undefined;
  };

  // 保存モードの切り替えと自動の区切りの排他（同時の切り替えで保存境界の状態と今の区切りが食い違わないようにする。
  // ADR 0060）。1 本の鎖に並べ、前の処理が終わってから次を始める。
  let exclusive: Promise<unknown> = Promise.resolve();
  const withExclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = exclusive.then(run, run);
    exclusive = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  // 今の区切り。流れの最初の発言で作り（理由: stream_started）、以後は同じ区切りを使う。同時の最初の発言でも 1 つだけ。
  const ensureStream = (request: ApiHandlerRequest): Promise<EnsureResult> => {
    if (current !== null) return Promise.resolve({ ok: true, stream: current });
    creating ??= (async (): Promise<EnsureResult> => {
      const requestId = stringOf(request.body, 'request_id');
      const created = await options.createSession({
        ...request,
        route: createSessionRoute,
        params: {},
        body: {
          request_id: randomUUID(),
          command_scope_id: stringOf(request.body, 'command_scope_id'),
          storage_mode: 'normal',
        },
      });
      const body = created.body as { session_id?: unknown };
      if (created.status !== 201 || typeof body.session_id !== 'string')
        return {
          ok: false,
          response:
            created.status >= 400 && created.status < 600
              ? created
              : apiErrorResponse(503, 'dependency_unavailable', requestId),
        };
      const segment: StreamSegment = {
        // 区切りの ID は会話の ID を使う（区切りと会話は 1 対 1。画面・端末には会話の ID を渡さない）。
        segment_id: body.session_id,
        storage_mode: 'normal',
        opened_at: new Date(now()).toISOString(),
        open_reason: 'stream_started',
        carried_summary: null,
      };
      if (
        !contract.valid('StreamSegment', segment) ||
        streamSegmentErrors(segment).length > 0
      )
        return {
          ok: false,
          response: apiErrorResponse(503, 'dependency_unavailable', requestId),
        };
      current = {
        sessionId: body.session_id,
        segment,
        lastTurnAt: segment.opened_at,
        turnExpiresAt: [],
      };
      return { ok: true, stream: current };
    })().finally(() => {
      creating = null;
    });
    return creating;
  };

  // 自動の区切りの理由（30 分・日付の変更）。無ければ null。
  const boundaryOf = (
    stream: Stream,
    at: number,
  ): AutomaticSegmentBoundaryReason | null =>
    automaticSegmentBoundary({
      opened_at: stream.segment.opened_at,
      last_turn_at: stream.lastTurnAt,
      now: new Date(at).toISOString(),
      utc_offset: utcOffset,
    });

  // 自動の区切りで新しい区切りを始める（UI-05、ADR 0068）。前の区切りを閉じるときは、期限内の材料だけで作った
  // 要約の由来と期限だけをつなぐ（本文は持たない。D:nextCarriedSummary）。**旧区切りで保存中の発言が終わるまで
  // 待ってから**要約を確定する（保存の期限を落とさない。PR #191 のレビュー P2）。
  //
  // 共有するのは「旧区切りの保存を待つこと」と「切り替えの排他」だけ。どの要求が再送か・区切りが要るかは要求ごとに
  // 違うので、切り替えの待機の後に**各要求が自分の再送と境界を判定し直す**（`postStreamTurn` のループ）。
  // 共有した処理の結果を他の要求に配らない（別の新規要求まで旧区切りに保存してしまう。レビュー P2）。
  let settling: Promise<void> | null = null;
  const settledOld = (sessionId: string): Promise<void> => {
    settling ??= settled(sessionId).finally(() => {
      settling = null;
    });
    return settling;
  };
  // 切り替えそのもの（直列）。待った後にもう一度境界を見る。切り替えたら true、切り替えなかったら false。
  // 会話を作れなかったときは `rotationFailure` に理由を残し、待っていたすべての要求が 503 にする
  // （区切りを作れないまま古い区切りで答えない）。
  let rotationFailure: {
    readonly status: number;
    readonly code: ApiErrorCode;
  } | null = null;
  const rotateSegment = (
    request: ApiHandlerRequest,
    from: Stream,
    requestId: string,
    acceptedKey: string,
    forced: 'forget_requested' | null,
  ): Promise<boolean> => {
    // 保存モードの切り替えと同じ排他で直列にする（切り替えと自動の区切りが重ならない。ADR 0060）。
    if (rotating === null) {
      rotating = withExclusive(async (): Promise<boolean> => {
        rotationFailure = null;
        const started = current;
        if (started === null) return false;
        // 記録しない区切りでは自動の区切りを起こさない（会話を作れず、すべての要求が 503 になる。ADR 0060）。
        if (started.segment.storage_mode === 'private') return false;
        // 先に別の発言が区切った（または最初の区切りを作り直した）なら、今の区切りを使う。
        if (started.sessionId !== from.sessionId) return false;
        if (forced === null && boundaryOf(started, now()) === null)
          return false;
        // 旧区切りで保存を待っている発言が終わるまで待つ（その発言の期限を要約の材料に入れる）。
        await settledOld(started.sessionId);
        // 待つ間に、この要求が保存を終えて受付に登録されていれば、切り替えない（再送として元の区切りで解決する）。
        if (acceptedIn(acceptedKey) !== undefined) return false;
        const stream = current;
        if (stream === null) return false;
        if (stream.sessionId !== started.sessionId) return false;
        // 待つ間に発言が保存されていれば、経過はその発言から測り直す（区切りが要らなくなっていれば切らない）。
        // 忘却の印は、待っている間に付くことがある（保存中の忘却の発言が終わった直後）。呼び出し時の `forced` で
        // 固定せず、この時点の印を見る（PR #235 のレビュー P2）。
        const at = now();
        const forgetNow =
          afterForget !== null && afterForget.from === stream.sessionId;
        const reason = forgetNow ? 'forget_requested' : boundaryOf(stream, at);
        if (reason === null) return false;
        const openedAt = new Date(at).toISOString();
        const summary = nextCarriedSummary({
          previous: stream.segment.carried_summary,
          closing: {
            segment_id: stream.segment.segment_id,
            storage_mode: stream.segment.storage_mode,
            turn_expires_at: stream.turnExpiresAt,
          },
          open_reason: reason,
          now: openedAt,
        });
        // 契約の型は 1 件以上の配列（[string, ...string[]]）。domain は同じ形を読み取り専用の配列で返す。
        const carried: StreamSegment['carried_summary'] =
          summary === null
            ? null
            : {
                source_segment_ids: [...summary.source_segment_ids] as [
                  string,
                  ...string[],
                ],
                expires_at: summary.expires_at,
              };
        const forgetsBefore = forgetNotices;
        const created = await options.createSession({
          ...request,
          route: createSessionRoute,
          params: {},
          body: {
            request_id: randomUUID(),
            command_scope_id: stringOf(request.body, 'command_scope_id'),
            storage_mode: stream.segment.storage_mode,
          },
        });
        const body = created.body as { session_id?: unknown };
        if (created.status !== 201 || typeof body.session_id !== 'string') {
          rotationFailure =
            created.status >= 400 && created.status < 600
              ? {
                  status: created.status,
                  code: String(
                    (created.body as { code?: unknown }).code ??
                      'dependency_unavailable',
                  ) as ApiErrorCode,
                }
              : { status: 503, code: 'dependency_unavailable' };
          return false;
        }
        const segment: StreamSegment = {
          segment_id: body.session_id,
          storage_mode: stream.segment.storage_mode,
          opened_at: openedAt,
          open_reason: reason,
          carried_summary: forgetNotices === forgetsBefore ? carried : null,
        };
        if (
          !contract.valid('StreamSegment', segment) ||
          streamSegmentErrors(segment).length > 0
        ) {
          rotationFailure = { status: 503, code: 'dependency_unavailable' };
          return false;
        }
        current = {
          sessionId: body.session_id,
          segment,
          // 新しい区切りの経過は、区切りを始めた時刻から測る。
          lastTurnAt: openedAt,
          turnExpiresAt: [],
        };
        // 忘却の指示で始めた区切りだけ、印を消費する（自動の区切りで消さない。レビュー P2）。
        if (reason === 'forget_requested' && afterForget !== null)
          afterForget = null;
        return true;
      }).finally(() => {
        rotating = null;
      });
    }
    return rotating;
  };

  // 保存した発言の生成の時刻と期限を、その発言の区切りへ足す（api-turns の onTurnRecorded から呼ぶ）。期限は保存した
  // 時点で確定した値をそのまま使い、この時点の時計から作り直さない（保存から応答までの待ちで期限を延ばさない。
  // PR #191 のレビュー P2）。再送では呼ばれない。区切りが変わっていれば何もしない。
  const recordTurn = (event: {
    readonly session_id: string;
    readonly turn_id: string;
    readonly created_at: string;
    readonly expires_at: string;
  }): void => {
    if (current === null || current.sessionId !== event.session_id) return;
    // 経過の起点は**遅い方**を取る。並行した発言の保存は完了の順が前後するので、後から終わった古い発言で
    // 起点を過去へ戻さない（戻すと、実際にはやりとりがあったのに日付・30 分の区切りが早まる。レビュー P2）。
    const lastTurnAt =
      Date.parse(event.created_at) > Date.parse(current.lastTurnAt)
        ? event.created_at
        : current.lastTurnAt;
    current = {
      ...current,
      lastTurnAt,
      turnExpiresAt: [...current.turnExpiresAt, event.expires_at],
    };
  };

  // 発言の結果をキャンバスへ置く（発言の応答と、画面へ回した遅着の結果で共通）。同じ発言は重ねて置かない（再送・遅着の重複）。
  // late は声で返せなかった結果（U120）。予定のカードにできない結果は text の物にして、本文を content の経路へ預ける。
  const placeTurn = (
    turn: TurnResponse,
    seenRevision: string,
    late = false,
    text: string | null = null,
  ): CanvasOpBatch | null => {
    if (placed.has(turn.turn_id)) return replays.get(turn.turn_id) ?? null;
    // 処理の間に期限切れ・忘却で消えた発言の結果は置かない（消えた発言を指す物を残さない。ADR 0187 の見直し）。
    // 配置済みとして覚え、再送でも置かない。
    if (goneTurns.has(turn.turn_id)) {
      placed.add(turn.turn_id);
      replays.set(turn.turn_id, null);
      return null;
    }
    const context = {
      record: options.canvas.record,
      seen_revision: seenRevision,
    };
    let batch = (options.place ?? placeCanvasForTurn)(
      options.canvas.document,
      turn.result_view,
      context,
    );
    const reply =
      batch === null && late
        ? placeReplyForTurn(options.canvas.document, turn, context, text)
        : null;
    if (reply !== null) batch = reply.batch;
    // モデルの配置のヒント（UI-09、ADR 0200）。コードの束があるときだけ使い、なければ記述を変えずに理由だけを記録する。
    // 口が失敗しても発言は止めず、ヒントなし（コードの配置）にする。
    let hint: unknown;
    try {
      hint = options.layoutHint?.(turn) ?? null;
    } catch {
      hint = null;
    }
    if (batch === null && hint !== null)
      options.canvas.recordLayoutHint('no_placement');
    // 検査に反した束は当てない（前の版が残る）。発言は記録済みなので、文字の結果だけを返す。ヒントが反していれば、
    // ヒントを捨ててコードの束を当てる。
    const applied =
      batch === null ? null : options.canvas.applyHinted(batch, hint);
    const canvas =
      applied !== null && applied.outcome.ok ? applied.batch : null;
    // 本文は、当てた束の物にだけ預ける（当てられなかった本文を残さない）。
    if (canvas !== null && reply !== null)
      options.canvas.setText(reply.item_id, reply.text);
    // 当てた束の物を、この発言に結び付ける（追加と中身の更新。ADR 0187）。閉じた物の結び付きは捨てる。ヒントが足した
    // 強調・まとまりだけの update は中身を変えないので、結び付けはコードの束の操作だけで決める。
    if (canvas !== null && batch !== null)
      for (const op of batch.ops)
        if (op.op === 'add') itemTurns.set(op.item.item_id, turn.turn_id);
        else if (op.op === 'update') itemTurns.set(op.item_id, turn.turn_id);
        else if (op.op === 'close') itemTurns.delete(op.item_id);
    // 配置を試みた発言だけ覚える（聞き返しなど、配置しない発言は入れない。同じ結果なら再送でも配置しないので）。
    if (batch !== null) placed.add(turn.turn_id);
    replays.set(turn.turn_id, canvas);
    for (const old of replays.keys()) {
      if (replays.size <= MAX_REPLAYS) break;
      replays.delete(old);
    }
    // 置いた物が消えた発言・記憶を参照していれば閉じる。前の知らせで閉じ損ねた物もここで閉じ直す（当たる物があれば
    // 版がさらに進む。なければ何もしない）。
    if (goneTurns.size > 0 || goneMemories.size > 0) sweepGone();
    return canvas;
  };

  // 保留を捨てた知らせ（U120）。ターンではないので、同じ依頼の遅着と混ぜずに text の物を置く。
  const placeNotice = (notice: {
    readonly session_id: string;
    readonly workflow_id: string;
    readonly reason: string;
    readonly text: string;
  }): CanvasOpBatch | null => {
    const placement = placeHeldDropped(options.canvas.document, notice, {
      record: options.canvas.record,
      seen_revision: options.canvas.document.canvas_revision,
    });
    const canvas = options.canvas.apply(placement.batch).ok
      ? placement.batch
      : null;
    if (canvas !== null) {
      options.canvas.setText(placement.item_id, placement.text);
      // 保留を捨てた知らせは発言の結果ではない（前に置いた発言との結び付きを外す）。
      itemTurns.delete(placement.item_id);
    }
    return canvas;
  };

  // 期限切れ・忘却の知らせ（UI-05 の段階 3、ADR 0187）。RetentionNotice だけを見る（台帳の前進・記録しない会話の終了は
  // 表示の物を持たない）。発言・記憶の ID は Core の DB の行の ID で、物の参照・結び付きと照らし合わせる。
  const applyNotice = (notice: Notice): boolean => {
    if (notice.schema !== 'buddy.retention-notice.v1') return true;
    const ids = (kind: string) =>
      new Set(
        notice.items
          .filter((item) => item.item_kind === kind)
          .map((item) => item.item_id),
      );
    const turns = ids('turn');
    const memories = ids('memory');
    const summaries = ids('carried_summary');
    for (const id of turns) goneTurns.add(id);
    for (const id of memories) goneMemories.add(id);
    // この知らせと、前に閉じ損ねた物（覚えている消えた ID に結び付く物）を閉じる。消えた発言の束を再送の応答に返さない
    // （配置済みの印は残し、置き直さない）。
    const removed = sweepGone(turns, memories);
    for (const turnId of turns)
      if (replays.has(turnId)) replays.set(turnId, null);
    // 区切りにつないだ要約: 忘却なら外す（忘れた内容が今の文脈の要約に入っているかを Core は確かめられないので、安全側。
    // U466）。期限切れ・忘却で要約をつないだ区間が消えたときも外す。
    const stream = current;
    if (stream !== null) {
      const carried = stream.segment.carried_summary;
      const forgotten = notice.kind === 'forgotten';
      if (
        carried !== null &&
        (forgotten ||
          summaries.has(stream.segment.segment_id) ||
          carried.source_segment_ids.some((id) => summaries.has(id)))
      )
        current = {
          ...stream,
          segment: { ...stream.segment, carried_summary: null },
        };
      // 忘却の後の次の発言で新しい区切りを始める（要約はつながない。ADR 0068 の段階 2-i と同じ印。U383 の残り）。
      if (forgotten) afterForget = { from: stream.sessionId };
    }
    if (notice.kind === 'forgotten') forgetNotices += 1;
    return removed;
  };

  const postStreamTurn: ApiRouteHandler = async (request) => {
    const body = request.body as JsonObject;
    const requestId = stringOf(body, 'request_id');
    if (request.device === null)
      return apiErrorResponse(401, 'unauthenticated');
    // 同じ要求の再送は、区切りを選ぶ前に元の区切り（会話）で解決する。新しい区切りで送ると request_hash が変わり
    // 409 になるため（PR #191 のレビュー P1）。再送は区切りも切り替えない（経過も延ばさない）。
    // 保存側の受付レシートと同じく、接続範囲（command_scope_id）と要求 ID の組で識別する（別の接続範囲の同じ ID を
    // 再送と取り違えない。レビュー P2）。
    const scopeId = stringOf(body, 'command_scope_id');
    const acceptedKey = acceptedKeyOf(scopeId, requestId);
    let replay = acceptedIn(acceptedKey);
    // 記録しない区切りから出る途中で失敗した状態では、新しい発言を保存しない（黙って `normal` の会話を作り、
    // 端末が `private` の表示のまま発言を DB へ残さない。ADR 0060）。区切りも作らない。
    if (replay === undefined && reopenPending)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const ensured = await ensureStream(request);
    if (!ensured.ok) return ensured.response;
    let stream = ensured.stream;
    replay = acceptedIn(acceptedKey);
    // 自動の区切り（前の発言から 30 分・日付の変更）。初めての発言だけが区切りを始める。切り替えは共有の排他で
    // 行うが、**待った後はこの要求自身の再送と境界を判定し直す**（他の要求の結果を配らない。レビュー P2）。
    // 他の要求が待っていたために切り替わらなかったときは、もう一度試す。
    for (let attempt = 0; replay === undefined && attempt < 8; attempt += 1) {
      const base = current ?? stream;
      // 記録しない区切りでは自動の区切りを起こさない（会話を作れない。ADR 0060）。
      if (base.segment.storage_mode === 'private') break;
      if (acceptedIn(acceptedKey) !== undefined) break;
      // 忘却の指示を受けた区切りなら、時間・日付に関係なく新しい区切りを始める（要約はつながない）。
      const forced: 'forget_requested' | null =
        afterForget !== null && afterForget.from === base.sessionId
          ? 'forget_requested'
          : null;
      if (forced === null && boundaryOf(base, now()) === null) break;
      const before = base.sessionId;
      const rotated = await rotateSegment(
        request,
        base,
        requestId,
        acceptedKey,
        forced,
      );
      if (rotationFailure !== null) {
        const failure: {
          readonly status: number;
          readonly code: ApiErrorCode;
        } = rotationFailure;
        return apiErrorResponse(failure.status, failure.code, requestId);
      }
      if (rotated) break;
      if (acceptedIn(acceptedKey) !== undefined) break;
      if ((current?.sessionId ?? before) !== before) break;
    }
    replay = acceptedIn(acceptedKey);
    // 上限まで試してまだ区切りが要る（他の要求と競合し続けた）なら、古い区切りで答えず 503 にする
    // （区切りの理由を落とさない。レビューの任意の指摘）。記録しない区切りには自動の区切りが無いので除く。
    if (
      replay === undefined &&
      (current ?? stream).segment.storage_mode !== 'private' &&
      (boundaryOf(current ?? stream, now()) !== null ||
        (afterForget !== null &&
          afterForget.from === (current ?? stream).sessionId))
    )
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    // 再送は、元の区切り（会話）で解決する。新しい区切りで送ると request_hash が変わり 409 になる（レビュー P1）。
    // 応答の `segment` は今の区切り（表示用）。
    stream =
      replay !== undefined
        ? { ...(current ?? stream), sessionId: replay.session_id }
        : (current ?? stream);
    // この発言の保存が終わるまで、区切りの切り替えを待たせる（旧区切りの要約の材料を落とさない。レビュー P2）。
    // 再送は最初に受け付けたときの由来（会話と世代）をそのまま渡す（今の世代を渡すと、private の出入りの後に
    // request_hash が変わり 409 になる。ADR 0060）。
    const origin =
      replay !== undefined
        ? {
            segment_id: replay.session_id,
            segment_generation: replay.segment_generation,
          }
        : {
            segment_id: stream.sessionId,
            segment_generation: options.storage.origin().segment_generation,
          };
    // 記録しない区切りの発言（区切りが private で、由来がその区切り）。応答の後にも、同じ区切りのままかを確かめる。
    const privateTurn =
      stream.segment.storage_mode === 'private' &&
      origin.segment_id === stream.segment.segment_id;
    const endSave = startTurnSave(stream.sessionId);
    let inner: { readonly status: number; readonly body: object };
    try {
      // 既存の発言の処理（解釈→意味検証→承認待ちの操作の作成・読み取り）。再送の判定・照合値の違いの 409 もここ。
      inner = await options.postTurn({
        ...request,
        route: postTurnRoute,
        params: { session_id: stream.sessionId },
        body: {
          request_id: requestId,
          command_scope_id: scopeId,
          text: stringOf(body, 'text'),
          input_kind: stringOf(body, 'input_kind'),
          origin,
        },
      });
    } finally {
      endSave();
    }
    if (inner.status !== 200) return inner;
    if (!contract.valid('TurnResponse', inner.body))
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    // 記録しない区切りの結果は、応答を受けた時点でもその区切りが続いているときだけ置く。処理の間に終えた・入り直した
    // ときは、キャンバス（戻した記述）にも受付の対応にも残さず 409 にする（遅れて届いた結果を次の区切りへ持ち込まない）。
    if (
      privateTurn &&
      (options.storage.mode !== 'private' ||
        current === null ||
        current.segment.segment_id !== origin.segment_id ||
        options.storage.origin().segment_generation !==
          origin.segment_generation)
    )
      return apiErrorResponse(409, 'conflict', requestId);
    const turn = inner.body as TurnResponse;
    // 初めて受け付けた発言を、その区切りに結び付ける（再送はこの区切りで解決する）。受付レシートの有効期間だけ保ち、
    // 応答の束のキャッシュの件数では捨てない（PR #191 のレビュー P2）。
    if (replay === undefined) {
      const at = now();
      accepted.set(acceptedKey, {
        session_id: origin.segment_id,
        segment_generation: origin.segment_generation,
        expires_at: at + ACCEPTED_REQUEST_TTL_MS,
      });
      if (accepted.size >= ACCEPTED_PRUNE_THRESHOLD)
        for (const [key, value] of accepted)
          if (value.expires_at <= at) accepted.delete(key);
    }
    if (privateTurn) privateTurnIds.add(turn.turn_id);
    // 同じ要求の再送は、もう一度配置しない。配置済みかは発言の ID（turn_id。再送は保存済みの同じ発言を返す）で、
    // 応答の束のキャッシュの件数とは切り離して覚える（キャッシュから消えた後の再送でも再配置しない。そのときの束は
    // 再現できないので canvas は null）。UI-05 で発言の記録に結び付けて保存する。
    const canvas = placeTurn(turn, stringOf(body, 'expected_canvas_revision'));
    // 忘却の指示を受け付けたら、次の発言で新しい区切りを始める（要約はつながない。ADR 0032・0068）。
    // 聞き返し（対象や語が決まらない）では忘却は成立していないので、区切りを始めない。再送でも始めない。
    if (
      replay === undefined &&
      turn.status === 'answered' &&
      turn.result_view?.intent === 'memory_forget'
    )
      afterForget = { from: stream.sessionId };
    const response: StreamTurnResponse = {
      request_id: turn.request_id,
      segment: stream.segment,
      turn_id: turn.turn_id,
      input_id: turn.input_id,
      workflow_id: turn.workflow_id,
      status: turn.status,
      result_view: turn.result_view,
      reply_text: turn.reply_text,
      // 会話の操作のときだけ（端末は画面のボタンと同じ処理を行う。B05-05）。
      ...(turn.session_control == null
        ? {}
        : { session_control: turn.session_control }),
      canvas,
    };
    if (!contract.valid('StreamTurnResponse', response))
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    return { status: 200, body: response };
  };

  // 保存モードの切り替えの失敗の応答。世代を書けないときは 503（入れない・出られない・切り替わらない）、
  // 遷移の規則の拒否は 409（ADR 0059・0060）。
  const storageModeFailure = (reason: string, requestId: string) =>
    reason === 'persist_unavailable' ||
    reason === 'persist_failed' ||
    reason === 'closed'
      ? apiErrorResponse(503, 'dependency_unavailable', requestId)
      : apiErrorResponse(409, 'conflict', requestId);

  // 区切りの始まりの理由を付けて区切りを作る（契約と domain の検査を通るものだけ。ADR 0032）。
  const openedSegment = (
    origin: {
      readonly segment_id: string;
      readonly storage_mode: StreamStorageMode;
    },
    openReason: StreamSegment['open_reason'],
    carriedSummary: StreamSegment['carried_summary'],
  ): StreamSegment | null => {
    const segment: StreamSegment = {
      segment_id: origin.segment_id,
      storage_mode: origin.storage_mode,
      opened_at: new Date(now()).toISOString(),
      open_reason: openReason,
      carried_summary: carriedSummary,
    };
    return contract.valid('StreamSegment', segment) &&
      streamSegmentErrors(segment).length === 0
      ? segment
      : null;
  };

  // 出る先の保存モードで会話を作る（会話の作成は保存境界の保持者の状態を書き換えない。2a）。端末の `request_id` は
  // 渡さない（会話の受付レシートは 7 日残るので、再起動をまたいだ再送で前の会話が返ると、由来の控えが無いまま
  // その会話を区切りにしてしまい、以後の発言がすべて 409 になる）。切り替えの重複は `modeOps` で防ぐ。
  const createSessionWithMode = async (
    mode: StreamStorageMode,
    request: ApiHandlerRequest,
  ): Promise<
    | { readonly ok: true; readonly sessionId: string }
    | {
        readonly ok: false;
        readonly response: { status: number; body: object };
      }
  > => {
    const created = await options.createSession({
      ...request,
      route: createSessionRoute,
      params: {},
      body: {
        request_id: randomUUID(),
        command_scope_id: stringOf(request.body, 'command_scope_id'),
        storage_mode: mode,
      },
    });
    const body = created.body as { session_id?: unknown };
    if (created.status !== 201 || typeof body.session_id !== 'string')
      return {
        ok: false,
        response: { status: created.status, body: created.body },
      };
    return { ok: true, sessionId: body.session_id };
  };

  // 保存モードを切り替えたことを購読へ知らせる（UI-05 の段階 6、ADR 0189、U477）。理由は記録しないに入った・出た・それ以外の
  // 保存モードの変更（区切りがまだなかった・作り直し待ちだったときの区切りの理由は stream_started でも、保存モードは変わり得るので
  // 知らせる）。知らせの失敗は切り替えの失敗にしない（端末は接続・ロック解除・発言の後にも読み直す）。
  const announce = (
    segment: StreamSegment,
    reason: StorageModeNotice['reason'],
  ): void => {
    try {
      options.announceStorageMode?.({
        schema: 'buddy.storage-mode-notice.v1',
        occurred_at: segment.opened_at,
        storage_mode: segment.storage_mode,
        reason,
      });
    } catch {
      // 知らせを渡せなくても、切り替えは確定している。
    }
  };

  // 保存モードを切り替える（U170、ADR 0060）。流れの経路を保存モードの唯一の入口・出口にし、private の出入りも
  // ここへ寄せる。端末は会話・区切りの ID を送らない（UI-01）。成功したら区切りを開き直す。
  // - private へ入る: ゲートの enterPrivate。書けなければ入れない（503）。区切りは要約をつながない private_started。
  // - private から出る: 先にゲートの exitPrivate（世代を進めてファイルへ書く）。書けなければ出られない（503）。
  //   その後に出る先の保存モードで会話を作る。区切りは private_ended。
  // - normal ⇔ extended: 出る先の保存モードで会話を作る（会話の保存モードは DB の sessions.storage_mode）。
  //   保存境界の保持者のモードと世代は書き換えない（会話ごとの由来。2a）。区切りは storage_mode_changed で、
  //   要約は nextCarriedSummary の規則の範囲でだけつなぐ。
  const switchStorageMode = async (
    target: StreamStorageMode,
    request: ApiHandlerRequest,
  ): Promise<{ status: number; body: object }> => {
    const requestId = stringOf(request.body, 'request_id');
    // 同じモードへの切り替えは何も動かさない（区切りも世代も進めない）。
    if (current !== null && current.segment.storage_mode === target)
      return {
        status: 200,
        body: { request_id: requestId, segment: current.segment },
      };
    if (target === 'private') {
      const outcome = await options.storage.enterPrivate();
      if (!outcome.ok) return storageModeFailure(outcome.reason, requestId);
      const segment = openedSegment(outcome.origin, 'private_started', null);
      if (segment === null)
        return apiErrorResponse(503, 'dependency_unavailable', requestId);
      current = {
        sessionId: outcome.origin.segment_id,
        segment,
        lastTurnAt: segment.opened_at,
        turnExpiresAt: [],
      };
      reopenPending = false;
      // 区切りが変わったので、忘却の印は残さない（古い区切りを指したままにしない）。
      afterForget = null;
      announce(segment, 'private_started');
      return { status: 200, body: { request_id: requestId, segment } };
    }
    // 記録しない区切りから出るときは、会話を作る前にゲートを出る（記録しない区切りの間は会話の作成が拒否される）。
    let leftPrivate = false;
    if (options.storage.mode === 'private') {
      const outcome = await options.storage.exitPrivate(target);
      if (!outcome.ok) return storageModeFailure(outcome.reason, requestId);
      leftPrivate = true;
    }
    // 旧区切りで保存中の発言が終わるまで待ってから要約を確定する（その発言の保存の期限を材料に入れる。
    // PR #191 のレビュー P2）。
    const before = current;
    if (before !== null) await settledOld(before.sessionId);
    const carriedFrom = current;
    // 忘却の指示を受けた区切りからの切り替えでは、要約をつながない（忘却した内容を持ち込まない。ADR 0032・0068）。
    const forgetDue =
      afterForget !== null &&
      carriedFrom !== null &&
      afterForget.from === carriedFrom.sessionId;
    const forgetsBefore = forgetNotices;
    const created = await createSessionWithMode(target, request);
    if (!created.ok) {
      // 記録しない区切りはもう閉じている（exitPrivate は確定済みで戻せない）。使えない区切りを残すと、private の
      // 表示のまま保存境界が開いている状態を同じモードの要求で修復できなくなる。区切りを捨て、次の要求でゲートの
      // 今の状態から作り直す。作り直せるまでの新しい発言は保存しない（黙って `normal` の会話を作らない）。
      if (leftPrivate) {
        current = null;
        reopenPending = true;
      }
      return created.response;
    }
    let openReason: StreamSegment['open_reason'];
    let carriedSummary: StreamSegment['carried_summary'] = null;
    if (carriedFrom === null) {
      openReason = 'stream_started';
    } else if (carriedFrom.segment.storage_mode === 'private') {
      // 記録しない会話から出る。要約はつながない（ADR 0032）。
      openReason = 'private_ended';
    } else {
      // normal ⇔ extended。要約は、期限内の由来の範囲でだけつなぐ（ADR 0032 の nextCarriedSummary）。
      openReason = 'storage_mode_changed';
      // 会話の作成を待つ間に忘却の知らせが来たときも、つながない（ADR 0187）。
      if (!forgetDue && forgetNotices === forgetsBefore) {
        const carried = nextCarriedSummary({
          previous: carriedFrom.segment.carried_summary,
          closing: {
            segment_id: carriedFrom.segment.segment_id,
            storage_mode: carriedFrom.segment.storage_mode,
            turn_expires_at: carriedFrom.turnExpiresAt,
          },
          open_reason: openReason,
          now: new Date(now()).toISOString(),
        });
        // 契約の CarriedSummary の由来は 1 件以上（空なら nextCarriedSummary は null を返す）。
        carriedSummary =
          carried === null
            ? null
            : {
                source_segment_ids: [...carried.source_segment_ids] as [
                  string,
                  ...string[],
                ],
                expires_at: carried.expires_at,
              };
      }
    }
    const segment = openedSegment(
      { segment_id: created.sessionId, storage_mode: target },
      openReason,
      carriedSummary,
    );
    if (segment === null)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    current = {
      sessionId: created.sessionId,
      segment,
      lastTurnAt: segment.opened_at,
      turnExpiresAt: [],
    };
    reopenPending = false;
    // 区切りが変わったので、忘却の印は残さない（古い区切りを指したままにしない）。
    afterForget = null;
    announce(segment, leftPrivate ? 'private_ended' : 'storage_mode_changed');
    return { status: 200, body: { request_id: requestId, segment } };
  };

  // 保存モードの切り替えの経路（POST /v1/stream/storage-mode）。同じ request_id の再送は同じ結果を返し、内容が違えば
  // 409（07 §3）。切り替えを二度行わない（世代を二度進めない）。切り替えは自動の区切りと同じ排他で直列にする。
  // 控えは受付レシートと同じく接続範囲と要求 ID の組で識別し、同じ有効期間だけ保つ（件数では捨てない）。
  const modeOps = new Map<
    string,
    {
      readonly key: string;
      readonly response: { status: number; body: object };
      readonly expires_at: number;
    }
  >();
  const postStreamStorageMode: ApiRouteHandler = (request) => {
    if (request.device === null)
      return Promise.resolve(apiErrorResponse(401, 'unauthenticated'));
    const body = request.body as unknown as StorageModeChangeRequest;
    const requestId = body.request_id;
    const key = JSON.stringify([
      request.device.device_id,
      body.command_scope_id,
      body.storage_mode,
    ]);
    const acceptedKey = acceptedKeyOf(body.command_scope_id, requestId);
    const seen = modeOps.get(acceptedKey);
    if (seen !== undefined && seen.expires_at > now())
      return Promise.resolve(
        seen.key === key
          ? seen.response
          : apiErrorResponse(409, 'conflict', requestId),
      );
    return withExclusive(async () => {
      // 待つ間に同じ要求が終わっていれば、その結果を返す（切り替えを二度行わない）。
      const again = modeOps.get(acceptedKey);
      if (again !== undefined && again.expires_at > now())
        return again.key === key
          ? again.response
          : apiErrorResponse(409, 'conflict', requestId);
      const response = await switchStorageMode(body.storage_mode, request);
      const at = now();
      modeOps.set(acceptedKey, {
        key,
        response,
        expires_at: at + ACCEPTED_REQUEST_TTL_MS,
      });
      if (modeOps.size >= ACCEPTED_PRUNE_THRESHOLD)
        for (const [old, value] of modeOps)
          if (value.expires_at <= at) modeOps.delete(old);
      return response;
    });
  };

  // 流れの今の保存モード（GET /v1/stream/storage-mode。UI-05 の段階 6、ADR 0189）。端末が状態欄に出すために読む。
  // 記録しない区切りが開いていれば private（区切りを開き直せずに 503 を返した後も、保存境界の保持者が正本）。そうでなければ
  // 今の区切りの保存モード、まだ区切りがなければ保存境界の保持者のモード（再起動の後は通常）。区切り・会話の ID・世代は返さない。
  const getStreamStorageMode: ApiRouteHandler = (request) => {
    if (request.device === null)
      return Promise.resolve(apiErrorResponse(401, 'unauthenticated'));
    const body = {
      storage_mode:
        options.storage.mode === 'private'
          ? 'private'
          : (current?.segment.storage_mode ?? options.storage.mode),
    };
    return Promise.resolve(
      contract.valid('StreamStorageModeView', body)
        ? { status: 200, body }
        : apiErrorResponse(503, 'dependency_unavailable'),
    );
  };

  const getCanvas: ApiRouteHandler = (request) =>
    Promise.resolve(
      request.device === null
        ? apiErrorResponse(401, 'unauthenticated')
        : { status: 200, body: options.canvas.document },
    );

  // ユーザーの操作の記録（UI-06）。同じ request_id の再送は同じ結果を返し、内容が違えば 409（07 §3）。
  const userOps = new Map<
    string,
    {
      readonly key: string;
      readonly response: { status: number; body: object };
    }
  >();
  const postCanvasUserOp: ApiRouteHandler = (request) => {
    if (request.device === null)
      return Promise.resolve(apiErrorResponse(401, 'unauthenticated'));
    const body = request.body as unknown as CanvasUserOpRequest;
    const key = JSON.stringify([
      request.device.device_id,
      body.command_scope_id,
      body.expected_canvas_revision,
      body.op,
    ]);
    const replay = userOps.get(body.request_id);
    if (replay !== undefined)
      return Promise.resolve(
        replay.key === key
          ? replay.response
          : apiErrorResponse(409, 'conflict', body.request_id),
      );
    const outcome = options.canvas.applyUser(
      body.op,
      body.expected_canvas_revision,
    );
    let response: { status: number; body: object };
    // 閉じた物の、発言との結び付きを捨てる（ADR 0187 の見直し）。
    if (outcome.ok && body.op.kind === 'close')
      itemTurns.delete(body.op.item_id);
    if (outcome.ok) {
      const ok: CanvasUserOpResponse = {
        request_id: body.request_id,
        canvas_revision: outcome.revision,
      };
      response = contract.valid('CanvasUserOpResponse', ok)
        ? { status: 200, body: ok }
        : apiErrorResponse(503, 'dependency_unavailable', body.request_id);
    } else
      response =
        outcome.reason === 'schema'
          ? apiErrorResponse(503, 'dependency_unavailable', body.request_id)
          : apiErrorResponse(409, 'conflict', body.request_id);
    userOps.set(body.request_id, { key, response });
    for (const old of userOps.keys()) {
      if (userOps.size <= MAX_REPLAYS) break;
      userOps.delete(old);
    }
    return Promise.resolve(response);
  };

  // 物の中身の読み取り（UI-07）。読み取りだけで、記述・イベントの記録・保存を変えない。版が今と同じでなければ 409
  // （中身は参照と同じ順の位置で結び付くので、版がずれた中身は渡さない）。中身は模擬の合成データ（実データは B08・B09・B11）。
  const postCanvasContent: ApiRouteHandler = (request) => {
    if (request.device === null)
      return Promise.resolve(apiErrorResponse(401, 'unauthenticated'));
    const body = request.body as unknown as CanvasContentRequest;
    const document = options.canvas.document;
    const conflict = () =>
      Promise.resolve(apiErrorResponse(409, 'conflict', body.request_id));
    if (body.expected_canvas_revision !== document.canvas_revision)
      return conflict();
    const item = document.items.find((entry) => entry.item_id === body.item_id);
    if (item === undefined) return conflict();
    // 本文を開けるのはメールだけ。行の位置（item_refs）の範囲の中。
    if (
      body.open_index !== null &&
      (item.component !== 'mail_card' ||
        body.open_index >= item.data.item_refs.length)
    )
      return conflict();
    // 画面へ回した結果の text は、中枢が持つ本文を返す（U120）。ほかの部品・本文のない text は模擬の中身。
    const content = mockCanvasContent(
      item,
      body.open_index,
      options.canvas.textFor(item.item_id),
    );
    const response: CanvasContentResponse = {
      request_id: body.request_id,
      canvas_revision: document.canvas_revision,
      item_id: item.item_id,
      open_index: body.open_index,
      content,
    };
    // 自分で作った中身も、形式と意味の検査を通ったものだけを返す（通らなければ中枢の不具合として 503）。
    if (
      !contract.valid('CanvasContentResponse', response) ||
      canvasContentErrors(content, {
        component: item.component,
        refCount: item.data.item_refs.length,
        openIndex: body.open_index,
      }).length > 0
    )
      return Promise.resolve(
        apiErrorResponse(503, 'dependency_unavailable', body.request_id),
      );
    return Promise.resolve({ status: 200, body: response });
  };

  // 記録しない間の発言に結び付けた控えを捨てる（ADR 0190）。
  const discardPrivate = (): void => {
    for (const turnId of privateTurnIds) {
      placed.delete(turnId);
      replays.delete(turnId);
    }
    for (const [itemId, turnId] of [...itemTurns])
      if (privateTurnIds.has(turnId)) itemTurns.delete(itemId);
    privateTurnIds.clear();
  };
  const beginPrivate = (): void => {
    if (options.canvas.privateOpen) return;
    options.canvas.beginPrivate();
    itemTurnsBeforePrivate = new Map(itemTurns);
  };
  // 一時の記述を閉じ、入る前の記述と物の結び付きへ戻す。記録しない間に期限切れ・忘却で消えた発言・記憶に結び付く物が
  // 戻った記述にあれば、ここで閉じる（ADR 0187 の後始末を戻した記述にも当てる）。
  const endPrivate = (): void => {
    if (options.canvas.endPrivate() === null) return;
    const saved = itemTurnsBeforePrivate;
    itemTurnsBeforePrivate = null;
    if (saved !== null) {
      itemTurns.clear();
      for (const [itemId, turnId] of saved) itemTurns.set(itemId, turnId);
    }
    if (goneTurns.size > 0 || goneMemories.size > 0) sweepGone();
    else forgetClosedItems();
  };

  return {
    privateConversation: {
      begin: beginPrivate,
      end: endPrivate,
      discard: discardPrivate,
      reset: () => {
        if (!options.canvas.privateOpen) return;
        const bound = privateTurnIds.size > 0;
        discardPrivate();
        // 一時の記述が変わっていなければ閉じ直さない（ロック中の要求のたびに版を進めない）。
        if (!bound && !options.canvas.privateChanged) return;
        endPrivate();
        beginPrivate();
      },
      held: () => ({ turns: privateTurnIds.size }),
    },
    handlers: {
      postStreamTurn,
      postStreamStorageMode,
      getStreamStorageMode,
      getCanvas,
      postCanvasUserOp,
      postCanvasContent,
    },
    // 画面へ回した遅着の結果は、端末が見ていた版を持たない（Core の今の版から置く）。
    placeLate: (turn, text) =>
      placeTurn(
        turn,
        options.canvas.document.canvas_revision,
        true,
        text ?? null,
      ),
    placeNotice,
    recordTurn,
    applyNotice,
    boundItemIds: () => [...itemTurns.keys()],
  };
}
