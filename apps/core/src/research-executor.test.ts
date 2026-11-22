// 公開 Web 調査の受付と実行器（B12-05、ADR 0141）の試験。DB は実際の worker（startCore の保存層）を
// 使い、検索・取得・要約の口は台本で応答する偽物にする。期待値は設計 05・10 §5 と domain の最終状態の
// 表（ADR 0129）、ADR 0141 の判断（再開・孤児・再通知）から手で書いた値で、実装から生成しない。
// 実 API・実アカウントは使わない。URL は保存されないので、ヒットの参照は合成の文字列だけを使う。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { openWriteConnection, storagePlatform } from '@buddy/storage';
import type { DbWorkerClient, ResearchJobRecord } from '@buddy/storage';
import { startEventCore } from './event-test-support.js';
import type { EventCore } from './event-test-support.js';
import { DB_FILE } from './paths.js';
import { createResearchExecutor } from './research-executor.js';
import type {
  ResearchExecutor,
  ResearchExecutorOptions,
  ResearchFetchOutcome,
  ResearchSearchHit,
  ResearchSearchOutcome,
  ResearchSummarizeOutcome,
} from './research-executor.js';

const QUERY = '名古屋 明日の天気';

interface Harness {
  readonly core: EventCore;
  readonly store: DbWorkerClient;
  sql(body: (db: ReturnType<typeof openWriteConnection>) => void): void;
}

async function start(t: test.TestContext): Promise<Harness> {
  const core = await startEventCore(t);
  const sql = (body: (db: ReturnType<typeof openWriteConnection>) => void) => {
    const db = openWriteConnection(join(core.dataDir, DB_FILE), {
      platform: storagePlatform(),
    });
    try {
      body(db);
    } finally {
      db.close();
    }
  };
  sql((db) => {
    db.exec(
      "INSERT INTO sessions VALUES ('s-1', 'normal', NULL, 1, NULL, 1000, NULL)",
    );
  });
  return { core, store: core.handle.store, sql };
}

// 依頼（workflows）と、その依頼を作った発言を用意する（受付→記録の順。ADR 0135）。
function seedWorkflow(h: Harness, workflowId: string): void {
  h.sql((db) => {
    db.exec(
      `INSERT INTO workflows VALUES ('${workflowId}', 's-1', 1, 'executing', 1000)`,
    );
    db.exec(
      `INSERT INTO turns VALUES ('turn-${workflowId}', 's-1', 'user', 'text', NULL, 1000, 9999999999)`,
    );
    db.exec(
      `INSERT INTO input_snapshots (input_id, request_revision, workflow_id, turn_id, origin, state, seal_reason, input_evidence, policy_version, permission_revision, forgetting_generation, audio_epoch)
       VALUES ('in-${workflowId}', 1, '${workflowId}', 'turn-${workflowId}', 'typed', 'sealed', 'submitted_text', 'submitted_text', 1, 0, 0, NULL)`,
    );
  });
}

class FakeSearch {
  outcomes: ResearchSearchOutcome[] = [];
  calls = 0;
  async search(): Promise<ResearchSearchOutcome> {
    this.calls += 1;
    return this.outcomes.shift() ?? { kind: 'zero_hits' };
  }
}

class FakeFetch {
  outcomes: ResearchFetchOutcome[] = [];
  readonly fetchedRefs: string[] = [];
  async fetch(input: {
    readonly hit: ResearchSearchHit;
  }): Promise<ResearchFetchOutcome> {
    this.fetchedRefs.push(input.hit.ref);
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error('fetch の台本が尽きました');
    return outcome;
  }
}

class FakeSummarize {
  outcome: ResearchSummarizeOutcome = { kind: 'failed' };
  readonly inputs: {
    readonly query: string;
    readonly pages: readonly {
      readonly source_id: string;
      readonly text: string;
    }[];
  }[] = [];
  async summarize(input: {
    readonly query: string;
    readonly pages: readonly {
      readonly source_id: string;
      readonly page_title: string | null;
      readonly text: string;
    }[];
  }): Promise<ResearchSummarizeOutcome> {
    this.inputs.push(input);
    return this.outcome;
  }
}

