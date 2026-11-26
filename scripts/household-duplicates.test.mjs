import assert from 'node:assert/strict';
import test from 'node:test';
import { householdDuplicateGroups } from '../packages/domain/dist/index.js';

// 重なっていそうな記録（ADR 0168）。期待値はすべて手で書いた。

const entry = (key, source, over = {}) => ({
  key,
  source_kind: source,
  direction: 'expense',
  occurred_on: '2030-11-03',
  amount_yen: 1280,
  ...over,
});

test('出所の違う同じ日・同じ金額・同じ向きの記録と、手入力の二つは重なっていそうな組にする', () => {
  assert.deepEqual(
    householdDuplicateGroups([
      entry('mail-1', 'mail_notice'),
      entry('manual-1', 'manual'),
      // 利用通知だけの二つ（同じ日に同じ金額を二度使った）は数えない。
      entry('mail-2', 'mail_notice', { occurred_on: '2030-11-04' }),
      entry('mail-3', 'mail_notice', { occurred_on: '2030-11-04' }),
      // 手入力の二つは数える。
      entry('manual-2', 'manual', { amount_yen: 500 }),
      entry('manual-3', 'manual', { amount_yen: 500 }),
      // 書き出しと利用通知（三つの組）。
      entry('csv-1', 'csv_import', { occurred_on: '2030-11-05' }),
      entry('mail-4', 'mail_notice', { occurred_on: '2030-11-05' }),
      entry('csv-2', 'csv_import', { occurred_on: '2030-11-05' }),
      // 向き・金額・日付の違うものは組にしない。
      entry('income-1', 'manual', { direction: 'income' }),
      entry('other-1', 'csv_import', { amount_yen: 1281 }),
    ]),
    [
      ['mail-1', 'manual-1'],
      ['manual-2', 'manual-3'],
      ['csv-1', 'mail-4', 'csv-2'],
    ],
  );
  assert.deepEqual(householdDuplicateGroups([]), []);
  assert.deepEqual(
    householdDuplicateGroups([
      entry('csv-a', 'csv_import'),
      entry('csv-b', 'csv_import'),
    ]),
    [],
  );
});
