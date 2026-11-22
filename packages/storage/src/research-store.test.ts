// 公開 Web 調査の受付・保存（B12-05、設計 05・10 §5、ADR 0125〜0129・0135・0141）。
// DB は一時ディレクトリに作って消す。期待値は domain の規則（状態機械・試行・出典・検査）と
// ADR 0141 の保存の判断（dedupe の冪等・孤児の取消・保持 7 日）から手で書いた値。
// 検索語・出典は合成で、実データ・実 URL は使わない（URL は保存しない）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { executeResearchOp } from './index.js';
import type {
  ResearchAcceptValue,
  ResearchJobRecord,
  ResearchOp,
  ResearchOpResult,
  ResearchRecoverValue,
  ResearchScreeningRecord,
} from './index.js';
import type { WebResearchAttemptsLike } from '@buddy/domain';
import type { SqliteDatabase } from './connection.js';
import {
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T01:00:00.000Z';
const T2 = '2026-01-01T02:00:00.000Z';
const T3 = '2026-01-01T03:00:00.000Z';
// 完了から 7 日（workflow_result の保持）を過ぎた時刻。
const T_EXPIRED = '2026-01-09T02:00:00.000Z';
const HASH_A = 'a'.repeat(64);

const SCREENING: ResearchScreeningRecord = {
  query_id: 'q-1',
  screened_query: '名古屋 明日の天気',
  input_sources: ['user_question'],
  rules_version: 1,
  outcome: 'passed',
  rejected_reasons: [],
  screened_at: T0,
};

function acceptOp(
  over: Partial<Extract<ResearchOp, { kind: 'research.accept' }>> = {},
): ResearchOp {
  return {
    kind: 'research.accept',
    workflow_id: 'wf-1',
    session_id: 's-1',
    dedupe_key: 'dk-1',
    request_revision: '1',
    screening: SCREENING,
    now: T0,
    ...over,
  };
}

function run(db: SqliteDatabase, op: ResearchOp): ResearchOpResult {
  return executeResearchOp(db, op, { platform: 'macos', halted: false }).result;
}

function value<T>(result: ResearchOpResult): T {
  assert.equal(result.ok, true, result.ok ? '' : result.reasons.join(','));
  if (!result.ok) throw new Error('unreachable');
  return result.value as T;
}

function reasons(result: ResearchOpResult): readonly string[] {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.outcome, 'rejected');
  return result.reasons;
}

function get(
  db: SqliteDatabase,
  workflowId = 'wf-1',
): ResearchJobRecord | null {
  return value<ResearchJobRecord | null>(
    run(db, { kind: 'research.get', workflow_id: workflowId }),
  );
}

function seedWorkflow(db: SqliteDatabase, workflowId = 'wf-1'): void {
  // sessions は種データに無いので、依頼の前に置く（重複は無視）。
  db.prepare(
    "INSERT OR IGNORE INTO sessions VALUES ('s-1', 'normal', 'dev-1', 1, NULL, 1000, NULL)",
  ).run();
  db.prepare(
    'INSERT INTO workflows (workflow_id, session_id, current_request_revision, state, updated_at) VALUES (?, ?, 1, ?, 1000)',
  ).run(workflowId, 's-1', 'executing');
}

// 検索 1 回（2 件）・読めたページ 1 件・要約 ok まで進んだ試行。
function finishedAttempts(
  over: Partial<WebResearchAttemptsLike> = {},
): WebResearchAttemptsLike {
  return {
    workflow_id: 'wf-1',
    request_revision: '1',
    searches: [
      {
        search_index: 1,
        query_id: 'q-1',
        outcome: 'hits',
        hit_count: 2,
        failure_cause: null,
      },
    ],
    search_denials: [],
    pages: [
      {
        page_index: 1,
        query_id: 'q-1',
        outcome: 'read',
        source_id: 'src-1',
        http_status: 200,
        redirects: 0,
        bytes: 1200,
        elapsed_ms: 300,
      },
    ],
    page_limit_denials: 0,
    summary: 'ok',
    ...over,
  };
}