function readOutcome(sourceId: string, text: string): ResearchFetchOutcome {
  return {
    outcome: 'read',
    source_id: sourceId,
    http_status: 200,
    redirects: 0,
    bytes: Buffer.byteLength(text),
    elapsed_ms: 120,
    page_title: '天気のページ',
    text,
    fetched_at: new Date().toISOString(),
  };
}

interface Rig {
  readonly executor: ResearchExecutor;
  readonly search: FakeSearch;
  readonly fetch: FakeFetch;
  readonly summarize: FakeSummarize;
  readonly notified: ResearchJobRecord[];
}

function rig(
  h: Harness,
  over: {
    notify?: (record: ResearchJobRecord) => Promise<void>;
    retention?: ResearchExecutorOptions['retention'];
  } = {},
): Rig {
  const search = new FakeSearch();
  const fetch = new FakeFetch();
  const summarize = new FakeSummarize();
  const notified: ResearchJobRecord[] = [];
  const executor = createResearchExecutor({
    store: h.store,
    search,
    fetch,
    summarize,
    sleep: () => Promise.resolve(),
    notify:
      over.notify ??
      ((record) => {
        notified.push(record);
        return Promise.resolve();
      }),
    ...(over.retention === undefined ? {} : { retention: over.retention }),
  });
  return { executor, search, fetch, summarize, notified };
}

async function get(
  h: Harness,
  workflowId: string,
): Promise<ResearchJobRecord | null> {
  const result = await h.store.research({
    kind: 'research.get',
    workflow_id: workflowId,
  });
  assert.equal(result.ok, true);
  return result.ok ? result.value : null;
}

async function acceptAndRun(
  r: Rig,
  workflowId: string,
  dedupeKey: string,
): Promise<void> {
  const accepted = await r.executor.acceptor.acceptResearch({
    workflow_id: workflowId,
    intent: 'research',
    query: QUERY,
    session_id: 's-1',
    dedupe_key: dedupeKey,
  });
  assert.deepEqual(accepted, { kind: 'accepted', workflow_id: workflowId });
  const outcome = await r.executor.runOnce(workflowId);
  assert.notEqual(outcome.status, 'unavailable', JSON.stringify(outcome));
}

test('完了までの実行: 検索→取得→要約→完了の知らせと、依頼の done', async (t) => {
  const h = await start(t);
  seedWorkflow(h, 'wf-r1');
  const r = rig(h);
  r.search.outcomes = [
    { kind: 'hits', hits: [{ ref: 'hit-1' }, { ref: 'hit-2' }] },
  ];
  const text1 = '名古屋は明日、晴れます。最高気温は18度です。';
  const text2 = '明日の名古屋は晴れのち曇りです。';
  r.fetch.outcomes = [readOutcome('src-1', text1), readOutcome('src-2', text2)];
  r.summarize.outcome = {
    kind: 'ok',
    summary: '名古屋は明日晴れます。',
    source_summaries: [{ source_id: 'src-1', summary: '晴れの根拠' }],
  };
  await acceptAndRun(r, 'wf-r1', 'dk-r1');
  const record = await get(h, 'wf-r1');
  assert.equal(record?.status.state, 'completed');
  assert.equal(record?.status.result?.summary, '名古屋は明日晴れます。');
  assert.equal(record?.status.result?.unread_count, 0);
  assert.equal(record?.status.result?.scope_reduced, false);
  assert.equal(record?.sources.length, 2);
  assert.equal(record?.sources[0]?.excerpt, text1);
  assert.equal(
    record?.sources[0]?.content_hash,
    createHash('sha256').update(text1, 'utf8').digest('hex'),
  );
  assert.equal(record?.sources[0]?.url, null);
  assert.equal(record?.sources[0]?.summary, '晴れの根拠');
  assert.equal(record?.sources[1]?.summary, null);
  assert.equal(record?.attempts.searches.length, 1);
  assert.equal(record?.attempts.pages.length, 2);
  assert.equal(record?.attempts.summary, 'ok');
  // 依頼は done になり、発言の由来が引ける。
  assert.equal(record?.workflow_state, 'done');
  assert.equal(record?.turn_id, 'turn-wf-r1');
  // 知らせは 1 回、通知済みになっている。
  assert.equal(r.notified.length, 1);
  assert.equal(r.notified[0]?.workflow_id, 'wf-r1');
  assert.notEqual(record?.notified_at, null);
  // 要約の口には本文が渡る。
  assert.equal(r.summarize.inputs[0]?.pages[0]?.text, text1);
});

