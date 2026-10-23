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
// - 端末の expected_canvas_revision は、今の UI-03 では束の元の版に使わない（Core の今の版から作る）。
//   ユーザーが動かした・閉じたことを前の状態として返す仕組みは UI-06。

import { randomUUID } from 'node:crypto';
import type {
  CanvasDocument,
  CanvasItem,
  CanvasOpBatch,
  StreamSegment,
  StreamTurnResponse,
  TurnResponse,
} from '@buddy/contracts';
import { applyCanvasBatch, streamSegmentErrors } from '@buddy/domain';
import type { ApiContract } from './api-contract.js';
import { createApiContract } from './api-contract.js';
import { API_ROUTES } from './api-routes.js';
import type { ApiRoute } from './api-routes.js';
import { apiErrorResponse } from './api-server.js';
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

// キャンバスの正本（Core の RAM）。1 人に 1 本の流れの、今の記述。
export class CanvasHub {
  readonly #contract: ApiContract;
  readonly #listeners = new Set<(revision: string) => void>();
  #document: CanvasDocument = EMPTY_CANVAS;

  constructor(contract: ApiContract = createApiContract()) {
    this.#contract = contract;
  }

  get document(): CanvasDocument {
    return this.#document;
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
    this.#document = next;
    for (const listener of [...this.#listeners]) {
      try {
        listener(next.canvas_revision);
      } catch {
        // 1 つの購読の失敗で他の購読と、当てた記述を止めない。
      }
    }
    return { ok: true, revision: next.canvas_revision };
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

export function placeCanvasForTurn(
  canvas: CanvasDocument,
  view: ScheduleViewLike | null,
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
  const item: CanvasItem = {
    item_id: ERRANDS_ITEM_ID,
    kind: 'card',
    component: 'list',
    heading: ERRANDS_HEADING,
    emphasis,
    group: null,
    relations: [],
    // 左から 2 列目から 4 列分・3 行分（最後の位置は端末の配置が決める）。
    grid: { column: 2, span: 4, rows: 3 },
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
    let canvas: CanvasOpBatch | null;
    if (placed.has(turn.turn_id)) canvas = replays.get(turn.turn_id) ?? null;
    else {
      const batch = (options.place ?? placeCanvasForTurn)(
        options.canvas.document,
        turn.result_view,
      );
      // 検査に反した束は当てない（前の版が残る）。発言は記録済みなので、文字の結果だけを返す。
      canvas = batch !== null && options.canvas.apply(batch).ok ? batch : null;
      // 配置を試みた発言だけ覚える（聞き返しなど、配置しない発言は入れない。同じ結果なら再送でも配置しないので）。
      if (batch !== null) placed.add(turn.turn_id);
      replays.set(turn.turn_id, canvas);
      for (const old of replays.keys()) {
        if (replays.size <= MAX_REPLAYS) break;
        replays.delete(old);
      }
    }
    const response: StreamTurnResponse = {
      request_id: turn.request_id,
      segment: stream.segment,
      turn_id: turn.turn_id,
      input_id: turn.input_id,
      workflow_id: turn.workflow_id,
      status: turn.status,
      result_view: turn.result_view,
      reply_text: turn.reply_text,
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

  return { handlers: { postStreamTurn, getCanvas } };
}
