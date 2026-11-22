// 公開 Web 調査の受付と実行器（設計 05・10 §5、B12-05、ADR 0077・0125〜0129・0135・0141）。
//
// B10-04 の受け口（BackgroundJobAcceptor、ADR 0135）を製品で生かす側。受け付けた調査を、
// 検索 → ページ取得 → 要約 → 完了の気づき、まで実際に進める。状態・遷移・試行・出典の規則の正本は
// domain（web-research-status / web-research-limits / web-query-screening）で、保存は storage の
// research 操作が担う。ここは手順と失敗の扱いだけを持つ。
// - 検索・取得・要約の実アダプターは B12-03（検索）・B12-04（取得）で、ここは差し込み口（port）だけを
//   持つ。口が渡されなければ実行器そのものを作らない（受け付けだけが先に進むことはない。ADR 0135）。
//   予算の予約は B12-03 の担当（ADR 0128）で、ここは口が返した拒否（budget_denied・query_rejected）を
//   試行の記録に残して domain の最終状態（保留）に委ねる。
// - 検索は受付時に検査を通った検索語で 1 回だけ送る（ADR 0141）。上限（検索 3 回・ページ 5 件）は
//   domain の天井で、再開のときの再検索のために残す。複数クエリへの組み替えは設計 05 の残件。
// - URL・検索結果・取得本文は保存しない（本人の決定 A、ADR 0126）。ヒットへの参照と本文は実行中の
//   メモリーだけに置き、保存するのは試行の件数・種類と、出典の抜粋（先頭 500 字）・要約・hash だけ。
//   再開した実行では、ヒットを取り直すために再検索することがある（試行の上限の中で数える）。
// - 実行は外部への送出なので、保存期限の掃除のゲートを通す（ADR 0053）。ゲートの確認は受付の入口
//   （api-turns の planResearch）と同じく search・cloud_send・auto_use の 3 つで、貸し出しは実行の
//   終わりまで持つ。
// - 受付は発言の記録より先に保存される（ADR 0135）。対応する依頼（workflows）がまだ無い間は少しだけ
//   待って確かめ直し、それでも無ければ実行しない（起動時の回復が孤児として取り消す。ADR 0141）。
// - 完了の知らせは差し込み口（notify）へ渡す。知らせに失敗したら通知済みにせず、起動時の回復で
//   もう一度知らせる（候補の作成は notification_key で冪等。ADR 0125・0141）。

import { createHash } from 'node:crypto';
import {
  WEB_QUERY_SCREENING_VERSION,
  WEB_RESEARCH_MAX_PAGES,
  WEB_SEARCH_MAX_SEARCHES,
  webQueryRejectReasons,
  webResearchFinalState,
  webSearchAdmissionErrors,
} from '@buddy/domain';
import type { WebResearchAttemptsLike, WebResearchState } from '@buddy/domain';
import type {
  DbWorkerClient,
  ResearchJobRecord,
  ResearchSourceRecord,
} from '@buddy/storage';
import type {
  BackgroundJobAcceptResult,
  BackgroundJobAcceptance,
  BackgroundJobAcceptor,
} from './turn-ports.js';

// --- 検索・取得・要約の差し込み口（実アダプターは B12-03・B12-04） ---

// 検索のヒット 1 件。ref は口の中だけの参照（実アダプターでは URL を含みうる）で、保存しない。
export interface ResearchSearchHit {
  readonly ref: string;
}

export type ResearchSearchOutcome =
  | { readonly kind: 'hits'; readonly hits: readonly ResearchSearchHit[] }
  | { readonly kind: 'zero_hits' }
  // 検索そのものの失敗（failure_cause はコードだけ。本文・URL は入れない）。
  | { readonly kind: 'failed'; readonly failure_cause: string }
  // 送る前に断られた（予算・検索語の拒否）。試行には数えず、断りの記録に残す（ADR 0128・0129）。
  | {
      readonly kind: 'denied';
      readonly reason: 'budget_denied' | 'query_rejected';
    };

