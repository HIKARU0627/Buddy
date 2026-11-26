// 家計簿の経路（ADR 0158・0161）。月ごとの合計・1 か月の記録・分類の変更・削除。
//
// 経路の検査（端末トークン・自宅判定・ロック解除・接続範囲・画面の操作）は api-server の admission が先に行う。
// ここは検査を通った要求の処理で、記録の読み書きと暗号化は household-ledger.ts、意味の規則は domain の household.ts。
// - 月ごとの合計（GET /v1/household/months）は今月から 11 か月前までの 12 か月。今月は本人のタイムゾーン（ADR 0131）で
//   決め、決まっていなければ 503（端末の時計・UTC で代用しない）。
// - 1 か月（GET /v1/household/months/{month}）は記録と集計。出所の識別子（メールの ID など）は返さない。
// - 分類の変更・削除は内容版で照合する。内容版の違い・削除済みは 409（画面は読み直す）、向きの違う分類・ない記録は 422。
//   同じ request_id の再送は、成功済みなら内容版が進んでいる・削除済みなので 409 になり、二重に効かない。
// - 設定の変更（POST /v1/household/settings）は利用通知の取り込みの入・切（ADR 0163）。版の違いは 409。
// - データ鍵が読めない・保存の失敗・成否不明は 503 dependency_unavailable にし、成功にも競合にも見せない。
// 承認・実行経路・effect_kind は関わらない（家計の記録は Buddy 自身の記録で、外部を変えない。ADR 0158）。

