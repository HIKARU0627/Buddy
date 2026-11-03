// 影モード（比較の記録）。B10-03 P3、ADR 0092。設計 10 §5・§6A、設計 09 X48、設計 05 の影モードの運用（P05）、ADR 0008。
//
// - 既定 OFF（本人の決定 D4）。設定（ShadowSettings）が無い・未開始なら、モデルを呼ばず記録も作らない。
// - 会話に影響しない: 本線の応答を待たせない（observe は同期で戻り、比較は裏で動く）。比較の失敗・遅延・例外は
//   本線へ伝えず、判定の結果を実行に使わない（used_for_execution は常に false）。
// - 記録しない会話・音声の接続中・余力がない・campaign の停止後は走らせない（走らせなければ記録も 0 件）。
// - 300 件（max_inputs）の上限は、開始前の件数の確認と、保存側の原子的な上限の二重で守る。保存期限は会話全文と同じ
//   （storageModeStateEffects の turn_retention_days）で、無期限にしない。
// - 比較の記録は、本線と比較モデルの意図・引数・遅延だけ。発話の本文は持たず input_id で参照する。
// - 保存先（intent_shadow の SQLite 命令・由来の辺・忘却の閉包）は ShadowRecordStore の口にした。この PR の試験は
//   メモリ上の偽の保存先で行う。
import { randomUUID } from 'node:crypto';
import type {
  IntentArgs,
  IntentShadowRecord,
  ModelProfile,
  ShadowJudgment,
} from '@buddy/contracts';
import { judgeIntent } from '@buddy/ai';
import type { IntentJudgment, LlmAdapter, SchemaValidator } from '@buddy/ai';
import {
  shadowAdmission,
  storageModeStateEffects,
  updateShadowCampaign,
} from '@buddy/domain';
import type { ShadowCampaign } from '@buddy/domain';
import type { ApiContract } from './api-contract.js';
import { judgmentInputOf } from './model-interpreter.js';
import type { ModelCallGuard } from './model-interpreter.js';
import type {
  InterpretationContext,
  InterpreterReply,
  ModelFailureKind,
} from './turn-ports.js';

// 比較の件数の上限（設計 09 X48・設計 05 P05 の初期値。設定で下げられるが、300 を超えない）。
export const SHADOW_MAX_INPUTS = 300;
const DAY_MS = 86_400_000;

export interface ShadowTarget {
  // 比較するモデルの配備の ID（記録の deployment_id）。
  readonly deployment_id: string;
  readonly profile: ModelProfile;
  readonly adapter: LlmAdapter;
}

export interface ShadowSettings {
  readonly campaign_id: string;
  // 本線のモデルの配備の ID。
  readonly primary_deployment_id: string;
  // campaign の開始（UTC）。
  readonly started_at: string;
  // 件数の上限（1〜300）。
  readonly max_inputs: number;
  // 比較の実費の上限（金額は設定の値。契約・コードに本人の金額を置かない）。
  readonly max_spend: string;
  readonly max_days: number;
  readonly targets: readonly ShadowTarget[];
}

export type SaveShadowResult =
  'saved' | 'duplicate' | 'limit_reached' | 'failed';

export interface ShadowRecordStore {
  // この campaign の記録の件数（確定した入力の数）。
  count(campaign_id: string): Promise<number>;
  // 同じ (campaign, input, revision) は 1 件だけ。件数が limit に達していれば保存しない（原子的に判定する）。
  save(record: IntentShadowRecord, limit: number): Promise<SaveShadowResult>;
}

export interface ShadowObservation {
  readonly storage_mode: string;
  // 音声の接続（Live）が開いているか。開いている間は始めない（設計 10 §5）。
  readonly live_session_open: boolean;
  readonly input_id: string;
  readonly request_revision: string;
  readonly context: InterpretationContext;
  // 本線の判定（これを実行に使った結果と並べて記録する）。
  readonly primary: InterpreterReply;
}

export type ShadowEvent =
  | { readonly kind: 'skipped'; readonly reasons: readonly string[] }
  | { readonly kind: 'recorded'; readonly result: SaveShadowResult }
  | { readonly kind: 'error' };

export interface ShadowRecorderOptions {
  // null は OFF（D4 の既定）。
  readonly settings: () => ShadowSettings | null;
  readonly store: ShadowRecordStore;
  // 余力があるか（P0・P1・P2 の仕事がない。ai の planModelCalls の判定を呼び出し側が渡す）。
  readonly slotAvailable: () => boolean;
  // 比較の費用は会話専用枠ではなく、自発的な解析と同じ側（origin: shadow_mode）の予算の口で受け付ける。
  readonly guard: ModelCallGuard;
  // 比較の実費の合計（金額は設定の通貨の整数文字列）。省略は '0'。
  readonly spent?: (campaign_id: string) => Promise<string>;
  readonly contract: ApiContract;
  readonly output_schema: unknown;
  readonly schema: SchemaValidator;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly onEvent?: (event: ShadowEvent) => void;
}

export interface ShadowRecorder {
  // 同期で戻る。比較は裏で動き、失敗しても例外を投げない。
  observe(observation: ShadowObservation): void;
  // 動いている比較が終わるのを待つ（試験用）。
  idle(): Promise<void>;
}

