// モデルを使う解釈（Interpreter）の実装（B10-03 P2、ADR 0091）。設計 10 §5・§5A・§6A、ADR 0004・0005・0070・0090。
//
// - 差し込み口は turn-ports の Interpreter。会話の操作（照合表）は api-turns が**この解釈より前**にコードで照合するので、
//   ここには届かない（X58）。この層は意図＋引数の判定を 1 回だけ呼ぶ。
// - 返す値は信用されない（Core が意図表・契約・意味検証で再度確かめる）。モデルは承認・実行権限・処理状態・effect_kind の
//   正本にならない。
// - 判定の失敗（拒否・打ち切り・形式/意味の不正・timeout・利用不可・予算）を unclear に混ぜず failed で返す。
//   自動の再送・JSON 修復・上位モデルでの再試行はしない。
// - 費用は ModelCallGuard の口（予約→送る→精算）の内側で扱う。実際の B07 の門（BudgetGate）への接続は別の子で行い、
//   ここでは口だけを決めて模擬で試験する。
import { randomUUID } from 'node:crypto';
import type { ModelProfile, ModelUsage } from '@buddy/contracts';
import {
  intentInputErrors,
  judgeIntent,
  MAX_CANDIDATES,
  MAX_OPEN_WORKFLOWS,
} from '@buddy/ai';
import type {
  IntentJudgmentInput,
  IntentJudgmentResult,
  JudgmentCandidate,
  JudgmentWorkflow,
  LlmAdapter,
  SchemaValidator,
} from '@buddy/ai';
import type {
  InterpretationContext,
  Interpreter,
  InterpreterReply,
  ModelFailureKind,
} from './turn-ports.js';

// 送る前の受付と、送った後の精算（B07 の予約 R・最大負担 M の受付に相当）。拒否なら送らない。
export type ModelCallAdmission =
  | {
      readonly ok: true;
      // 送って usage が分かったら精算する。usage が null なら usage 不明として予約を保持する（解放しない）。
      readonly settle: (usage: ModelUsage | null) => Promise<void>;
      // 受け付けたが送らなかった（送る直前の再確認で止めた）。予約を解放する。送った可能性があるときは呼ばない。
      readonly release: () => Promise<void>;
    }
  | { readonly ok: false; readonly reasons: readonly string[] };

export interface ModelCallGuard {
  admit(call: {
    readonly request_id: string;
    readonly profile: ModelProfile;
  }): Promise<ModelCallAdmission>;
}

// 診断用の記録（発話の本文・引数の値・モデルの自由文は含めない）。
export interface JudgmentDiagnostic {
  readonly request_id: string;
  readonly profile_id: string;
  readonly sent: boolean;
  readonly result: 'intent' | 'unclear' | 'failed';
  readonly failure: ModelFailureKind | null;
  readonly detail: string | null;
  readonly reasons: readonly string[];
  readonly usage: ModelUsage | null;
  readonly elapsed_ms: number;
}

export interface ModelInterpreterOptions {
  readonly adapter: LlmAdapter;
  // 意図判定の profile（暫定は D1 の Gemini 3.8 Flash・思考 low。profile で差し替える）。
  readonly profile: ModelProfile;
  // 契約の WireResponse の JSON Schema（根の $defs つき。provider へ送る形は codec が作る）。
  readonly output_schema: unknown;
  readonly schema: SchemaValidator;
  readonly guard: ModelCallGuard;
  readonly now?: () => number;
  readonly onJudged?: (diagnostic: JudgmentDiagnostic) => void;
  readonly newRequestId?: () => string;
}

// 候補の目印は Core が決めた中立の値（一覧の順番）だけ。件名・差出人・本文・provider の ID は渡さない（U216）。
function judgmentCandidates(
  context: InterpretationContext,
): readonly JudgmentCandidate[] {
  return context.mail_candidates
    .slice(0, MAX_CANDIDATES)
    .map((item, index) => ({
      candidate_id: item.candidate_id,
      label: `メール${index + 1}`,
    }));
}