test('accept: 検査を通過した調査を受け付け、空の試行で読み戻せる', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      assert.deepEqual(value<ResearchAcceptValue>(run(db, acceptOp())), {
        outcome: 'accepted',
        workflow_id: 'wf-1',
      });
      const record = get(db);
      assert.equal(record?.workflow_id, 'wf-1');
      assert.equal(record?.session_id, 's-1');
      assert.equal(record?.dedupe_key, 'dk-1');
      assert.equal(record?.query_id, 'q-1');
      assert.equal(record?.query, '名古屋 明日の天気');
      assert.equal(record?.status.state, 'accepted');
      assert.equal(record?.status.state_revision, '1');
      assert.equal(record?.status.request_revision, '1');
      assert.equal(record?.status.accepted_at, T0);
      assert.equal(record?.status.finished_at, null);
      assert.equal(record?.status.result, null);
      assert.equal(record?.status.stop, null);
      assert.deepEqual(record?.screening, SCREENING);
      assert.deepEqual(record?.attempts, {
        workflow_id: 'wf-1',
        request_revision: '1',
        searches: [],
        search_denials: [],
        pages: [],
        page_limit_denials: 0,
        summary: 'not_attempted',
      });
      assert.deepEqual(record?.sources, []);
      assert.equal(record?.pending_summary, null);
      assert.equal(record?.notified_at, null);
      // 依頼（workflows）はまだ無い（受付が先、記録は後。ADR 0135）。
      assert.equal(record?.workflow_state, null);
      assert.equal(record?.turn_id, null);
    } finally {
      db.close();
    }
  });
});

test('accept: 同じ dedupe_key の再送は重複として既存の workflow_id を返し、別 ID では作らない', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      value(run(db, acceptOp()));
      assert.deepEqual(
        value<ResearchAcceptValue>(
          run(db, acceptOp({ workflow_id: 'wf-2', now: T1 })),
        ),
        { outcome: 'duplicate', workflow_id: 'wf-1' },
      );
      assert.equal(get(db, 'wf-2'), null);
      // 同じ workflow_id を別の dedupe_key で使うことはできない。
      assert.deepEqual(
        reasons(run(db, acceptOp({ dedupe_key: 'dk-2', now: T1 }))),
        ['workflow_conflict'],
      );
    } finally {
      db.close();
    }
  });
});

test('accept: 検査の記録が passed でない・版が違うものは受け付けず、何も保存しない', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      // 形の検査: rejected_reasons が残っている passed はあり得ない。
      assert.deepEqual(
        reasons(
          run(
            db,
            acceptOp({
              screening: { ...SCREENING, rejected_reasons: ['personal_data'] },
            }),
          ),
        ),
        ['rejected_reasons_invalid'],
      );
      // domain の検査: rules_version は現行の 1 でなければならない。
      assert.deepEqual(
        reasons(
          run(db, acceptOp({ screening: { ...SCREENING, rules_version: 99 } })),
        ),
        ['screening_rules_version'],
      );
      assert.equal(get(db), null);
    } finally {
      db.close();
    }
  });
});

test('record_progress: 試行と出典を保存し、出典の URL は常に null で読み戻る', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      value(run(db, acceptOp()));
      const attempts = finishedAttempts({ summary: 'not_attempted' });
      value(
        run(db, {
          kind: 'research.record_progress',
          workflow_id: 'wf-1',
          attempts,
          sources: [
            {
              source_id: 'src-1',
              query_id: 'q-1',
              basis: 'page_read',
              fetched_at: T1,
              page_title: '天気のページ',
              excerpt: '明日は晴れです。',
              summary: null,
              content_hash: HASH_A,
              url: null,
            },
          ],
          pending_summary: null,
          now: T1,
        }),
      );
      const record = get(db);
      assert.deepEqual(record?.attempts, attempts);
      assert.deepEqual(record?.sources, [
        {
          source_id: 'src-1',
          query_id: 'q-1',
          basis: 'page_read',
          fetched_at: T1,
          page_title: '天気のページ',
          excerpt: '明日は晴れです。',
          summary: null,
          content_hash: HASH_A,
          url: null,
        },
      ]);
      // 読んでいないページの出典は作れない。
      assert.deepEqual(
        reasons(
          run(db, {
            kind: 'research.record_progress',
            workflow_id: 'wf-1',
            attempts,
            sources: [
              {
                source_id: 'src-9',
                query_id: 'q-1',
                basis: 'page_read',
                fetched_at: T1,
                page_title: null,
                excerpt: '読んでいない抜粋',
                summary: null,
                content_hash: HASH_A,
                url: null,
              },
            ],
            pending_summary: null,
            now: T1,
          }),
        ),
        ['source_attempt_mismatch'],
      );
    } finally {
      db.close();
    }
  });
});