test('受付の検査: 私的情報を含む検索語は受け付けず、何も保存しない', async (t) => {
  const h = await start(t);
  const r = rig(h);
  const rejected = await r.executor.acceptor.acceptResearch({
    workflow_id: 'wf-r2',
    intent: 'research',
    query: 'taro@example.com の予定を調べて',
    session_id: 's-1',
    dedupe_key: 'dk-r2',
  });
  assert.deepEqual(rejected, { kind: 'unavailable' });
  assert.equal(await get(h, 'wf-r2'), null);
  assert.equal(r.search.calls, 0);
});

test('重複の受付: 同じ dedupe_key では最初の workflow_id が返り、調査は 1 件だけ', async (t) => {
  const h = await start(t);
  seedWorkflow(h, 'wf-r3');
  const r = rig(h);
  const first = await r.executor.acceptor.acceptResearch({
    workflow_id: 'wf-r3',
    intent: 'research',
    query: QUERY,
    session_id: 's-1',
    dedupe_key: 'dk-r3',
  });
  const second = await r.executor.acceptor.acceptResearch({
    workflow_id: 'wf-r3-other',
    intent: 'research',
    query: QUERY,
    session_id: 's-1',
    dedupe_key: 'dk-r3',
  });
  assert.deepEqual(first, { kind: 'accepted', workflow_id: 'wf-r3' });
  assert.deepEqual(second, { kind: 'accepted', workflow_id: 'wf-r3' });
  assert.equal(await get(h, 'wf-r3-other'), null);
});

test('0 件: no_results で止まり、知らせはしない', async (t) => {
  const h = await start(t);
  seedWorkflow(h, 'wf-r4');
  const r = rig(h);
  r.search.outcomes = [{ kind: 'zero_hits' }];
  await acceptAndRun(r, 'wf-r4', 'dk-r4');
  const record = await get(h, 'wf-r4');
  assert.equal(record?.status.state, 'no_results');
  assert.deepEqual(record?.status.stop, {
    kind: 'no_results',
    reason: 'zero_hits',
  });
  assert.equal(r.notified.length, 0);
  assert.equal(record?.workflow_state, 'done');
});

test('検索の失敗: failed（search_failed）で止まる', async (t) => {
  const h = await start(t);
  seedWorkflow(h, 'wf-r5');
  const r = rig(h);
  r.search.outcomes = [{ kind: 'failed', failure_cause: 'provider_error' }];
  await acceptAndRun(r, 'wf-r5', 'dk-r5');
  const record = await get(h, 'wf-r5');
  assert.equal(record?.status.state, 'failed');
  assert.deepEqual(record?.status.stop, {
    kind: 'failed',
    reason: 'search_failed',
  });
});

test('予算の拒否: 検索を送らず held（budget_held）で止まる', async (t) => {
  const h = await start(t);
  seedWorkflow(h, 'wf-r6');
  const r = rig(h);
  r.search.outcomes = [{ kind: 'denied', reason: 'budget_denied' }];
  await acceptAndRun(r, 'wf-r6', 'dk-r6');
  const record = await get(h, 'wf-r6');
  assert.equal(record?.status.state, 'held');
  assert.deepEqual(record?.status.stop, {
    kind: 'held',
    reason: 'budget_held',
  });
  assert.deepEqual(record?.attempts.search_denials, ['budget_denied']);
  assert.equal(record?.attempts.searches.length, 0);
  // 保留は終端ではないので、依頼は executing のまま。
  assert.equal(record?.workflow_state, 'executing');
});

