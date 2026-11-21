// 関連集合（同じ provider・アカウント・thread）の解析計画と、実行直前の照合（B10-05 P4、ADR 0103）。
// 設計 11 §5A・§5B（F05）、設計 08 §3 F05、設計 09 QA32・QA45、ADR 0007。
//
// - 計画: 公開済みの関連メールの列挙・各メールの解析の状態・取消・完了などの解決状況から、集合の `AnalysisState` と
//   契約の `RelatedAnalysis`（group_id・analysis_revision・source_set_hash・published_generation）を作る。
//   **同じ記録からは同じ結果**（配列の順・解析の到着順・再起動で変わらない）。再起動は記録から計画を作り直すだけで、
//   途中の状態を ready にしない。
// - ready の判定は packages/domain の `analysisReadiness`（列挙完了・必要ソースがすべて解析済みか規則 ID 付きの除外・
//   未解決の変更なし・現在の公開世代）をそのまま使う。ここで条件を足したり緩めたりしない。
// - 最終ガード: 判定に使った版が、変更の transaction（LocalCommand）／送出直前の transaction（RemoteMutation）の時点でも
//   現在の版か、DB の現在値で再検査する。新着・訂正・削除・scope 変更・忘却・TTL 切れで版が変われば旧資格は失効する。
//   DB を読む口（AnalysisReader・EntityReader）は注入する。実際の transaction への配線は B13（自動実行）が行う。
// - 承認・実行経路・状態・effect_kind はここで決めない。候補の保存・生成は B11。
import { createHash } from 'node:crypto';
import type { RelatedAnalysis } from '@buddy/contracts';
import {
  analysisReadiness,
  analysisStillCurrent,
  autoCreationReasons,
  resolveEntityState,
} from '@buddy/domain';
import type {
  AnalysisState,
  EntityRecord,
  EntityState,
  ResolvedChange,
} from '@buddy/domain';
import type { AnalysisSourceState } from './mail-extraction.js';

export interface PlannedSource {
  // 関連集合の必要ソース（公開済みのメール 1 通）の ID と版。
  readonly source_id: string;
  readonly source_revision: string;
  // 抽出の入口が返した状態（analysisSourceOf）。未解析のメールは pending。
  readonly analysis: AnalysisSourceState;
  // そのメールの抽出結果の変更（取消・完了・訂正・不明）。抽出していなければ空。
  readonly changes: readonly ResolvedChange[];
}

// 前回の計画の記録。再起動の後も同じ版番号を続けるために、呼び出し側が保存する。
export interface AnalysisSnapshot {
  readonly analysis_revision: string;
  readonly fingerprint: string;
}

export interface PlanRelatedAnalysisInput {
  readonly group_id: string;
  readonly published_generation: string;
  // 公開済みの関連メールの列挙が最後まで終わったか。列挙の途中では自動実行を始めない。
  readonly enumeration_complete: boolean;
  readonly sources: readonly PlannedSource[];
  readonly previous: AnalysisSnapshot | null;
}

export interface RelatedAnalysisPlan {
  readonly analysis: AnalysisState;
  readonly related: RelatedAnalysis;
  // 次の計画の previous に保存する（版番号は、集合・状態・世代が変わったときだけ進む）。
  readonly snapshot: AnalysisSnapshot;
  // ready にならない理由（analysisReadiness の理由と同じ語。診断用）。
  readonly reasons: readonly string[];
}

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const byId = <T extends { readonly source_id: string }>(
  items: readonly T[],
): T[] =>
  [...items].sort((a, b) =>
    a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0,
  );

// 版番号を 1 進める（AnalysisRevision は 10 進の文字列）。
const nextRevision = (revision: string): string =>
  (BigInt(revision) + 1n).toString();

// 解析の計画。集合の版（source_set_hash）は、必要ソースの ID と版だけから作る（状態は含めない）。
export function planRelatedAnalysis(
  input: PlanRelatedAnalysisInput,
): RelatedAnalysisPlan {
  const ids = new Set<string>();
  for (const source of input.sources) {
    if (ids.has(source.source_id)) throw new Error('duplicate_source');
    ids.add(source.source_id);
  }
  const sources = byId(input.sources);
  const sourceSetHash = sha256(
    JSON.stringify(
      sources.map((source) => [source.source_id, source.source_revision]),
    ),
  );
  // 解決していない変更の数。取消の対象が不明・曖昧・訂正か追加か不明（uncertain）は、集合を ready にしない。
  const unresolved = sources.reduce(
    (count, source) =>
      count +
      source.changes.filter((change) => change.resolution !== 'resolved')
        .length,
    0,
  );
  const analysis: AnalysisState = {
    group_id: input.group_id,
    analysis_revision: '0',
    source_set_hash: sourceSetHash,
    published_generation: input.published_generation,
    // 必要ソースが 1 つも無い集合は、列挙できていないものとして扱う（空で完了にしない）。
    plan_complete: input.enumeration_complete && sources.length > 0,
    sources: sources.map((source) => ({
      state: source.analysis.state,
      rule_id: source.analysis.rule_id,
    })),
    unresolved_change_count: unresolved,
  };
  const readiness = analysisReadiness(analysis, input.published_generation);
  const fingerprint = sha256(
    JSON.stringify([
      input.group_id,
      input.published_generation,
      sourceSetHash,
      analysis.plan_complete,
      sources.map((source) => [
        source.source_id,
        source.analysis.state,
        source.analysis.rule_id,
        // 解決した変更の内容（関係・対象・解決の状態）。依頼の有効状態を変える解析結果が更新されたら版を進める。
        // 並びに依存しないように、変更ごとの JSON を整列する。
        source.changes
          .map((change) =>
            JSON.stringify([
              change.relation,
              change.target_request_entity_id,
              change.resolution,
            ]),
          )
          .sort(),
      ]),
      unresolved,
    ]),
  );
  const revision =
    input.previous === null
      ? '1'
      : input.previous.fingerprint === fingerprint
        ? input.previous.analysis_revision
        : nextRevision(input.previous.analysis_revision);
  const blocking = readiness.reasons.some((reason) =>
    [
      'source_unread',
      'source_failed',
      'excluded_without_rule',
      'unresolved_changes',
    ].includes(reason),
  );
  const status: RelatedAnalysis['status'] = readiness.ready
    ? 'ready'
    : blocking
      ? 'blocked'
      : 'pending';
  return {
    analysis: { ...analysis, analysis_revision: revision },
    related: {
      group_id: input.group_id,
      analysis_revision: revision,
      source_set_hash: sourceSetHash,
      published_generation: input.published_generation,
      plan_complete: analysis.plan_complete,
      status,
      sources: sources.map((source) => ({
        source_id: source.source_id,
        source_revision: source.source_revision,
        state: source.analysis.state,
        rule_id: source.analysis.rule_id,
      })),
      unresolved_change_count: unresolved,
    },
    snapshot: { analysis_revision: revision, fingerprint },
    reasons: readiness.reasons,
  };
}

