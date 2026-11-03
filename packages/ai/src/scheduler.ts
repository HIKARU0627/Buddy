// 同時数・枠・優先度の受付（B10-02 P2、ADR 0081）。設計 10 §5（LLM の同時実行）・設計 11 §9、QA13・QA37。
// - テキスト推論は同時 2 本まで。枠 A は P0 専用、枠 B は P1→P2 の順に使う。
// - ローカル生成は別に同時 1 本まで。
// - 影モードは枠の内側で、P0／P1／P2 の仕事があるときは待たずに skip する（D4 既定 OFF）。
// - 同時数 1 の provider を P0 と P1／P2 で共有する設定は routingErrors が拒否する（QA37）。
// ここは純粋な計画で、実際の待ち行列・timer・provider の呼び出しは持たない。
import {
  LOCAL_GENERATION_LIMIT,
  providerConcurrencyLimits,
  resolveModelRoute,
  TASK_RULES,
  type CallPriority,
  type ConcurrencyLane,
  type ModelRoutingConfig,
  type ModelTask,
} from './routing.js';

export { LOCAL_GENERATION_LIMIT };

export const TEXT_INFERENCE_LIMIT = 2;
export const LANE_A_LIMIT = 1;
export const LANE_B_LIMIT = 1;

export interface RunningModelCall {
  readonly task: ModelTask;
  readonly provider: string;
  // 影モードの比較（結果を使わない）。
  readonly shadow: boolean;
}

export interface ModelCallRequest {
  readonly task: ModelTask;
  readonly shadow?: boolean;
}

export interface SchedulerState {
  readonly running: readonly RunningModelCall[];
  // 影モードの比較 campaign が有効か。既定は false（D4）。
  readonly shadow_enabled?: boolean;
  // 影モードに使える予算が空いているか。
  readonly budget_available?: boolean;
}

export type CallDecision =
  | {
      readonly admit: true;
      readonly lane: ConcurrencyLane;
      readonly priority: CallPriority;
    }
  | {
      readonly admit: false;
      readonly action: 'wait' | 'skip';
      readonly reasons: readonly string[];
    };

const PRIORITY_ORDER: Readonly<Record<CallPriority, number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

const rank = (request: ModelCallRequest): number =>
  TASK_RULES[request.task].shadow
    ? 3
    : PRIORITY_ORDER[TASK_RULES[request.task].priority];

// 影モードかどうかはジョブの規則を正本にする。running のフラグは、規則と食い違う記録も影モードとして扱う。
const isRunningShadow = (call: RunningModelCall): boolean =>
  call.shadow || TASK_RULES[call.task].shadow;

