// 記憶の一覧の経路（UI-10 の忘却の画面の左の一覧。設計 03、ADR 0040 U40・0180・0183）。
//
// 経路の検査（端末トークン・自宅判定・ロック解除・本人の画面操作）は api-server の admission が先に行う。
// - 保存中・見直し待ちの記憶を、保存の新しい順に最大 1000 件返す。本文（要約）は要求ごとに読むデータ鍵で封筒を開いて返す。
//   開けない行・データ鍵がないときは一覧全体を 503 にする（黙って落とさない。気づきの一覧と同じ）。
// - 対象キー・内容の HMAC（dedupe_key）・由来の ID・元サービスの生の ID は返さない。由来は種類ごとの件数だけ（U388 と同じ考え）。
// - 忘却の公開ゲート（U112・U382）の今の値を添える。開けるのは中枢のコードの定数だけで、この経路はゲートを読むだけ。
//   一覧は読み取りなので、ゲートが閉じていても返す（画面は計画・実行の操作を「まだ使えません」と無効にする）。
// 拒否の本文は ApiError だけ。

import type { MemoryListItem, MemoryListResponse } from '@buddy/contracts';
import { openBlob } from '@buddy/storage';
import type {
  DataKeyMaterial,
  DbWorkerClient,
  MemoryListRow,
} from '@buddy/storage';
import { MEMORY_LIST_MAX } from '@buddy/storage';
import { apiErrorResponse } from './api-server.js';
import type { ApiRouteHandler } from './api-server.js';

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
  readonly handlers: { readonly listMemories: ApiRouteHandler };
}

const iso = (millis: number): string => new Date(millis).toISOString();

// 1 行を契約の形にする。本文を開けない・空・上限を超える行は null（一覧全体を 503 にする）。
function itemOf(
  dataKey: DataKeyMaterial,
  row: MemoryListRow,
): MemoryListItem | null {
  if (row.text === null) return null;
  const opened = openBlob(
    dataKey,
    {
      formatVersion: row.text.format_version,
      keyId: row.text.key_id,
      nonce: row.text.nonce,
      ciphertext: row.text.ciphertext,
      tag: row.text.tag,
    },
    {
      ownerTable: 'memories',
      ownerId: row.memory_id,
      ownerVersion: 0,
      purpose: 'memory_text',
    },
  );
  if (!opened.ok) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(opened.plaintext);
  } catch {
    return null;
  }
  const length = [...text].length;
  if (length === 0 || length > TEXT_MAX_CODE_POINTS) return null;
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
  return { handlers: { listMemories } };
}