test('読めるページが無い: failed（no_readable_page）で止まる', async (t) => {
  const h = await start(t);
  seedWorkflow(h, 'wf-r7');
  const r = rig(h);
  r.search.outcomes = [{ kind: 'hits', hits: [{ ref: 'hit-1' }] }];
  r.fetch.outcomes = [
    {
      outcome: 'http_error',
      source_id: null,
      http_status: 404,
      redirects: 0,
      bytes: 0,
      elapsed_ms: 90,
      page_title: null,
      text: null,
      fetched_at: null,
    },
  ];
  await acceptAndRun(r, 'wf-r7', 'dk-r7');
  const record = await get(h, 'wf-r7');
  assert.equal(record?.status.state, 'failed');
  assert.deepEqual(record?.status.stop, {
    kind: 'failed',
    reason: 'no_readable_page',
  });
  assert.equal(r.summarize.inputs.length, 0);
});

test('要約の失敗と予算の拒否: summary_failed と budget_held に分かれる', async (t) => {
  const h = await start(t);
  seedWorkflow(h, 'wf-r8');
  seedWorkflow(h, 'wf-r9');
  const failedRig = rig(h);
  failedRig.search.outcomes = [{ kind: 'hits', hits: [{ ref: 'hit-1' }] }];
  failedRig.fetch.outcomes = [readOutcome('src-1', '本文です。')];
  failedRig.summarize.outcome = { kind: 'failed' };
  await acceptAndRun(failedRig, 'wf-r8', 'dk-r8');
  const failed = await get(h, 'wf-r8');
  assert.equal(failed?.status.state, 'failed');
  assert.deepEqual(failed?.status.stop, {
    kind: 'failed',
    reason: 'summary_failed',
  });

  const heldRig = rig(h);
  heldRig.search.outcomes = [{ kind: 'hits', hits: [{ ref: 'hit-1' }] }];
  heldRig.fetch.outcomes = [readOutcome('src-1', '本文です。')];
  heldRig.summarize.outcome = { kind: 'budget_denied' };
  await acceptAndRun(heldRig, 'wf-r9', 'dk-r9');
  const held = await get(h, 'wf-r9');
  assert.equal(held?.status.state, 'held');
  assert.deepEqual(held?.status.stop, {
    kind: 'held',
    reason: 'budget_held',
  });
});

test('ゲートが閉じている間は外部へ送らず、調査は accepted のまま残る', async (t) => {
  const h = await start(t);
  seedWorkflow(h, 'wf-r10');
  const r = rig(h, {
    retention: {
      ready: () => Promise.resolve(),
      gate: () => ({ search: false, cloud_send: false, auto_use: false }),
      lease: () => null,
    },
  });
  const accepted = await r.executor.acceptor.acceptResearch({
    workflow_id: 'wf-r10',
    intent: 'research',
    query: QUERY,
    session_id: 's-1',
    dedupe_key: 'dk-r10',
  });
  assert.deepEqual(accepted, { kind: 'accepted', workflow_id: 'wf-r10' });
  const outcome = await r.executor.runOnce('wf-r10');
  assert.deepEqual(outcome, {
    status: 'unavailable',
    reason: 'retention_gate_closed',
  });
  assert.equal(r.search.calls, 0);
  assert.equal((await get(h, 'wf-r10'))?.status.state, 'accepted');
});

