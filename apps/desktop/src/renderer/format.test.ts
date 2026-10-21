// 画面の時刻・期限・指紋の書き方の試験（ADR 0024）。時刻は端末の地域時間の Date で組み立て、期待値は手で書く。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  afterOf,
  clockOf,
  fingerprintGroups,
  remainingOf,
  splitInFour,
} from './format.js';

const local = (h: number, m: number, s: number, day = 21) =>
  new Date(2026, 9, day, h, m, s);
const NOW = local(10, 0, 0).getTime();

test('times of today show only the clock; other days add the month and day', () => {
  assert.equal(clockOf(local(9, 5, 7).toISOString(), NOW), '09:05:07');
  assert.equal(
    clockOf(local(9, 5, 7).toISOString(), NOW, { seconds: false }),
    '09:05',
  );
  assert.equal(
    clockOf(local(23, 59, 0, 20).toISOString(), NOW),
    '10/20 23:59:00',
  );
  // 読めない値はそのまま出す（隠さない）。
  assert.equal(clockOf('not-a-time', NOW), 'not-a-time');
});

test('relative times count up to the next whole second or minute', () => {
  assert.equal(afterOf(local(10, 0, 4).toISOString(), NOW), '4 秒後');
  assert.equal(afterOf(local(10, 0, 59).toISOString(), NOW), '59 秒後');
  assert.equal(afterOf(local(10, 1, 0).toISOString(), NOW), '1 分後');
  assert.equal(afterOf(local(10, 1, 1).toISOString(), NOW), '2 分後');
  assert.equal(afterOf(local(10, 0, 0).toISOString(), NOW), 'まもなく');
  assert.equal(afterOf(local(9, 59, 0).toISOString(), NOW), 'まもなく');
  assert.equal(remainingOf(local(10, 5, 0).toISOString(), NOW), '残り 5 分');
  assert.equal(remainingOf(local(10, 0, 30).toISOString(), NOW), '残り 30 秒');
  assert.equal(remainingOf(local(10, 0, 0).toISOString(), NOW), '期限切れ');
  assert.equal(remainingOf('not-a-time', NOW), '期限切れ');
});

test('fingerprints split into sixteen groups of four and codes into fours', () => {
  const fp = 'c006dee35079e5e206508453c86d4a260eccf47bb944759799ed7b56fb0dc7a6';
  assert.deepEqual(fingerprintGroups(fp), [
    'c006',
    'dee3',
    '5079',
    'e5e2',
    '0650',
    '8453',
    'c86d',
    '4a26',
    '0ecc',
    'f47b',
    'b944',
    '7597',
    '99ed',
    '7b56',
    'fb0d',
    'c7a6',
  ]);
  assert.deepEqual(fingerprintGroups(''), []);
  assert.equal(splitInFour('12345678'), '1234 5678');
  assert.equal(splitInFour('cafe5aa9'), 'cafe 5aa9');
  assert.equal(splitInFour(''), '');
});
