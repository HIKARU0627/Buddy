// モデルの生の抽出（ExtractionWire）から、Core が検証した ExtractionResult v2 を作る（B10-05 P2、ADR 0101）。
// 設計 11 §3（根拠の対応付け・コードによる検証）・§5A・§5B、設計 09 X39・X62・X63・QA09〜QA11、ADR 0007。
// - 根拠の引用は、**送ったソースの text** で（source_id・part・版・位置の一意性）をコードが照合する。照合できない根拠は
//   explicit にせず、依頼の confidence を low に下げる（自動実行の対象にしない）。モデルの自己申告を認可に使わない。
// - 位置（start/end）・未読・切詰め・宛先・自動配信・依頼 ID は、コードが決める。モデルの出力から読まない。
// - 年が書かれていない日付をモデルが確定した場合は、確定値にせず unresolved（missing_year）へ下げる（X63・QA09）。
// - 期限の欄の組み合わせが矛盾する出力は直さず意味検証の失敗にする（ADR 0007）。
import type {
  Deadline,
  ExtractedRequest,
  ExtractionResult,
  ExtractionWire,
  FieldEvidence,
  RequestChange,
  SourceCompleteness,
  SourceQuote,
  SourceRef,
} from '@buddy/contracts';
import { codePointLength, toDeadline } from '@buddy/domain';
import type { ExtractionSource, WireDeadline } from '@buddy/domain';
import type { SemanticValidator } from './validation.js';

export type QuoteFailure =
  | 'source_unknown'
  | 'part_mismatch'
  | 'revision_mismatch'
  | 'not_found'
  | 'ambiguous';

export type QuoteCheck =
  | { readonly ok: true; readonly ref: SourceRef }
  | { readonly ok: false; readonly reason: QuoteFailure };

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean =>
  code >= 0xdc00 && code <= 0xdfff;

// 一致が対になったサロゲートの途中から始まる・終わる位置は、コードポイントの境界ではないので除く。
function onCodePointBoundary(
  text: string,
  start: number,
  end: number,
): boolean {
  if (
    start > 0 &&
    start < text.length &&
    isLowSurrogate(text.charCodeAt(start)) &&
    isHighSurrogate(text.charCodeAt(start - 1))
  )
    return false;
  if (
    end > 0 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  )
    return false;
  return true;
}

// 引用をソースの text から探す。重なる一致も数え、一意でなければ照合できないとする（QA11）。
// 位置は Unicode コードポイント、end は含まない。文字の正規化（NFC など）はしない（正規化の違いは不一致にする）。
export function locateQuote(
  text: string,
  quote: string,
):
  | { readonly kind: 'found'; readonly start: number; readonly end: number }
  | { readonly kind: 'not_found' | 'ambiguous' } {
  if (quote === '') return { kind: 'not_found' };
  const starts: number[] = [];
  for (let from = 0; ;) {
    const index = text.indexOf(quote, from);
    if (index < 0) break;
    if (onCodePointBoundary(text, index, index + quote.length))
      starts.push(index);
    from = index + 1;
  }
  if (starts.length === 0) return { kind: 'not_found' };
  if (starts.length > 1) return { kind: 'ambiguous' };
  const start = codePointLength(text.slice(0, starts[0]));
  return { kind: 'found', start, end: start + codePointLength(quote) };
}

export function checkQuote(
  quote: SourceQuote,
  sources: readonly ExtractionSource[],
): QuoteCheck {
  const source = sources.find((item) => item.source_id === quote.source_id);
  if (source === undefined) return { ok: false, reason: 'source_unknown' };
  if (source.part !== quote.part) return { ok: false, reason: 'part_mismatch' };
  if (source.source_revision !== quote.source_revision)
    return { ok: false, reason: 'revision_mismatch' };
  const located = locateQuote(source.text, quote.quote);
  if (located.kind !== 'found') return { ok: false, reason: located.kind };
  return {
    ok: true,
    ref: {
      source_id: source.source_id,
      source_revision: source.source_revision,
      quote: quote.quote,
      start: located.start,
      end: located.end,
    },
  };
}

// --- 意味の検証（モデルの出力を直さず、矛盾は失敗にする） ---

function calendarDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(text);
  if (match === null) return false;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function clockTime(text: string): boolean {
  const match = /T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(text);
  if (match === null) return true;
  return (
    Number(match[1]) < 24 &&
    Number(match[2]) < 60 &&
    Number(match[3] ?? '0') < 60
  );
}

// resolution ごとに全ての欄の組み合わせを見る。使わない欄に値が入った出力（例: 確定した日時に unresolved_reason が付く）は、
// 矛盾として拒否する（組立てで黙って捨てて確定値にしない）。
function deadlineShapeConsistent(wire: WireDeadline): boolean {
  const none = (value: unknown): boolean => value === null;
  const some = (value: unknown): boolean => value !== null;
  switch (wire.resolution) {
    case 'exact_datetime':
      return (
        some(wire.local_datetime) &&
        none(wire.local_date) &&
        some(wire.original_text) &&
        none(wire.unresolved_reason)
      );
    case 'date_only':
      return (
        none(wire.local_datetime) &&
        some(wire.local_date) &&
        some(wire.original_text) &&
        none(wire.unresolved_reason)
      );
    case 'relative_unresolved':
      return (
        none(wire.local_datetime) &&
        none(wire.local_date) &&
        some(wire.original_text) &&
        some(wire.unresolved_reason)
      );
    case 'none':
      return (
        none(wire.local_datetime) &&
        none(wire.local_date) &&
        none(wire.original_text) &&
        none(wire.unresolved_reason)
      );
  }
}

function deadlineErrors(wire: WireDeadline, label: string): string[] {
  const reasons: string[] = [];
  if (!deadlineShapeConsistent(wire) || toDeadline(wire, 'zone') === null)
    reasons.push(`deadline_inconsistent:${label}`);
  for (const value of [wire.local_datetime, wire.local_date]) {
    if (value !== null && !(calendarDate(value) && clockTime(value)))
      reasons.push(`deadline_date_invalid:${label}`);
  }
  return reasons;
}

export function extractionWireErrors(wire: ExtractionWire): readonly string[] {
  const reasons: string[] = [];
  wire.requests.forEach((request, index) => {
    reasons.push(...deadlineErrors(request.deadline, `request:${index}`));
  });
  wire.changes.forEach((change, index) => {
    if (change.new_deadline !== null)
      reasons.push(...deadlineErrors(change.new_deadline, `change:${index}`));
  });
  return [...new Set(reasons)];
}

export const extractionSemantics: SemanticValidator<ExtractionWire> = {
  errors: extractionWireErrors,
};

// --- 結果の組立て ---

export interface MessageFacts {
  // ヘッダーからコードが決める（To に本人のアドレスがある。CC だけは false）。モデルに判定させない。
  readonly addressed_to_me: boolean;
  readonly from_automated_sender: boolean;
}

export interface ExtractionHeader {
  readonly source_account_id: string;
  readonly thread_id: string;
  readonly message_id: string;
  // 件名・本文が属するメッセージの版。
  readonly source_revision: string;
  readonly profile_id: string;
  // 固定の指示文と出力の schema の hash（Core が計算する。同じ版の結果を再利用する鍵）。
  readonly prompt_hash: string;
  readonly schema_hash: string;
}

// 既存の依頼のうち、根拠の位置から一意に対応づけられる候補の ID（5A 節の規則は Core が持つ）。
// 0 件は未解決、1 件は解決、2 件以上は曖昧。モデルの類似度では決めない。
export type TargetResolver = (
  refs: readonly SourceRef[],
  relation: RequestChange['relation'],
) => readonly string[];

export interface BuildExtractionParams {
  readonly header: ExtractionHeader;
  readonly zone: string;
  readonly received_at_local: string;
  readonly wire: ExtractionWire;
  // 実際に送ったソース（切り詰め後）。
  readonly sources: readonly ExtractionSource[];
  // 入力を組み立てるコードが確定した完全性。モデルの出力で変えない。
  readonly completeness: SourceCompleteness;
  readonly facts: MessageFacts;
  readonly resolveTarget?: TargetResolver;
}

// 診断用の数え上げ。本文・引用・期限の原文を含めない。
export interface ExtractionDiagnostics {
  readonly quote_failures: Readonly<Record<QuoteFailure, number>>;
  readonly deadline_unverified: number;
  readonly year_downgrades: number;
  readonly time_downgrades: number;
  readonly requests_lowered: number;
  readonly unresolved_changes: number;
}

