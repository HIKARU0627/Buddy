// 予約 R と最大負担 M による予算の受付と精算（設計 05 予約と最大負担の区別 F02、ADR 0006）。
// 金額は通貨単位の百万分の一の整数文字列で受け、BigInt で計算する。個人の金額は設定から渡す。

import type { BudgetOrigin } from './budget-rules.js';

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

// 契約の BudgetReservation に対応する（ADR 0034 の対応表）。profile と単価の版は受付時に固定し、
// 精算・追加予約で変えない。通常料金の実費（actualGross）が枠の上限を数える値で、クレジットの区分
// （creditApplied・additionalSpend。実費 = クレジット + 追加の支出）は精算を分けて記録するだけで、上限の判定には
// 使わない（05 クレジットの追補。ADR 0042）。creditCycleId は、クレジットを充てる profile の予約が受付時に結び付いた
// 周期（周期をまたいで付け替えない）。省略した記録（合成のシナリオ・古い行）は「クレジット 0・追加の支出＝実費・
// 周期なし」の初期の規則と同じ。
export interface ReservationRecord {
  readonly reservationId: string;
  readonly requestId: string;
  readonly profileId: string;
  readonly priceVersion: string;
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
  readonly creditApplied?: string | null;
  readonly additionalSpend?: string | null;
  readonly creditCycleId?: string | null;
  // 保存した行の受付の時刻（UTC のミリ秒）と処理の起点。本人が対象を見分ける表示用で、判定には使わない（B07-05、
  // ADR 0039）。記録のない古い行・合成のシナリオでは省く（null）。
  readonly createdAt?: number;
  readonly origin?: BudgetOrigin | null;
}

export interface AdmissionRequest {
  readonly requestId: string;
  readonly profileId: string;
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

// 受付・追加予約の集計の対象（その月の解放していない行と、月を問わず M 超過の確認待ちの行）に、今の設定で経路を
// 解けない予約（設定から枠を消した後など）があるか。あれば、その使用量を親の枠に数えられず上限を超え得るので、
// 閉じた側に倒して受け付けない（B07-03 の Codex のレビュー P1。記録した経路で数える方法は採らない）。
function unresolvedReasons(
  settings: BudgetSettings,
  reservations: readonly ReservationRecord[],
  month: string,
): string[] {
  const unresolved = reservations.some(
    (item) =>
      item.status !== 'released' &&
      (item.budgetMonth === month ||
        (item.status === 'settled' &&
          !item.overrunReviewed &&
          BigInt(item.actualGross ?? '0') > BigInt(item.maxLiability))) &&
      poolPath(settings, item.poolId) === null,
  );
  return unresolved ? ['reservation_pool_unknown'] : [];
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
  reasons.push(
    ...unresolvedReasons(settings, reservations, request.budgetMonth),
  );
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
  // 予約の枠から根までの経路が今の設定で解けなければ（設定から枠を消した後など）、上限を検査できないので
  // 拒否する（閉じた側に倒す。B07-03 の Codex のレビュー P1）。
  const path = poolPath(settings, current.poolId);
  if (path === null) return { ok: false, reasonCodes: ['unknown_pool'] };
  const reasons = [
    ...(reserved > maxLiability ? ['reservation_exceeds_max'] : []),
    ...unresolvedReasons(settings, reservations, current.budgetMonth),
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

// 確定した usage で一度だけ精算する。元の月・元の枠のまま、M 超過も記録する。クレジットの区分（creditApplied。省略は
// 0）は Buddy の台帳で決めた値で、provider が示す値ではないので、同じ精算の再適用の判定（照合 ID と実費）には使わない。
// クレジットは、受付時に周期へ結び付いた予約（creditCycleId）で、実費以下のときだけ充てられる（ADR 0042）。
export function settleReservation(
  reservation: ReservationRecord,
  settlement: {
    readonly requestId: string;
    readonly providerReconciliationId: string;
    readonly actualGross: string;
    readonly creditApplied?: string;
  },
):
  | {
      readonly ok: true;
      readonly reservation: ReservationRecord;
      readonly duplicate: boolean;
      readonly overrun: boolean;
    }
  | Failure {
  // manual: で始まる照合 ID は手での精算（settleManually）の印で、provider の精算には使わない（ADR 0034・0035）。
  if (settlement.providerReconciliationId.startsWith('manual:'))
    return { ok: false, reasonCodes: ['manual_prefix_reserved'] };
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
  const credit = BigInt(settlement.creditApplied ?? '0');
  if (credit > BigInt(settlement.actualGross))
    return { ok: false, reasonCodes: ['credit_exceeds_actual'] };
  if (credit > 0n && (reservation.creditCycleId ?? null) === null)
    return { ok: false, reasonCodes: ['credit_not_eligible'] };
  return {
    ok: true,
    duplicate: false,
    overrun,
    reservation: {
      ...reservation,
      status: 'settled',
      actualGross: settlement.actualGross,
      providerReconciliationId: settlement.providerReconciliationId,
      creditApplied: credit.toString(),
      additionalSpend: (BigInt(settlement.actualGross) - credit).toString(),
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
