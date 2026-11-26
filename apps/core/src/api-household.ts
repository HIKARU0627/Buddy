// 家計簿の経路（ADR 0158・0161）。月ごとの合計・1 か月の記録・分類の変更・削除。
//
// 経路の検査（端末トークン・自宅判定・ロック解除・接続範囲・画面の操作）は api-server の admission が先に行う。
// ここは検査を通った要求の処理で、記録の読み書きと暗号化は household-ledger.ts、意味の規則は domain の household.ts。
// - 月ごとの合計（GET /v1/household/months）は今月から 11 か月前までの 12 か月。今月は本人のタイムゾーン（ADR 0131）で
//   決め、決まっていなければ 503（端末の時計・UTC で代用しない）。
// - 1 か月（GET /v1/household/months/{month}）は記録と集計。出所の識別子（メールの ID など）は返さない。
// - 分類の変更・削除は内容版で照合する。内容版の違い・削除済みは 409（画面は読み直す）、向きの違う分類・ない記録は 422。
//   同じ request_id の再送は、成功済みなら内容版が進んでいる・削除済みなので 409 になり、二重に効かない。
// - データ鍵が読めない・保存の失敗・成否不明は 503 dependency_unavailable にし、成功にも競合にも見せない。
// 承認・実行経路・effect_kind は関わらない（家計の記録は Buddy 自身の記録で、外部を変えない。ADR 0158）。

import { createHash, randomUUID } from 'node:crypto';
import {
  candidateLocalClock,
  householdMonthShift,
  isHouseholdMonth,
} from '@buddy/domain';
import type { DataKeyMaterial, DbWorkerClient } from '@buddy/storage';
import { apiErrorResponse } from './api-server.js';
import type { ApiRouteHandler } from './api-server.js';
import {
  changeHouseholdCategory,
  deleteHouseholdEntry,
  readHouseholdMonths,
} from './household-ledger.js';
import type {
  HouseholdEntryView,
  HouseholdMonthView,
} from './household-ledger.js';

// 月ごとの合計で返す月の数（今月を含む）。
export const HOUSEHOLD_OVERVIEW_MONTHS = 12;

export interface HouseholdRoutesOptions {
  readonly store: Pick<DbWorkerClient, 'household'>;
  // データ鍵を読む。Core のメモリーに持ち続けないので要求ごとに読む。読めなければ null。
  readonly dataKey: () => Promise<DataKeyMaterial | null>;
  // 本人のタイムゾーン（IANA）。決まっていなければ null。
  readonly zone: () => string | null;
  // いまの UTC のミリ秒。
  readonly now: () => number;
  // 新しい ID（封筒）。省略時は randomUUID。
  readonly newId?: () => string;
}

export interface HouseholdRoutes {
  readonly handlers: {
    readonly listHouseholdMonths: ApiRouteHandler;
    readonly getHouseholdMonth: ApiRouteHandler;
    readonly changeHouseholdCategory: ApiRouteHandler;
    readonly deleteHouseholdEntry: ApiRouteHandler;
  };
}

// 内容版の違い・削除済み（画面の表示が古い）。409 にして読み直させる。
const CONFLICT_REASONS: ReadonlySet<string> = new Set([
  'revision_mismatch',
  'entry_deleted',
]);
// 本人の入力の誤り・ない記録。422。
const INVALID_REASONS: ReadonlySet<string> = new Set([
  'category_invalid',
  'category_direction_mismatch',
  'entry_missing',
  'entry_id_invalid',
  'expected_revision_invalid',
]);

const stringOf = (value: unknown): string =>
  typeof value === 'string' ? value : '';

type HouseholdErrorCode =
  'conflict' | 'dependency_unavailable' | 'invalid_input';

const failWith =
  (requestId: string) => (status: number, code: HouseholdErrorCode) =>
    apiErrorResponse(status, code, requestId === '' ? null : requestId);

// 書込みの拒否の理由を応答に写す。成否不明（unknown）と想定外の理由は 503。
function failureStatus(
  outcome: 'rejected' | 'unknown',
  reasons: readonly string[],
): { readonly status: number; readonly code: HouseholdErrorCode } {
  if (outcome === 'unknown')
    return { status: 503, code: 'dependency_unavailable' };
  if (
    reasons.length > 0 &&
    reasons.every((reason) => CONFLICT_REASONS.has(reason))
  )
    return { status: 409, code: 'conflict' };
  if (
    reasons.length > 0 &&
    reasons.every((reason) => INVALID_REASONS.has(reason))
  )
    return { status: 422, code: 'invalid_input' };
  return { status: 503, code: 'dependency_unavailable' };
}