import { createHash, randomUUID } from 'node:crypto';
import {
  candidateLocalClock,
  detectHouseholdRecurring,
  householdBudgetErrors,
  householdContentErrors,
  householdMonthOf,
  householdMonthShift,
  householdNoticeMatchKey,
  isHouseholdMonth,
} from '@buddy/domain';
import type { HouseholdBudgetItem, HouseholdEntryContent } from '@buddy/domain';
import { openHouseholdBudget, sealHouseholdBudget } from '@buddy/storage';
import type { DataKeyMaterial, DbWorkerClient } from '@buddy/storage';
import { apiErrorResponse } from './api-server.js';
import type { ApiRouteHandler } from './api-server.js';
import {
  HouseholdMerchantKey,
  changeHouseholdCategory,
  deleteHouseholdEntry,
  readHouseholdMonths,
  recordHouseholdEntry,
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
    readonly changeHouseholdSettings: ApiRouteHandler;
    readonly importHouseholdRows: ApiRouteHandler;
    readonly changeHouseholdBudget: ApiRouteHandler;
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

// 保存する内容版の形（1 から。保存層と同じ）。契約の形（0 を含む）より狭いので、0 などは経路の処理で 422 にする。
const STORED_REVISION = /^[1-9][0-9]{0,15}$/u;

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

// 契約の HouseholdBudget の形。分類の表示の順（保存層がそろえて保存する）。
function budgetBody(
  revision: string,
  items: readonly HouseholdBudgetItem[],
): object {
  return {
    budget_revision: revision,
    items: items.map((item) => ({
      category: item.category,
      budget_yen: item.budget_yen,
    })),
    total_budget_yen: items.reduce((sum, item) => sum + item.budget_yen, 0),
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

  // 予算の版と中身。予算がまだなければ版 0・空。読めない・開けなければ null。
  const readBudget = async (
    dataKey: DataKeyMaterial,
  ): Promise<{
    readonly revision: string;
    readonly items: readonly HouseholdBudgetItem[];
  } | null> => {
    const got = await options.store.household({ kind: 'household.budget_get' });
    if (!got.ok) return null;
    const { budget_revision: revision, content } = got.value;
    if (content === null)
      return revision === '0' ? { revision, items: [] } : null;
    const opened = openHouseholdBudget(dataKey, Number(revision), {
      formatVersion: content.format_version,
      keyId: content.key_id,
      nonce: content.nonce,
      ciphertext: content.ciphertext,
      tag: content.tag,
    });
    return opened.ok ? { revision, items: opened.items } : null;
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
    // 利用通知の取り込みの入・切（ADR 0163）。読めなければ合計も返さない（入・切を推測で見せない）。
    const settings = await options.store.household({
      kind: 'household.settings_get',
    });
    if (!settings.ok) return fail(503, 'dependency_unavailable');
    // 分類ごとの予算（ADR 0166）。読めない・開けなければ合計も返さない（予算を推測で見せない）。
    const budget = await readBudget(dataKey);
    if (budget === null) return fail(503, 'dependency_unavailable');
    return {
      status: 200,
      body: {
        time_zone: zone,
        current_month: current,
        generated_at: new Date(at).toISOString(),
        months,
        truncated: read.truncated,
        settings: settings.value,
        // 定期の支出と固定費の目安（ADR 0165）。同じ 12 か月の記録から計算し、保存しない。
        recurring: detectHouseholdRecurring(
          read.months.flatMap((month) =>
            month.entries.map((entry) => entry.content),
          ),
          current,
        ),
        budget: budgetBody(budget.revision, budget.items),
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
    if (!STORED_REVISION.test(expected)) return fail(422, 'invalid_input');
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
    if (!STORED_REVISION.test(expected)) return fail(422, 'invalid_input');
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

  // 利用通知の取り込みを止める・再開する（ADR 0163）。版は保存層が同じ transaction で照合する。
  const changeSettings: ApiRouteHandler = async (request) => {
    const body = request.body ?? {};
    const fail = failWith(stringOf(body['request_id']));
    const expected = stringOf(body['expected_settings_revision']);
    const mailIntake = stringOf(body['mail_intake']);
    if (mailIntake !== 'on' && mailIntake !== 'off')
      return fail(422, 'invalid_input');
    const changed = await options.store.household({
      kind: 'household.settings_set',
      expected_revision: expected,
      mail_intake: mailIntake,
      now: new Date(options.now()).toISOString(),
    });
    if (!changed.ok) {
      const failure = failureStatus(changed.outcome, changed.reasons);
      return fail(failure.status, failure.code);
    }
    return { status: 200, body: changed.value };
  };

  // 分類ごとの予算を丸ごと差し替える（ADR 0166）。版は保存層が同じ transaction で照合する。
  const changeBudget: ApiRouteHandler = async (request) => {
    const body = request.body ?? {};
    const fail = failWith(stringOf(body['request_id']));
    const expected = stringOf(body['expected_budget_revision']);
    const raw = Array.isArray(body['items']) ? body['items'] : [];
    const items = raw.map((item) => {
      const value = (item ?? {}) as Record<string, unknown>;
      return {
        category: value['category'] as string,
        budget_yen: value['budget_yen'] as number,
      };
    });
    if (householdBudgetErrors(items).length > 0)
      return fail(422, 'invalid_input');
    if (!/^(0|[1-9][0-9]{0,15})$/u.test(expected))
      return fail(422, 'invalid_input');
    const dataKey = await loadKey();
    if (dataKey === null) return fail(503, 'dependency_unavailable');
    const sealed = sealHouseholdBudget(
      dataKey,
      Number(expected) + 1,
      items,
      newId(),
    );
    if (!sealed.ok) return fail(422, 'invalid_input');
    const changed = await options.store.household({
      kind: 'household.budget_set',
      expected_revision: expected,
      content: sealed.content,
      now: new Date(options.now()).toISOString(),
    });
    if (!changed.ok) {
      const failure = failureStatus(changed.outcome, changed.reasons);
      return fail(failure.status, failure.code);
    }
    const read = await readBudget(dataKey);
    if (read === null) return fail(503, 'dependency_unavailable');
    return { status: 200, body: budgetBody(read.revision, read.items) };
  };

  // 外部の家計簿サービスの書き出しの取り込み（ADR 0164）。行ごとに家計の記録の検査をし直し、出所（書き出しの行の ID）で
  // 二度記録しない。同じ日・同じ金額の利用通知の記録がある支出は取り込まない（一つの通知に一つの行。U335）。支出の分類が
  // 決まっている行は、店名の規則として覚える（取り込みの規則は本人の規則を上書きしない。ADR 0158）。
  const importRows: ApiRouteHandler = async (request) => {
    const body = request.body ?? {};
    const fail = failWith(stringOf(body['request_id']));
    if (body['origin'] !== 'moneyforward') return fail(422, 'invalid_input');
    const rows = Array.isArray(body['rows']) ? body['rows'] : [];
    const dataKey = await loadKey();
    if (dataKey === null) return fail(503, 'dependency_unavailable');
    const ports = {
      client: options.store,
      dataKey,
      sha256Hex,
      newId,
      now: () => new Date(options.now()).toISOString(),
    };
    const counts = {
      created: 0,
      duplicate: 0,
      matched: 0,
      rejected: 0,
      rules_learned: 0,
    };
    const valid: { rowId: string; content: HouseholdEntryContent }[] = [];
    for (const raw of rows) {
      const row = (raw ?? {}) as Record<string, unknown>;
      const content = {
        direction: row['direction'],
        amount_yen: row['amount_yen'],
        occurred_on: row['occurred_on'],
        occurred_time: null,
        category: row['category'],
        merchant: row['merchant'],
        memo: row['memo'],
        payment: row['payment'],
      };
      if (
        typeof row['row_id'] !== 'string' ||
        householdContentErrors(content).length > 0
      ) {
        counts.rejected += 1;
        continue;
      }
      valid.push({
        rowId: row['row_id'],
        content: content as HouseholdEntryContent,
      });
    }
    // 利用通知の記録の日付と金額（月ごとに読む）。読めなければ二重の記録を避けられないので止める。
    const notices = new Map<string, number>();
    const months = new Set(
      valid.map((item) => householdMonthOf(item.content.occurred_on) ?? ''),
    );
    for (const month of months) {
      if (month === '') continue;
      const read = await readHouseholdMonths(ports, month, month);
      if (read.outcome !== 'ok') return fail(503, 'dependency_unavailable');
      for (const entry of read.months[0]?.entries ?? []) {
        if (entry.source_kind !== 'mail_notice') continue;
        const key = householdNoticeMatchKey(entry.content);
        if (key !== null) notices.set(key, (notices.get(key) ?? 0) + 1);
      }
    }
    const merchantKey = HouseholdMerchantKey.fromDataKey(dataKey);
    for (const item of valid) {
      const key = householdNoticeMatchKey(item.content);
      const left = key === null ? 0 : (notices.get(key) ?? 0);
      if (key !== null && left > 0) {
        notices.set(key, left - 1);
        counts.matched += 1;
        continue;
      }
      const recorded = await recordHouseholdEntry(
        ports,
        { kind: 'csv_import', origin: 'moneyforward', row_id: item.rowId },
        item.content,
      );
      if (recorded.outcome === 'duplicate') {
        counts.duplicate += 1;
        continue;
      }
      if (recorded.outcome === 'rejected') {
        // 中身は上で検査済みなので、残る形の誤りは書き出しの行の ID（出所）だけ。保存の失敗は途中で止める
        // （取り込み直せば記録済みの行は増えない）。
        if (recorded.reasons.includes('source_invalid')) {
          counts.rejected += 1;
          continue;
        }
        return fail(503, 'dependency_unavailable');
      }
      if (recorded.outcome !== 'created')
        return fail(503, 'dependency_unavailable');
      counts.created += 1;
      const { content } = item;
      if (
        content.direction !== 'expense' ||
        content.category === 'uncategorized' ||
        content.merchant === null
      )
        continue;
      const merchant = merchantKey.merchant(content.merchant);
      if (merchant === null) continue;
      const rule = await options.store.household({
        kind: 'household.rule_set',
        merchant_key: merchant,
        category: content.category,
        origin: 'import',
        now: ports.now(),
      });
      if (rule.ok && rule.value.written) counts.rules_learned += 1;
    }
    return { status: 200, body: counts };
  };

  return {
    handlers: {
      listHouseholdMonths,
      getHouseholdMonth,
      changeHouseholdCategory: changeCategory,
      deleteHouseholdEntry: deleteEntry,
      changeHouseholdSettings: changeSettings,
      importHouseholdRows: importRows,
      changeHouseholdBudget: changeBudget,
    },
  };
}
