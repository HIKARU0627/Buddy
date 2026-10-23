// B07-04: 予算の門（Core の BudgetGate）が使う純粋な規則（設計 05 F02・D15、09 X18・QA42・X53、ADR 0006・0034〜0037、
// 本人の判断 2026-10-23）。
// - 起点（BudgetOrigin）とサービス（LLM・検索・音声）から計上する葉の枠を、実行時の設定の routing で決める。
// - 超過枠へ回せる通常の枠の許可リストは、本人の依頼の LLM・検索の枠から作る（音声は入れない。空なら回さない）。
// - 実行時の設定（BudgetRuntimeConfig）の意味検査。契約の検査（scripts/contract-tools.mjs）と同じ理由コードと順序で、
//   Core が起動時に設定ファイルを確かめるために使う（Core は scripts を読まない）。
// - タイムゾーンの正規化（Intl の resolvedOptions().timeZone）と、Etc/* の拒否。
// - 送る前の最終検査（予約が reserved で、まだ送出意図がなく、安全停止していない）。
// 個人の金額・単価・為替はコードに置かない。設定の値は呼び出し側が渡す。

import type { BudgetSettings } from './budget.js';
import type { BudgetOrigin, PriceVersionInput } from './budget-rules.js';

export type BudgetService = 'llm' | 'search' | 'voice';

export const BUDGET_ORIGINS: readonly BudgetOrigin[] = [
  'owner_request',
  'autonomous_analysis',
  'auto_execution',
  'initial_import',
  'shadow_mode',
];

export const BUDGET_SERVICES: readonly BudgetService[] = [
  'llm',
  'search',
  'voice',
];

// 以下は契約の BudgetServiceRoutes・BudgetRouting・BudgetPool・BudgetConfig・BudgetRuntimeConfig と同じ形（snake_case）。
export interface BudgetServiceRoutesInput {
  readonly llm: string | null;
  readonly search: string | null;
  readonly voice: string | null;
}

export interface BudgetRoutingInput {
  readonly routes: Readonly<Record<BudgetOrigin, BudgetServiceRoutesInput>>;
  readonly overage_pool_id: string | null;
}

export interface BudgetPoolInput {
  readonly pool_id: string;
  readonly parent_pool_id: string | null;
  readonly limit: { readonly currency: string; readonly amount: string };
  readonly requires_approval: boolean;
}

export interface BudgetConfigInput {
  readonly schema: string;
  readonly currency: string;
  readonly pools: readonly BudgetPoolInput[];
  readonly verified_price_versions: readonly string[];
}

export interface BudgetRuntimeConfigInput {
  readonly schema: string;
  readonly time_zone: string | null;
  readonly budget: BudgetConfigInput;
  readonly price_versions: readonly PriceVersionInput[];
  readonly routing: BudgetRoutingInput;
}

// 起点とサービスから計上する葉の枠。設定にない（null）なら受け付けない。
export function routePool(
  routing: BudgetRoutingInput,
  origin: BudgetOrigin,
  service: BudgetService,
): string | null {
  const routes = routing.routes[origin] as BudgetServiceRoutesInput | undefined;
  if (routes === undefined) return null;
  return routes[service] ?? null;
}

// 超過枠へ回す経路。許可リストは本人の依頼（owner_request）の LLM・検索の枠（完全一致で照合し、子孫を含めない）。
// 音声の枠は入れない（J17。LLM・検索と融通しない）。超過枠がない・許可リストが空なら null（回さない）。
export function overageRouteOf(routing: BudgetRoutingInput): {
  readonly routablePoolIds: readonly string[];
  readonly overagePoolId: string;
} | null {
  const overage = routing.overage_pool_id;
  if (overage === null) return null;
  const owner = routing.routes.owner_request;
  const routable = [owner.llm, owner.search].filter(
    (id, index, all): id is string =>
      id !== null && id !== overage && all.indexOf(id) === index,
  );
  if (routable.length === 0) return null;
  return { routablePoolIds: routable, overagePoolId: overage };
}

// 契約の BudgetConfig を domain の BudgetSettings にする（金額は Money の amount）。
export function toBudgetSettings(config: BudgetConfigInput): BudgetSettings {
  return {
    currency: config.currency,
    pools: config.pools.map((pool) => ({
      poolId: pool.pool_id,
      parentPoolId: pool.parent_pool_id,
      limit: pool.limit.amount,
      requiresApproval: pool.requires_approval,
    })),
    verifiedPriceVersions: [...config.verified_price_versions],
  };
}

// --- タイムゾーンの正規化 ---

export type TimeZoneNormalization =
  | {
      readonly ok: true;
      // Intl が正規化した名前（resolvedOptions().timeZone）。記録にはこの名前を使う。
      readonly timeZone: string;
      // 渡した名前と正規化した名前が違う（旧別名・大文字小文字の違いなど）。Core は警告を出す。
      readonly normalized: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'unknown_time_zone' | 'etc_time_zone';
    };

const TIME_ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/u;

