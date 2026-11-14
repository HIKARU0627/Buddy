import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  webPageAdmissionLimitErrors,
  webPageAttemptErrors,
  webResearchAttemptsErrors,
  webResearchConfirmedLabel,
  webResearchFinalState,
  webResearchOutcomeErrors,
  webResearchUsageOf,
  webSearchAdmissionLimitErrors,
  webSearchAttemptErrors,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// B12-02 P2（ADR 0128・0129）: 公開 Web 調査の上限の数え方と、失敗・0 件・保留・完了の区別。
// 期待値は設計 05（3 検索・5 ページ・2MB・15 秒・3 リダイレクト）、Issue #27 の完了条件（失敗を完了と表示しない）から
// 手で書き、実装から生成しない。
const { validators, schema } = await loadContracts();
const defs = schema.$defs;
const cases = parseStrictJson(
  await readFile(
    new URL(
      'packages/contracts/fixtures/web-research-attempts-cases.json',
      root,
    ),
    'utf8',
  ),
);
const open = { url_storage: 'undecided' };

test('B12-02 P2: the fixture keeps the allowed and rejected shapes', () => {
  const ids = new Set();
  for (const entry of cases.cases) {
    assert(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    const validate = validators[entry.schema];
    assert(validate, entry.schema);
    assert.equal(
      validate(entry.value),
      entry.valid,
      `${entry.id}: ${JSON.stringify(validate.errors)}`,
    );
    if (entry.valid)
      assert.deepEqual(
        semanticErrors(entry.schema, entry.value),
        entry.semantic_errors ?? [],
        entry.id,
      );
    else assert.equal(entry.semantic_errors, undefined, entry.id);
  }
});

test('B12-02 P2: the attempt records keep no search result, URL or body', () => {
  for (const name of [
    'WebSearchAttempt',
    'WebPageAttempt',
    'WebResearchAttempts',
  ]) {
    assert.equal(defs[name].additionalProperties, false, name);
    for (const field of [
      'url',
      'urls',
      'title',
      'snippet',
      'hits',
      'text',
      'body',
      'query',
    ])
      assert.equal(field in defs[name].properties, false, `${name}.${field}`);
  }
  // 上限は schema の形にも入っている（3 検索・5 ページ・2MB・15 秒・3 リダイレクト）。
  assert.equal(defs.WebResearchAttempts.properties.searches.maxItems, 3);
  assert.equal(defs.WebResearchAttempts.properties.pages.maxItems, 5);
  assert.equal(defs.WebSearchAttempt.properties.search_index.maximum, 3);
  assert.equal(defs.WebPageAttempt.properties.page_index.maximum, 5);
  assert.equal(defs.WebPageAttempt.properties.bytes.maximum, 2_000_000);
  assert.equal(defs.WebPageAttempt.properties.elapsed_ms.maximum, 15_000);
  assert.equal(defs.WebPageAttempt.properties.redirects.maximum, 3);
});

test('B12-02 P2: the search and page limits refuse the request after the limit', () => {
  for (const entry of cases.domain_cases.admission.search)
    assert.deepEqual(
      webSearchAdmissionLimitErrors({
        searches: Array.from({ length: entry.searches }, (_, index) => ({
          search_index: index + 1,
        })),
      }),
      entry.expected,
      `${entry.searches} searches`,
    );
  for (const entry of cases.domain_cases.admission.page)
    assert.deepEqual(
      webPageAdmissionLimitErrors(
        {
          searches: [
            {
              search_index: 1,
              query_id: 'q',
              outcome: 'hits',
              hit_count: entry.hits,
              failure_cause: null,
            },
          ],
          pages: Array.from({ length: entry.pages }, () => ({
            query_id: 'q',
          })),
        },
        'q',
      ),
      entry.expected,
      `${entry.pages} pages of ${entry.hits} hits`,
    );
  // 失敗した検索の件数・0 件の検索は、取得できる件数に入らない。
  assert.deepEqual(
    webPageAdmissionLimitErrors(
      {
        searches: [
          {
            search_index: 1,
            query_id: 'q',
            outcome: 'failed',
            hit_count: 0,
            failure_cause: 'timeout',
          },
        ],
        pages: [],
      },
      'q',
    ),
    ['no_more_hits'],
  );
  // 検索ごとの件数で数える。検索 A が 1 件・検索 B が 4 件のとき、A の 2 件目は取らず、B は取れる
  // （B の未使用の件数を A のページに使わない）。見つかっていない検索の取得は受け付けない。
  const hits = (index, queryId, count) => ({
    search_index: index,
    query_id: queryId,
    outcome: 'hits',
    hit_count: count,
    failure_cause: null,
  });
  const twoSearches = {
    searches: [hits(1, 'a', 1), hits(2, 'b', 4)],
    pages: [{ query_id: 'a' }],
  };
  assert.deepEqual(webPageAdmissionLimitErrors(twoSearches, 'a'), [
    'no_more_hits',
  ]);
  assert.deepEqual(webPageAdmissionLimitErrors(twoSearches, 'b'), []);
  assert.deepEqual(webPageAdmissionLimitErrors(twoSearches, 'c'), [
    'no_more_hits',
  ]);
});

test('B12-02 P2: attempts are counted whether they failed, were rejected or were read', () => {
  const find = (id) =>
    cases.domain_cases.final_state.find((entry) => entry.id === id).attempts;
  // 失敗した検索も 1 回に数え、読めなかった・拒否した取得も 1 ページに数える。
  assert.deepEqual(
    webResearchUsageOf(find('completed-after-one-search-failed')),
    { searches: 2, pages: 1 },
  );
  assert.deepEqual(webResearchUsageOf(find('every-page-rejected-or-failed')), {
    searches: 1,
    pages: 3,
  });
  // 断った（送らなかった）検索は数えない。
  assert.deepEqual(
    webResearchUsageOf(find('budget-denied-before-any-search')),
    { searches: 0, pages: 0 },
  );
});

test('B12-02 P2: the attempt consistency matches the hand-written cases', () => {
  for (const entry of cases.domain_cases.attempts_errors)
    assert.deepEqual(
      webResearchAttemptsErrors(entry.attempts),
      entry.expected,
      entry.id,
    );
  // 上限を超える記録は schema の外だが、domain も拒否する（4 回目の検索・6 ページ目）。
  const typical = cases.domain_cases.attempts_errors[0].attempts;
  const search = typical.searches[0];
  assert.deepEqual(
    webResearchAttemptsErrors({
      ...typical,
      searches: [1, 2, 3, 4].map((index) => ({
        ...search,
        search_index: index,
        hit_count: 5,
      })),
    }),
    ['search_limit'],
  );
  const page = typical.pages[0];
  assert.deepEqual(
    webResearchAttemptsErrors({
      ...typical,
      searches: [{ ...search, hit_count: 10 }],
      pages: [1, 2, 3, 4, 5, 6].map((index) => ({
        ...page,
        page_index: index,
        outcome: 'http_error',
        source_id: null,
        http_status: 500,
        bytes: 0,
      })),
      summary: 'not_attempted',
    }),
    ['page_limit'],
  );
  // 検索 1 回・ページ 1 件の整合は、契約ゲートの意味検査と domain が同じ結論になる。
  for (const entry of cases.cases.filter(
    (candidate) => candidate.schema === 'WebSearchAttempt' && candidate.valid,
  ))
    assert.deepEqual(
      webSearchAttemptErrors(entry.value),
      entry.semantic_errors ?? [],
      entry.id,
    );
  for (const entry of cases.cases.filter(
    (candidate) => candidate.schema === 'WebPageAttempt' && candidate.valid,
  ))
    assert.deepEqual(
      webPageAttemptErrors(entry.value),
      entry.semantic_errors ?? [],
      entry.id,
    );
});

test('B12-02 P2: the final state is decided by the hand-written table', () => {
  for (const entry of cases.domain_cases.final_state) {
    const final = webResearchFinalState(entry.attempts);
    if (entry.expected === null) {
      assert.equal(final, null, entry.id);
      continue;
    }
    assert(final, entry.id);
    assert.equal(final.state, entry.expected.state, entry.id);
    assert.equal(final.stop?.reason ?? null, entry.expected.reason, entry.id);
    if (final.stop !== null)
      assert.equal(final.stop.kind, final.state, entry.id);
    assert.equal(final.unread_count, entry.expected.unread_count, entry.id);
    assert.equal(final.scope_reduced, entry.expected.scope_reduced, entry.id);
  }
});

test('B12-02 P2: a failure, a zero-hit search and an unreadable page are never the same outcome', () => {
  const final = (id) =>
    webResearchFinalState(
      cases.domain_cases.final_state.find((entry) => entry.id === id).attempts,
    );
  // 失敗と 0 件: 全部成功して 0 件のときだけ no_results。1 回でも失敗していれば 0 件と言い切らない。
  assert.equal(final('no-results-two-searches').state, 'no_results');
  assert.equal(final('zero-hits-but-another-search-failed').state, 'failed');
  // 読めないページ: 検索の件数があっても、読めたページが無ければ完了にしない。
  assert.equal(final('every-page-unreadable').state, 'failed');
  assert.equal(final('every-page-unreadable').stop.reason, 'no_readable_page');
  // 3 つの終わり方は、状態も理由も互いに違う。
  const ends = [
    'all-searches-failed',
    'no-results-one-search',
    'every-page-unreadable',
  ].map((id) => `${final(id).state}/${final(id).stop.reason}`);
  assert.equal(new Set(ends).size, 3);
  // 保留は予算・検索語の拒否だけ。失敗・0 件・読めないは保留にならない。
  for (const id of [
    'all-searches-failed',
    'no-results-one-search',
    'every-page-unreadable',
  ])
    assert.notEqual(final(id).state, 'held', id);
  // 完了になるのは、要約が ok で、読めたページが 1 件以上あるときだけ。
  const completed = cases.domain_cases.final_state.filter(
    (entry) => entry.expected?.state === 'completed',
  );
  assert(completed.length >= 5);
  for (const entry of completed) {
    assert.equal(entry.attempts.summary, 'ok', entry.id);
    assert(
      entry.attempts.pages.some((page) => page.outcome === 'read'),
      entry.id,
    );
  }
});

test('B12-02 P2: a status that does not match its attempts is never shown as completed', () => {
  for (const entry of cases.domain_cases.outcome) {
    assert.deepEqual(
      webResearchOutcomeErrors(entry.status, entry.attempts),
      entry.expected,
      entry.id,
    );
    assert.equal(
      webResearchConfirmedLabel(entry.status, entry.attempts, entry.policy),
      entry.label,
      entry.id,
    );
    if (entry.status.state === 'completed' && entry.label === 'completed')
      assert.equal(entry.expected.length, 0, entry.id);
  }
  // 試行の記録が壊れている（整合しない）ときは、状態が合っていても確認できない。
  const matches = cases.domain_cases.outcome.find(
    (entry) => entry.id === 'completed-matches',
  );
  assert.equal(
    webResearchConfirmedLabel(
      matches.status,
      { ...matches.attempts, page_limit_denials: 1 },
      open,
    ),
    'unconfirmed',
  );
});