export interface BuiltExtraction {
  readonly result: ExtractionResult;
  readonly diagnostics: ExtractionDiagnostics;
}

export const RECIPIENT_RULE_ID = 'recipient_header_v1';

interface QuoteSet {
  readonly refs: readonly SourceRef[];
  readonly failures: readonly QuoteFailure[];
  readonly total: number;
}

function checkAll(
  quotes: readonly SourceQuote[],
  sources: readonly ExtractionSource[],
): QuoteSet {
  const refs: SourceRef[] = [];
  const failures: QuoteFailure[] = [];
  for (const quote of quotes) {
    const checked = checkQuote(quote, sources);
    if (checked.ok) refs.push(checked.ref);
    else failures.push(checked.reason);
  }
  return { refs, failures, total: quotes.length };
}

// 項目の根拠の状態。引用が 1 つも無い・全部照合できない → missing、一部だけ照合できない → conflicting、
// 全部照合できた → explicit。照合できない根拠を explicit にしない。
function fieldOf(field: FieldEvidence['field'], set: QuoteSet): FieldEvidence {
  if (set.total === 0 || set.refs.length === 0)
    return { field, status: 'missing', refs: [], rule_id: null };
  if (set.failures.length > 0)
    return { field, status: 'conflicting', refs: [...set.refs], rule_id: null };
  return { field, status: 'explicit', refs: [...set.refs], rule_id: null };
}

// 年を表す語と、受信年からの差。「再来年」は「来年」を含むので、語は長い順に探して一致した部分を取り除く。
const YEAR_WORDS: readonly (readonly [string, number])[] = [
  ['再来年', 2],
  ['来年', 1],
  ['今年', 0],
  ['昨年', -1],
  ['去年', -1],
];

// 確定した年の根拠が、同じ依頼の引用・期限の原文にあるか。年の数字（前後が数字でない）か、受信年を基準にした
// 「今年・来年・再来年・昨年・去年」だけを根拠にし、受信日から年を推測しない（設計 11 §3、X63）。
export function yearJustified(
  year: number,
  evidenceText: string,
  receivedYear: number,
): boolean {
  if (new RegExp(`(?<![0-9])${year}(?![0-9])`, 'u').test(evidenceText))
    return true;
  let rest = evidenceText;
  for (const [word, offset] of YEAR_WORDS) {
    if (!rest.includes(word)) continue;
    if (receivedYear + offset === year) return true;
    rest = rest.replaceAll(word, '');
  }
  return false;
}

function resolvedYear(deadline: Deadline): number | null {
  if (deadline.kind === 'instant')
    return Number(deadline.local_datetime.slice(0, 4));
  if (deadline.kind === 'date') return Number(deadline.date.slice(0, 4));
  return null;
}

// 原文に時刻の表現があるか（「17時」「17:00」「午後」「正午」「5pm」「noon」など）。日付だけの原文は false。
export function timeExpressed(text: string): boolean {
  return (
    /[0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}/u.test(text) ||
    /[0-9０-９]{1,2}\s*時/u.test(text) ||
    /午前|午後|正午|真夜中/u.test(text) ||
    /[0-9]\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])/iu.test(text) ||
    /\b(?:noon|midnight)\b/iu.test(text)
  );
}

interface DeadlineOutcome {
  readonly deadline: Deadline;
  readonly evidence: FieldEvidence | null;
  readonly verified: boolean;
  readonly year_downgraded: boolean;
  readonly time_downgraded: boolean;
}