test('advance: CAS が外れた遷移と、状態機械に無い遷移を断る', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      value(run(db, acceptOp()));
      // state_revision が合わない。
      assert.deepEqual(
        reasons(
          run(db, {
            kind: 'research.advance',
            workflow_id: 'wf-1',
            expected_state_revision: '9',
            to_state: 'searching',
            stop_reason: null,
            result_summary: null,
            now: T1,
          }),
        ),
        ['state_revision_conflict'],
      );
      // accepted から reading へは直接進めない（searching を経る）。
      const skipped = reasons(
        run(db, {
          kind: 'research.advance',
          workflow_id: 'wf-1',
          expected_state_revision: '1',
          to_state: 'reading',
          stop_reason: null,
          result_summary: null,
          now: T1,
        }),
      );
      assert.equal(skipped[0]?.startsWith('transition_'), true);
      // 正しい遷移は進む。
      const moved = value<ResearchJobRecord>(
        run(db, {
          kind: 'research.advance',
          workflow_id: 'wf-1',
          expected_state_revision: '1',
          to_state: 'searching',
          stop_reason: null,
          result_summary: null,
          now: T1,
        }),
      );
      assert.equal(moved.status.state, 'searching');
      assert.equal(moved.status.state_revision, '2');
      assert.equal(moved.status.updated_at, T1);
    } finally {
      db.close();
    }
  });
});

test('advance completed: pending_summary を結果にし、依頼を done にし、保持の期限を付ける', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedWorkflow(db);
      value(run(db, acceptOp()));
      value(
        run(db, {
          kind: 'research.advance',
          workflow_id: 'wf-1',
          expected_state_revision: '1',
          to_state: 'searching',
          stop_reason: null,
          result_summary: null,
          now: T1,
        }),
      );
      // 要約まで終わった試行と、完了文の先行保存。
      value(
        run(db, {
          kind: 'research.record_progress',
          workflow_id: 'wf-1',
          attempts: finishedAttempts(),
          sources: [
            {
              source_id: 'src-1',
              query_id: 'q-1',
              basis: 'page_read',
              fetched_at: T1,
              page_title: '天気のページ',
              excerpt: '明日は晴れです。',
              summary: '晴れの要約',
              content_hash: HASH_A,
              url: null,
            },
          ],
          pending_summary: '名古屋は明日晴れます。',
          now: T2,
        }),
      );
      // 状態機械の順に進める（searching → reading → summarizing → completed）。
      for (const [expected, toState] of [
        ['2', 'reading'],
        ['3', 'summarizing'],
      ] as const)
        value(
          run(db, {
            kind: 'research.advance',
            workflow_id: 'wf-1',
            expected_state_revision: expected,
            to_state: toState,
            stop_reason: null,
            result_summary: null,
            now: T2,
          }),
        );
      const done = value<ResearchJobRecord>(
        run(db, {
          kind: 'research.advance',
          workflow_id: 'wf-1',
          expected_state_revision: '4',
          to_state: 'completed',
          stop_reason: null,
          result_summary: null,
          now: T2,
        }),
      );
      assert.equal(done.status.state, 'completed');
      assert.equal(done.status.finished_at, T2);
      assert.deepEqual(done.status.result, {
        summary: '名古屋は明日晴れます。',
        sources: [
          {
            source_id: 'src-1',
            basis: 'page_read',
            fetched_at: T1,
            excerpt: '明日は晴れです。',
            summary: '晴れの要約',
            url: null,
          },
        ],
        // 読めた 1 ページがそのまま出典なので、未読は 0。
        unread_count: 0,
        scope_reduced: false,
      });
      // 依頼は同じ保存で done になる。
      assert.equal(done.workflow_state, 'done');
      // 保持（7 日）を過ぎた回復で消える。
      const recovered = value<ResearchRecoverValue>(
        run(db, { kind: 'research.recover', now: T_EXPIRED }),
      );
      assert.equal(recovered.expired, 1);
      assert.equal(get(db), null);
    } finally {
      db.close();
    }
  });
});

test('advance no_results: 0 件の検索は zero_hits で止まり、結果は持たない', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedWorkflow(db);
      value(run(db, acceptOp()));
      value(
        run(db, {
          kind: 'research.advance',
          workflow_id: 'wf-1',
          expected_state_revision: '1',
          to_state: 'searching',
          stop_reason: null,
          result_summary: null,
          now: T1,
        }),
      );
      value(
        run(db, {
          kind: 'research.record_progress',
          workflow_id: 'wf-1',
          attempts: finishedAttempts({
            searches: [
              {
                search_index: 1,
                query_id: 'q-1',
                outcome: 'zero_hits',
                hit_count: 0,
                failure_cause: null,
              },
            ],
            pages: [],
            summary: 'not_attempted',
          }),
          sources: [],
          pending_summary: null,
          now: T2,
        }),
      );
      const stopped = value<ResearchJobRecord>(
        run(db, {
          kind: 'research.advance',
          workflow_id: 'wf-1',
          expected_state_revision: '2',
          to_state: 'no_results',
          stop_reason: 'zero_hits',
          result_summary: null,
          now: T2,
        }),
      );
      assert.equal(stopped.status.state, 'no_results');
      assert.deepEqual(stopped.status.stop, {
        kind: 'no_results',
        reason: 'zero_hits',
      });
      assert.equal(stopped.status.result, null);
      assert.equal(stopped.workflow_state, 'done');
    } finally {
      db.close();
    }
  });
});