const failureOutcome = (
  failure: ModelFailureKind,
): ShadowJudgment['outcome'] => {
  switch (failure) {
    case 'refused':
      return 'refused';
    case 'truncated':
      return 'truncated';
    case 'invalid_schema':
    case 'invalid_semantics':
      return 'invalid_output';
    case 'timeout':
      return 'timeout';
    case 'unavailable':
      return 'unavailable';
    case 'budget_denied':
    case 'cancelled':
    case 'stale':
      return 'skipped';
  }
};

const judgmentOf = (
  deployment_id: string,
  reply:
    | InterpreterReply
    | (IntentJudgment & { readonly kind: 'intent' | 'unclear' | 'failed' }),
  latency_ms: number | null,
): ShadowJudgment => {
  const base = { deployment_id, probability: null, latency_ms };
  if (reply.kind === 'failed')
    return {
      ...base,
      outcome: failureOutcome(reply.failure),
      intent: null,
      args: null,
    };
  if (reply.kind === 'unclear')
    return {
      ...base,
      outcome: 'needs_clarification',
      intent: 'unclear',
      args: null,
    };
  return {
    ...base,
    outcome: 'ok',
    intent: reply.intent as ShadowJudgment['intent'],
    args: reply.args as unknown as IntentArgs,
  };
};

export function createShadowRecorder(
  options: ShadowRecorderOptions,
): ShadowRecorder {
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => randomUUID());
  const running = new Set<Promise<void>>();

  const emit = (event: ShadowEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // 通知の失敗で比較を止めない。
    }
  };

  const run = async (
    observation: ShadowObservation,
    settings: ShadowSettings,
    retentionMs: number,
  ): Promise<void> => {
    const target = settings.targets[0];
    if (target === undefined) return;
    const limit = Math.min(settings.max_inputs, SHADOW_MAX_INPUTS);
    // 開始前の確認: 件数・実費・日数の最初の到達で止める（保存側の上限とは別に、無駄な呼出しをしない）。
    const confirmed = await options.store.count(settings.campaign_id);
    const spent = (await options.spent?.(settings.campaign_id)) ?? '0';
    const campaign: ShadowCampaign = updateShadowCampaign(
      {
        started_at: settings.started_at,
        confirmed_inputs: confirmed,
        spent,
        max_inputs: limit,
        max_spend: settings.max_spend,
        max_days: settings.max_days,
        status: 'running',
        stop_reason: null,
      },
      { addedInputs: 0, addedCost: '0', now: new Date(now()).toISOString() },
    );
    const admission = shadowAdmission({
      privateConversation: false,
      liveSessionOpen: observation.live_session_open,
      slotAvailable: options.slotAvailable(),
      campaign,
    });
    if (!admission.run) {
      emit({ kind: 'skipped', reasons: admission.reasons });
      return;
    }
    const requestId = newId();
    const admitted = await options.guard.admit({
      request_id: requestId,
      profile: target.profile,
    });
    if (!admitted.ok) {
      emit({ kind: 'skipped', reasons: ['shadow_budget'] });
      return;
    }
    const started = now();
    let shadow: ShadowJudgment;
    try {
      const result = await judgeIntent(target.adapter, {
        request_id: requestId,
        profile: target.profile,
        // 比較は本線と同じ入力にする（同じ上限で絞る。条件の差を評価結果にしない）。
        input: judgmentInputOf(observation.context),
        output_schema: options.output_schema,
        schema: options.schema,
      });
      await admitted.settle(result.outcome.usage).catch(() => undefined);
      shadow = judgmentOf(
        target.deployment_id,
        result.judgment,
        Math.max(0, now() - started),
      );
    } catch {
      await admitted.settle(null).catch(() => undefined);
      shadow = judgmentOf(
        target.deployment_id,
        { kind: 'failed', failure: 'unavailable', retryable: true },
        null,
      );
    }
    const recordedAt = now();
    const record: IntentShadowRecord = {
      schema: 'buddy.intent-shadow.v1',
      record_id: newId(),
      campaign_id: settings.campaign_id,
      input_id: observation.input_id,
      request_revision: observation.request_revision,
      primary: judgmentOf(
        settings.primary_deployment_id,
        observation.primary,
        observation.primary.elapsed_ms ?? null,
      ),
      shadows: [shadow],
      recorded_at: new Date(recordedAt).toISOString(),
      expires_at: new Date(recordedAt + retentionMs).toISOString(),
      used_for_execution: false,
    };
    // 契約に合わない記録は保存しない（ID・時刻の形式、本文を持たないこと）。
    if (!options.contract.valid('IntentShadowRecord', record)) {
      emit({ kind: 'error' });
      return;
    }
    emit({
      kind: 'recorded',
      result: await options.store.save(record, limit),
    });
  };

  return {
    observe(observation) {
      let settings: ShadowSettings | null;
      try {
        settings = options.settings();
      } catch {
        return;
      }
      // 既定 OFF: 設定が無ければ、モデルも保存先も触らない。
      if (settings === null) return;
      const effects = storageModeStateEffects(observation.storage_mode);
      // 記録しない会話（比較の記録を作らない）・保存期限が決まらない会話では走らせない。0 件。
      if (
        effects === null ||
        !effects.record_shadow ||
        effects.turn_retention_days === null
      ) {
        emit({ kind: 'skipped', reasons: ['private_conversation'] });
        return;
      }
      const retentionMs = effects.turn_retention_days * DAY_MS;
      const task = run(observation, settings, retentionMs)
        .catch(() => emit({ kind: 'error' }))
        .finally(() => running.delete(task));
      running.add(task);
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}
