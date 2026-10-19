// 予約 R と最大負担 M による予算の受付と精算（設計 05 予約と最大負担の区別 F02、ADR 0006）。
// 金額は通貨単位の百万分の一の整数文字列で受け、BigInt で計算する。個人の金額は設定から渡す。

export interface BudgetPoolConfig {
  readonly poolId: string;
  readonly parentPoolId: string | null;
  readonly limit: string;
  readonly requiresApproval: boolean;
}

export interface BudgetSettings {
  readonly currency: string;
  readonly pools: readonly BudgetPoolConfig[];
  readonly verifiedPriceVersions: readonly string[];
}

export type ReservationStatus =
  'reserved' | 'usage_unknown' | 'settled' | 'released';

export interface ReservationRecord {
  readonly reservationId: string;
  readonly requestId: string;
  readonly poolId: string;
  readonly budgetMonth: string;
  readonly currency: string;
  readonly reserved: string;
  readonly maxLiability: string;
  readonly status: ReservationStatus;
  readonly actualGross: string | null;
  readonly providerReconciliationId: string | null;
  readonly approvalId: string | null;
  readonly revision: string;
  readonly overrunReviewed: boolean;
}

export interface AdmissionRequest {
  readonly requestId: string;
  readonly poolId: string;
  readonly budgetMonth: string;
  readonly priceVersion: string;
  readonly currency: string;
  readonly reserved: string;
  readonly maxLiability: string;
  readonly approvalId: string | null;
}

export type Failure = { readonly ok: false; readonly reasonCodes: string[] };

// 葉から根への枠の並び。未知の枠や循環は null。
export function poolPath(
  settings: BudgetSettings,
  poolId: string,
): string[] | null {
  const byId = new Map(settings.pools.map((pool) => [pool.poolId, pool]));
  const path: string[] = [];
  let current: string | null = poolId;
  while (current !== null) {
    const pool = byId.get(current);
    if (!pool || path.includes(current)) return null;
    path.push(current);
    current = pool.parentPoolId;
  }
  return path;
}

// 枠ごとの使用量。精算済みは実費、未精算は R / M、解放済みは 0。元の予算月だけに数える。
function usage(
  settings: BudgetSettings,
  reservations: readonly ReservationRecord[],
  poolId: string,
  month: string,
): { r: bigint; m: bigint } {
  let r = 0n;
  let m = 0n;
  for (const item of reservations) {
    if (item.budgetMonth !== month || item.status === 'released') continue;
    if (!poolPath(settings, item.poolId)?.includes(poolId)) continue;
    if (item.status === 'settled') {
      const actual = BigInt(item.actualGross ?? '0');
      r += actual;
      m += actual;
    } else {
      r += BigInt(item.reserved);
      m += BigInt(item.maxLiability);
    }
  }
  return { r, m };
}

function limitReasons(
  settings: BudgetSettings,
  reservations: readonly ReservationRecord[],
  path: readonly string[],
  month: string,
  addR: bigint,
  addM: bigint,
): string[] {
  const reasons: string[] = [];
  const byId = new Map(settings.pools.map((pool) => [pool.poolId, pool]));
  for (const poolId of path) {
    const limit = BigInt(byId.get(poolId)?.limit ?? '0');
    const used = usage(settings, reservations, poolId, month);
    if (used.r + addR > limit) reasons.push(`r_limit:${poolId}`);
    if (used.m + addM > limit) reasons.push(`m_limit:${poolId}`);
  }
  return reasons;
}

// M を超えた実費が確認されるまで、その枠と子孫の枠への新規受付を止める。
function overrunHolds(
  reservations: readonly ReservationRecord[],
  path: readonly string[],
): string[] {
  return reservations
    .filter(
      (item) =>
        item.status === 'settled' &&
        !item.overrunReviewed &&
        BigInt(item.actualGross ?? '0') > BigInt(item.maxLiability) &&
        path.includes(item.poolId),
    )
    .map((item) => `overrun_hold:${item.poolId}`)
    .filter((reason, index, all) => all.indexOf(reason) === index);
}