// 契約の HouseholdEntry の形。出所の識別子は持たない。
function entryBody(entry: HouseholdEntryView): object {
  const { content } = entry;
  return {
    entry_id: entry.entry_id,
    content_revision: entry.content_revision,
    source_kind: entry.source_kind,
    direction: content.direction,
    amount_yen: content.amount_yen,
    occurred_on: content.occurred_on,
    occurred_time: content.occurred_time,
    category: content.category,
    merchant: content.merchant,
    memo: content.memo,
    payment: content.payment,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
}

function monthTotals(view: HouseholdMonthView): object {
  const { summary } = view;
  return {
    month: view.month,
    expense_yen: summary.expense_yen,
    income_yen: summary.income_yen,
    balance_yen: summary.balance_yen,
    transfer_yen: summary.transfer_yen,
    entry_count: summary.entry_count,
    unreadable: view.unreadable,
  };
}

export function createHouseholdRoutes(
  options: HouseholdRoutesOptions,
): HouseholdRoutes {
  const newId = options.newId ?? (() => randomUUID());
  const sha256Hex = (material: string): string =>
    createHash('sha256').update(material, 'utf8').digest('hex');
  const loadKey = async (): Promise<DataKeyMaterial | null> => {
    try {
      return await options.dataKey();
    } catch {
      return null;
    }
  };

  const listHouseholdMonths: ApiRouteHandler = async () => {
    const fail = failWith('');
    const zone = options.zone();
    if (zone === null) return fail(503, 'dependency_unavailable');
    const at = options.now();
    const clock = candidateLocalClock(at, zone);
    const current = clock === null ? null : clock.date.slice(0, 7);
    // 12 か月の範囲が 2000〜2099 年に収まらない（中枢の時計の狂い）なら、決められないものとして閉じる。
    const from =
      current === null
        ? null
        : householdMonthShift(current, -(HOUSEHOLD_OVERVIEW_MONTHS - 1));
    if (current === null || from === null || !isHouseholdMonth(current))
      return fail(503, 'dependency_unavailable');
    const dataKey = await loadKey();
    if (dataKey === null) return fail(503, 'dependency_unavailable');
    const read = await readHouseholdMonths(
      { client: options.store, dataKey },
      from,
      current,
    );
    if (read.outcome !== 'ok') return fail(503, 'dependency_unavailable');
    const months = read.months.map(monthTotals);
    if (months.length !== HOUSEHOLD_OVERVIEW_MONTHS)
      return fail(503, 'dependency_unavailable');
    return {
      status: 200,
      body: {
        time_zone: zone,
        current_month: current,
        generated_at: new Date(at).toISOString(),
        months,
        truncated: read.truncated,
      },
    };
  };

  const getHouseholdMonth: ApiRouteHandler = async (request) => {
    const fail = failWith('');
    const month = request.params['month'] ?? '';
    // 形（YYYY-MM）は経路の検査が済ませている。家計の記録は 2000〜2099 年だけ。
    if (!isHouseholdMonth(month)) return fail(422, 'invalid_input');
    const dataKey = await loadKey();
    if (dataKey === null) return fail(503, 'dependency_unavailable');
    const read = await readHouseholdMonths(
      { client: options.store, dataKey },
      month,
      month,
    );
    if (read.outcome !== 'ok') return fail(503, 'dependency_unavailable');
    const view = read.months[0];
    if (view === undefined || view.month !== month)
      return fail(503, 'dependency_unavailable');
    return {
      status: 200,
      body: {
        month,
        entries: view.entries.map(entryBody),
        summary: view.summary,
        unreadable: view.unreadable,
        truncated: read.truncated,
      },
    };
  };

  const changeCategory: ApiRouteHandler = async (request) => {
    const body = request.body ?? {};
    const fail = failWith(stringOf(body['request_id']));
    const entryId = request.params['entry_id'] ?? '';
    const expected = stringOf(body['expected_content_revision']);
    const category = stringOf(body['category']);
    const dataKey = await loadKey();
    if (dataKey === null) return fail(503, 'dependency_unavailable');
    const changed = await changeHouseholdCategory(
      {
        client: options.store,
        dataKey,
        sha256Hex,
        newId,
        now: () => new Date(options.now()).toISOString(),
      },
      entryId,
      expected,
      category,
    );
    if (changed.outcome !== 'changed') {
      const failure = failureStatus(changed.outcome, changed.reasons);
      return fail(failure.status, failure.code);
    }
    return {
      status: 200,
      body: {
        entry_id: changed.entry_id,
        content_revision: changed.content_revision,
        rule_learned: changed.rule_learned,
      },
    };
  };

  const deleteEntry: ApiRouteHandler = async (request) => {
    const body = request.body ?? {};
    const fail = failWith(stringOf(body['request_id']));
    const entryId = request.params['entry_id'] ?? '';
    const expected = stringOf(body['expected_content_revision']);
    const deleted = await deleteHouseholdEntry(
      {
        client: options.store,
        now: () => new Date(options.now()).toISOString(),
      },
      entryId,
      expected,
    );
    if (deleted.outcome !== 'deleted') {
      const failure = failureStatus(deleted.outcome, deleted.reasons);
      return fail(failure.status, failure.code);
    }
    return {
      status: 200,
      body: { entry_id: deleted.entry_id, state: 'deleted' },
    };
  };

  return {
    handlers: {
      listHouseholdMonths,
      getHouseholdMonth,
      changeHouseholdCategory: changeCategory,
      deleteHouseholdEntry: deleteEntry,
    },
  };
}