export interface ResearchSearchPort {
  search(input: {
    readonly query_id: string;
    readonly query: string;
  }): Promise<ResearchSearchOutcome>;
}

// 取得 1 件の結果。試行の欄（outcome・http_status・redirects・bytes・elapsed_ms）は domain の
// ページ試行の形そのままで、整合（read は 2xx・timeout は上限の時間など）は domain が検査する。
export interface ResearchFetchOutcome {
  readonly outcome: string;
  readonly source_id: string | null;
  readonly http_status: number | null;
  readonly redirects: number;
  readonly bytes: number;
  readonly elapsed_ms: number;
  // read のときだけ。本文は保存せず、抜粋と hash の材料にだけ使う。
  readonly page_title: string | null;
  readonly text: string | null;
  readonly fetched_at: string | null;
}

export interface ResearchFetchPort {
  fetch(input: {
    readonly query_id: string;
    readonly hit: ResearchSearchHit;
  }): Promise<ResearchFetchOutcome>;
}

export type ResearchSummarizeOutcome =
  | {
      readonly kind: 'ok';
      readonly summary: string;
      // 出典ごとの要約（source_id → 要約）。無い出典は既存の要約のままにする。
      readonly source_summaries: readonly {
        readonly source_id: string;
        readonly summary: string;
      }[];
    }
  | { readonly kind: 'budget_denied' }
  | { readonly kind: 'failed' };

export interface ResearchSummarizePort {
  summarize(input: {
    readonly query: string;
    readonly pages: readonly {
      readonly source_id: string;
      readonly page_title: string | null;
      // 本文（この実行で読んだページ）。再開で本文が残っていない出典は保存済みの抜粋を渡す。
      readonly text: string;
    }[];
  }): Promise<ResearchSummarizeOutcome>;
}

export interface ResearchExecutorOptions {
  readonly store: Pick<DbWorkerClient, 'research'>;
  readonly search: ResearchSearchPort;
  readonly fetch: ResearchFetchPort;
  readonly summarize: ResearchSummarizePort;
  // 完了の知らせ（製品では候補 research_done の作成。core.ts がつなぐ）。省略時は通知済みとして扱う。
  readonly notify?: (record: ResearchJobRecord) => Promise<void>;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
  // 依頼の記録を待つ間隔（試験で差し替える）。省略時は短い間隔で数回だけ確かめ直す。
  readonly sleep?: (ms: number) => Promise<void>;
  // 保存期限の掃除のゲート（ADR 0053）。省略時は通さない（試験・模擬用）。
  readonly retention?: {
    readonly ready: () => Promise<void>;
    readonly gate: () => {
      readonly search: boolean;
      readonly cloud_send: boolean;
      readonly auto_use: boolean;
    };
    readonly lease: () => (() => void) | null;
  };
}

export type ResearchRunOutcome =
  | {
      readonly status:
        'completed' | 'no_results' | 'held' | 'failed' | 'canceled';
      readonly workflow_id: string;
    }
  | {
      readonly status: 'in_progress';
      readonly workflow_id: string;
      readonly state: WebResearchState;
    }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface ResearchRecoverSummary {
  readonly runnable: number;
  readonly unnotified: number;
  readonly expired: number;
  readonly orphans_canceled: number;
}

export interface ResearchExecutor {
  // B10-04 の受け口（api-turns の planResearch が呼ぶ）。
  readonly acceptor: BackgroundJobAcceptor;
  // 1 件の調査を進める（すでに進んでいれば、その実行の結果を返す）。
  runOnce(workflowId: string): Promise<ResearchRunOutcome>;
  // 起動時の回復: 期限切れの削除・孤児の取消（保存層）→ 実行できる調査の再開と、完了の再通知。
  recover(): Promise<ResearchRecoverSummary>;
  // 実行中の調査が終わるのを待つ（停止処理用）。
  drain(): Promise<void>;
}

