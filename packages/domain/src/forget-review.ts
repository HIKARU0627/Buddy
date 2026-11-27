// 忘却の計画の見せ方と、忘却台帳の端末への配信の判定（設計 03 忘却と再取り込み・忘却台帳の複製、ADR 0040・0054・0180）。
//
// - forgetPlanView: domain の planForget が作った計画を、本人が確かめる形（消える物・消える指示・残る物の件数と ID）に
//   まとめる。本文・検索語は持たない（計画にもない）。実在して保留される操作と、行のない系譜だけの節点（90 日の削除で
//   行が先に消えた操作の確定内容）を分ける（ADR 0054 の引き継ぎ）。上限を超える計画は、途中までを見せずに作らない。
// - forgetLedgerDelta: 端末が持つ台帳の head（系譜・世代・entry_hash）と、中枢の台帳の連鎖を比べ、続きの項目を返すか、
//   系譜・hash の食い違い・端末が中枢より進んでいる（中枢の巻き戻し）を返す。端末は台帳の正本にならない（ADR 0040）。
// DB・鍵・時計に触れない純粋な関数。

import {
  FORGET_DELETE_ORDER,
  operationContentPurgeable,
} from './forget-plan.js';
import type { ForgetNodeKind, ForgetPlan } from './forget-plan.js';

// ---- 計画の見せ方 ----

// 消える物の種類（計画の削除の種類と、確定内容の暗号文を消す操作）。範囲（session）は削除の対象にならない。
export const FORGET_REMOVED_KINDS = [
  ...FORGET_DELETE_ORDER,
  'operation_content',
] as const satisfies readonly ForgetNodeKind[];

export type ForgetRemovedKind = (typeof FORGET_REMOVED_KINDS)[number];

// 一覧で返す ID の上限（記憶・指示・残す操作のそれぞれ）。超える計画は作らない（U387）。
export const FORGET_VIEW_ID_LIMIT = 1000;

export interface ForgetPlanViewParts {
  // 種類ごとの件数（0 件の種類は出さない。FORGET_REMOVED_KINDS の順）。
  readonly removed_counts: readonly {
    readonly kind: ForgetRemovedKind;
    readonly count: number;
  }[];
  // 消える記憶の ID（対象を含む。ID の順）。
  readonly removed_memory_ids: readonly string[];
  // 消える本人の指示の ID（ADR 0054 U112。ID の順）。
  readonly removed_directive_ids: readonly string[];
  // 残る操作のうち、行が実在するもの（状態・承認・試行を変えず、送出禁止の印だけを付ける）。
  readonly kept_operations: readonly {
    readonly operation_id: string;
    readonly state: string;
  }[];
  // 残る操作のうち、行がなく系譜だけに残る確定内容の数（DB には何も起きない）。
  readonly kept_lineage_only: number;
  // 再登録を禁じる由来の数（消さずに台帳に HMAC だけを書く）。
  readonly blocked_source_count: number;
}

export type ForgetPlanViewResult =
  | { readonly ok: true; readonly view: ForgetPlanViewParts }
  | { readonly ok: false; readonly reasons: readonly ['plan_too_large'] };

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// existingOperations は、計画を作った系譜（ForgetGraph.operations）に行がある操作の ID。
export function forgetPlanView(
  plan: ForgetPlan,
  existingOperations: ReadonlySet<string>,
): ForgetPlanViewResult {
  const counts = new Map<ForgetRemovedKind, number>();
  const add = (kind: ForgetRemovedKind, count: number): void => {
    if (count > 0) counts.set(kind, (counts.get(kind) ?? 0) + count);
  };
  const memoryIds: string[] = [];
  for (const node of plan.deletions) {
    if (!(FORGET_REMOVED_KINDS as readonly string[]).includes(node.kind))
      continue;
    add(node.kind as ForgetRemovedKind, 1);
    if (node.kind === 'memory') memoryIds.push(node.id);
  }
  add('operation_content', plan.operation_contents.purge.length);
  const kept: { operation_id: string; state: string }[] = [];
  let lineageOnly = 0;
  for (const retained of plan.operation_contents.retained) {
    if (existingOperations.has(retained.operation_id))
      kept.push({
        operation_id: retained.operation_id,
        state:
          retained.state !== 'unknown' &&
          !operationContentPurgeable(retained.state)
            ? retained.state
            : 'unknown',
      });
    else lineageOnly += 1;
  }
  const directives = [...plan.user_directives].sort(compare);
  memoryIds.sort(compare);
  kept.sort((a, b) => compare(a.operation_id, b.operation_id));
  if (
    memoryIds.length > FORGET_VIEW_ID_LIMIT ||
    directives.length > FORGET_VIEW_ID_LIMIT ||
    kept.length > FORGET_VIEW_ID_LIMIT
  )
    return { ok: false, reasons: ['plan_too_large'] };
  return {
    ok: true,
    view: {
      removed_counts: FORGET_REMOVED_KINDS.filter((kind) =>
        counts.has(kind),
      ).map((kind) => ({ kind, count: counts.get(kind) as number })),
      removed_memory_ids: memoryIds,
      removed_directive_ids: directives,
      kept_operations: kept,
      kept_lineage_only: lineageOnly,
      blocked_source_count: plan.ledger.blocked_source_hmacs.length,
    },
  };
}

