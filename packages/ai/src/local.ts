// ローカルの P0 の prefix cache の有無と遅延の記録（B10-02 P2/P3、QA40）。設計 05 ローカル profile の採用条件、
// 設計 09 QA40、ADR 0081。
// 実機の測定は B15 まで行わない。ここは、記録の形と「cache なしは採用条件未達」の判定だけを純粋な関数にする。
// 遅延の差そのものは cached と uncached の要約に残し、採否の最終判断は B10-07 の評価で本人が行う。
export interface LocalLatencyRecord {
  readonly profile_id: string;
  readonly prefix_cache: boolean;
  readonly p50_ms: number;
  readonly p95_ms: number;
}

export interface LocalLatencySummary {
  readonly prefix_cache: boolean;
  readonly p50_ms: number;
  readonly p95_ms: number;
}

export type LocalAdoption =
  | {
      readonly decision: 'adopt';
      readonly cached: LocalLatencySummary;
      readonly uncached: LocalLatencySummary;
    }
  | { readonly decision: 'not_adopted'; readonly reasons: readonly string[] };

const valid = (record: LocalLatencyRecord): boolean =>
  Number.isFinite(record.p50_ms) &&
  Number.isFinite(record.p95_ms) &&
  record.p50_ms >= 0 &&
  record.p95_ms >= 0 &&
  record.p50_ms <= record.p95_ms;

// 同じ profile の記録から、最も遅い値（安全側）を要約する。
const summarize = (
  records: readonly LocalLatencyRecord[],
  prefixCache: boolean,
): LocalLatencySummary => ({
  prefix_cache: prefixCache,
  p50_ms: Math.max(...records.map((record) => record.p50_ms)),
  p95_ms: Math.max(...records.map((record) => record.p95_ms)),
});

export function localAdoption(
  profileId: string,
  records: readonly LocalLatencyRecord[],
): LocalAdoption {
  const relevant = records.filter((record) => record.profile_id === profileId);
  if (relevant.length === 0)
    return { decision: 'not_adopted', reasons: ['no_measurement'] };
  if (relevant.some((record) => !valid(record)))
    return { decision: 'not_adopted', reasons: ['invalid_measurement'] };
  const cached = relevant.filter((record) => record.prefix_cache);
  const uncached = relevant.filter((record) => !record.prefix_cache);
  // cache なしは採用条件未達（QA40）。
  if (cached.length === 0)
    return { decision: 'not_adopted', reasons: ['prefix_cache_missing'] };
  // 比較の基準（cache なし）がないと差を記録できない。
  if (uncached.length === 0)
    return { decision: 'not_adopted', reasons: ['cache_baseline_missing'] };
  return {
    decision: 'adopt',
    cached: summarize(cached, true),
    uncached: summarize(uncached, false),
  };
}
