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

import { randomUUID } from 'node:crypto';
import type {
  CanvasCell,
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
  TurnResponse,
} from '@buddy/contracts';
import {
  applyCanvasBatch,
  applyCanvasUserOp,
  automaticSegmentBoundary,
  canvasBatchPlacementTargets,
  canvasContentErrors,
  nextCarriedSummary,
  streamSegmentErrors,
} from '@buddy/domain';
import type { AutomaticSegmentBoundaryReason } from '@buddy/domain';
import type { ApiContract } from './api-contract.js';
import { createApiContract } from './api-contract.js';
import { API_ROUTES } from './api-routes.js';
import type { ApiRoute } from './api-routes.js';
import { apiErrorResponse } from './api-server.js';
import type { ApiErrorCode } from './api-server.js';
import { mockCanvasContent } from './canvas-content.js';
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

// キャンバスの正本（Core の RAM）。1 人に 1 本の流れの、今の記述。
export class CanvasHub {
  readonly #contract: ApiContract;
  readonly #listeners = new Set<(revision: string) => void>();
  #document: CanvasDocument = EMPTY_CANVAS;
  // 物ごとの、置き場所・存在が最後に変わった版（UI-06。古い版へのユーザーの操作を当ててよいかに使う）。
  #placedAt = new Map<string, string>();
  #record: CanvasUserRecordEntry[] = [];
  // 物の本文（U120）。記述・イベント・ログには載せず、content の経路でだけ返す（ADR 0032・0066）。
  #texts = new Map<string, string>();

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
  // 保存境界の保持者（今の区切りの世代）。流れの発言の由来に使う（ADR 0045・0059）。
  readonly storage: { origin(): { readonly segment_generation: string } };
  readonly contract?: ApiContract;
  readonly now?: () => number;
  // 本人の時間帯（自動の区切りの日付の判定。設計 07 §5 の設定と同じ値。既定は +09:00）。
  readonly utcOffset?: string;
  // 模擬の配置者の差し替え（試験用。検査に反する束を当てようとしても前の版が残ることを確かめる）。
  readonly place?: typeof placeCanvasForTurn;
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
  let creating: Promise<EnsureResult> | null = null;
  // 自動の区切りで区切りを始める処理（同時の発言で二重に区切らないよう直列にする）。
  let rotating: Promise<boolean> | null = null;
  // 前に当てた束（応答のキャッシュ。上限つき）と、配置を済ませた発言の ID（上限なし。1 人の流れの RAM だけ）。
  const replays = new Map<string, CanvasOpBatch | null>();
  const placed = new Set<string>();
  // 受け付けた発言の要求（request_id）→ 元の区切り（会話）と受付レシートの期限。同じ要求の再送は、区切りを
  // 切り替える前にこの対応で解決する（新しい区切りで送ると request_hash が変わり 409 になる。PR #191 のレビュー P1）。
  // 応答の束のキャッシュ（MAX_REPLAYS）とは別に、受付レシートの有効期間（`command_receipt` の 7 日。設計 03）だけ保つ。
  // 再送の判定を応答のキャッシュの件数で捨てると、その後の再送が 409 になる（レビュー P2）。
  const accepted = new Map<
    string,
    { readonly session_id: string; readonly expires_at: number }
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
    | { readonly session_id: string; readonly expires_at: number }
    | undefined => {
    const entry = accepted.get(key);
    return entry !== undefined && entry.expires_at > now() ? entry : undefined;
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
  ): Promise<boolean> => {
    rotating ??= (async (): Promise<boolean> => {
      rotationFailure = null;
      const started = current;
      if (started === null) return false;
      // 先に別の発言が区切った（または最初の区切りを作り直した）なら、今の区切りを使う。
      if (started.sessionId !== from.sessionId) return false;
      if (boundaryOf(started, now()) === null) return false;
      // 旧区切りで保存を待っている発言が終わるまで待つ（その発言の期限を要約の材料に入れる）。
      await settledOld(started.sessionId);
      // 待つ間に、この要求が保存を終えて受付に登録されていれば、切り替えない（再送として元の区切りで解決する）。
      if (acceptedIn(acceptedKey) !== undefined) return false;
      const stream = current;
      if (stream === null) return false;
      if (stream.sessionId !== started.sessionId) return false;
      // 待つ間に発言が保存されていれば、経過はその発言から測り直す（区切りが要らなくなっていれば切らない）。
      const at = now();
      const reason = boundaryOf(stream, at);
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
        carried_summary: carried,
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
      return true;
    })().finally(() => {
      rotating = null;
    });
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
    // 検査に反した束は当てない（前の版が残る）。発言は記録済みなので、文字の結果だけを返す。
    const canvas =
      batch !== null && options.canvas.apply(batch).ok ? batch : null;
    // 本文は、当てた束の物にだけ預ける（当てられなかった本文を残さない）。
    if (canvas !== null && reply !== null)
      options.canvas.setText(reply.item_id, reply.text);
    // 配置を試みた発言だけ覚える（聞き返しなど、配置しない発言は入れない。同じ結果なら再送でも配置しないので）。
    if (batch !== null) placed.add(turn.turn_id);
    replays.set(turn.turn_id, canvas);
    for (const old of replays.keys()) {
      if (replays.size <= MAX_REPLAYS) break;
      replays.delete(old);
    }
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
    if (canvas !== null)
      options.canvas.setText(placement.item_id, placement.text);
    return canvas;
  };

