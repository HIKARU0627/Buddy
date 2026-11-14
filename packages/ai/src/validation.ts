// モデルの生出力の検証と ModelOutcome への変換（B10-02 P3、ADR 0082）。
// 設計 10 §6A D15、設計 09 QA02・QA03、ADR 0070。
// - schema の検査は注入する（正本は contracts の JSON Schema。Core が Ajv の検証器を渡す）。
// - 意味の検査も注入する（意図ごとの規則は domain・B10-03）。ここは失敗の種類を区別して返すだけ。
// - 空・途中の JSON・schema 不一致・上限・拒否・timeout を区別し、**自動の JSON 修復・再送・上位モデルでの再試行をしない**
//   （設計修正案 v1.2 P01・P02）。retryable は利用者が手で再試行したときに成功し得るかだけを表す。
import type { ModelOutcome, ModelUsage, WireResponse } from '@buddy/contracts';
import type { AdapterResult } from './types.js';

export interface SchemaValidator {
  valid(value: unknown): boolean;
}

// 出力の型 T は呼出しの種類ごとの WireResponse（意図の判定）や ExtractionWire（メールの抽出）。既定は意図の判定。
export interface SemanticValidator<T = WireResponse> {
  errors(value: T): readonly string[];
}

// 失敗の内訳。ModelOutcome の kind より細かく、ログ・診断・試験で原因を区別する。
// 空・途中の JSON・schema 不一致は ModelOutcome ではすべて invalid_schema になる（契約の失敗の種類を増やさない）。
export type OutputFailureDetail =
  | 'empty'
  | 'json_parse'
  | 'schema'
  | 'semantics'
  | 'chars_limit'
  | 'output_limit'
  | 'provider_refused'
  | 'provider_truncated';

export interface OutputValidationOptions<T = WireResponse> {
  readonly profile_id: string;
  readonly schema: SchemaValidator;
  readonly semantics?: SemanticValidator<T>;
  // profile の出力上限（思考を含む）。null は上限なし（ローカルなど）。
  readonly output_limit_tokens: number | null;
  // 文字数での安全上の上限（省略は文字数を見ない）。
  readonly max_output_chars?: number;
}

// 契約の ModelOutcome の成功の value だけを T に置き換えた形（T = WireResponse なら ModelOutcome と同じ）。
export type ModelOutcomeOf<T> =
  | Exclude<ModelOutcome, { readonly kind: 'ok' }>
  | (Omit<Extract<ModelOutcome, { readonly kind: 'ok' }>, 'value'> & {
      readonly value: T;
    });

export interface ValidatedModelOutput<T = WireResponse> {
  readonly outcome: ModelOutcomeOf<T>;
  // 受理したときは null。失敗のときは原因の内訳。
  readonly detail: OutputFailureDetail | null;
  // 意味検証の理由（診断用。契約の ModelOutcome には入れない）。
  readonly reasons: readonly string[];
}

type FailureKind = Exclude<ModelOutcome['kind'], 'ok'>;

const failed = <T>(
  kind: FailureKind,
  retryable: boolean,
  usage: ModelUsage | null,
  detail: OutputFailureDetail,
  reasons: readonly string[] = [],
): ValidatedModelOutput<T> => ({
  outcome: { kind, retryable, usage },
  detail,
  reasons,
});

export function modelOutcomeFromAdapter<T = WireResponse>(
  result: AdapterResult,
  options: OutputValidationOptions<T>,
): ValidatedModelOutput<T> {
  if (result.kind !== 'response') {
    if (result.kind === 'timeout')
      return {
        outcome: { kind: 'timeout', retryable: true, usage: result.usage },
        detail: null,
        reasons: [],
      };
    if (result.kind === 'unavailable')
      return {
        outcome: { kind: 'unavailable', retryable: true, usage: result.usage },
        detail: null,
        reasons: [],
      };
    return {
      outcome: { kind: 'cancelled', retryable: false, usage: result.usage },
      detail: null,
      reasons: [],
    };
  }

  if (result.refused)
    return failed('refused', false, result.usage, 'provider_refused');
  if (result.truncated)
    return failed('truncated', false, result.usage, 'provider_truncated');
  if (result.text.trim() === '')
    return failed('invalid_schema', false, result.usage, 'empty');
  if (
    options.max_output_chars !== undefined &&
    result.text.length > options.max_output_chars
  )
    return failed('truncated', false, result.usage, 'chars_limit');
  // PriceCategory の output_tokens は思考を含む（契約の説明）。上限は出力トークンだけで見る。
  if (
    result.usage !== null &&
    options.output_limit_tokens !== null &&
    result.usage.output_tokens > options.output_limit_tokens
  )
    return failed('truncated', false, result.usage, 'output_limit');
  // 成功の ModelOutcome は usage が必須（ADR 0070）。観測できない usage を実測値で埋めない。
  // 量は 0・usage_complete を false にして「観測できていない」ことを表し、出力は捨てない（U191）。
  const observedUsage: ModelUsage = result.usage ?? {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: null,
    usage_complete: false,
  };

  let value: unknown;
  try {
    value = JSON.parse(result.text);
  } catch {
    return failed('invalid_schema', false, result.usage, 'json_parse');
  }
  if (!options.schema.valid(value))
    return failed('invalid_schema', false, result.usage, 'schema');
  const reasons = options.semantics?.errors(value as T) ?? [];
  if (reasons.length > 0)
    return failed(
      'invalid_semantics',
      false,
      result.usage,
      'semantics',
      reasons,
    );
  return {
    outcome: {
      kind: 'ok',
      value: value as T,
      profile_id: options.profile_id,
      usage: observedUsage,
      retryable: false,
    },
    detail: null,
    reasons: [],
  };
}
