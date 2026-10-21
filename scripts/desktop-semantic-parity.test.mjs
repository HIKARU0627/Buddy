import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { desktopSemanticErrors } from '../apps/desktop/dist/main/contract.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// デスクトップの main が持つ意味検査（apps/desktop の contract.ts）と、契約の検証ツールの意味検査
// （scripts/contract-tools.mjs）が同じ結論を出すことを確かめる。片方だけを変えるとここで落ちる。
// 期待値はどちらの実装からも作らず、両者の一致だけを見る。
const { validators } = await loadContracts();
const cases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/schema-cases.json', root),
    'utf8',
  ),
);

const STATUS_VARIANTS = {
  stop_scope: ['none', 'local', 'guest', 'global'],
  input_permitted: [true, false],
  voice_state: [null, 'waiting_wake_word', 'device_stopped', 'global_stopped'],
  hub_connection: ['not_connected', 'connected', 'unreachable'],
  hub_last_confirmed_at: [null, '2030-10-05T00:00:00Z'],
  budget_held: [null, false],
};

// 一つの項目だけを変えた値と、二つの項目を変えた値を作る。
function variants(base) {
  const out = [base];
  const entries = Object.entries(STATUS_VARIANTS);
  for (const [key, values] of entries)
    for (const value of values) {
      out.push({ ...base, [key]: value });
      for (const [other, others] of entries)
        if (other !== key)
          for (const second of others)
            out.push({ ...base, [key]: value, [other]: second });
    }
  return out;
}

// 中枢の画面の自宅のネットワークの伏せた表示（B03-08）。意味検査で誤りになる形も含めて組み合わせる。
const HOME_VARIANTS = {
  ref: [null, '00000000-0000-4000-8000-000000000e61'],
  gateway_mac_tail: [null, '53:01'],
  subnet: [null, '192.0.2.0/24'],
  ssid_hint: [
    null,
    { first: null, length: 3 },
    { first: '合', length: 3 },
    { first: '合', length: 5 },
  ],
  ssid_unavailable_reason: [null, 'redacted', 'unavailable'],
};

function homeVariants(observation) {
  let out = [observation];
  for (const [key, values] of Object.entries(HOME_VARIANTS))
    out = out.flatMap((value) =>
      values.map((choice) => ({ ...value, [key]: choice })),
    );
  return out;
}

test('desktop main and the contract tools agree on every semantic check', () => {
  let compared = 0;
  let homeErrors = 0;
  for (const entry of cases) {
    if (!entry.valid || !entry.schema.startsWith('Desktop')) continue;
    const name = entry.schema;
    const candidates =
      name === 'DesktopStatusBar' && entry.value.visibility === 'shown'
        ? variants(entry.value)
        : entry.value.status?.visibility === 'shown'
          ? variants(entry.value.status).map((status) => ({
              ...entry.value,
              status,
            }))
          : entry.value.home?.observation
            ? homeVariants(entry.value.home.observation).flatMap(
                (observation) =>
                  [entry.value.home.registration, null].map((registration) => ({
                    ...entry.value,
                    home: { registration, observation },
                  })),
              )
            : [entry.value];
    for (const value of candidates) {
      if (!validators[name](value)) continue;
      assert.deepEqual(
        desktopSemanticErrors(name, value),
        semanticErrors(name, value),
        `${entry.id}: ${JSON.stringify(value)}`,
      );
      compared += 1;
      if (value.home && semanticErrors(name, value).length > 0) homeErrors += 1;
    }
  }
  // 比較した値が少なすぎれば、組み合わせの作り方が壊れている。
  assert(compared > 200, `compared only ${compared}`);
  // 自宅のネットワークは、意味検査で誤りになる形も比べている。
  assert(homeErrors > 0, 'no failing home network variants compared');
});
