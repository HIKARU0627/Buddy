import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ROUTE_CHECKS,
  TARGET_DISCOVERY_STATUSES,
  TARGET_OPTION_KINDS,
  targetDiscoveryErrors,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// 選べる取得対象（ADR 0145）。形式は contracts:check が確かめる。ここでは、契約の列挙と domain の語彙が同じであること、
// 契約の検証ツールの意味検査と domain の targetDiscoveryErrors が fixture のすべてで同じ結論を出すこと、
// 経路が中枢の画面だけであること、画面へ渡す形に接続 ID が無いことを確かめる。期待値は手で書く。
const { validators, schema } = await loadContracts();
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/schema-cases.json', root),
    'utf8',
  ),
);

test('discovery enums match the domain vocabulary', () => {
  const defs = schema.$defs;
  assert.deepEqual(
    [...TARGET_DISCOVERY_STATUSES],
    defs.ConnectionTargetOptionList.properties.status.enum,
  );
  assert.deepEqual(
    [...TARGET_DISCOVERY_STATUSES],
    defs.ConnectionCategoryList.properties.status.enum,
  );
  assert.deepEqual(
    [...TARGET_OPTION_KINDS],
    defs.ConnectionTargetOption.properties.kind.enum,
  );
});

test('the contract tools and the domain agree on every discovery fixture', () => {
  const discovery = cases.filter(
    (entry) => entry.schema === 'ConnectionTargetDiscovery' && entry.valid,
  );
  // 許可例 3 件と、意味検査で落ちる例 8 件（手で数えた数）。
  assert.equal(discovery.length, 11);
  let failing = 0;
  for (const entry of discovery) {
    assert(validators.ConnectionTargetDiscovery(entry.value), entry.id);
    const tools = semanticErrors('ConnectionTargetDiscovery', entry.value);
    const domain = targetDiscoveryErrors(entry.value.provider, entry.value);
    assert.deepEqual(tools, domain, entry.id);
    assert.deepEqual(tools, entry.semantic_errors ?? [], entry.id);
    if (tools.length > 0) failing += 1;
  }
  assert.equal(failing, 8);
});

test('the target options route is a hub-screen read and the screen value has no connection id', () => {
  assert.deepEqual(
    [...ROUTE_CHECKS.listConnectionTargetOptions],
    ['device_token', 'home_network', 'unlocked', 'hub_screen'],
  );
  const desktop = schema.$defs.DesktopConnectionDiscovery;
  assert.deepEqual(Object.keys(desktop.properties), [
    'calendars',
    'mail_containers',
    'categories',
  ]);
  assert.equal(desktop.additionalProperties, false);
});