const ID_FORM = /^[\x21-\x7e]{1,128}$/u;
// 依頼の記録（受付の直後の別 transaction）を待つ回数と間隔。
const WORKFLOW_WAIT_ATTEMPTS = 5;
const WORKFLOW_WAIT_MS = 100;

// 決まった値から UUID の形の ID を作る（検索の query_id。dedupe_key から決めるので再送でも同じ）。
function derivedId(...parts: readonly string[]): string {
  const bytes = createHash('sha256')
    .update(parts.join('\0'), 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

// 抜粋は本文の先頭 500 字（コードポイント単位。ADR 0126 の上限）。
function excerptOf(text: string): string {
  return [...text].slice(0, 500).join('');
}

export function createResearchExecutor(
  options: ResearchExecutorOptions,
): ResearchExecutor {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
      }));
  const running = new Map<string, Promise<ResearchRunOutcome>>();

  const getRecord = async (
    workflowId: string,
  ): Promise<ResearchJobRecord | null> => {
    const result = await options.store.research({
      kind: 'research.get',
      workflow_id: workflowId,
    });
    return result.ok ? result.value : null;
  };

  // 完了の知らせ。失敗したら通知済みにしない（回復でもう一度知らせる）。
  const notifyCompleted = async (record: ResearchJobRecord): Promise<void> => {
    if (record.status.state !== 'completed' || record.notified_at !== null)
      return;
    if (options.notify !== undefined) {
      try {
        await options.notify(record);
      } catch {
        log(`調査の完了を知らせられませんでした（${record.workflow_id}）。`);
        return;
      }
    }
    await options.store.research({
      kind: 'research.mark_notified',
      workflow_id: record.workflow_id,
      now: now().toISOString(),
    });
  };

  const runTracked = (workflowId: string): Promise<ResearchRunOutcome> => {
    const existing = running.get(workflowId);
    if (existing !== undefined) return existing;
    const promise = runGated(workflowId).catch((): ResearchRunOutcome => ({
      status: 'unavailable',
      reason: 'executor_failed',
    }));
    running.set(workflowId, promise);
    void promise.finally(() => {
      if (running.get(workflowId) === promise) running.delete(workflowId);
    });
    return promise;
  };

  const kick = (workflowId: string): void => {
    void runTracked(workflowId);
  };

  async function runGated(workflowId: string): Promise<ResearchRunOutcome> {
    // 掃除が済むまで外部へ送らない（ADR 0053）。確認と貸し出しの取得は同じ区間で行い、実行の
    // 終わりまで貸し出しを持つ。anchors: options.retention.ready() / options.retention.lease()
    let release: (() => void) | null = null;
    if (options.retention !== undefined) {
      for (let attempt = 0; release === null && attempt < 3; attempt += 1) {
        await options.retention.ready();
        const gate = options.retention.gate();
        if (!gate.search || !gate.cloud_send || !gate.auto_use)
          return { status: 'unavailable', reason: 'retention_gate_closed' };
        release = options.retention.lease();
      }
      if (release === null)
        return { status: 'unavailable', reason: 'retention_gate_closed' };
    }
    try {
      return await runInner(workflowId);
    } finally {
      release?.();
    }
  }

  async function runInner(workflowId: string): Promise<ResearchRunOutcome> {
    let record = await getRecord(workflowId);
    if (record === null)
      return { status: 'unavailable', reason: 'job_missing' };
    // 受付だけが保存され、依頼の記録がまだ無い間は少しだけ待つ（ADR 0135・0141）。
    for (
      let attempt = 0;
      record.workflow_state === null && attempt < WORKFLOW_WAIT_ATTEMPTS;
      attempt += 1
    ) {
      await sleep(WORKFLOW_WAIT_MS);
      const refreshed = await getRecord(workflowId);
      if (refreshed === null)
        return { status: 'unavailable', reason: 'job_missing' };
      record = refreshed;
    }
    if (record.workflow_state !== 'executing') {
      if (
        record.status.state === 'completed' ||
        record.status.state === 'no_results' ||
        record.status.state === 'failed' ||
        record.status.state === 'canceled'
      ) {
        if (record.status.state === 'completed') await notifyCompleted(record);
        return { status: record.status.state, workflow_id: workflowId };
      }
      // 依頼が記録されなかった受付は、起動時の回復が孤児として取り消す。ここでは実行しない。
      return { status: 'unavailable', reason: 'workflow_not_recorded' };
    }
    if (
      record.status.state === 'completed' ||
      record.status.state === 'no_results' ||
      record.status.state === 'failed' ||
      record.status.state === 'canceled'
    ) {
      if (record.status.state === 'completed') await notifyCompleted(record);
      return { status: record.status.state, workflow_id: workflowId };
    }
    if (record.status.state === 'held')
      // 保留の再開のきっかけ（予算の回復・本人の再依頼）はまだ無いので、自動では再開しない。
      return { status: 'in_progress', workflow_id: workflowId, state: 'held' };

    let job: ResearchJobRecord = record;
    let attempts: WebResearchAttemptsLike = record.attempts;
    let sources: ResearchSourceRecord[] = [...record.sources];
    // この実行で得たヒットと本文（保存しない。再開の実行では持ち直す）。
    const heldHits: { current: readonly ResearchSearchHit[] | null } = {
      current: null,
    };
    const texts = new Map<string, string>();

    const persist = async (pendingSummary: string | null): Promise<boolean> => {
      const result = await options.store.research({
        kind: 'research.record_progress',
        workflow_id: workflowId,
        attempts,
        sources,
        pending_summary: pendingSummary,
        now: now().toISOString(),
      });
      if (!result.ok) {
        log(
          `調査の進捗を保存できませんでした（${workflowId}: ${result.reasons.join(',')}）。`,
        );
        return false;
      }
      return true;
    };

    const advance = async (
      toState: WebResearchState,
      stopReason: string | null,
      resultSummary: string | null,
    ): Promise<ResearchJobRecord | null> => {
      const current = await getRecord(workflowId);
      if (current === null) return null;
      const result = await options.store.research({
        kind: 'research.advance',
        workflow_id: workflowId,
        expected_state_revision: current.status.state_revision,
        to_state: toState,
        stop_reason: stopReason,
        result_summary: resultSummary,
        now: now().toISOString(),
      });
      return result.ok ? result.value : null;
    };

    // 試行の記録から最終状態が決まれば、そこへ進めて終える。決まらなければ null。
    const finalize = async (
      pendingSummary: string | null,
    ): Promise<ResearchRunOutcome | null> => {
      const final = webResearchFinalState(attempts);
      if (final === null) return null;
      const moved = await advance(
        final.state,
        final.stop?.reason ?? null,
        final.state === 'completed' ? pendingSummary : null,
      );
      if (moved === null)
        return { status: 'unavailable', reason: 'advance_rejected' };
      if (final.state === 'completed') await notifyCompleted(moved);
      return { status: final.state, workflow_id: workflowId };
    };

    const doSearch = async (): Promise<'ok' | 'finished' | 'aborted'> => {
      // 送る前に、受付の検査の記録と検索語そのものを確かめ直す（ADR 0127）。
      const admission = webSearchAdmissionErrors(
        { query_id: job.query_id, query: job.query },
        {
          query_id: job.screening.query_id,
          screened_query: job.screening.screened_query,
          input_sources: job.screening.input_sources,
          rules_version: job.screening.rules_version,
          outcome: job.screening.outcome,
          rejected_reasons: job.screening.rejected_reasons,
        },
      );
      if (admission.length > 0) {
        if (!attempts.search_denials.includes('query_rejected')) {
          attempts = {
            ...attempts,
            search_denials: [...attempts.search_denials, 'query_rejected'],
          };
          if (!(await persist(null))) return 'aborted';
        }
        return (await finalize(null)) === null ? 'aborted' : 'finished';
      }
      const outcome = await options.search.search({
        query_id: job.query_id,
        query: job.query,
      });
      if (outcome.kind === 'denied') {
        if (!attempts.search_denials.includes(outcome.reason)) {
          attempts = {
            ...attempts,
            search_denials: [...attempts.search_denials, outcome.reason],
          };
          if (!(await persist(null))) return 'aborted';
        }
        return (await finalize(null)) === null ? 'aborted' : 'finished';
      }
      if (outcome.kind === 'failed') {
        attempts = {
          ...attempts,
          searches: [
            ...attempts.searches,
            {
              search_index: attempts.searches.length + 1,
              query_id: job.query_id,
              outcome: 'failed',
              hit_count: 0,
              failure_cause: outcome.failure_cause,
            },
          ],
        };
        if (!(await persist(null))) return 'aborted';
        // 前の検索でヒットがある再開では、最終状態はまだ決まらない（ページが残っている）。
        return (await finalize(null)) === null ? 'ok' : 'finished';
      }
      if (outcome.kind === 'zero_hits') {
        attempts = {
          ...attempts,
          searches: [
            ...attempts.searches,
            {
              search_index: attempts.searches.length + 1,
              query_id: job.query_id,
              outcome: 'zero_hits',
              hit_count: 0,
              failure_cause: null,
            },
          ],
        };
        if (!(await persist(null))) return 'aborted';
        return (await finalize(null)) === null ? 'ok' : 'finished';
      }
      heldHits.current = outcome.hits;
      attempts = {
        ...attempts,
        searches: [
          ...attempts.searches,
          {
            search_index: attempts.searches.length + 1,
            query_id: job.query_id,
            outcome: 'hits',
            hit_count: outcome.hits.length,
            failure_cause: null,
          },
        ],
      };
      if (!(await persist(null))) return 'aborted';
      return 'ok';
    };

    // 状態の順に進める。accepted → searching → reading → summarizing → 終端。
    // reading へ進めた直後に落ちた再開（ページ 0 件・ヒットなし）は、searching へ戻って検索し直す
    // （reading → searching は domain の遷移表にある）。
    for (let step = 0; step < 10; step += 1) {
      const state = job.status.state;
      if (state === 'accepted') {
        const moved = await advance('searching', null, null);
        if (moved === null)
          return { status: 'unavailable', reason: 'advance_rejected' };
        job = moved;
        continue;
      }
      if (state === 'searching') {
        for (;;) {
          const hitTotal = attempts.searches
            .filter((search) => search.outcome === 'hits')
            .reduce((sum, search) => sum + search.hit_count, 0);
          const fetchTarget = Math.min(hitTotal, WEB_RESEARCH_MAX_PAGES);
          if (hitTotal === 0 && attempts.searches.length > 0) {
            // 0 件・失敗・拒否だけが残った記録は、最終状態で終える。
            const finished = await finalize(null);
            if (finished !== null) return finished;
            return {
              status: 'in_progress',
              workflow_id: workflowId,
              state: 'searching',
            };
          }
          if (hitTotal > 0 && attempts.pages.length >= fetchTarget) break;
          if (heldHits.current !== null) break;
          if (attempts.searches.length >= WEB_SEARCH_MAX_SEARCHES)
            // ヒットへの参照が残っておらず、検索の枠も使い切った。ページへ進めないので止める
            // （最終状態は決まらない。ADR 0141 の残件）。
            return {
              status: 'in_progress',
              workflow_id: workflowId,
              state: 'searching',
            };
          const searched = await doSearch();
          if (searched === 'aborted')
            return { status: 'unavailable', reason: 'progress_rejected' };
          if (searched === 'finished')
            return (
              (await currentOutcome(workflowId)) ?? {
                status: 'unavailable',
                reason: 'advance_rejected',
              }
            );
        }
        const moved = await advance('reading', null, null);
        if (moved === null)
          return { status: 'unavailable', reason: 'advance_rejected' };
        job = moved;
        continue;
      }
      if (state === 'reading') {
        if (attempts.pages.length === 0 && heldHits.current === null) {
          const moved = await advance('searching', null, null);
          if (moved === null)
            return { status: 'unavailable', reason: 'advance_rejected' };
          job = moved;
          continue;
        }
        const hitTotal = attempts.searches
          .filter((search) => search.outcome === 'hits')
          .reduce((sum, search) => sum + search.hit_count, 0);
        const fetchTarget = Math.min(hitTotal, WEB_RESEARCH_MAX_PAGES);
        while (attempts.pages.length < fetchTarget) {
          if (
            heldHits.current === null ||
            attempts.pages.length >= heldHits.current.length
          ) {
            // この実行のヒットが尽きた（再開で取り直した検索の件数が前の記録より少ない等）。
            // 読めた分で判断する。
            break;
          }
          const hit = heldHits.current[
            attempts.pages.length
          ] as ResearchSearchHit;
          const fetched = await options.fetch.fetch({
            query_id: job.query_id,
            hit,
          });
          const page = {
            page_index: attempts.pages.length + 1,
            query_id: job.query_id,
            outcome: fetched.outcome,
            source_id: fetched.source_id,
            http_status: fetched.http_status,
            redirects: fetched.redirects,
            bytes: fetched.bytes,
            elapsed_ms: fetched.elapsed_ms,
          };
          attempts = { ...attempts, pages: [...attempts.pages, page] };
          if (
            fetched.outcome === 'read' &&
            fetched.source_id !== null &&
            fetched.text !== null &&
            fetched.fetched_at !== null
          ) {
            texts.set(fetched.source_id, fetched.text);
            sources = [
              ...sources.filter(
                (source) => source.source_id !== fetched.source_id,
              ),
              {
                source_id: fetched.source_id,
                query_id: job.query_id,
                basis: 'page_read',
                fetched_at: fetched.fetched_at,
                page_title: fetched.page_title,
                excerpt: excerptOf(fetched.text),
                summary: null,
                content_hash: sha256Hex(fetched.text),
                url: null,
              },
            ];
          }
          if (!(await persist(null)))
            return { status: 'unavailable', reason: 'progress_rejected' };
        }
        const reads = attempts.pages.filter(
          (page) => page.outcome === 'read',
        ).length;
        if (reads === 0) {
          const finished = await finalize(null);
          if (finished !== null) return finished;
          return {
            status: 'in_progress',
            workflow_id: workflowId,
            state: 'reading',
          };
        }
        const moved = await advance('summarizing', null, null);
        if (moved === null)
          return { status: 'unavailable', reason: 'advance_rejected' };
        job = moved;
        continue;
      }
      if (state === 'summarizing') {
        if (attempts.summary === 'not_attempted') {
          const outcome = await options.summarize.summarize({
            query: job.query,
            pages: sources.map((source) => ({
              source_id: source.source_id,
              page_title: source.page_title,
              text: texts.get(source.source_id) ?? source.excerpt ?? '',
            })),
          });
          if (outcome.kind === 'ok') {
            attempts = { ...attempts, summary: 'ok' };
            const byId = new Map(
              outcome.source_summaries.map((entry) => [
                entry.source_id,
                entry.summary,
              ]),
            );
            sources = sources.map((source) => {
              const summary = byId.get(source.source_id);
              return summary === undefined ? source : { ...source, summary };
            });
            if (!(await persist(outcome.summary)))
              return { status: 'unavailable', reason: 'progress_rejected' };
            const finished = await finalize(outcome.summary);
            if (finished !== null) return finished;
          } else {
            attempts = {
              ...attempts,
              summary:
                outcome.kind === 'budget_denied' ? 'budget_denied' : 'failed',
            };
            if (!(await persist(null)))
              return { status: 'unavailable', reason: 'progress_rejected' };
            const finished = await finalize(null);
            if (finished !== null) return finished;
          }
          return {
            status: 'in_progress',
            workflow_id: workflowId,
            state: 'summarizing',
          };
        }
        // 要約の結果は保存済み（前回の実行が遷移の前に落ちた）。最終状態へ進める。
        const finished = await finalize(job.pending_summary);
        if (finished !== null) return finished;
        return {
          status: 'in_progress',
          workflow_id: workflowId,
          state: 'summarizing',
        };
      }
      break;
    }

    const current = await getRecord(workflowId);
    if (current === null)
      return { status: 'unavailable', reason: 'job_missing' };
    return {
      status: 'in_progress',
      workflow_id: workflowId,
      state: current.status.state as WebResearchState,
    };
  }

  async function currentOutcome(
    workflowId: string,
  ): Promise<ResearchRunOutcome | null> {
    const current = await getRecord(workflowId);
    if (current === null) return null;
    const state = current.status.state;
    if (
      state === 'completed' ||
      state === 'no_results' ||
      state === 'held' ||
      state === 'failed' ||
      state === 'canceled'
    )
      return { status: state, workflow_id: workflowId };
    return {
      status: 'in_progress',
      workflow_id: workflowId,
      state: state as WebResearchState,
    };
  }

  const acceptor: BackgroundJobAcceptor = {
    async acceptResearch(
      job: BackgroundJobAcceptance,
    ): Promise<BackgroundJobAcceptResult> {
      if (
        job.intent !== 'research' ||
        !ID_FORM.test(job.workflow_id) ||
        !ID_FORM.test(job.session_id) ||
        !ID_FORM.test(job.dedupe_key) ||
        typeof job.query !== 'string'
      )
        return { kind: 'unavailable' };
      // 検査を通らない検索語は受け付けない（拒否した検索語は保存しない。ADR 0127）。
      if (webQueryRejectReasons(job.query).length > 0)
        return { kind: 'unavailable' };
      const acceptedAt = now().toISOString();
      const result = await options.store.research({
        kind: 'research.accept',
        workflow_id: job.workflow_id,
        session_id: job.session_id,
        dedupe_key: job.dedupe_key,
        request_revision: '1',
        screening: {
          query_id: derivedId('research-query', job.dedupe_key),
          screened_query: job.query,
          input_sources: ['user_question'],
          rules_version: WEB_QUERY_SCREENING_VERSION,
          outcome: 'passed',
          rejected_reasons: [],
          screened_at: acceptedAt,
        },
        now: acceptedAt,
      });
      if (!result.ok) return { kind: 'unavailable' };
      // 重複の再送でも、止まっている実行があれば進め直すきっかけにする。
      kick(result.value.workflow_id);
      return { kind: 'accepted', workflow_id: result.value.workflow_id };
    },
  };

  return {
    acceptor,
    runOnce: runTracked,
    async recover(): Promise<ResearchRecoverSummary> {
      const result = await options.store.research({
        kind: 'research.recover',
        now: now().toISOString(),
      });
      if (!result.ok)
        return { runnable: 0, unnotified: 0, expired: 0, orphans_canceled: 0 };
      let kicked = 0;
      for (const entry of result.value.runnable) {
        if (entry.workflow_state === 'executing') {
          kick(entry.workflow_id);
          kicked += 1;
        }
      }
      for (const workflowId of result.value.unnotified) {
        const record = await getRecord(workflowId);
        if (record !== null) await notifyCompleted(record);
      }
      return {
        runnable: kicked,
        unnotified: result.value.unnotified.length,
        expired: result.value.expired,
        orphans_canceled: result.value.orphans_canceled,
      };
    },
    async drain(): Promise<void> {
      await Promise.allSettled([...running.values()]);
    },
  };
}
