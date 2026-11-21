// メール 1 通の抽出の入口（B10-05 P3、ADR 0102）。設計 11 §2・§3・§5B、設計 09 X38・X62、QA10、ADR 0007・0070・0100・0101。
//
// - 流れ: 抽出前フィルター（コード）→ 予算の受付 → 抽出（1 回だけ）→ 精算。フィルターで外したメールは、予算の受付も LLM の
//   呼出しもしない（呼出し 0 回）。
// - 判定の記録は本文なしのメタデータで、診断用。候補（気づき）の保存先とは別の口に渡し、気づきには出さない。
// - 宛先・自動配信はヘッダーから Core が決める。モデルへアドレスを渡さず、モデルに判定させない。
// - 結果は関連解析の必要ソースの状態（analyzed／pending／unread／failed／excluded）へ写す。規則 ID なしの除外・未読の空の
//   結果で関連解析を ready にしない（packages/domain の analysisReadiness）。
// - 承認・実行経路・状態・effect_kind はここで決めない。候補の保存・生成は B11、自動実行の判定表の実行は B13。
import { randomUUID } from 'node:crypto';
import type { ModelProfile, ModelUsage } from '@buddy/contracts';
import {
  analysisStateOfExtraction,
  extractMail,
  extractionInputErrors,
} from '@buddy/ai';
import type {
  ExtractionMailInput,
  LlmAdapter,
  MailExtraction,
  SchemaValidator,
  SourceAnalysisState,
  TargetResolver,
} from '@buddy/ai';
import {
  deriveMessageFacts,
  prefilterDecision,
  prefilterRecord,
} from '@buddy/domain';
import type {
  MailRecipients,
  PrefilterContext,
  PrefilterDecision,
  PrefilterHeaders,
  PrefilterMail,
  PrefilterRecord,
} from '@buddy/domain';
import type { ModelCallGuard } from './model-interpreter.js';

// text/calendar の招待を LLM に送らず、予定はカレンダー連携で扱うときの除外の規則 ID（関連解析の excluded の根拠）。
export const CALENDAR_INVITE_RULE_ID = 'prefilter_calendar_invite_v1';

// 判定の記録の出口（診断用）。候補の保存とは別の口。失敗しても抽出を止めない。
export interface PrefilterRecordSink {
  record(entry: PrefilterRecord): void | Promise<void>;
}

export interface MailExtractionRequest {
  readonly source_account_id: string;
  readonly thread_id: string;
  readonly message_id: string;
  // 件名・本文・許可対象の添付だけ。アドレスの欄を持たない（宛先は下の recipients でコードだけが使う）。
  readonly mail: ExtractionMailInput;
  readonly headers: PrefilterHeaders;
  // 宛先の判定にだけ使う。モデルへは渡さない。
  readonly recipients: MailRecipients;
  readonly own_addresses: readonly string[];
  readonly context: PrefilterContext;
  readonly resolveTarget?: TargetResolver;
}

export type FilteredDecision = Exclude<
  PrefilterDecision,
  { readonly kind: 'analyze' }
>;

export type MailExtractionOutcome =
  // フィルターで外した。予算の受付も LLM の呼出しもしていない。
  | {
      readonly status: 'filtered';
      readonly decision: FilteredDecision;
      readonly record: PrefilterRecord;
    }
  // 解析の対象にした。抽出の結果（成功・送らなかった・失敗）を持つ。
  | {
      readonly status: 'extraction';
      readonly extraction: MailExtraction;
      readonly record: PrefilterRecord;
    };

// 関連解析の必要ソースの状態（packages/domain の AnalysisState.sources[] と同じ形）。
export interface AnalysisSourceState {
  readonly state: SourceAnalysisState | 'excluded';
  readonly rule_id: string | null;
}

export function analysisSourceOf(
  outcome: MailExtractionOutcome,
): AnalysisSourceState {
  if (outcome.status === 'filtered')
    return {
      state: 'excluded',
      rule_id:
        outcome.decision.kind === 'skip_automated'
          ? outcome.decision.rule_id
          : CALENDAR_INVITE_RULE_ID,
    };
  return {
    state: analysisStateOfExtraction(outcome.extraction),
    rule_id: null,
  };
}