// IANA タイムゾーンの名前を、実行環境の Intl（ICU）の正規の名前にする。Etc/*（Etc/GMT+9 は UTC−9 で、符号の
// 取り違えが起きやすい）は拒否する。UTC・Etc/UTC は Intl が UTC に正規化するので受け付ける。旧別名
// （Japan・US/Eastern など）は正規の名前にして受け付け、normalized を true にする（Core が警告を出す）。
// 正規の名前は ICU（CLDR）の名前で、IANA の主要な名前と違うことがある（Asia/Kolkata → Asia/Calcutta）。
export function normalizeTimeZone(name: unknown): TimeZoneNormalization {
  if (typeof name !== 'string' || !TIME_ZONE_NAME.test(name))
    return { ok: false, reason: 'unknown_time_zone' };
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', {
      timeZone: name,
    }).resolvedOptions().timeZone;
  } catch {
    return { ok: false, reason: 'unknown_time_zone' };
  }
  if (!TIME_ZONE_NAME.test(resolved))
    return { ok: false, reason: 'unknown_time_zone' };
  if (resolved.startsWith('Etc/'))
    return { ok: false, reason: 'etc_time_zone' };
  return { ok: true, timeZone: resolved, normalized: resolved !== name };
}

// --- 実行時の設定の意味検査（契約の semanticErrors と同じ理由コード・順序） ---

const decimalMicros = (text: string): bigint => {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
};

function timeZoneErrors(value: string): string[] {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return [];
  } catch {
    return ['unknown_time_zone'];
  }
}

function budgetConfigErrors(value: BudgetConfigInput): string[] {
  const errors: string[] = [];
  const pools = new Map<string, BudgetPoolInput>();
  for (const pool of value.pools) {
    if (pools.has(pool.pool_id)) errors.push('duplicate_pool');
    pools.set(pool.pool_id, pool);
    if (pool.limit.currency !== value.currency)
      errors.push('currency_mismatch');
  }
  for (const pool of value.pools) {
    const seen = new Set([pool.pool_id]);
    let parent = pool.parent_pool_id;
    while (parent !== null) {
      const node = pools.get(parent);
      if (!node) {
        errors.push('unknown_parent_pool');
        break;
      }
      if (seen.has(parent)) {
        errors.push('pool_cycle');
        break;
      }
      seen.add(parent);
      parent = node.parent_pool_id;
    }
    const direct =
      pool.parent_pool_id === null ? undefined : pools.get(pool.parent_pool_id);
    if (direct && BigInt(pool.limit.amount) > BigInt(direct.limit.amount))
      errors.push('child_limit_exceeds_parent');
  }
  return errors;
}

function priceVersionErrors(value: PriceVersionInput): string[] {
  const errors: string[] = [];
  if (
    value.effective_to !== null &&
    Date.parse(value.effective_from) >= Date.parse(value.effective_to)
  )
    errors.push('effective_period_order');
  const categories = value.rates.map((rate) => rate.category);
  if (new Set(categories).size !== categories.length)
    errors.push('duplicate_category');
  if (
    categories.includes('cached_input_tokens') &&
    !categories.includes('input_tokens')
  )
    errors.push('cache_without_input');
  const inputRate = value.rates.find(
    (rate) => rate.category === 'input_tokens',
  );
  const cachedRate = value.rates.find(
    (rate) => rate.category === 'cached_input_tokens',
  );
  if (
    inputRate &&
    cachedRate &&
    BigInt(cachedRate.unit_price) * BigInt(inputRate.per_quantity) >
      BigInt(inputRate.unit_price) * BigInt(cachedRate.per_quantity)
  )
    errors.push('cached_price_above_input');
  for (const rate of value.rates) {
    const input = ['input_tokens', 'cached_input_tokens'].includes(
      rate.category,
    );
    if (rate.max_quantity_per_request === null && !input)
      errors.push('unbounded_category');
    if (
      rate.max_quantity_per_request !== null &&
      BigInt(rate.minimum_quantity) > BigInt(rate.max_quantity_per_request)
    )
      errors.push('minimum_exceeds_max');
  }
  if (
    value.currency === value.conversion.to_currency &&
    decimalMicros(value.conversion.rate) !== 1_000_000n
  )
    errors.push('same_currency_rate');
  if (decimalMicros(value.conversion.rate) === 0n)
    errors.push('non_positive_rate');
  if (decimalMicros(value.conversion.safety_factor) < 1_000_000n)
    errors.push('safety_factor_below_one');
  return errors;
}