function judgmentWorkflows(
  context: InterpretationContext,
): readonly JudgmentWorkflow[] {
  return (context.open_workflows ?? []).slice(0, MAX_OPEN_WORKFLOWS);
}

// 本線と影モードの比較が使う共通の入力（候補と依頼を同じ上限で絞る）。条件をそろえるため、両方がこの関数を使う。
export function judgmentInputOf(
  context: InterpretationContext,
): IntentJudgmentInput {
  return {
    utterance: context.text,
    today: context.today,
    candidates: judgmentCandidates(context),
    open_workflows: judgmentWorkflows(context),
  };
}

function replyOf(result: IntentJudgmentResult): InterpreterReply {
  const judgment = result.judgment;
  if (judgment.kind === 'failed')
    return {
      kind: 'failed',
      failure: judgment.failure,
      retryable: judgment.retryable,
    };
  if (judgment.kind === 'unclear')
    return judgment.relation === 'new'
      ? { kind: 'unclear' }
      : {
          kind: 'unclear',
          relation: judgment.relation,
          ...(judgment.target_workflow_id === null
            ? {}
            : { target_workflow_id: judgment.target_workflow_id }),
        };
  return {
    kind: 'intent',
    intent: judgment.intent,
    args: judgment.args,
    relation: judgment.relation,
    ...(judgment.target_workflow_id === null
      ? {}
      : { target_workflow_id: judgment.target_workflow_id }),
  };
}

export function createModelInterpreter(
  options: ModelInterpreterOptions,
): Interpreter {
  const now = options.now ?? (() => Date.now());
  const newRequestId = options.newRequestId ?? (() => randomUUID());
  return {
    async interpret(context) {
      const requestId = newRequestId();
      const started = now();
      const diagnose = (
        result: IntentJudgmentResult | null,
        failure: ModelFailureKind | null,
        usage: ModelUsage | null,
      ): void => {
        try {
          options.onJudged?.({
            request_id: requestId,
            profile_id: options.profile.profile_id,
            sent: result?.sent ?? false,
            result:
              result === null || result.judgment.kind === 'failed'
                ? 'failed'
                : result.judgment.kind,
            failure,
            detail: result?.detail ?? null,
            reasons: result?.reasons ?? [],
            usage,
            elapsed_ms: Math.max(0, now() - started),
          });
        } catch {
          // 診断の失敗で解釈を止めない。
        }
      };
      const input = judgmentInputOf(context);
      // 入力の検査に通らない発話は、予約も送信もしない（切って送ると意図が変わる）。
      if (intentInputErrors(input).length > 0) {
        diagnose(null, 'invalid_semantics', null);
        return {
          kind: 'failed',
          failure: 'invalid_semantics',
          retryable: false,
        };
      }
      let admission: ModelCallAdmission;
      try {
        admission = await options.guard.admit({
          request_id: requestId,
          profile: options.profile,
        });
      } catch {
        // 予算の口が答えなかった。送らない（送った可能性がないので安全側）。
        diagnose(null, 'unavailable', null);
        return { kind: 'failed', failure: 'unavailable', retryable: true };
      }
      if (!admission.ok) {
        diagnose(null, 'budget_denied', null);
        return { kind: 'failed', failure: 'budget_denied', retryable: true };
      }
      let result: IntentJudgmentResult;
      try {
        result = await judgeIntent(options.adapter, {
          request_id: requestId,
          profile: options.profile,
          input,
          output_schema: options.output_schema,
          schema: options.schema,
        });
      } catch {
        // アダプターが例外を投げた: 送った可能性があるので、usage 不明として予約を保持する（再送しない）。
        await admission.settle(null).catch(() => undefined);
        diagnose(null, 'unavailable', null);
        return { kind: 'failed', failure: 'unavailable', retryable: true };
      }
      await admission.settle(result.outcome.usage).catch(() => undefined);
      diagnose(
        result,
        result.judgment.kind === 'failed' ? result.judgment.failure : null,
        result.outcome.usage,
      );
      return { ...replyOf(result), elapsed_ms: Math.max(0, now() - started) };
    },
  };
}