// 受け付ける順に並べ、その時点の枠と provider の同時数で決める。戻り値は入力と同じ順。
export function planModelCalls(
  config: ModelRoutingConfig,
  state: SchedulerState,
  requests: readonly ModelCallRequest[],
): readonly CallDecision[] {
  const limits = providerConcurrencyLimits(config);
  const runningShadow = state.running.filter(isRunningShadow);
  const runningWork = state.running.filter((call) => !isRunningShadow(call));
  let laneA = runningWork.filter(
    (call) => TASK_RULES[call.task].lane === 'A',
  ).length;
  // 影モードは枠 B を使う。実行中の影モードも枠 B とテキストの同時数に数える。
  let laneB =
    runningWork.filter((call) => TASK_RULES[call.task].lane === 'B').length +
    runningShadow.length;
  let local = state.running.filter((call) => call.provider === 'local').length;
  let text = laneA + laneB;
  const providers = new Map<string, number>();
  for (const call of state.running)
    providers.set(call.provider, (providers.get(call.provider) ?? 0) + 1);
  const runningNonShadow = runningWork.length > 0;

  const decisions: CallDecision[] = requests.map(() => ({
    admit: false,
    action: 'wait',
    reasons: ['not_planned'],
  }));
  const order = requests
    .map((request, index) => ({ request, index }))
    .sort(
      (left, right) =>
        rank(left.request) - rank(right.request) || left.index - right.index,
    );
  let admittedNonShadow = false;
  for (const { request, index } of order) {
    const rule = TASK_RULES[request.task];
    // ジョブの規則と明示のフラグが食い違う要求は受け付けない（影モードの制御を迂回させない）。
    if (request.shadow !== undefined && request.shadow !== rule.shadow) {
      decisions[index] = {
        admit: false,
        action: 'wait',
        reasons: ['shadow_flag_mismatch'],
      };
      continue;
    }
    const shadow = rule.shadow;
    // 既定 OFF・予算なしの影モードは、経路の有無より先に skip する（経路が null でも待機にしない）。
    if (shadow && state.shadow_enabled !== true) {
      decisions[index] = {
        admit: false,
        action: 'skip',
        reasons: ['shadow_disabled'],
      };
      continue;
    }
    if (shadow && state.budget_available !== true) {
      decisions[index] = {
        admit: false,
        action: 'skip',
        reasons: ['shadow_budget'],
      };
      continue;
    }
    const route = resolveModelRoute(config, request.task);
    if (!route.ok) {
      decisions[index] = {
        admit: false,
        action: 'wait',
        reasons: route.reasons,
      };
      continue;
    }
    const provider = route.profile.provider;
    const isLocal = provider === 'local';
    // ローカル生成は、ローカル ASR だけでなく、ローカル provider を使うテキストの仕事も同時 1 本まで。
    // 影モードは、この段階で枠が埋まっていても待機にせず skip する（比較のために本人の仕事を待たせない）。
    if (isLocal && local >= LOCAL_GENERATION_LIMIT) {
      decisions[index] = shadow
        ? { admit: false, action: 'skip', reasons: ['shadow_wait'] }
        : { admit: false, action: 'wait', reasons: ['local_limit'] };
      continue;
    }
    const providerLimit = limits[provider] ?? route.profile.max_concurrency;
    const providerCount = providers.get(provider) ?? 0;

    if (shadow) {
      // 本人の依頼・自発の仕事がある間は、影モードのために枠を空けない（待たせない・skip）。
      const pendingNonShadow = requests.some(
        (entry, entryIndex) =>
          entryIndex !== index && !TASK_RULES[entry.task].shadow,
      );
      if (runningNonShadow || admittedNonShadow || pendingNonShadow) {
        decisions[index] = {
          admit: false,
          action: 'skip',
          reasons: ['shadow_busy'],
        };
        continue;
      }
      if (text >= TEXT_INFERENCE_LIMIT || laneB >= LANE_B_LIMIT) {
        decisions[index] = {
          admit: false,
          action: 'skip',
          reasons: ['shadow_wait'],
        };
        continue;
      }
      if (providerCount >= providerLimit) {
        decisions[index] = {
          admit: false,
          action: 'skip',
          reasons: [`provider_limit:${provider}`],
        };
        continue;
      }
      laneB += 1;
      text += 1;
      if (isLocal) local += 1;
      providers.set(provider, providerCount + 1);
      decisions[index] = { admit: true, lane: 'B', priority: rule.priority };
      continue;
    }

    if (rule.lane === 'local') {
      if (local >= LOCAL_GENERATION_LIMIT) {
        decisions[index] = {
          admit: false,
          action: 'wait',
          reasons: ['local_limit'],
        };
        continue;
      }
      if (providerCount >= providerLimit) {
        decisions[index] = {
          admit: false,
          action: 'wait',
          reasons: [`provider_limit:${provider}`],
        };
        continue;
      }
      local += 1;
      providers.set(provider, providerCount + 1);
      admittedNonShadow = true;
      decisions[index] = {
        admit: true,
        lane: 'local',
        priority: rule.priority,
      };
      continue;
    }

    const lane = rule.lane;
    if (lane === 'A' && laneA >= LANE_A_LIMIT) {
      decisions[index] = {
        admit: false,
        action: 'wait',
        reasons: ['lane_a_busy'],
      };
      continue;
    }
    if (lane === 'B' && laneB >= LANE_B_LIMIT) {
      decisions[index] = {
        admit: false,
        action: 'wait',
        reasons: ['lane_b_busy'],
      };
      continue;
    }
    if (text >= TEXT_INFERENCE_LIMIT) {
      decisions[index] = {
        admit: false,
        action: 'wait',
        reasons: ['text_limit'],
      };
      continue;
    }
    if (providerCount >= providerLimit) {
      decisions[index] = {
        admit: false,
        action: 'wait',
        reasons: [`provider_limit:${provider}`],
      };
      continue;
    }
    if (lane === 'A') laneA += 1;
    else laneB += 1;
    text += 1;
    if (isLocal) local += 1;
    providers.set(provider, providerCount + 1);
    admittedNonShadow = true;
    decisions[index] = { admit: true, lane, priority: rule.priority };
  }
  return decisions;
}
