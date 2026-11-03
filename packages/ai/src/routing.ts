// 役割・ジョブごとの振り分け表と profile の検査（B10-02 P2、ADR 0081）。
// 設計 05「モデルの振り分け」・設計 10 §5（判定モデルの選定・LLM の同時実行）・設計 11 §8・§9。
// - 振り分けはジョブ（ModelTask）ごとの固定表。本人が「しっかり考えて」と言ったときの上位の設定は B10-03 以降。
// - 同時数は 2 本（枠 A は P0 専用、枠 B は P1→P2）。ローカル生成は別に 1 本。影モードは枠の内側で、既定 OFF（D4）。
// - 同時数 1 の provider を P0 と P1／P2 で共有しない（QA37）。同じ provider の profile の同時数は揃える。
// - 個人の金額・単価・為替・API キーはここに置かない。price_version の ID だけを扱う。
import type { ModelProfile } from '@buddy/contracts';
import type { ModelRole } from './types.js';

export const MODEL_TASKS = [
  'voice_reply',
  'intent_judgment',
  'text_chat',
  'intent_shadow',
  'mail_extraction',
  'reply_draft',
  'research_summary',
  'consult',
  'memory_extraction',
  'conversation_summary',
  'local_asr',
] as const;

export type ModelTask = (typeof MODEL_TASKS)[number];

// ローカル生成の同時数の上限。プロバイダの max_concurrency が 2 でも、実効は 1（scheduler も同じ値を使う）。
export const LOCAL_GENERATION_LIMIT = 1;

// 設計 11 §9 の優先度。P0＝対話、P1＝本人が頼んだ裏のジョブ、P2＝自発的解析。
export type CallPriority = 'P0' | 'P1' | 'P2';

// 枠 A は P0 専用、枠 B は P1→P2、local はローカル生成（同時 1）。
export type ConcurrencyLane = 'A' | 'B' | 'local';

export interface TaskRule {
  readonly role: ModelRole;
  // 期待する思考レベル。null は「思考の設定を持たない」。
  readonly reasoning: string | null;
  readonly priority: CallPriority;
  readonly lane: ConcurrencyLane;
  // profile.timeout_ms の上限。実測で調整する前提の初期値で、合格値ではない。
  readonly max_timeout_ms: number;
  // JSON Schema で構造化した出力を要求するか。
  readonly structured_output: boolean;
  // 影モードの比較（結果を使わない）。既定 OFF（D4）。
  readonly shadow: boolean;
  // 経路がないと起動できないか。影モード・ローカル ASR・裏のジョブは無効にできる。
  readonly required: boolean;
}

// 手で書いた固定表。ジョブの追加・変更はここだけを直し、利用側は TASK_RULES を参照する。
export const TASK_RULES: Readonly<Record<ModelTask, TaskRule>> = {
  voice_reply: {
    role: 'voice',
    reasoning: null,
    priority: 'P0',
    lane: 'A',
    max_timeout_ms: 30_000,
    structured_output: false,
    shadow: false,
    required: true,
  },
  intent_judgment: {
    role: 'intent',
    reasoning: 'low',
    priority: 'P0',
    lane: 'A',
    max_timeout_ms: 20_000,
    structured_output: true,
    shadow: false,
    required: true,
  },
  text_chat: {
    role: 'intent',
    reasoning: 'low',
    priority: 'P0',
    lane: 'A',
    max_timeout_ms: 20_000,
    structured_output: false,
    shadow: false,
    required: true,
  },
  intent_shadow: {
    role: 'intent',
    reasoning: null,
    priority: 'P2',
    lane: 'B',
    max_timeout_ms: 20_000,
    structured_output: true,
    shadow: true,
    required: false,
  },
  mail_extraction: {
    role: 'background_text',
    reasoning: 'low',
    priority: 'P2',
    lane: 'B',
    max_timeout_ms: 20_000,
    structured_output: true,
    shadow: false,
    required: false,
  },
  reply_draft: {
    role: 'background_text',
    reasoning: 'low',
    priority: 'P0',
    lane: 'A',
    max_timeout_ms: 20_000,
    structured_output: false,
    shadow: false,
    required: false,
  },
  research_summary: {
    role: 'background_text',
    reasoning: 'medium',
    priority: 'P1',
    lane: 'B',
    max_timeout_ms: 120_000,
    structured_output: false,
    shadow: false,
    required: false,
  },
  consult: {
    role: 'advanced_consult',
    reasoning: 'high',
    priority: 'P1',
    lane: 'B',
    max_timeout_ms: 120_000,
    structured_output: false,
    shadow: false,
    required: false,
  },
  memory_extraction: {
    role: 'background_text',
    reasoning: 'low',
    priority: 'P2',
    lane: 'B',
    max_timeout_ms: 20_000,
    structured_output: true,
    shadow: false,
    required: false,
  },
  conversation_summary: {
    role: 'background_text',
    reasoning: 'low',
    priority: 'P2',
    lane: 'B',
    max_timeout_ms: 20_000,
    structured_output: false,
    shadow: false,
    required: false,
  },
  local_asr: {
    role: 'local_asr',
    reasoning: null,
    priority: 'P0',
    lane: 'local',
    max_timeout_ms: 60_000,
    structured_output: false,
    shadow: false,
    required: false,
  },
};