test('再開: 保存済みの試行から続きを実行し、ヒットを取り直して完了する', async (t) => {
  const h = await start(t);
  seedWorkflow(h, 'wf-r11');
  // 前回の実行が、検索 1 回・ページ 1 件を読んだところで落ちた状態を保存で作る。
  const accepted = await h.store.research({
    kind: 'research.accept',
    workflow_id: 'wf-r11',
    session_id: 's-1',
    dedupe_key: 'dk-r11',
    request_revision: '1',
    screening: {
      query_id: 'q-r11',
      screened_query: QUERY,
      input_sources: ['user_question'],
      rules_version: 1,
      outcome: 'passed',
      rejected_reasons: [],
      screened_at: new Date().toISOString(),
    },
    now: new Date().toISOString(),
  });
  assert.equal(accepted.ok, true);
  const record0 = await get(h, 'wf-r11');
  const queryId = record0?.query_id as string;
  await h.store.research({
    kind: 'research.advance',
    workflow_id: 'wf-r11',
    expected_state_revision: '1',
    to_state: 'searching',
    stop_reason: null,
    result_summary: null,
    now: new Date().toISOString(),
  });
  const text1 = '1 件目の本文です。';
  await h.store.research({
    kind: 'research.record_progress',
    workflow_id: 'wf-r11',
    attempts: {
      workflow_id: 'wf-r11',
      request_revision: '1',
      searches: [
        {
          search_index: 1,
          query_id: queryId,
          outcome: 'hits',
          hit_count: 2,
          failure_cause: null,
        },
      ],
      search_denials: [],
      pages: [
        {
          page_index: 1,
          query_id: queryId,
          outcome: 'read',
          source_id: 'src-1',
          http_status: 200,
          redirects: 0,
          bytes: 30,
          elapsed_ms: 100,
        },
      ],
      page_limit_denials: 0,
      summary: 'not_attempted',
    },
    sources: [
      {
        source_id: 'src-1',
        query_id: queryId,
        basis: 'page_read',
        fetched_at: new Date().toISOString(),
        page_title: '天気のページ',
        excerpt: text1,
        summary: null,
        content_hash: createHash('sha256').update(text1, 'utf8').digest('hex'),
        url: null,
      },
    ],
    pending_summary: null,
    now: new Date().toISOString(),
  });
  // 再開する実行器。ヒットへの参照は保存されていないので、検索し直す。
  const r = rig(h);
  r.search.outcomes = [
    { kind: 'hits', hits: [{ ref: 'hit-1' }, { ref: 'hit-2' }] },
  ];
  r.fetch.outcomes = [readOutcome('src-2', '2 件目の本文です。')];
  r.summarize.outcome = {
    kind: 'ok',
    summary: '再開して完了しました。',
    source_summaries: [],
  };
  const outcome = await r.executor.runOnce('wf-r11');
  assert.deepEqual(outcome, { status: 'completed', workflow_id: 'wf-r11' });
  const record = await get(h, 'wf-r11');
  assert.equal(record?.status.state, 'completed');
  assert.equal(record?.attempts.searches.length, 2);
  assert.equal(record?.attempts.pages.length, 2);
  assert.equal(record?.sources.length, 2);
  // 要約の口には、本文の残っていない 1 件目は保存済みの抜粋が渡る。
  assert.equal(r.summarize.inputs[0]?.pages[0]?.text, text1);
});

test('孤児: 依頼が記録されなかった受付は、回復で取り消される', async (t) => {
  const h = await start(t);
  const r = rig(h);
  const accepted = await r.executor.acceptor.acceptResearch({
    workflow_id: 'wf-r12',
    intent: 'research',
    query: QUERY,
    session_id: 's-1',
    dedupe_key: 'dk-r12',
  });
  assert.deepEqual(accepted, { kind: 'accepted', workflow_id: 'wf-r12' });
  // 受付の直後の実行は、依頼が無いので進まない。
  await r.executor.drain();
  assert.equal((await get(h, 'wf-r12'))?.status.state, 'accepted');
  assert.equal(r.search.calls, 0);
  const summary = await r.executor.recover();
  assert.equal(summary.orphans_canceled, 1);
  const record = await get(h, 'wf-r12');
  assert.equal(record?.status.state, 'canceled');
  assert.deepEqual(record?.status.stop, {
    kind: 'canceled',
    reason: 'superseded',
  });
});

