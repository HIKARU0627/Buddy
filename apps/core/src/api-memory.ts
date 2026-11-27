// 記憶の一覧の経路（UI-10 の忘却の画面の左の一覧。設計 03、ADR 0040 U40・0180・0183）。
//
// 経路の検査（端末トークン・自宅判定・ロック解除・本人の画面操作）は api-server の admission が先に行う。
// - 保存中・見直し待ちの記憶を、保存の新しい順に最大 1000 件返す。本文（要約）は要求ごとに読むデータ鍵で封筒を開いて返す。
//   開けない行・データ鍵がないときは一覧全体を 503 にする（黙って落とさない。気づきの一覧と同じ）。
// - 対象キー・内容の HMAC（dedupe_key）・由来の ID・元サービスの生の ID は返さない。由来は種類ごとの件数だけ（U388 と同じ考え）。
// - 忘却の公開ゲート（U112・U382）の今の値を添える。開けるのは中枢のコードの定数だけで、この経路はゲートを読むだけ。
//   一覧は読み取りなので、ゲートが閉じていても返す（画面は計画・実行の操作を「まだ使えません」と無効にする）。
// - 保存してよい記憶の種類の設定（ADR 0191）: 読み取り（GET /v1/memory/settings）は一覧と同じ検査、変更（POST）は本人の画面
//   操作で接続範囲つき。版は保存層が同じ transaction で照合し、違えば 409（同じ要求の再送も 409）。種類の全部を受け取る。
// 拒否の本文は ApiError だけ。

import type {
  MemoryListItem,
  MemoryListResponse,
  MemorySettings,
} from '@buddy/contracts';
import type {
  DataKeyMaterial,
  DbWorkerClient,
  MemoryKindName,
  MemoryListRow,
  MemorySettingsValue,
} from '@buddy/storage';
import { MEMORY_KIND_NAMES, MEMORY_LIST_MAX } from '@buddy/storage';
import { apiErrorResponse } from './api-server.js';
import type { ApiRouteHandler } from './api-server.js';
import { openSealedText } from './sealed-text.js';

// 契約の MemoryListItem.text の上限（記憶の要約は 80 文字まで。MemoryRecord と同じ）。
const TEXT_MAX_CODE_POINTS = 80;

export interface MemoryRoutesOptions {
  readonly store: Pick<DbWorkerClient, 'memory'>;
  // データ鍵（要求ごとに読む。保持しない）。読めなければ null。
  readonly dataKey: () => Promise<DataKeyMaterial | null>;
  // 忘却の公開ゲート。製品は FORGET_PUBLIC_GATE_OPEN を読む関数を渡す（ForgetService と同じ値）。
  readonly gate: () => boolean;
  // UTC の Unix ミリ秒（削除の期限を過ぎた記憶を出さない判定に使う）。
  readonly now: () => number;
}

export interface MemoryRoutes {
  readonly handlers: {
    readonly listMemories: ApiRouteHandler;
    readonly getMemorySettings: ApiRouteHandler;
    readonly changeMemorySettings: ApiRouteHandler;
  };
}

const settingsBody = (value: MemorySettingsValue): MemorySettings => ({
  schema: 'buddy.memory-settings.v1',
  allowed_kinds: [...value.allowed_kinds] as MemorySettings['allowed_kinds'],
  memory_settings_revision: value.settings_revision,
});

const REVISION = /^(0|[1-9][0-9]*)$/u;

const iso = (millis: number): string => new Date(millis).toISOString();

// 1 行を契約の形にする。本文を開けない・空・上限を超える行は null（一覧全体を 503 にする）。
function itemOf(
  dataKey: DataKeyMaterial,
  row: MemoryListRow,
): MemoryListItem | null {
  if (row.text === null) return null;
  const text = openSealedText(
    dataKey,
    row.text,
    { ownerTable: 'memories', ownerId: row.memory_id, purpose: 'memory_text' },
    TEXT_MAX_CODE_POINTS,
  );
  if (text === null) return null;
  return {
    memory_id: row.memory_id,
    origin: row.origin,
    kind: row.kind,
    text,
    status: row.status,
    created_at: iso(row.created_at),
    review_at: iso(row.review_at),
    delete_at: row.delete_at === null ? null : iso(row.delete_at),
    source_counts: {
      turn: row.source_counts.turn,
      source_item: row.source_counts.source_item,
      memory: row.source_counts.memory,
    },
  };
}

export function createMemoryRoutes(options: MemoryRoutesOptions): MemoryRoutes {
  const listMemories: ApiRouteHandler = async () => {
    let dataKey: DataKeyMaterial | null;
    try {
      dataKey = await options.dataKey();
    } catch {
      dataKey = null;
    }
    if (dataKey === null)
      return apiErrorResponse(503, 'dependency_unavailable');
    const listed = await options.store.memory({
      kind: 'memory.list',
      limit: MEMORY_LIST_MAX,
      now: options.now(),
    });
    if (!listed.ok) return apiErrorResponse(503, 'dependency_unavailable');
    const value = listed.value as {
      readonly rows: readonly MemoryListRow[];
      readonly truncated: boolean;
    };
    const items: MemoryListItem[] = [];
    for (const row of value.rows) {
      const item = itemOf(dataKey, row);
      if (item === null) return apiErrorResponse(503, 'dependency_unavailable');
      items.push(item);
    }
    const body: MemoryListResponse = {
      schema: 'buddy.memory-list.v1',
      forget_gate: options.gate() ? 'open' : 'closed',
      items,
      truncated: value.truncated,
    };
    return { status: 200, body };
  };
  const getMemorySettings: ApiRouteHandler = async () => {
    const read = await options.store.memory({ kind: 'memory.settings_get' });
    if (!read.ok) return apiErrorResponse(503, 'dependency_unavailable');
    return {
      status: 200,
      body: settingsBody(read.value as MemorySettingsValue),
    };
  };

  // 設定の変更（本人の画面操作だけ。経路の検査は api-server が先に行う）。契約の検査（種類・重なり・版の形）も api-server が
  // 先に行うが、保存層へ渡す前にもう一度確かめる。
  const changeMemorySettings: ApiRouteHandler = async (request) => {
    const body = request.body ?? {};
    const requestId =
      typeof body['request_id'] === 'string' ? body['request_id'] : null;
    const expected = body['expected_memory_settings_revision'];
    const kinds = body['allowed_kinds'];
    if (
      typeof expected !== 'string' ||
      !REVISION.test(expected) ||
      !Array.isArray(kinds) ||
      new Set(kinds).size !== kinds.length ||
      !kinds.every((kind) => MEMORY_KIND_NAMES.includes(kind as MemoryKindName))
    )
      return apiErrorResponse(422, 'invalid_input', requestId);
    const changed = await options.store.memory({
      kind: 'memory.settings_set',
      expected_revision: expected,
      allowed_kinds: kinds as MemoryKindName[],
      now: options.now(),
    });
    if (!changed.ok)
      return changed.outcome === 'rejected' &&
        changed.reasons.includes('settings_revision_conflict')
        ? apiErrorResponse(409, 'conflict', requestId)
        : apiErrorResponse(503, 'dependency_unavailable', requestId);
    return {
      status: 200,
      body: settingsBody(changed.value as MemorySettingsValue),
    };
  };

  return {
    handlers: { listMemories, getMemorySettings, changeMemorySettings },
  };
}