  const postStreamTurn: ApiRouteHandler = async (request) => {
    const body = request.body as JsonObject;
    const requestId = stringOf(body, 'request_id');
    if (request.device === null)
      return apiErrorResponse(401, 'unauthenticated');
    const ensured = await ensureStream(request);
    if (!ensured.ok) return ensured.response;
    let stream = ensured.stream;
    // 同じ要求の再送は、区切りを選ぶ前に元の区切り（会話）で解決する。新しい区切りで送ると request_hash が変わり
    // 409 になるため（PR #191 のレビュー P1）。再送は区切りも切り替えない（経過も延ばさない）。
    // 保存側の受付レシートと同じく、接続範囲（command_scope_id）と要求 ID の組で識別する（別の接続範囲の同じ ID を
    // 再送と取り違えない。レビュー P2）。
    const scopeId = stringOf(body, 'command_scope_id');
    const acceptedKey = acceptedKeyOf(scopeId, requestId);
    let replay = acceptedIn(acceptedKey);
    // 自動の区切り（前の発言から 30 分・日付の変更）。初めての発言だけが区切りを始める。切り替えは共有の排他で
    // 行うが、**待った後はこの要求自身の再送と境界を判定し直す**（他の要求の結果を配らない。レビュー P2）。
    // 他の要求が待っていたために切り替わらなかったときは、もう一度試す。
    for (let attempt = 0; replay === undefined && attempt < 8; attempt += 1) {
      const base = current ?? stream;
      if (acceptedIn(acceptedKey) !== undefined) break;
      if (boundaryOf(base, now()) === null) break;
      const before = base.sessionId;
      const rotated = await rotateSegment(
        request,
        base,
        requestId,
        acceptedKey,
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
    // （区切りの理由を落とさない。レビューの任意の指摘）。
    if (replay === undefined && boundaryOf(current ?? stream, now()) !== null)
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    // 再送は、元の区切り（会話）で解決する。新しい区切りで送ると request_hash が変わり 409 になる（レビュー P1）。
    // 応答の `segment` は今の区切り（表示用）。
    stream =
      replay !== undefined
        ? { ...(current ?? stream), sessionId: replay.session_id }
        : (current ?? stream);
    // この発言の保存が終わるまで、区切りの切り替えを待たせる（旧区切りの要約の材料を落とさない。レビュー P2）。
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
          origin: {
            segment_id: stream.sessionId,
            segment_generation: options.storage.origin().segment_generation,
          },
        },
      });
    } finally {
      endSave();
    }
    if (inner.status !== 200) return inner;
    if (!contract.valid('TurnResponse', inner.body))
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const turn = inner.body as TurnResponse;
    // 初めて受け付けた発言を、その区切りに結び付ける（再送はこの区切りで解決する）。受付レシートの有効期間だけ保ち、
    // 応答の束のキャッシュの件数では捨てない（PR #191 のレビュー P2）。
    if (replay === undefined) {
      const at = now();
      accepted.set(acceptedKey, {
        session_id: stream.sessionId,
        expires_at: at + ACCEPTED_REQUEST_TTL_MS,
      });
      if (accepted.size >= ACCEPTED_PRUNE_THRESHOLD)
        for (const [key, value] of accepted)
          if (value.expires_at <= at) accepted.delete(key);
    }
    // 同じ要求の再送は、もう一度配置しない。配置済みかは発言の ID（turn_id。再送は保存済みの同じ発言を返す）で、
    // 応答の束のキャッシュの件数とは切り離して覚える（キャッシュから消えた後の再送でも再配置しない。そのときの束は
    // 再現できないので canvas は null）。UI-05 で発言の記録に結び付けて保存する。
    const canvas = placeTurn(turn, stringOf(body, 'expected_canvas_revision'));
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

  return {
    handlers: {
      postStreamTurn,
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
  };
}
