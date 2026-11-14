// メール 1 通の抽出の実行（B10-05 P2、ADR 0101）。設計 11 §3・§5B、設計 09 X39・QA02・QA03・QA10。
// - 入力の組立て（P1）→ 1 回だけ送る → schema・意味の検証 → 根拠の照合と ExtractionResult v2 への変換、の順。
// - timeout・不正な出力・途中終了の後に、自動の再送・JSON 修復・上位モデルでの再試行をしない（ADR 0070）。
// - 失敗・未読・切詰めを「依頼 0 件の成功」にしない。結果は analysisStateOfExtraction で関連解析の状態へ写す
//   （analyzed になるのは、成功し、未読・切詰めがないときだけ。設計 11 §5B）。
// - 承認・実行経路・状態・effect_kind はここで決めない（LLM は正本にならない）。
import type {
  ExtractionResult,
  ExtractionWire,
  ModelOutcome,
  ModelProfile,
  ModelUsage,
} from '@buddy/contracts';
import type { LlmAdapter } from './adapter.js';
import { assembleExtractionInput } from './extraction-input.js';
import type {
  ExtractionInputError,
  ExtractionMailInput,
} from './extraction-input.js';
import {
  buildExtractionResult,
  extractionSemantics,
} from './extraction-evidence.js';
import type {
  ExtractionDiagnostics,
  ExtractionHeader,
  MessageFacts,
  TargetResolver,
} from './extraction-evidence.js';
import type { Cancellation, ModelCommand } from './types.js';
import { modelOutcomeFromAdapter } from './validation.js';
import type { OutputFailureDetail, SchemaValidator } from './validation.js';

// モデルの出力の文字数の安全上限。依頼ごとに引用を含むので、意図の判定より大きく取る。
export const MAX_EXTRACTION_OUTPUT_CHARS = 16000;

export interface ExtractMailParams {
  readonly request_id: string;
  readonly profile: ModelProfile;
  readonly input: ExtractionMailInput;
  // 契約の ExtractionWire の JSON Schema（根の $defs つき。provider へ送る形は codec が作る）。
  readonly output_schema: unknown;
  // ExtractionWire のローカルの完全検証（正本は契約の JSON Schema。Core が Ajv の検証器を渡す）。
  readonly schema: SchemaValidator;
  readonly header: ExtractionHeader;
  readonly facts: MessageFacts;
  readonly resolveTarget?: TargetResolver;
  readonly cancellation?: Cancellation;
}

export type MailExtraction =
  // 検証と照合を通り、ExtractionResult v2 になった。未読・切詰めがあっても結果は返るが、analyzed にならない。
  | {
      readonly status: 'extracted';
      readonly result: ExtractionResult;
      readonly diagnostics: ExtractionDiagnostics;
      readonly usage: ModelUsage;
    }
  // 入力が組み立てられず、モデルへ送らなかった。
  | {
      readonly status: 'not_sent';
      readonly errors: readonly ExtractionInputError[];
    }
  // 送ったが、結果を使えない（拒否・打ち切り・schema 不正・意味不正・timeout・利用不可・中断）。
  | {
      readonly status: 'failed';
      readonly failure: Exclude<ModelOutcome['kind'], 'ok'>;
      readonly retryable: boolean;
      readonly detail: OutputFailureDetail | null;
      readonly reasons: readonly string[];
      readonly usage: ModelUsage | null;
    };

export async function extractMail(
  adapter: LlmAdapter,
  params: ExtractMailParams,
): Promise<MailExtraction> {
  const assembled = assembleExtractionInput(params.input);
  if (!assembled.ok) return { status: 'not_sent', errors: assembled.errors };
  const command: ModelCommand = {
    request_id: params.request_id,
    role: 'background_text',
    profile: params.profile,
    messages: assembled.assembled.messages,
    output_schema: params.output_schema,
  };
  const raw = await adapter.complete(command, params.cancellation);
  const validated = modelOutcomeFromAdapter<ExtractionWire>(raw, {
    profile_id: params.profile.profile_id,
    schema: params.schema,
    semantics: extractionSemantics,
    output_limit_tokens: params.profile.output_limit_tokens,
    max_output_chars: MAX_EXTRACTION_OUTPUT_CHARS,
  });
  const outcome = validated.outcome;
  if (outcome.kind !== 'ok')
    return {
      status: 'failed',
      failure: outcome.kind,
      retryable: outcome.retryable,
      detail: validated.detail,
      reasons: validated.reasons,
      usage: outcome.usage,
    };
  const built = buildExtractionResult({
    header: params.header,
    zone: params.input.zone,
    received_at_local: params.input.received_at_local,
    wire: outcome.value,
    sources: assembled.assembled.sources,
    completeness: assembled.assembled.completeness,
    facts: params.facts,
    ...(params.resolveTarget === undefined
      ? {}
      : { resolveTarget: params.resolveTarget }),
  });
  return {
    status: 'extracted',
    result: built.result,
    diagnostics: built.diagnostics,
    usage: outcome.usage,
  };
}

// 関連解析の必要ソースの状態（packages/domain の AnalysisState.sources[].state と同じ語彙）。
export type SourceAnalysisState = 'analyzed' | 'pending' | 'unread' | 'failed';

// 抽出の結果を関連解析の状態へ写す。**analyzed になるのは、結果を得て、未読も切詰めもないときだけ**。
// 依頼が 0 件でも未読があれば unread（空の結果で処理済みにしない。設計 11 §5B）。
export function analysisStateOfExtraction(
  extraction: MailExtraction,
): SourceAnalysisState {
  switch (extraction.status) {
    case 'extracted':
      return extraction.result.completeness.unread_source_ids.length === 0 &&
        extraction.result.completeness.truncated_source_ids.length === 0
        ? 'analyzed'
        : 'unread';
    case 'not_sent':
      // 読める内容がない（本文・添付が未取得）は未読。入力の誤りは失敗。
      return extraction.errors.includes('nothing_readable')
        ? 'unread'
        : 'failed';
    case 'failed':
      // 時間・予算・中断は後で解析できるので pending。出力が使えない・拒否は failed。どちらも ready にしない。
      return ['timeout', 'unavailable', 'budget_denied', 'cancelled'].includes(
        extraction.failure,
      )
        ? 'pending'
        : 'failed';
  }
}