// 実行時の設定（リポジトリの外）。profile の endpoint・認証は Core が設定から渡す。
export interface ModelRoutingConfig {
  readonly profiles: readonly ModelProfile[];
  readonly routes: Readonly<Partial<Record<ModelTask, string | null>>>;
  // 費用の見積もりで確認済みの price_version（B07 の BudgetRuntimeConfig.verified_price_versions と同じ）。
  readonly verified_price_versions: readonly string[];
}

const isNonEmpty = (value: string): boolean => value.trim() !== '';

// profile 単体の検査。形（JSON Schema）は contracts が検査済みの値を渡す。
export function modelProfileErrors(profile: ModelProfile): string[] {
  const errors: string[] = [];
  if (!isNonEmpty(profile.profile_id)) errors.push('profile_id_empty');
  if (!isNonEmpty(profile.endpoint)) errors.push('endpoint_empty');
  if (!isNonEmpty(profile.provider)) errors.push('provider_empty');
  if (profile.timeout_ms < 1) errors.push('timeout_invalid');
  if (profile.max_concurrency < 1) errors.push('concurrency_invalid');
  if (profile.output_limit_tokens !== null && profile.output_limit_tokens < 1)
    errors.push('output_limit_invalid');
  if (profile.reasoning !== null && !isNonEmpty(profile.reasoning))
    errors.push('reasoning_empty');
  // 有料の provider は price_version が要る。ローカルは金額を計上しないので null を許す。
  if (profile.provider !== 'local' && profile.price_version === null)
    errors.push('price_version_missing');
  // p95 予約は意図判定の比較 profile だけ（設計 05 質問132、ADR 0034）。
  if (
    profile.reservation_method === 'measured_p95' &&
    profile.role !== 'intent'
  )
    errors.push('p95_not_intent');
  if (profile.role === 'local_asr' && profile.provider !== 'local')
    errors.push('local_provider_required');
  const capabilities = profile.verified_capabilities;
  if (new Set(capabilities).size !== capabilities.length)
    errors.push('capability_duplicate');
  // 構造化出力と思考は、endpoint ごとに確かめた能力として登録されているものだけを使う
  // （schema の記載から能力を推定しない。ModelProfile の説明）。
  if (
    profile.structured_output !== 'none' &&
    !capabilities.includes(profile.structured_output)
  )
    errors.push('capability_unverified');
  if (
    profile.reasoning !== null &&
    !capabilities.includes(`reasoning:${profile.reasoning}`)
  )
    errors.push('capability_unverified');
  return errors;
}

// provider ごとの同時数の上限。同じ provider の profile の同時数は揃え、揃わなければ小さい方を使う（閉じた側）。
export function providerConcurrencyLimits(
  config: ModelRoutingConfig,
): Readonly<Record<string, number>> {
  const limits: Record<string, number> = {};
  for (const profile of config.profiles) {
    const current = limits[profile.provider];
    limits[profile.provider] =
      current === undefined
        ? profile.max_concurrency
        : Math.min(current, profile.max_concurrency);
  }
  return limits;
}

