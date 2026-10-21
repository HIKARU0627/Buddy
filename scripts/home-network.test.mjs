import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  HOME_NETWORK_REASONS,
  HOME_REPORT_MAX_AGE_MS,
  ROUTE_CHECKS,
  formatSubnet,
  homeNetworkDecision,
  parseHomeSubnet,
  subnetOfAddress,
} from '../packages/domain/dist/index.js';
import { loadContracts, parseStrictJson, root } from './contract-tools.mjs';

// 自宅ネットワークの判定（X42、ADR 0022）を、手書きの期待値（home-network-cases.json）と照合する。
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/home-network-cases.json', root),
    'utf8',
  ),
);
const { schema } = await loadContracts();

test('home network decisions follow the hand-written X42 expectations', () => {
  const ids = new Set();
  for (const entry of cases.cases) {
    assert(!ids.has(entry.id), entry.id);
    ids.add(entry.id);
    const input = { ...cases.base, ...entry.change };
    assert.deepEqual(homeNetworkDecision(input), entry.expected, entry.id);
  }
  // 許可は理由が一つもないときだけ。指紋だけ・直接経路だけの許可はない。
  for (const entry of cases.cases)
    assert.equal(
      entry.expected.allowed,
      entry.expected.reasons.length === 0,
      entry.id,
    );
});

test('the reason codes and the report freshness match the contract and the decision', () => {
  // 鮮度は 6 分（本人の判断 2026-10-21）。手書きの値と比べる。
  assert.equal(HOME_REPORT_MAX_AGE_MS, 360_000);
  assert.deepEqual(
    [...HOME_NETWORK_REASONS],
    schema.$defs.HomeNetworkReason.enum,
  );
  // 報告の経路は自宅判定を求めず、登録は中枢の画面だけ。
  assert.deepEqual(ROUTE_CHECKS.reportHomeFingerprint, ['device_token']);
  assert.deepEqual(ROUTE_CHECKS.registerHome, [
    'device_token',
    'home_network',
    'command_scope',
    'unlocked',
    'screen_operation',
    'hub_screen',
  ]);
  // 登録の状態は中枢の画面だけが読める（B03-08）。
  assert.deepEqual(ROUTE_CHECKS.getHomeRegistration, [
    'device_token',
    'home_network',
    'unlocked',
    'hub_screen',
  ]);
  // 外出先からの接続を有効にする経路はない（初期版は OFF に固定）。
  for (const id of Object.keys(ROUTE_CHECKS))
    assert(!/outside|away|remote_?access/iu.test(id), id);
  for (const name of Object.keys(schema.$defs))
    assert(!/outside|away/iu.test(name), name);
});

test('home subnets are canonical IPv4 network addresses with a bounded prefix', () => {
  for (const entry of cases.subnets) {
    const parsed = parseHomeSubnet(entry.text);
    assert.equal(parsed !== null, entry.canonical, entry.text);
    if (parsed !== null) assert.equal(formatSubnet(parsed), entry.text);
  }
  for (const entry of cases.address_subnets)
    assert.equal(
      subnetOfAddress(entry.address, entry.prefix),
      entry.expected,
      `${entry.address}/${entry.prefix}`,
    );
});

test('the schema pattern for home subnets agrees with the canonical parser on prefixes', () => {
  const pattern = new RegExp(schema.$defs.HomeSubnet.pattern, 'u');
  for (const entry of cases.subnets)
    if (entry.canonical) assert(pattern.test(entry.text), entry.text);
  for (const text of ['192.0.2.0/31', '10.0.0.0/7', '192.0.2.0/024'])
    assert(!pattern.test(text), text);
});