// ---- 台帳の配信 ----

export const LEDGER_ZERO_ENTRY_HASH = '0'.repeat(64);
// 1 回の応答で返す項目の上限（U386）。続きは has_more で知らせ、端末は返った head から取り直す。
export const FORGET_LEDGER_DELTA_LIMIT = 256;

export interface LedgerChainLink {
  readonly entry: { readonly forgetting_generation: string };
  readonly entry_hash: string;
}

// 端末が最後に保存できた台帳の head。何も持たなければ系譜 null・世代 0・64 個の 0。
export interface LedgerReplicaHead {
  readonly ledger_id: string | null;
  readonly forgetting_generation: string;
  readonly entry_hash: string;
}

export type LedgerDeltaDecision<E extends LedgerChainLink> =
  | {
      readonly outcome: 'entries';
      readonly entries: readonly E[];
      readonly has_more: boolean;
    }
  // 端末の複製が中枢の台帳の続きでない（系譜が違う・同じ世代の hash が違う）。端末は保存せず、世代 0 から取り直す。
  | {
      readonly outcome: 'diverged';
      readonly reason: 'lineage_mismatch' | 'hash_mismatch';
    }
  // 端末が中枢より新しい世代を持つ（中枢の台帳が古い状態へ戻された疑い）。端末は複製を巻き戻さない。
  | { readonly outcome: 'replica_ahead' }
  // 中枢の台帳の連鎖が欠けている（世代が 1 から続かない）。返さない。
  | { readonly outcome: 'ledger_invalid' };

const DECIMAL = /^(0|[1-9][0-9]*)$/u;

export function forgetLedgerDelta<E extends LedgerChainLink>(
  ledger: { readonly ledger_id: string | null; readonly entries: readonly E[] },
  replica: LedgerReplicaHead,
  limit: number = FORGET_LEDGER_DELTA_LIMIT,
): LedgerDeltaDecision<E> {
  // 中枢の連鎖は世代 1 から欠番なく並ぶ（DB の trigger と書き出しの照合が守る。ここは最後の確認）。
  for (const [index, link] of ledger.entries.entries())
    if (link.entry.forgetting_generation !== String(index + 1))
      return { outcome: 'ledger_invalid' };
  if (ledger.entries.length > 0 && ledger.ledger_id === null)
    return { outcome: 'ledger_invalid' };
  if (!DECIMAL.test(replica.forgetting_generation))
    return { outcome: 'diverged', reason: 'hash_mismatch' };
  const held = BigInt(replica.forgetting_generation);
  const head = BigInt(ledger.entries.length);
  // 系譜: 端末が系譜を持つなら中枢と同じでなければならない。世代 1 以上を持つ端末は必ず系譜を持つ。
  if (replica.ledger_id !== null && replica.ledger_id !== ledger.ledger_id)
    return held > head && ledger.ledger_id === null
      ? { outcome: 'replica_ahead' }
      : { outcome: 'diverged', reason: 'lineage_mismatch' };
  if (held > head) return { outcome: 'replica_ahead' };
  if (held === 0n) {
    if (replica.entry_hash !== LEDGER_ZERO_ENTRY_HASH)
      return { outcome: 'diverged', reason: 'hash_mismatch' };
  } else {
    if (replica.ledger_id === null)
      return { outcome: 'diverged', reason: 'lineage_mismatch' };
    const link = ledger.entries[Number(held) - 1] as E;
    if (link.entry_hash !== replica.entry_hash)
      return { outcome: 'diverged', reason: 'hash_mismatch' };
  }
  const start = Number(held);
  const end = Math.min(ledger.entries.length, start + Math.max(1, limit));
  return {
    outcome: 'entries',
    entries: ledger.entries.slice(start, end),
    has_more: end < ledger.entries.length,
  };
}
