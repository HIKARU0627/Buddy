import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  WEB_QUERY_MAX_CODE_POINTS,
  WEB_QUERY_MAX_WORDS,
  WEB_QUERY_SCREENING_VERSION,
  WEB_RESEARCH_STATES,
  webQueryRejectReasons,
  webQueryScreeningErrors,
  webResearchDisplayLabel,
  webResearchIsTerminal,
  webResearchNextStates,
  webResearchNotificationParts,
  webResearchStatusErrors,
  webResearchTransitionErrors,
  webSearchAdmissionErrors,
  webSourceRecordErrors,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// B12-02 P1（ADR 0125〜0127）: 公開 Web 調査の検索語の検査・永続の出典・受付/進捗/完了の応答。
// 期待値は設計 05・10 §5、Brave の利用条件、本人の決定（2026-11-03、D2）から手で書き、実装から生成しない。
const { validators, schema } = await loadContracts();
const defs = schema.$defs;
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/web-research-status-cases.json', root),
    'utf8',
  ),
);
const byId = (id) => cases.cases.find((entry) => entry.id === id);

test('B12-02: the fixture keeps the allowed and rejected shapes', () => {
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

test('B12-02: a persisted source never keeps search results', () => {
  const properties = defs.WebSourceRecord.properties;
  assert.equal(properties.basis.const, 'page_read');
  // 検索結果のスニペット・要約・順位・結果の本体を持つ欄が無い（additionalProperties: false で追加もできない）。
  for (const field of [
    'snippet',
    'search_summary',
    'description',
    'hit',
    'rank',
  ])
    assert.equal(field in properties, false, field);
  assert.equal(defs.WebSourceRecord.additionalProperties, false);
  assert.equal(
    validators['WebSourceRecord'](byId('source-record-with-snippet').value),
    false,
  );
  // 検索結果の要約だけの出典は、永続の形に入れない。
  assert.equal(
    validators['WebSourceRecord'](
      byId('source-record-search-summary-only').value,
    ),
    false,
  );
  // 抜粋は短く（500 文字）、要約は 4000 文字まで。本文全体は持たない。
  assert.equal(properties.excerpt.anyOf[0].maxLength, 500);
  assert.equal(properties.summary.anyOf[0].maxLength, 4000);
  for (const field of ['text', 'body', 'content', 'html'])
    assert.equal(field in properties, false, field);
  // 本文の hash は 64 桁の 16 進で、取得した本文を後から突き合わせる。
  assert.equal(properties.content_hash.$ref, '#/$defs/Hash');
});

test('B12-02: the transient links are marked transient and stay out of the stored result', () => {
  const links = defs.WebTransientLinks.properties;
  assert.equal(links.retention.const, 'transient_only');
  assert.equal(links.items.maxItems, 5);
  // 結果（result）には URL・タイトルの欄が無く、リンクは応答の別の欄だけにある。
  for (const field of ['url', 'urls', 'links', 'title'])
    assert.equal(field in defs.WebResearchResult.properties, false, field);
  assert('transient_links' in defs.WebResearchStatus.properties);
  assert.equal(
    validators['WebResearchStatus'](byId('status-links-persistent').value),
    false,
  );
});

test('B12-02: the query screening reasons match the hand-written cases', () => {
  for (const entry of cases.domain_cases.query_reasons)
    assert.deepEqual(
      webQueryRejectReasons(entry.query),
      entry.expected,
      entry.id,
    );
});

test('B12-02: the query screening boundaries and secret-looking values are rejected', () => {
  assert.equal(WEB_QUERY_SCREENING_VERSION, 1);
  assert.equal(WEB_QUERY_MAX_CODE_POINTS, 512);
  assert.equal(WEB_QUERY_MAX_WORDS, 75);
  // 長さは UTF-16 ではなくコードポイントで数える（512 を許し、513 を拒否）。
  assert.deepEqual(webQueryRejectReasons('あ'.repeat(512)), []);
  assert.deepEqual(webQueryRejectReasons('あ'.repeat(513)), ['too_long']);
  assert.deepEqual(webQueryRejectReasons('𠮷'.repeat(512)), []);
  assert.deepEqual(webQueryRejectReasons('𠮷'.repeat(513)), ['too_long']);
  // 語数は 75 まで。
  assert.deepEqual(webQueryRejectReasons(Array(75).fill('a').join(' ')), []);
  assert.deepEqual(webQueryRejectReasons(Array(76).fill('a').join(' ')), [
    'too_many_words',
  ]);
  // 鍵・トークンの形は実行時に組み立てる（試験のソースに鍵に見える文字列を置かない）。
  const tokens = {
    api_key: ['sk', '-', 'x'.repeat(24)].join(''),
    aws: ['AKIA', 'A'.repeat(16)].join(''),
    github: ['ghp', '_', 'x'.repeat(30)].join(''),
    slack: ['xoxb', '-', 'a'.repeat(12)].join(''),
    bearer: ['Bearer', ' ', 'x'.repeat(24)].join(''),
    jwt: ['eyJ', 'x'.repeat(12), '.', 'y'.repeat(12), '.', 'z'.repeat(12)].join(
      '',
    ),
    long_run: 'q'.repeat(40),
  };
  for (const [name, token] of Object.entries(tokens))
    assert.deepEqual(
      webQueryRejectReasons(`weather ${token}`),
      ['secret_like_token'],
      name,
    );
  // 31 文字までの英数字は通す（普通の長い単語・型番を拒否しない）。
  assert.deepEqual(webQueryRejectReasons('q'.repeat(31)), []);
  // 電話番号らしさは 10 桁以上の数字の連なり。9 桁までと、日付・区切りの短い数字は通す。
  assert.deepEqual(webQueryRejectReasons('code 123456789'), []);
  assert.deepEqual(webQueryRejectReasons('call 0312345678'), ['phone_number']);
  assert.deepEqual(webQueryRejectReasons('call +81 3 1234 5678'), [
    'phone_number',
  ]);
  // 行の区切りは \n・\r・U+2028・U+2029 のどれも拒否する。
  for (const separator of ['\n', '\r', ' ', ' '])
    assert.deepEqual(
      webQueryRejectReasons(`first${separator}second`),
      ['line_break'],
      JSON.stringify(separator),
    );
});

test('B12-02: a search is only admitted with a matching passed screening', () => {
  for (const entry of cases.domain_cases.admission)
    assert.deepEqual(
      webSearchAdmissionErrors(entry.request, entry.screening),
      entry.expected,
      entry.id,
    );
  // 検査の記録そのものの整合は、契約ゲートと domain が同じ結論になる。
  for (const entry of cases.cases.filter(
    (candidate) =>
      candidate.schema === 'WebQueryScreening' && candidate.valid === true,
  ))
    assert.deepEqual(
      webQueryScreeningErrors(entry.value),
      entry.semantic_errors ?? [],
      entry.id,
    );
});

test('B12-02: a persisted source holds a URL only when the policy allows it', () => {
  for (const entry of cases.domain_cases.source_policy)
    assert.deepEqual(
      webSourceRecordErrors(entry.source, entry.policy),
      entry.expected,
      entry.id,
    );
  // 既定は「保存しない」側。undecided でも disallowed でも URL を持てない。
  for (const urlStorage of ['undecided', 'disallowed'])
    assert.deepEqual(
      webSourceRecordErrors(
        { ...byId('source-record-url-set').value },
        { url_storage: urlStorage },
      ),
      ['url_not_storable'],
      urlStorage,
    );
});

test('B12-02: the status checks and display labels match the hand-written cases', () => {
  for (const entry of cases.domain_cases.status) {
    const status = byId(entry.ref).value;
    assert.deepEqual(
      webResearchStatusErrors(status, entry.policy),
      entry.expected,
      `${entry.ref} ${entry.policy.url_storage}`,
    );
    assert.equal(
      webResearchDisplayLabel(status, entry.policy),
      entry.label,
      `${entry.ref} ${entry.policy.url_storage}`,
    );
  }
});

test('B12-02: only a valid completed status can be shown as completed', () => {
  const policy = { url_storage: 'undecided' };
  // どの状態の応答でも、completed の見出しになるのは完了の状態の応答だけ。
  for (const entry of cases.cases.filter(
    (candidate) => candidate.schema === 'WebResearchStatus' && candidate.valid,
  )) {
    const label = webResearchDisplayLabel(entry.value, policy);
    if (label === 'completed') {
      assert.equal(entry.value.state, 'completed', entry.id);
      assert(entry.value.result !== null, entry.id);
      assert(entry.value.result.sources.length >= 1, entry.id);
      assert.equal(entry.value.stop, null, entry.id);
    }
  }
  // 失敗・0 件・保留・取消に、完了の結果を載せても完了にならない（結果があっても unconfirmed）。
  for (const [state, stop] of [
    ['failed', { kind: 'failed', reason: 'search_failed' }],
    ['no_results', { kind: 'no_results', reason: 'zero_hits' }],
    ['held', { kind: 'held', reason: 'budget_held' }],
    ['canceled', { kind: 'canceled', reason: 'user_canceled' }],
  ]) {
    const done = byId('status-completed').value;
    const forged = {
      ...done,
      state,
      stop,
      finished_at: state === 'held' ? null : done.finished_at,
    };
    assert.notEqual(
      webResearchDisplayLabel(forged, policy),
      'completed',
      state,
    );
    assert.equal(webResearchDisplayLabel(forged, policy), 'unconfirmed', state);
  }
  // 理由と種類の取り違えも拒否する（0 件を失敗の理由にする、失敗を 0 件の理由にする）。
  const failed = byId('status-failed').value;
  assert.deepEqual(
    webResearchStatusErrors(
      { ...failed, stop: { kind: 'failed', reason: 'zero_hits' } },
      policy,
    ),
    ['stop_reason_mismatch'],
  );
  assert.deepEqual(
    webResearchStatusErrors(
      { ...failed, stop: { kind: 'no_results', reason: 'search_failed' } },
      policy,
    ),
    ['stop_kind_mismatch', 'stop_reason_mismatch'],
  );
  // ページの合計は 5 まで（読んだ数＋読めなかった数）。
  const completed = byId('status-completed').value;
  assert.deepEqual(
    webResearchStatusErrors(
      { ...completed, result: { ...completed.result, unread_count: 3 } },
      policy,
    ),
    [],
  );
  assert.deepEqual(
    webResearchStatusErrors(
      { ...completed, result: { ...completed.result, unread_count: 4 } },
      policy,
    ),
    ['page_limit'],
  );
  // リンクは結果の出典にあるものだけ。
  assert.deepEqual(
    webResearchStatusErrors(
      {
        ...completed,
        transient_links: {
          retention: 'transient_only',
          items: [
            {
              source_id: '00000000-0000-4000-8000-000000000a99',
              url: 'https://example.com/other',
              title: null,
            },
          ],
        },
      },
      policy,
    ),
    ['transient_link_unknown_source'],
  );
  // 出典の source_id が重ならない。
  assert.deepEqual(
    webResearchStatusErrors(
      {
        ...completed,
        result: {
          ...completed.result,
          sources: [completed.result.sources[0], completed.result.sources[0]],
        },
      },
      policy,
    ),
    ['source_id_duplicate'],
  );
  // 時刻は受付 ≦ 更新、受付 ≦ 完了。
  assert.deepEqual(
    webResearchStatusErrors(
      { ...completed, updated_at: '2029-12-31T23:59:59Z' },
      policy,
    ),
    ['updated_before_accepted'],
  );
  assert.deepEqual(
    webResearchStatusErrors(
      { ...completed, finished_at: '2029-12-31T23:59:59Z' },
      policy,
    ),
    ['finished_before_accepted'],
  );
});

test('B12-02: the transition table is the hand-written one', () => {
  assert.deepEqual(
    [...WEB_RESEARCH_STATES].sort(),
    Object.keys(cases.domain_cases.transitions).sort(),
  );
  for (const [from, nexts] of Object.entries(cases.domain_cases.transitions)) {
    assert.deepEqual(
      [...webResearchNextStates(from)].sort(),
      [...nexts].sort(),
      from,
    );
    // 表にない遷移は、状態の版が正しくても拒否する。
    for (const to of WEB_RESEARCH_STATES) {
      const previous = { ...byId('status-accepted').value, state: from };
      const next = { ...previous, state: to, state_revision: '2' };
      assert.deepEqual(
        webResearchTransitionErrors(previous, next),
        nexts.includes(to) ? [] : ['transition_not_allowed'],
        `${from} -> ${to}`,
      );
    }
  }
  // 終端は completed・no_results・failed・canceled。held は終端ではない。
  for (const state of ['completed', 'no_results', 'failed', 'canceled'])
    assert.equal(webResearchIsTerminal(state), true, state);
  for (const state of [
    'accepted',
    'searching',
    'reading',
    'summarizing',
    'held',
  ])
    assert.equal(webResearchIsTerminal(state), false, state);
  // 失敗した調査を、そのまま完了にできない。held からは検索のやり直しだけで、続きの読み込み・要約へ戻せない。
  assert.deepEqual(webResearchNextStates('failed'), []);
  assert.equal(webResearchNextStates('held').includes('summarizing'), false);
  assert.equal(webResearchNextStates('held').includes('reading'), false);
});

test('B12-02: the status revision moves by one within the same request', () => {
  const base = byId('status-accepted').value;
  const next = { ...base, state: 'searching', state_revision: '2' };
  assert.deepEqual(webResearchTransitionErrors(base, next), []);
  assert.deepEqual(
    webResearchTransitionErrors(base, { ...next, state_revision: '1' }),
    ['state_revision_not_next'],
  );
  assert.deepEqual(
    webResearchTransitionErrors(base, { ...next, state_revision: '3' }),
    ['state_revision_not_next'],
  );
  assert.deepEqual(
    webResearchTransitionErrors(base, { ...next, state_revision: '02' }),
    ['state_revision_invalid'],
  );
  assert.deepEqual(
    webResearchTransitionErrors(base, { ...next, request_revision: '2' }),
    ['other_request'],
  );
  assert.deepEqual(
    webResearchTransitionErrors(base, {
      ...next,
      workflow_id: '00000000-0000-4000-8000-000000000a02',
    }),
    ['other_request'],
  );
  assert.deepEqual(
    webResearchTransitionErrors(base, {
      ...next,
      accepted_at: '2030-01-02T00:00:00Z',
    }),
    ['accepted_at_changed'],
  );
  assert.deepEqual(
    webResearchTransitionErrors(base, { ...next, state: 'unknown' }),
    ['state_unknown'],
  );
});

test('B12-02: only a completed research makes the research_done notification', () => {
  for (const entry of cases.domain_cases.notification)
    assert.deepEqual(
      webResearchNotificationParts(byId(entry.ref).value, entry.policy),
      entry.expected,
      entry.ref,
    );
  // 完了の版は完了した応答の state_revision。同じ完了を読み直しても同じ材料になる。
  const completed = byId('status-completed').value;
  assert.deepEqual(
    webResearchNotificationParts(completed, { url_storage: 'undecided' }),
    webResearchNotificationParts(
      { ...completed, transient_links: null },
      { url_storage: 'undecided' },
    ),
  );
});