// 期限を確定する。原文（original_text）が、照合できた引用の中、または送ったソースの中に一意にあるときだけ explicit。
function resolveDeadline(
  wire: WireDeadline | null,
  quoteRefs: readonly SourceRef[],
  context: BuildExtractionParams,
): DeadlineOutcome {
  const incomplete =
    context.completeness.unread_source_ids.length > 0 ||
    context.completeness.truncated_source_ids.length > 0;
  let base = wire === null ? null : toDeadline(wire, context.zone);
  // 原文に時刻の表現がないのにモデルが日時を確定した出力は、日付だけの期限へ下げる（時刻を補わない。設計 11 §5 D15）。
  // 日時（instant）は予定の自動作成の条件なので、補われた時刻で予定を作らせない。
  let timeDowngraded = false;
  if (
    base !== null &&
    base.kind === 'instant' &&
    !timeExpressed(base.original_text)
  ) {
    base = {
      kind: 'date',
      date: base.local_datetime.slice(0, 10),
      original_text: base.original_text,
    };
    timeDowngraded = true;
  }
  if (base === null || base.kind === 'none')
    return {
      deadline: { kind: 'none' },
      // 期限なしと判定できても、読めていない部分があるなら「期限なし」を確定しない（X39・QA10）。
      evidence: incomplete
        ? { field: 'deadline', status: 'unread', refs: [], rule_id: null }
        : null,
      verified: true,
      year_downgraded: false,
      time_downgraded: false,
    };
  const original = base.original_text;
  const inQuotes = quoteRefs.filter((ref) => ref.quote.includes(original));
  let refs: SourceRef[] = [...inQuotes];
  if (refs.length === 0) {
    const located = context.sources.map((source) => ({
      source,
      result: locateQuote(source.text, original),
    }));
    const found = located.flatMap(({ source, result }) =>
      result.kind === 'found'
        ? [
            {
              source_id: source.source_id,
              source_revision: source.source_revision,
              quote: original,
              start: result.start,
              end: result.end,
            },
          ]
        : [],
    );
    // 原文が全体で一つに決まるときだけ照合できる。どこかのソースで曖昧（同じソースに複数）なら、
    // 別のソースで一意に見つかっても照合できないとする（曖昧な期限を一意に見せない）。
    const anyAmbiguous = located.some(
      ({ result }) => result.kind === 'ambiguous',
    );
    if (found.length === 1 && !anyAmbiguous) refs = found;
  }
  if (refs.length === 0)
    return {
      deadline: base,
      evidence: {
        field: 'deadline',
        status: 'missing',
        refs: [],
        rule_id: null,
      },
      verified: false,
      year_downgraded: false,
      time_downgraded: false,
    };
  const year = resolvedYear(base);
  const receivedYear = Number(context.received_at_local.slice(0, 4));
  const evidenceText = [original, ...quoteRefs.map((ref) => ref.quote)].join(
    '\n',
  );
  const downgraded =
    year !== null && !yearJustified(year, evidenceText, receivedYear);
  return {
    deadline: downgraded
      ? { kind: 'unresolved', reason: 'missing_year', original_text: original }
      : base,
    evidence: { field: 'deadline', status: 'explicit', refs, rule_id: null },
    verified: true,
    year_downgraded: downgraded,
    time_downgraded: timeDowngraded,
  };
}

const emptyFailureCounts = (): Record<QuoteFailure, number> => ({
  source_unknown: 0,
  part_mismatch: 0,
  revision_mismatch: 0,
  not_found: 0,
  ambiguous: 0,
});

function overlapsQuoted(
  refs: readonly SourceRef[],
  sources: readonly ExtractionSource[],
): boolean {
  return refs.some((ref) =>
    sources
      .find((source) => source.source_id === ref.source_id)
      ?.quoted_ranges.some(
        (range) => ref.start < range.end && ref.end > range.start,
      ),
  );
}