export interface MailExtractorOptions {
  readonly adapter: LlmAdapter;
  // 抽出の profile（暫定は D1 の Gemini 3.8 Flash・思考 low。profile で差し替える）。
  readonly profile: ModelProfile;
  // 契約の ExtractionWire の JSON Schema（根の $defs つき。provider へ送る形は codec が作る）。
  readonly output_schema: unknown;
  readonly schema: SchemaValidator;
  readonly guard: ModelCallGuard;
  // 同じ source_revision・profile・prompt・schema の結果を再利用する鍵（Core が固定の指示文と schema から計算する）。
  readonly fingerprints: {
    readonly prompt_hash: string;
    readonly schema_hash: string;
  };
  readonly records: PrefilterRecordSink;
  readonly now?: () => Date;
  readonly newRequestId?: () => string;
}

export interface MailExtractor {
  extract(request: MailExtractionRequest): Promise<MailExtractionOutcome>;
}

// フィルターが見る形（本文なしメタデータの判定にだけ使う）。
function prefilterMailOf(mail: ExtractionMailInput): PrefilterMail {
  return {
    subject: mail.subject,
    body: mail.body.state === 'extracted' ? mail.body.text : null,
    attachments: mail.attachments.map((attachment) =>
      attachment.state === 'extracted'
        ? {
            permitted: attachment.permitted,
            state: 'extracted',
            text: attachment.text,
            truncated: attachment.extraction_truncated === true,
          }
        : {
            permitted: attachment.permitted,
            state: attachment.state,
            text: null,
            truncated: false,
          },
    ),
  };
}

const failedBefore = (
  failure: 'budget_denied' | 'unavailable',
  reasons: readonly string[],
): MailExtraction => ({
  status: 'failed',
  failure,
  retryable: true,
  detail: null,
  reasons,
  usage: null,
});

export function createMailExtractor(
  options: MailExtractorOptions,
): MailExtractor {
  const now = options.now ?? (() => new Date());
  const newRequestId = options.newRequestId ?? (() => randomUUID());
  return {
    async extract(request) {
      const decision = prefilterDecision(
        request.headers,
        prefilterMailOf(request.mail),
        request.context,
      );
      const record = prefilterRecord(
        {
          source_account_id: request.source_account_id,
          message_id: request.message_id,
          source_revision: request.mail.message_revision,
        },
        decision,
        now().toISOString(),
      );
      try {
        await options.records.record(record);
      } catch {
        // 診断の記録の失敗で解析を止めない（結果は気づきとは別の口）。
      }
      if (decision.kind !== 'analyze')
        return { status: 'filtered', decision, record };

      // 入力が組み立てられないメールは、予約も送信もしない（読める内容がなければ未読として扱う）。
      const inputErrors = extractionInputErrors(request.mail);
      if (inputErrors.length > 0)
        return {
          status: 'extraction',
          extraction: { status: 'not_sent', errors: inputErrors },
          record,
        };

      const requestId = newRequestId();
      let admission;
      try {
        admission = await options.guard.admit({
          request_id: requestId,
          profile: options.profile,
        });
      } catch {
        // 予算の口が答えなかった。送らない（送った可能性がないので安全側）。
        return {
          status: 'extraction',
          extraction: failedBefore('unavailable', ['guard_unavailable']),
          record,
        };
      }
      if (!admission.ok)
        return {
          status: 'extraction',
          extraction: failedBefore('budget_denied', admission.reasons),
          record,
        };

      let extraction: MailExtraction;
      try {
        extraction = await extractMail(options.adapter, {
          request_id: requestId,
          profile: options.profile,
          input: request.mail,
          output_schema: options.output_schema,
          schema: options.schema,
          header: {
            source_account_id: request.source_account_id,
            thread_id: request.thread_id,
            message_id: request.message_id,
            source_revision: request.mail.message_revision,
            profile_id: options.profile.profile_id,
            prompt_hash: options.fingerprints.prompt_hash,
            schema_hash: options.fingerprints.schema_hash,
          },
          // 宛先・自動配信はヘッダーから決める（モデルに判定させない）。
          facts: deriveMessageFacts(
            request.headers,
            request.recipients,
            request.own_addresses,
          ),
          ...(request.resolveTarget === undefined
            ? {}
            : { resolveTarget: request.resolveTarget }),
        });
      } catch {
        // アダプターが例外を投げた: 送った可能性があるので、usage 不明として予約を保持する（再送しない）。
        await admission.settle(null).catch(() => undefined);
        return {
          status: 'extraction',
          extraction: failedBefore('unavailable', ['adapter_threw']),
          record,
        };
      }
      const usage: ModelUsage | null =
        extraction.status === 'not_sent' ? null : extraction.usage;
      if (extraction.status === 'not_sent')
        await admission.release().catch(() => undefined);
      else await admission.settle(usage).catch(() => undefined);
      return { status: 'extraction', extraction, record };
    },
  };
}