test('recover: 依頼の無い受付は取り消し、完了の未通知を返し、通知済みにすると返さない', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      // wf-1 は依頼なし（孤児）、wf-2 は依頼ありで完了まで進める。
      value(run(db, acceptOp()));
      seedWorkflow(db, 'wf-2');
      value(
        run(
          db,
          acceptOp({
            workflow_id: 'wf-2',
            dedupe_key: 'dk-2',
            screening: { ...SCREENING, query_id: 'q-2' },
          }),
        ),
      );
      value(
        run(db, {
          kind: 'research.advance',
          workflow_id: 'wf-2',
          expected_state_revision: '1',
          to_state: 'searching',
          stop_reason: null,
          result_summary: null,
          now: T1,
        }),
      );
      value(
        run(db, {
          kind: 'research.record_progress',
          workflow_id: 'wf-2',
          attempts: finishedAttempts({
            workflow_id: 'wf-2',
            searches: [
              {
                search_index: 1,
                query_id: 'q-2',
                outcome: 'hits',
                hit_count: 1,
                failure_cause: null,
              },
            ],
            pages: [
              {
                page_index: 1,
                query_id: 'q-2',
                outcome: 'read',
                source_id: 'src-2',
                http_status: 200,
                redirects: 0,
                bytes: 900,
                elapsed_ms: 200,
              },
            ],
          }),
          sources: [
            {
              source_id: 'src-2',
              query_id: 'q-2',
              basis: 'page_read',
              fetched_at: T1,
              page_title: null,
              excerpt: '抜粋です。',
              summary: null,
              content_hash: HASH_A,
              url: null,
            },
          ],
          pending_summary: '調べ終わりました。',
          now: T2,
        }),
      );
      for (const [expected, toState] of [
        ['2', 'reading'],
        ['3', 'summarizing'],
      ] as const)
        value(
          run(db, {
            kind: 'research.advance',
            workflow_id: 'wf-2',
            expected_state_revision: expected,
            to_state: toState,
            stop_reason: null,
            result_summary: null,
            now: T3,
          }),
        );
      value(
        run(db, {
          kind: 'research.advance',
          workflow_id: 'wf-2',
          expected_state_revision: '4',
          to_state: 'completed',
          stop_reason: null,
          result_summary: null,
          now: T3,
        }),
      );
      const recovered = value<ResearchRecoverValue>(
        run(db, { kind: 'research.recover', now: T3 }),
      );
      assert.equal(recovered.orphans_canceled, 1);
      assert.deepEqual(recovered.unnotified, ['wf-2']);
      assert.deepEqual(recovered.runnable, []);
      const orphan = get(db, 'wf-1');
      assert.equal(orphan?.status.state, 'canceled');
      assert.deepEqual(orphan?.status.stop, {
        kind: 'canceled',
        reason: 'superseded',
      });
      // 通知済みにすると、回復で返らなくなる。
      value(
        run(db, {
          kind: 'research.mark_notified',
          workflow_id: 'wf-2',
          now: T3,
        }),
      );
      const again = value<ResearchRecoverValue>(
        run(db, { kind: 'research.recover', now: T3 }),
      );
      assert.deepEqual(again.unnotified, []);
      assert.equal(get(db, 'wf-2')?.notified_at, T3);
    } finally {
      db.close();
    }
  });
});

test('list_runnable: 実行できる状態だけを、依頼の状態と一緒に返す', async () => {
  await withTempDir((dir) => {
    const db = openSeededDatabase(databasePath(dir));
    try {
      seedWorkflow(db);
      value(run(db, acceptOp()));
      value(
        run(
          db,
          acceptOp({
            workflow_id: 'wf-2',
            dedupe_key: 'dk-2',
            screening: { ...SCREENING, query_id: 'q-2' },
          }),
        ),
      );
      assert.deepEqual(value(run(db, { kind: 'research.list_runnable' })), [
        { workflow_id: 'wf-1', workflow_state: 'executing' },
        { workflow_id: 'wf-2', workflow_state: null },
      ]);
    } finally {
      db.close();
    }
  });
});
