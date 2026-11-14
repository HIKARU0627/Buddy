import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_TIMEOUT_MS,
  WEB_RESEARCH_MAX_PAGES,
  WEB_SEARCH_MAX_SEARCHES,
  WEB_SEARCH_PROVIDER,
  privateWebTargetReason,
  webFetchUsageErrors,
  webResearchUsageErrors,
  webSourceErrors,
  webUsagePolicyErrors,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// B12-01（ADR 0077）: 公開 Web 調査の検索・取得・出典・上限・利用条件。
// 期待値は本人の決定（2026-11-03、D2）と設計 05 から手で書き、実装から生成しない。
const { validators, schema } = await loadContracts();
const defs = schema.$defs;
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/web-research-cases.json', root),
    'utf8',
  ),
);

test('B12-01: the provider is Brave and the search results are transient only', () => {
  assert.equal(WEB_SEARCH_PROVIDER, 'brave');
  const policy = cases.cases.find((entry) => entry.id === 'policy').value;
  assert(validators['WebUsagePolicy'](policy));
  assert.equal(policy.provider, 'brave');
  // Brave の利用条件 3(b)(i): 検索結果は操作に必要な一時保存だけ。
  assert.equal(policy.retention, 'transient_only');
  // Brave の利用条件 3(b)(xiii): モデルの訓練・評価に使わない。
  assert.equal(policy.model_use, 'grounding_only');
  // URL を永続保存してよいかは B12-02 で決める。
  assert.equal(policy.url_storage, 'undecided');
  assert.equal(
    defs.WebSearchResponse.properties.retention.const,
    'transient_only',
  );
  assert.equal(
    defs.WebSearchResponse.properties.model_use.const,
    'grounding_only',
  );
  // 検索結果に保存用の項目を持たせない。
  for (const field of ['stored_at', 'persistent', 'database_id'])
    assert.equal(field in defs.WebSearchHit.properties, false, field);
});

test('B12-01: the initial limits match the design (3 searches, 5 pages, 2 MB, 15 s, 3 redirects)', () => {
  assert.equal(WEB_SEARCH_MAX_SEARCHES, 3);
  assert.equal(WEB_RESEARCH_MAX_PAGES, 5);
  assert.equal(WEB_FETCH_MAX_BYTES, 2_000_000);
  assert.equal(WEB_FETCH_TIMEOUT_MS, 15_000);
  assert.equal(WEB_FETCH_MAX_REDIRECTS, 3);
  const limits = cases.cases.find((entry) => entry.id === 'limits').value;
  assert(validators['WebResearchLimits'](limits));
  assert.equal(defs.WebResearchLimits.properties.max_searches.const, 3);
  assert.equal(defs.WebResearchLimits.properties.max_pages.const, 5);
  assert.equal(
    defs.WebResearchLimits.properties.max_bytes_per_page.const,
    2000000,
  );
  assert.equal(defs.WebResearchLimits.properties.timeout_ms.const, 15000);
  assert.equal(defs.WebResearchLimits.properties.max_redirects.const, 3);
});

test('B12-01: the hand-written usage boundaries are kept', () => {
  for (const entry of cases.domain_cases.usage)
    assert.deepEqual(
      webResearchUsageErrors(entry.usage),
      entry.expected,
      entry.id,
    );
  for (const entry of cases.domain_cases.fetch)
    assert.deepEqual(
      webFetchUsageErrors(entry.usage),
      entry.expected,
      entry.id,
    );
  for (const entry of cases.domain_cases.sources)
    assert.deepEqual(webSourceErrors(entry.source), entry.expected, entry.id);
  for (const entry of cases.domain_cases.policies)
    assert.deepEqual(
      webUsagePolicyErrors(entry.policy),
      entry.expected,
      entry.id,
    );
});

test('B12-01: the fixture keeps the allowed and rejected shapes', () => {
  for (const entry of cases.cases) {
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
  // 読めない本文は根拠にしない。検索結果の要約だけの出典は抜粋・要約を持たない。
  const unreadable = cases.cases.find(
    (entry) => entry.id === 'fetch-result-unreadable',
  ).value;
  assert.equal(unreadable.readable, false);
  assert.equal(unreadable.text, null);
  const summaryOnly = cases.cases.find(
    (entry) => entry.id === 'source-search-summary-only',
  ).value;
  assert.equal(summaryOnly.basis, 'search_summary_only');
  assert.equal(summaryOnly.excerpt, null);
  assert.equal(summaryOnly.summary, null);
  assert.equal(summaryOnly.fetched_at, null);
  // ローカル・プライベートへの取得は拒否する。
  const privateTarget = cases.cases.find(
    (entry) => entry.id === 'fetch-request-private',
  );
  assert.deepEqual(semanticErrors(privateTarget.schema, privateTarget.value), [
    'private_target',
  ]);
  // 非公開 IPv6（ULA・リンクローカル・IPv4 mapped loopback）も拒否し、公開 IPv6 は通す。
  for (const id of [
    'fetch-request-ipv6-ula',
    'fetch-request-ipv6-link-local',
    'fetch-request-ipv6-mapped-loopback',
  ]) {
    const entry = cases.cases.find((candidate) => candidate.id === id);
    assert.deepEqual(
      semanticErrors(entry.schema, entry.value),
      ['private_target'],
      id,
    );
  }
  const publicIpv6 = cases.cases.find(
    (entry) => entry.id === 'fetch-request-ipv6-public',
  );
  assert.deepEqual(semanticErrors(publicIpv6.schema, publicIpv6.value), []);
  // 契約ゲートと domain の判定が同じ結論になる（形式で拒否する http は除く）。
  for (const entry of cases.cases.filter(
    (candidate) =>
      candidate.schema === 'WebFetchRequest' &&
      candidate.value.url.startsWith('https://'),
  ))
    assert.equal(
      privateWebTargetReason(entry.value.url) !== null,
      semanticErrors(entry.schema, entry.value).includes('private_target'),
      entry.id,
    );
  // CGNAT（Tailscale）・マルチキャスト・文書用 IPv6 も拒否し、公開 IPv6 は通す。
  for (const url of [
    'https://100.64.0.1/',
    'https://224.0.0.1/',
    'https://[2001:db8::1]/',
  ])
    assert.equal(privateWebTargetReason(url), 'private_target', url);
  assert.equal(privateWebTargetReason('https://[2606:4700:4700::1111]/'), null);
});