// 振り分けの検査。空なら有効。
export function routingErrors(config: ModelRoutingConfig): string[] {
  const errors = new Set<string>();
  const byId = new Map<string, ModelProfile>();
  for (const profile of config.profiles) {
    for (const reason of modelProfileErrors(profile)) errors.add(reason);
    if (byId.has(profile.profile_id))
      errors.add(`duplicate_profile:${profile.profile_id}`);
    byId.set(profile.profile_id, profile);
  }
  // 同じ provider の profile で同時数が違うと、どちらを信じるかで P0 が P2 を待ち得る。
  const providerConcurrency = new Map<string, number>();
  for (const profile of config.profiles) {
    const current = providerConcurrency.get(profile.provider);
    if (current === undefined)
      providerConcurrency.set(profile.provider, profile.max_concurrency);
    else if (current !== profile.max_concurrency)
      errors.add(`provider_concurrency_mismatch:${profile.provider}`);
  }
  const routed: { readonly task: ModelTask; readonly profile: ModelProfile }[] =
    [];
  for (const task of MODEL_TASKS) {
    const rule = TASK_RULES[task];
    const profileId = config.routes[task] ?? null;
    if (profileId === null) {
      if (rule.required) errors.add(`required_route_missing:${task}`);
      continue;
    }
    const profile = byId.get(profileId);
    if (profile === undefined) {
      errors.add(`unknown_profile:${task}`);
      continue;
    }
    routed.push({ task, profile });
    if (profile.role !== rule.role) errors.add(`role_mismatch:${task}`);
    if (
      rule.reasoning === null
        ? profile.reasoning !== null
        : profile.reasoning !== rule.reasoning
    )
      errors.add(`reasoning_mismatch:${task}`);
    if (rule.structured_output && profile.structured_output === 'none')
      errors.add(`structured_output_missing:${task}`);
    if (profile.output_limit_tokens === null && profile.provider !== 'local')
      errors.add(`output_limit_missing:${task}`);
    if (
      profile.provider !== 'local' &&
      profile.price_version !== null &&
      !config.verified_price_versions.includes(profile.price_version)
    )
      errors.add(`price_version_unverified:${task}`);
    if (profile.timeout_ms < 1 || profile.timeout_ms > rule.max_timeout_ms)
      errors.add(`timeout_out_of_range:${task}`);
    // p95 予約は意図判定の比較 profile だけ（設計 05 質問132、ADR 0035）。同じ intent の役割でも、
    // 文字会話や影モードへ流用しない。
    if (
      profile.reservation_method === 'measured_p95' &&
      task !== 'intent_judgment'
    )
      errors.add(`p95_not_judgment:${task}`);
  }
  // QA37: 同時数 1 の provider を P0 と P1／P2 で共有しない。P0 が P2 の完了を待たないため。
  // ローカルは max_concurrency が 2 でも実効 1（LOCAL_GENERATION_LIMIT）なので、その値で検査する。
  for (const [provider, concurrency] of providerConcurrency) {
    const effective =
      provider === 'local'
        ? Math.min(concurrency, LOCAL_GENERATION_LIMIT)
        : concurrency;
    if (effective !== 1) continue;
    const priorities = new Set(
      routed
        .filter((entry) => entry.profile.provider === provider)
        .map((entry) => TASK_RULES[entry.task].priority),
    );
    if (priorities.has('P0') && (priorities.has('P1') || priorities.has('P2')))
      errors.add(`provider_shared_between_priorities:${provider}`);
  }
  return [...errors];
}

export type RouteResolution =
  | {
      readonly ok: true;
      readonly task: ModelTask;
      readonly rule: TaskRule;
      readonly profile: ModelProfile;
    }
  | { readonly ok: false; readonly reasons: readonly string[] };

export function resolveModelRoute(
  config: ModelRoutingConfig,
  task: ModelTask,
): RouteResolution {
  const profileId = config.routes[task] ?? null;
  if (profileId === null) return { ok: false, reasons: ['route_missing'] };
  const profile = config.profiles.find(
    (entry) => entry.profile_id === profileId,
  );
  if (profile === undefined) return { ok: false, reasons: ['unknown_profile'] };
  return { ok: true, task, rule: TASK_RULES[task], profile };
}
