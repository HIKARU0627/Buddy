// 流れ（stream）への発言とキャンバスの記述の経路（UI-03、ADR 0032）。最小の縦断で、区切り（segment）は 1 つ。
//
// - キャンバスの正本は Core（CanvasHub）。変更の束は Schema（CanvasOpBatch）と domain の意味の検査
//   （applyCanvasBatch: 読む順・参照の件数・版の連続・対象の有無など）を通ったものだけを当てる。どれかに反すれば
//   何も当てず、前の版が残る。端末へは版（canvas_revision）だけを接続中の購読に知らせ、本文を入れない。
//   端末は読み取り（getCanvas）で記述を取る。UI-03 の記述は Core の RAM にだけ持つ（保存は UI-05）。
// - 発言（postStreamTurn）は、既存の発言の処理（postTurn。模擬の解釈・意味検証・承認待ちの操作の作成）をそのまま
//   呼ぶ。会話は Core が 1 つだけ持つ（今の区切り。流れの最初の発言で作る。自動の区切りの規則は UI-05）。応答の
//   文字の結果（result_view）から、模擬の配置者（コードの規則。placeCanvasForTurn）が変更の束を作る。
//   LLM・端末は配置を決めない。承認・停止・取消はキャンバスに置かない。
// - 端末の expected_canvas_revision は、束の元の版に使わない（Core の今の版から作る。AI が優先）。発言は版が古くても
//   受け付け、添えた版は配置者の入力（本人が見ていた版）として渡す（UI-06）。
// - ユーザーの操作（UI-06、ADR 0032）: 動かす・大きさを変える・閉じる・棚へ片付ける・棚から出すを postCanvasUserOp で
//   記録し、記述に当てる（applyCanvasUserOp）。古い版への操作は、その物の置き場所・存在が後から変わっていなければ当て、
//   変わっていれば 409 で捨てる。記録（RAM に 64 件まで）は次の配置者の入力にする。保存は UI-05。

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
  canvasBatchPlacementTargets,
  canvasContentErrors,
  streamSegmentErrors,
} from '@buddy/domain';
import type { ApiContract } from './api-contract.js';
import { createApiContract } from './api-contract.js';
import { API_ROUTES } from './api-routes.js';
import type { ApiRoute } from './api-routes.js';
import { apiErrorResponse } from './api-server.js';
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
    this.#commit(next);
    return { ok: true, revision: next.canvas_revision };
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
    if (op.kind === 'close') this.#placedAt.delete(op.item_id);
    else this.#placedAt.set(op.item_id, next.canvas_revision);
    this.#record = [
      ...this.#record,
      {
        kind: op.kind,
        item_id: op.item_id,
        cell: 'cell' in op ? { ...op.cell } : null,
        canvas_revision: next.canvas_revision,
      },
    ].slice(-CANVAS_USER_RECORD_LIMIT);
    this.#commit(next);
    return { ok: true, revision: next.canvas_revision };
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

// --- 経路 ---

export interface StreamRoutesOptions {
  readonly canvas: CanvasHub;
  // 既存の会話・発言の処理（api-turns.ts の createSession・postTurn）。関数として呼ぶだけで、中身は変えない。
  readonly createSession: ApiRouteHandler;
  readonly postTurn: ApiRouteHandler;
  readonly contract?: ApiContract;
  readonly now?: () => number;
  // 模擬の配置者の差し替え（試験用。検査に反する束を当てようとしても前の版が残ることを確かめる）。
  readonly place?: typeof placeCanvasForTurn;
}

export interface StreamRoutes {
  readonly handlers: Readonly<Record<string, ApiRouteHandler>>;
  // 声で返せなかった結果（接続が閉じた・文字へ切り替えた・世代が違う）を画面へ回す（B05-05、ADR 0052）。発言の結果と同じ
  // 配置者の規則・意味の検査を通して、キャンバスへ置く。配置済みの発言は重ねて置かない。置いた束を返す（置かなければ null）。
  readonly placeLate: (turn: TurnResponse) => CanvasOpBatch | null;
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

interface Stream {
  readonly sessionId: string;
  readonly segment: StreamSegment;
}

type EnsureResult =
  | { readonly ok: true; readonly stream: Stream }
  | { readonly ok: false; readonly response: { status: number; body: object } };

export function createStreamRoutes(options: StreamRoutesOptions): StreamRoutes {
  const contract = options.contract ?? createApiContract();
  const now = options.now ?? (() => Date.now());
  const createSessionRoute = routeOf('createSession');
  const postTurnRoute = routeOf('postTurn');
  let current: Stream | null = null;
  let creating: Promise<EnsureResult> | null = null;
  // 前に当てた束（応答のキャッシュ。上限つき）と、配置を済ませた発言の ID（上限なし。1 人の流れの RAM だけ）。
  const replays = new Map<string, CanvasOpBatch | null>();
  const placed = new Set<string>();

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
      current = { sessionId: body.session_id, segment };
      return { ok: true, stream: current };
    })().finally(() => {
      creating = null;
    });
    return creating;
  };

  // 発言の結果をキャンバスへ置く（発言の応答と、画面へ回した遅着の結果で共通）。同じ発言は重ねて置かない（再送・遅着の重複）。
  const placeTurn = (
    turn: TurnResponse,
    seenRevision: string,
  ): CanvasOpBatch | null => {
    if (placed.has(turn.turn_id)) return replays.get(turn.turn_id) ?? null;
    const batch = (options.place ?? placeCanvasForTurn)(
      options.canvas.document,
      turn.result_view,
      { record: options.canvas.record, seen_revision: seenRevision },
    );
    // 検査に反した束は当てない（前の版が残る）。発言は記録済みなので、文字の結果だけを返す。
    const canvas =
      batch !== null && options.canvas.apply(batch).ok ? batch : null;
    // 配置を試みた発言だけ覚える（聞き返しなど、配置しない発言は入れない。同じ結果なら再送でも配置しないので）。
    if (batch !== null) placed.add(turn.turn_id);
    replays.set(turn.turn_id, canvas);
    for (const old of replays.keys()) {
      if (replays.size <= MAX_REPLAYS) break;
      replays.delete(old);
    }
    return canvas;
  };

  const postStreamTurn: ApiRouteHandler = async (request) => {
    const body = request.body as JsonObject;
    const requestId = stringOf(body, 'request_id');
    if (request.device === null)
      return apiErrorResponse(401, 'unauthenticated');
    const ensured = await ensureStream(request);
    if (!ensured.ok) return ensured.response;
    const { stream } = ensured;
    // 既存の発言の処理（解釈→意味検証→承認待ちの操作の作成・読み取り）。再送の判定・照合値の違いの 409 もここ。
    const inner = await options.postTurn({
      ...request,
      route: postTurnRoute,
      params: { session_id: stream.sessionId },
      body: {
        request_id: requestId,
        command_scope_id: stringOf(body, 'command_scope_id'),
        text: stringOf(body, 'text'),
        input_kind: stringOf(body, 'input_kind'),
      },
    });
    if (inner.status !== 200) return inner;
    if (!contract.valid('TurnResponse', inner.body))
      return apiErrorResponse(503, 'dependency_unavailable', requestId);
    const turn = inner.body as TurnResponse;
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
    const content = mockCanvasContent(item, body.open_index);
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
    placeLate: (turn) =>
      placeTurn(turn, options.canvas.document.canvas_revision),
  };
}
