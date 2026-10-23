// 予算の保存の試験で使う合成の設定・命令・照会（試験専用。index.ts から export しない）。
// 通貨は ISO の試験用コード XTS、上限は縮めた合成値（個人の金額・単価・為替ではない）。期待値は各試験に手で書く。

import type { BudgetSettings } from '@buddy/domain';
import type { BudgetOp, BudgetRequestRef, SqliteDatabase } from './index.js';

// 枠の木（ADR 0006 の J17 の形を縮めたもの）。llm・search は llm_search の子、llm.background は llm の子。
// voice と overage（承認の要る超過枠）は独立。
export const SETTINGS: BudgetSettings = {
  currency: 'XTS',
  pools: [
    {
      poolId: 'llm_search',
      parentPoolId: null,
      limit: '100',
      requiresApproval: false,
    },
    {
      poolId: 'llm',
      parentPoolId: 'llm_search',
      limit: '80',
      requiresApproval: false,
    },
    {
      poolId: 'llm.background',
      parentPoolId: 'llm',
      limit: '30',
      requiresApproval: false,
    },
    {
      poolId: 'search',
      parentPoolId: 'llm_search',
      limit: '40',
      requiresApproval: false,
    },
    {
      poolId: 'voice',
      parentPoolId: null,
      limit: '50',
      requiresApproval: false,
    },
    {
      poolId: 'overage',
      parentPoolId: null,
      limit: '60',
      requiresApproval: true,
    },
  ],
  verifiedPriceVersions: ['price-1'],
};

// 本人の依頼の枠（超過枠へ回せる枠の許可リスト）。
export const OWNER_ROUTE = {
  routable_pool_ids: ['llm'],
  overage_pool_id: 'overage',
} as const;

export const TIME_ZONE = 'Asia/Tokyo';
// 東京の 2030 年 10 月の中ほど・11 月の初め（UTC）。
export const OCT_15 = Date.parse('2030-10-15T00:00:00.000Z');
export const NOV_02 = Date.parse('2030-11-02T00:00:00.000Z');

// 合成の UUID（v4 の形）。n は 1〜0xffffffffffff。
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export function request(n: number, hash = 'a'): BudgetRequestRef {
  return {
    command_scope_id: uuid(0xe00000 + n),
    request_id: uuid(0xe10000 + n),
    request_hash: hash.repeat(64),
    command_id: uuid(0xe20000 + n),
  };
}

export function admitOp(
  n: number,
  amounts: { readonly reserved: string; readonly max: string },
  overrides: Partial<Extract<BudgetOp, { kind: 'budget.admit' }>> = {},
): Extract<BudgetOp, { kind: 'budget.admit' }> {
  return {
    kind: 'budget.admit',
    reservation_id: uuid(0xa00000 + n),
    request_id: uuid(0xb00000 + n),
    profile_id: 'intent.luna.v1',
    pool_id: 'llm',
    origin: 'owner_request',
    budget_month: '2030-10',
    price_version: 'price-1',
    currency: 'XTS',
    reserved_amount: amounts.reserved,
    max_liability: amounts.max,
    settings: SETTINGS,
    overage: null,
    now: OCT_15,
    ...overrides,
  };
}

export const reservationId = (n: number): string => uuid(0xa00000 + n);
export const budgetRequestId = (n: number): string => uuid(0xb00000 + n);
export const approvalId = (n: number): string => uuid(0xc00000 + n);

export const count = (db: SqliteDatabase, sql: string): number =>
  db.prepare(sql).pluck().get() as number;

// 予約の行（金額は BigInt で読み、10 進の文字列にする）。
export function reservationRow(
  db: SqliteDatabase,
  id: string,
): Record<string, unknown> | undefined {
  const row = db
    .prepare(
      'SELECT pool_id, budget_month, status, reserved_amount, max_liability, reservation_revision, actual_gross, provider_reconciliation_id, settlement_kind, settled_at, overrun_reviewed, overrun_reviewed_at, approval_id FROM budget_reservations WHERE reservation_id = ?',
    )
    .safeIntegers(true)
    .get(id) as Record<string, unknown> | undefined;
  if (row === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? value.toString() : value,
    ]),
  );
}