export function admitBudget(
  settings: BudgetSettings,
  reservations: readonly ReservationRecord[],
  request: AdmissionRequest,
): { readonly admitted: boolean; readonly reasonCodes: string[] } {
  const reasons: string[] = [];
  const path = poolPath(settings, request.poolId);
  if (!path) return { admitted: false, reasonCodes: ['unknown_pool'] };
  if (reservations.some((item) => item.requestId === request.requestId))
    reasons.push('duplicate_request');
  if (request.currency !== settings.currency) reasons.push('currency_mismatch');
  if (!settings.verifiedPriceVersions.includes(request.priceVersion))
    reasons.push('price_unverified');
  if (BigInt(request.reserved) > BigInt(request.maxLiability))
    reasons.push('reservation_exceeds_max');
  const needsApproval = settings.pools.some(
    (pool) => path.includes(pool.poolId) && pool.requiresApproval,
  );
  if (needsApproval && request.approvalId === null)
    reasons.push('approval_required');
  reasons.push(...overrunHolds(reservations, path));
  reasons.push(
    ...limitReasons(
      settings,
      reservations,
      path,
      request.budgetMonth,
      BigInt(request.reserved),
      BigInt(request.maxLiability),
    ),
  );
  return { admitted: reasons.length === 0, reasonCodes: reasons };
}

// 追加予約は同じ行の R / M を増やし、追加分だけを受付検査する。
export function topUpReservation(
  settings: BudgetSettings,
  reservations: readonly ReservationRecord[],
  reservationId: string,
  expectedRevision: string,
  deltaReserved: string,
  deltaMaxLiability: string,
): { readonly ok: true; readonly reservation: ReservationRecord } | Failure {
  const current = reservations.find(
    (item) => item.reservationId === reservationId,
  );
  if (!current) return { ok: false, reasonCodes: ['unknown_reservation'] };
  if (current.revision !== expectedRevision)
    return { ok: false, reasonCodes: ['revision_conflict'] };
  if (current.status !== 'reserved')
    return { ok: false, reasonCodes: ['not_active'] };
  const reserved = BigInt(current.reserved) + BigInt(deltaReserved);
  const maxLiability = BigInt(current.maxLiability) + BigInt(deltaMaxLiability);
  const path = poolPath(settings, current.poolId) ?? [];
  const reasons = [
    ...(reserved > maxLiability ? ['reservation_exceeds_max'] : []),
    ...overrunHolds(reservations, path),
    ...limitReasons(
      settings,
      reservations,
      path,
      current.budgetMonth,
      BigInt(deltaReserved),
      BigInt(deltaMaxLiability),
    ),
  ];
  if (reasons.length) return { ok: false, reasonCodes: reasons };
  return {
    ok: true,
    reservation: {
      ...current,
      reserved: reserved.toString(),
      maxLiability: maxLiability.toString(),
      revision: (BigInt(current.revision) + 1n).toString(),
    },
  };
}

// 確定した usage で一度だけ精算する。元の月・元の枠のまま、M 超過も記録する。
export function settleReservation(
  reservation: ReservationRecord,
  settlement: {
    readonly requestId: string;
    readonly providerReconciliationId: string;
    readonly actualGross: string;
  },
):
  | {
      readonly ok: true;
      readonly reservation: ReservationRecord;
      readonly duplicate: boolean;
      readonly overrun: boolean;
    }
  | Failure {
  if (settlement.requestId !== reservation.requestId)
    return { ok: false, reasonCodes: ['request_mismatch'] };
  if (reservation.status === 'released')
    return { ok: false, reasonCodes: ['released'] };
  const overrun =
    BigInt(settlement.actualGross) > BigInt(reservation.maxLiability);
  if (reservation.status === 'settled') {
    const same =
      reservation.providerReconciliationId ===
        settlement.providerReconciliationId &&
      reservation.actualGross === settlement.actualGross;
    return same
      ? { ok: true, reservation, duplicate: true, overrun }
      : { ok: false, reasonCodes: ['settlement_conflict'] };
  }
  return {
    ok: true,
    duplicate: false,
    overrun,
    reservation: {
      ...reservation,
      status: 'settled',
      actualGross: settlement.actualGross,
      providerReconciliationId: settlement.providerReconciliationId,
    },
  };
}

// 応答喪失・timeout・結果の破棄では R / M を保持したまま不明にする。
export function markUsageUnknown(
  reservation: ReservationRecord,
): { readonly ok: true; readonly reservation: ReservationRecord } | Failure {
  if (reservation.status !== 'reserved')
    return { ok: false, reasonCodes: ['not_active'] };
  return { ok: true, reservation: { ...reservation, status: 'usage_unknown' } };
}

// provider へ送っていないことが記録上確実な場合だけ解放する。
export function releaseUnsent(
  reservation: ReservationRecord,
  providerRequestSent: boolean,
): { readonly ok: true; readonly reservation: ReservationRecord } | Failure {
  if (reservation.status === 'settled')
    return { ok: false, reasonCodes: ['already_settled'] };
  if (reservation.status === 'released')
    return { ok: false, reasonCodes: ['released'] };
  if (providerRequestSent || reservation.status === 'usage_unknown')
    return { ok: false, reasonCodes: ['possibly_sent'] };
  return { ok: true, reservation: { ...reservation, status: 'released' } };
}