test('製品配線: startCore に口を渡すと受付→実行→候補（research_done）まで進む', async (t) => {
  const search = new FakeSearch();
  search.outcomes = [{ kind: 'hits', hits: [{ ref: 'hit-1' }] }];
  const fetch = new FakeFetch();
  fetch.outcomes = [readOutcome('src-1', '名古屋は明日晴れます。')];
  const summarize = new FakeSummarize();
  summarize.outcome = {
    kind: 'ok',
    summary: '名古屋は明日晴れます。',
    source_summaries: [],
  };
  const core = await startEventCore(t, {
    research: { search, fetch, summarize },
  });
  const executor = core.handle.researchExecutor;
  assert.notEqual(executor, null);
  if (executor === null) return;
  const store = core.handle.store;
  const sql = (body: (db: ReturnType<typeof openWriteConnection>) => void) => {
    const db = openWriteConnection(join(core.dataDir, DB_FILE), {
      platform: storagePlatform(),
    });
    try {
      body(db);
    } finally {
      db.close();
    }
  };
  const workflowId = '11111111-2222-4333-8444-555555555555';
  sql((db) => {
    db.exec(
      "INSERT INTO sessions VALUES ('s-1', 'normal', NULL, 1, NULL, 1000, NULL)",
    );
    db.exec(
      `INSERT INTO workflows VALUES ('${workflowId}', 's-1', 1, 'executing', 1000)`,
    );
    db.exec(
      `INSERT INTO turns VALUES ('turn-w1', 's-1', 'user', 'text', NULL, 1000, 9999999999)`,
    );
    db.exec(
      `INSERT INTO input_snapshots (input_id, request_revision, workflow_id, turn_id, origin, state, seal_reason, input_evidence, policy_version, permission_revision, forgetting_generation, audio_epoch)
       VALUES ('in-w1', 1, '${workflowId}', 'turn-w1', 'typed', 'sealed', 'submitted_text', 'submitted_text', 1, 0, 0, NULL)`,
    );
  });
  const accepted = await executor.acceptor.acceptResearch({
    workflow_id: workflowId,
    intent: 'research',
    query: QUERY,
    session_id: 's-1',
    dedupe_key: 'dk-w1',
  });
  assert.deepEqual(accepted, { kind: 'accepted', workflow_id: workflowId });
  // 受付の直後の実行（kick）が完了まで進むのを待つ。
  let state = '';
  for (let i = 0; i < 100 && state !== 'completed'; i += 1) {
    const result = await store.research({
      kind: 'research.get',
      workflow_id: workflowId,
    });
    state = result.ok ? (result.value?.status.state ?? '') : '';
    if (state !== 'completed')
      await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(state, 'completed');
  await executor.drain();
  // 候補が 1 件だけ作られ、由来は発言になっている。
  sql((db) => {
    const rows = db
      .prepare(
        "SELECT kind FROM notification_candidates WHERE kind = 'research_done'",
      )
      .all() as { kind: string }[];
    assert.equal(rows.length, 1);
    const origins = db
      .prepare(
        "SELECT source_kind, source_id FROM derivations WHERE artifact_kind = 'notification_candidate'",
      )
      .all() as { source_kind: string; source_id: string }[];
    assert.deepEqual(origins, [{ source_kind: 'turn', source_id: 'turn-w1' }]);
  });
  const record = await store.research({
    kind: 'research.get',
    workflow_id: workflowId,
  });
  assert.equal(record.ok && record.value?.notified_at !== null, true);
});

test('製品配線: 口を渡さなければ researchExecutor は null で、受付は付かない', async (t) => {
  const core = await startEventCore(t);
  assert.equal(core.handle.researchExecutor, null);
});

test('再通知: 知らせに失敗した完了は、回復でもう一度知らせて通知済みになる', async (t) => {
  const h = await start(t);
  seedWorkflow(h, 'wf-r13');
  let notifyCalls = 0;
  const r = rig(h, {
    notify: () => {
      notifyCalls += 1;
      return notifyCalls === 1
        ? Promise.reject(new Error('synthetic'))
        : Promise.resolve();
    },
  });
  r.search.outcomes = [{ kind: 'hits', hits: [{ ref: 'hit-1' }] }];
  r.fetch.outcomes = [readOutcome('src-1', '本文です。')];
  r.summarize.outcome = {
    kind: 'ok',
    summary: '完了しました。',
    source_summaries: [],
  };
  await acceptAndRun(r, 'wf-r13', 'dk-r13');
  const done = await get(h, 'wf-r13');
  assert.equal(done?.status.state, 'completed');
  assert.equal(done?.notified_at, null);
  assert.equal(notifyCalls, 1);
  const summary = await r.executor.recover();
  assert.equal(summary.unnotified, 1);
  assert.equal(notifyCalls, 2);
  assert.notEqual((await get(h, 'wf-r13'))?.notified_at, null);
});