// 起点から計上する枠と超過枠の検査。各理由は 1 回だけ返す（契約の routingErrors と同じ）。
function routingErrors(
  budget: BudgetConfigInput,
  routing: BudgetRoutingInput,
): string[] {
  const errors = new Set<string>();
  const pools = new Map(budget.pools.map((pool) => [pool.pool_id, pool]));
  const path = (id: string): string[] => {
    const seen: string[] = [];
    let current: string | null = id;
    while (current !== null && pools.has(current) && !seen.includes(current)) {
      seen.push(current);
      current = (pools.get(current) as BudgetPoolInput).parent_pool_id;
    }
    return seen;
  };
  const textPools: string[] = [];
  const voicePools: string[] = [];
  for (const origin of Object.keys(routing.routes) as BudgetOrigin[]) {
    const services = routing.routes[origin];
    for (const service of Object.keys(services) as BudgetService[]) {
      const id = services[service];
      if (id === null) continue;
      const pool = pools.get(id);
      if (pool === undefined) {
        errors.add('unknown_route_pool');
        continue;
      }
      if (pool.requires_approval) errors.add('route_pool_requires_approval');
      else if (path(id).some((item) => pools.get(item)?.requires_approval))
        errors.add('route_under_approval_pool');
      (service === 'voice' ? voicePools : textPools).push(id);
    }
  }
  const overage = routing.overage_pool_id;
  if (overage !== null) {
    const pool = pools.get(overage);
    if (pool === undefined) errors.add('unknown_route_pool');
    else if (!pool.requires_approval) errors.add('overage_pool_invalid');
    // 超過枠は独立した枠（ADR 0006）。根の枠でなければ、音声や LLM・検索の木の予算を消費し得る。
    else if (pool.parent_pool_id !== null)
      errors.add('overage_pool_not_independent');
  }
  // 自発の起点の LLM の枠は、本人の依頼の LLM の枠の配下（子孫）でなければならない（本人の判断）。同じ枠や、本人の
  // 枠の外（親の total など）へ向けると、自発の枠の上限を迂回して本人の依頼の予算を使い切れる（Codex のレビュー P2）。
  const ownerLlm = routing.routes.owner_request.llm;
  for (const origin of Object.keys(routing.routes) as BudgetOrigin[]) {
    const llm = routing.routes[origin].llm;
    if (
      origin !== 'owner_request' &&
      llm !== null &&
      pools.has(llm) &&
      // 本人の LLM の経路がないのに自発の LLM の経路があれば、配下に限る制約を確かめられないので拒否する
      // （閉じた側。Codex の再確認 P2）。本人の枠が設定にないときは unknown_route_pool で拒否済み。
      (ownerLlm === null ||
        (pools.has(ownerLlm) &&
          (llm === ownerLlm || !path(llm).includes(ownerLlm))))
    )
      errors.add('autonomous_not_under_owner_pool');
  }
  const textPaths = new Set(textPools.flatMap(path));
  if (voicePools.some((id) => path(id).some((item) => textPaths.has(item))))
    errors.add('voice_pool_shared');
  return [...errors];
}

// 実行時の設定の意味検査。形（JSON Schema）の検査に通った値を渡す。空なら有効。
export function budgetRuntimeConfigErrors(
  value: BudgetRuntimeConfigInput,
): string[] {
  const errors: string[] = [];
  if (value.time_zone !== null) errors.push(...timeZoneErrors(value.time_zone));
  errors.push(...budgetConfigErrors(value.budget));
  const ids = value.price_versions.map((item) => item.price_version);
  if (new Set(ids).size !== ids.length) errors.push('duplicate_price_version');
  for (const id of value.budget.verified_price_versions)
    if (!ids.includes(id)) errors.push('unknown_verified_price_version');
  const end = (version: PriceVersionInput): number =>
    version.effective_to === null ? Infinity : Date.parse(version.effective_to);
  value.price_versions.forEach((item, index) => {
    errors.push(...priceVersionErrors(item));
    if (item.conversion.to_currency !== value.budget.currency)
      errors.push('currency_mismatch');
    for (const other of value.price_versions.slice(index + 1))
      if (
        other.price_key === item.price_key &&
        Date.parse(item.effective_from) < end(other) &&
        Date.parse(other.effective_from) < end(item)
      )
        errors.push('price_period_overlap');
  });
  errors.push(...routingErrors(value.budget, value.routing));
  return errors;
}

// --- 送る前の最終検査 ---

export interface DispatchCheckInput {
  readonly status: 'reserved' | 'usage_unknown' | 'settled' | 'released';
  // 送出意図を記録済み（もう一度送らない）。
  readonly dispatched: boolean;
  readonly safetyStopped: boolean;
  // 送る時刻と応答の期限（UTC のミリ秒）。M は受付の時刻から期限までの単価で計算したので、期限の後には送らない
  // （Codex のレビュー P1。期限を過ぎた要求は新しい受付で M を計算し直す）。
  readonly now: number;
  readonly deadline: number;
}

// 送る直前の検査（08 §3 P01 の reservation_valid と安全停止）。空なら一度だけ送ってよい。送出意図は 1 予約に 1 回で、
// 結果不明の後に自動で送り直さない。
export function dispatchReasons(input: DispatchCheckInput): string[] {
  const reasons: string[] = [];
  if (input.status !== 'reserved') reasons.push('reservation_invalid');
  if (input.dispatched) reasons.push('already_dispatched');
  if (input.safetyStopped) reasons.push('safety_stopped');
  if (!(input.now < input.deadline)) reasons.push('reservation_expired');
  return reasons;
}