// --- 依頼の状態（取消・完了を、解析の到着順によらず同じ状態へ） ---

export interface EntityOutcome {
  readonly request_entity_id: string;
  readonly state: EntityState;
  // 新しい用事・予定・ラベル・下書きの自動作成を止める理由（空なら止めない）。操作ごとに見る。
  readonly auto_creation_blocked: (operation: {
    readonly kind: string;
    readonly accountId: string;
    readonly calendarId: string | null;
  }) => readonly string[];
}

// 集合の全ての変更を適用した依頼の有効状態。変更の順序・配列順に依存しない（domain の resolveEntityState）。
export function entityOutcome(
  entity: EntityRecord,
  changes: readonly ResolvedChange[],
): EntityOutcome {
  return {
    request_entity_id: entity.request_entity_id,
    state: resolveEntityState(entity.request_entity_id, entity.state, changes),
    auto_creation_blocked: (operation) =>
      autoCreationReasons(entity, changes, operation),
  };
}

// --- 実行直前の照合（最終ガード） ---

// 判定に使った版（CandidateSnapshot.related_analysis）。
export type UsedAnalysis = Pick<
  RelatedAnalysis,
  'group_id' | 'analysis_revision' | 'source_set_hash' | 'published_generation'
>;

// DB の現在値を読む口（transaction の中で呼ぶ）。無ければ null。
export interface AnalysisReader {
  current(groupId: string): AnalysisState | null;
}

export interface EntityReader {
  current(entityId: string): {
    readonly record: EntityRecord;
    readonly request_revision: string;
  } | null;
}

export interface UsedEntity {
  readonly request_entity_id: string;
  // 判定に使った依頼の版（RequestEntityRevision。本人の依頼の版とは別の型）。
  readonly request_revision: string;
}

export interface FinalGuardInput {
  // メール由来の候補は関連解析の版が必須。無い（null）ときは拒否する。
  readonly used: UsedAnalysis | null;
  readonly entity: UsedEntity | null;
  // DB の現在の公開世代。
  readonly current_published_generation: string;
  readonly operation: {
    readonly kind: string;
    readonly accountId: string;
    readonly calendarId: string | null;
  };
  // 同じ集合の解析結果の変更（取消・完了は、判定後・送出前に公開されたものも含む）。
  readonly changes: readonly ResolvedChange[];
}

export type FinalGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

// 実行の直前に、判定に使った版が今も現在の版で、集合が ready で、依頼が有効で版が同じかを確かめる。
// 読めなかった（null）ものは失敗として扱う（推測で通さない）。
export function finalGuard(
  input: FinalGuardInput,
  analyses: AnalysisReader,
  entities: EntityReader,
): FinalGuardResult {
  const reasons: string[] = [];
  if (input.used === null) reasons.push('related_analysis_missing');
  else {
    const current = analyses.current(input.used.group_id);
    if (current === null) reasons.push('analysis_not_found');
    else {
      if (current.published_generation !== input.current_published_generation)
        reasons.push('generation_changed');
      if (current.analysis_revision !== input.used.analysis_revision)
        reasons.push('analysis_revision_changed');
      if (current.source_set_hash !== input.used.source_set_hash)
        reasons.push('source_set_changed');
      if (
        input.used.published_generation !== input.current_published_generation
      )
        reasons.push('used_generation_stale');
      // 計画完了・必要ソースの解析・未解決の変更・世代は analysisReadiness の理由をそのまま使う。
      for (const reason of analysisReadiness(
        current,
        input.current_published_generation,
      ).reasons)
        reasons.push(`analysis_${reason}`);
      // 同じ判定を domain の一括の検査でも確かめる（理由の取りこぼしを通さない）。
      if (
        reasons.length === 0 &&
        !analysisStillCurrent(
          input.used,
          current,
          input.current_published_generation,
        )
      )
        reasons.push('analysis_not_current');
    }
  }
  if (input.entity === null) reasons.push('entity_missing');
  else {
    const current = entities.current(input.entity.request_entity_id);
    if (current === null) reasons.push('entity_not_found');
    else {
      if (current.request_revision !== input.entity.request_revision)
        reasons.push('request_revision_changed');
      reasons.push(
        ...autoCreationReasons(current.record, input.changes, input.operation),
      );
    }
  }
  const unique = reasons.filter(
    (reason, index) => reasons.indexOf(reason) === index,
  );
  return unique.length === 0 ? { ok: true } : { ok: false, reasons: unique };
}
