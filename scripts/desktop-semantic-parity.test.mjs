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

test('desktop main and the contract tools agree on every semantic check', () => {
  let compared = 0;
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
          : [entry.value];
    for (const value of candidates) {
      if (!validators[name](value)) continue;
      assert.deepEqual(
        desktopSemanticErrors(name, value),
        semanticErrors(name, value),
        `${entry.id}: ${JSON.stringify(value)}`,
      );
      compared += 1;
    }
  }
  // 比較した値が少なすぎれば、組み合わせの作り方が壊れている。
  assert(compared > 200, `compared only ${compared}`);
});