export function buildExtractionResult(
  params: BuildExtractionParams,
): BuiltExtraction {
  // 期限の欄が矛盾した出力は、意味検証（extractionWireErrors）で先に拒否する。ここへ来たら組み立てずに止める
  // （矛盾を「期限なし」などへ黙って直さない）。
  if (extractionWireErrors(params.wire).length > 0)
    throw new Error('extraction_wire_invalid');
  const failures = emptyFailureCounts();
  let deadlineUnverified = 0;
  let yearDowngrades = 0;
  let timeDowngrades = 0;
  let requestsLowered = 0;
  let unresolvedChanges = 0;
  const count = (set: QuoteSet): void => {
    for (const reason of set.failures) failures[reason] += 1;
  };

  const requests: ExtractedRequest[] = params.wire.requests.map(
    (request, index) => {
      const quotes = checkAll(request.evidence, params.sources);
      count(quotes);
      const deadline = resolveDeadline(request.deadline, quotes.refs, params);
      if (!deadline.verified) deadlineUnverified += 1;
      if (deadline.year_downgraded) yearDowngrades += 1;
      if (deadline.time_downgraded) timeDowngrades += 1;
      const summary = fieldOf('summary', quotes);
      const fields: FieldEvidence[] = [
        summary,
        { ...summary, field: 'kind' },
        {
          field: 'target',
          status: 'derived',
          refs: [],
          rule_id: RECIPIENT_RULE_ID,
        },
      ];
      if (deadline.evidence !== null) fields.push(deadline.evidence);
      // 根拠の照合に失敗した依頼は、自己申告の confidence が高くても low に下げる（自動実行の対象にしない）。
      const lowered =
        quotes.failures.length > 0 ||
        summary.status !== 'explicit' ||
        !deadline.verified;
      if (lowered && request.confidence !== 'low') requestsLowered += 1;
      return {
        request_index: index,
        kind: request.kind,
        summary: request.summary,
        deadline: deadline.deadline,
        fields,
        // モデルの申告と、引用の範囲に重なる根拠があるかの、どちらかが引用なら引用として扱う。
        in_quoted_text:
          request.in_quoted_text ||
          overlapsQuoted(
            [...quotes.refs, ...(deadline.evidence?.refs ?? [])],
            params.sources,
          ),
        confidence_observed: lowered ? 'low' : request.confidence,
        addressed_to_me: params.facts.addressed_to_me,
        from_automated_sender: params.facts.from_automated_sender,
        // 既存の依頼との対応づけ（5A 節）は Core の別の層。ここでは決めない。
        request_entity_id: null,
        request_revision: null,
      };
    },
  );

  const changes: RequestChange[] = params.wire.changes.map((change) => {
    const target = checkAll(change.target_evidence, params.sources);
    const evidence = checkAll(change.change_evidence, params.sources);
    count(target);
    count(evidence);
    const needsTarget = change.relation !== 'new';
    const fields: FieldEvidence[] = [];
    if (needsTarget) fields.push(fieldOf('target', target));
    fields.push(fieldOf('change', evidence));
    const newDeadline = resolveDeadline(
      change.new_deadline,
      evidence.refs,
      params,
    );
    if (change.new_deadline !== null && !newDeadline.verified)
      deadlineUnverified += 1;
    if (newDeadline.year_downgraded) yearDowngrades += 1;
    if (newDeadline.time_downgraded) timeDowngrades += 1;
    if (change.new_deadline !== null && newDeadline.evidence !== null)
      fields.push(newDeadline.evidence);

    let resolution: RequestChange['resolution'] = 'unresolved';
    let targetId: string | null = null;
    if (change.relation === 'new') resolution = 'resolved';
    else if (
      change.relation !== 'uncertain' &&
      target.failures.length === 0 &&
      target.refs.length > 0 &&
      // 変更の内容（「取り消します」など）の根拠も照合できたときだけ解決する。根拠のない取消で依頼を止めない。
      evidence.failures.length === 0 &&
      evidence.refs.length > 0 &&
      params.resolveTarget !== undefined
    ) {
      const candidates = params.resolveTarget(target.refs, change.relation);
      if (candidates.length === 1) {
        resolution = 'resolved';
        targetId = candidates[0] ?? null;
      } else if (candidates.length > 1) resolution = 'ambiguous';
    }
    if (resolution !== 'resolved') unresolvedChanges += 1;
    return {
      relation: change.relation,
      target_request_entity_id: targetId,
      resolution,
      fields,
      new_deadline: change.new_deadline === null ? null : newDeadline.deadline,
    };
  });

  return {
    result: {
      schema: 'buddy.extraction.v2',
      source_account_id: params.header.source_account_id,
      thread_id: params.header.thread_id,
      message_id: params.header.message_id,
      source_revision: params.header.source_revision,
      profile_id: params.header.profile_id,
      prompt_hash: params.header.prompt_hash,
      schema_hash: params.header.schema_hash,
      requests,
      changes,
      // 入力を組み立てるコードが確定した値をそのまま使う（モデルの出力から読まない）。
      completeness: params.completeness,
    },
    diagnostics: {
      quote_failures: failures,
      deadline_unverified: deadlineUnverified,
      year_downgrades: yearDowngrades,
      time_downgrades: timeDowngrades,
      requests_lowered: requestsLowered,
      unresolved_changes: unresolvedChanges,
    },
  };
}
